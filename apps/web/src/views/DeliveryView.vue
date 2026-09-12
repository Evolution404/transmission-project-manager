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
  ImplementationRecordSummary,
  LifecycleState,
  ProjectLifecycleSummary,
  ProjectSummary,
  ReleaseBatchSummary,
  ReleaseLineSummary,
  SettlementSummary,
} from '@tpm/shared';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const canRelease = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');
const canImplement = computed(() => ['admin', 'project_manager', 'implementation'].includes(props.currentUser.role));
const canSettle = computed(() => ['admin', 'project_manager', 'finance'].includes(props.currentUser.role));
const canUpload = computed(() => ['admin', 'project_manager', 'implementation', 'finance'].includes(props.currentUser.role));

const loading = ref(true);
const error = ref('');
const projects = ref<ProjectSummary[]>([]);
const selectedProjectId = ref<string | null>(null);
const lifecycle = ref<ProjectLifecycleSummary | null>(null);
const releases = ref<ReleaseBatchSummary[]>([]);
const implementations = ref<ImplementationRecordSummary[]>([]);
const settlements = ref<SettlementSummary[]>([]);
const unlinkedHistorical = ref<ImplementationRecordSummary[]>([]);
const attachments = ref<AttachmentSummary[]>([]);

const releaseDate = ref('');
const releaseNote = ref('');
const releaseQuantities = ref<Record<string, string>>({});
const implementationReleaseLineId = ref<string | null>(null);
const implementationQuantity = ref('');
const implementationDate = ref('');
const implementationPersonnel = ref('');
const implementationNote = ref('');
const historicalDescription = ref('');
const historicalUnit = ref('套');
const historicalQuantity = ref('');
const historicalDate = ref('');
const historicalLinkTargets = ref<Record<string, string | null>>({});
const settlementDate = ref('');
const settlementAmount = ref('');
const settlementFinal = ref(false);
const settlementNote = ref('');
const settlementQuantities = ref<Record<string, string>>({});
const attachmentFile = ref<File | null>(null);
const saving = ref(false);

function businessToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseDecimalScaled(value: string, digits = 4): number | null {
  const raw = value.trim();
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const scale = 10n ** BigInt(digits);
  const integer = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(digits, '0') || '0');
  const scaled = integer * scale + fraction;
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

function formatMoneyFen(value: number) {
  return `${(value / 100).toFixed(2)} 元`;
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
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  };
}

const projectOptions = computed(() => projects.value.map((item) => ({ label: item.name, value: item.id })));
const releaseLines = computed(() => releases.value.flatMap((batch) => batch.lines));
const releaseLineOptions = computed(() => releaseLines.value.map((line) => ({
  label: `${line.snapshot.lineName} ${line.snapshot.section} · ${formatScaled(line.quantityScaled)} ${line.snapshot.unit ?? ''}`,
  value: line.id,
})));
const demandMaterialOptions = computed(() => (lifecycle.value?.lines ?? []).map((line) => ({
  label: `${line.lineName} ${line.section} · ${line.rawModel} / ${line.unit ?? '未设单位'}`,
  value: line.demandMaterialId,
})));

async function loadProjects() {
  const data = await apiRequest<{ items: ProjectSummary[]; nextCursor: string | null }>('/api/projects?limit=50');
  projects.value = data.items;
  if (!selectedProjectId.value && data.items[0]) selectedProjectId.value = data.items[0].id;
}

