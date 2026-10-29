package recorder_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"webrtc/internal/hub"
	"webrtc/internal/ratelimit"
	"webrtc/internal/recorder"
	wsignal "webrtc/internal/signal"
)

type fakeClient struct {
	t    *testing.T
	ws   *websocket.Conn
	mu   sync.Mutex
	pcs  map[string]*webrtc.PeerConnection
	seen map[string]string
	name string
	got  int32
}

func newFakeClient(t *testing.T, url, room, secret, name string) *fakeClient {
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &fakeClient{t: t, ws: ws, pcs: map[string]*webrtc.PeerConnection{}, name: name}
	_ = ws.WriteJSON(map[string]any{"type": "join", "room": room, "secret": secret, "name": name})
	go c.loop()
	return c
}

func (c *fakeClient) send(v any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.WriteJSON(v)
}

func (c *fakeClient) pc(id string) *webrtc.PeerConnection {
	c.mu.Lock()
	defer c.mu.Unlock()
	if pc, ok := c.pcs[id]; ok {
		return pc
	}
	pc, _ := webrtc.NewPeerConnection(webrtc.Configuration{})
	pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, err := tr.ReadRTP(); err != nil {
				return
			}
			atomic.AddInt32(&c.got, 1)
		}
	})
	track, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "p")
	_, _ = pc.AddTrack(track)
	pc.OnICECandidate(func(ic *webrtc.ICECandidate) {
		if ic != nil {
			c.send(map[string]any{"type": "ice", "to": id, "payload": ic.ToJSON()})
		}
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected {
			go func() {
				for i := 0; i < 150; i++ {
					_ = track.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond})
					time.Sleep(20 * time.Millisecond)
				}
			}()
		}
	})
	c.pcs[id] = pc
	return pc
}

func (c *fakeClient) loop() {
	for {
		var m struct {
			Type    string          `json:"type"`
			From    string          `json:"from"`
			Payload json.RawMessage `json:"payload"`
		}
		if c.ws.ReadJSON(&m) != nil {
			return
		}
		switch m.Type {
		case "offer":
			var sd webrtc.SessionDescription
			_ = json.Unmarshal(m.Payload, &sd)
			pc := c.pc(m.From)
			_ = pc.SetRemoteDescription(sd)
			ans, _ := pc.CreateAnswer(nil)
			_ = pc.SetLocalDescription(ans)
			c.send(map[string]any{"type": "answer", "to": m.From, "payload": pc.LocalDescription()})
		case "ice":
			var ic webrtc.ICECandidateInit
			_ = json.Unmarshal(m.Payload, &ic)
			if pc := c.pcs[m.From]; pc != nil && pc.RemoteDescription() != nil {
				_ = pc.AddICECandidate(ic)
			}
		}
	}
}

func TestRecordsBothParticipantsAndUploads(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg не установлен")
	}

	t.Setenv("RECORD_SECRET", "s3")
	h := hub.NewHub()
	limiter := ratelimit.New(20)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { wsignal.ServeWS(h, limiter, w, r) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	var got struct {
		sync.Mutex
		secret string
		size   int64
		path   string
	}
	uploaded := make(chan struct{}, 1)
	cb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		file, _, err := r.FormFile("recording")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		b, _ := io.ReadAll(file)
		got.Lock()
		got.secret, got.size, got.path = r.Header.Get("X-Record-Secret"), int64(len(b)), r.URL.Path
		got.Unlock()
		uploaded <- struct{}{}
	}))
	defer cb.Close()

	mgr := recorder.NewManager(recorder.Config{WSURL: wsURL, Dir: t.TempDir(), CallbackURL: cb.URL + "/calls/{id}/recording", Secret: "s3", Announce: true})

	a := newFakeClient(t, wsURL, "room1", "sec", "Анна")
	time.Sleep(200 * time.Millisecond)
	b := newFakeClient(t, wsURL, "room1", "sec", "Иван")
	time.Sleep(500 * time.Millisecond)

	if err := mgr.Start(42, "room1", "sec"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(4 * time.Second)
	mgr.Stop(42)
	if atomic.LoadInt32(&a.got) < 50 || atomic.LoadInt32(&b.got) < 50 {
		t.Fatalf("оповещение не дошло: a=%d b=%d пакетов", a.got, b.got)
	}

	select {
	case <-uploaded:
	case <-time.After(30 * time.Second):
		t.Fatal("запись не пришла в callback")
	}

	got.Lock()
	defer got.Unlock()
	if got.secret != "s3" || got.path != "/calls/42/recording" || got.size < 1000 {
		t.Fatalf("secret=%q path=%q size=%d", got.secret, got.path, got.size)
	}
}
