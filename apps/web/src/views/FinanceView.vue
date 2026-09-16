<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  NAlert,
  NButton,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NSpace,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui';
import { apiRequest, jsonRequestInit } from '../api/client';
import type {
  AgreementSummary,
  CurrentUser,
  FinanceProjectSummary,
  FinancialEntryPage,
  FinancialEntrySummary,
  FinancialEntryType,
  FrameworkFinanceSummary,
  FrameworkSummary,
  ProjectBudgetSummary,
} from '@tpm/shared';

const props = defineProps<{ currentUser: CurrentUser }>();
const route = useRoute();
const message = useMessage();
const canManageStructure = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');
const canFinanceWrite = computed(() => ['admin', 'project_manager', 'finance'].includes(props.currentUser.role));

const loading = ref(true);
const error = ref('');
const frameworks = ref<FrameworkSummary[]>([]);
const projects = ref<FinanceProjectSummary[]>([]);
const agreements = ref<AgreementSummary[]>([]);
const budgets = ref<ProjectBudgetSummary[]>([]);
const entries = ref<FinancialEntrySummary[]>([]);
const entryCursor = ref<string | null>(null);
const summary = ref<FrameworkFinanceSummary | null>(null);
const selectedFrameworkId = ref<string | null>(null);
const selectedBudgetProjectId = ref<string | null>(null);

const frameworkForm = ref({ code: '', name: '', totalYuan: '', annualTargetYuan: '', startDate: '', endDate: '' });
const agreementForm = ref({ code: '', name: '', amountYuan: '', validFrom: '', validTo: '', status: 'active' as const });
const budgetTotalYuan = ref('');
const budgetNote = ref('');
const budgetSplits = ref<Array<{ agreementId: string | null; amountYuan: string }>>([{ agreementId: null, amountYuan: '' }]);
const entryType = ref<FinancialEntryType>('budget_occurrence');
const entryProjectId = ref<string | null>(null);
const entryAmountYuan = ref('');
const entryBusinessDate = ref('');
const entryNote = ref('');
const entrySplits = ref<Array<{ agreementId: string | null; amountYuan: string }>>([{ agreementId: null, amountYuan: '' }]);
const bindingProjectId = ref<string | null>(null);
const bindingFrameworkId = ref<string | null>(null);
const metric = ref<'budget' | 'occurrence' | 'actual'>('occurrence');
const saving = ref(false);
const showFrameworkForm = ref(false);
const showAgreementForm = ref(false);
const showEntryForm = ref(false);

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

function formatMoney(value: number) {
  return `${(value / 100).toFixed(2)} 元`;
}
function formatPercent(value: number | null) {
  return value === null ? '未配置' : `${(value / 100).toFixed(2)}%`;
}

const frameworkOptions = computed(() => frameworks.value.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id })));
const projectOptions = computed(() => projects.value.map((item) => ({ label: `${item.name}${item.frameworkId ? '' : '（未绑定框架）'}`, value: item.id })));
const agreementOptions = computed(() => agreements.value.filter((item) => item.status === 'active').map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id })));
const currentBudget = computed(() => budgets.value[0] ?? null);
const selectedFramework = computed(() => frameworks.value.find((item) => item.id === selectedFrameworkId.value) ?? null);

async function loadBase() {
  const [fw, projectData] = await Promise.all([
    apiRequest<{ items: FrameworkSummary[] }>('/api/frameworks'),
    apiRequest<{ items: FinanceProjectSummary[] }>('/api/finance/projects'),
  ]);
  frameworks.value = fw.items;
  projects.value = projectData.items;
  if (!selectedFrameworkId.value && fw.items[0]) selectedFrameworkId.value = fw.items[0].id;
}