async function loadProjectContext() {
  const projectId = selectedProjectId.value;
  if (!projectId) {
    lifecycle.value = null;
    releases.value = [];
    implementations.value = [];
    settlements.value = [];
    attachments.value = [];
    return;
  }
  const requests: Promise<unknown>[] = [
    apiRequest<ProjectLifecycleSummary>(`/api/projects/${encodeURIComponent(projectId)}/lifecycle`),
    apiRequest<{ items: ReleaseBatchSummary[] }>(`/api/release-batches?projectId=${encodeURIComponent(projectId)}`),
    apiRequest<{ items: ImplementationRecordSummary[] }>(`/api/implementations?projectId=${encodeURIComponent(projectId)}`),
    apiRequest<{ items: SettlementSummary[] }>(`/api/settlements?projectId=${encodeURIComponent(projectId)}`),
  ];
  const [life, releaseData, implementationData, settlementData] = await Promise.all(requests) as [
    ProjectLifecycleSummary,
    { items: ReleaseBatchSummary[] },
    { items: ImplementationRecordSummary[] },
    { items: SettlementSummary[] },
  ];
  lifecycle.value = life;
  releases.value = releaseData.items;
  implementations.value = implementationData.items;
  settlements.value = settlementData.items;
  releaseQuantities.value = {};
  settlementQuantities.value = {};
  for (const line of life.lines) {
    const releaseRemaining = Math.max(0, line.allocatedQuantityScaled - line.releasedQuantityScaled);
    if (releaseRemaining > 0) releaseQuantities.value[line.demandMaterialId] = formatScaled(releaseRemaining);
    const settlementRemaining = Math.max(0, line.allocatedQuantityScaled - line.settledQuantityScaled);
    if (settlementRemaining > 0) settlementQuantities.value[line.demandMaterialId] = formatScaled(settlementRemaining);
  }
  if (!implementationReleaseLineId.value && releaseLines.value[0]) implementationReleaseLineId.value = releaseLines.value[0].id;
  if (canUpload.value) {
    try {
      const attachmentData = await apiRequest<{ items: AttachmentSummary[] }>(`/api/attachments?objectType=project&objectId=${encodeURIComponent(projectId)}`);
      attachments.value = attachmentData.items;
    } catch {
      attachments.value = [];
    }
  }
}

async function loadUnlinkedHistorical() {
  if (!canImplement.value) {
    unlinkedHistorical.value = [];
    return;
  }
  const data = await apiRequest<{ items: ImplementationRecordSummary[] }>('/api/implementations?unlinked=true');
  unlinkedHistorical.value = data.items;
  const next: Record<string, string | null> = {};
  for (const record of data.items) {
    for (const line of record.lines) next[line.id] = demandMaterialOptions.value[0]?.value ?? null;
  }
  historicalLinkTargets.value = next;
}

async function loadInitial() {
  loading.value = true;
  error.value = '';
  const today = businessToday();
  releaseDate.value = today;
  implementationDate.value = today;
  historicalDate.value = today;
  settlementDate.value = today;
  try {
    await loadProjects();
    await loadProjectContext();
    await loadUnlinkedHistorical();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取实施结算数据失败';
  } finally {
    loading.value = false;
  }
}

async function selectProject(value: string | null) {
  selectedProjectId.value = value;
  implementationReleaseLineId.value = null;
  await loadProjectContext();
  await loadUnlinkedHistorical();
}

async function refreshProject() {
  await loadProjects();
  await loadProjectContext();
  await loadUnlinkedHistorical();
}

async function createRelease() {
  const projectId = selectedProjectId.value;
  const life = lifecycle.value;
  if (!projectId || !life) return;
  const lines = life.lines.flatMap((line) => {
    const quantityScaled = parseDecimalScaled(releaseQuantities.value[line.demandMaterialId] ?? '');
    return quantityScaled !== null && quantityScaled > 0 ? [{ demandMaterialId: line.demandMaterialId, quantityScaled }] : [];
  });
  if (!lines.length) { message.warning('至少填写一条正数出库数量'); return; }
  saving.value = true;
  try {
    await apiRequest('/api/release-batches', writeInit('POST', {
      projectId,
      expectedProjectVersion: life.projectVersion,
      releaseDate: releaseDate.value,
      note: releaseNote.value.trim() || null,
      lines,
    }));
    releaseNote.value = '';
    await refreshProject();
    message.success('项目范围已出库');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '出库失败'); }
  finally { saving.value = false; }
}

