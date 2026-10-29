<script setup>
import { computed } from 'vue';
import { state, layout } from '../stores/app.js';
import VideoTile from './VideoTile.vue';
import Placeholder from './Placeholder.vue';

const peerList = computed(() => Array.from(state.peers.entries()).filter(([id]) => !state.hiddenPeers.has(id)).map(([, entry]) => entry));
const count = computed(() => peerList.value.length + 1);
</script>

<template>
  <section class="video-area" :data-layout="layout" :data-count="count">
    <VideoTile />
    <VideoTile v-for="p in peerList" :key="p.id" :peer="p" />
    <Placeholder />
  </section>
</template>
