<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
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
import { parseApiResponse } from '../api/response';
import type {
  ApiResponse,
  AttachmentSummary,
  CurrentUser,
  LifecycleState,
  ProjectExecutionSummary,
  ProjectReleaseSummary,
  ProjectTaskExecutionSummary,
  ReserveProjectSummary,
} from '@tpm/shared';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const canRelease = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');
const canImplement = computed(() => ['admin', 'project_manager', 'implementation'].includes(props.currentUser.role));
const canSettle = computed(() => ['admin', 'project_manager', 'finance'].includes(props.currentUser.role));
const canUpload = computed(() => ['admin', 'project_manager', 'implementation', 'finance'].includes(props.currentUser.role));

const loading = ref(true);
const saving = ref(false);
const error = ref('');
const projects = ref<ReserveProjectSummary[]>([]);
const selectedProjectId = ref<string | null>(null);
const project = ref<ReserveProjectSummary | null>(null);
const execution = ref<ProjectExecutionSummary | null>(null);
const releases = ref<ProjectReleaseSummary[]>([]);
const selectedTaskId = ref<string | null>(null);
const attachments = ref<AttachmentSummary[]>([]);

const releaseDate = ref('');
const releaseNote = ref('');
const taskForm = ref({ name: '', scopeText: '', owner: '', plannedDate: '', plannedQuantity: '', unit: '项' });
const taskDemandQuantities = ref<Record<string, string>>({});
const taskMaterialQuantities = ref<Record<string, string>>({});
const supplyForm = ref({ taskMaterialId: null as string | null, stage: 'reported' as 'reported' | 'shipped' | 'arrived', quantity: '', eventDate: '', note: '' });
const implementationDate = ref('');
const implementationScopeQuantities = ref<Record<string, string>>({});
const implementationMaterialUsages = ref<Record<string, string>>({});
const implementationNote = ref('');
const settlementDate = ref('');
const settlementAmount = ref('');
const settlementFinal = ref(false);
const settlementCoverage = ref<Record<string, string>>({});
const settlementNote = ref('');
const attachmentFile = ref<File | null>(null);

function businessToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseScaled(value: string, digits = 4): number | null {
  const raw = value.trim();
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const scale = 10n ** BigInt(digits);
  const scaled = BigInt(match[1]!) * scale + BigInt((match[2] ?? '').padEnd(digits, '0') || '0');
  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

function parseMoneyFen(value: string): number | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const fen = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return fen <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fen) : null;
}

function formatScaled(value: number, digits = 4) {
  const scale = 10 ** digits;
  const whole = Math.floor(value / scale);
  const fraction = String(value % scale).padStart(digits, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

const stateLabels: Record<LifecycleState, string> = {
  implemented_settled: '已实施已结算',
  implemented_unsettled: '已实施未结算',
  unimplemented_settled: '未实施已结算',
  unimplemented_unsettled: '未实施未结算',
};

function stateTagType(state: LifecycleState): 'success' | 'warning' | 'error' | 'info' {
  if (state === 'implemented_settled') return 'success';
  if (state === 'implemented_unsettled') return 'warning';
  if (state === 'unimplemented_settled') return 'info';
  return 'error';
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
  return result.data;
}

function writeInit(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) };
}

const projectOptions = computed(() => projects.value.map((item) => ({ label: `${item.name}${item.status === 'confirmed' ? ` · 储备v${item.reserveVersion}` : ' · 草稿'}`, value: item.id })));
const selectedTask = computed(() => execution.value?.tasks.find((item) => item.id === selectedTaskId.value) ?? null);
const taskOptions = computed(() => (execution.value?.tasks ?? []).map((item) => ({ label: `${item.name} · ${stateLabels[item.state]}`, value: item.id })));
const taskMaterialOptions = computed(() => (selectedTask.value?.materials ?? []).map((item) => ({ label: `${item.model} · ${formatScaled(item.requiredQuantityScaled)} ${item.unit}`, value: item.id })));
const supplyStageOptions = [
  { label: '已上报', value: 'reported' },
  { label: '已发货', value: 'shipped' },
  { label: '已到货', value: 'arrived' },
];

async function loadProjects() {
  const data = await apiRequest<{ items: ReserveProjectSummary[]; nextCursor: string | null }>('/api/reserve-projects?limit=100');
  projects.value = data.items;
  if (!selectedProjectId.value && data.items[0]) selectedProjectId.value = data.items[0].id;
}

