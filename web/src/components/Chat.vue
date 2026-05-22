<script setup>
import { ref, watch, nextTick, computed } from 'vue';
import { state } from '../stores/app.js';
import { sendChat } from '../composables/useChat.js';
import Icon from './Icon.vue';

const text = ref('');
const msgsEl = ref(null);

const openClass = computed(() => ({
  open: state.chatOpen,
  'mob-active': state.mobileTab === 'chat',
}));

watch(() => state.chatMessages.length, async () => {
  await nextTick();
  if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
});

function submit() {
  const t = text.value.trim();
  if (!t) return;
  sendChat(t);
  text.value = '';
}
</script>

<template>
  <aside class="chat" :class="openClass">
    <div class="chat-head">Чат комнаты</div>
    <div ref="msgsEl" class="chat-msgs">
      <div
        v-for="(m, i) in state.chatMessages"
        :key="i"
        class="msg"
        :class="{ mine: m.mine }"
      >
        <div class="from">{{ m.from }}</div>{{ m.text }}
      </div>
    </div>
    <form class="chat-input" @submit.prevent="submit">
      <input v-model="text" placeholder="Сообщение..." autocomplete="off" />
      <button type="submit"><Icon name="send" /></button>
    </form>
  </aside>
</template>
