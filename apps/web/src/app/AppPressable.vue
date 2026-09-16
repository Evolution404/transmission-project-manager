<script setup lang="ts">
withDefaults(defineProps<{
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}>(), {
  disabled: false,
  type: 'button',
});

defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <button
    class="app-pressable"
    :type="type"
    :disabled="disabled"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>

<style scoped>
.app-pressable {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: inherit;
  text-align: inherit;
  text-decoration: none;
  cursor: pointer;
}
.app-pressable:disabled { cursor: not-allowed; opacity: .5; }
.app-pressable:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
</style>