async function loadFrameworkContext() {
  const frameworkId = selectedFrameworkId.value;
  if (!frameworkId) {
    agreements.value = [];
    summary.value = null;
    entries.value = [];
    entryCursor.value = null;
    return;
  }
  const [agreementData, summaryData, entryData] = await Promise.all([
    apiRequest<{ items: AgreementSummary[] }>(`/api/agreements?frameworkId=${encodeURIComponent(frameworkId)}`),
    apiRequest<FrameworkFinanceSummary>(`/api/finance/summary?frameworkId=${encodeURIComponent(frameworkId)}&asOf=${businessToday()}`),
    apiRequest<FinancialEntryPage>(`/api/financial-entries?frameworkId=${encodeURIComponent(frameworkId)}&limit=50`),
  ]);
  agreements.value = agreementData.items;
  summary.value = summaryData;
  entries.value = entryData.items;
  entryCursor.value = entryData.nextCursor;
}

async function loadMoreEntries() {
  const frameworkId = selectedFrameworkId.value;
  const cursor = entryCursor.value;
  if (!frameworkId || !cursor) return;
  try {
    const data = await apiRequest<FinancialEntryPage>(`/api/financial-entries?frameworkId=${encodeURIComponent(frameworkId)}&limit=50&cursor=${encodeURIComponent(cursor)}`);
    const known = new Set(entries.value.map((item) => item.id));
    entries.value = [...entries.value, ...data.items.filter((item) => !known.has(item.id))];
    entryCursor.value = data.nextCursor;
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '加载更多资金流水失败');
  }
}

async function loadBudgetProject(projectId: string | null) {
  selectedBudgetProjectId.value = projectId;
  budgets.value = [];
  budgetTotalYuan.value = '';
  budgetNote.value = '';
  budgetSplits.value = [{ agreementId: null, amountYuan: '' }];
  if (!projectId) return;
  const project = projects.value.find((item) => item.id === projectId);
  if (project?.frameworkId && project.frameworkId !== selectedFrameworkId.value) {
    selectedFrameworkId.value = project.frameworkId;
    await loadFrameworkContext();
  }
  const data = await apiRequest<{ items: ProjectBudgetSummary[] }>(`/api/budgets?projectId=${encodeURIComponent(projectId)}`);
  budgets.value = data.items;
  const budget = data.items[0];
  if (budget) {
    budgetTotalYuan.value = (budget.totalAmountFen / 100).toFixed(2);
    budgetNote.value = budget.note ?? '';
    budgetSplits.value = budget.allocations.length
      ? budget.allocations.map((item) => ({ agreementId: item.agreementId, amountYuan: (item.amountFen / 100).toFixed(2) }))
      : [{ agreementId: null, amountYuan: '' }];
  }
}

async function loadInitial() {
  loading.value = true;
  error.value = '';
  try {
    const year = businessToday().slice(0, 4);
    frameworkForm.value.startDate = `${year}-01-01`;
    frameworkForm.value.endDate = `${year}-12-31`;
    agreementForm.value.validFrom = `${year}-01-01`;
    agreementForm.value.validTo = `${year}-12-31`;
    entryBusinessDate.value = businessToday();
    await loadBase();
    await loadFrameworkContext();
    const routeProjectId = typeof route.query.projectId === 'string' ? route.query.projectId : null;
    if (routeProjectId && projects.value.some((item) => item.id === routeProjectId)) await loadBudgetProject(routeProjectId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取资金数据失败';
  } finally {
    loading.value = false;
  }
}

async function selectFramework(value: string | null) {
  selectedFrameworkId.value = value;
  bindingFrameworkId.value = value;
  await loadFrameworkContext();
}

async function createFramework() {
  const totalAmountFen = parseMoneyFen(frameworkForm.value.totalYuan);
  const annualTargetFen = frameworkForm.value.annualTargetYuan.trim() ? parseMoneyFen(frameworkForm.value.annualTargetYuan) : null;
  if (!frameworkForm.value.code.trim() || !frameworkForm.value.name.trim() || totalAmountFen === null || (frameworkForm.value.annualTargetYuan.trim() && annualTargetFen === null)) {
    message.warning('请填写有效的框架编号、名称和金额'); return;
  }
  saving.value = true;
  try {
    await apiRequest('/api/frameworks', jsonRequestInit('POST', {
      code: frameworkForm.value.code.trim(), name: frameworkForm.value.name.trim(), totalAmountFen, annualTargetFen,
      startDate: frameworkForm.value.startDate, endDate: frameworkForm.value.endDate,
    }));
    frameworkForm.value.code = ''; frameworkForm.value.name = ''; frameworkForm.value.totalYuan = ''; frameworkForm.value.annualTargetYuan = '';
    showFrameworkForm.value = false;
    await loadBase(); await loadFrameworkContext(); message.success('框架已创建');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '框架创建失败'); }
  finally { saving.value = false; }
}

