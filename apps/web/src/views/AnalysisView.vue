<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NGrid,
  NGridItem,
  NInput,
  NSelect,
  NSpace,
  NSpin,
  NStatistic,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui';
import type { EChartsType } from 'echarts/core';
import { apiRequest, jsonRequestInit } from '../api/client';
import type {
  AlertEventSummary,
  AnalysisRuleSummary,
  CurrentUser,
  FinanceProjectSummary,
  FrameworkProgressSummary,
  FrameworkSummary,
  MilestoneDueSummary,
  MonthlyPlanSummary,
  MonthlyReportSummary,
  ProjectGapSummary,
  ReserveRemainingSummary,
} from '@tpm/shared';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const canPlan = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');
const isAdmin = computed(() => props.currentUser.role === 'admin');

const loading = ref(true);
const saving = ref(false);
const error = ref('');
const frameworks = ref<FrameworkSummary[]>([]);
const projects = ref<FinanceProjectSummary[]>([]);
const selectedFrameworkId = ref<string | null>(null);
const progress = ref<FrameworkProgressSummary | null>(null);
const gaps = ref<ProjectGapSummary[]>([]);
const reserve = ref<ReserveRemainingSummary | null>(null);
const rule = ref<AnalysisRuleSummary | null>(null);
const milestones = ref<MilestoneDueSummary[]>([]);
const alerts = ref<AlertEventSummary[]>([]);
const plans = ref<MonthlyPlanSummary[]>([]);
const reports = ref<MonthlyReportSummary[]>([]);

const asOfDate = ref(businessToday());
const planProjectId = ref<string | null>(null);
const planMonth = ref<number | null>(Number(asOfDate.value.slice(5, 7)));
const planAmountYuan = ref('');
const ruleMode = ref<'ratio' | 'gap'>('ratio');
const ruleThresholdPercent = ref('80');
const reportMonth = ref(asOfDate.value.slice(0, 7));
const milestoneForm = ref({ title: '', owner: '', datePrecision: 'unknown' as 'month' | 'day' | 'unknown', month: null as number | null, specificDate: '' });

const progressChartEl = ref<HTMLDivElement | null>(null);
const reserveChartEl = ref<HTMLDivElement | null>(null);
let progressChart: EChartsType | null = null;
let reserveChart: EChartsType | null = null;
let disposed = false;

function businessToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function parseMoneyFen(value: string): number | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const fen = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return fen <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fen) : null;
}
function parsePercentBasisPoints(value: string): number | null {
  const match = value.trim().match(/^(100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/);
  if (!match) return null;
  const bp = Math.round(Number(value) * 100);
  return Number.isInteger(bp) && bp >= 0 && bp <= 10000 ? bp : null;
}
function formatMoney(fen: number | null | undefined) { return fen === null || fen === undefined ? '未配置' : `${(fen / 100).toFixed(2)} 元`; }
function formatPercent(bp: number | null | undefined) { return bp === null || bp === undefined ? '未配置' : `${(bp / 100).toFixed(2)}%`; }
function formatQuantity(value: number) { return (value / 10000).toFixed(4).replace(/\.?0+$/, ''); }
function quarterStatusLabel(status: string) { return status === 'ended' ? '已结束' : status === 'in_progress' ? '进行中' : '未开始'; }
function alertStateLabel(state: string) { return state === 'active' ? '处理中' : state === 'recovered' ? '已恢复' : state; }
function alertSeverityLabel(severity: string) { return severity === 'warning' ? '预警' : severity === 'critical' ? '严重' : severity === 'info' ? '提示' : severity; }
function milestoneStateLabel(row: MilestoneDueSummary) { return row.status === 'completed' ? '已完成' : row.overdue ? '已逾期' : row.reminderDue ? '待处理' : '未到期'; }

const frameworkOptions = computed(() => frameworks.value.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id })));
const planProjectOptions = computed(() => projects.value.filter((item) => item.frameworkId === selectedFrameworkId.value).map((item) => ({ label: item.name, value: item.id })));
const monthOptions = Array.from({ length: 12 }, (_, index) => ({ label: `${index + 1} 月`, value: index + 1 }));
const selectedFramework = computed(() => frameworks.value.find((item) => item.id === selectedFrameworkId.value) ?? null);
const analysisYear = computed(() => progress.value?.businessYear ?? Number(selectedFramework.value?.startDate.slice(0, 4) ?? asOfDate.value.slice(0, 4)));

