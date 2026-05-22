<script setup>
import { computed } from 'vue';
import { state } from '../stores/app.js';
import { leave } from '../composables/useSignaling.js';
import { toastOk, toastError } from '../composables/useToast.js';
import Icon from './Icon.vue';

const inCall = computed(() => !!state.currentRoom);
const roomName = computed(() => state.currentRoom ? '# ' + state.currentRoom : 'Выберите комнату');
const roomSub = computed(() => state.connectionStatus || 'Введите название и нажмите «Присоединиться»');
const roomInitial = computed(() => state.currentRoom?.charAt(0).toUpperCase() || '#');

async function copyLink() {
  if (!state.currentRoom) return;
  const url = `${location.origin}/#${encodeURIComponent(state.currentRoom)}`;
  try { await navigator.clipboard.writeText(url); toastOk('Ссылка скопирована'); }
  catch { try { prompt('Скопируйте ссылку:', url); } catch { toastError('Не удалось скопировать'); } }
}
</script>

<template>
  <header class="topbar">
    <div class="room-title">
      <div class="avatar small">{{ roomInitial }}</div>
      <div>
        <div class="room-name">{{ roomName }}</div>
        <div class="room-sub">{{ roomSub }}</div>
      </div>
    </div>
    <div class="top-actions">
      <button class="icon-btn" :disabled="!inCall" title="Скопировать ссылку" @click="copyLink">
        <Icon name="link" />
      </button>
      <button class="icon-btn" :disabled="!inCall" title="Покинуть" @click="leave">
        <Icon name="log-out" />
      </button>
    </div>
  </header>
</template>
