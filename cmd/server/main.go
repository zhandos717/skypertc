package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"webrtc/internal/config"
	"webrtc/internal/hub"
	"webrtc/internal/ratelimit"
	"webrtc/internal/recorder"
	wsignal "webrtc/internal/signal"
)

func main() {
	// PWA manifest MIME — not in Go's built-in table, register explicitly.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")

	h := hub.NewHub()
	cfg := config.ClientConfig{IceServers: config.BuildIceServers()}
	cfgJSON, _ := json.Marshal(cfg)

	staticDir := config.Env("STATIC_DIR", "./static")
	host := config.Env("HOST", "")
	port := config.Env("PORT", "8080")
	addr := host + ":" + port

	limiter := ratelimit.New(20)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		wsignal.ServeWS(h, limiter, w, r)
	})
	mux.HandleFunc("/rooms", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(h.ListPublicRooms())
	})
	mux.HandleFunc("/config.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(cfgJSON)
	})
	if secret := os.Getenv("RECORD_SECRET"); secret != "" {
		rec := recorder.NewManager(recorder.Config{
			WSURL:       config.Env("RECORD_WS_URL", "ws://127.0.0.1:"+port+"/ws"),
			Origin:      config.Env("RECORD_ORIGIN", firstOrigin()),
			Dir:         config.Env("RECORD_DIR", "./recordings"),
			CallbackURL: os.Getenv("RECORD_CALLBACK_URL"),
			Secret:      secret,
			IceServers:  cfg.IceServers,
			PublicIP:    os.Getenv("RECORD_PUBLIC_IP"),
			Announce:    os.Getenv("RECORD_ANNOUNCE") != "0",
			UDPMin:      uint16(portEnv("RECORD_UDP_MIN")),
			UDPMax:      uint16(portEnv("RECORD_UDP_MAX")),
		})
		mux.HandleFunc("/internal/record", recordHandler(secret, rec))
		log.Printf("call recording enabled (dir=%s)", config.Env("RECORD_DIR", "./recordings"))
	}
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))

	log.Printf("SkypeRTC listening on http://localhost:%s (static=%s, ice=%d servers)", port, staticDir, len(cfg.IceServers))

	srv := &http.Server{Addr: addr, Handler: mux}

	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
		<-quit
		log.Println("Shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("Shutdown error: %v", err)
		}
	}()

	certFile := os.Getenv("TLS_CERT")
	keyFile := os.Getenv("TLS_KEY")
	if certFile != "" && keyFile != "" {
		log.Printf("TLS enabled (cert=%s)", certFile)
		if err := srv.ListenAndServeTLS(certFile, keyFile); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
		return
	}
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func firstOrigin() string {
	return strings.TrimSpace(strings.SplitN(os.Getenv("ALLOWED_ORIGINS"), ",", 2)[0])
}

// recordHandler принимает команды приложения: {"action":"start","call_id":1,"room":"..","secret":".."} и {"action":"stop","call_id":1}.
func recordHandler(secret string, rec *recorder.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Record-Secret")), []byte(secret)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			Action string `json:"action"`
			CallID int64  `json:"call_id"`
			Room   string `json:"room"`
			Secret string `json:"secret"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.CallID <= 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		switch body.Action {
		case "start":
			if body.Room == "" {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if err := rec.Start(body.CallID, body.Room, body.Secret); err != nil {
				log.Printf("record start %d: %v", body.CallID, err)
				http.Error(w, "start failed", http.StatusBadGateway)
				return
			}
		case "stop":
			rec.Stop(body.CallID)
		default:
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func portEnv(key string) int {
	n, _ := strconv.Atoi(os.Getenv(key))
	if n < 0 || n > 65535 {
		return 0
	}
	return n
}