async function createAgreement() {
  const frameworkId = selectedFrameworkId.value, amountFen = parseMoneyFen(agreementForm.value.amountYuan);
  if (!frameworkId || !agreementForm.value.code.trim() || !agreementForm.value.name.trim() || amountFen === null) { message.warning('请完整填写协议信息'); return; }
  saving.value = true;
  try {
    await apiRequest('/api/agreements', jsonRequestInit('POST', {
      frameworkId, code: agreementForm.value.code.trim(), name: agreementForm.value.name.trim(), amountFen,
      validFrom: agreementForm.value.validFrom, validTo: agreementForm.value.validTo, status: agreementForm.value.status,
    }));
    agreementForm.value.code = ''; agreementForm.value.name = ''; agreementForm.value.amountYuan = '';
    showAgreementForm.value = false;
    await loadFrameworkContext(); message.success('执行协议已创建');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '协议创建失败'); }
  finally { saving.value = false; }
}

async function bindProject() {
  const project = projects.value.find((item) => item.id === bindingProjectId.value);
  if (!project || !bindingFrameworkId.value) { message.warning('请选择项目和框架'); return; }
  saving.value = true;
  try {
    await apiRequest(`/api/projects/${project.id}/framework`, jsonRequestInit('PUT', { expectedVersion: project.version, frameworkId: bindingFrameworkId.value }));
    await loadBase(); message.success('项目框架归属已更新');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '项目绑定失败'); }
  finally { saving.value = false; }
}

function addBudgetSplit() { budgetSplits.value.push({ agreementId: null, amountYuan: '' }); }
function removeBudgetSplit(index: number) { budgetSplits.value.splice(index, 1); if (!budgetSplits.value.length) addBudgetSplit(); }

async function saveBudget() {
  const projectId = selectedBudgetProjectId.value, totalAmountFen = parseMoneyFen(budgetTotalYuan.value);
  if (!projectId || totalAmountFen === null) { message.warning('请选择项目并填写预算金额'); return; }
  const allocations = budgetSplits.value.map((split) => ({ agreementId: split.agreementId ?? '', amountFen: parseMoneyFen(split.amountYuan) }));
  if (allocations.some((item) => !item.agreementId || item.amountFen === null)) { message.warning('协议分配需完整填写'); return; }
  const payload = { projectId, totalAmountFen, note: budgetNote.value.trim() || null, allocations: allocations.map((item) => ({ agreementId: item.agreementId, amountFen: item.amountFen! })) };
  saving.value = true;
  try {
    if (currentBudget.value) {
      const { projectId: _ignored, ...update } = payload;
      await apiRequest(`/api/budgets/${currentBudget.value.id}`, jsonRequestInit('PUT', { expectedVersion: currentBudget.value.version, ...update }));
    } else {
      await apiRequest('/api/budgets', jsonRequestInit('POST', payload));
    }
    await loadBudgetProject(projectId); await loadFrameworkContext(); message.success('预算草稿已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '预算保存失败'); }
  finally { saving.value = false; }
}

async function confirmBudget() {
  const budget = currentBudget.value; if (!budget) return;
  saving.value = true;
  try {
    await apiRequest(`/api/budgets/${budget.id}/confirm`, jsonRequestInit('POST', { expectedVersion: budget.version }));
    await loadBudgetProject(budget.projectId); await loadFrameworkContext(); message.success('预算已确认；不会自动生成预算发生流水');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '预算确认失败'); }
  finally { saving.value = false; }
}

function addEntrySplit() { entrySplits.value.push({ agreementId: null, amountYuan: '' }); }
function removeEntrySplit(index: number) { entrySplits.value.splice(index, 1); if (!entrySplits.value.length) addEntrySplit(); }

async function postEntry() {
  const amountFen = parseMoneyFen(entryAmountYuan.value), project = projects.value.find((item) => item.id === entryProjectId.value);
  if (!project || amountFen === null || !entryBusinessDate.value) { message.warning('请选择项目并填写有效金额和日期'); return; }
  const allocations = entrySplits.value.map((split) => ({ agreementId: split.agreementId ?? '', amountFen: parseMoneyFen(split.amountYuan) }));
  if (allocations.some((item) => !item.agreementId || item.amountFen === null)) { message.warning('流水协议分配需完整填写'); return; }
  saving.value = true;
  try {
    await apiRequest('/api/financial-entries', jsonRequestInit('POST', {
      type: entryType.value, projectId: project.id, amountFen, businessDate: entryBusinessDate.value, note: entryNote.value.trim() || null,
      allocations: allocations.map((item) => ({ agreementId: item.agreementId, amountFen: item.amountFen! })),
    }));
    entryAmountYuan.value = ''; entryNote.value = ''; entrySplits.value = [{ agreementId: null, amountYuan: '' }];
    showEntryForm.value = false;
    if (project.frameworkId && project.frameworkId !== selectedFrameworkId.value) selectedFrameworkId.value = project.frameworkId;
    await loadFrameworkContext(); message.success('资金流水已登记');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '流水登记失败'); }
  finally { saving.value = false; }
}

