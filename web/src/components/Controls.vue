<script setup>
import { computed, ref } from 'vue';
import { state } from '../stores/app.js';
import {
  micOn, camOn, screenOn,
  toggleMic, toggleCam, toggleScreen, flipCamera,
  ensureMedia,
} from '../composables/useMedia.js';
import { leave } from '../composables/useSignaling.js';
import MoreMenu from './MoreMenu.vue';
import Icon from './Icon.vue';

const moreOpen = ref(false);

async function clickMic()    { if (!state.localStream) await ensureMedia(); toggleMic(); }
async function clickCam()    { if (!state.localStream) await ensureMedia(); toggleCam(); }
async function clickScreen() { await toggleScreen(); }
async function clickHang()   { leave(); }
async function clickFlip()   { await flipCamera(); }
function clickMore(ev)       { ev.stopPropagation(); moreOpen.value = !moreOpen.value; }

const canHang = computed(() => !!state.currentRoom);

function tabletChatToggle() {
  if (window.innerWidth <= 700) state.mobileTab = 'chat';
  else state.chatOpen = !state.chatOpen;
}
</script>

<template>
  <footer class="controls">
    <button class="ctrl" :class="{ off: !micOn }" title="Микрофон" @click="clickMic">
      <Icon name="mic" class="icon-on" />
      <Icon name="mic-off" class="icon-off" />
    </button>
    <button class="ctrl" data-role="cam" :class="{ off: !camOn }" title="Камера" @click="clickCam">
      <Icon name="video" class="icon-on" />
      <Icon name="video-off" class="icon-off" />
    </button>
    <button class="ctrl" :class="{ off: screenOn }" title="Показ экрана" @click="clickScreen">
      <Icon name="monitor" class="icon-on" />
      <Icon name="monitor-x" class="icon-off" />
    </button>
    <button class="ctrl hangup" :disabled="!canHang" title="Завершить" @click="clickHang">
      <Icon name="phone-off" />
    </button>
    <button class="ctrl" title="Сменить камеру" @click="clickFlip">
      <Icon name="refresh-cw" />
    </button>
    <div class="ctrl-more-wrap">
      <button class="ctrl" title="Дополнительно" :aria-expanded="moreOpen" @click="clickMore">
        <Icon name="more" />
      </button>
      <MoreMenu :open="moreOpen" @close="moreOpen = false" />
    </div>
    <button class="ctrl" id="chatBtn" title="Чат" @click="tabletChatToggle">
      <Icon name="message-circle" />
    </button>
  </footer>
</template>
