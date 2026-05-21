import { state } from './state.js';

export function showReaction(tileEl, emoji) {
  const el = document.createElement('div');
  el.className = 'reaction-float';
  el.textContent = emoji;
  tileEl.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

export function wireReactionsBar(send) {
  const localVideo = document.getElementById('localVideo');
  document.querySelectorAll('.react-btn').forEach(btn => {
    btn.onclick = () => {
      const emoji = btn.dataset.emoji;
      const selfTile = localVideo.closest('.video-tile');
      if (selfTile) showReaction(selfTile, emoji);
      btn.style.transform = 'scale(1.5)';
      setTimeout(() => (btn.style.transform = ''), 200);
      // Send via DataChannel if available, fallback to WS signaling.
      const msg = JSON.stringify({ type: 'react', emoji });
      let sent = 0;
      for (const { events } of state.peers.values()) {
        if (events && events.readyState === 'open') {
          try { events.send(msg); sent++; } catch {}
        }
      }
      if (sent === 0 && state.ws && state.ws.readyState === WebSocket.OPEN) {
        send({ type: 'react', payload: JSON.stringify(emoji) });
      }
    };
  });
}

export function wireNameEdit() {
  const meName = document.getElementById('meName');
  const meAvatar = document.getElementById('meAvatar');
  state.userName = localStorage.getItem('skypertc.name') ||
    (() => { const n = prompt('Ваше имя?', 'Гость') || 'Гость'; localStorage.setItem('skypertc.name', n); return n; })();
  meName.textContent = state.userName;
  meAvatar.textContent = state.userName.charAt(0).toUpperCase();

  document.getElementById('nameEditBtn').onclick = () => {
    const n = prompt('Ваше имя?', state.userName);
    if (!n || n === state.userName) return;
    state.userName = n.trim() || state.userName;
    localStorage.setItem('skypertc.name', state.userName);
    meName.textContent = state.userName;
    meAvatar.textContent = state.userName.charAt(0).toUpperCase();
  };
}

export function wireLocalFullscreen() {
  const localVideo = document.getElementById('localVideo');
  document.getElementById('localFsBtn').onclick = (e) => {
    e.stopPropagation();
    const tile = localVideo.closest('.video-tile');
    if (document.fullscreenElement) document.exitFullscreen();
    else tile?.requestFullscreen?.();
  };
  const pipBtn = document.getElementById('localPipBtn');
  if (pipBtn) {
    if (!document.pictureInPictureEnabled) pipBtn.hidden = true;
    else pipBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        if (document.pictureInPictureElement === localVideo) await document.exitPictureInPicture();
        else await localVideo.requestPictureInPicture();
      } catch (err) { console.warn('PiP:', err); }
    };
  }
}

export function wireMobileNav() {
  const chatPanel = document.getElementById('chatPanel');
  const chatBtn = document.getElementById('chatBtn');
  const chatBadge = document.getElementById('chatBadge');

  const tabletBackdrop = document.createElement('div');
  tabletBackdrop.className = 'chatBtn-backdrop';
  document.body.appendChild(tabletBackdrop);

  const panels = {
    sidebar: document.querySelector('.sidebar'),
    main:    document.querySelector('.main'),
    chat:    chatPanel,
  };
  const tabs = document.querySelectorAll('.mob-tab');

  function showMobTab(name) {
    Object.entries(panels).forEach(([k, el]) => {
      el.classList.toggle('mob-active', k === name);
    });
    tabs.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === name));
    if (name === 'chat') chatBadge.classList.remove('visible');
  }

  chatBtn.onclick = () => {
    if (window.innerWidth <= 700) {
      showMobTab('chat');
    } else {
      const opening = !chatPanel.classList.contains('open');
      chatPanel.classList.toggle('open', opening);
      tabletBackdrop.classList.toggle('active', opening);
      if (opening) chatBadge.classList.remove('visible');
    }
  };

  tabletBackdrop.onclick = () => {
    chatPanel.classList.remove('open');
    tabletBackdrop.classList.remove('active');
  };

  tabs.forEach(btn => btn.onclick = () => showMobTab(btn.dataset.tab));

  if (window.innerWidth <= 700) showMobTab('main');

  // Auto-switch to main when joining
  document.getElementById('joinBtn').addEventListener('click', () => {
    if (window.innerWidth <= 700) showMobTab('main');
  }, true);

  // Chat badge when message arrives and chat not active
  window._onChatMsg = () => {
    const chatActive = chatPanel.classList.contains('mob-active') ||
                       chatPanel.classList.contains('open');
    if (!chatActive) chatBadge.classList.add('visible');
  };
}
