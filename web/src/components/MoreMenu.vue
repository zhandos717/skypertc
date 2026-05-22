<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { state, internals } from '../stores/app.js';
import {
  enableBgBlur, enableBgImage, disableBgBlur, isBgBlurOn,
  setMusicMode, ensureMedia,
} from '../composables/useMedia.js';
import { openDevices } from '../composables/useDevices.js';
import { useTheme } from '../composables/useTheme.js';
import { isDocPipSupported, toggleDocPip } from '../services/docPip.js';
import { toastError } from '../composables/useToast.js';
import Icon from './Icon.vue';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close']);

const { cycleTheme, themeLabel } = useTheme();

const bgOn = computed(() => state.bgEffectOn);
const screen = computed(() => state.screenSharing);
const docPipOk = isDocPipSupported();

const bgImageInput = ref(null);
let bgBusy = false;
let musicBusy = false;

async function clickBgBlur() {
  if (bgBusy || screen.value) return;
  bgBusy = true;
  try {
    if (!state.localStream) await ensureMedia();
    if (isBgBlurOn()) await disableBgBlur(); else await enableBgBlur();
  } catch (e) {
    toastError('Не удалось включить размытие фона: ' + (e?.message || e));
  } finally {
    bgBusy = false; emit('close');
  }
}

async function clickBgOff() {
  if (isBgBlurOn()) await disableBgBlur();
  emit('close');
}

async function onBgImage(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  if (screen.value) { toastError('Сначала выключите показ экрана'); return; }
  bgBusy = true;
  try {
    if (!state.localStream) await ensureMedia();
    const url = URL.createObjectURL(file);
    await enableBgImage(url);
  } catch (e) { toastError('Не удалось применить фон: ' + (e?.message || e)); }
  finally { bgBusy = false; emit('close'); }
}

async function clickMusic() {
  if (musicBusy) return;
  musicBusy = true;
  try {
    if (!state.localStream) await ensureMedia();
    await setMusicMode(!state.musicMode);
  }
  finally { musicBusy = false; emit('close'); }
}

async function clickDocPip() {
  try { await toggleDocPip(); }
  catch (e) { toastError('Не удалось открыть плавающее окно: ' + (e?.message || e)); }
  emit('close');
}

function clickDevices() { openDevices(); emit('close'); }
function clickTheme(ev) { ev.stopPropagation(); cycleTheme(); }

// Close on outside click.
const root = ref(null);
function onDocClick(ev) {
  if (!props.open) return;
  if (root.value && !root.value.contains(ev.target)) emit('close');
}
onMounted(() => document.addEventListener('click', onDocClick, true));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true));
</script>

<template>
  <div ref="root" class="more-menu" role="menu" :hidden="!open">
    <button class="more-item" role="menuitem" @click="clickDevices">
      <Icon name="settings" />
      <span class="more-label">Устройства...</span>
    </button>
    <div class="more-sep"></div>
    <button class="more-item" role="menuitem" :class="{ active: bgOn }" :disabled="screen" @click="clickBgBlur">
      <Icon name="sparkles" />
      <span class="more-label">Размыть фон</span>
      <span class="more-state" :data-state="bgOn ? 'on' : 'off'">{{ bgOn ? 'вкл' : 'выкл' }}</span>
    </button>
    <button class="more-item" role="menuitem" :disabled="screen" @click="bgImageInput?.click()">
      <Icon name="image" />
      <span class="more-label">Фон-картинка...</span>
    </button>
    <button v-if="bgOn" class="more-item" role="menuitem" @click="clickBgOff">
      <Icon name="x" />
      <span class="more-label">Убрать эффект фона</span>
    </button>
    <div class="more-sep"></div>
    <button class="more-item" role="menuitem" @click="clickTheme">
      <Icon name="sparkles" />
      <span class="more-label">Тема</span>
      <span class="more-state" :data-state="state.theme === 'auto' ? 'off' : 'on'">{{ themeLabel() }}</span>
    </button>
    <div v-if="docPipOk" class="more-sep"></div>
    <button v-if="docPipOk" class="more-item" role="menuitem" @click="clickDocPip">
      <Icon name="pip" />
      <span class="more-label">Вынести в плавающее окно</span>
    </button>
    <div class="more-sep"></div>
    <button class="more-item" role="menuitem" :class="{ active: state.musicMode }" @click="clickMusic">
      <Icon name="music" />
      <span class="more-label">Музыкальный режим</span>
      <span class="more-state" :data-state="state.musicMode ? 'on' : 'off'">{{ state.musicMode ? 'вкл' : 'выкл' }}</span>
    </button>
    <input ref="bgImageInput" type="file" accept="image/*" hidden @change="onBgImage" />
  </div>
</template>
