<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NEmpty, NProgress, NSpin, NTag } from 'naive-ui';
import type { CurrentUser, ProjectExecutionSummary, ReserveProjectSummary } from '@tpm/shared';
import { apiRequest } from '../api/client';

const props = defineProps<{ currentUser: CurrentUser }>();
const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId));
const project = ref<ReserveProjectSummary | null>(null);
const execution = ref<ProjectExecutionSummary | null>(null);
const loading = ref(true);
const error = ref('');
const tab = ref(String(route.query.tab || 'overview'));

const canManage = computed(() => ['admin', 'project_manager'].includes(props.currentUser.role));
const implementationProgress = computed(() => {
  const tasks = execution.value?.tasks ?? [];
  const planned = tasks.reduce((sum, item) => sum + item.plannedQuantityScaled, 0);
  const done = tasks.reduce((sum, item) => sum + item.implementedQuantityScaled, 0);
  return planned ? Math.min(100, Math.round(done / planned * 100)) : 0;
});
const settlementProgress = computed(() => {
  const tasks = execution.value?.tasks ?? [];
  const planned = tasks.reduce((sum, item) => sum + item.plannedQuantityScaled, 0);
  const done = tasks.reduce((sum, item) => sum + item.settledQuantityScaled, 0);
  return planned ? Math.min(100, Math.round(done / planned * 100)) : 0;
});

function formatMoneyFen(value: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value / 100);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [detail, summary] = await Promise.all([
      apiRequest<ReserveProjectSummary>(`/api/reserve-projects/${encodeURIComponent(projectId.value)}`),
      apiRequest<ProjectExecutionSummary>(`/api/projects/${encodeURIComponent(projectId.value)}/execution`),
    ]);
    project.value = detail;
    execution.value = summary;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '项目详情读取失败';
  } finally { loading.value = false; }
}

function backToProjects() { void router.push('/projects'); }
function openTask(taskId: string) { void router.push(`/projects/${encodeURIComponent(projectId.value)}/tasks/${encodeURIComponent(taskId)}`); }
function openLegacyExecution() { void router.push('/delivery'); }

function setTab(value: string) {
  tab.value = value;
  void router.replace({ query: { ...route.query, tab: value } });
}

onMounted(load);
</script>

