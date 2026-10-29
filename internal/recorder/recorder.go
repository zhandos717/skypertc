// Package recorder записывает звонки: заходит в комнату тихим участником, принимает аудио каждого
// и после завершения отдаёт сведённый файл приложению.
package recorder

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"

	"webrtc/internal/config"
)

// BotName узнаётся клиентами: участника с таким именем в интерфейсе не показывают.
const BotName = "__rec__"

const (
	emptyGrace  = 30 * time.Second
	maxDuration = 4 * time.Hour
	minSeconds  = 2
)

type Config struct {
	WSURL       string
	Origin      string
	Dir         string
	CallbackURL string
	Secret      string
	IceServers  []config.IceServer
	PublicIP    string
	UDPMin      uint16
	UDPMax      uint16
}

type Manager struct {
	cfg Config
	mu  sync.Mutex
	run map[int64]*session
}

func NewManager(cfg Config) *Manager {
	return &Manager{cfg: cfg, run: make(map[int64]*session)}
}

func (m *Manager) Start(callID int64, room, secret string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.run[callID]; ok {
		return nil
	}
	s := &session{m: m, callID: callID, room: room, secret: secret, peers: map[string]*peer{}, started: time.Now(), done: make(chan struct{})}
	if err := s.connect(); err != nil {
		return err
	}
	m.run[callID] = s
	go s.loop()
	return nil
}

func (m *Manager) Stop(callID int64) {
	m.mu.Lock()
	s := m.run[callID]
	m.mu.Unlock()
	if s != nil {
		s.finish(3 * time.Second)
	}
}

func (m *Manager) forget(callID int64) {
	m.mu.Lock()
	delete(m.run, callID)
	m.mu.Unlock()
}

type segment struct {
	path   string
	offset time.Duration
	writer *oggwriter.OggWriter
}

type peer struct {
	pc      *webrtc.PeerConnection
	pending []webrtc.ICECandidateInit
	remote  bool
}

type session struct {
	m       *Manager
	callID  int64
	room    string
	secret  string
	started time.Time

	ws    *websocket.Conn
	wsMu  sync.Mutex
	api   *webrtc.API
	mu    sync.Mutex
	peers map[string]*peer
	segs  []*segment

	finishing bool
	done      chan struct{}
	timer     *time.Timer
}

func (s *session) connect() error {
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return err
	}
	se := webrtc.SettingEngine{}
	if s.m.cfg.UDPMin > 0 && s.m.cfg.UDPMax >= s.m.cfg.UDPMin {
		if err := se.SetEphemeralUDPPortRange(s.m.cfg.UDPMin, s.m.cfg.UDPMax); err != nil {
			return err
		}
	}
	if s.m.cfg.PublicIP != "" {
		se.SetNAT1To1IPs([]string{s.m.cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}
	s.api = webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithSettingEngine(se))

	header := http.Header{}
	if s.m.cfg.Origin != "" {
		header.Set("Origin", s.m.cfg.Origin)
	}
	ws, _, err := websocket.DefaultDialer.Dial(s.m.cfg.WSURL, header)
	if err != nil {
		return err
	}
	s.ws = ws
	if err := os.MkdirAll(s.dir(), 0o750); err != nil {
		return err
	}
	return s.send(map[string]any{"type": "join", "room": s.room, "secret": s.secret, "name": BotName})
}

func (s *session) dir() string { return filepath.Join(s.m.cfg.Dir, fmt.Sprint(s.callID)) }

func (s *session) send(v any) error {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	return s.ws.WriteJSON(v)
}

type message struct {
	Type  string `json:"type"`
	From  string `json:"from"`
	Peers []struct {
		ID string `json:"id"`
	} `json:"peers"`
	Payload json.RawMessage `json:"payload"`
}