const frameworkColumns = [
  { title: '编号', key: 'code', width: 130 }, { title: '框架名称', key: 'name', minWidth: 180 },
  { title: '总额', key: 'totalAmountFen', width: 140, render: (row: FrameworkSummary) => formatMoney(row.totalAmountFen) },
  { title: '年度目标', key: 'annualTargetFen', width: 140, render: (row: FrameworkSummary) => row.annualTargetFen === null ? '默认框架总额' : formatMoney(row.annualTargetFen) },
];
const agreementColumns = [
  { title: '协议编号', key: 'code', width: 130 }, { title: '名称', key: 'name', minWidth: 160 },
  { title: '额度', key: 'amountFen', width: 130, render: (row: AgreementSummary) => formatMoney(row.amountFen) },
  { title: '状态', key: 'status', width: 90, render: (row: AgreementSummary) => h(NTag, { size: 'small', type: row.status === 'active' ? 'success' : 'warning', bordered: false }, { default: () => row.status }) },
];
const entryColumns = [
  { title: '业务日', key: 'businessDate', width: 120 },
  { title: '类型', key: 'type', width: 110, render: (row: FinancialEntrySummary) => row.type === 'budget_occurrence' ? '预算发生' : '实际发生' },
  { title: '项目', key: 'projectName', minWidth: 160 },
  { title: '金额', key: 'amountFen', width: 130, render: (row: FinancialEntrySummary) => formatMoney(row.amountFen) },
];

onMounted(loadInitial);
</script>

