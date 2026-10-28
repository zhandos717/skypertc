<script setup>
import { onMounted, computed } from 'vue';
import { state } from './stores/app.js';
import { useTheme } from './composables/useTheme.js';
import { useSignaling, join } from './composables/useSignaling.js';
import { startPolling } from './composables/useRooms.js';

import Sidebar from './components/Sidebar.vue';
import Topbar from './components/Topbar.vue';
import VideoArea from './components/VideoArea.vue';
import ReactionsBar from './components/ReactionsBar.vue';
import Controls from './components/Controls.vue';
import Chat from './components/Chat.vue';
import MobileNav from './components/MobileNav.vue';
import ToastStack from './components/ToastStack.vue';
import DevicesModal from './components/DevicesModal.vue';

const { initTheme } = useTheme();
const { loadIceConfig } = useSignaling();

const mainClass = computed(() => ({ 'mob-active': state.mobileTab === 'main' }));

function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  if (!raw) return { room: '', secret: '' };
  const idx = raw.indexOf(':');
  if (idx < 0) return { room: decodeURIComponent(raw).trim(), secret: '' };
  return { room: decodeURIComponent(raw.slice(0, idx)).trim(), secret: raw.slice(idx + 1) };
}

onMounted(() => {
  initTheme();
  loadIceConfig();
  startPolling();

  // Параметры встраивания: ?embed=1&mode=audio|video&name=Иван
  const query = new URLSearchParams(location.search);
  state.embed = query.get('embed') === '1';
  state.audioOnly = query.get('mode') === 'audio';
  const nameFromUrl = (query.get('name') || '').trim().slice(0, 60);

  // Establish/persist user name. Имя из ссылки приоритетнее и не сохраняется: звонок идёт от имени вошедшего в чат.
  if (nameFromUrl) {
    state.userName = nameFromUrl;
  } else {
    state.userName = localStorage.getItem('skypertc.name')
      || (prompt('Ваше имя?', 'Гость') || 'Гость');
    localStorage.setItem('skypertc.name', state.userName);
  }

  // Auto-join from URL hash (#room or #room:secret). When a hash is present
  // the user explicitly wants to enter that room — jump to the call panel.
  // Otherwise on mobile we stay on the 'sidebar' default (room creation).
  const initial = parseHash();
  if (initial.room) {
    state.currentSecret = initial.secret;
    join({ room: initial.room, isPublic: !initial.secret, secret: initial.secret })
      .catch(console.error);
    if (window.innerWidth <= 700) state.mobileTab = 'main';
  }

  // React to hash changes (user pasted a new link).
  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h.room && h.room !== state.currentRoom) {
      state.currentSecret = h.secret;
      join({ room: h.room, isPublic: !h.secret, secret: h.secret }).catch(console.error);
      if (window.innerWidth <= 700) state.mobileTab = 'main';
    }
  });
});
</script>

<template>
  <div class="app" :class="{ embed: state.embed, 'audio-only': state.audioOnly }">
    <Sidebar />
    <main class="main" :class="mainClass">
      <Topbar />
      <VideoArea />
      <ReactionsBar />
      <Controls />
    </main>
    <Chat />
  </div>
  <MobileNav v-if="!state.embed" />
  <ToastStack />
  <DevicesModal />
</template>
