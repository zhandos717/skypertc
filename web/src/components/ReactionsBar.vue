<script setup>
import { showLocalReaction } from '../composables/useReactions.js';

const EMOJI = ['👍', '❤️', '😂', '🎉', '🙌', '🔥'];

function fire(emoji, el) {
  showLocalReaction(emoji);
  el.style.transform = 'scale(1.5)';
  setTimeout(() => (el.style.transform = ''), 200);
}
</script>

<template>
  <div class="reactions-bar">
    <button
      v-for="e in EMOJI"
      :key="e"
      class="react-btn"
      :data-emoji="e"
      @click="fire(e, $event.currentTarget)"
    >{{ e }}</button>
  </div>
</template>