async function createImplementation() {
  const projectId = selectedProjectId.value;
  const life = lifecycle.value;
  const releaseLineId = implementationReleaseLineId.value;
  const completedQuantityScaled = parseDecimalScaled(implementationQuantity.value);
  if (!projectId || !life || !releaseLineId || completedQuantityScaled === null || completedQuantityScaled <= 0) {
    message.warning('请选择出库范围并填写有效完成数量'); return;
  }
  saving.value = true;
  try {
    await apiRequest('/api/implementations', writeInit('POST', {
      historical: false,
      projectId,
      expectedProjectVersion: life.projectVersion,
      recordDate: implementationDate.value,
      personnel: implementationPersonnel.value.trim() || null,
      note: implementationNote.value.trim() || null,
      lines: [{
        releaseLineId,
        description: null,
        unit: releaseLines.value.find((line) => line.id === releaseLineId)?.snapshot.unit ?? null,
        completedQuantityScaled,
        actualUsedQuantityScaled: completedQuantityScaled,
      }],
    }));
    implementationQuantity.value = '';
    implementationNote.value = '';
    await refreshProject();
    message.success('实施记录已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '实施记录保存失败'); }
  finally { saving.value = false; }
}

async function createHistoricalImplementation() {
  const quantity = parseDecimalScaled(historicalQuantity.value);
  if (!historicalDescription.value.trim() || quantity === null || quantity <= 0) {
    message.warning('请填写历史实施描述和有效数量'); return;
  }
  saving.value = true;
  try {
    await apiRequest('/api/implementations', writeInit('POST', {
      historical: true,
      projectId: null,
      expectedProjectVersion: null,
      recordDate: historicalDate.value,
      personnel: implementationPersonnel.value.trim() || null,
      note: '历史补录',
      lines: [{ releaseLineId: null, description: historicalDescription.value.trim(), unit: historicalUnit.value.trim() || null, completedQuantityScaled: quantity, actualUsedQuantityScaled: quantity }],
    }));
    historicalDescription.value = '';
    historicalQuantity.value = '';
    await loadUnlinkedHistorical();
    message.success('历史实施已补录，未自动生成出库记录');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '历史实施补录失败'); }
  finally { saving.value = false; }
}

async function linkHistorical(record: ImplementationRecordSummary) {
  const projectId = selectedProjectId.value;
  const life = lifecycle.value;
  if (!projectId || !life) return;
  const links = record.lines.map((line) => ({ implementationLineId: line.id, demandMaterialId: historicalLinkTargets.value[line.id] ?? '' }));
  if (links.some((item) => !item.demandMaterialId)) { message.warning('请为全部历史实施明细选择项目需求物资'); return; }
  saving.value = true;
  try {
    await apiRequest(`/api/implementations/${encodeURIComponent(record.id)}/link`, writeInit('PUT', {
      expectedVersion: record.version,
      projectId,
      expectedProjectVersion: life.projectVersion,
      links,
    }));
    await refreshProject();
    message.success('历史实施已关联，不会补造出库记录');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '历史实施关联失败'); }
  finally { saving.value = false; }
}

async function createSettlement() {
  const projectId = selectedProjectId.value;
  const life = lifecycle.value;
  const amountFen = parseMoneyFen(settlementAmount.value);
  if (!projectId || !life || amountFen === null) { message.warning('请填写有效结算金额'); return; }
  const coverage = life.lines.flatMap((line) => {
    const quantityScaled = parseDecimalScaled(settlementQuantities.value[line.demandMaterialId] ?? '');
    return quantityScaled !== null && quantityScaled > 0 ? [{ demandMaterialId: line.demandMaterialId, quantityScaled }] : [];
  });
  if (!coverage.length) { message.warning('至少填写一条结算覆盖数量'); return; }
  saving.value = true;
  try {
    await apiRequest('/api/settlements', writeInit('POST', {
      projectId,
      expectedProjectVersion: life.projectVersion,
      settlementDate: settlementDate.value,
      amountFen,
      final: settlementFinal.value,
      note: settlementNote.value.trim() || null,
      coverage,
      agreementAllocations: [],
    }));
    settlementAmount.value = '';
    settlementNote.value = '';
    settlementFinal.value = false;
    await refreshProject();
    message.success('结算记录已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '结算保存失败'); }
  finally { saving.value = false; }
}

async function voidSettlement(settlement: SettlementSummary) {
  if (!lifecycle.value) return;
  saving.value = true;
  try {
    await apiRequest(`/api/settlements/${encodeURIComponent(settlement.id)}/void`, writeInit('POST', {
      expectedVersion: settlement.version,
      expectedProjectVersion: lifecycle.value.projectVersion,
      reason: '人工撤销',
    }));
    await refreshProject();
    message.success('结算已撤销，状态和待办已重新计算');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '撤销结算失败'); }
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
    const data = await apiRequest<{ items: AttachmentSummary[] }>(`/api/attachments?objectType=project&objectId=${encodeURIComponent(projectId)}`);
    attachments.value = data.items;
    message.success('附件已上传');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '附件上传失败'); }
  finally { saving.value = false; }
}