const gapColumns = [
  { title: '子项目', key: 'projectName' },
  { title: '同期计划', key: 'plannedToDateFen', render: (row: ProjectGapSummary) => formatMoney(row.plannedToDateFen) },
  { title: '预算发生', key: 'actualToDateFen', render: (row: ProjectGapSummary) => formatMoney(row.actualToDateFen) },
  { title: '缺口', key: 'gapFen', render: (row: ProjectGapSummary) => formatMoney(row.gapFen) },
];
const milestoneColumns = computed(() => [
  { title: '事项', key: 'title' },
  { title: '负责人', key: 'owner', render: (row: MilestoneDueSummary) => row.owner ?? '—' },
  { title: '日期', key: 'specificDate', render: (row: MilestoneDueSummary) => row.dueDate ?? row.dueMonth ?? '待补充' },
  { title: '提醒', key: 'reminderDue', render: (row: MilestoneDueSummary) => row.status === 'completed' ? '已完成' : row.overdue ? '已逾期' : row.reminderDue ? '待处理' : '未到期' },
  ...(canPlan.value ? [{ title: '操作', key: 'action', render: (row: MilestoneDueSummary) => row.status === 'completed' ? null : h(NButton, { size: 'small', onClick: () => setMilestoneStatus(row, 'completed') }, { default: () => '完成' }) }] : []),
]);
const alertColumns = [
  { title: '级别', key: 'severity' }, { title: '状态', key: 'state' }, { title: '内容', key: 'message' }, { title: '周期', key: 'periodKey' },
];

async function loadFrameworkContext() {
  const frameworkId = selectedFrameworkId.value;
  progress.value = null; gaps.value = []; plans.value = []; reports.value = [];
  if (!frameworkId) { await renderCharts(); return; }
  const year = Number(selectedFramework.value?.startDate.slice(0, 4) ?? asOfDate.value.slice(0, 4));
  const [progressData, gapData, planData, reportData] = await Promise.all([
    apiRequest<FrameworkProgressSummary>(`/api/analysis/frameworks/${encodeURIComponent(frameworkId)}/progress?asOf=${asOfDate.value}`),
    apiRequest<{ items: ProjectGapSummary[] }>(`/api/analysis/projects/gaps?frameworkId=${encodeURIComponent(frameworkId)}&asOf=${asOfDate.value}`),
    apiRequest<{ items: MonthlyPlanSummary[] }>(`/api/analysis/plans?frameworkId=${encodeURIComponent(frameworkId)}&year=${year}`),
    apiRequest<{ items: MonthlyReportSummary[] }>(`/api/reports/monthly?frameworkId=${encodeURIComponent(frameworkId)}&businessMonth=${reportMonth.value}`),
  ]);
  progress.value = progressData;
  gaps.value = gapData.items;
  plans.value = planData.items;
  reports.value = reportData.items;
  await renderCharts();
}

async function loadCommon() {
  const basePromises: Promise<unknown>[] = [];
  const fwPromise = apiRequest<{ items: FrameworkSummary[] }>('/api/frameworks').then((data) => { frameworks.value = data.items; if (!selectedFrameworkId.value && data.items[0]) selectedFrameworkId.value = data.items[0].id; });
  const projectPromise = apiRequest<{ items: FinanceProjectSummary[] }>('/api/finance/projects').then((data) => { projects.value = data.items; });
  const reservePromise = apiRequest<ReserveRemainingSummary>('/api/analysis/reserve-remaining').then((data) => { reserve.value = data; });
  const rulePromise = apiRequest<AnalysisRuleSummary>('/api/analysis/rules').then((data) => { rule.value = data; ruleMode.value = data.mode; ruleThresholdPercent.value = (data.thresholdBasisPoints / 100).toFixed(2).replace(/\.00$/, ''); });
  const milestonePromise = apiRequest<{ items: MilestoneDueSummary[] }>(`/api/milestones/due?asOf=${asOfDate.value}`).then((data) => { milestones.value = data.items; });
  const alertPromise = apiRequest<{ items: AlertEventSummary[] }>('/api/alerts').then((data) => { alerts.value = data.items; });
  basePromises.push(fwPromise, projectPromise, reservePromise, rulePromise, milestonePromise, alertPromise);
  await Promise.all(basePromises);
  await loadFrameworkContext();
  await renderCharts();
}

