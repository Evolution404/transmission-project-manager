<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NDataTable, NEmpty, NForm, NFormItem, NInput, NModal, NSelect,
  NSpace, NSwitch, NTag, useMessage,
} from 'naive-ui';
import { normalizeTowerNo, type CurrentUser, type TransmissionLineSummary, type TransmissionTowerSummary, type VoltageLevelSummary, type VoltageSystemType } from '@tpm/shared';
import { parseApiResponse } from '../api/response';
import { parseFileInWorker } from '../imports/workerClient';
import {
  buildTowerImportPreview,
  completeTowerCoverageErrors,
  parseTowerPaste,
  towerImportChunks,
  towerIdsInSourceOrder,
  towerRowsFromSpreadsheet,
  type TowerImportPreview,
  type TowerImportPreviewRow,
  type TowerImportSourceRow,
} from '../imports/towerImport';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const isAdmin = computed(() => props.currentUser.role === 'admin');

const voltageLevels = ref<VoltageLevelSummary[]>([]);
const lines = ref<TransmissionLineSummary[]>([]);
const towers = ref<TransmissionTowerSummary[]>([]);
const selectedVoltageId = ref<string | null>(null);
const selectedLineId = ref<string | null>(null);
const error = ref('');
const mobileStep = ref<'voltage' | 'lines' | 'towers'>('voltage');
const lineCursor = ref<string | null>(null), towerCursor = ref<string | null>(null);
const loading = ref(false);
let lineRequest = 0, towerRequest = 0;
const bulkModal = ref(false), bulkText = ref('');
const bulkPreview = ref<TowerImportPreview | null>(null);
const bulkSourceLabel = ref('');
const bulkMode = ref<'merge' | 'full-order'>('merge');
const bulkModeOptions = [
  { label: '新增 / 更新（新增杆塔按编号自动插入）', value: 'merge' },
  { label: '完整清单重排（文件顺序就是线路顺序）', value: 'full-order' },
];
const bulkGlobalErrors = ref<string[]>([]);
const bulkPreparing = ref(false);
const bulkChunks = ref<TowerImportPreviewRow[][]>([]);
const bulkChunkKeys = ref<string[]>([]);
const bulkNextChunk = ref(0);
const bulkProcessed = ref(0);
const bulkOrderVersion = ref<number | null>(null);
const bulkReorderKey = ref('');
const selectedVoltage = computed(() => voltageLevels.value.find((v) => v.id === selectedVoltageId.value));
const selectedLine = computed(() => lines.value.find((l) => l.id === selectedLineId.value));

const voltageModal = ref(false);
const lineModal = ref(false);
const towerModal = ref(false);
const editingVoltage = ref<VoltageLevelSummary | null>(null);
const editingLine = ref<TransmissionLineSummary | null>(null);
const editingTower = ref<TransmissionTowerSummary | null>(null);
const saving = ref(false);

const voltageForm = ref({ displayName: '', code: '', systemType: 'AC' as VoltageSystemType, nominalKv: '', sortOrder: '', enabled: true });
const lineForm = ref({ voltageLevelId: '', lineCode: '', lineName: '', enabled: true });
const towerForm = ref({ lineId: '', towerNo: '', towerType: '', enabled: true });

const voltageOptions = computed(() => voltageLevels.value.map((item) => ({ label: item.displayName + (item.enabled ? '' : '（停用）'), value: item.id, disabled: !item.enabled && item.id !== editingLine.value?.voltageLevelId })));
const systemOptions = [{ label: '交流', value: 'AC' }, { label: '直流', value: 'DC' }];

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
  return result.data;
}

