// Central reactive store. Mirrors what static/modules/state.js held, plus
// derived view state (layout, mobile tab, chat badge) so components can react.
// `internals` holds non-reactive objects (RTCPeerConnection, MediaStream
// sidecars, timers) that Vue shouldn't track.
import { reactive, computed } from 'vue';

export const state = reactive({
  ws: null,
  localStream: null,
  selfSpeaking: false,
  myId: null,
  currentRoom: null,
  currentSecret: '',
  /** id → { id, name, stream, abr: { tier, kbps, loss, rtt, q } | null, speaking } */
  peers: new Map(),
  peerNames: new Map(),
  rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  userName: '',
  /** Встроенный режим (iframe в чате): без боковой панели и без вопроса про имя. */
  embed: false,
  /** Только голос: камера не запрашивается. */
  audioOnly: false,
  musicMode: false,
  bgEffectOn: false,
  screenSharing: false,
  /** Self-tile preview stream — set when a bg-effect or screen-share track
   *  should be shown locally instead of the raw camera. */
  previewStream: null,
  joining: false,            // true between user-initiated join() and ws.onopen
  /** Live captions feed — Map<peerId | 'self', { text, ts }>.
   *  Vue 3 reactive() proxies Map: .set/.delete trigger re-render. */
  captions: new Map(),
  captionsOn: false,         // own mic transcription toggle (broadcasts to peers)
  captionsLang: localStorage.getItem('skypertc.captions.lang') || 'ru-RU',
  publicRooms: [],
  recent: JSON.parse(localStorage.getItem('skypertc.recent') || '[]'),
  chatMessages: [],          // { from, text, mine }[]
  chatBadge: false,
  mobileTab: 'sidebar',      // sidebar | main | chat — start on room-creation on mobile
  chatOpen: false,           // tablet chat slide-in
  theme: localStorage.getItem('skypertc.theme') || 'auto',
  connectionStatus: '',      // string shown in topbar sub
});

export const internals = {
  pcs: new Map(),
  abrs: new Map(),
  events: new Map(),
  speakStops: new Map(),
  bgEffect: null,
  screenStream: null,
  cameraVideoTrack: null,
  rawCameraTrack: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
};

export const peerCount = computed(() => state.peers.size);

export const layout = computed(() => {
  const n = state.peers.size + 1;
  if (n === 1) return 'solo';
  if (n === 2) return 'pair';
  if (n <= 4) return 'grid';
  return 'spotlight';
});

export function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}
