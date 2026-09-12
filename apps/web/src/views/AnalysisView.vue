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
import { parseApiResponse } from '../api/response';
import type {
  AlertEventSummary,
  AnalysisRuleSummary,
  ApiResponse,
  BackupSummary,
  CurrentUser,
  FinanceProjectSummary,
  FrameworkProgressSummary,
  FrameworkSummary,
  MilestoneDueSummary,
  MonthlyPlanSummary,
  MonthlyReportSummary,
  NotificationContactSummary,
  NotificationOutboxSummary,
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
const backups = ref<BackupSummary[]>([]);
const contacts = ref<NotificationContactSummary[]>([]);
const outbox = ref<NotificationOutboxSummary[]>([]);

const asOfDate = ref(businessToday());
const planProjectId = ref<string | null>(null);
const planMonth = ref<number | null>(Number(asOfDate.value.slice(5, 7)));
const planAmountYuan = ref('');
const ruleMode = ref<'ratio' | 'gap'>('ratio');
const ruleThresholdPercent = ref('80');
const reportMonth = ref(asOfDate.value.slice(0, 7));
const milestoneForm = ref({ title: '', owner: '', datePrecision: 'unknown' as 'month' | 'day' | 'unknown', month: null as number | null, specificDate: '' });
const contactForm = ref({ memberId: props.currentUser.id, address: '' });

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

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
  return result.data;
}
function writeInit(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) };
}

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
const backupColumns = [
  { title: '日期', key: 'backupDate' }, { title: '类型', key: 'kind' }, { title: '状态', key: 'status' }, { title: '分片', key: 'chunkCount' },
  { title: '校验', key: 'verifiedAt', render: (row: BackupSummary) => row.verifiedAt ? '已校验' : '未校验' },
  { title: '操作', key: 'action', render: (row: BackupSummary) => h(NSpace, {}, { default: () => [row.status !== 'completed' ? h(NButton, { size: 'small', onClick: () => stepBackup(row) }, { default: () => '推进' }) : null, row.status === 'completed' ? h(NButton, { size: 'small', onClick: () => verifyBackup(row) }, { default: () => '校验' }) : null] }) },
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
  if (isAdmin.value) {
    basePromises.push(
      apiRequest<{ items: BackupSummary[] }>('/api/backups').then((data) => { backups.value = data.items; }),
      apiRequest<{ items: NotificationContactSummary[] }>('/api/notification-contacts').then((data) => { contacts.value = data.items; }),
      apiRequest<{ items: NotificationOutboxSummary[] }>('/api/notification-outbox').then((data) => { outbox.value = data.items; }),
    );
  }
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
    await apiRequest(`/api/analysis/plans/${encodeURIComponent(planProjectId.value)}/${analysisYear.value}/${Number(planMonth.value)}`, writeInit('PUT', { expectedVersion: current?.version ?? null, targetAmountFen }));
    await loadFrameworkContext(); message.success('月计划已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '月计划保存失败'); }
  finally { saving.value = false; }
}
async function saveRule() {
  if (!rule.value) return;
  const thresholdBasisPoints = parsePercentBasisPoints(ruleThresholdPercent.value); if (thresholdBasisPoints === null) { message.warning('阈值请输入 0–100%'); return; }
  saving.value = true;
  try {
    rule.value = await apiRequest<AnalysisRuleSummary>('/api/analysis/rules', writeInit('PUT', { expectedVersion: rule.value.version, mode: ruleMode.value, thresholdBasisPoints }));
    await loadFrameworkContext(); message.success('分析规则已更新');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '规则更新失败'); }
  finally { saving.value = false; }
}
async function generateReport() {
  if (!selectedFrameworkId.value) return;
  saving.value = true;
  try {
    await apiRequest('/api/reports/monthly', writeInit('POST', { frameworkId: selectedFrameworkId.value, businessMonth: reportMonth.value, dataCutoffDate: asOfDate.value }));
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
    await apiRequest('/api/milestones', writeInit('POST', { businessYear: analysisYear.value, title, owner: milestoneForm.value.owner.trim() || null, projectId: null, datePrecision: precision, month, specificDate: specificDate || null, leadDays: [7, 3, 0] }));
    milestoneForm.value = { title: '', owner: '', datePrecision: 'unknown', month: null, specificDate: '' };
    milestones.value = (await apiRequest<{ items: MilestoneDueSummary[] }>(`/api/milestones/due?asOf=${asOfDate.value}`)).items; message.success('年度事项已创建');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '事项创建失败'); }
  finally { saving.value = false; }
}
async function setMilestoneStatus(item: MilestoneDueSummary, status: 'open' | 'completed') {
  try {
    await apiRequest(`/api/milestones/${item.id}/status`, writeInit('PUT', { expectedVersion: item.version, status }));
    milestones.value = (await apiRequest<{ items: MilestoneDueSummary[] }>(`/api/milestones/due?asOf=${asOfDate.value}`)).items;
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '事项状态更新失败'); }
}
async function createContact() {
  const address = contactForm.value.address.trim(); if (!address) return;
  try {
    await apiRequest('/api/notification-contacts', writeInit('POST', { memberId: contactForm.value.memberId, address, verified: true, enabled: true }));
    contacts.value = (await apiRequest<{ items: NotificationContactSummary[] }>('/api/notification-contacts')).items; contactForm.value.address = ''; message.success('通知地址已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '通知地址保存失败'); }
}
async function createBackup() {
  saving.value = true;
  try {
    await apiRequest('/api/backups', writeInit('POST', { backupDate: businessToday(), kind: 'daily' }));
    backups.value = (await apiRequest<{ items: BackupSummary[] }>('/api/backups')).items; message.success('备份任务已创建');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '备份创建失败'); }
  finally { saving.value = false; }
}
async function stepBackup(item: BackupSummary) {
  try { await apiRequest(`/api/backups/${item.id}/step`, writeInit('POST', {})); backups.value = (await apiRequest<{ items: BackupSummary[] }>('/api/backups')).items; }
  catch (cause) { message.error(cause instanceof Error ? cause.message : '备份推进失败'); }
}
async function verifyBackup(item: BackupSummary) {
  try { await apiRequest(`/api/backups/${item.id}/verify`, writeInit('POST', {})); backups.value = (await apiRequest<{ items: BackupSummary[] }>('/api/backups')).items; }
  catch (cause) { message.error(cause instanceof Error ? cause.message : '备份校验失败'); }
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
      series: [{ type: 'bar', data: (reserve.value?.categories ?? []).map((item) => item.knownRemainingFen) }],
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
    <n-card title="分析口径">
      <n-space align="end" wrap>
        <n-form-item label="统计日期"><n-input v-model:value="asOfDate" data-test="analysis-as-of" @change="changeAsOf" /></n-form-item>
        <n-form-item label="框架"><n-select :value="selectedFrameworkId" :options="frameworkOptions" data-test="analysis-framework" @update:value="selectFramework" /></n-form-item>
        <n-button @click="refresh">刷新</n-button>
      </n-space>
    </n-card>

    <n-spin :show="loading">
      <n-grid :cols="4" :x-gap="16" :y-gap="16" responsive="screen">
        <n-grid-item><n-card><n-statistic label="同期计划" :value="formatMoney(progress?.plannedToDateFen)" /></n-card></n-grid-item>
        <n-grid-item><n-card><n-statistic label="预算发生" :value="formatMoney(progress?.actualToDateFen)" /></n-card></n-grid-item>
        <n-grid-item><n-card><n-statistic label="同期达成率" :value="formatPercent(progress?.attainmentBasisPoints)" /></n-card></n-grid-item>
        <n-grid-item><n-card><n-statistic label="活动预警" :value="alerts.filter((item) => item.state === 'active').length" /></n-card></n-grid-item>
      </n-grid>

      <n-alert v-if="progress?.lagging" type="warning" :bordered="false">{{ progress.frameworkName }} 当前低于规则要求；规则为 {{ progress.rule.mode === 'ratio' ? '同期计划达成率' : '年度目标落后百分点' }} {{ formatPercent(progress.rule.thresholdBasisPoints) }}。</n-alert>

      <n-tabs type="line" animated>
        <n-tab-pane name="progress" tab="进度与缺口">
          <n-grid :cols="2" :x-gap="16" responsive="screen">
            <n-grid-item><n-card title="计划与实际"><div ref="progressChartEl" class="chart"></div></n-card></n-grid-item>
            <n-grid-item><n-card title="季度节点"><n-space vertical><div v-for="quarter in progress?.quarters ?? []" :key="quarter.quarter">Q{{ quarter.quarter }} · 累计目标 {{ formatPercent(quarter.cumulativeTargetBasisPoints) }} · {{ quarter.status }}</div></n-space></n-card></n-grid-item>
          </n-grid>
          <n-card title="子项目同期缺口" class="section-card"><n-data-table v-if="gaps.length" :columns="gapColumns" :data="gaps" :pagination="false" /><n-empty v-else description="暂无项目缺口数据" /></n-card>

          <n-card v-if="canPlan" title="月计划维护" class="section-card">
            <n-space align="end" wrap>
              <n-form-item label="子项目"><n-select v-model:value="planProjectId" data-test="plan-project" :options="planProjectOptions" /></n-form-item>
              <n-form-item label="月份"><n-select v-model:value="planMonth" data-test="plan-month" :options="monthOptions" /></n-form-item>
              <n-form-item label="目标金额（元）"><n-input v-model:value="planAmountYuan" data-test="plan-amount" /></n-form-item>
              <n-button type="primary" data-test="save-plan" :loading="saving" @click="savePlan">保存月计划</n-button>
            </n-space>
          </n-card>
          <n-card v-if="isAdmin && rule" title="滞后规则" class="section-card">
            <n-space align="end" wrap>
              <n-form-item label="模式"><n-select v-model:value="ruleMode" :options="[{ label: '同期计划达成率', value: 'ratio' }, { label: '年度目标落后百分点', value: 'gap' }]" /></n-form-item>
              <n-form-item label="阈值（%）"><n-input v-model:value="ruleThresholdPercent" data-test="rule-threshold" /></n-form-item>
              <n-button data-test="save-rule" :loading="saving" @click="saveRule">更新规则</n-button>
            </n-space>
          </n-card>
          <n-card v-if="canPlan" title="月报快照" class="section-card">
            <n-space align="end" wrap><n-form-item label="业务月份"><n-input v-model:value="reportMonth" /></n-form-item><n-button @click="generateReport">生成新修订</n-button></n-space>
            <div v-if="reports.length" class="report-history"><span v-for="item in reports" :key="item.id">{{ item.businessMonth }} · 修订 {{ item.revision }} · 规则 v{{ item.ruleVersion }}</span></div>
            <n-empty v-else description="当前月份尚无报告快照" />
          </n-card>
        </n-tab-pane>

        <n-tab-pane name="reserve" tab="储备剩余">
          <n-grid :cols="3" :x-gap="16" responsive="screen">
            <n-grid-item><n-card><n-statistic label="当前已分配数量" :value="formatQuantity(reserve?.allocatedQuantityScaled ?? 0)" /></n-card></n-grid-item>
            <n-grid-item><n-card><n-statistic label="已出库数量" :value="formatQuantity(reserve?.releasedQuantityScaled ?? 0)" /></n-card></n-grid-item>
            <n-grid-item><n-card><n-statistic label="已知剩余金额" :value="formatMoney(reserve?.knownRemainingFen)" /></n-card></n-grid-item>
          </n-grid>
          <n-alert v-if="reserve && (reserve.missingPriceCount || reserve.unclassifiedRemainingFen || reserve.unscopedCommonCostFen)" type="warning" :bordered="false">缺价 {{ reserve.missingPriceCount }} 项；未分类剩余 {{ formatMoney(reserve.unclassifiedRemainingFen) }}；施工/其他共同费用 {{ formatMoney(reserve.unscopedCommonCostFen) }}。共同费用未按数量强行摊入分类。</n-alert>
          <n-card title="按储备大类的现状剩余" class="section-card"><div ref="reserveChartEl" class="chart"></div><div class="category-list"><n-tag v-for="item in reserve?.categories ?? []" :key="item.reserveCategoryId" :bordered="false">{{ item.label }} {{ formatMoney(item.knownRemainingFen) }}</n-tag></div></n-card>
        </n-tab-pane>

        <n-tab-pane name="milestones" tab="年度事项">
          <n-card v-if="canPlan" title="新增事项">
            <n-space align="end" wrap>
              <n-form-item label="事项"><n-input v-model:value="milestoneForm.title" /></n-form-item>
              <n-form-item label="负责人"><n-input v-model:value="milestoneForm.owner" /></n-form-item>
              <n-form-item label="日期精度"><n-select v-model:value="milestoneForm.datePrecision" :options="[{ label: '具体日期', value: 'day' }, { label: '仅月份', value: 'month' }, { label: '待补充', value: 'unknown' }]" /></n-form-item>
              <n-form-item v-if="milestoneForm.datePrecision !== 'unknown'" label="月份"><n-select v-model:value="milestoneForm.month" :options="monthOptions" /></n-form-item>
              <n-form-item v-if="milestoneForm.datePrecision === 'day'" label="日期"><n-input v-model:value="milestoneForm.specificDate" /></n-form-item>
              <n-button @click="createMilestone">新增事项</n-button>
            </n-space>
          </n-card>
          <n-card title="事项清单" class="section-card"><n-data-table v-if="milestones.length" :columns="milestoneColumns" :data="milestones" :pagination="false" /><n-empty v-else description="暂无年度事项" /></n-card>
        </n-tab-pane>

        <n-tab-pane name="alerts" tab="预警与通知">
          <n-card title="预警事件"><n-data-table v-if="alerts.length" :columns="alertColumns" :data="alerts" :pagination="false" /><n-empty v-else description="暂无预警" /></n-card>
          <template v-if="isAdmin">
            <n-card title="通知地址" class="section-card">
              <n-space align="end" wrap><n-form-item label="成员 ID"><n-input v-model:value="contactForm.memberId" /></n-form-item><n-form-item label="邮件地址"><n-input v-model:value="contactForm.address" /></n-form-item><n-button @click="createContact">保存已验证地址</n-button></n-space>
              <div v-if="contacts.length" class="compact-list"><span v-for="item in contacts" :key="item.id">{{ item.address }} · {{ item.verifiedAt ? '已验证' : '未验证' }}</span></div>
            </n-card>
            <n-card title="通知 Outbox" class="section-card"><div class="compact-list"><span v-for="item in outbox" :key="item.id">{{ item.recipient }} · {{ item.status }} · 尝试 {{ item.attemptCount }}</span><n-empty v-if="!outbox.length" description="暂无待发通知" /></div></n-card>
          </template>
        </n-tab-pane>

        <n-tab-pane v-if="isAdmin" name="ops" tab="备份运维">
          <n-card title="D1 → R2 逻辑备份">
            <template #header-extra><n-button data-test="create-backup" :loading="saving" @click="createBackup">创建今日备份</n-button></template>
            <n-alert type="info" :bordered="false">备份按表分片、可续跑并保存 SHA-256；附件以 R2 key 清单进入 manifest。正式 D1 恢复演练仍需独立恢复环境，不能在当前在线库上直接覆盖。</n-alert>
            <n-data-table v-if="backups.length" :columns="backupColumns" :data="backups" :pagination="false" />
            <n-empty v-else description="暂无备份记录" />
          </n-card>
        </n-tab-pane>
      </n-tabs>
    </n-spin>
  </div>
</template>

<style scoped>
.analysis-view { min-width: 0; }
.section-card { margin-top: 16px; }
.chart { width: 100%; height: 280px; }
.category-list, .compact-list, .report-history { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 12px; }
.compact-list { flex-direction: column; }
@media (max-width: 700px) { .chart { height: 230px; } }
</style>
