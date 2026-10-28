// Local-media controller: getUserMedia, mic/cam toggles, screen share, camera
// flip, background blur/image, music-mode audio renegotiation.
import { ref } from 'vue';
import { state, internals, wsSend } from '../stores/app.js';
import { BgEffect } from '../services/bgEffect.js';
import { tweakOpusSdp } from '../services/sdp.js';
import { replaceVideoTrackEverywhere, startSpeakingDetection } from './usePeers.js';
import { applyPersisted } from './useDevices.js';
import { toastError } from './useToast.js';

export const micOn = ref(true);
export const camOn = ref(true);
export const screenOn = ref(false);

let visibilityWired = false;
function wireVisibilityPause() {
  if (visibilityWired) return;
  visibilityWired = true;
  let prevVideoEnabled = true;
  document.addEventListener('visibilitychange', () => {
    const t = state.localStream?.getVideoTracks()[0];
    if (!t) return;
    if (document.hidden) { prevVideoEnabled = t.enabled; t.enabled = false; }
    else { t.enabled = prevVideoEnabled; }
  });
}

export async function ensureMedia() {
  if (state.localStream) return state.localStream;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: state.audioOnly ? false : {
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
    // Self speaking detector.
    internals.selfSpeakStop?.();
    internals.selfSpeakStop = startSpeakingDetection(state.localStream, (sp) => {
      state.selfSpeaking = sp;
    });
    wireVisibilityPause();
    applyPersisted().catch(() => {});
  } catch (e) {
    toastError('Не удалось получить доступ к камере/микрофону: ' + e.message);
    throw e;
  }
  return state.localStream;
}

export function toggleMic() {
  const t = state.localStream?.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  micOn.value = t.enabled;
}

export function toggleCam() {
  const t = state.localStream?.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  camOn.value = t.enabled;
}

function getRawCameraTrack() {
  if (internals.rawCameraTrack && internals.rawCameraTrack.readyState === 'live') return internals.rawCameraTrack;
  return state.localStream?.getVideoTracks()[0] || null;
}

export async function enableBgBlur() { return enableBgEffect({ mode: 'blur', blurPx: 14 }); }
export async function enableBgImage(imageUrl) { return enableBgEffect({ mode: 'image', imageUrl }); }

async function enableBgEffect(opts) {
  const raw = getRawCameraTrack();
  if (!raw) return null;
  if (internals.bgEffect) { internals.bgEffect.stop(); internals.bgEffect = null; }
  internals.rawCameraTrack = raw;
  internals.bgEffect = new BgEffect(raw, opts);
  await internals.bgEffect.start();
  const processed = internals.bgEffect.outTrack;
  await replaceVideoTrackEverywhere(processed);
  // Self-preview composed: bg-effect track + original audio tracks.
  const preview = new MediaStream([processed]);
  state.localStream?.getAudioTracks().forEach(t => preview.addTrack(t));
  state.previewStream = preview;
  state.bgEffectOn = true;
  return processed;
}

export async function disableBgBlur() {
  if (!internals.bgEffect) return;
  const raw = internals.rawCameraTrack && internals.rawCameraTrack.readyState === 'live' ? internals.rawCameraTrack : null;
  internals.bgEffect.stop();
  internals.bgEffect = null;
  if (raw) await replaceVideoTrackEverywhere(raw);
  state.previewStream = null;
  state.bgEffectOn = false;
}

export function isBgBlurOn() { return !!internals.bgEffect; }

export async function setMusicMode(on) {
  if (!state.localStream) return;
  state.musicMode = !!on;
  const constraints = on ? {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    channelCount: 2, sampleRate: 48000, sampleSize: 16,
  } : {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
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
  for (const pc of internals.pcs.values()) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) { try { await sender.replaceTrack(newTrack); } catch (e) { console.warn(e); } }
  }
  if (oldTrack) { state.localStream.removeTrack(oldTrack); oldTrack.stop(); }
  state.localStream.addTrack(newTrack);
  // Renegotiate so the new Opus stereo SDP gets propagated.
  for (const [pid, pc] of internals.pcs) {
    try {
      const offer = await pc.createOffer();
      offer.sdp = tweakOpusSdp(offer.sdp, state.musicMode);
      await pc.setLocalDescription(offer);
      wsSend({ type: 'offer', to: pid, payload: pc.localDescription });
    } catch (e) { console.warn('music-mode renegotiate:', e); }
  }
}

export async function startScreenShare() {
  if (isBgBlurOn()) await disableBgBlur();
  try {
    internals.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
  } catch (e) { console.warn('display denied', e); return; }
  const screenTrack = internals.screenStream.getVideoTracks()[0];
  screenTrack.contentHint = 'detail';
  internals.cameraVideoTrack = state.localStream?.getVideoTracks()[0] || null;
  await replaceVideoTrackEverywhere(screenTrack);
  const preview = new MediaStream([screenTrack]);
  state.localStream?.getAudioTracks().forEach(t => preview.addTrack(t));
  state.previewStream = preview;
  state.screenSharing = true;
  screenOn.value = true;
  screenTrack.onended = stopScreenShare;
}

export async function stopScreenShare() {
  if (!internals.screenStream) return;
  internals.screenStream.getTracks().forEach(t => t.stop());
  internals.screenStream = null;
  if (internals.cameraVideoTrack) await replaceVideoTrackEverywhere(internals.cameraVideoTrack);
  state.previewStream = null;
  state.screenSharing = false;
  screenOn.value = false;
}

export async function toggleScreen() {
  if (!state.localStream) await ensureMedia();
  if (internals.screenStream) await stopScreenShare();
  else await startScreenShare();
}

let flipBusy = false;
export async function flipCamera() {
  if (!state.localStream || flipBusy) return;
  flipBusy = true;
  try {
    if (isBgBlurOn()) await disableBgBlur();
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    if (devices.length < 2) return;
    const curTrack = state.localStream.getVideoTracks()[0];
    const curId = curTrack?.getSettings?.().deviceId;
    const idx = devices.findIndex(d => d.deviceId === curId);
    const next = devices[(idx + 1) % devices.length];
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: next.deviceId } }, audio: false,
    });
    const newTrack = newStream.getVideoTracks()[0];
    newTrack.contentHint = 'motion';
    await replaceVideoTrackEverywhere(newTrack);
    if (curTrack) { state.localStream.removeTrack(curTrack); curTrack.stop(); }
    state.localStream.addTrack(newTrack);
  } catch (e) {
    console.warn('flip camera:', e);
  } finally {
    flipBusy = false;
  }
}

export function useMedia() {
  return {
    micOn, camOn, screenOn,
    ensureMedia, toggleMic, toggleCam, toggleScreen, flipCamera,
    enableBgBlur, enableBgImage, disableBgBlur, isBgBlurOn,
    setMusicMode,
  };
}