const lifecycleColumns = [
  { title: '线路/杆段', key: 'line', render: (row: ProjectLifecycleSummary['lines'][number]) => `${row.lineName} ${row.section}` },
  { title: '物资', key: 'rawModel', render: (row: ProjectLifecycleSummary['lines'][number]) => `${row.rawModel} / ${row.unit ?? ''}` },
  { title: '项目量', key: 'allocatedQuantityScaled', render: (row: ProjectLifecycleSummary['lines'][number]) => formatScaled(row.allocatedQuantityScaled) },
  { title: '已出库', key: 'releasedQuantityScaled', render: (row: ProjectLifecycleSummary['lines'][number]) => formatScaled(row.releasedQuantityScaled) },
  { title: '已实施', key: 'implementedQuantityScaled', render: (row: ProjectLifecycleSummary['lines'][number]) => `${formatScaled(row.implementedQuantityScaled)} / ${formatScaled(row.allocatedQuantityScaled)}` },
  { title: '已结算', key: 'settledQuantityScaled', render: (row: ProjectLifecycleSummary['lines'][number]) => `${formatScaled(row.settledQuantityScaled)} / ${formatScaled(row.allocatedQuantityScaled)}` },
  { title: '状态', key: 'state', render: (row: ProjectLifecycleSummary['lines'][number]) => h(NTag, { size: 'small', bordered: false, type: stateTagType(row.state) }, { default: () => stateLabels[row.state] }) },
];

const releaseColumns = [
  { title: '日期', key: 'releaseDate' },
  { title: '范围', key: 'range', render: (row: ReleaseBatchSummary) => row.lines.map((line) => `${line.snapshot.lineName} ${formatScaled(line.quantityScaled)}${line.snapshot.unit ?? ''}`).join('；') },
  { title: '快照版本', key: 'snapshot', render: (row: ReleaseBatchSummary) => `项目 v${row.projectVersionSnapshot} / 储备 v${row.reserveVersionSnapshot}` },
];

const implementationColumns = [
  { title: '日期', key: 'recordDate' },
  { title: '类型', key: 'historical', render: (row: ImplementationRecordSummary) => row.historical ? '历史补录' : '正常实施' },
  { title: '人员', key: 'personnel', render: (row: ImplementationRecordSummary) => row.personnel ?? '—' },
  { title: '完成量', key: 'quantity', render: (row: ImplementationRecordSummary) => row.lines.map((line) => formatScaled(line.completedQuantityScaled)).join(' + ') },
];

const settlementColumns = computed(() => [
  { title: '日期', key: 'settlementDate' },
  { title: '金额', key: 'amountFen', render: (row: SettlementSummary) => formatMoneyFen(row.amountFen) },
  { title: '状态', key: 'status', render: (row: SettlementSummary) => row.voidedAt ? '已撤销' : row.final ? '最终结算' : '部分结算' },
  ...(canSettle.value ? [{ title: '操作', key: 'actions', render: (row: SettlementSummary) => row.voidedAt ? null : h(NButton, { size: 'small', quaternary: true, onClick: () => voidSettlement(row) }, { default: () => '撤销' }) }] : []),
]);

onMounted(loadInitial);
</script>

