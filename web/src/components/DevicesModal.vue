<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { state } from '../stores/app.js';
import {
  devicesOpen, closeDevices,
  listDevices, getSaved, getCurrentIds,
  setMic, setCamera, setSpeaker,
} from '../composables/useDevices.js';
import { toastError } from '../composables/useToast.js';
import Icon from './Icon.vue';

const mics = ref([]);
const speakers = ref([]);
const cameras = ref([]);
const sel = ref({ mic: '', spk: '', cam: '' });
const canSpeaker = 'setSinkId' in HTMLMediaElement.prototype;

const meterEl = ref(null);
let stopMeter = null;

async function refresh() {
  const all = await listDevices();
  mics.value = all.mics;
  speakers.value = all.speakers;
  cameras.value = all.cameras;
  const saved = getSaved();
  const cur = getCurrentIds();
  sel.value = {
    mic: cur.mic || saved.mic,
    cam: cur.camera || saved.camera,
    spk: saved.speaker,
  };
}

function startMeter() {
  stopMeter?.();
  if (!state.localStream || !meterEl.value) return;
  const track = state.localStream.getAudioTracks()[0];
  if (!track) return;
  let ctx, src, analyser, raf;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    src = ctx.createMediaStreamSource(new MediaStream([track]));
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);
  } catch { return; }
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteFrequencyData(data);
    let sum = 0; for (let i = 0; i < 32; i++) sum += data[i];
    const pct = Math.min(100, Math.round((sum / 32 / 90) * 100));
    if (meterEl.value) meterEl.value.style.width = pct + '%';
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  stopMeter = () => {
    cancelAnimationFrame(raf);
    try { src.disconnect(); ctx.close(); } catch {}
    stopMeter = null;
  };
}

async function onMic(e) {
  try { await setMic(e.target.value); stopMeter?.(); startMeter(); }
  catch (err) { toastError('Не удалось сменить микрофон: ' + (err?.message || err)); }
}
async function onCam(e) {
  try { await setCamera(e.target.value); }
  catch (err) { toastError('Не удалось сменить камеру: ' + (err?.message || err)); }
}
async function onSpk(e) {
  try { await setSpeaker(e.target.value); }
  catch (err) { toastError('Не удалось сменить динамик: ' + (err?.message || err)); }
}

const overlayCls = computed(() => ({ in: devicesOpen.value }));

function onKey(e) { if (e.key === 'Escape') closeDevices(); }
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); stopMeter?.(); });

watch(devicesOpen, async (v) => {
  if (v) { await refresh(); startMeter(); }
  else { stopMeter?.(); }
});

// Hot-plug.
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (devicesOpen.value) refresh(); });
</script>

<template>
  <Teleport to="body">
    <div v-if="devicesOpen" class="modal-overlay" :class="overlayCls" @click.self="closeDevices">
      <div class="modal" role="dialog" aria-label="Устройства">
        <div class="modal-head">
          <h3>Устройства</h3>
          <button class="modal-close" aria-label="Закрыть" @click="closeDevices">
            <Icon name="x" />
          </button>
        </div>
        <div class="modal-body">
          <label class="dev-row">
            <span class="dev-label">Микрофон</span>
            <select class="dev-select" v-model="sel.mic" @change="onMic">
              <option v-if="!mics.length" disabled>Нет устройств</option>
              <option v-for="d in mics" :key="d.deviceId" :value="d.deviceId">{{ d.label || 'Без названия' }}</option>
            </select>
            <div class="mic-meter" aria-hidden="true"><div ref="meterEl" class="mic-meter-fill"></div></div>
          </label>
          <label class="dev-row">
            <span class="dev-label">Динамик</span>
            <select class="dev-select" v-model="sel.spk" :disabled="!canSpeaker" @change="onSpk">
              <option v-if="!speakers.length" disabled>Нет устройств</option>
              <option v-for="d in speakers" :key="d.deviceId" :value="d.deviceId">{{ d.label || 'Без названия' }}</option>
            </select>
            <span v-if="!canSpeaker" class="dev-hint">Браузер не поддерживает выбор</span>
          </label>
          <label class="dev-row">
            <span class="dev-label">Камера</span>
            <select class="dev-select" v-model="sel.cam" @change="onCam">
              <option v-if="!cameras.length" disabled>Нет устройств</option>
              <option v-for="d in cameras" :key="d.deviceId" :value="d.deviceId">{{ d.label || 'Без названия' }}</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  </Teleport>
</template>
