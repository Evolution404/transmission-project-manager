<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NAlert, NCard, NGrid, NGridItem, NSpin, NStatistic, NTag } from 'naive-ui';
import type { AnalysisDashboardSummary, ApiResponse, CurrentUser } from '@tpm/shared';

defineProps<{ currentUser: CurrentUser }>();

const loading = ref(true);
const error = ref('');
const dashboard = ref<AnalysisDashboardSummary | null>(null);

function businessToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/analysis/dashboard?asOf=${businessToday()}`);
    const result = await response.json() as ApiResponse<AnalysisDashboardSummary>;
    if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
    dashboard.value = result.data;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取总览失败';
  } finally {
    loading.value = false;
  }
}

onMounted(loadDashboard);
</script>

<template>
  <div class="view-stack">
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <n-spin :show="loading">
      <n-grid :cols="5" :x-gap="16" :y-gap="16" responsive="screen">
        <n-grid-item><n-card><n-statistic label="已纳入需求" :value="dashboard?.demandCount ?? 0" /><small class="muted">已进入项目范围的需求</small></n-card></n-grid-item>
        <n-grid-item><n-card><n-statistic label="项目总数" :value="dashboard?.projectCount ?? 0" /><small class="muted">当前授权范围</small></n-card></n-grid-item>
        <n-grid-item><n-card><n-statistic label="待出库项目" :value="dashboard?.unreleasedProjectCount ?? 0" /><small class="muted">仍存在未出库范围</small></n-card></n-grid-item>
        <n-grid-item><n-card><n-statistic label="结算待办" :value="dashboard?.pendingSettlementCount ?? 0" /><small class="muted">已实施但未最终结算</small></n-card></n-grid-item>
        <n-grid-item><n-card><n-statistic label="活动预警" :value="dashboard?.activeAlertCount ?? 0" /><small class="muted">规则或年度事项提醒</small></n-card></n-grid-item>
      </n-grid>
    </n-spin>

    <n-card title="当前开发状态">
      <template #header-extra><n-tag type="success" :bordered="false">P6 分析、提醒与备份</n-tag></template>
      <p class="empty-copy">首页数字来自当前业务事实和活动预警，不使用硬编码样本。正式业务数据、线上配额和真实通知投递仍需在 P7 验收。</p>
    </n-card>

    <n-card title="当前身份">
      <div class="identity-summary">
        <div><span>成员</span><strong>{{ currentUser.displayName }}</strong></div>
        <div><span>角色</span><strong>{{ currentUser.role }}</strong></div>
        <div><span>授权范围</span><strong>{{ currentUser.scopes.length ? currentUser.scopes.length + ' 项' : '未配置' }}</strong></div>
        <div><span>登录账号</span><strong>@{{ currentUser.username }}</strong></div>
      </div>
    </n-card>
  </div>
</template>
