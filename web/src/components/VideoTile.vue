<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { state } from '../stores/app.js';
import { reactionOverlays } from '../composables/useReactions.js';
import Icon from './Icon.vue';

const props = defineProps({
  /** Peer entry from state.peers; null/undefined when rendering local tile. */
  peer: { type: Object, default: null },
});

const isSelf = computed(() => !props.peer);
const tileId = computed(() => isSelf.value ? 'self' : props.peer.id);
const stream = computed(() => {
  if (isSelf.value) return state.previewStream || state.localStream;
  return props.peer.stream;
});
const speaking = computed(() => isSelf.value ? state.selfSpeaking : !!props.peer.speaking);
const name = computed(() => isSelf.value ? 'Вы' : (props.peer.name || 'Собеседник'));
const abr = computed(() => isSelf.value ? null : props.peer.abr);
const reactions = computed(() => reactionOverlays.get(tileId.value) || []);

const videoEl = ref(null);
const tileEl = ref(null);

function bindStream() {
  if (videoEl.value) videoEl.value.srcObject = stream.value || null;
}
watch(stream, bindStream);
onMounted(() => {
  bindStream();
  // Apply persisted speaker on remote tiles.
  if (!isSelf.value && videoEl.value) {
    const saved = localStorage.getItem('skypertc.device.speaker');
    if (saved && typeof videoEl.value.setSinkId === 'function') {
      videoEl.value.setSinkId(saved).catch(() => {});
    }
  }
});
onBeforeUnmount(() => { if (videoEl.value) videoEl.value.srcObject = null; });

async function toggleFs() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await tileEl.value?.requestFullscreen?.();
}
async function togglePip() {
  if (!videoEl.value) return;
  try {
    if (document.pictureInPictureElement === videoEl.value) await document.exitPictureInPicture();
    else await videoEl.value.requestPictureInPicture();
  } catch (e) { console.warn('PiP:', e); }
}
const pipSupported = 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;

function fmtLoss(l) { return l != null ? (l * 100).toFixed(1) + '%' : '–'; }
function fmtRtt(r)  { return r != null ? Math.round(r * 1000) + 'мс' : '–'; }
</script>

<template>
  <div ref="tileEl" class="video-tile" :class="{ self: isSelf, speaking }">
    <video ref="videoEl" autoplay playsinline :muted="isSelf"></video>
    <div class="tile-label">{{ name }}</div>
    <button class="tile-fs-btn" title="На весь экран" @click.stop="toggleFs">
      <Icon name="maximize" />
    </button>
    <button v-if="pipSupported" class="tile-pip-btn" title="Picture-in-Picture" @click.stop="togglePip">
      <Icon name="pip" />
    </button>
    <template v-if="abr">
      <div class="net-dot" :data-q="abr.q" :title="`Связь: ${abr.q}`"></div>
      <div class="abr-badge">
        <span class="abr-tier" :class="`abr-${abr.tier}`">{{ abr.tier.toUpperCase() }}</span>
        {{ abr.kbps }} kbps · {{ fmtLoss(abr.loss) }} · {{ fmtRtt(abr.rtt) }}
      </div>
    </template>
    <div v-for="r in reactions" :key="r.id" class="reaction-float">{{ r.emoji }}</div>
  </div>
</template>