func (s *session) loop() {
	time.AfterFunc(maxDuration, func() { s.finish(0) })
	for {
		var msg message
		if err := s.ws.ReadJSON(&msg); err != nil {
			s.finish(0)
			return
		}
		switch msg.Type {
		case "welcome":
			for _, p := range msg.Peers {
				s.offerTo(p.ID)
			}
			s.armEmptyTimer()
		case "peer-joined":
			s.cancelEmptyTimer()
		case "peer-left":
			s.dropPeer(msg.From)
			s.armEmptyTimer()
		case "offer":
			s.onOffer(msg.From, msg.Payload)
		case "answer":
			s.onAnswer(msg.From, msg.Payload)
		case "ice":
			s.onICE(msg.From, msg.Payload)
		case "denied":
			s.finish(0)
			return
		}
	}
}

func (s *session) newPeer(id string) (*peer, error) {
	pc, err := s.api.NewPeerConnection(webrtc.Configuration{ICEServers: toPion(s.m.cfg.IceServers)})
	if err != nil {
		return nil, err
	}
	p := &peer{pc: pc}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			_ = s.send(map[string]any{"type": "ice", "to": id, "payload": c.ToJSON()})
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() == webrtc.RTPCodecTypeAudio {
			s.recordTrack(id, track)
		}
	})
	s.mu.Lock()
	s.peers[id] = p
	s.mu.Unlock()
	return p, nil
}

func (s *session) offerTo(id string) {
	p, err := s.newPeer(id)
	if err != nil {
		log.Printf("recorder %d: peer: %v", s.callID, err)
		return
	}
	if _, err := p.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		return
	}
	offer, err := p.pc.CreateOffer(nil)
	if err != nil || p.pc.SetLocalDescription(offer) != nil {
		return
	}
	_ = s.send(map[string]any{"type": "offer", "to": id, "payload": p.pc.LocalDescription()})
}

func (s *session) peer(id string) *peer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peers[id]
}

func (s *session) onOffer(from string, raw json.RawMessage) {
	var sd webrtc.SessionDescription
	if json.Unmarshal(raw, &sd) != nil {
		return
	}
	p := s.peer(from)
	if p == nil {
		var err error
		if p, err = s.newPeer(from); err != nil {
			return
		}
	}
	if p.pc.SetRemoteDescription(sd) != nil {
		return
	}
	s.flushICE(p)
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil || p.pc.SetLocalDescription(answer) != nil {
		return
	}
	_ = s.send(map[string]any{"type": "answer", "to": from, "payload": p.pc.LocalDescription()})
}

func (s *session) onAnswer(from string, raw json.RawMessage) {
	var sd webrtc.SessionDescription
	p := s.peer(from)
	if p == nil || json.Unmarshal(raw, &sd) != nil || p.pc.SetRemoteDescription(sd) != nil {
		return
	}
	s.flushICE(p)
}

func (s *session) onICE(from string, raw json.RawMessage) {
	var c webrtc.ICECandidateInit
	p := s.peer(from)
	if p == nil || json.Unmarshal(raw, &c) != nil {
		return
	}
	s.mu.Lock()
	if !p.remote {
		p.pending = append(p.pending, c)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	_ = p.pc.AddICECandidate(c)
}

func (s *session) flushICE(p *peer) {
	s.mu.Lock()
	p.remote = true
	pending := p.pending
	p.pending = nil
	s.mu.Unlock()
	for _, c := range pending {
		_ = p.pc.AddICECandidate(c)
	}
}

func (s *session) dropPeer(id string) {
	s.mu.Lock()
	p := s.peers[id]
	delete(s.peers, id)
	s.mu.Unlock()
	if p != nil {
		_ = p.pc.Close()
	}
}

func (s *session) armEmptyTimer() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.peers) > 0 || s.finishing {
		return
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(emptyGrace, func() { s.finish(0) })
}

func (s *session) cancelEmptyTimer() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

