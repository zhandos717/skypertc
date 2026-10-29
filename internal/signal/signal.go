package signal

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"webrtc/internal/hub"
	"webrtc/internal/randutil"
	"webrtc/internal/ratelimit"
)

const (
	wsPongWait   = 60 * time.Second
	wsPingPeriod = 25 * time.Second
	wsWriteWait  = 10 * time.Second
	wsMaxMsgSize = 256 * 1024
)

// allowedOrigins is populated from ALLOWED_ORIGINS env var (comma-separated).
// Empty list = allow all (dev mode).
var allowedOrigins = func() map[string]struct{} {
	raw := os.Getenv("ALLOWED_ORIGINS")
	if raw == "" {
		return nil
	}
	m := make(map[string]struct{})
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			m[o] = struct{}{}
		}
	}
	return m
}()

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
	CheckOrigin: func(r *http.Request) bool {
		if allowedOrigins == nil {
			return true // dev mode
		}
		origin := r.Header.Get("Origin")
		_, ok := allowedOrigins[origin]
		return ok
	},
}

func realIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.SplitN(xff, ",", 2)[0])
	}
	addr := r.RemoteAddr
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		return addr[:i]
	}
	return addr
}

func ServeWS(h *hub.Hub, limiter *ratelimit.IPLimiter, w http.ResponseWriter, r *http.Request) {
	ip := realIP(r)
	if !limiter.Allow(ip) {
		http.Error(w, "too many connections", http.StatusTooManyRequests)
		return
	}
	defer limiter.Release(ip)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade:", err)
		return
	}
	c := &hub.Client{Conn: conn, Send: make(chan []byte, 32)}

	conn.SetReadLimit(wsMaxMsgSize)
	conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	go func() {
		ticker := time.NewTicker(wsPingPeriod)
		defer func() {
			ticker.Stop()
			conn.Close()
		}()
		for {
			select {
			case msg, ok := <-c.Send:
				c.Mu.Lock()
				conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
				if !ok {
					conn.WriteMessage(websocket.CloseMessage, []byte{})
					c.Mu.Unlock()
					return
				}
				err := conn.WriteMessage(websocket.TextMessage, msg)
				c.Mu.Unlock()
				if err != nil {
					return
				}
			case <-ticker.C:
				c.Mu.Lock()
				conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
				err := conn.WriteMessage(websocket.PingMessage, nil)
				c.Mu.Unlock()
				if err != nil {
					return
				}
			}
		}
	}()

	defer func() {
		if c.Room != "" {
			h.Leave(c)
		}
		close(c.Send)
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
			if c.Room != "" {
				h.Leave(c)
			}
			h.Mu.RLock()
			existing := h.Rooms[m.Room]
			h.Mu.RUnlock()
			if existing != nil {
				existing.Mu.RLock()
				roomSecret := existing.Secret
				existing.Mu.RUnlock()
				if roomSecret != "" && roomSecret != m.Secret {
					deny, _ := json.Marshal(map[string]any{"type": "denied", "reason": "Неверный код комнаты"})
					c.Write(deny)
					continue
				}
			}
			c.ID = randutil.RandID()
			c.Name = m.Name
			c.Room = m.Room
			room := h.GetOrCreateRoom(m.Room, m.Public)
			room.Mu.Lock()
			if room.Secret == "" && m.Secret != "" {
				room.Secret = m.Secret
			}
			room.Mu.Unlock()

			room.Mu.Lock()
			peers := make([]map[string]string, 0, len(room.Clients))
			for _, p := range room.Clients {
				peers = append(peers, map[string]string{"id": p.ID, "name": p.Name})
			}
			room.Clients[c.ID] = c
			others := make([]*hub.Client, 0, len(room.Clients)-1)
			for id, p := range room.Clients {
				if id != c.ID {
					others = append(others, p)
				}
			}
			room.Mu.Unlock()

			welcome, _ := json.Marshal(map[string]any{
				"type":  "welcome",
				"id":    c.ID,
				"peers": peers,
			})
			c.Write(welcome)

			joined, _ := json.Marshal(map[string]any{
				"type": "peer-joined",
				"from": c.ID,
				"name": m.Name,
			})
			for _, p := range others {
				p.Write(joined)
			}

		case "offer", "answer", "ice", "chat", "react":
			if c.Room == "" {
				continue
			}
			h.Mu.RLock()
			room, ok := h.Rooms[c.Room]
			h.Mu.RUnlock()
			if !ok {
				continue
			}
			m.From = c.ID
			out, _ := json.Marshal(m)

			if m.To != "" {
				room.Mu.RLock()
				target := room.Clients[m.To]
				room.Mu.RUnlock()
				if target != nil {
					target.Write(out)
				}
			} else {
				room.Mu.RLock()
				peers := make([]*hub.Client, 0, len(room.Clients))
				for id, p := range room.Clients {
					if id != c.ID {
						peers = append(peers, p)
					}
					_ = id
				}
				room.Mu.RUnlock()
				for _, p := range peers {
					p.Write(out)
				}
			}
		}
	}
}