async function loadAll() {
  error.value = '';
  try {
    voltageLevels.value = (await apiRequest<{ items: VoltageLevelSummary[] }>('/api/master/voltage-levels')).items;
    if (!voltageLevels.value.some((v) => v.id === selectedVoltageId.value)) selectedVoltageId.value = voltageLevels.value[0]?.id ?? null;
    await loadLines();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '基础台账读取失败'; }
}
async function loadLines(append = false) {
  const token = ++lineRequest, voltageId = selectedVoltageId.value;
  if (!voltageId) { lines.value = []; return; }
  loading.value = true;
  try {
    const data = await apiRequest<{ items: TransmissionLineSummary[]; nextCursor?: string | null }>(`/api/master/lines?voltageLevelId=${encodeURIComponent(voltageId)}${append && lineCursor.value ? '&cursor=' + encodeURIComponent(lineCursor.value) : ''}`);
    if (token !== lineRequest) return;
    lines.value = append ? [...lines.value, ...data.items] : data.items; lineCursor.value = data.nextCursor ?? null;
    if (selectedLineId.value && !lines.value.some((l) => l.id === selectedLineId.value)) { selectedLineId.value = null; towers.value = []; }
    if (selectedLineId.value) await loadTowers();
  } catch (cause) { if (token === lineRequest) error.value = cause instanceof Error ? cause.message : '线路读取失败'; }
  finally { if (token === lineRequest) loading.value = false; }
}
async function loadTowers(append = false) {
  const token = ++towerRequest, lineId = selectedLineId.value;
  if (!lineId) { towers.value = []; return; }
  try {
    const data = await apiRequest<{ items: TransmissionTowerSummary[]; nextCursor?: string | null }>(`/api/master/towers?lineId=${encodeURIComponent(lineId)}${append && towerCursor.value ? '&cursor=' + encodeURIComponent(towerCursor.value) : ''}`);
    if (token !== towerRequest) return;
    towers.value = append ? [...towers.value, ...data.items] : data.items; towerCursor.value = data.nextCursor ?? null;
  } catch (cause) { if (token === towerRequest) error.value = cause instanceof Error ? cause.message : '杆塔读取失败'; }
}
async function selectVoltage(id: string) {
  selectedVoltageId.value = id; selectedLineId.value = null; lines.value = []; towers.value = [];
  lineCursor.value = null; towerCursor.value = null; towerRequest++; mobileStep.value = 'lines';
  await loadLines();
}
async function selectLine(id: string) {
  selectedLineId.value = id; towers.value = []; towerCursor.value = null; mobileStep.value = 'towers'; await loadTowers();
}
async function removeObject(kind: string, item: { id: string; version: number }) {
  saving.value = true;
  try {
    await apiRequest(`/api/master/${kind}/${item.id}`, jsonInit('DELETE', { expectedVersion: item.version }));
    await loadAll(); message.success('已删除未引用的台账对象');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '删除失败'); }
  finally { saving.value = false; }
}
async function openBulk() {
  bulkText.value = '';
  bulkPreview.value = null;
  bulkSourceLabel.value = '';
  bulkMode.value = 'merge';
  bulkGlobalErrors.value = [];
  bulkChunks.value = [];
  bulkChunkKeys.value = [];
  bulkNextChunk.value = 0;
  bulkProcessed.value = 0;
  bulkOrderVersion.value = null;
  bulkReorderKey.value = crypto.randomUUID();
  bulkModal.value = true;
}

function setBulkMode(value: 'merge' | 'full-order') {
  bulkMode.value = value;
  bulkPreview.value = null;
  bulkGlobalErrors.value = [];
  bulkChunks.value = [];
  bulkChunkKeys.value = [];
  bulkNextChunk.value = 0;
  bulkProcessed.value = 0;
  bulkOrderVersion.value = null;
  bulkReorderKey.value = crypto.randomUUID();
}