<template>
  <div class="view-stack project-detail-view">
    <button class="breadcrumb-back" @click="backToProjects">‹ 返回项目</button>
    <div v-if="error" class="detail-error">{{ error }} <n-button text @click="load">重新加载</n-button></div>
    <n-spin :show="loading">
      <template v-if="project && execution">
        <section class="object-header">
          <div>
            <div class="object-kicker">{{ project.year ?? '未设年度' }} · {{ project.owner || '未指定负责人' }}</div>
            <h2>{{ project.name }}</h2>
            <div class="object-tags">
              <n-tag size="small" :bordered="false" :type="execution.released ? 'info' : project.status === 'confirmed' ? 'success' : 'default'">
                {{ execution.released ? '执行中' : project.status === 'confirmed' ? '储备已确认' : '储备草稿' }}
              </n-tag>
              <span>项目 v{{ project.version }}</span>
              <span>储备 v{{ project.reserveVersion }}</span>
            </div>
          </div>
          <n-button v-if="canManage && project.status === 'confirmed' && !execution.released" type="primary" @click="openLegacyExecution">前往项目出库</n-button>
          <n-button v-else-if="execution.released && !execution.tasks.length" type="primary" @click="openLegacyExecution">前往创建任务</n-button>
          <n-button v-else-if="execution.tasks.length" type="primary" @click="setTab('tasks')">查看执行任务</n-button>
        </section>

        <nav class="segment-nav" aria-label="项目详情分段">
          <button v-for="item in [
            ['overview', '概览'], ['demands', '来源需求'], ['materials', '项目物资'], ['tasks', '执行任务'], ['finance', '资金'], ['history', '附件与历史'],
          ]" :key="item[0]" :class="{ active: tab === item[0] }" @click="setTab(item[0])">{{ item[1] }}</button>
        </nav>

        <section v-if="tab === 'overview'" class="detail-section overview-section">
          <div class="overview-grid">
            <div class="overview-primary">
              <div class="metric-row"><span>执行任务</span><strong>{{ execution.tasks.length }}</strong></div>
              <div class="metric-row"><span>来源需求</span><strong>{{ project.demandLinks.length }}</strong></div>
              <div class="progress-metric">
                <div><span>实施进度</span><strong>{{ implementationProgress }}%</strong></div>
                <n-progress type="line" :show-indicator="false" :percentage="implementationProgress" />
              </div>
              <div class="progress-metric">
                <div><span>结算进度</span><strong>{{ settlementProgress }}%</strong></div>
                <n-progress type="line" :show-indicator="false" :percentage="settlementProgress" />
              </div>
            </div>
            <div class="money-summary">
              <span>已知项目物资金额</span>
              <strong>{{ formatMoneyFen(project.knownMaterialAmountFen) }}</strong>
              <small v-if="project.missingPriceCount">另有 {{ project.missingPriceCount }} 项物资待估价</small>
              <small v-else>当前项目物资价格完整</small>
            </div>
          </div>
        </section>

        <section v-else-if="tab === 'tasks'" class="detail-section">
          <div class="section-heading"><div><h3>执行任务</h3><p>供应、实施、结算分别推进，不强制串行。</p></div></div>
          <div v-if="execution.tasks.length" class="task-list">
            <button v-for="task in execution.tasks" :key="task.id" class="task-row" @click="openTask(task.id)">
              <div><strong>{{ task.name }}</strong><span>{{ task.scopeText || '未填写现场范围' }}</span></div>
              <div class="task-progress-pair"><span>实施 {{ Math.round(task.implementedQuantityScaled / task.plannedQuantityScaled * 100) }}%</span><span>结算 {{ Math.round(task.settledQuantityScaled / task.plannedQuantityScaled * 100) }}%</span></div>
              <span class="row-chevron">›</span>
            </button>
          </div>
          <n-empty v-else description="项目出库后可以创建执行任务" />
        </section>

        <section v-else-if="tab === 'demands'" class="detail-section">
          <div class="section-heading"><div><h3>来源需求</h3><p>这里只表达项目来源，不等同于项目物资。</p></div></div>
          <div v-if="project.demandLinks.length" class="fact-list">
            <div v-for="item in project.demandLinks" :key="item.id"><strong>{{ item.sequenceNo }}</strong><span>{{ item.lineName }} {{ item.section }}</span></div>
          </div>
          <n-empty v-else description="当前项目未关联来源需求" />
        </section>

        <section v-else-if="tab === 'materials'" class="detail-section">
          <div class="section-heading"><div><h3>项目物资</h3><p>项目物资独立于需求阶段物资，可持续修订并保留历史。</p></div></div>
          <div v-if="project.materialRequirements.length" class="fact-list">
            <div v-for="item in project.materialRequirements" :key="item.id"><strong>{{ item.model }}</strong><span>{{ item.requiredQuantityScaled / 10000 }} {{ item.unit }}</span></div>
          </div>
          <n-empty v-else description="当前项目没有项目物资；0 物资项目仍然合法" />
        </section>

        <section v-else class="detail-section muted-placeholder">
          <h3>{{ tab === 'finance' ? '资金' : '附件与历史' }}</h3>
          <p>此分段将在下一批迁移中接入现有真实业务能力。</p>
        </section>
      </template>
    </n-spin>
  </div>
</template>

