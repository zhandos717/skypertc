(() => {
  const $ = (id) => document.getElementById(id);
  const localVideo = $('localVideo');
  const remotesEl = $('remotes');
  const placeholder = $('placeholder');
  const joinBtn = $('joinBtn');
  const leaveBtn = $('leaveBtn');
  const callBtn = $('callBtn');
  const hangBtn = $('hangBtn');
  const micBtn = $('micBtn');
  const camBtn = $('camBtn');
  const roomInput = $('roomInput');
  const roomName = $('roomName');
  const roomSub = $('roomSub');
  const roomAvatar = $('roomAvatar');
  const peersList = $('peers');
  const recentList = $('recent');
  const chatForm = $('chatForm');
  const chatText = $('chatText');
  const chatMsgs = $('chatMsgs');
  const meName = $('meName');
  const meAvatar = $('meAvatar');

  const userName = localStorage.getItem('skypertc.name') ||
    (() => { const n = prompt('Ваше имя?', 'Гость') || 'Гость'; localStorage.setItem('skypertc.name', n); return n; })();
  meName.textContent = userName;
  meAvatar.textContent = userName.charAt(0).toUpperCase();

  const recent = JSON.parse(localStorage.getItem('skypertc.recent') || '[]');
  renderRecent();

  function renderRecent() {
    recentList.innerHTML = '';
    recent.slice(0, 6).forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `<div class="avatar small">#</div><div><div class="name">${r}</div><div class="sub">Комната</div></div>`;
      li.onclick = () => { roomInput.value = r; };
      recentList.appendChild(li);
    });
  }
  function addRecent(name) {
    const i = recent.indexOf(name);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(name);
    localStorage.setItem('skypertc.recent', JSON.stringify(recent.slice(0, 10)));
    renderRecent();
  }

  let ws = null;
  let localStream = null;
  let myId = null;
  let currentRoom = null;
  const peers = new Map(); // id -> {pc, name, videoEl}
  const peerNames = new Map();

  let rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };
  // Fetch ICE config from server (env-driven). Falls back to default if request fails.
  fetch('/config.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(cfg => { if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) rtcConfig = cfg; })
    .catch(() => {});

  async function ensureMedia() {
    if (localStream) return localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width:  { ideal: 640, max: 1280 },
          height: { ideal: 360, max: 720 },
          frameRate: { ideal: 24, max: 30 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      localVideo.srcObject = localStream;
    } catch (e) {
      alert('Не удалось получить доступ к камере/микрофону: ' + e.message);
      throw e;
    }
    return localStream;
  }

  // ===== Adaptive Bitrate Controller (AIMD) =====
  // Quality tiers — auto-switched based on network conditions.
  const TIERS = [
    { name: 'low',  maxBitrate:  120_000, scale: 4, fps: 12, audio: 16_000 }, // 160x90, 12fps
    { name: 'med',  maxBitrate:  350_000, scale: 2, fps: 20, audio: 24_000 }, // 320x180, 20fps
    { name: 'high', maxBitrate:  900_000, scale: 1, fps: 30, audio: 32_000 }, // 640x360, 30fps
    { name: 'hd',   maxBitrate: 2_000_000, scale: 1, fps: 30, audio: 48_000 },
  ];

  function makeAbr(pc, peerId) {
    const state = {
      tierIdx: 1,             // start at "med"
      currentBitrate: TIERS[1].maxBitrate,
      lastPacketsSent: 0,
      lastPacketsLost: 0,
      lastTs: 0,
      goodTicks: 0,
      timer: null,
    };

    async function applyTier(idx) {
      idx = Math.max(0, Math.min(TIERS.length - 1, idx));
      const tier = TIERS[idx];
      state.tierIdx = idx;
      state.currentBitrate = tier.maxBitrate;

      for (const sender of pc.getSenders()) {
        if (!sender.track) continue;
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        if (sender.track.kind === 'video') {
          params.encodings[0].maxBitrate = tier.maxBitrate;
          params.encodings[0].maxFramerate = tier.fps;
          params.encodings[0].scaleResolutionDownBy = tier.scale;
          params.degradationPreference = 'balanced';
        } else if (sender.track.kind === 'audio') {
          params.encodings[0].maxBitrate = tier.audio;
        }
        try { await sender.setParameters(params); } catch (e) { console.warn('setParameters', e); }
      }
      updateAbrBadge(peerId, tier, null, null);
    }

    async function setBitrate(bps) {
      bps = Math.max(60_000, Math.min(2_000_000, bps));
      state.currentBitrate = bps;
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = bps;
        try { await sender.setParameters(params); } catch {}
      }
    }

    async function tick() {
      if (pc.connectionState !== 'connected') return;
      let stats;
      try { stats = await pc.getStats(); } catch { return; }

      let rtt = 0, lossFraction = 0, availOut = 0;
      let packetsSent = 0, packetsLost = 0;
      let nackCount = 0;

      stats.forEach(r => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          packetsSent = r.packetsSent || 0;
          nackCount = r.nackCount || 0;
        }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
          packetsLost = r.packetsLost || 0;
          if (r.roundTripTime) rtt = r.roundTripTime;
        }
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
          if (r.availableOutgoingBitrate) availOut = r.availableOutgoingBitrate;
          if (r.currentRoundTripTime && !rtt) rtt = r.currentRoundTripTime;
        }
      });

      const sentDelta = Math.max(1, packetsSent - state.lastPacketsSent);
      const lostDelta = Math.max(0, packetsLost - state.lastPacketsLost);
      lossFraction = lostDelta / (sentDelta + lostDelta);
      state.lastPacketsSent = packetsSent;
      state.lastPacketsLost = packetsLost;

      // Decision: AIMD with hysteresis
      const tier = TIERS[state.tierIdx];
      let nextBitrate = state.currentBitrate;
      let action = 'hold';

      if (lossFraction > 0.10 || rtt > 0.6) {
        nextBitrate = Math.floor(state.currentBitrate * 0.6);  // hard cut
        state.goodTicks = 0;
        action = 'cut';
      } else if (lossFraction > 0.04 || rtt > 0.35) {
        nextBitrate = Math.floor(state.currentBitrate * 0.85); // soft cut
        state.goodTicks = 0;
        action = 'down';
      } else {
        state.goodTicks++;
        if (state.goodTicks >= 3) {
          nextBitrate = Math.floor(state.currentBitrate * 1.10); // additive grow
          action = 'up';
        }
      }

      // Respect Google congestion-control hint when available
      if (availOut > 0) {
        nextBitrate = Math.min(nextBitrate, Math.floor(availOut * 0.95));
      }

      // Tier switching when far outside current tier band
      if (nextBitrate < tier.maxBitrate * 0.5 && state.tierIdx > 0) {
        await applyTier(state.tierIdx - 1);
      } else if (nextBitrate > tier.maxBitrate * 1.3 && state.tierIdx < TIERS.length - 1 && state.goodTicks > 5) {
        await applyTier(state.tierIdx + 1);
        state.goodTicks = 0;
      } else if (Math.abs(nextBitrate - state.currentBitrate) > 20_000) {
        await setBitrate(nextBitrate);
      }

      updateAbrBadge(peerId, TIERS[state.tierIdx], lossFraction, rtt, state.currentBitrate, action);
    }

    state.timer = setInterval(tick, 2000);
    applyTier(state.tierIdx);

    return {
      stop() { clearInterval(state.timer); },
    };
  }

  function updateAbrBadge(peerId, tier, loss, rtt, bps, action) {
    const entry = peers.get(peerId);
    if (!entry || !entry.tile) return;
    let badge = entry.tile.querySelector('.abr-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'abr-badge';
      entry.tile.appendChild(badge);
    }
    const kbps = bps ? Math.round(bps / 1000) : Math.round(tier.maxBitrate / 1000);
    const lossStr = loss != null ? (loss * 100).toFixed(1) + '%' : '–';
    const rttStr = rtt != null ? Math.round(rtt * 1000) + 'мс' : '–';
    badge.innerHTML = `<span class="abr-tier abr-${tier.name}">${tier.name.toUpperCase()}</span> ${kbps} kbps · ${lossStr} · ${rttStr}`;
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function createPeer(id, initiator) {
    const pc = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'ice', to: id, payload: e.candidate });
    };
    pc.ontrack = (e) => {
      let entry = peers.get(id);
      if (!entry) return;
      if (!entry.videoEl) {
        const tile = document.createElement('div');
        tile.className = 'video-tile';
        tile.dataset.id = id;
        const v = document.createElement('video');
        v.autoplay = true; v.playsInline = true;
        const label = document.createElement('div');
        label.className = 'tile-label';
        label.textContent = entry.name || 'Собеседник';
        tile.appendChild(v); tile.appendChild(label);
        remotesEl.appendChild(tile);
        entry.videoEl = v;
        entry.tile = tile;
      }
      entry.videoEl.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        removePeer(id);
      }
    };

    const entry = { pc, name: peerNames.get(id) || 'Собеседник', videoEl: null, tile: null, abr: null };
    peers.set(id, entry);

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected' && !entry.abr) {
        entry.abr = makeAbr(pc, id);
      }
    });

    if (initiator) {
      (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'offer', to: id, payload: pc.localDescription });
      })();
    }
    renderPeers();
    return entry;
  }

  function removePeer(id) {
    const entry = peers.get(id);
    if (!entry) return;
    try { entry.abr?.stop(); } catch {}
    try { entry.pc.close(); } catch {}
    if (entry.tile) entry.tile.remove();
    peers.delete(id);
    renderPeers();
  }

  function renderPeers() {
    peersList.innerHTML = '';
    peers.forEach((e, id) => {
      const li = document.createElement('li');
      const initial = (e.name || '?').charAt(0).toUpperCase();
      li.innerHTML = `<div class="avatar small">${initial}</div><div><div class="name">${e.name}</div><div class="sub"><span class="dot online"></span>В звонке</div></div>`;
      peersList.appendChild(li);
    });
    if (peers.size > 0) placeholder.classList.add('hidden');
    else if (!currentRoom) placeholder.classList.remove('hidden');
  }

  let currentSecret = '';

  async function join() {
    const room = roomInput.value.trim();
    if (!room) { roomInput.focus(); return; }
    const isPublic = $('publicChk').checked;
    // Private = not public AND no inherited secret from URL → generate secret
    let secret = currentSecret;
    if (!isPublic && !secret) {
      secret = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    }
    if (isPublic) secret = ''; // public rooms have no secret
    currentSecret = secret;

    await ensureMedia();

    if (ws) ws.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      send({ type: 'join', room, name: userName, public: isPublic, secret });
      currentRoom = room;
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

    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.type) {
        case 'welcome': {
          myId = m.id;
          roomSub.textContent = `${m.peers.length} участник(ов)`;
          for (const p of m.peers) {
            peerNames.set(p.id, p.name || 'Собеседник');
            createPeer(p.id, true);
          }
          break;
        }
        case 'peer-joined': {
          peerNames.set(m.from, m.name || 'Собеседник');
          roomSub.textContent = `${peers.size + 1} участник(ов)`;
          break;
        }
        case 'peer-left': {
          removePeer(m.from);
          break;
        }
        case 'offer': {
          peerNames.set(m.from, peerNames.get(m.from) || 'Собеседник');
          let entry = peers.get(m.from) || createPeer(m.from, false);
          await entry.pc.setRemoteDescription(m.payload);
          const ans = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(ans);
          send({ type: 'answer', to: m.from, payload: entry.pc.localDescription });
          break;
        }
        case 'answer': {
          const entry = peers.get(m.from);
          if (entry) await entry.pc.setRemoteDescription(m.payload);
          break;
        }
        case 'ice': {
          const entry = peers.get(m.from);
          if (entry && m.payload) {
            try { await entry.pc.addIceCandidate(m.payload); } catch (e) { console.warn(e); }
          }
          break;
        }
        case 'chat': {
          let txt = m.payload;
          try { if (typeof txt === 'string') txt = JSON.parse(txt); } catch {}
          addChat(peerNames.get(m.from) || 'Собеседник', String(txt), false);
          break;
        }
        case 'denied': {
          alert('Не удалось войти: ' + (m.reason || 'отказано'));
          leave();
          break;
        }
      }
    };

    ws.onclose = () => {
      roomSub.textContent = 'Отключено';
    };
  }

  function leave() {
    peers.forEach((_, id) => removePeer(id));
    if (ws) { ws.close(); ws = null; }
    currentRoom = null;
    roomName.textContent = 'Выберите комнату';
    roomSub.textContent = 'Введите название и нажмите «Присоединиться»';
    roomAvatar.textContent = '#';
    leaveBtn.disabled = true;
    callBtn.disabled = true;
    hangBtn.disabled = true;
    copyLinkBtn.disabled = true;
    currentSecret = '';
    $('publicChk').disabled = false;
    history.replaceState(null, '', location.pathname);
    placeholder.classList.remove('hidden');
  }

  function addChat(from, text, mine) {
    const div = document.createElement('div');
    div.className = 'msg' + (mine ? ' mine' : '');
    div.innerHTML = `<div class="from">${from}</div>${escapeHtml(text)}`;
    chatMsgs.appendChild(div);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = chatText.value.trim();
    if (!t || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat', payload: JSON.stringify(t) }));
    addChat('Вы', t, true);
    chatText.value = '';
  });

  const copyLinkBtn = $('copyLinkBtn');
  copyLinkBtn.onclick = async () => {
    if (!currentRoom) return;
    const url = `${location.origin}/#${encodeURIComponent(currentRoom)}`;
    try {
      await navigator.clipboard.writeText(url);
      const old = copyLinkBtn.textContent;
      copyLinkBtn.textContent = '✓';
      setTimeout(() => (copyLinkBtn.textContent = old), 1200);
    } catch {
      prompt('Скопируйте ссылку:', url);
    }
  };

  // Auto-join from URL hash (#room or #room:secret) and keep hash in sync
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
    currentSecret = initial.secret;
    if (initial.secret) {
      $('publicChk').checked = false;
      $('publicChk').disabled = true;
    }
  }
  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h.room && h.room !== currentRoom) {
      roomInput.value = h.room;
      currentSecret = h.secret;
    }
  });

  // ===== Public rooms list =====
  const publicRoomsEl = $('publicRooms');
  async function refreshPublicRooms() {
    try {
      const r = await fetch('/rooms', { cache: 'no-store' });
      if (!r.ok) return;
      const list = await r.json();
      publicRoomsEl.innerHTML = '';
      if (!list || !list.length) {
        publicRoomsEl.innerHTML = '<li class="empty">Пока никого</li>';
        return;
      }
      list.sort((a, b) => b.count - a.count);
      for (const item of list) {
        const li = document.createElement('li');
        const initial = (item.name || '#').charAt(0).toUpperCase();
        li.innerHTML = `<div class="avatar small">${initial}</div>
          <div style="flex:1"><div class="name">${item.name}</div><div class="sub">${item.count} в комнате</div></div>
          <span class="count-pill">${item.count}</span>`;
        li.onclick = () => { roomInput.value = item.name; $('publicChk').checked = true; };
        publicRoomsEl.appendChild(li);
      }
    } catch {}
  }
  refreshPublicRooms();
  setInterval(refreshPublicRooms, 5000);

  joinBtn.onclick = () => join().catch(console.error);
  leaveBtn.onclick = leave;
  hangBtn.onclick = leave;
  callBtn.onclick = () => { if (!currentRoom) join(); };

  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join().catch(console.error);
  });

  micBtn.onclick = () => {
    if (!localStream) return;
    const t = localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    micBtn.classList.toggle('off', !t.enabled);
    micBtn.textContent = t.enabled ? '🎤' : '🔇';
  };
  // ===== Screen sharing =====
  const screenBtn = $('screenBtn');
  let screenStream = null;
  let cameraVideoTrack = null;

  async function replaceVideoTrackEverywhere(newTrack) {
    for (const { pc } of peers.values()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        try { await sender.replaceTrack(newTrack); } catch (e) { console.warn(e); }
      }
    }
  }

  async function startScreenShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
    } catch (e) {
      console.warn('display denied', e);
      return;
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    cameraVideoTrack = localStream?.getVideoTracks()[0] || null;
    await replaceVideoTrackEverywhere(screenTrack);
    // Show locally
    const preview = new MediaStream([screenTrack]);
    if (localStream) {
      localStream.getAudioTracks().forEach(t => preview.addTrack(t));
    }
    localVideo.srcObject = preview;
    screenBtn.classList.add('off');
    screenBtn.textContent = '🟥';
    screenTrack.onended = stopScreenShare; // browser "Stop sharing" button
  }

  async function stopScreenShare() {
    if (!screenStream) return;
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    if (cameraVideoTrack) {
      await replaceVideoTrackEverywhere(cameraVideoTrack);
    }
    localVideo.srcObject = localStream;
    screenBtn.classList.remove('off');
    screenBtn.textContent = '🖥️';
  }

  screenBtn.onclick = async () => {
    if (!localStream) { await ensureMedia(); }
    if (screenStream) stopScreenShare();
    else startScreenShare();
  };

  camBtn.onclick = () => {
    if (!localStream) return;
    const t = localStream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    camBtn.classList.toggle('off', !t.enabled);
    camBtn.textContent = t.enabled ? '📷' : '📵';
  };

  // Override chat payload: server forwards json.RawMessage as-is
  // We send chat payload already JSON-encoded string above. On receive, m.payload is a JSON string -> need parse
  const origAddChat = addChat;
  // Patch onmessage chat handler to parse JSON-encoded string
  // (handled inline by checking type via JSON.parse of payload)
})();
