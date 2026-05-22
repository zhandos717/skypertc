<script setup>
import { computed } from 'vue';
import { state } from '../stores/app.js';
import Icon from './Icon.vue';

const visible = computed(() => !state.currentRoom && state.peers.size === 0);
</script>

<template>
  <div v-if="visible" class="placeholder">
    <div class="big-call-icon"><Icon name="phone-call" /></div>
    <h2>Готовы к звонку</h2>
    <p>Введите имя комнаты слева и присоединитесь, чтобы начать видеозвонок</p>
  </div>
</template>
