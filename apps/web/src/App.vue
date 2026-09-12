<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { HealthResponse } from '@tpm/shared';

const connection = ref('正在检查接口连接…');

onMounted(async () => {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('Health request failed');
    const result = (await response.json()) as HealthResponse;
    connection.value = result.ok ? '基础接口已连接' : '接口暂不可用';
  } catch {
    connection.value = '接口尚未连接，请启动本地 API 服务';
  }
});
</script>

<template>
  <main>
    <p class="eyebrow">项目骨架 · v0.1.0</p>
    <h1>输电项目全流程管理台</h1>
    <p class="flow">需求 → 储备 → 出库 → 实施 → 结算</p>
    <section aria-labelledby="status-title">
      <h2 id="status-title">项目已初始化</h2>
      <p>当前仅提供运行骨架，业务功能尚未实现，未连接正式项目数据。</p>
      <p role="status" aria-live="polite" class="status">{{ connection }}</p>
    </section>
  </main>
</template>