function initializeTaskDrafts() {
  taskDemandQuantities.value = {};
  taskMaterialQuantities.value = {};
  if (!project.value) return;
  for (const link of project.value.demandLinks) taskDemandQuantities.value[link.demandId] = '';
  for (const material of project.value.materialRequirements) taskMaterialQuantities.value[material.id] = '';
}

function initializeSelectedTaskDrafts(task: ProjectTaskExecutionSummary | null) {
  implementationScopeQuantities.value = {};
  implementationMaterialUsages.value = {};
  settlementCoverage.value = {};
  supplyForm.value.taskMaterialId = task?.materials[0]?.id ?? null;
  if (!task) return;
  for (const scope of task.demandScopes) {
    const implemented = execution.value?.demands.find((item) => item.demandId === scope.demandId)?.implementedQuantityScaled ?? 0;
    void implemented;
    implementationScopeQuantities.value[scope.id] = '';
    settlementCoverage.value[scope.id] = '';
  }
  for (const material of task.materials) implementationMaterialUsages.value[material.id] = '';
}

async function loadProjectContext() {
  const id = selectedProjectId.value;
  if (!id) {
    project.value = null;
    execution.value = null;
    releases.value = [];
    return;
  }
  const [detail, executionData, releaseData] = await Promise.all([
    apiRequest<ReserveProjectSummary>(`/api/reserve-projects/${encodeURIComponent(id)}`),
    apiRequest<ProjectExecutionSummary>(`/api/projects/${encodeURIComponent(id)}/execution`),
    apiRequest<{ items: ProjectReleaseSummary[] }>(`/api/project-releases?projectId=${encodeURIComponent(id)}`),
  ]);
  project.value = detail;
  execution.value = executionData;
  releases.value = releaseData.items;
  if (!selectedTaskId.value || !executionData.tasks.some((item) => item.id === selectedTaskId.value)) selectedTaskId.value = executionData.tasks[0]?.id ?? null;
  initializeTaskDrafts();
  initializeSelectedTaskDrafts(executionData.tasks.find((item) => item.id === selectedTaskId.value) ?? null);
  if (canUpload.value) {
    try {
      attachments.value = (await apiRequest<{ items: AttachmentSummary[] }>(`/api/attachments?objectType=project&objectId=${encodeURIComponent(id)}`)).items;
    } catch { attachments.value = []; }
  }
}

async function refreshProject() {
  await loadProjects();
  await loadProjectContext();
}

async function loadInitial() {
  loading.value = true;
  error.value = '';
  const today = businessToday();
  releaseDate.value = today;
  taskForm.value.plannedDate = today;
  supplyForm.value.eventDate = today;
  implementationDate.value = today;
  settlementDate.value = today;
  try {
    await loadProjects();
    await loadProjectContext();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取项目执行数据失败';
  } finally { loading.value = false; }
}

async function selectProject(value: string | null) {
  selectedProjectId.value = value;
  selectedTaskId.value = null;
  await loadProjectContext();
}

function selectTask(value: string | null) {
  selectedTaskId.value = value;
  initializeSelectedTaskDrafts(execution.value?.tasks.find((item) => item.id === value) ?? null);
}

async function createProjectRelease() {
  if (!project.value) return;
  saving.value = true;
  try {
    await apiRequest<ProjectReleaseSummary>('/api/project-releases', writeInit('POST', {
      projectId: project.value.id,
      expectedProjectVersion: project.value.version,
      releaseDate: releaseDate.value,
      note: releaseNote.value.trim() || null,
    }));
    releaseNote.value = '';
    await refreshProject();
    message.success('项目已整体出库，正式进入执行阶段');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '项目级出库失败'); }
  finally { saving.value = false; }
}

