import { state } from './modules/state.js';
import { ensureMedia, wireMediaButtons } from './modules/media.js';
import { createPeer, removePeer, tweakOpusSdp } from './modules/peer.js';
import { addChat, wireChatForm } from './modules/chat.js';
import { initRooms, addRecent } from './modules/rooms.js';
import { showReaction, wireReactionsBar, wireNameEdit, wireLocalFullscreen, wireMobileNav } from './modules/ui.js';
import { toastError } from './modules/toast.js';

let reconnectAttempts = 0;
let reconnectTimer = null;

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

const remotesEl = document.getElementById('remotes');
const placeholder = document.getElementById('placeholder');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const callBtn = document.getElementById('callBtn');
const hangBtn = document.getElementById('hangBtn');
const roomInput = document.getElementById('roomInput');
const roomName = document.getElementById('roomName');
const roomSub = document.getElementById('roomSub');
const roomAvatar = document.getElementById('roomAvatar');
const copyLinkBtn = document.getElementById('copyLinkBtn');

// Fetch ICE config from server (env-driven). Falls back to default if request fails.
fetch('/config.json', { cache: 'no-store' })
  .then(r => r.ok ? r.json() : null)
  .then(cfg => { if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) state.rtcConfig = cfg; })
  .catch(() => {});

function attachWsHandlers(ws, room, secret, isPublic) {
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'welcome': {
        state.myId = m.id;
        roomSub.textContent = `${m.peers.length} участник(ов)`;
        for (const p of m.peers) {
          state.peerNames.set(p.id, p.name || 'Собеседник');
          createPeer(p.id, true, { send, remotesEl });
        }
        break;
      }
      case 'peer-joined': {
        state.peerNames.set(m.from, m.name || 'Собеседник');
        roomSub.textContent = `${state.peers.size + 1} участник(ов)`;
        break;
      }
      case 'peer-left': {
        removePeer(m.from);
        break;
      }
      case 'offer': {
        state.peerNames.set(m.from, state.peerNames.get(m.from) || 'Собеседник');
        let entry = state.peers.get(m.from) || createPeer(m.from, false, { send, remotesEl });
        await entry.pc.setRemoteDescription(m.payload);
        const ans = await entry.pc.createAnswer();
        ans.sdp = tweakOpusSdp(ans.sdp);
        await entry.pc.setLocalDescription(ans);
        send({ type: 'answer', to: m.from, payload: entry.pc.localDescription });
        break;
      }
      case 'answer': {
        const entry = state.peers.get(m.from);
        if (entry) await entry.pc.setRemoteDescription(m.payload);
        break;
      }
      case 'ice': {
        const entry = state.peers.get(m.from);
        if (entry && m.payload) {
          try { await entry.pc.addIceCandidate(m.payload); } catch (e) { console.warn(e); }
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
        const entry = state.peers.get(m.from);
        if (entry?.tile) showReaction(entry.tile, String(emoji));
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
    if (!state.currentRoom) {
      roomSub.textContent = 'Отключено';
      return;
    }
    const MAX = 5;
    if (reconnectAttempts >= MAX) {
      roomSub.textContent = 'Отключено';
      return;
    }
    reconnectAttempts++;
    const delay = Math.pow(2, reconnectAttempts - 1) * 1000;
    roomSub.textContent = `Переподключение через ${delay / 1000}с... (${reconnectAttempts}/${MAX})`;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!state.currentRoom) return;
      const savedRoom = state.currentRoom;
      const savedSecret = state.currentSecret;
      state.peers.forEach((_, id) => removePeer(id));
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const newWs = new WebSocket(`${proto}://${location.host}/ws`);
      state.ws = newWs;
      newWs.onopen = () => {
        reconnectAttempts = 0;
        roomSub.textContent = 'Подключение...';
        send({ type: 'join', room: savedRoom, name: state.userName, public: !savedSecret, secret: savedSecret });
      };
      attachWsHandlers(newWs, savedRoom, savedSecret, !savedSecret);
    }, delay);
  };
}

