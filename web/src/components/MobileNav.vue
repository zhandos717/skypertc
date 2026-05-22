<script setup>
import { state } from '../stores/app.js';
import Icon from './Icon.vue';

function setTab(name) {
  state.mobileTab = name;
  if (name === 'chat') state.chatBadge = false;
}
</script>

<template>
  <nav class="mobile-nav">
    <button
      class="mob-tab"
      :class="{ active: state.mobileTab === 'sidebar' }"
      data-tab="sidebar"
      @click="setTab('sidebar')"
    >
      <span class="mob-icon"><Icon name="users" /></span>
      <span class="mob-label">Комната</span>
    </button>
    <button
      class="mob-tab"
      :class="{ active: state.mobileTab === 'main' }"
      data-tab="main"
      @click="setTab('main')"
    >
      <span class="mob-icon"><Icon name="video" /></span>
      <span class="mob-label">Звонок</span>
    </button>
    <button
      class="mob-tab"
      :class="{ active: state.mobileTab === 'chat' }"
      data-tab="chat"
      @click="setTab('chat')"
    >
      <span class="mob-icon"><Icon name="message-circle" /></span>
      <span class="mob-label">Чат</span>
      <span class="chat-badge" :class="{ visible: state.chatBadge }"></span>
    </button>
  </nav>
</template>
