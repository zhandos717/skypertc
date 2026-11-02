// Peer-connection lifecycle. Each peer entry in the store is the React-able
// piece (name, stream, abr, speaking); the underlying RTCPeerConnection,
// DataChannel and ABR controller live in `internals` so Vue doesn't deep-track
// them. VideoTile.vue binds to entry.stream via srcObject.
import { state, internals } from '../stores/app.js';
import { preferBestCodec, tweakOpusSdp } from '../services/sdp.js';
import { makeAbr } from '../services/abr.js';

export function startSpeakingDetection(stream, onChange) {
  if (!stream || !stream.getAudioTracks().length) return () => {};
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;
    const timer = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
      const is = avg > 14;
      if (is !== speaking) { speaking = is; onChange(speaking); }
    }, 80);
    return () => { clearInterval(timer); try { ctx.close(); } catch {} onChange(false); };
  } catch { return () => {}; }
}

export async function replaceVideoTrackEverywhere(newTrack) {
  for (const pc of internals.pcs.values()) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      try { await sender.replaceTrack(newTrack); } catch (e) { console.warn(e); }
    }
  }
}

function attachEventsChannel(pc, peerId, onReaction) {
  const handle = (ch) => {
    internals.events.set(peerId, ch);
    ch.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m?.type === 'react' && typeof m.emoji === 'string') {
        onReaction(peerId, m.emoji);
      }
    };
  };
  pc.addEventListener('datachannel', (e) => {
    if (e.channel.label === 'events') handle(e.channel);
  });
}

const LINK_GRACE_MS = 8_000;
const LINK_RETRY_MS = 10_000;
const LINK_LOST_MS = 60_000;

export function createPeer(id, initiator, { send, onReaction }) {
  const pc = new RTCPeerConnection({
    ...state.rtcConfig,
    bundlePolicy: 'max-bundle',
    iceCandidatePoolSize: 2,
  });
  state.localStream?.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  preferBestCodec(pc);
  attachEventsChannel(pc, id, onReaction);

  if (initiator) {
    const dc = pc.createDataChannel('events', { ordered: false, maxRetransmits: 0 });
    dc.onopen = () => internals.events.set(id, dc);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', to: id, payload: e.candidate });
  };

  pc.ontrack = (e) => {
    const entry = state.peers.get(id);
    if (!entry) return;
    try { if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0.05; } catch {}
    entry.stream = e.streams[0];
    if (e.track.kind === 'video') {
      state.remoteVideo = true;
      state.audioOnly = false;
    }
    // Start (or restart) speaking detection on the incoming stream.
    const old = internals.speakStops.get(id);
    if (old) old();
    internals.speakStops.set(id, startSpeakingDetection(e.streams[0], (sp) => {
      const cur = state.peers.get(id);
      if (cur) cur.speaking = sp;
    }));
  };

  // Короткий обрыв на слабом интернете не повод бросать собеседника: ждём, пробуем перезапустить путь
  // и только через минуту без связи считаем её потерянной.
  const restartIce = () => {
    if (!initiator || pc.connectionState === 'connected' || pc.connectionState === 'closed') return;
    pc.restartIce();
    pc.createOffer({ iceRestart: true })
      .then(offer => { offer.sdp = tweakOpusSdp(offer.sdp, state.musicMode); return pc.setLocalDescription(offer); })
      .then(() => send({ type: 'offer', to: id, payload: pc.localDescription }))
      .catch(e => console.warn('ICE restart failed:', e));
  };

  const clearLinkTimers = () => {
    const timers = internals.linkTimers.get(id);
    if (timers) { clearTimeout(timers.grace); clearTimeout(timers.lost); clearInterval(timers.retry); }
    internals.linkTimers.delete(id);
  };

  pc.onconnectionstatechange = () => {
    const entry = state.peers.get(id);
    const connection = pc.connectionState;

    if (connection === 'connected') {
      clearLinkTimers();
      if (entry) entry.link = 'ok';
      return;
    }
    if (connection === 'closed') {
      removePeer(id);
      return;
    }
    if (connection !== 'disconnected' && connection !== 'failed') return;

    if (entry) entry.link = 'weak';
    if (internals.linkTimers.has(id)) return;

    internals.linkTimers.set(id, {
      grace: setTimeout(restartIce, connection === 'failed' ? 0 : LINK_GRACE_MS),
      retry: setInterval(restartIce, LINK_RETRY_MS),
      lost: setTimeout(() => {
        if (!state.peers.has(id) || pc.connectionState === 'connected') return;
        state.linkLost = true;
        removePeer(id);
      }, LINK_LOST_MS),
    });
  };

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected' && !internals.abrs.has(id)) {
      internals.abrs.set(id, makeAbr(pc, id));
    }
  });

  const entry = {
    id,
    name: state.peerNames.get(id) || 'Собеседник',
    stream: null,
    abr: null,
    speaking: false,
    link: 'ok',
    initiator,
  };
  state.peers.set(id, entry);
  internals.pcs.set(id, pc);

  if (initiator) {
    (async () => {
      const offer = await pc.createOffer();
      offer.sdp = tweakOpusSdp(offer.sdp, state.musicMode);
      await pc.setLocalDescription(offer);
      send({ type: 'offer', to: id, payload: pc.localDescription });
    })();
  }

  return { pc, entry };
}

export function removePeer(id) {
  const timers = internals.linkTimers.get(id);
  if (timers) { clearTimeout(timers.grace); clearTimeout(timers.lost); clearInterval(timers.retry); }
  internals.linkTimers.delete(id);
  try { internals.abrs.get(id)?.stop(); } catch {}
  try { internals.speakStops.get(id)?.(); } catch {}
  try { internals.pcs.get(id)?.close(); } catch {}
  internals.abrs.delete(id);
  internals.speakStops.delete(id);
  internals.pcs.delete(id);
  internals.events.delete(id);
  state.peers.delete(id);
}

export function clearAllPeers() {
  for (const id of Array.from(state.peers.keys())) removePeer(id);
}

export function getPc(id) { return internals.pcs.get(id); }

export function usePeers() {
  return { createPeer, removePeer, clearAllPeers, replaceVideoTrackEverywhere, getPc };
}
