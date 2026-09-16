<script setup lang="ts">
import BrandIcon from './BrandIcon.vue';
import { BRAND_NAME, BRAND_SUBTITLE } from './brand';

withDefaults(defineProps<{
  iconSize?: number;
}>(), {
  iconSize: 52,
});
</script>

<template>
  <span class="brand-lockup">
    <BrandIcon :size="iconSize" />
    <span class="brand-lockup-copy">
      <strong>{{ BRAND_NAME }}</strong>
      <small>{{ BRAND_SUBTITLE }}</small>
    </span>
  </span>
</template>

<style scoped>
.brand-lockup { display: flex; align-items: center; gap: 14px; min-width: 0; }
.brand-lockup-copy { display: grid; min-width: 0; gap: 4px; }
.brand-lockup-copy strong,
.brand-lockup-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brand-lockup-copy strong { color: #f7faff; font-size: 20px; font-weight: 760; line-height: 1.15; letter-spacing: -.02em; }
.brand-lockup-copy small { color: #8f9aae; font-size: 12px; font-weight: 520; line-height: 1.2; letter-spacing: .03em; }
</style>