async function loadCompleteTowers(lineId: string): Promise<TransmissionTowerSummary[]> {
  const result: TransmissionTowerSummary[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `/api/master/towers?lineId=${encodeURIComponent(lineId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page: { items: TransmissionTowerSummary[]; nextCursor?: string | null } = await apiRequest(query);
    result.push(...page.items);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return result;
}

async function prepareBulkPreview(sourceRows: TowerImportSourceRow[], label: string) {
  const line = selectedLine.value;
  if (!line) { message.warning('请先选择线路'); return; }
  bulkPreparing.value = true;
  try {
    const existing = await loadCompleteTowers(line.id);
    bulkPreview.value = buildTowerImportPreview(sourceRows, existing);
    bulkGlobalErrors.value = bulkMode.value === 'full-order' ? completeTowerCoverageErrors(bulkPreview.value, existing) : [];
    bulkSourceLabel.value = label;
    bulkChunks.value = towerImportChunks(bulkPreview.value.rows);
    bulkChunkKeys.value = bulkChunks.value.map(() => crypto.randomUUID());
    bulkNextChunk.value = 0;
    bulkProcessed.value = 0;
    bulkOrderVersion.value = line.towerOrderVersion;
    bulkReorderKey.value = crypto.randomUUID();
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '杆塔导入预览失败'); }
  finally { bulkPreparing.value = false; }
}

async function previewBulkPaste() {
  const rows = parseTowerPaste(bulkText.value);
  if (!rows.length) { message.warning('请粘贴至少一行杆塔数据'); return; }
  await prepareBulkPreview(rows, '粘贴数据');
}

async function onBulkFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  bulkPreparing.value = true;
  try {
    const spreadsheet = await parseFileInWorker(file);
    await prepareBulkPreview(towerRowsFromSpreadsheet(spreadsheet), file.name);
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '杆塔文件解析失败'); }
  finally { bulkPreparing.value = false; input.value = ''; }
}

async function saveBulk() {
  const preview = bulkPreview.value, lineId = selectedLineId.value;
  if (!preview || !lineId || bulkOrderVersion.value === null) return;
  if (preview.counts.error || bulkGlobalErrors.value.length) { message.warning('请先修正预览中的错误'); return; }
  if (!bulkChunks.value.length && bulkMode.value === 'merge') { message.success('导入内容没有需要写入的变化'); return; }
  saving.value = true;
  try {
    while (bulkNextChunk.value < bulkChunks.value.length) {
      const chunkIndex = bulkNextChunk.value;
      const chunk = bulkChunks.value[chunkIndex]!;
      const items = chunk.map((row) => ({
        action: row.action,
        ...(row.action === 'update' ? { id: row.id, expectedVersion: row.expectedVersion } : {}),
        towerNo: row.towerNo,
        towerType: row.towerType,
        enabled: row.enabled,
      }));
      const responseData: { created: number; updated: number; towerOrderVersion: number } = await apiRequest(
        `/api/master/lines/${lineId}/towers/import-chunk`,
        jsonInit('POST', { expectedTowerOrderVersion: bulkOrderVersion.value, items }, bulkChunkKeys.value[chunkIndex]!),
      );
      bulkOrderVersion.value = responseData.towerOrderVersion;
      bulkProcessed.value += chunk.length;
      bulkNextChunk.value += 1;
    }
    if (bulkMode.value === 'full-order') {
      const current = await loadCompleteTowers(lineId);
      const towerIds = towerIdsInSourceOrder(preview, current);
      if (!towerIds) throw new Error('完整清单与当前线路对象无法唯一对应，请重新生成预览');
      const reordered: { towerOrderVersion: number } = await apiRequest(
        `/api/master/lines/${lineId}/towers/reorder`,
        jsonInit('POST', { expectedTowerOrderVersion: bulkOrderVersion.value, towerIds }, bulkReorderKey.value),
      );
      bulkOrderVersion.value = reordered.towerOrderVersion;
    }
    bulkModal.value = false;
    await loadAll();
    message.success(`杆塔导入完成：新增 ${preview.counts.create}，更新 ${preview.counts.update}，无变化 ${preview.counts.unchanged}${bulkMode.value === 'full-order' ? '；已按完整清单重排' : ''}`);
  } catch (cause) {
    message.error(`${cause instanceof Error ? cause.message : '杆塔导入失败'}；已完成部分不会重复写入，可直接继续`);
  } finally { saving.value = false; }
}

function jsonInit(method: 'POST' | 'PATCH' | 'DELETE', body: unknown, idempotencyKey: string = crypto.randomUUID()): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) };
}

function openVoltage(item?: VoltageLevelSummary) {
  editingVoltage.value = item ?? null;
  voltageForm.value = item ? {
    displayName: item.displayName, code: item.code, systemType: item.systemType,
    nominalKv: String(item.nominalKv), sortOrder: String(item.sortOrder), enabled: item.enabled,
  } : { displayName: '', code: '', systemType: 'AC', nominalKv: '', sortOrder: String((voltageLevels.value.length + 1) * 10), enabled: true };
  voltageModal.value = true;
}

async function saveVoltage() {
  const nominalKv = Number(voltageForm.value.nominalKv), sortOrder = Number(voltageForm.value.sortOrder);
  if (!voltageForm.value.displayName.trim() || !voltageForm.value.code.trim() || !Number.isInteger(nominalKv) || nominalKv <= 0 || !Number.isInteger(sortOrder)) {
    message.warning('请完整填写电压等级名称、编码、标称电压和排序'); return;
  }
  saving.value = true;
  try {
    const body = { ...voltageForm.value, displayName: voltageForm.value.displayName.trim(), code: voltageForm.value.code.trim(), nominalKv, sortOrder };
    if (editingVoltage.value) await apiRequest(`/api/master/voltage-levels/${editingVoltage.value.id}`, jsonInit('PATCH', { ...body, expectedVersion: editingVoltage.value.version }));
    else await apiRequest('/api/master/voltage-levels', jsonInit('POST', body));
    voltageModal.value = false; await loadAll(); message.success('电压等级已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

function openLine(item?: TransmissionLineSummary) {
  editingLine.value = item ?? null;
  lineForm.value = item ? { voltageLevelId: item.voltageLevelId, lineCode: item.lineCode ?? '', lineName: item.lineName, enabled: item.enabled } : { voltageLevelId: selectedVoltageId.value ?? '', lineCode: '', lineName: '', enabled: true };
  lineModal.value = true;
}

async function saveLine() {
  if (!lineForm.value.voltageLevelId || !lineForm.value.lineName.trim()) { message.warning('请选择电压等级并填写线路名称'); return; }
  saving.value = true;
  try {
    const body = { ...lineForm.value, lineName: lineForm.value.lineName.trim(), lineCode: lineForm.value.lineCode.trim() || null };
    if (editingLine.value) await apiRequest(`/api/master/lines/${editingLine.value.id}`, jsonInit('PATCH', { ...body, expectedVersion: editingLine.value.version }));
    else await apiRequest('/api/master/lines', jsonInit('POST', body));
    lineModal.value = false; await loadAll(); message.success('线路已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

function openTower(item?: TransmissionTowerSummary) {
  editingTower.value = item ?? null;
  towerForm.value = item ? { lineId: item.lineId, towerNo: item.towerNo, towerType: item.towerType ?? '', enabled: item.enabled } : { lineId: selectedLineId.value ?? '', towerNo: '', towerType: '', enabled: true };
  towerModal.value = true;
}

async function saveTower() {
  const towerNo = normalizeTowerNo(towerForm.value.towerNo);
  if (!towerForm.value.lineId || !towerNo) { message.warning('请选择线路，并填写如 10、10-1、#010 的有效杆塔编号'); return; }
  saving.value = true;
  try {
    const body = { ...towerForm.value, towerNo, towerType: towerForm.value.towerType.trim() || null };
    if (editingTower.value) await apiRequest(`/api/master/towers/${editingTower.value.id}`, jsonInit('PATCH', { ...body, expectedVersion: editingTower.value.version }));
    else await apiRequest('/api/master/towers', jsonInit('POST', body));
    towerModal.value = false; await loadAll(); message.success('杆塔已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

const towerColumns = computed(() => [
  { title: '顺序', key: 'sortRank', width: 64 }, { title: '杆塔号', key: 'towerNo' },
  { title: '类型', key: 'towerType', render: (row: TransmissionTowerSummary) => row.towerType ?? '—' },
  { title: '状态', key: 'enabled', render: (row: TransmissionTowerSummary) => row.enabled ? '启用' : '停用' },
  ...(isAdmin.value ? [{ title: '操作', key: 'actions', width: 112, render: (row: TransmissionTowerSummary) => h(NSpace, { size: 4 }, { default: () => [
    h(NButton, { size: 'tiny', onClick: () => openTower(row) }, { default: () => '编辑' }),
    h(NButton, { size: 'tiny', disabled: saving.value, onClick: () => removeObject('towers', row) }, { default: () => '删除' }),
  ] }) }] : []),
]);

onMounted(loadAll);
</script>

<template>
  <div class="view-stack master-data-view">
    <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>
    <div class="master-hero">
      <div><span>基础台账</span><h2>统一维护电压等级、线路和杆塔</h2><p>先选电压等级，再选线路，查看并维护线路上的杆塔。</p></div>
      <n-tag :bordered="false" :type="isAdmin ? 'success' : 'default'">{{ isAdmin ? '管理员可维护' : '只读' }}</n-tag>
    </div>

    <nav class="master-breadcrumb" aria-label="台账层级">
      <button data-test="back-voltage" @click="mobileStep='voltage'">基础台账 / 电压等级</button>
      <template v-if="selectedVoltage"><span>/</span><button @click="mobileStep='lines'">{{ selectedVoltage.displayName }} · 线路</button></template>
      <template v-if="selectedLine"><span>/</span><button @click="mobileStep='towers'">{{ selectedLine.lineName }} · 杆塔清单</button></template>
    </nav>
    <div class="master-columns" data-test="master-columns" :data-step="mobileStep">
      <section class="master-panel voltage-panel">
        <header><div><small>01</small><h3>电压等级</h3></div><n-button v-if="isAdmin" size="small" @click="openVoltage()">新增电压等级</n-button></header>
        <div v-for="item in voltageLevels" :key="item.id" class="master-item" :class="{selected: selectedVoltageId===item.id}">
          <button class="master-select" :data-test="'select-voltage-'+item.id" :aria-pressed="selectedVoltageId===item.id" @click="selectVoltage(item.id)"><strong>{{ item.displayName }}</strong><span>{{ item.enabled ? '启用' : '停用' }}<b>›</b></span></button>
          <div v-if="isAdmin" class="item-actions"><n-button text size="tiny" @click="openVoltage(item)">编辑</n-button><n-button text size="tiny" :disabled="saving" @click="removeObject('voltage-levels', item)">删除</n-button></div>
        </div>
        <n-empty v-if="!voltageLevels.length" description="请先新增电压等级" />
      </section>
      <section class="master-panel line-panel">
        <header><div><small>02 · {{ selectedVoltage?.displayName ?? '请选择电压等级' }}</small><h3>线路</h3></div><n-button v-if="isAdmin" size="small" :disabled="!selectedVoltage?.enabled" @click="openLine()">新增线路</n-button></header>
        <div v-for="item in lines" :key="item.id" class="master-item" :class="{selected: selectedLineId===item.id}">
          <button class="master-select" :data-test="'select-line-'+item.id" :aria-pressed="selectedLineId===item.id" @click="selectLine(item.id)"><strong>{{ item.lineName }}</strong><span>{{ item.towerCount ?? 0 }} 基杆塔 · {{ item.enabled ? '启用' : '停用' }}<b>›</b></span></button>
          <div v-if="isAdmin" class="item-actions"><n-button text size="tiny" @click="openLine(item)">编辑</n-button><n-button text size="tiny" :disabled="saving" @click="removeObject('lines', item)">删除</n-button></div>
        </div>
        <n-empty v-if="!lines.length && !loading" description="当前电压等级下暂无线路" />
        <n-button v-if="lineCursor" :loading="loading" @click="loadLines(true)">加载更多线路</n-button>
      </section>
      <section class="master-panel tower-panel">
        <header><div><small>03 · {{ selectedLine?.lineName ?? '请选择线路' }}</small><h3>杆塔清单</h3></div></header>
        <n-space v-if="isAdmin && selectedLine" class="tower-actions"><n-button size="small" data-test="open-new-tower" :disabled="!selectedLine.enabled || !selectedVoltage?.enabled" @click="openTower()">新增杆塔</n-button><n-button size="small" data-test="open-bulk-towers" :disabled="!selectedLine.enabled || !selectedVoltage?.enabled" @click="openBulk">导入杆塔</n-button></n-space>
        <n-data-table v-if="towers.length" :columns="towerColumns" :data="towers" :pagination="false" :scroll-x="420" />
        <n-empty v-else :description="selectedLine ? '当前线路下暂无杆塔' : '选择一条线路，查看杆塔清单'" />
        <n-button v-if="towerCursor" @click="loadTowers(true)">加载更多杆塔</n-button>
      </section>
    </div>
    <n-modal v-model:show="bulkModal" preset="card" title="导入杆塔" style="width:min(780px,calc(100vw - 32px))">
      <p>当前线路：{{ selectedLine?.lineName }}。可选择 .xlsx / .csv，或直接从表格粘贴“杆塔编号、杆塔类型、状态”。系统会先规范编号并与完整线路台账对比，再一次确认导入。</p>
      <n-form-item label="导入模式">
        <n-select data-test="tower-import-mode" :value="bulkMode" :options="bulkModeOptions" @update:value="setBulkMode" />
      </n-form-item>
      <n-alert v-if="bulkMode==='full-order'" type="warning" :bordered="false">完整清单模式要求当前线路每个杆塔对象都在文件中唯一出现；不会把缺失行当作删除。导入完成后，文件行顺序将成为线路顺序。</n-alert>
      <div class="tower-import-source">
        <input data-test="tower-import-file" type="file" accept=".xlsx,.csv" :disabled="bulkPreparing || saving" @change="onBulkFile" />
        <span>或</span>
        <n-button size="small" :loading="bulkPreparing" data-test="preview-bulk-towers" @click="previewBulkPaste">预览粘贴数据</n-button>
      </div>
      <n-input v-model:value="bulkText" data-test="bulk-tower-text" type="textarea" :rows="8" placeholder="杆塔编号[TAB]杆塔类型[TAB]状态，例如：10-1    角钢塔    启用。第一行也可以带表头。" />
      <div v-if="bulkPreview" class="tower-import-preview" data-test="tower-import-preview">
        <p><strong>{{ bulkSourceLabel }}</strong>：共 {{ bulkPreview.counts.total }} 行；新增 {{ bulkPreview.counts.create }}，更新 {{ bulkPreview.counts.update }}，无变化 {{ bulkPreview.counts.unchanged }}，错误 {{ bulkPreview.counts.error }}。</p>
        <p v-if="!bulkPreview.counts.error && !bulkGlobalErrors.length">{{ bulkMode==='full-order' ? '完整清单校验通过；属性变化会先自动分批写入，随后按文件顺序原子重排。' : '系统将自动分批写入；新增杆塔按规范编号自动插入合适位置，不改变已有杆塔的人工顺序。' }}</p>
        <div v-if="bulkPreview.counts.error" class="tower-import-errors">
          <p v-for="row in bulkPreview.rows.filter(item => item.action === 'error').slice(0,20)" :key="`${row.source}-${row.rowNumber}`">{{ row.source }}第 {{ row.rowNumber }} 行：{{ row.message }}</p>
          <p v-if="bulkPreview.counts.error > 20">另有 {{ bulkPreview.counts.error - 20 }} 条错误，请修正后重新预览。</p>
        </div>
        <div v-if="bulkGlobalErrors.length" class="tower-import-errors">
          <p v-for="issue in bulkGlobalErrors" :key="issue">{{ issue }}</p>
        </div>
        <p v-if="bulkChunks.length">进度：{{ bulkProcessed }} / {{ bulkChunks.reduce((total, chunk) => total + chunk.length, 0) }} 条需要写入的数据。</p>
      </div>
      <template #footer><div class="actions"><n-button @click="bulkModal=false">取消</n-button><n-button data-test="save-bulk-towers" type="primary" :loading="saving" :disabled="!bulkPreview || bulkPreview.counts.error>0 || bulkGlobalErrors.length>0" @click="saveBulk">{{ bulkNextChunk > 0 ? '继续导入' : '开始导入' }}</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="voltageModal" preset="card" title="电压等级" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="显示名称"><n-input v-model:value="voltageForm.displayName" placeholder="例如：220kV、±800kV" /></n-form-item><n-form-item label="内部编码"><n-input v-model:value="voltageForm.code" placeholder="例如：AC_220KV" /></n-form-item><n-form-item label="制式"><n-select v-model:value="voltageForm.systemType" :options="systemOptions" /></n-form-item><n-form-item label="标称电压 kV"><n-input v-model:value="voltageForm.nominalKv" placeholder="请输入整数" /></n-form-item><n-form-item label="排序"><n-input v-model:value="voltageForm.sortOrder" placeholder="请输入排序号" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="voltageForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="voltageModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveVoltage">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="lineModal" preset="card" title="线路" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="电压等级"><n-select v-model:value="lineForm.voltageLevelId" :options="voltageOptions" /></n-form-item><n-form-item label="线路名称"><n-input v-model:value="lineForm.lineName" placeholder="请输入线路名称" /></n-form-item><n-form-item label="线路编码（可选）"><n-input v-model:value="lineForm.lineCode" placeholder="请输入线路编码" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="lineForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="lineModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveLine">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="towerModal" preset="card" title="杆塔" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="所属线路"><span>{{ selectedLine?.lineName }}</span></n-form-item><n-form-item label="杆塔号"><n-input v-model:value="towerForm.towerNo" data-test="tower-number-input" placeholder="例如：10-1" /></n-form-item><n-alert v-if="!editingTower" type="info" :bordered="false">新增杆塔会按规范化编号自动插入合适位置，后续仍可手动调整顺序。</n-alert><n-form-item label="杆塔类型（可选）"><n-input v-model:value="towerForm.towerType" placeholder="例如：角钢塔、钢管杆" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="towerForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="towerModal=false">取消</n-button><n-button data-test="save-tower" type="primary" :loading="saving" @click="saveTower">保存</n-button></div></template>
    </n-modal>
  </div>
</template>

<style scoped>
.master-hero{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:20px 22px;border:1px solid #e4e9f1;border-radius:14px;background:linear-gradient(120deg,#fff,#f6f8fd)}
.master-hero span{color:#2457d6;font-size:11px;font-weight:700;letter-spacing:.08em}.master-hero h2{margin:4px 0 5px;font-size:21px}.master-hero p{margin:0;color:#7d8798;font-size:13px}.actions{display:flex;justify-content:flex-end;gap:10px}
@media(max-width:640px){.master-hero{align-items:flex-start;flex-direction:column;padding:16px}.master-hero h2{font-size:18px}}

.master-breadcrumb{display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:#7d8798}.master-breadcrumb button{border:0;background:transparent;color:#2457d6;cursor:pointer;padding:6px 0;font:inherit}
.tower-import-source{display:flex;align-items:center;gap:10px;margin:12px 0}.tower-import-preview{margin-top:14px;padding:12px 14px;border-radius:10px;background:#f7f9fc;border:1px solid #e6eaf1}.tower-import-preview p{margin:5px 0}.tower-import-errors{max-height:180px;overflow:auto;color:#b42318}
.master-columns{display:grid;grid-template-columns:minmax(210px,.8fr) minmax(240px,1fr) minmax(440px,1.8fr);gap:14px;align-items:start}
.master-panel{min-width:0;background:#fff;border:1px solid #e4e9f1;border-radius:14px;padding:16px;min-height:360px}
.master-panel header{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:16px}.master-panel h3{margin:4px 0 0;font-size:17px}.master-panel small{color:#7d8798}.master-item{border:1px solid #edf0f5;border-radius:10px;margin-bottom:8px;overflow:hidden}.master-item.selected{border-color:#84a5f5;background:#f0f5ff}.master-select{display:flex;flex-direction:column;text-align:left;width:100%;gap:7px;padding:12px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}.master-select strong{overflow-wrap:anywhere}.master-select span{font-size:12px;color:#7d8798;display:flex;justify-content:space-between}.master-select b{color:#2457d6}.item-actions{display:flex;gap:14px;padding:0 12px 10px}.tower-actions{margin-bottom:14px}
@media(max-width:1100px){.master-columns{grid-template-columns:minmax(180px,.8fr) minmax(200px,1fr) minmax(350px,1.5fr);gap:8px}.master-panel{padding:12px}}
@media(max-width:900px){.master-columns{display:block}.master-panel{display:none;min-height:260px}.master-columns[data-step="voltage"] .voltage-panel,.master-columns[data-step="lines"] .line-panel,.master-columns[data-step="towers"] .tower-panel{display:block}}
</style>
