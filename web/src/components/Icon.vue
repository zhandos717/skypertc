<script setup>
defineProps({ name: { type: String, required: true } });
</script>
<template>
  <svg class="icon"><use :href="`/icons.svg#${name}`" /></svg>
</template>
