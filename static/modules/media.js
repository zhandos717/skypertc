import { state } from './state.js';
import { BgEffect } from './bg-effect.js';
import { toastError } from './toast.js';

const localVideo = document.getElementById('localVideo');

let bgEffect = null;

export function startSpeakingDetection(stream, tileEl) {
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
      if (is !== speaking) { speaking = is; tileEl.classList.toggle('speaking', speaking); }
    }, 80);
    return () => { clearInterval(timer); ctx.close(); tileEl.classList.remove('speaking'); };
  } catch { return () => {}; }
}

export async function ensureMedia() {
  if (state.localStream) return state.localStream;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:  { ideal: 1280, max: 1920 },
        height: { ideal: 720,  max: 1080 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    const vTrack = state.localStream.getVideoTracks()[0];
    if (vTrack) vTrack.contentHint = 'motion';
    localVideo.srcObject = state.localStream;
    const selfTile = localVideo.closest('.video-tile');
    if (selfTile) startSpeakingDetection(state.localStream, selfTile);
    wireVisibilityPause();
  } catch (e) {
    toastError('Не удалось получить доступ к камере/микрофону: ' + e.message);
    throw e;
  }
  return state.localStream;
}

// Raw camera track (without effect). Always points to the underlying device track.
let rawCameraTrack = null;

function getRawCameraTrack() {
  if (rawCameraTrack && rawCameraTrack.readyState === 'live') return rawCameraTrack;
  return state.localStream?.getVideoTracks()[0] || null;
}

export async function enableBgBlur() {
  return enableBgEffect({ mode: 'blur', blurPx: 14 });
}

export async function enableBgImage(imageUrl) {
  return enableBgEffect({ mode: 'image', imageUrl });
}

async function enableBgEffect(opts) {
  const raw = getRawCameraTrack();
  if (!raw) return null;
  // If an effect is already running, stop it first.
  if (bgEffect) { bgEffect.stop(); bgEffect = null; }
  rawCameraTrack = raw;
  bgEffect = new BgEffect(raw, opts);
  await bgEffect.start();
  const processed = bgEffect.outTrack;
  await replaceVideoTrackEverywhere(processed);
  const preview = new MediaStream([processed]);
  state.localStream?.getAudioTracks().forEach(t => preview.addTrack(t));
  localVideo.srcObject = preview;
  return processed;
}

export async function disableBgBlur() {
  if (!bgEffect) return;
  const raw = rawCameraTrack && rawCameraTrack.readyState === 'live' ? rawCameraTrack : null;
  bgEffect.stop();
  bgEffect = null;
  if (raw) {
    await replaceVideoTrackEverywhere(raw);
    localVideo.srcObject = state.localStream;
  }
}

export function isBgBlurOn() { return !!bgEffect; }

export async function setMusicMode(on) {
  if (!state.localStream) return;
  state.musicMode = !!on;
  // Re-acquire audio with appropriate constraints.
  const constraints = on ? {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    sampleRate: 48000,
    sampleSize: 16,
  } : {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
  } catch (e) {
    toastError('Не удалось переключить аудио: ' + (e?.message || e));
    state.musicMode = !on;
    return;
  }
  const newTrack = newStream.getAudioTracks()[0];
  const oldTrack = state.localStream.getAudioTracks()[0];
  for (const { pc } of state.peers.values()) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) {
      try { await sender.replaceTrack(newTrack); } catch (e) { console.warn(e); }
    }
  }
  if (oldTrack) { state.localStream.removeTrack(oldTrack); oldTrack.stop(); }
  state.localStream.addTrack(newTrack);
}

// Pause video upload when tab is hidden — saves ~1-3 Mbps and CPU.
let visibilityWired = false;
function wireVisibilityPause() {
  if (visibilityWired) return;
  visibilityWired = true;
  let prevVideoEnabled = true;
  document.addEventListener('visibilitychange', () => {
    const t = state.localStream?.getVideoTracks()[0];
    if (!t) return;
    if (document.hidden) {
      prevVideoEnabled = t.enabled;
      t.enabled = false;
    } else {
      t.enabled = prevVideoEnabled;
    }
  });
}

