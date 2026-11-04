package signal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"webrtc/internal/hub"
	"webrtc/internal/ratelimit"
)

func joinRoom(t *testing.T, srv *httptest.Server, name, token string) string {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })

	if err := conn.WriteJSON(SignalMsg{Type: "join", Room: "croom", Secret: "k", Name: name, Token: token}); err != nil {
		t.Fatal(err)
	}
	var reply SignalMsg
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := conn.ReadJSON(&reply); err != nil {
		t.Fatal(err)
	}

	return reply.Type
}

func TestProtectedRoomIsLimitedToConfiguredPeopleAndIgnoresRecorder(t *testing.T) {
	t.Setenv("RECORD_SECRET", "s3")
	h := hub.NewHub()
	h.Settings = hub.NewSettingsStore(hub.Settings{MaxRoomPeers: 2}, "")
	limiter := ratelimit.New(20)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { ServeWS(h, limiter, w, r) }))
	defer srv.Close()

	got := []string{joinRoom(t, srv, "A", ""), joinRoom(t, srv, "B", ""), joinRoom(t, srv, "C", ""), joinRoom(t, srv, "bot", "s3")}
	want := []string{"welcome", "welcome", "denied", "welcome"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("join #%d: got %q, want %q (all: %v)", i, got[i], want[i], got)
		}
	}

	if err := h.Settings.Set(hub.Settings{MaxRoomPeers: 3}); err != nil {
		t.Fatal(err)
	}
	if reply := joinRoom(t, srv, "C", ""); reply != "welcome" {
		t.Fatalf("after raising the limit C must get in, got %q", reply)
	}
}
