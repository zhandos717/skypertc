// Audio/video device picker. Same persistence keys as the original module so
// existing users keep their saved selections.
import { ref } from 'vue';
import { state, internals } from '../stores/app.js';
import { replaceVideoTrackEverywhere } from './usePeers.js';
import { toastError } from './useToast.js';

const LS_MIC = 'skypertc.device.mic';
const LS_SPK = 'skypertc.device.speaker';
const LS_CAM = 'skypertc.device.camera';

export const devicesOpen = ref(false);

export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      mics:     all.filter(d => d.kind === 'audioinput'),
      speakers: all.filter(d => d.kind === 'audiooutput'),
      cameras:  all.filter(d => d.kind === 'videoinput'),
    };
  } catch { return { mics: [], speakers: [], cameras: [] }; }
}

export function getSaved() {
  return {
    mic:     localStorage.getItem(LS_MIC) || '',
    speaker: localStorage.getItem(LS_SPK) || '',
    camera:  localStorage.getItem(LS_CAM) || '',
  };
}

export function getCurrentIds() {
  const aTrack = state.localStream?.getAudioTracks?.()[0];
  const vTrack = state.localStream?.getVideoTracks?.()[0];
  return {
    mic:    aTrack?.getSettings?.().deviceId || '',
    camera: vTrack?.getSettings?.().deviceId || '',
  };
}

export async function setMic(deviceId) {
  if (!state.localStream) return;
  const constraints = state.musicMode ? {
    deviceId: { exact: deviceId },
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    channelCount: 2, sampleRate: 48000,
  } : {
    deviceId: { exact: deviceId },
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    channelCount: 1,
  };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
  const newTrack = stream.getAudioTracks()[0];
  for (const pc of internals.pcs.values()) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) { try { await sender.replaceTrack(newTrack); } catch (e) { console.warn(e); } }
  }
  const old = state.localStream.getAudioTracks()[0];
  if (old) { state.localStream.removeTrack(old); old.stop(); }
  state.localStream.addTrack(newTrack);
  localStorage.setItem(LS_MIC, deviceId);
}

export async function setCamera(deviceId) {
  if (!state.localStream) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: { exact: deviceId },
      width:  { ideal: 1280, max: 1920 },
      height: { ideal: 720,  max: 1080 },
      frameRate: { ideal: 30, max: 60 },
    },
  });
  const newTrack = stream.getVideoTracks()[0];
  newTrack.contentHint = 'motion';
  await replaceVideoTrackEverywhere(newTrack);
  const old = state.localStream.getVideoTracks()[0];
  if (old) { state.localStream.removeTrack(old); old.stop(); }
  state.localStream.addTrack(newTrack);
  localStorage.setItem(LS_CAM, deviceId);
}

export async function setSpeaker(deviceId) {
  const vids = document.querySelectorAll('video');
  let supported = false;
  for (const v of vids) {
    if (typeof v.setSinkId === 'function') {
      supported = true;
      try { await v.setSinkId(deviceId); } catch (e) { console.warn('setSinkId:', e); }
    }
  }
  if (!supported) throw new Error('Браузер не поддерживает выбор динамика');
  localStorage.setItem(LS_SPK, deviceId);
}

export async function applyPersisted() {
  const { mic, camera, speaker } = getSaved();
  const { mics, cameras, speakers } = await listDevices();
  if (mic && mics.find(d => d.deviceId === mic)) { try { await setMic(mic); } catch {} }
  if (camera && cameras.find(d => d.deviceId === camera)) { try { await setCamera(camera); } catch {} }
  if (speaker && speakers.find(d => d.deviceId === speaker)) { try { await setSpeaker(speaker); } catch {} }
}

export function openDevices() { devicesOpen.value = true; }
export function closeDevices() { devicesOpen.value = false; }

export function useDevices() {
  return {
    devicesOpen, openDevices, closeDevices,
    listDevices, getSaved, getCurrentIds, setMic, setCamera, setSpeaker, applyPersisted,
  };
}