<template>
  <n-spin :show="loading">
    <div class="view-stack finance-view">
      <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>

      <header class="page-header">
        <div class="page-header-copy">
          <span class="page-eyebrow">FINANCE</span>
          <h2 class="page-title">资金管理</h2>
          <p class="page-description">框架额度、预算确认、预算发生和实际发生保持独立账目，先看状态，再按需登记。</p>
        </div>
      </header>

      <section class="finance-overview">
        <div class="finance-context">
          <n-select :value="selectedFrameworkId" :options="frameworkOptions" placeholder="选择框架" @update:value="selectFramework" />
          <n-select v-model:value="metric" :options="[
            { label: '预算确认占用', value: 'budget' },
            { label: '预算发生', value: 'occurrence' },
            { label: '实际发生', value: 'actual' },
          ]" />
          <span class="finance-context-note">预算与发生分账，不自动互转</span>
        </div>
        <div v-if="summary" class="metrics">
          <div><span>框架总额</span><strong>{{ formatMoney(summary.framework.totalAmountFen) }}</strong></div>
          <div><span>预算确认占用</span><strong>{{ formatMoney(summary.confirmedBudgetFen) }}</strong></div>
          <div><span>预算发生</span><strong>{{ formatMoney(summary.budgetOccurrenceFen) }}</strong></div>
          <div><span>实际发生</span><strong>{{ formatMoney(summary.actualCostFen) }}</strong></div>
          <div><span>框架使用率</span><strong>{{ formatPercent(summary.frameworkUsageBasisPoints) }}</strong><n-tag v-if="summary.frameworkUsageWarning" type="warning" :bordered="false">≥80% 预警</n-tag></div>
          <div><span>年度进度</span><strong>{{ formatPercent(summary.annualProgressBasisPoints) }}</strong></div>
          <div><span>协议预支额度</span><strong>{{ formatMoney(summary.agreementReservedFen) }}</strong></div>
          <div><span>预算超框架</span><strong>{{ summary.budgetOverFrameworkWarning ? '是' : '否' }}</strong></div>
        </div>
        <div v-if="summary?.agreements.length" class="agreement-metrics">
          <div v-for="item in summary.agreements" :key="item.id" class="metric-row">
            <strong>{{ item.name }}</strong><span>{{ item.code }}</span><span>预算发生 {{ formatMoney(item.budgetOccurrenceFen) }}</span>
            <span>使用率 {{ formatPercent(item.usageBasisPoints) }}</span><n-tag v-if="item.usageWarning" type="warning" :bordered="false">≥90%</n-tag>
          </div>
        </div>
      </section>

      <n-tabs type="line" animated class="workspace-tabs">
        <n-tab-pane name="frameworks" tab="框架与协议">
          <section class="workspace-panel">
            <header class="workspace-panel-header">
              <div><h3>框架</h3><p>先选择当前业务框架，再查看协议和额度使用情况。</p></div>
              <n-button v-if="canManageStructure" data-test="open-framework-form" secondary @click="showFrameworkForm = !showFrameworkForm">
                {{ showFrameworkForm ? '收起' : '新建框架' }}
              </n-button>
            </header>
            <div class="workspace-panel-body data-panel-body">
              <n-data-table v-if="frameworks.length" :columns="frameworkColumns" :data="frameworks" :pagination="false" :scroll-x="650" />
              <n-empty v-else description="暂无框架。" />
            </div>
            <n-form v-if="canManageStructure && showFrameworkForm" class="form-grid edit-surface" label-placement="top">
              <n-form-item label="框架编号"><n-input v-model:value="frameworkForm.code" data-test="framework-code" /></n-form-item>
              <n-form-item label="框架名称"><n-input v-model:value="frameworkForm.name" data-test="framework-name" /></n-form-item>
              <n-form-item label="框架总额（元）"><n-input v-model:value="frameworkForm.totalYuan" data-test="framework-total" /></n-form-item>
              <n-form-item label="年度目标（元，可空）"><n-input v-model:value="frameworkForm.annualTargetYuan" /></n-form-item>
              <n-form-item label="开始日期"><n-input v-model:value="frameworkForm.startDate" /></n-form-item>
              <n-form-item label="结束日期"><n-input v-model:value="frameworkForm.endDate" /></n-form-item>
              <n-form-item><n-button data-test="create-framework" type="primary" :loading="saving" @click="createFramework">新增框架</n-button></n-form-item>
            </n-form>
          </section>

          <section v-if="selectedFramework" class="workspace-panel detail-panel">
            <header class="workspace-panel-header">
              <div><h3>执行协议</h3><p>{{ selectedFramework.name }} 下的预支额度和有效期。</p></div>
              <n-button v-if="canManageStructure" secondary @click="showAgreementForm = !showAgreementForm">
                {{ showAgreementForm ? '收起' : '新增协议' }}
              </n-button>
            </header>
            <div class="workspace-panel-body data-panel-body">
              <n-data-table v-if="agreements.length" :columns="agreementColumns" :data="agreements" :pagination="false" :scroll-x="650" />
              <n-empty v-else description="当前框架暂无执行协议。" />
            </div>
            <n-form v-if="canManageStructure && showAgreementForm" class="form-grid edit-surface" label-placement="top">
              <n-form-item label="协议编号"><n-input v-model:value="agreementForm.code" /></n-form-item>
              <n-form-item label="协议名称"><n-input v-model:value="agreementForm.name" /></n-form-item>
              <n-form-item label="协议额度（元）"><n-input v-model:value="agreementForm.amountYuan" /></n-form-item>
              <n-form-item label="有效期开始"><n-input v-model:value="agreementForm.validFrom" /></n-form-item>
              <n-form-item label="有效期结束"><n-input v-model:value="agreementForm.validTo" /></n-form-item>
              <n-form-item label="状态"><n-select v-model:value="agreementForm.status" :options="[{ label: '有效', value: 'active' }, { label: '暂停', value: 'paused' }, { label: '到期', value: 'expired' }]" /></n-form-item>
              <n-form-item><n-button type="primary" :loading="saving" @click="createAgreement">新增执行协议</n-button></n-form-item>
            </n-form>
          </section>
        </n-tab-pane>

        <n-tab-pane name="budgets" tab="子项目预算">
          <section class="workspace-panel">
            <header class="workspace-panel-header">
              <div><h3>子项目预算</h3><p>预算草稿允许不完整；确认时协议分配必须精确等于预算总额。</p></div>
            </header>
            <div v-if="canManageStructure" class="binding-toolbar">
              <span>项目框架归属</span>
              <n-select v-model:value="bindingProjectId" :options="projectOptions" placeholder="选择项目" />
              <n-select v-model:value="bindingFrameworkId" :options="frameworkOptions" placeholder="选择框架" />
              <n-button :loading="saving" @click="bindProject">保存归属</n-button>
            </div>
            <div class="workspace-panel-body budget-body">
              <n-alert type="info" :bordered="false">确认预算时协议必须与项目属于同一框架并在有效期内；预算确认占用不会自动生成预算发生。</n-alert>
              <n-form class="budget-form" label-placement="top">
              <n-form-item label="子项目"><n-select data-test="budget-project" :value="selectedBudgetProjectId" :options="projectOptions" @update:value="loadBudgetProject" /></n-form-item>
              <n-form-item label="预算总额（元）"><n-input v-model:value="budgetTotalYuan" data-test="budget-total" :disabled="!canFinanceWrite" /></n-form-item>
              <n-form-item label="说明"><n-input v-model:value="budgetNote" :disabled="!canFinanceWrite" /></n-form-item>
              </n-form>
              <div v-for="(split, index) in budgetSplits" :key="index" class="split-row">
                <n-select :data-test="`budget-agreement-${index}`" v-model:value="split.agreementId" :options="agreementOptions" :disabled="!canFinanceWrite" placeholder="执行协议" />
                <n-input :data-test="`budget-allocation-${index}`" v-model:value="split.amountYuan" :disabled="!canFinanceWrite" placeholder="分配金额（元）" />
                <n-button v-if="canFinanceWrite" @click="removeBudgetSplit(index)">删除</n-button>
              </div>
              <n-space v-if="canFinanceWrite" class="actions">
                <n-button data-test="add-budget-split" @click="addBudgetSplit">增加协议分配</n-button>
                <n-button data-test="save-budget" type="primary" :loading="saving" @click="saveBudget">保存预算草稿</n-button>
                <n-button v-if="currentBudget" type="success" :loading="saving" @click="confirmBudget">确认预算版本</n-button>
              </n-space>
              <div v-if="currentBudget" class="status-line">当前：{{ currentBudget.status === 'confirmed' ? `已确认 v${currentBudget.budgetVersion}` : '草稿' }}；对象版本 {{ currentBudget.version }}</div>
            </div>
          </section>
        </n-tab-pane>

        <n-tab-pane name="entries" tab="资金流水">
          <section class="workspace-panel">
            <header class="workspace-panel-header">
              <div><h3>当前框架流水</h3><p>预算发生和实际发生分账记录；列表按服务端游标完整翻页。</p></div>
              <n-button v-if="canFinanceWrite" data-test="open-entry-form" type="primary" @click="showEntryForm = !showEntryForm">
                {{ showEntryForm ? '收起登记' : '登记流水' }}
              </n-button>
            </header>
            <div class="workspace-panel-body data-panel-body">
              <n-data-table v-if="entries.length" :columns="entryColumns" :data="entries" :pagination="false" :scroll-x="650" />
              <n-empty v-else description="暂无资金流水。" />
              <div v-if="entryCursor" class="load-more">
                <n-button data-test="load-more-entries" @click="loadMoreEntries">加载更多流水</n-button>
              </div>
            </div>
          </section>
          <section v-if="showEntryForm && canFinanceWrite" class="workspace-panel detail-panel edit-panel">
            <header class="workspace-panel-header"><div><h3>登记预算发生 / 实际发生</h3><p>该操作新增不可变资金事实；错误记录通过冲销留痕。</p></div></header>
            <div class="workspace-panel-body">
            <n-alert type="warning" :bordered="false">登记流水必须关联同框架、业务日期有效的执行协议。预算发生和实际发生是不同账目，不能相互代替。</n-alert>
            <n-form class="entry-form" label-placement="top">
              <n-form-item label="子项目"><n-select data-test="entry-project" v-model:value="entryProjectId" :options="projectOptions" /></n-form-item>
              <n-form-item label="流水类型"><n-select data-test="entry-type" v-model:value="entryType" :options="[{ label: '预算发生', value: 'budget_occurrence' }, { label: '实际发生', value: 'actual_cost' }]" /></n-form-item>
              <n-form-item label="金额（元）"><n-input data-test="entry-amount" v-model:value="entryAmountYuan" /></n-form-item>
              <n-form-item label="业务日期"><n-input data-test="entry-date" v-model:value="entryBusinessDate" /></n-form-item>
              <n-form-item label="说明"><n-input v-model:value="entryNote" /></n-form-item>
            </n-form>
            <div v-for="(split, index) in entrySplits" :key="index" class="split-row">
              <n-select :data-test="`entry-agreement-${index}`" v-model:value="split.agreementId" :options="agreementOptions" placeholder="执行协议" />
              <n-input :data-test="`entry-allocation-${index}`" v-model:value="split.amountYuan" placeholder="分配金额（元）" />
              <n-button @click="removeEntrySplit(index)">删除</n-button>
            </div>
            <n-space v-if="canFinanceWrite" class="actions">
              <n-button @click="addEntrySplit">增加协议分配</n-button>
              <n-button data-test="post-entry" type="primary" :loading="saving" @click="postEntry">登记流水</n-button>
            </n-space>
            </div>
          </section>
        </n-tab-pane>
      </n-tabs>
    </div>
  </n-spin>
