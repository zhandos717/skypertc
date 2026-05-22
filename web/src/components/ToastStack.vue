<script setup>
import { TransitionGroup } from 'vue';
import { toasts, dismiss } from '../composables/useToast.js';
</script>

<template>
  <div class="toast-stack">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="['toast', 'in', `toast-${t.type}`]"
        :role="t.type === 'error' ? 'alert' : 'status'"
        @click="dismiss(t.id)"
      >{{ t.message }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active, .toast-leave-active { transition: opacity .18s, transform .18s; }
.toast-enter-from { opacity: 0; transform: translateY(14px); }
.toast-leave-to   { opacity: 0; transform: translateY(8px); }
</style>
