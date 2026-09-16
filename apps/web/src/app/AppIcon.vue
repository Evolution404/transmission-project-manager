<script setup lang="ts">
defineProps<{
  name: 'workspace' | 'demands' | 'projects' | 'tasks' | 'finance' | 'analysis' | 'master' | 'settings' | 'more' | 'logout' | 'chevron' | 'menu';
  size?: number;
}>();
</script>

<template>
  <svg
    class="app-icon"
    :width="size ?? 20"
    :height="size ?? 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'workspace'">
      <path d="M4 4.75h6.5v6.5H4zM13.5 4.75H20v4.5h-6.5zM13.5 12.25H20v7h-6.5zM4 14.25h6.5v5H4z" />
    </template>
    <template v-else-if="name === 'demands'">
      <path d="M6.5 3.75h8l3 3v13.5h-11z" />
      <path d="M14.5 3.75v3.5H18M9.5 11h5M9.5 14.5h5M9.5 18h3" />
    </template>
    <template v-else-if="name === 'projects'">
      <path d="M3.75 7.75h16.5v11.5H3.75z" />
      <path d="M8 7.75V5.5c0-.7.55-1.25 1.25-1.25h5.5C15.45 4.25 16 4.8 16 5.5v2.25M3.75 12h16.5" />
    </template>
    <template v-else-if="name === 'tasks'">
      <path d="M8.5 6.25h11M8.5 12h11M8.5 17.75h11" />
      <path d="m3.75 6 1 1 1.75-2M3.75 11.75l1 1 1.75-2M3.75 17.5l1 1 1.75-2" />
    </template>
    <template v-else-if="name === 'finance'">
      <path d="M4 7.25h16v11.5H4zM6.5 5h11" />
      <path d="M7.25 13h4.5M15.5 11v4" />
    </template>
    <template v-else-if="name === 'analysis'">
      <path d="M4 19.25V4.75M4 19.25h16" />
      <path d="m7.25 15.5 3.2-3.4 3.05 1.8 4.25-5.4" />
    </template>
    <template v-else-if="name === 'master'">
      <path d="M5 20V9.5M19 20V9.5M3.5 20h17" />
      <path d="m7 9.5 5-6 5 6M8.25 9.5h7.5M8 13h8M7.25 16.5h9.5" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.55-2-3.45-2.45 1a7.2 7.2 0 0 0-2.05-1.2L14 3h-4l-.4 2.6a7.2 7.2 0 0 0-2.05 1.2l-2.45-1-2 3.45 2 1.55A7 7 0 0 0 5 12c0 .4.03.8.1 1.2l-2 1.55 2 3.45 2.45-1a7.2 7.2 0 0 0 2.05 1.2L10 21h4l.4-2.6a7.2 7.2 0 0 0 2.05-1.2l2.45 1 2-3.45-2-1.55c.07-.4.1-.8.1-1.2Z" />
    </template>
    <template v-else-if="name === 'more'">
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'logout'">
      <path d="M10 4.5H5.5v15H10M13.5 8.25 17.25 12l-3.75 3.75M8 12h9" />
    </template>
    <template v-else-if="name === 'chevron'">
      <path d="m9 6 6 6-6 6" />
    </template>
    <template v-else>
      <path d="M5 7h14M5 12h14M5 17h14" />
    </template>
  </svg>
</template>

<style scoped>
.app-icon { display: block; flex: 0 0 auto; }
</style>