async function refresh() {
  loading.value = true; error.value = '';
  try { await loadCommon(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '读取分析数据失败'; }
  finally { loading.value = false; }
}
async function selectFramework(value: string | null) { selectedFrameworkId.value = value; await loadFrameworkContext(); }
async function changeAsOf() {
  reportMonth.value = asOfDate.value.slice(0, 7);
  const [milestoneData] = await Promise.all([apiRequest<{ items: MilestoneDueSummary[] }>(`/api/milestones/due?asOf=${asOfDate.value}`), loadFrameworkContext()]);
  milestones.value = milestoneData.items;
}

async function savePlan() {
  if (!planProjectId.value || !planMonth.value) { message.warning('请选择项目和月份'); return; }
  const targetAmountFen = parseMoneyFen(planAmountYuan.value); if (targetAmountFen === null) { message.warning('请输入有效计划金额'); return; }
  const current = plans.value.find((item) => item.projectId === planProjectId.value && item.month === Number(planMonth.value));
  saving.value = true;
  try {
    await apiRequest(`/api/analysis/plans/${encodeURIComponent(planProjectId.value)}/${analysisYear.value}/${Number(planMonth.value)}`, jsonRequestInit('PUT', { expectedVersion: current?.version ?? null, targetAmountFen }));
    await loadFrameworkContext(); message.success('月计划已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '月计划保存失败'); }
  finally { saving.value = false; }
}
async function saveRule() {
  if (!rule.value) return;
  const thresholdBasisPoints = parsePercentBasisPoints(ruleThresholdPercent.value); if (thresholdBasisPoints === null) { message.warning('阈值请输入 0–100%'); return; }
  saving.value = true;
  try {
    rule.value = await apiRequest<AnalysisRuleSummary>('/api/analysis/rules', jsonRequestInit('PUT', { expectedVersion: rule.value.version, mode: ruleMode.value, thresholdBasisPoints }));
    await loadFrameworkContext(); message.success('分析规则已更新');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '规则更新失败'); }
  finally { saving.value = false; }
}
async function generateReport() {
  if (!selectedFrameworkId.value) return;
  saving.value = true;
  try {
    await apiRequest('/api/reports/monthly', jsonRequestInit('POST', { frameworkId: selectedFrameworkId.value, businessMonth: reportMonth.value, dataCutoffDate: asOfDate.value }));
    await loadFrameworkContext(); message.success('月报修订已生成');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '月报生成失败'); }
  finally { saving.value = false; }
}
async function createMilestone() {
  const title = milestoneForm.value.title.trim(); if (!title) { message.warning('请输入事项名称'); return; }
  const precision = milestoneForm.value.datePrecision;
  const month = precision === 'unknown' ? null : milestoneForm.value.month;
  const specificDate = precision === 'day' ? milestoneForm.value.specificDate : null;
  saving.value = true;
  try {
    await apiRequest('/api/milestones', jsonRequestInit('POST', { businessYear: analysisYear.value, title, owner: milestoneForm.value.owner.trim() || null, projectId: null, datePrecision: precision, month, specificDate: specificDate || null, leadDays: [7, 3, 0] }));
    milestoneForm.value = { title: '', owner: '', datePrecision: 'unknown', month: null, specificDate: '' };
    milestones.value = (await apiRequest<{ items: MilestoneDueSummary[] }>(`/api/milestones/due?asOf=${asOfDate.value}`)).items; message.success('年度事项已创建');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '事项创建失败'); }
  finally { saving.value = false; }
}
async function setMilestoneStatus(item: MilestoneDueSummary, status: 'open' | 'completed') {
  try {
    await apiRequest(`/api/milestones/${item.id}/status`, jsonRequestInit('PUT', { expectedVersion: item.version, status }));
    milestones.value = (await apiRequest<{ items: MilestoneDueSummary[] }>(`/api/milestones/due?asOf=${asOfDate.value}`)).items;
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '事项状态更新失败'); }
}
async function renderCharts() {
  await nextTick();
  const chartElementsExist = progressChartEl.value || reserveChartEl.value;
  if (!chartElementsExist) return;
  const { init } = await import('../charts/echarts');
  if (disposed) return;
  if (progressChartEl.value) {
    progressChart ??= init(progressChartEl.value);
    progressChart.setOption({
      tooltip: { trigger: 'axis' }, grid: { left: 56, right: 24, top: 30, bottom: 36 },
      xAxis: { type: 'category', data: ['同期计划', '预算发生'] }, yAxis: { type: 'value' },
      series: [{ type: 'bar', data: [progress.value?.plannedToDateFen ?? 0, progress.value?.actualToDateFen ?? 0] }],
    }, true);
  }
  if (reserveChartEl.value) {
    reserveChart ??= init(reserveChartEl.value);
    reserveChart.setOption({
      tooltip: { trigger: 'axis' }, grid: { left: 90, right: 24, top: 20, bottom: 36 },
      xAxis: { type: 'value' }, yAxis: { type: 'category', data: (reserve.value?.categories ?? []).map((item) => item.label) },
      series: [{ type: 'bar', data: (reserve.value?.categories ?? []).map((item) => item.knownCurrentAmountFen) }],
    }, true);
  }
}
function resizeCharts() { progressChart?.resize(); reserveChart?.resize(); }