<style scoped>
.project-detail-view { max-width: 1260px; }
.breadcrumb-back { justify-self: start; padding: 3px 0; border: 0; background: transparent; color: var(--ui-text-secondary, #566174); cursor: pointer; }
.breadcrumb-back:hover { color: var(--ui-accent, #075dcc); }
.object-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 4px 2px 8px; }
.object-kicker { margin-bottom: 5px; color: var(--ui-text-secondary, #566174); font-size: 13px; }
.object-header h2 { margin: 0; font-size: 28px; line-height: 1.25; letter-spacing: -.025em; }
.object-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 11px; color: var(--ui-text-secondary, #566174); font-size: 12px; }
.segment-nav { display: flex; gap: 4px; overflow-x: auto; padding: 4px; border: 1px solid var(--ui-border, #dce2ea); border-radius: 14px; background: rgba(255,255,255,.72); scrollbar-width: none; }
.segment-nav button { min-height: 38px; padding: 0 14px; border: 0; border-radius: 10px; background: transparent; color: var(--ui-text-secondary, #566174); white-space: nowrap; cursor: pointer; }
.segment-nav button.active { background: var(--ui-surface, #fff); color: var(--ui-text, #18212f); font-weight: 700; box-shadow: 0 1px 3px rgba(25,40,65,.08); }
.detail-section { padding: 22px; border: 1px solid var(--ui-border, #dce2ea); border-radius: 18px; background: var(--ui-surface, #fff); }
.overview-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .75fr); gap: 28px; }
.overview-primary { display: grid; grid-template-columns: 1fr 1fr; gap: 20px 26px; }
.metric-row, .progress-metric { display: grid; gap: 7px; min-height: 74px; align-content: center; }
.metric-row span, .progress-metric span, .money-summary span { color: var(--ui-text-secondary, #566174); font-size: 13px; }
.metric-row strong { font-size: 24px; }
.progress-metric > div { display: flex; justify-content: space-between; gap: 14px; }
.progress-metric strong { font-size: 15px; }
.money-summary { display: grid; align-content: center; min-height: 168px; padding: 20px; border-radius: 16px; background: var(--ui-surface-muted, #eef1f5); }
.money-summary strong { margin: 8px 0; font-size: 26px; font-variant-numeric: tabular-nums; }
.money-summary small { color: var(--ui-text-secondary, #566174); }
.section-heading { display: flex; align-items: end; justify-content: space-between; margin-bottom: 14px; }
.section-heading h3, .muted-placeholder h3 { margin: 0; font-size: 18px; }
.section-heading p, .muted-placeholder p { margin: 4px 0 0; color: var(--ui-text-secondary, #566174); font-size: 13px; }
.task-list, .fact-list { display: grid; }
.task-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 24px; gap: 20px; align-items: center; min-height: 68px; padding: 12px 4px; border: 0; border-bottom: 1px solid var(--ui-border, #dce2ea); background: transparent; color: inherit; text-align: left; cursor: pointer; }
.task-row:last-child { border-bottom: 0; }
.task-row > div:first-child { display: grid; gap: 4px; }
.task-row span, .fact-list span { color: var(--ui-text-secondary, #566174); font-size: 13px; }
.task-progress-pair { display: flex; gap: 16px; }
.row-chevron { font-size: 22px; }
.fact-list > div { display: flex; justify-content: space-between; gap: 20px; padding: 13px 2px; border-bottom: 1px solid var(--ui-border, #dce2ea); }
.detail-error { padding: 14px 16px; border-radius: 12px; background: #fff4f3; color: #b42318; }
@media (max-width: 767px) {
  .object-header { align-items: flex-start; flex-direction: column; gap: 16px; }
  .object-header h2 { font-size: 24px; }
  .object-header > .n-button { width: 100%; }
  .segment-nav { margin-inline: -2px; }
  .detail-section { padding: 17px 16px; }
  .overview-grid { grid-template-columns: 1fr; gap: 16px; }
  .overview-primary { grid-template-columns: 1fr; gap: 4px; }
  .metric-row { grid-template-columns: 1fr auto; min-height: 46px; align-items: center; }
  .metric-row strong { font-size: 18px; }
  .progress-metric { min-height: 62px; }
  .money-summary { min-height: 124px; }
  .money-summary strong { font-size: 22px; }
  .task-row { grid-template-columns: 1fr 20px; gap: 12px; }
  .task-progress-pair { grid-column: 1 / -1; justify-content: flex-start; }
  .row-chevron { grid-column: 2; grid-row: 1; }
}
</style>