export async function replaceVideoTrackEverywhere(newTrack) {
  for (const { pc } of state.peers.values()) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      try { await sender.replaceTrack(newTrack); } catch (e) { console.warn(e); }
    }
  }
}

export function wireMediaButtons({ send }) {
  const micBtn = document.getElementById('micBtn');
  const camBtn = document.getElementById('camBtn');
  const screenBtn = document.getElementById('screenBtn');
  const flipBtn = document.getElementById('flipBtn');

  const moreBtn = document.getElementById('moreBtn');
  const moreMenu = document.getElementById('moreMenu');
  const miBgBlur = document.getElementById('miBgBlur');
  const miBgImage = document.getElementById('miBgImage');
  const miBgOff = document.getElementById('miBgOff');
  const miMusic = document.getElementById('miMusic');
  const miDocPip = document.getElementById('miDocPip');
  const bgImageInput = document.getElementById('bgImageInput');
  let screenStream = null;
  let cameraVideoTrack = null;
  let bgBusy = false;

  function refreshMoreMenu() {
    const bgOn = isBgBlurOn();
    miBgBlur.classList.toggle('active', bgOn);
    miBgBlur.querySelector('.more-state').dataset.state = bgOn ? 'on' : 'off';
    miBgBlur.querySelector('.more-state').textContent = bgOn ? 'вкл' : 'выкл';
    miBgOff.hidden = !bgOn;
    miBgImage.disabled = !!screenStream;
    miBgBlur.disabled = !!screenStream;

    miMusic.classList.toggle('active', state.musicMode);
    miMusic.querySelector('.more-state').dataset.state = state.musicMode ? 'on' : 'off';
    miMusic.querySelector('.more-state').textContent = state.musicMode ? 'вкл' : 'выкл';
  }

  function openMoreMenu() {
    moreMenu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    refreshMoreMenu();
    setTimeout(() => document.addEventListener('click', onDocClick, { once: true }), 0);
  }
  function closeMoreMenu() {
    moreMenu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
  }
  function onDocClick(ev) {
    if (!moreMenu.contains(ev.target) && ev.target !== moreBtn && !moreBtn.contains(ev.target)) {
      closeMoreMenu();
    } else if (moreMenu.contains(ev.target)) {
      // re-arm if click was inside menu but not on item
      setTimeout(() => document.addEventListener('click', onDocClick, { once: true }), 0);
    }
  }

  if (moreBtn) {
    moreBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (moreMenu.hidden) openMoreMenu(); else closeMoreMenu();
    };
  }

  async function toggleBgBlur() {
    if (bgBusy) return;
    if (screenStream) return;
    if (!state.localStream) { await ensureMedia(); }
    bgBusy = true;
    try {
      if (isBgBlurOn()) await disableBgBlur();
      else await enableBgBlur();
    } catch (e) {
      console.warn('bg blur failed:', e);
      toastError('Не удалось включить размытие фона: ' + (e?.message || e));
    } finally {
      bgBusy = false;
      refreshMoreMenu();
    }
  }

  if (miBgBlur) miBgBlur.onclick = async () => { await toggleBgBlur(); closeMoreMenu(); };
  if (miBgOff)  miBgOff.onclick  = async () => {
    if (isBgBlurOn()) { await disableBgBlur(); refreshMoreMenu(); }
    closeMoreMenu();
  };
  if (miBgImage && bgImageInput) {
    miBgImage.onclick = () => { bgImageInput.click(); };
    bgImageInput.onchange = async () => {
      const file = bgImageInput.files?.[0];
      bgImageInput.value = '';
      if (!file) return;
      if (screenStream) { toastError('Сначала выключите показ экрана'); return; }
      if (!state.localStream) { await ensureMedia(); }
      bgBusy = true;
      try {
        const url = URL.createObjectURL(file);
        await enableBgImage(url);
      } catch (e) {
        toastError('Не удалось применить фон: ' + (e?.message || e));
      } finally {
        bgBusy = false;
        refreshMoreMenu();
        closeMoreMenu();
      }
    };
  }

  if (miDocPip) {
    import('./doc-pip.js').then(({ isDocPipSupported, toggleDocPip }) => {
      if (!isDocPipSupported()) {
        miDocPip.hidden = true;
        return;
      }
      miDocPip.onclick = async () => {
        try { await toggleDocPip(); }
        catch (e) { toastError('Не удалось открыть плавающее окно: ' + (e?.message || e)); }
        closeMoreMenu();
      };
    });
  }

  if (miMusic) {
    let musicBusy = false;
    miMusic.onclick = async () => {
      if (musicBusy) return;
      musicBusy = true;
      try {
        await setMusicMode(!state.musicMode);
        const { tweakOpusSdp } = await import('./peer.js');
        for (const [pid, { pc }] of state.peers) {
          try {
            const offer = await pc.createOffer();
            offer.sdp = tweakOpusSdp(offer.sdp);
            await pc.setLocalDescription(offer);
            send({ type: 'offer', to: pid, payload: pc.localDescription });
          } catch (e) { console.warn('music-mode renegotiate:', e); }
        }
      } finally {
        musicBusy = false;
        refreshMoreMenu();
        closeMoreMenu();
      }
    };
  }

  micBtn.onclick = () => {
    if (!state.localStream) return;
    const t = state.localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    micBtn.classList.toggle('off', !t.enabled);
  };

  camBtn.onclick = () => {
    if (!state.localStream) return;
    const t = state.localStream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    camBtn.classList.toggle('off', !t.enabled);
  };

  async function startScreenShare() {
    if (isBgBlurOn()) {
      await disableBgBlur();
      refreshMoreMenu();
    }
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
    screenTrack.contentHint = 'detail';
    cameraVideoTrack = state.localStream?.getVideoTracks()[0] || null;
    await replaceVideoTrackEverywhere(screenTrack);
    const preview = new MediaStream([screenTrack]);
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach(t => preview.addTrack(t));
    }
    localVideo.srcObject = preview;
    screenBtn.classList.add('off');
    screenTrack.onended = stopScreenShare;
  }

  async function stopScreenShare() {
    if (!screenStream) return;
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    if (cameraVideoTrack) {
      await replaceVideoTrackEverywhere(cameraVideoTrack);
    }
    localVideo.srcObject = state.localStream;
    screenBtn.classList.remove('off');
  }

  screenBtn.onclick = async () => {
    if (!state.localStream) { await ensureMedia(); }
    if (screenStream) stopScreenShare();
    else startScreenShare();
  };

  let flipBusy = false;
  flipBtn.onclick = async () => {
    if (!state.localStream || flipBusy) return;
    flipBusy = true;
    flipBtn.classList.add('off');
    try {
      if (isBgBlurOn()) {
        await disableBgBlur();
        bgBtn?.classList.remove('on');
      }
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter(d => d.kind === 'videoinput');
      if (devices.length < 2) return;
      const curTrack = state.localStream.getVideoTracks()[0];
      const curId = curTrack?.getSettings?.().deviceId;
      const idx = devices.findIndex(d => d.deviceId === curId);
      const next = devices[(idx + 1) % devices.length];
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: next.deviceId } },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      newTrack.contentHint = 'motion';
      await replaceVideoTrackEverywhere(newTrack);
      if (curTrack) { state.localStream.removeTrack(curTrack); curTrack.stop(); }
      state.localStream.addTrack(newTrack);
      localVideo.srcObject = state.localStream;
    } catch (e) {
      console.warn('flip camera:', e);
    } finally {
      flipBusy = false;
      flipBtn.classList.remove('off');
    }
  };
}