async function join() {
  const room = roomInput.value.trim();
  if (!room) { roomInput.focus(); return; }
  const isPublic = document.getElementById('publicChk').checked;
  let secret = state.currentSecret;
  if (!isPublic && !secret) {
    secret = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
  if (isPublic) secret = '';
  state.currentSecret = secret;

  await ensureMedia();

  if (state.ws) state.ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);

  state.ws.onopen = () => {
    send({ type: 'join', room, name: state.userName, public: isPublic, secret });
    state.currentRoom = room;
    roomName.textContent = '# ' + room;
    roomSub.textContent = 'Подключение...';
    roomAvatar.textContent = room.charAt(0).toUpperCase();
    addRecent(room);
    leaveBtn.disabled = false;
    callBtn.disabled = false;
    hangBtn.disabled = false;
    copyLinkBtn.disabled = false;
    const hashVal = encodeURIComponent(room) + (secret ? (':' + secret) : '');
    if (location.hash.replace(/^#/, '') !== hashVal) {
      history.replaceState(null, '', '#' + hashVal);
    }
    placeholder.classList.add('hidden');
  };

  attachWsHandlers(state.ws, room, secret, isPublic);
}

function leave() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  state.currentRoom = null;
  state.peers.forEach((_, id) => removePeer(id));
  if (state.ws) { state.ws.close(); state.ws = null; }
  roomName.textContent = 'Выберите комнату';
  roomSub.textContent = 'Введите название и нажмите «Присоединиться»';
  roomAvatar.textContent = '#';
  leaveBtn.disabled = true;
  callBtn.disabled = true;
  hangBtn.disabled = true;
  copyLinkBtn.disabled = true;
  state.currentSecret = '';
  document.getElementById('publicChk').disabled = false;
  history.replaceState(null, '', location.pathname);
  placeholder.classList.remove('hidden');
}

// Copy link button
copyLinkBtn.onclick = async () => {
  if (!state.currentRoom) return;
  const url = `${location.origin}/#${encodeURIComponent(state.currentRoom)}`;
  try {
    await navigator.clipboard.writeText(url);
    const icon = copyLinkBtn.querySelector('i');
    if (icon) icon.style.display = 'none';
    const check = document.createElement('span');
    check.textContent = '✓';
    copyLinkBtn.appendChild(check);
    setTimeout(() => { check.remove(); if (icon) icon.style.display = ''; }, 1200);
  } catch {
    prompt('Скопируйте ссылку:', url);
  }
};

// Auto-join from URL hash (#room or #room:secret)
function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  if (!raw) return { room: '', secret: '' };
  const idx = raw.indexOf(':');
  if (idx < 0) return { room: decodeURIComponent(raw).trim(), secret: '' };
  return { room: decodeURIComponent(raw.slice(0, idx)).trim(), secret: raw.slice(idx + 1) };
}

const initial = parseHash();
if (initial.room) {
  roomInput.value = initial.room;
  state.currentSecret = initial.secret;
  if (initial.secret) {
    document.getElementById('publicChk').checked = false;
    document.getElementById('publicChk').disabled = true;
  }
}

window.addEventListener('hashchange', () => {
  const h = parseHash();
  if (h.room && h.room !== state.currentRoom) {
    roomInput.value = h.room;
    state.currentSecret = h.secret;
  }
});

// Button wiring
joinBtn.onclick = () => join().catch(console.error);
leaveBtn.onclick = leave;
hangBtn.onclick = leave;
callBtn.onclick = () => { if (!state.currentRoom) join(); };
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join().catch(console.error);
});

// Theme switcher (auto / dark / light), persisted in localStorage.
(() => {
  const saved = localStorage.getItem('skypertc.theme') || 'auto';
  applyTheme(saved);
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('skypertc.theme', t);
    const el = document.getElementById('miTheme');
    if (el) el.querySelector('.more-state').textContent = t === 'auto' ? 'авто' : (t === 'dark' ? 'тёмная' : 'светлая');
  }
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('miTheme');
    if (!btn) return;
    applyTheme(localStorage.getItem('skypertc.theme') || 'auto');
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const cur = localStorage.getItem('skypertc.theme') || 'auto';
      const next = cur === 'auto' ? 'dark' : (cur === 'dark' ? 'light' : 'auto');
      applyTheme(next);
    };
  });
})();

// Register Service Worker (caches MediaPipe assets after first load).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW register:', e));
}

// Wire up all modules
wireNameEdit();
wireChatForm(send);
wireMediaButtons({ send });
wireReactionsBar(send);
wireLocalFullscreen();
wireMobileNav();
initRooms();