func (s *session) recordTrack(peerID string, track *webrtc.TrackRemote) {
	path := filepath.Join(s.dir(), fmt.Sprintf("%s-%d.ogg", peerID, time.Now().UnixNano()))
	w, err := oggwriter.New(path, 48000, 2)
	if err != nil {
		log.Printf("recorder %d: ogg: %v", s.callID, err)
		return
	}
	seg := &segment{path: path, offset: time.Since(s.started), writer: w}
	s.mu.Lock()
	s.segs = append(s.segs, seg)
	s.mu.Unlock()

	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			break
		}
		if err := w.WriteRTP(pkt); err != nil {
			break
		}
	}
	_ = w.Close()
}

func (s *session) finish(delay time.Duration) {
	s.mu.Lock()
	if s.finishing {
		s.mu.Unlock()
		return
	}
	s.finishing = true
	if s.timer != nil {
		s.timer.Stop()
	}
	s.mu.Unlock()

	go func() {
		time.Sleep(delay)
		_ = s.ws.Close()
		s.mu.Lock()
		peers := s.peers
		s.peers = map[string]*peer{}
		s.mu.Unlock()
		for _, p := range peers {
			_ = p.pc.Close()
		}
		time.Sleep(500 * time.Millisecond)
		s.m.forget(s.callID)
		s.publish()
		close(s.done)
	}()
}

func (s *session) publish() {
	s.mu.Lock()
	segs := append([]*segment(nil), s.segs...)
	s.mu.Unlock()

	usable := segs[:0]
	for _, seg := range segs {
		if st, err := os.Stat(seg.path); err == nil && st.Size() > 2048 {
			usable = append(usable, seg)
		}
	}
	if len(usable) == 0 {
		_ = os.RemoveAll(s.dir())
		return
	}

	out := filepath.Join(s.dir(), "call.m4a")
	if err := mix(usable, out); err != nil {
		log.Printf("recorder %d: mix: %v (files kept in %s)", s.callID, err, s.dir())
		return
	}
	if err := s.upload(out); err != nil {
		log.Printf("recorder %d: upload: %v (file kept: %s)", s.callID, err, out)
		return
	}
	_ = os.RemoveAll(s.dir())
}

func mix(segs []*segment, out string) error {
	args := []string{"-y", "-loglevel", "error"}
	var filters []string
	var labels strings.Builder
	for i, seg := range segs {
		args = append(args, "-i", seg.path)
		ms := seg.offset.Milliseconds()
		filters = append(filters, fmt.Sprintf("[%d:a]adelay=%d:all=1[a%d]", i, ms, i))
		fmt.Fprintf(&labels, "[a%d]", i)
	}
	if len(segs) == 1 {
		filters = append(filters, "[a0]anull[m]")
	} else {
		filters = append(filters, fmt.Sprintf("%samix=inputs=%d:normalize=0:dropout_transition=0[m]", labels.String(), len(segs)))
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"), "-map", "[m]", "-c:a", "aac", "-b:a", "48k", "-ac", "1", out)
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, b)
	}
	return nil
}

func (s *session) upload(path string) error {
	if s.m.cfg.CallbackURL == "" {
		return fmt.Errorf("RECORD_CALLBACK_URL не задан")
	}
	url := strings.ReplaceAll(s.m.cfg.CallbackURL, "{id}", fmt.Sprint(s.callID))
	var last error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt*attempt) * 5 * time.Second)
		}
		last = postFile(url, s.m.cfg.Secret, path)
		if last == nil {
			return nil
		}
	}
	return last
}

func postFile(url, secret, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, _ := mw.CreateFormFile("recording", "call.m4a")
	if _, err := io.Copy(part, f); err != nil {
		return err
	}
	_ = mw.Close()

	req, _ := http.NewRequest(http.MethodPost, url, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Record-Secret", secret)
	resp, err := (&http.Client{Timeout: 2 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}
	return nil
}

func toPion(in []config.IceServer) []webrtc.ICEServer {
	out := make([]webrtc.ICEServer, 0, len(in))
	for _, s := range in {
		out = append(out, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	return out
}
