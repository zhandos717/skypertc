export const state = {
  ws: null,
  localStream: null,
  myId: null,
  currentRoom: null,
  currentSecret: '',
  peers: new Map(),      // id → { pc, name, videoEl, tile, abr, speakStop }
  peerNames: new Map(),
  rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  userName: '',
  musicMode: false,
};
