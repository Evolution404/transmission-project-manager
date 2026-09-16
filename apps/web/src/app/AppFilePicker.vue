<script setup lang="ts">
import { ref } from 'vue';
import { NButton } from 'naive-ui';

const props = withDefaults(defineProps<{
  accept?: string;
  disabled?: boolean;
  label?: string;
  selectedName?: string | null;
  testId?: string;
}>(), {
  disabled: false,
  label: '选择文件',
  selectedName: null,
});

const emit = defineEmits<{ change: [event: Event] }>();
const inputRef = ref<HTMLInputElement | null>(null);

function openPicker() {
  if (!props.disabled) inputRef.value?.click();
}
</script>

<template>
  <div class="app-file-picker">
    <input
      ref="inputRef"
      class="native-file-input"
      type="file"
      :accept="accept"
      :disabled="disabled"
      :data-test="testId"
      tabindex="-1"
      aria-hidden="true"
      @change="emit('change', $event)"
    />
    <n-button :disabled="disabled" secondary @click="openPicker">{{ label }}</n-button>
    <span class="file-name" :class="{ empty: !selectedName }">{{ selectedName || '未选择文件' }}</span>
  </div>
</template>

<style scoped>
.native-file-input {
  position: fixed;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.app-file-picker {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.file-name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-name.empty { color: var(--ui-text-tertiary); }
@media (max-width: 767px) {
  .app-file-picker { align-items: stretch; flex-direction: column; }
  .app-file-picker :deep(.n-button) { width: 100%; }
}
</style>
