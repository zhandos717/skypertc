package hub

import (
	"encoding/json"
	"sync"

	"github.com/gorilla/websocket"
	"webrtc/internal/randutil"
)

type Client struct {
	ID   string
	Name string
	Room string
	Conn *websocket.Conn
	Send chan []byte
	Mu   sync.Mutex
}

type Room struct {
	Clients map[string]*Client
	Public  bool
	Name    string
	Secret  string
	Mu      sync.RWMutex
}

type Hub struct {
	Rooms map[string]*Room
	Mu    sync.RWMutex
}

func NewHub() *Hub {
	return &Hub{Rooms: make(map[string]*Room)}
}

func (h *Hub) GetOrCreateRoom(name string, public bool) *Room {
	h.Mu.Lock()
	defer h.Mu.Unlock()
	r, ok := h.Rooms[name]
	if !ok {
		r = &Room{Clients: make(map[string]*Client), Public: public, Name: name}
		h.Rooms[name] = r
	}
	return r
}

func (h *Hub) ListPublicRooms() []map[string]any {
	h.Mu.RLock()
	defer h.Mu.RUnlock()
	out := make([]map[string]any, 0, len(h.Rooms))
	for _, r := range h.Rooms {
		r.Mu.RLock()
		if r.Public && r.Secret == "" {
			out = append(out, map[string]any{"name": r.Name, "count": len(r.Clients)})
		}
		r.Mu.RUnlock()
	}
	return out
}

func (h *Hub) Leave(c *Client) {
	h.Mu.Lock()
	r, ok := h.Rooms[c.Room]
	h.Mu.Unlock()
	if !ok {
		return
	}
	r.Mu.Lock()
	delete(r.Clients, c.ID)
	empty := len(r.Clients) == 0
	peers := make([]*Client, 0, len(r.Clients))
	for _, p := range r.Clients {
		peers = append(peers, p)
	}
	r.Mu.Unlock()

	leaveMsg, _ := json.Marshal(map[string]any{"type": "peer-left", "from": c.ID})
	for _, p := range peers {
		p.Write(leaveMsg)
	}

	if empty {
		h.Mu.Lock()
		delete(h.Rooms, c.Room)
		h.Mu.Unlock()
	}
}

func (c *Client) Write(msg []byte) {
	select {
	case c.Send <- msg:
	default:
	}
}

func NewClient(conn *websocket.Conn) *Client {
	return &Client{
		ID:   randutil.RandID(),
		Conn: conn,
		Send: make(chan []byte, 32),
	}
}
