package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"webrtc/internal/config"
	"webrtc/internal/hub"
	"webrtc/internal/ratelimit"
	wsignal "webrtc/internal/signal"
)

func main() {
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