<template>
  <div class="view-stack delivery-view">
    <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>
    <n-card title="项目实施结算工作台">
      <n-form label-placement="top" class="project-selector">
        <n-form-item label="项目">
          <n-select :value="selectedProjectId" :options="projectOptions" @update:value="selectProject" />
        </n-form-item>
      </n-form>
      <n-alert type="info" :bordered="false">
        项目出库是“从储备进入实施范围”，不是仓库物资出库。实施与结算独立记录，允许先结算后实施；部分完成不会自动变成全部完成。
      </n-alert>
    </n-card>

    <n-spin :show="loading">
      <template v-if="lifecycle">
        <n-card title="当前状态">
          <template #header-extra>
            <n-tag :type="stateTagType(lifecycle.projectState)" :bordered="false">{{ stateLabels[lifecycle.projectState] }}</n-tag>
          </template>
          <div class="status-grid">
            <div><span>项目版本</span><strong>v{{ lifecycle.projectVersion }}</strong></div>
            <div><span>实施</span><strong>{{ lifecycle.implementationComplete ? '全部完成' : '未全部完成' }}</strong></div>
            <div><span>结算</span><strong>{{ lifecycle.settlementComplete ? '全部覆盖' : '未全部覆盖' }}</strong></div>
            <div><span>结算待办</span><strong>{{ lifecycle.settlementTodo.needed ? `${lifecycle.settlementTodo.dueDate} 前完成` : '无' }}</strong></div>
          </div>
          <n-data-table :columns="lifecycleColumns" :data="lifecycle.lines" :pagination="false" :scroll-x="980" />
        </n-card>

        <n-tabs type="line" animated>
          <n-tab-pane name="release" tab="项目出库">
            <n-card v-if="canRelease" title="新增出库批次">
              <n-alert type="info" :bordered="false">出库后会保存当前项目范围快照。后续储备调整不能把已出库/已实施/有效结算的范围缩小。</n-alert>
              <n-form label-placement="top">
                <n-form-item label="出库日期"><n-input v-model:value="releaseDate" /></n-form-item>
                <div v-for="line in lifecycle.lines" :key="line.demandMaterialId" class="line-input-row">
                  <span>{{ line.lineName }} {{ line.section }} · 尚未出库 {{ formatScaled(Math.max(0, line.allocatedQuantityScaled - line.releasedQuantityScaled)) }} {{ line.unit ?? '' }}</span>
                  <n-input :value="releaseQuantities[line.demandMaterialId] ?? ''" :data-test="`release-quantity-${line.demandMaterialId}`" placeholder="本批数量" @update:value="(value: string) => { releaseQuantities[line.demandMaterialId] = value; }" />
                </div>
                <n-form-item label="备注"><n-input v-model:value="releaseNote" /></n-form-item>
                <n-button data-test="create-release" type="primary" :loading="saving" @click="createRelease">确认出库范围</n-button>
              </n-form>
            </n-card>
            <n-card title="出库历史">
              <n-data-table v-if="releases.length" :columns="releaseColumns" :data="releases" :pagination="false" :scroll-x="760" />
              <n-empty v-else description="暂无出库记录" />
            </n-card>
          </n-tab-pane>

          <n-tab-pane name="implementation" tab="实施记录">
            <n-card v-if="canImplement" title="正常实施">
              <n-alert type="info" :bordered="false">正常实施只能使用已经出库的范围，并按出库明细累计完成量。</n-alert>
              <n-form label-placement="top">
                <n-form-item label="实施日期"><n-input v-model:value="implementationDate" /></n-form-item>
                <n-form-item label="出库范围"><n-select data-test="implementation-release-line" v-model:value="implementationReleaseLineId" :options="releaseLineOptions" /></n-form-item>
                <n-form-item label="完成数量"><n-input data-test="implementation-quantity" v-model:value="implementationQuantity" /></n-form-item>
                <n-form-item label="人员"><n-input v-model:value="implementationPersonnel" /></n-form-item>
                <n-form-item label="备注"><n-input v-model:value="implementationNote" /></n-form-item>
                <n-button data-test="create-implementation" type="primary" :loading="saving" @click="createImplementation">保存实施记录</n-button>
              </n-form>
            </n-card>
            <n-card v-if="canImplement" title="历史实施补录" class="detail-card">
              <n-alert type="warning" :bordered="false">历史实施可以先补录为待关联记录；系统不会因此补造出库。后续人工关联项目需求物资后才计入项目实施量。</n-alert>
              <n-form label-placement="top">
                <n-form-item label="历史日期"><n-input v-model:value="historicalDate" /></n-form-item>
                <n-form-item label="描述"><n-input v-model:value="historicalDescription" /></n-form-item>
                <n-form-item label="单位"><n-input v-model:value="historicalUnit" /></n-form-item>
                <n-form-item label="完成数量"><n-input v-model:value="historicalQuantity" /></n-form-item>
                <n-button type="primary" :loading="saving" @click="createHistoricalImplementation">补录历史实施</n-button>
              </n-form>
              <div v-if="unlinkedHistorical.length" class="historical-list">
                <div v-for="record in unlinkedHistorical" :key="record.id" class="historical-card">
                  <strong>{{ record.recordDate }} · {{ record.personnel ?? '未填人员' }}</strong>
                  <div v-for="line in record.lines" :key="line.id" class="line-input-row">
                    <span>{{ line.description }} · {{ formatScaled(line.completedQuantityScaled) }} {{ line.unit ?? '' }}</span>
                    <n-select :value="historicalLinkTargets[line.id] ?? null" :options="demandMaterialOptions" @update:value="(value: string | null) => { historicalLinkTargets[line.id] = value; }" />
                  </div>
                  <n-button size="small" :loading="saving" @click="linkHistorical(record)">关联到当前项目</n-button>
                </div>
              </div>
            </n-card>
            <n-card title="实施历史" class="detail-card">
              <n-data-table v-if="implementations.length" :columns="implementationColumns" :data="implementations" :pagination="false" />
              <n-empty v-else description="暂无实施记录" />
            </n-card>
          </n-tab-pane>

          <n-tab-pane name="settlement" tab="结算">
            <n-card v-if="canSettle" title="新增结算">
              <n-alert type="info" :bordered="false">结算可先于实施发生；这里记录结算事实和覆盖范围，不自动生成“实际费用”资金流水。</n-alert>
              <n-form label-placement="top">
                <n-form-item label="结算日期"><n-input v-model:value="settlementDate" /></n-form-item>
                <n-form-item label="结算金额（元）"><n-input data-test="settlement-amount" v-model:value="settlementAmount" /></n-form-item>
                <div v-for="line in lifecycle.lines" :key="line.demandMaterialId" class="line-input-row">
                  <span>{{ line.lineName }} {{ line.section }} · 尚未结算 {{ formatScaled(Math.max(0, line.allocatedQuantityScaled - line.settledQuantityScaled)) }} {{ line.unit ?? '' }}</span>
                  <n-input :value="settlementQuantities[line.demandMaterialId] ?? ''" :data-test="`settlement-quantity-${line.demandMaterialId}`" placeholder="本次覆盖数量" @update:value="(value: string) => { settlementQuantities[line.demandMaterialId] = value; }" />
                </div>
                <n-form-item><n-checkbox v-model:checked="settlementFinal">最终结算（必须覆盖项目全部范围）</n-checkbox></n-form-item>
                <n-form-item label="备注"><n-input v-model:value="settlementNote" /></n-form-item>
                <n-button data-test="create-settlement" type="primary" :loading="saving" @click="createSettlement">保存结算</n-button>
              </n-form>
            </n-card>
            <n-card title="结算历史" class="detail-card">
              <n-data-table v-if="settlements.length" :columns="settlementColumns" :data="settlements" :pagination="false" />
              <n-empty v-else description="暂无结算记录" />
            </n-card>
          </n-tab-pane>

          <n-tab-pane name="attachments" tab="附件">
            <n-card title="项目私有附件">
              <n-alert type="info" :bordered="false">附件保存在私有 R2，对下载请求再次校验项目授权，不生成公开永久链接。</n-alert>
              <div v-if="canUpload" class="attachment-upload">
                <input type="file" @change="attachmentChanged" />
                <n-button :loading="saving" @click="uploadAttachment">上传附件</n-button>
              </div>
              <div v-if="attachments.length" class="attachment-list">
                <a v-for="item in attachments" :key="item.id" :href="`/api/attachments/${item.id}/content`">{{ item.fileName }}</a>
              </div>
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
.project-selector { max-width: 520px; }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.status-grid > div { display: grid; gap: 4px; padding: 12px; border: 1px solid #e5e9f0; border-radius: 9px; }
.status-grid span { color: #6f7b8c; font-size: 12px; }
.line-input-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 280px); gap: 12px; align-items: center; margin-bottom: 10px; }
.detail-card { margin-top: 14px; }
.historical-list { display: grid; gap: 12px; margin-top: 14px; }
.historical-card { display: grid; gap: 10px; padding: 12px; border: 1px solid #e5e9f0; border-radius: 9px; }
.attachment-upload { display: flex; gap: 12px; align-items: center; margin: 14px 0; }
.attachment-list { display: grid; gap: 8px; margin-top: 12px; }
@media (max-width: 900px) {
  .status-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 640px) {
  .status-grid { grid-template-columns: 1fr; }
  .line-input-row { grid-template-columns: 1fr; }
  .attachment-upload { align-items: stretch; flex-direction: column; }
}
</style>