async function createTask() {
  if (!project.value || !execution.value) return;
  const plannedQuantityScaled = parseScaled(taskForm.value.plannedQuantity);
  if (!taskForm.value.name.trim() || plannedQuantityScaled === null || plannedQuantityScaled <= 0 || !taskForm.value.unit.trim()) {
    message.warning('请填写任务名称、正数计划量和单位'); return;
  }
  const demandScopes = project.value.demandLinks.flatMap((link) => {
    const quantity = parseScaled(taskDemandQuantities.value[link.demandId] ?? '');
    return quantity !== null && quantity > 0 ? [{ demandId: link.demandId, quantityScaled: quantity }] : [];
  });
  if (demandScopes.reduce((sum, item) => sum + item.quantityScaled, 0) !== plannedQuantityScaled) {
    message.warning('任务需求范围数量合计必须等于任务计划量，才能准确回投四状态'); return;
  }
  const materials = project.value.materialRequirements.flatMap((item) => {
    const quantity = parseScaled(taskMaterialQuantities.value[item.id] ?? '');
    return quantity !== null && quantity > 0 ? [{ projectMaterialRequirementId: item.id, quantityScaled: quantity }] : [];
  });
  saving.value = true;
  try {
    const created = await apiRequest<ProjectTaskExecutionSummary>('/api/project-tasks', writeInit('POST', {
      projectId: project.value.id,
      expectedProjectVersion: execution.value.projectVersion,
      name: taskForm.value.name.trim(),
      description: null,
      scopeText: taskForm.value.scopeText.trim() || null,
      owner: taskForm.value.owner.trim() || null,
      plannedDate: taskForm.value.plannedDate || null,
      plannedQuantityScaled,
      unit: taskForm.value.unit.trim(),
      demandScopes,
      materials,
    }));
    selectedTaskId.value = created.id;
    taskForm.value.name = '';
    taskForm.value.scopeText = '';
    taskForm.value.plannedQuantity = '';
    await refreshProject();
    selectedTaskId.value = created.id;
    initializeSelectedTaskDrafts(execution.value?.tasks.find((item) => item.id === created.id) ?? null);
    message.success('执行任务已创建');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '执行任务创建失败'); }
  finally { saving.value = false; }
}

async function addSupplyEvent() {
  const task = selectedTask.value;
  const material = task?.materials.find((item) => item.id === supplyForm.value.taskMaterialId);
  const quantityScaled = parseScaled(supplyForm.value.quantity);
  if (!task || !material || quantityScaled === null || quantityScaled <= 0) { message.warning('请选择任务物资并填写正数数量'); return; }
  saving.value = true;
  try {
    await apiRequest('/api/task-material-supply-events', writeInit('POST', {
      taskMaterialRequirementId: material.id,
      expectedSupplyVersion: material.supplyVersion,
      stage: supplyForm.value.stage,
      quantityScaled,
      eventDate: supplyForm.value.eventDate,
      note: supplyForm.value.note.trim() || null,
    }));
    supplyForm.value.quantity = '';
    supplyForm.value.note = '';
    await loadProjectContext();
    message.success('物资供应进度已登记');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '物资供应登记失败'); }
  finally { saving.value = false; }
}

async function createImplementation() {
  const task = selectedTask.value;
  if (!task) return;
  const scopeLines = task.demandScopes.flatMap((scope) => {
    const quantity = parseScaled(implementationScopeQuantities.value[scope.id] ?? '');
    return quantity !== null && quantity > 0 ? [{ taskDemandScopeId: scope.id, completedQuantityScaled: quantity }] : [];
  });
  const completedQuantityScaled = scopeLines.reduce((sum, item) => sum + item.completedQuantityScaled, 0);
  if (!completedQuantityScaled) { message.warning('至少填写一条实施完成量'); return; }
  const materialUsages = task.materials.flatMap((material) => {
    const quantity = parseScaled(implementationMaterialUsages.value[material.id] ?? '');
    return quantity !== null && quantity >= 0 && (implementationMaterialUsages.value[material.id] ?? '').trim()
      ? [{ taskMaterialRequirementId: material.id, quantityScaled: quantity }]
      : [];
  });
  saving.value = true;
  try {
    await apiRequest('/api/task-implementations', writeInit('POST', {
      taskId: task.id,
      expectedImplementationVersion: task.implementationVersion,
      recordDate: implementationDate.value,
      completedQuantityScaled,
      scopeLines,
      materialUsages,
      note: implementationNote.value.trim() || null,
    }));
    implementationNote.value = '';
    await loadProjectContext();
    message.success('实施事实已保存，结算提醒已同步更新');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '实施记录保存失败'); }
  finally { saving.value = false; }
}

