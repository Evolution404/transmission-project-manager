<script setup lang="ts">
import { NButton, NResult } from 'naive-ui';
import { useRouter } from 'vue-router';

const router = useRouter();

function goHome() { void router.push('/'); }
function goProjects() { void router.push('/projects'); }
</script>

<template>
  <div class="not-found-view">
    <n-result
      status="404"
      title="页面不存在"
      description="这个地址不存在，可能是旧链接已经失效，也可能是地址输入有误。"
    >
      <template #footer>
        <div class="not-found-actions">
          <n-button secondary @click="goHome">返回工作台</n-button>
          <n-button type="primary" @click="goProjects">打开项目中心</n-button>
        </div>
      </template>
    </n-result>
  </div>
</template>

<style scoped>
.not-found-view {
  display: grid;
  place-items: center;
  min-height: min(620px, calc(100dvh - 160px));
  padding: 48px 18px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-surface);
}
.not-found-actions { display: flex; justify-content: center; gap: 10px; }
@media (max-width: 560px) {
  .not-found-view { min-height: calc(100dvh - 210px); padding: 32px 14px; }
  .not-found-actions { flex-direction: column; width: min(100%, 260px); }
  .not-found-actions .n-button { width: 100%; }
}
</style>