</template>

<style scoped>
.finance-view { gap: 18px; max-width: 1420px; }
.finance-overview { overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.finance-context { display: grid; grid-template-columns: minmax(260px, 420px) minmax(180px, 260px) 1fr; gap: 10px; align-items: center; min-height: 64px; padding: 12px 16px; border-bottom: 1px solid var(--ui-border); }
.finance-context-note { justify-self: end; color: var(--ui-text-tertiary); font-size: 11px; }
.workspace-tabs :deep(.n-tabs-tab) { padding-inline: 2px; margin-right: 24px; font-size: 12px; }
.workspace-panel { overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.workspace-panel + .workspace-panel { margin-top: 16px; }
.workspace-panel-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 60px; padding: 13px 16px; border-bottom: 1px solid var(--ui-border); }
.workspace-panel-header h3 { margin: 0; font-size: 14px; font-weight: 680; }
.workspace-panel-header p { margin: 3px 0 0; color: var(--ui-text-secondary); font-size: 11px; line-height: 1.5; }
.workspace-panel-body { padding: 16px; }
.data-panel-body { padding: 0; }
.data-panel-body :deep(.n-data-table) { border: 0; border-radius: 0; }
.data-panel-body > .n-empty { padding: 30px 16px; }
.detail-panel { margin-top: 16px; }
.edit-panel { border-color: var(--ui-border-strong); }
.toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(180px, 320px) auto; gap: 10px; margin-top: 16px; align-items: center; }
.binding-toolbar { display: grid; grid-template-columns: auto minmax(220px, 1fr) minmax(180px, 320px) auto; gap: 10px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--ui-border); background: var(--ui-surface-subtle); }
.binding-toolbar > span { color: var(--ui-text-secondary); font-size: 11px; font-weight: 650; white-space: nowrap; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.metrics > div { display: grid; align-content: center; gap: 6px; min-height: 92px; padding: 16px 18px; border-right: 1px solid var(--ui-border); border-bottom: 1px solid var(--ui-border); background: var(--ui-surface); }
.metrics > div:nth-child(4n) { border-right: 0; }
.metrics > div:nth-last-child(-n+4) { border-bottom: 0; }
.metrics span { color: var(--ui-text-secondary); font-size: 11px; }
.metrics strong { color: var(--ui-text); font-size: 18px; font-weight: 690; font-variant-numeric: tabular-nums; }
.agreement-metrics { display: grid; padding: 0 16px 10px; border-top: 1px solid var(--ui-border); }
.metric-row { display: grid; grid-template-columns: minmax(140px, 1fr) 110px 160px 130px auto; gap: 10px; align-items: center; min-height: 48px; border-bottom: 1px solid var(--ui-border); color: var(--ui-text-secondary); font-size: 12px; }
.metric-row:last-child { border-bottom: 0; }
.metric-row strong { color: var(--ui-text); font-size: 12px; font-weight: 650; }
.form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0 12px; margin-top: 16px; align-items: end; }
.edit-surface { margin: 0; padding: 16px; border-top: 1px solid var(--ui-border); background: var(--ui-surface-subtle); }
.budget-body { display: grid; gap: 12px; }
.budget-form, .entry-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 12px; margin-top: 16px; }
.entry-form { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.split-row { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(150px, 240px) auto; gap: 10px; margin: 8px 0; }
.actions { margin-top: 12px; }
.status-line { margin-top: 12px; color: var(--ui-text-secondary); }
.load-more { display: flex; justify-content: center; padding: 14px 0 0; }
@media (max-width: 1000px) {
  .finance-context { grid-template-columns: minmax(220px, 1fr) minmax(180px, 240px); }
  .finance-context-note { display: none; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metrics > div:nth-child(4n) { border-right: 1px solid var(--ui-border); }
  .metrics > div:nth-child(2n) { border-right: 0; }
  .metrics > div:nth-last-child(-n+4) { border-bottom: 1px solid var(--ui-border); }
  .metrics > div:nth-last-child(-n+2) { border-bottom: 0; }
  .form-grid, .entry-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .binding-toolbar { grid-template-columns: 1fr 1fr auto; }
  .binding-toolbar > span { grid-column: 1 / -1; }
  .metric-row { grid-template-columns: 1fr 1fr; padding: 10px 0; }
}
@media (max-width: 700px) {
  .finance-context, .toolbar, .form-grid, .budget-form, .entry-form, .split-row, .binding-toolbar { grid-template-columns: 1fr; }
  .finance-context { align-items: stretch; }
  .workspace-panel-header { align-items: flex-start; }
  .workspace-panel-header .n-button { flex: 0 0 auto; }
  .binding-toolbar > span { grid-column: auto; }
  .metrics { grid-template-columns: 1fr 1fr; }
  .metrics > div { min-height: 82px; padding: 13px; }
  .metrics strong { font-size: 16px; }
  .metric-row { grid-template-columns: 1fr; gap: 4px; }
}
</style>