async function createSettlement() {
  const task = selectedTask.value;
  const amountFen = parseMoneyFen(settlementAmount.value);
  if (!task || amountFen === null) { message.warning('请填写有效结算金额'); return; }
  const coverage = task.demandScopes.flatMap((scope) => {
    const quantity = parseScaled(settlementCoverage.value[scope.id] ?? '');
    return quantity !== null && quantity > 0 ? [{ taskDemandScopeId: scope.id, quantityScaled: quantity }] : [];
  });
  const coverageQuantityScaled = coverage.reduce((sum, item) => sum + item.quantityScaled, 0);
  if (!coverageQuantityScaled) { message.warning('至少填写一条结算覆盖量'); return; }
  saving.value = true;
  try {
    await apiRequest('/api/task-settlements', writeInit('POST', {
      taskId: task.id,
      expectedSettlementVersion: task.settlementVersion,
      settlementDate: settlementDate.value,
      coverageQuantityScaled,
      amountFen,
      final: settlementFinal.value,
      note: settlementNote.value.trim() || null,
      coverage,
      agreementAllocations: [],
    }));
    settlementAmount.value = '';
    settlementNote.value = '';
    settlementFinal.value = false;
    await loadProjectContext();
    message.success('结算事实已保存；它与实施进度独立推进');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '结算保存失败'); }
  finally { saving.value = false; }
}

