package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type ClientConfig struct {
	IceServers []IceServer `json:"iceServers"`
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func buildIceServers() []IceServer {
	var servers []IceServer

	stun := env("STUN_URLS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
	if stun != "" {
		urls := splitCSV(stun)
		if len(urls) > 0 {
			servers = append(servers, IceServer{URLs: urls})
		}
	}

	turnURLs := env("TURN_URLS", "")
	if turnURLs != "" {
		servers = append(servers, IceServer{
			URLs:       splitCSV(turnURLs),
			Username:   os.Getenv("TURN_USERNAME"),
			Credential: os.Getenv("TURN_CREDENTIAL"),
		})
	}
	return servers
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := parts[:0]
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

type Client struct {
	id   string
	room string
	conn *websocket.Conn
	send chan []byte
	mu   sync.Mutex
}

type Room struct {
	clients map[string]*Client
	public  bool
	name    string
	secret  string
	mu      sync.RWMutex
}

type Hub struct {
	rooms map[string]*Room
	mu    sync.RWMutex
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]*Room)}
}

func (h *Hub) getOrCreateRoom(name string, public bool) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[name]
	if !ok {
		r = &Room{clients: make(map[string]*Client), public: public, name: name}
		h.rooms[name] = r
	}
	return r
}

func (h *Hub) listPublicRooms() []map[string]any {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]map[string]any, 0, len(h.rooms))
	for _, r := range h.rooms {
		r.mu.RLock()
		// Public listing excludes rooms with a secret (truly private)
		if r.public && r.secret == "" {
			out = append(out, map[string]any{"name": r.name, "count": len(r.clients)})
		}
		r.mu.RUnlock()
	}
	return out
}

func (h *Hub) leave(c *Client) {
	h.mu.Lock()
	r, ok := h.rooms[c.room]
	h.mu.Unlock()
	if !ok {
		return
	}
	r.mu.Lock()
	delete(r.clients, c.id)
	empty := len(r.clients) == 0
	peers := make([]*Client, 0, len(r.clients))
	for _, p := range r.clients {
		peers = append(peers, p)
	}
	r.mu.Unlock()

	leaveMsg, _ := json.Marshal(map[string]any{"type": "peer-left", "from": c.id})
	for _, p := range peers {
		p.write(leaveMsg)
	}

	if empty {
		h.mu.Lock()
		delete(h.rooms, c.room)
		h.mu.Unlock()
	}
}

func (c *Client) write(msg []byte) {
	select {
	case c.send <- msg:
	default:
	}
}

type SignalMsg struct {
	Type    string          `json:"type"`
	Room    string          `json:"room,omitempty"`
	Name    string          `json:"name,omitempty"`
	Public  bool            `json:"public,omitempty"`
	Secret  string          `json:"secret,omitempty"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to,omitempty"`
	Reason  string          `json:"reason,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (h *Hub) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade:", err)
		return
	}
	c := &Client{conn: conn, send: make(chan []byte, 32)}

	go func() {
		defer conn.Close()
		for msg := range c.send {
			c.mu.Lock()
			err := conn.WriteMessage(websocket.TextMessage, msg)
			c.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()

	defer func() {
		if c.room != "" {
			h.leave(c)
		}
		close(c.send)
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var m SignalMsg
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}

		switch m.Type {
		case "join":
			if c.room != "" {
				h.leave(c)
			}
			// Check secret BEFORE creating room (lookup only)
			h.mu.RLock()
			existing := h.rooms[m.Room]
			h.mu.RUnlock()
			if existing != nil {
				existing.mu.RLock()
				roomSecret := existing.secret
				existing.mu.RUnlock()
				if roomSecret != "" && roomSecret != m.Secret {
					deny, _ := json.Marshal(map[string]any{"type": "denied", "reason": "Неверный код комнаты"})
					c.write(deny)
					continue
				}
			}
			c.id = randID()
			c.room = m.Room
			room := h.getOrCreateRoom(m.Room, m.Public)
			room.mu.Lock()
			if room.secret == "" && m.Secret != "" {
				room.secret = m.Secret
			}
			room.mu.Unlock()

			room.mu.Lock()
			peers := make([]map[string]string, 0, len(room.clients))
			for _, p := range room.clients {
				peers = append(peers, map[string]string{"id": p.id})
			}
			room.clients[c.id] = c
			others := make([]*Client, 0, len(room.clients)-1)
			for id, p := range room.clients {
				if id != c.id {
					others = append(others, p)
				}
			}
			room.mu.Unlock()

			welcome, _ := json.Marshal(map[string]any{
				"type":  "welcome",
				"id":    c.id,
				"peers": peers,
			})
			c.write(welcome)

			joined, _ := json.Marshal(map[string]any{
				"type": "peer-joined",
				"from": c.id,
				"name": m.Name,
			})
			for _, p := range others {
				p.write(joined)
			}

		case "offer", "answer", "ice", "chat":
			if c.room == "" {
				continue
			}
			h.mu.RLock()
			room, ok := h.rooms[c.room]
			h.mu.RUnlock()
			if !ok {
				continue
			}
			m.From = c.id
			out, _ := json.Marshal(m)

			if m.To != "" {
				room.mu.RLock()
				target := room.clients[m.To]
				room.mu.RUnlock()
				if target != nil {
					target.write(out)
				}
			} else {
				room.mu.RLock()
				peers := make([]*Client, 0, len(room.clients))
				for id, p := range room.clients {
					if id != c.id {
						peers = append(peers, p)
					}
					_ = id
				}
				room.mu.RUnlock()
				for _, p := range peers {
					p.write(out)
				}
			}
		}
	}
}

func randID() string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 10)
	for i := range b {
		b[i] = letters[randInt()%len(letters)]
	}
	return string(b)
}

var randSeed uint64 = 0x9E3779B97F4A7C15

func randInt() int {
	randSeed ^= randSeed << 13
	randSeed ^= randSeed >> 7
	randSeed ^= randSeed << 17
	return int(randSeed & 0x7fffffff)
}

func main() {
	hub := NewHub()
	cfg := ClientConfig{IceServers: buildIceServers()}
	cfgJSON, _ := json.Marshal(cfg)

	staticDir := env("STATIC_DIR", "./static")
	host := env("HOST", "")
	port := env("PORT", "8080")
	addr := host + ":" + port

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", hub.serveWS)
	mux.HandleFunc("/rooms", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(hub.listPublicRooms())
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

	certFile := os.Getenv("TLS_CERT")
	keyFile := os.Getenv("TLS_KEY")
	if certFile != "" && keyFile != "" {
		log.Printf("TLS enabled (cert=%s)", certFile)
		if err := http.ListenAndServeTLS(addr, certFile, keyFile, mux); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
