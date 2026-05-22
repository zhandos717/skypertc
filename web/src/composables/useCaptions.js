// Live captions via the browser-native Web Speech API.
//
//  - Each client transcribes its OWN mic (cheaper and more accurate than
//    pushing remote audio through STT).
//  - The recognized text is broadcast over the existing DataChannel ('events')
//    so peers see captions for whoever has the toggle on.
//  - The most recent caption auto-clears after CAPTION_TTL_MS so stale text
//    doesn't linger forever when someone goes quiet.
//
// Chrome/Edge/Safari: works. Firefox: SpeechRecognition is missing — startCaptions
// returns false and we surface a toast in the UI.

import { state, internals } from '../stores/app.js';
import { toastError } from './useToast.js';

const CAPTION_TTL_MS = 6000;

let recognition = null;
let restartTimer = null;
const clearTimers = new Map(); // peerId|'self' → timeout id

function setCaption(key, text) {
  if (!text) {
    state.captions.delete(key);
    return;
  }
  state.captions.set(key, { text, ts: Date.now() });
  const prev = clearTimers.get(key);
  if (prev) clearTimeout(prev);
  clearTimers.set(key, setTimeout(() => {
    state.captions.delete(key);
    clearTimers.delete(key);
  }, CAPTION_TTL_MS));
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ch of internals.events.values()) {
    if (ch.readyState === 'open') {
      try { ch.send(payload); } catch {}
    }
  }
}

export function isCaptionsSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function startCaptions(lang) {
  if (!isCaptionsSupported()) {
    toastError('Браузер не поддерживает субтитры (нужен Chrome, Edge или Safari)');
    return false;
  }
  stopCaptions({ silent: true });

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = lang || state.captionsLang || 'ru-RU';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (ev) => {
    let interim = '';
    let final = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const txt = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) final += txt;
      else interim += txt;
    }
    const text = (final + ' ' + interim).trim();
    if (!text) return;
    setCaption('self', text);
    broadcast({ type: 'caption', text });
  };

  recognition.onerror = (e) => {
    // 'no-speech' / 'aborted' are routine; only log unexpected errors.
    if (e.error && !['no-speech', 'aborted', 'audio-capture'].includes(e.error)) {
      console.warn('Captions error:', e.error);
    }
  };

  recognition.onend = () => {
    // Chrome stops the engine after a silent pause; restart while toggle is on.
    if (state.captionsOn) {
      restartTimer = setTimeout(() => {
        if (!state.captionsOn || !recognition) return;
        try { recognition.start(); } catch {}
      }, 200);
    }
  };

  try { recognition.start(); }
  catch (e) {
    console.warn('Captions start failed:', e);
    recognition = null;
    return false;
  }

  state.captionsOn = true;
  return true;
}

export function stopCaptions({ silent = false } = {}) {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (recognition) {
    try { recognition.onend = null; recognition.stop(); } catch {}
    recognition = null;
  }
  if (state.captionsOn && !silent) {
    broadcast({ type: 'caption-end' });
  }
  state.captionsOn = false;
  setCaption('self', '');
}

export function setCaptionsLang(lang) {
  state.captionsLang = lang;
  localStorage.setItem('skypertc.captions.lang', lang);
  if (state.captionsOn) {
    // Restart with the new language.
    startCaptions(lang);
  }
}

/** Called by the DataChannel handler in usePeers.js for incoming caption msgs. */
export function handleRemoteCaption(peerId, msg) {
  if (msg?.type === 'caption' && typeof msg.text === 'string') {
    setCaption(peerId, msg.text);
  } else if (msg?.type === 'caption-end') {
    setCaption(peerId, '');
  }
}