onMounted(() => { disposed = false; window.addEventListener('resize', resizeCharts); void refresh(); });
onBeforeUnmount(() => { disposed = true; window.removeEventListener('resize', resizeCharts); progressChart?.dispose(); reserveChart?.dispose(); });
</script>

<template>
  <div class="view-stack analysis-view">
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <header class="page-header">
      <div class="page-header-copy">
        <span class="page-eyebrow">ANALYSIS</span>
        <h2 class="page-title">分析</h2>
        <p class="page-description">查看框架进度、项目缺口、储备剩余和年度事项；通知与备份已归入设置。</p>
      </div>
    </header>

    <section class="analysis-toolbar">
      <n-form-item label="统计日期"><n-input v-model:value="asOfDate" data-test="analysis-as-of" @change="changeAsOf" /></n-form-item>
      <n-form-item label="框架"><n-select :value="selectedFrameworkId" :options="frameworkOptions" data-test="analysis-framework" @update:value="selectFramework" /></n-form-item>
      <n-button @click="refresh">刷新数据</n-button>
    </section>

    <n-spin :show="loading">
      <section class="analysis-metrics">
        <div><span>同期计划</span><strong>{{ formatMoney(progress?.plannedToDateFen) }}</strong></div>
        <div><span>预算发生</span><strong>{{ formatMoney(progress?.actualToDateFen) }}</strong></div>
        <div><span>同期达成率</span><strong>{{ formatPercent(progress?.attainmentBasisPoints) }}</strong></div>
        <div><span>活动预警</span><strong>{{ alerts.filter((item) => item.state === 'active').length }}</strong></div>
      </section>

      <n-alert v-if="progress?.lagging" type="warning" :bordered="false" class="analysis-warning">{{ progress.frameworkName }} 当前低于规则要求；规则为 {{ progress.rule.mode === 'ratio' ? '同期计划达成率' : '年度目标落后百分点' }} {{ formatPercent(progress.rule.thresholdBasisPoints) }}。</n-alert>

      <n-tabs type="line" animated>
        <n-tab-pane name="progress" tab="进度与缺口">
          <div class="analysis-two-column">
            <section class="analysis-panel chart-panel">
              <div class="analysis-panel-heading"><div><h3>计划与实际</h3><p>{{ analysisYear }} 年累计进度</p></div></div>
              <div ref="progressChartEl" class="chart"></div>
            </section>
            <section class="analysis-panel quarter-panel">
              <div class="analysis-panel-heading"><div><h3>季度节点</h3><p>只按实际年份和季度边界判断状态</p></div></div>
              <div class="quarter-list">
                <div v-for="quarter in progress?.quarters ?? []" :key="quarter.quarter" class="quarter-row">
                  <span class="quarter-index">Q{{ quarter.quarter }}</span>
                  <div><strong>{{ formatPercent(quarter.cumulativeTargetBasisPoints) }}</strong><small>累计目标</small></div>
                  <n-tag size="small" :bordered="false" :type="quarter.status === 'ended' ? 'default' : quarter.status === 'in_progress' ? 'info' : 'warning'">{{ quarterStatusLabel(quarter.status) }}</n-tag>
                </div>
              </div>
            </section>
          </div>

          <section class="analysis-panel gap-panel">
            <div class="analysis-panel-heading"><div><h3>子项目同期缺口</h3><p>同期计划与预算发生的真实差额</p></div></div>
            <n-data-table v-if="gaps.length" class="analysis-desktop-table" :columns="gapColumns" :data="gaps" :pagination="false" />
            <div v-if="gaps.length" class="analysis-mobile-list">
              <div v-for="item in gaps" :key="item.projectId" class="analysis-mobile-row">
                <strong>{{ item.projectName }}</strong>
                <div class="mobile-facts"><span>计划 {{ formatMoney(item.plannedToDateFen) }}</span><span>发生 {{ formatMoney(item.actualToDateFen) }}</span><span>缺口 {{ formatMoney(item.gapFen) }}</span></div>
              </div>
            </div>
            <n-empty v-else description="暂无项目缺口数据" />
          </section>

          <section v-if="canPlan || isAdmin" class="analysis-panel configuration-panel">
            <div class="analysis-panel-heading"><div><h3>分析配置</h3><p>月计划、滞后规则和月报快照集中维护</p></div></div>
            <div class="configuration-grid">
              <div v-if="canPlan" class="configuration-group">
                <strong>月计划</strong>
                <n-form-item label="子项目"><n-select v-model:value="planProjectId" data-test="plan-project" :options="planProjectOptions" /></n-form-item>
                <div class="configuration-fields"><n-form-item label="月份"><n-select v-model:value="planMonth" data-test="plan-month" :options="monthOptions" /></n-form-item><n-form-item label="目标金额（元）"><n-input v-model:value="planAmountYuan" data-test="plan-amount" /></n-form-item></div>
                <n-button type="primary" data-test="save-plan" :loading="saving" @click="savePlan">保存月计划</n-button>
              </div>
              <div v-if="isAdmin && rule" class="configuration-group">
                <strong>滞后规则</strong>
                <n-form-item label="模式"><n-select v-model:value="ruleMode" :options="[{ label: '同期计划达成率', value: 'ratio' }, { label: '年度目标落后百分点', value: 'gap' }]" /></n-form-item>
                <n-form-item label="阈值（%）"><n-input v-model:value="ruleThresholdPercent" data-test="rule-threshold" /></n-form-item>
                <n-button data-test="save-rule" :loading="saving" @click="saveRule">更新规则</n-button>
              </div>
              <div v-if="canPlan" class="configuration-group">
                <strong>月报快照</strong>
                <n-form-item label="业务月份"><n-input v-model:value="reportMonth" /></n-form-item>
                <n-button @click="generateReport">生成新修订</n-button>
                <div v-if="reports.length" class="report-history"><span v-for="item in reports" :key="item.id">{{ item.businessMonth }} · 修订 {{ item.revision }} · 规则 v{{ item.ruleVersion }}</span></div>
                <span v-else class="configuration-empty">当前月份尚无报告快照</span>
              </div>
            </div>
          </section>
        </n-tab-pane>

        <n-tab-pane name="reserve" tab="储备剩余">
          <section class="reserve-metrics">
            <div><span>当前储备物资数量</span><strong>{{ formatQuantity(reserve?.currentMaterialQuantityScaled ?? 0) }}</strong></div>
            <div><span>已项目级出库项目</span><strong>{{ reserve?.releasedProjectCount ?? 0 }}</strong></div>
            <div><span>当前已知物资金额</span><strong>{{ formatMoney(reserve?.knownCurrentMaterialAmountFen) }}</strong></div>
          </section>
          <n-alert v-if="reserve && (reserve.missingPriceCount || reserve.unclassifiedCurrentMaterialFen)" type="warning" :bordered="false" class="analysis-warning">缺价 {{ reserve.missingPriceCount }} 项；未分类当前物资 {{ formatMoney(reserve.unclassifiedCurrentMaterialFen) }}。储备类别分析只统计当前未出库项目的项目物资，施工/其他费用不纳入。</n-alert>
          <section class="analysis-panel">
            <div class="analysis-panel-heading"><div><h3>储备大类金额</h3><p>仅统计当前仍未项目级出库的项目物资</p></div></div>
            <div ref="reserveChartEl" class="chart"></div>
            <div class="category-list"><n-tag v-for="item in reserve?.categories ?? []" :key="item.reserveCategoryId" :bordered="false">{{ item.label }} {{ formatMoney(item.knownCurrentAmountFen) }}</n-tag></div>
          </section>
        </n-tab-pane>

        <n-tab-pane name="milestones" tab="年度事项">
          <section v-if="canPlan" class="analysis-panel milestone-editor">
            <div class="analysis-panel-heading"><div><h3>新增年度事项</h3><p>日期只有月份时保持月份精度，不补造具体日期</p></div></div>
            <div class="milestone-form-grid">
              <n-form-item label="事项"><n-input v-model:value="milestoneForm.title" /></n-form-item>
              <n-form-item label="负责人"><n-input v-model:value="milestoneForm.owner" /></n-form-item>
              <n-form-item label="日期精度"><n-select v-model:value="milestoneForm.datePrecision" :options="[{ label: '具体日期', value: 'day' }, { label: '仅月份', value: 'month' }, { label: '待补充', value: 'unknown' }]" /></n-form-item>
              <n-form-item v-if="milestoneForm.datePrecision !== 'unknown'" label="月份"><n-select v-model:value="milestoneForm.month" :options="monthOptions" /></n-form-item>
              <n-form-item v-if="milestoneForm.datePrecision === 'day'" label="日期"><n-input v-model:value="milestoneForm.specificDate" /></n-form-item>
              <n-button @click="createMilestone">新增事项</n-button>
            </div>
          </section>
          <section class="analysis-panel">
            <div class="analysis-panel-heading"><div><h3>事项清单</h3><p>{{ analysisYear }} 年需要持续跟踪的事项</p></div></div>
            <n-data-table v-if="milestones.length" class="analysis-desktop-table" :columns="milestoneColumns" :data="milestones" :pagination="false" />
            <div v-if="milestones.length" class="analysis-mobile-list">
              <div v-for="item in milestones" :key="item.id" class="analysis-mobile-row milestone-mobile-row">
                <div class="mobile-row-head"><strong>{{ item.title }}</strong><n-tag size="small" :bordered="false" :type="item.status === 'completed' ? 'success' : item.overdue ? 'error' : item.reminderDue ? 'warning' : 'default'">{{ milestoneStateLabel(item) }}</n-tag></div>
                <div class="mobile-facts"><span>{{ item.owner || '未指定负责人' }}</span><span>{{ item.dueDate ?? item.dueMonth ?? '日期待补充' }}</span></div>
                <n-button v-if="canPlan && item.status !== 'completed'" size="small" secondary @click="setMilestoneStatus(item, 'completed')">标记完成</n-button>
              </div>
            </div>
            <n-empty v-else description="暂无年度事项" />
          </section>
        </n-tab-pane>

        <n-tab-pane name="alerts" tab="预警">
          <section class="analysis-panel">
            <div class="analysis-panel-heading"><div><h3>预警事件</h3><p>这里只保留业务预警；通知发送与备份在设置中管理</p></div></div>
            <n-data-table v-if="alerts.length" class="analysis-desktop-table" :columns="alertColumns" :data="alerts" :pagination="false" />
            <div v-if="alerts.length" class="analysis-mobile-list">
              <div v-for="item in alerts" :key="item.id" class="analysis-mobile-row">
                <div class="mobile-row-head"><strong>{{ item.message }}</strong><n-tag size="small" :bordered="false" :type="item.state === 'active' ? 'warning' : 'success'">{{ alertStateLabel(item.state) }}</n-tag></div>
                <div class="mobile-facts"><span>{{ alertSeverityLabel(item.severity) }}</span><span>{{ item.periodKey }}</span></div>
              </div>
            </div>
            <n-empty v-else description="暂无预警" />
          </section>
        </n-tab-pane>
      </n-tabs>
    </n-spin>
  </div>
