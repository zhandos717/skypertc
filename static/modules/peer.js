import { state } from './state.js';
import { startSpeakingDetection } from './media.js';
import { makeAbr } from './abr.js';

function preferBestCodec(pc) {
  if (!('getCapabilities' in RTCRtpSender)) return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps?.codecs) return;

  // Heuristic: AV1 only on beefy CPUs (≥8 logical cores) and non-mobile.
  // Mobile defaults to H264 (HW-accelerated). Desktop falls back to VP9.
  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  const cores = navigator.hardwareConcurrency || 4;
  const canAv1 = !isMobile && cores >= 8;

  const av1  = canAv1 ? caps.codecs.filter(c => /AV1/i.test(c.mimeType)) : [];
  const vp9  = caps.codecs.filter(c => /VP9/i.test(c.mimeType));
  const h264 = caps.codecs.filter(c => /H264/i.test(c.mimeType));
  const rest = caps.codecs.filter(c => !/AV1|VP9|H264/i.test(c.mimeType));

  // Order: mobile prefers H264, desktop prefers AV1→VP9.
  const ordered = isMobile
    ? [...h264, ...vp9, ...av1, ...rest]
    : [...av1, ...vp9, ...h264, ...rest];

  if (!ordered.length) return;
  for (const tr of pc.getTransceivers()) {
    if (tr.sender?.track?.kind === 'video' || tr.receiver?.track?.kind === 'video') {
      try { tr.setCodecPreferences(ordered); } catch {}
    }
  }
}

export function tweakOpusSdp(sdp) {
  const music = !!state.musicMode;
  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (m, pt, params) => {
    const rtpmap = new RegExp(`a=rtpmap:${pt} opus/`, 'i');
    if (!rtpmap.test(sdp)) return m;
    const extras = music
      ? 'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000'
      : 'minptime=10;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=40000';
    return `a=fmtp:${pt} ${params};${extras}`;
  });
}

function attachEventsChannel(pc, peerId) {
  const handle = (ch) => {
    state.peers.get(peerId) && (state.peers.get(peerId).events = ch);
    ch.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m?.type === 'react' && typeof m.emoji === 'string') {
        const entry = state.peers.get(peerId);
        if (entry?.tile) {
          import('./ui.js').then(({ showReaction }) => showReaction(entry.tile, m.emoji));
        }
      }
    };
  };
  pc.addEventListener('datachannel', (e) => {
    if (e.channel.label === 'events') handle(e.channel);
  });
}

export function createPeer(id, initiator, { send, remotesEl }) {
  const pc = new RTCPeerConnection({ ...state.rtcConfig, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 2 });
  state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  preferBestCodec(pc);
  attachEventsChannel(pc, id);
  if (initiator) {
    const dc = pc.createDataChannel('events', { ordered: false, maxRetransmits: 0 });
    dc.onopen = () => {
      const entry = state.peers.get(id);
      if (entry) entry.events = dc;
    };
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', to: id, payload: e.candidate });
  };

  pc.ontrack = (e) => {
    let entry = state.peers.get(id);
    if (!entry) return;
    try { if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0.05; } catch {}
    if (!entry.videoEl) {
      const tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.dataset.id = id;
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true;
      const label = document.createElement('div');
      label.className = 'tile-label';
      label.textContent = entry.name || 'Собеседник';
      const fsBtn = document.createElement('button');
      fsBtn.className = 'tile-fs-btn'; fsBtn.title = 'На весь экран';
      fsBtn.innerHTML = '<svg class="icon"><use href="/icons.svg#maximize"/></svg>';
      fsBtn.onclick = (ev) => { ev.stopPropagation(); tile.requestFullscreen?.(); };
      const pipBtn = document.createElement('button');
      pipBtn.className = 'tile-pip-btn'; pipBtn.title = 'Picture-in-Picture';
      pipBtn.innerHTML = '<svg class="icon"><use href="/icons.svg#pip"/></svg>';
      pipBtn.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
          else await v.requestPictureInPicture();
        } catch (e) { console.warn('PiP:', e); }
      };
      if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
        pipBtn.hidden = true;
      }
      tile.appendChild(v); tile.appendChild(label); tile.appendChild(fsBtn); tile.appendChild(pipBtn);
      remotesEl.appendChild(tile);
      entry.videoEl = v;
      entry.tile = tile;
      entry.speakStop = startSpeakingDetection(e.streams[0], tile);
    }
    entry.videoEl.srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      removePeer(id);
    }
  };

  const entry = { pc, name: state.peerNames.get(id) || 'Собеседник', videoEl: null, tile: null, abr: null, speakStop: null, initiator };
  state.peers.set(id, entry);

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState !== 'failed') return;
    if (!entry.initiator) return;
    pc.restartIce();
    pc.createOffer({ iceRestart: true })
      .then(offer => { offer.sdp = tweakOpusSdp(offer.sdp); return pc.setLocalDescription(offer); })
      .then(() => send({ type: 'offer', to: id, payload: pc.localDescription }))
      .catch(e => console.warn('ICE restart failed:', e));
  };

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected' && !entry.abr) {
      entry.abr = makeAbr(pc, id);
    }
  });

  if (initiator) {
    (async () => {
      const offer = await pc.createOffer();
      offer.sdp = tweakOpusSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      send({ type: 'offer', to: id, payload: pc.localDescription });
    })();
  }

  renderPeers();
  return entry;
}

export function removePeer(id) {
  const entry = state.peers.get(id);
  if (!entry) return;
  try { entry.abr?.stop(); } catch {}
  try { entry.speakStop?.(); } catch {}
  try { entry.pc.close(); } catch {}
  if (entry.tile) entry.tile.remove();
  state.peers.delete(id);
  renderPeers();
}

export function renderPeers() {
  const peersList = document.getElementById('peers');
  const placeholder = document.getElementById('placeholder');
  peersList.innerHTML = '';
  state.peers.forEach((e) => {
    const li = document.createElement('li');
    const initial = (e.name || '?').charAt(0).toUpperCase();
    li.innerHTML = `<div class="avatar small">${initial}</div><div><div class="name">${e.name}</div><div class="sub"><span class="dot online"></span>В звонке</div></div>`;
    peersList.appendChild(li);
  });
  if (state.peers.size > 0) placeholder.classList.add('hidden');
  else if (!state.currentRoom) placeholder.classList.remove('hidden');
  updateGridLayout();
}

export function updateGridLayout() {
  const area = document.getElementById('videoArea');
  if (!area) return;
  // total tiles = 1 (self) + N peers
  const n = state.peers.size + 1;
  let layout = 'solo';
  if (n === 2) layout = 'pair';
  else if (n <= 4) layout = 'grid';
  else layout = 'spotlight';
  area.dataset.layout = layout;
  area.dataset.count = String(n);
}