function attachmentChanged(event: Event) {
  attachmentFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function uploadAttachment() {
  const projectId = selectedProjectId.value;
  const file = attachmentFile.value;
  if (!projectId || !file) { message.warning('请选择附件'); return; }
  saving.value = true;
  try {
    const response = await fetch(`/api/attachments?objectType=project&objectId=${encodeURIComponent(projectId)}&fileName=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'Idempotency-Key': crypto.randomUUID() },
      body: file,
    });
    const result = await parseApiResponse<AttachmentSummary>(response);
    if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
    attachmentFile.value = null;
    attachments.value = (await apiRequest<{ items: AttachmentSummary[] }>(`/api/attachments?objectType=project&objectId=${encodeURIComponent(projectId)}`)).items;
    message.success('附件已上传');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '附件上传失败'); }
  finally { saving.value = false; }
}

const taskColumns = [
  { title: '任务', key: 'name', minWidth: 170 },
  { title: '计划量', key: 'plannedQuantityScaled', render: (row: ProjectTaskExecutionSummary) => `${formatScaled(row.plannedQuantityScaled)} ${row.unit}` },
  { title: '已实施', key: 'implementedQuantityScaled', render: (row: ProjectTaskExecutionSummary) => formatScaled(row.implementedQuantityScaled) },
  { title: '已结算', key: 'settledQuantityScaled', render: (row: ProjectTaskExecutionSummary) => formatScaled(row.settledQuantityScaled) },
  { title: '状态', key: 'state', render: (row: ProjectTaskExecutionSummary) => h(NTag, { size: 'small', bordered: false, type: stateTagType(row.state) }, { default: () => stateLabels[row.state] }) },
  { title: '操作', key: 'action', render: (row: ProjectTaskExecutionSummary) => h(NButton, { size: 'small', onClick: () => selectTask(row.id) }, { default: () => '进入任务' }) },
];

onMounted(loadInitial);
</script>

<template>
  <div class="view-stack delivery-view">
    <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>
    <n-card title="项目执行工作台">
      <n-form label-placement="top" class="project-selector">
        <n-form-item label="项目"><n-select :value="selectedProjectId" :options="projectOptions" @update:value="selectProject" /></n-form-item>
      </n-form>
      <n-alert type="info" :bordered="false">这里的“出库”是项目级业务状态转换，不是仓库发货。项目只出库一次；出库后可拆成多个执行任务，每个任务的物资供应、现场实施、结算三条线独立推进。</n-alert>
    </n-card>

    <n-spin :show="loading">
      <template v-if="project && execution">
        <n-card title="项目总览">
          <template #header-extra><n-tag :type="stateTagType(execution.projectState)" :bordered="false">{{ stateLabels[execution.projectState] }}</n-tag></template>
          <div class="status-grid">
            <div><span>项目版本</span><strong>v{{ execution.projectVersion }}</strong></div>
            <div><span>项目级出库</span><strong>{{ execution.released ? '已完成' : '未完成' }}</strong></div>
            <div><span>执行任务</span><strong>{{ execution.tasks.length }}</strong></div>
            <div><span>来源需求</span><strong>{{ execution.demands.length }}</strong></div>
          </div>
          <div v-if="execution.demands.length" class="demand-feedback">
            <div v-for="item in execution.demands" :key="item.demandId" class="feedback-row">
              <span>{{ item.sequenceNo }} · {{ item.lineName }} {{ item.section }}</span>
              <span>实施 {{ formatScaled(item.implementedQuantityScaled) }}/{{ formatScaled(item.plannedQuantityScaled) }}</span>
              <span>结算 {{ formatScaled(item.settledQuantityScaled) }}/{{ formatScaled(item.plannedQuantityScaled) }}</span>
              <n-tag :type="stateTagType(item.state)" size="small" :bordered="false">{{ stateLabels[item.state] }}</n-tag>
            </div>
          </div>
        </n-card>

        <n-tabs type="line" animated>
          <n-tab-pane name="release" tab="项目级出库">
            <n-card title="项目级出库">
              <n-alert type="warning" :bordered="false" class="section-note">必须先确认储备版本。出库会固化当前项目需求来源和项目物资快照；它不填写物资数量行，也不代表供应商已发货。</n-alert>
              <n-form v-if="canRelease && !execution.released" label-placement="top">
                <n-form-item label="出库日期"><n-input v-model:value="releaseDate" /></n-form-item>
                <n-form-item label="备注"><n-input v-model:value="releaseNote" /></n-form-item>
                <n-button data-test="create-project-release" type="primary" :loading="saving" @click="createProjectRelease">项目整体出库</n-button>
              </n-form>
              <n-alert v-else-if="execution.released" type="success" :bordered="false">该项目已完成项目级出库，可建立多个执行任务。</n-alert>
              <div v-for="item in releases" :key="item.id" class="snapshot-row">
                <strong>{{ item.releaseDate }}</strong><span>项目 v{{ item.projectVersionSnapshot }} / 储备 v{{ item.reserveVersionSnapshot }}</span><span>{{ item.snapshot.materialRequirements.length }} 条项目物资快照</span>
              </div>
            </n-card>
          </n-tab-pane>

          <n-tab-pane name="tasks" tab="执行任务">
            <n-card title="任务列表">
              <n-data-table v-if="execution.tasks.length" :columns="taskColumns" :data="execution.tasks" :pagination="false" :scroll-x="800" />
              <n-empty v-else description="项目出库后可建立第一条执行任务" />
            </n-card>
            <n-card v-if="canImplement && execution.released" title="新增执行任务" class="detail-card">
              <n-alert type="info" :bordered="false" class="section-note">一个项目可以拆成多个任务。需求范围决定任务实施/结算如何回投到原始需求；任务物资来自项目物资，不等同于需求物资。</n-alert>
              <n-form label-placement="top" class="task-form">
                <n-form-item label="任务名称"><n-input data-test="task-name" v-model:value="taskForm.name" /></n-form-item>
                <n-form-item label="现场范围"><n-input v-model:value="taskForm.scopeText" /></n-form-item>
                <n-form-item label="负责人"><n-input v-model:value="taskForm.owner" /></n-form-item>
                <n-form-item label="计划日期"><n-input v-model:value="taskForm.plannedDate" /></n-form-item>
                <n-form-item label="任务计划量"><n-input data-test="task-planned-quantity" v-model:value="taskForm.plannedQuantity" /></n-form-item>
                <n-form-item label="任务单位"><n-input v-model:value="taskForm.unit" /></n-form-item>
              </n-form>
              <strong>任务覆盖的需求范围</strong>
              <div v-for="link in project.demandLinks" :key="link.id" class="line-input-row"><span>{{ link.sequenceNo }} · {{ link.lineName }} {{ link.section }}</span><n-input :data-test="`task-demand-${link.demandId}`" :value="taskDemandQuantities[link.demandId] ?? ''" placeholder="本任务覆盖量" @update:value="(value: string) => { taskDemandQuantities[link.demandId] = value; }" /></div>
              <strong>任务所需项目物资</strong>
              <div v-for="material in project.materialRequirements" :key="material.id" class="line-input-row"><span>{{ material.model }} · 项目当前 {{ formatScaled(material.requiredQuantityScaled) }} {{ material.unit }}</span><n-input :data-test="`task-material-${material.id}`" :value="taskMaterialQuantities[material.id] ?? ''" placeholder="本任务物资量，可空" @update:value="(value: string) => { taskMaterialQuantities[material.id] = value; }" /></div>
              <n-button data-test="create-task" type="primary" :loading="saving" @click="createTask">创建执行任务</n-button>
            </n-card>
          </n-tab-pane>

          <n-tab-pane name="parallel" tab="任务三线并行">
            <n-card title="选择执行任务">
              <n-select data-test="task-select" :value="selectedTaskId" :options="taskOptions" placeholder="选择任务" @update:value="selectTask" />
            </n-card>
            <template v-if="selectedTask">
              <n-card title="任务状态" class="detail-card">
                <template #header-extra><n-tag :type="stateTagType(selectedTask.state)" :bordered="false">{{ stateLabels[selectedTask.state] }}</n-tag></template>
                <div class="status-grid">
                  <div><span>计划量</span><strong>{{ formatScaled(selectedTask.plannedQuantityScaled) }} {{ selectedTask.unit }}</strong></div>
                  <div><span>已实施</span><strong>{{ formatScaled(selectedTask.implementedQuantityScaled) }}</strong></div>
                  <div><span>已结算</span><strong>{{ formatScaled(selectedTask.settledQuantityScaled) }}</strong></div>
                  <div><span>结算提醒</span><strong>{{ selectedTask.settlementReminder.needed ? `${selectedTask.settlementReminder.dueDate} 前` : '无' }}</strong></div>
                </div>
              </n-card>

              <div class="parallel-grid">
                <n-card title="A. 物资供应">
                  <n-alert type="info" :bordered="false" class="section-note">累计必须满足：已到货 ≤ 已发货 ≤ 已上报 ≤ 任务物资需求。</n-alert>
                  <div v-for="item in selectedTask.supplyTotals" :key="item.taskMaterialRequirementId" class="supply-row">
                    <strong>{{ item.model }}</strong>
                    <span>上报 {{ formatScaled(item.totals.reportedQuantityScaled) }} / 发货 {{ formatScaled(item.totals.shippedQuantityScaled) }} / 到货 {{ formatScaled(item.totals.arrivedQuantityScaled) }} {{ item.unit }}</span>
                  </div>
                  <n-form v-if="canImplement && selectedTask.materials.length" label-placement="top">
                    <n-form-item label="任务物资"><n-select data-test="supply-material" v-model:value="supplyForm.taskMaterialId" :options="taskMaterialOptions" /></n-form-item>
                    <n-form-item label="阶段"><n-select data-test="supply-stage" v-model:value="supplyForm.stage" :options="supplyStageOptions" /></n-form-item>
                    <n-form-item label="数量"><n-input data-test="supply-quantity" v-model:value="supplyForm.quantity" /></n-form-item>
                    <n-form-item label="日期"><n-input v-model:value="supplyForm.eventDate" /></n-form-item>
                    <n-form-item label="备注"><n-input v-model:value="supplyForm.note" /></n-form-item>
                    <n-button data-test="create-supply-event" type="primary" :loading="saving" @click="addSupplyEvent">登记供应进度</n-button>
                  </n-form>
                  <n-empty v-else-if="!selectedTask.materials.length" description="该任务未配置物资，可仅推进实施和结算。" />
                </n-card>

                <n-card title="B. 现场实施">
                  <n-alert type="info" :bordered="false" class="section-note">实施不等待结算；首次实施后自动产生结算提醒。</n-alert>
                  <n-form v-if="canImplement" label-placement="top">
                    <n-form-item label="实施日期"><n-input v-model:value="implementationDate" /></n-form-item>
                    <div v-for="scope in selectedTask.demandScopes" :key="scope.id" class="line-input-row"><span>{{ scope.demand?.lineName }} {{ scope.demand?.section }} · 任务范围 {{ formatScaled(scope.plannedQuantityScaled) }}</span><n-input :data-test="`implementation-scope-${scope.id}`" :value="implementationScopeQuantities[scope.id] ?? ''" placeholder="本次完成量" @update:value="(value: string) => { implementationScopeQuantities[scope.id] = value; }" /></div>
                    <strong v-if="selectedTask.materials.length">实际物资使用（可空）</strong>
                    <div v-for="material in selectedTask.materials" :key="material.id" class="line-input-row"><span>{{ material.model }} / {{ material.unit }}</span><n-input :value="implementationMaterialUsages[material.id] ?? ''" placeholder="本次实际使用量" @update:value="(value: string) => { implementationMaterialUsages[material.id] = value; }" /></div>
                    <n-form-item label="备注"><n-input v-model:value="implementationNote" /></n-form-item>
                    <n-button data-test="create-task-implementation" type="primary" :loading="saving" @click="createImplementation">保存实施事实</n-button>
                  </n-form>
                </n-card>

                <n-card title="C. 任务结算">
                  <n-alert type="info" :bordered="false" class="section-note">结算与实施独立，允许先结算后实施。最终结算必须覆盖任务全部需求范围。</n-alert>
                  <n-form v-if="canSettle" label-placement="top">
                    <n-form-item label="结算日期"><n-input v-model:value="settlementDate" /></n-form-item>
                    <n-form-item label="结算金额（元）"><n-input data-test="task-settlement-amount" v-model:value="settlementAmount" /></n-form-item>
                    <div v-for="scope in selectedTask.demandScopes" :key="scope.id" class="line-input-row"><span>{{ scope.demand?.lineName }} {{ scope.demand?.section }} · 任务范围 {{ formatScaled(scope.plannedQuantityScaled) }}</span><n-input :data-test="`task-settlement-scope-${scope.id}`" :value="settlementCoverage[scope.id] ?? ''" placeholder="本次结算覆盖量" @update:value="(value: string) => { settlementCoverage[scope.id] = value; }" /></div>
                    <n-form-item><n-checkbox v-model:checked="settlementFinal">最终结算</n-checkbox></n-form-item>
                    <n-form-item label="备注"><n-input v-model:value="settlementNote" /></n-form-item>
                    <n-button data-test="create-task-settlement" type="primary" :loading="saving" @click="createSettlement">保存结算事实</n-button>
                  </n-form>
                </n-card>
              </div>
            </template>
            <n-empty v-else description="先创建并选择一个执行任务" />
          </n-tab-pane>

          <n-tab-pane name="attachments" tab="附件">
            <n-card title="项目私有附件">
              <n-alert type="info" :bordered="false">附件保存在私有 R2；下载仍按项目权限校验。</n-alert>
              <div v-if="canUpload" class="attachment-upload"><input type="file" @change="attachmentChanged" /><n-button :loading="saving" @click="uploadAttachment">上传附件</n-button></div>
              <div v-if="attachments.length" class="attachment-list"><a v-for="item in attachments" :key="item.id" :href="`/api/attachments/${item.id}/content`">{{ item.fileName }}</a></div>
              <n-empty v-else description="暂无附件" />
            </n-card>
          </n-tab-pane>
        </n-tabs>
      </template>
      <n-empty v-else description="暂无可查看项目" />
    </n-spin>
  </div>
</template>

<style scoped>
.delivery-view { gap: 16px; }
.project-selector { max-width: 560px; }
.section-note { margin-bottom: 12px; }
.detail-card { margin-top: 14px; }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.status-grid > div { display: grid; gap: 4px; padding: 12px; border: 1px solid #e5e9f0; border-radius: 9px; }
.status-grid span { color: #6f7b8c; font-size: 12px; }
.demand-feedback { display: grid; gap: 8px; }
.feedback-row { display: grid; grid-template-columns: minmax(220px, 1.5fr) 1fr 1fr auto; gap: 12px; align-items: center; padding: 9px 0; border-bottom: 1px solid #eef1f5; }
.snapshot-row, .supply-row { display: flex; gap: 16px; align-items: center; padding: 9px 0; border-bottom: 1px solid #eef1f5; }
.task-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.line-input-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(170px, 260px); gap: 12px; align-items: center; margin: 8px 0; }
.parallel-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 14px; align-items: start; }
.attachment-upload { display: flex; gap: 12px; align-items: center; margin: 14px 0; }
.attachment-list { display: grid; gap: 8px; margin-top: 12px; }
@media (max-width: 1180px) { .parallel-grid { grid-template-columns: 1fr; } }
@media (max-width: 900px) { .status-grid, .task-form { grid-template-columns: 1fr 1fr; } .feedback-row { grid-template-columns: 1fr 1fr; } }
@media (max-width: 640px) { .status-grid, .task-form, .feedback-row, .line-input-row { grid-template-columns: 1fr; } .attachment-upload { align-items: stretch; flex-direction: column; } }
</style>