</template>

<style scoped>
.analysis-view { min-width: 0; max-width: 1480px; }
.analysis-toolbar { display: grid; grid-template-columns: 180px minmax(280px, 1fr) auto; gap: 10px; align-items: end; padding: 14px 16px 4px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.analysis-metrics, .reserve-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.analysis-metrics > div, .reserve-metrics > div { display: grid; gap: 7px; min-height: 92px; align-content: center; padding: 14px 17px; }
.analysis-metrics > div + div, .reserve-metrics > div + div { border-left: 1px solid var(--ui-border); }
.analysis-metrics span, .reserve-metrics span { color: var(--ui-text-tertiary); font-size: 11px; }
.analysis-metrics strong, .reserve-metrics strong { font-size: 20px; font-weight: 690; font-variant-numeric: tabular-nums; letter-spacing: -.015em; }
.reserve-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 16px; }
.analysis-warning { margin-top: 14px; }
.analysis-two-column { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(320px, .8fr); gap: 14px; }
.analysis-panel { overflow: hidden; margin-top: 14px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.analysis-two-column .analysis-panel { margin-top: 0; }
.analysis-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 58px; padding: 12px 16px; border-bottom: 1px solid var(--ui-border); }
.analysis-panel-heading > div { display: grid; gap: 3px; }
.analysis-panel-heading h3 { margin: 0; font-size: 14px; font-weight: 680; }
.analysis-panel-heading p { margin: 0; color: var(--ui-text-tertiary); font-size: 10px; }
.chart { width: 100%; height: 280px; }
.quarter-list { display: grid; padding: 4px 16px 12px; }
.quarter-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 12px; align-items: center; min-height: 58px; border-bottom: 1px solid var(--ui-border); }
.quarter-row:last-child { border-bottom: 0; }
.quarter-index { color: var(--ui-text-secondary); font-size: 12px; font-weight: 700; }
.quarter-row > div { display: grid; gap: 2px; }
.quarter-row strong { font-size: 13px; font-weight: 650; }
.quarter-row small { color: var(--ui-text-tertiary); font-size: 10px; }
.configuration-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.configuration-group { min-width: 0; padding: 16px; }
.configuration-group + .configuration-group { border-left: 1px solid var(--ui-border); }
.configuration-group > strong { display: block; margin-bottom: 12px; font-size: 12px; font-weight: 680; }
.configuration-fields { display: grid; grid-template-columns: .75fr 1.25fr; gap: 10px; }
.configuration-empty { color: var(--ui-text-tertiary); font-size: 11px; }
.report-history { display: grid; gap: 4px; margin-top: 10px; color: var(--ui-text-secondary); font-size: 10px; }
.category-list { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 16px; }
.milestone-form-grid { display: grid; grid-template-columns: 1.35fr 1fr .9fr .7fr 1fr auto; gap: 10px; align-items: end; padding: 16px; }
.analysis-mobile-list { display: none; }
.mobile-row-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.mobile-facts { display: flex; flex-wrap: wrap; gap: 5px 12px; color: var(--ui-text-tertiary); font-size: 10px; }
@media (max-width: 1050px) {
  .analysis-two-column { grid-template-columns: 1fr; }
  .configuration-grid { grid-template-columns: 1fr; }
  .configuration-group + .configuration-group { border-top: 1px solid var(--ui-border); border-left: 0; }
  .milestone-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 767px) {
  .analysis-toolbar { grid-template-columns: 1fr; padding: 12px 12px 2px; }
  .analysis-toolbar > .n-button { width: 100%; margin-bottom: 10px; }
  .analysis-metrics, .reserve-metrics { grid-template-columns: 1fr 1fr; }
  .analysis-metrics > div, .reserve-metrics > div { min-height: 72px; padding: 12px; }
  .analysis-metrics > div + div, .reserve-metrics > div + div { border-left: 0; }
  .analysis-metrics > div:nth-child(even), .reserve-metrics > div:nth-child(even) { border-left: 1px solid var(--ui-border); }
  .analysis-metrics > div:nth-child(n+3), .reserve-metrics > div:nth-child(n+3) { border-top: 1px solid var(--ui-border); }
  .analysis-metrics strong, .reserve-metrics strong { font-size: 16px; }
  .analysis-panel { border-radius: 14px; }
  .chart { height: 230px; }
  .configuration-fields, .milestone-form-grid { grid-template-columns: 1fr; }
  .analysis-desktop-table { display: none; }
  .analysis-mobile-list { display: grid; }
  .analysis-mobile-row { display: grid; gap: 7px; padding: 13px 14px; border-bottom: 1px solid var(--ui-border); }
  .analysis-mobile-row:last-child { border-bottom: 0; }
  .analysis-mobile-row > strong, .mobile-row-head strong { font-size: 12px; font-weight: 650; }
  .milestone-mobile-row > .n-button { justify-self: start; }
}
</style>
