<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NAlert, NSpin } from 'naive-ui';
import type { AnalysisDashboardSummary, CurrentUser } from '@tpm/shared';
import { parseApiResponse } from '../api/response';
import AppIcon from '../app/AppIcon.vue';

const props = defineProps<{ currentUser: CurrentUser }>();
const router = useRouter();

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
    const result = await parseApiResponse<AnalysisDashboardSummary>(response);
    if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
    dashboard.value = result.data;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取总览失败';
  } finally {
    loading.value = false;
  }
}

function navigate(path: string) { void router.push(path); }

onMounted(loadDashboard);
</script>

<template>
  <div class="view-stack dashboard-view">
    <n-alert v-if="error" type="error" title="数据读取失败">{{ error }}</n-alert>

    <header class="page-header">
      <div class="page-header-copy">
        <span class="page-eyebrow">WORKSPACE</span>
        <h2 class="page-title">工作台</h2>
        <p class="page-description">查看当前业务状态，并直接进入需要处理的项目、任务和预警。</p>
      </div>
      <div class="dashboard-date"><span>数据日期</span><strong>{{ dashboard?.asOf ?? '—' }}</strong></div>
    </header>

    <n-spin :show="loading">
      <section class="overview-strip" aria-label="业务摘要">
        <button class="overview-cell" @click="navigate('/demands')">
          <span>需求</span><strong>{{ dashboard?.demandCount ?? 0 }}</strong><small>已纳入系统</small>
        </button>
        <button class="overview-cell" @click="navigate('/projects')">
          <span>项目</span><strong>{{ dashboard?.projectCount ?? 0 }}</strong><small>当前授权范围</small>
        </button>
        <button class="overview-cell emphasis" @click="navigate('/projects?stage=reserve')">
          <span>待出库</span><strong>{{ dashboard?.unreleasedProjectCount ?? 0 }}</strong><small>等待进入执行</small>
        </button>
        <button class="overview-cell emphasis" @click="navigate('/delivery')">
          <span>结算待办</span><strong>{{ dashboard?.pendingSettlementCount ?? 0 }}</strong><small>实施后未最终结算</small>
        </button>
        <button class="overview-cell warning" @click="navigate('/analysis')">
          <span>活动预警</span><strong>{{ dashboard?.activeAlertCount ?? 0 }}</strong><small>当前有效提醒</small>
        </button>
      </section>
    </n-spin>

    <section class="workspace-section">
      <div class="workspace-section-heading"><div><h3>常用入口</h3><p>按工作对象进入，不需要先理解后台模块结构。</p></div></div>
      <div class="workspace-links">
        <button @click="navigate('/projects')"><span class="workspace-link-icon"><app-icon name="projects" /></span><span><strong>项目中心</strong><small>储备、出库、执行任务和项目资金</small></span><app-icon name="chevron" :size="17" /></button>
        <button @click="navigate('/delivery')"><span class="workspace-link-icon"><app-icon name="tasks" /></span><span><strong>执行任务</strong><small>供应、现场实施和任务结算</small></span><app-icon name="chevron" :size="17" /></button>
        <button @click="navigate('/demands')"><span class="workspace-link-icon"><app-icon name="demands" /></span><span><strong>项目需求</strong><small>新建、导入和查看需求来源</small></span><app-icon name="chevron" :size="17" /></button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dashboard-date { display: grid; gap: 3px; min-width: 126px; padding: 10px 12px; border-left: 2px solid var(--ui-border-strong); }
.dashboard-date span { color: var(--ui-text-tertiary); font-size: 10px; }
.dashboard-date strong { font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; }
.overview-strip { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.overview-cell { display: grid; gap: 6px; min-width: 0; min-height: 134px; padding: 20px; border: 0; border-right: 1px solid var(--ui-border); background: transparent; color: inherit; text-align: left; cursor: pointer; transition: background-color 140ms ease; }
.overview-cell:last-child { border-right: 0; }
.overview-cell:hover { background: var(--ui-surface-subtle); }
.overview-cell > span { color: var(--ui-text-secondary); font-size: 12px; font-weight: 620; }
.overview-cell > strong { align-self: end; font-size: 31px; font-weight: 690; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
.overview-cell > small { color: var(--ui-text-tertiary); font-size: 11px; line-height: 1.4; }
.overview-cell.emphasis > strong { color: var(--ui-info); }
.overview-cell.warning > strong { color: var(--ui-warning); }
.workspace-section { overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.workspace-section-heading { padding: 16px 18px 13px; border-bottom: 1px solid var(--ui-border); }
.workspace-section-heading h3 { margin: 0; font-size: 15px; font-weight: 680; }
.workspace-section-heading p { margin: 4px 0 0; color: var(--ui-text-secondary); font-size: 12px; }
.workspace-links { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); }
.workspace-links > button { display: grid; grid-template-columns: 40px 1fr 18px; align-items: center; gap: 12px; min-width: 0; min-height: 92px; padding: 16px 18px; border: 0; border-right: 1px solid var(--ui-border); background: transparent; color: inherit; text-align: left; cursor: pointer; }
.workspace-links > button:last-child { border-right: 0; }
.workspace-links > button:hover { background: var(--ui-surface-subtle); }
.workspace-link-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 11px; background: var(--ui-surface-muted); color: var(--ui-text-secondary); }
.workspace-links > button > span:nth-child(2) { min-width: 0; }
.workspace-links strong, .workspace-links small { display: block; }
.workspace-links strong { font-size: 13px; font-weight: 660; }
.workspace-links small { margin-top: 4px; overflow: hidden; color: var(--ui-text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.workspace-links :deep(.app-icon:last-child) { color: var(--ui-text-tertiary); }
@media (max-width: 1050px) { .overview-strip { grid-template-columns: repeat(3,1fr); } .overview-cell:nth-child(3) { border-right: 0; } .overview-cell:nth-child(n+4) { border-top: 1px solid var(--ui-border); } .workspace-links { grid-template-columns: 1fr; } .workspace-links > button { border-right: 0; border-bottom: 1px solid var(--ui-border); } .workspace-links > button:last-child { border-bottom: 0; } }
@media (max-width: 767px) {
  .dashboard-date { align-self: flex-start; min-width: 0; padding: 4px 0 4px 10px; }
  .overview-strip { grid-template-columns: 1fr 1fr; }
  .overview-cell { min-height: 112px; padding: 15px; border-right: 1px solid var(--ui-border); border-top: 1px solid var(--ui-border); }
  .overview-cell:nth-child(-n+2) { border-top: 0; }
  .overview-cell:nth-child(even) { border-right: 0; }
  .overview-cell:last-child { grid-column: 1 / -1; border-right: 0; }
  .overview-cell > strong { font-size: 27px; }
  .workspace-links > button { min-height: 78px; padding: 13px 15px; }
}
</style>
