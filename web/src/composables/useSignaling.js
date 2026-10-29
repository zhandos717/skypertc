// WebSocket signaling — owns the connection, reconnect backoff, room join/leave
// flow, and dispatches incoming messages to peer / chat / reaction composables.
import { state, internals, wsSend } from '../stores/app.js';
import { ensureMedia } from './useMedia.js';
import { createPeer, removePeer, clearAllPeers, getPc } from './usePeers.js';
import { tweakOpusSdp } from '../services/sdp.js';
import { addRecent } from './useRooms.js';
import { addChat } from './useChat.js';
import { showRemoteReaction } from './useReactions.js';
import { toastError } from './useToast.js';

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function onReaction(peerId, emoji) {
  showRemoteReaction(peerId, emoji);
}

function attachHandlers(ws) {
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'welcome': {
        state.myId = m.id;
        state.connectionStatus = `${m.peers.length} участник(ов)`;
        for (const p of m.peers) {
          state.peerNames.set(p.id, p.name || 'Собеседник');
          if (p.recorder) state.hiddenPeers.add(p.id);
          createPeer(p.id, true, { send: wsSend, onReaction });
        }
        break;
      }
      case 'peer-joined': {
        state.peerNames.set(m.from, m.name || 'Собеседник');
        if (m.recorder) state.hiddenPeers.add(m.from);
        state.connectionStatus = `${state.peers.size + 1} участник(ов)`;
        break;
      }
      case 'peer-left': {
        removePeer(m.from);
        break;
      }
      case 'offer': {
        state.peerNames.set(m.from, state.peerNames.get(m.from) || 'Собеседник');
        let pc = getPc(m.from);
        if (!pc) { ({ pc } = createPeer(m.from, false, { send: wsSend, onReaction })); }
        await pc.setRemoteDescription(m.payload);
        const ans = await pc.createAnswer();
        ans.sdp = tweakOpusSdp(ans.sdp, state.musicMode);
        await pc.setLocalDescription(ans);
        wsSend({ type: 'answer', to: m.from, payload: pc.localDescription });
        break;
      }
      case 'answer': {
        const pc = getPc(m.from);
        if (pc) await pc.setRemoteDescription(m.payload);
        break;
      }
      case 'ice': {
        const pc = getPc(m.from);
        if (pc && m.payload) {
          try { await pc.addIceCandidate(m.payload); } catch (e) { console.warn(e); }
        }
        break;
      }
      case 'chat': {
        let txt = m.payload;
        try { if (typeof txt === 'string') txt = JSON.parse(txt); } catch {}
        addChat(state.peerNames.get(m.from) || 'Собеседник', String(txt), false);
        break;
      }
      case 'react': {
        let emoji = m.payload;
        try { if (typeof emoji === 'string') emoji = JSON.parse(emoji); } catch {}
        showRemoteReaction(m.from, String(emoji));
        break;
      }
      case 'denied': {
        toastError('Не удалось войти: ' + (m.reason || 'отказано'));
        leave();
        break;
      }
    }
  };

  ws.onclose = () => {
    if (!state.currentRoom) { state.connectionStatus = 'Отключено'; return; }
    const MAX = 5;
    if (internals.reconnectAttempts >= MAX) { state.connectionStatus = 'Отключено'; return; }
    internals.reconnectAttempts++;
    const delay = Math.pow(2, internals.reconnectAttempts - 1) * 1000;
    state.connectionStatus = `Переподключение через ${delay / 1000}с... (${internals.reconnectAttempts}/${MAX})`;
    internals.reconnectTimer = setTimeout(() => {
      internals.reconnectTimer = null;
      if (!state.currentRoom) return;
      const savedRoom = state.currentRoom;
      const savedSecret = state.currentSecret;
      clearAllPeers();
      const newWs = new WebSocket(wsUrl());
      state.ws = newWs;
      newWs.onopen = () => {
        internals.reconnectAttempts = 0;
        state.connectionStatus = 'Подключение...';
        wsSend({ type: 'join', room: savedRoom, name: state.userName, public: !savedSecret, secret: savedSecret });
      };
      attachHandlers(newWs);
    }, delay);
  };
}

export async function join({ room, isPublic, secret }) {
  // Idempotency guards: ignore repeat clicks on the same target room and any
  // overlapping in-flight join. Without these the WS churns and the server
  // sees multiple sequential 'join' messages from the same client.
  if (state.joining) return;
  if (state.currentRoom === room) return;

  state.joining = true;
  try {
    // Tear down any prior connection so its onclose can't trigger reconnect.
    if (state.ws) {
      try { state.ws.onclose = null; state.ws.onmessage = null; state.ws.onerror = null; } catch {}
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
    if (internals.reconnectTimer !== null) {
      clearTimeout(internals.reconnectTimer);
      internals.reconnectTimer = null;
    }
    internals.reconnectAttempts = 0;
    clearAllPeers();
    state.currentRoom = null;
    state.connectionStatus = 'Подключение...';

    await ensureMedia();

    state.currentSecret = secret || '';
    const ws = new WebSocket(wsUrl());
    state.ws = ws;

    ws.onopen = () => {
      wsSend({ type: 'join', room, name: state.userName, public: isPublic, secret: secret || '' });
      state.currentRoom = room;
      state.connectionStatus = 'Подключение...';
      addRecent(room);
      const hashVal = encodeURIComponent(room) + (secret ? (':' + secret) : '');
      if (location.hash.replace(/^#/, '') !== hashVal) {
        history.replaceState(null, '', '#' + hashVal);
      }
      if (window.innerWidth <= 700) state.mobileTab = 'main';
      state.joining = false;
    };
    ws.onerror = () => { state.joining = false; };

    attachHandlers(ws);
  } catch (e) {
    state.joining = false;
    throw e;
  }
}

export function leave() {
  if (internals.reconnectTimer !== null) {
    clearTimeout(internals.reconnectTimer);
    internals.reconnectTimer = null;
  }
  internals.reconnectAttempts = 0;
  state.currentRoom = null;
  state.joining = false;
  clearAllPeers();
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.onmessage = null; state.ws.onerror = null; } catch {}
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
  state.connectionStatus = '';
  state.currentSecret = '';
  history.replaceState(null, '', location.pathname);
  if (window.innerWidth <= 700) state.mobileTab = 'sidebar';
}

export async function loadIceConfig() {
  try {
    const r = await fetch('/config.json', { cache: 'no-store' });
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
      state.rtcConfig = cfg;
    }
  } catch {}
}

export function useSignaling() {
  return { join, leave, loadIceConfig };
}
