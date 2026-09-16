<script setup lang="ts">
withDefaults(defineProps<{
  size?: number;
  title?: string;
}>(), {
  size: 52,
  title: '',
});
</script>

<template>
  <svg
    class="brand-icon"
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    fill="none"
    :aria-hidden="title ? undefined : 'true'"
    :role="title ? 'img' : undefined"
  >
    <title v-if="title">{{ title }}</title>
    <defs>
      <linearGradient id="brand-ring" x1="9" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
        <stop stop-color="#8ED8FF" />
        <stop offset="0.52" stop-color="#4C92FF" />
        <stop offset="1" stop-color="#2E63E8" />
      </linearGradient>
      <linearGradient id="brand-tower" x1="26" y1="8" x2="41" y2="55" gradientUnits="userSpaceOnUse">
        <stop stop-color="#E7F6FF" />
        <stop offset="0.42" stop-color="#91CBFF" />
        <stop offset="1" stop-color="#3977FF" />
      </linearGradient>
    </defs>

    <path
      d="M13.2 47.4A25.1 25.1 0 0 1 10.5 21C15.2 10.9 25.8 5.2 36.8 7.1c7.8 1.3 14.5 6.2 18.1 13"
      stroke="url(#brand-ring)"
      stroke-width="5"
      stroke-linecap="round"
    />
    <path
      d="M56.7 28.2c.2 1.1.3 2.2.3 3.4 0 13.3-10.8 24.1-24.1 24.1"
      stroke="url(#brand-ring)"
      stroke-width="5"
      stroke-linecap="round"
    />
    <path
      d="M12.6 36.5c7.8-6.5 17.4-9.8 28-8.7 6.3.7 11.8 2.7 16.7 6"
      stroke="url(#brand-ring)"
      stroke-width="4"
      stroke-linecap="round"
    />

    <path d="M32 8.5 26.8 24l5.2-2.5 5.2 2.5L32 8.5Z" fill="url(#brand-tower)" />
    <path d="M32 20.2 17.8 55h7.7l6.4-15.4L44 55h7.8L32 20.2Z" fill="url(#brand-tower)" />
    <path d="M26.6 30.8h10.8M23.6 38h16.8M21.2 45.2h22" stroke="#0D2A5C" stroke-opacity=".34" stroke-width="2.1" stroke-linecap="round" />
    <path d="m27.2 31.3 9.9 6.2m-12.5.7 14.6 7" stroke="#0D2A5C" stroke-opacity=".3" stroke-width="1.9" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.brand-icon { display: block; flex: 0 0 auto; overflow: visible; }
</style>
