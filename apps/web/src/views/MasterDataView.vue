<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NDataTable, NEmpty, NForm, NFormItem, NInput, NModal, NSelect,
  NSpace, NSwitch, NTag, useMessage,
} from 'naive-ui';
import {
  normalizeTowerNo,
  type CurrentUser,
  type TransmissionLineNameHistoryEntry,
  type TransmissionLineSummary,
  type TransmissionTowerNoHistoryEntry,
  type TransmissionTowerSummary,
  type VoltageLevelSummary,
  type VoltageSystemType,
} from '@tpm/shared';
import { apiRequest, jsonRequestInit } from '../api/client';
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
const activeLine = ref<TransmissionLineSummary | null>(null);
const towers = ref<TransmissionTowerSummary[]>([]);
const lineCursor = ref<string | null>(null);
const towerCursor = ref<string | null>(null);
const lineVoltageFilter = ref('all');
const lineStatusFilter = ref<'all' | 'enabled' | 'disabled'>('all');
const lineSearch = ref('');
const towerSearch = ref('');
const loading = ref(false);
const error = ref('');
let lineRequest = 0;
let towerRequest = 0;

const selectedLine = computed(() => activeLine.value);
const selectedVoltage = computed(() => activeLine.value ? voltageLevels.value.find((item) => item.id === activeLine.value!.voltageLevelId) ?? null : null);
const lineVoltageOptions = computed(() => [
  { label: '全部电压等级', value: 'all' },
  ...voltageLevels.value.map((item) => ({ label: item.displayName, value: item.id })),
]);
const voltageOptions = computed(() => voltageLevels.value.map((item) => ({
  label: `${item.displayName}${item.enabled ? '' : '（停用）'}`,
  value: item.id,
  disabled: !item.enabled && item.id !== editingLine.value?.voltageLevelId,
})));
const lineStatusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '启用', value: 'enabled' },
  { label: '停用', value: 'disabled' },
];
const systemOptions = [{ label: '交流', value: 'AC' }, { label: '直流', value: 'DC' }];

async function loadVoltageLevels() {
  voltageLevels.value = (await apiRequest<{ items: VoltageLevelSummary[] }>('/api/master/voltage-levels')).items;
}

async function loadLines(append = false) {
  const token = ++lineRequest;
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: '100' });
    if (lineVoltageFilter.value !== 'all') params.set('voltageLevelId', lineVoltageFilter.value);
    if (lineStatusFilter.value !== 'all') params.set('enabled', lineStatusFilter.value === 'enabled' ? 'true' : 'false');
    if (lineSearch.value.trim()) params.set('query', lineSearch.value.trim());
    if (append && lineCursor.value) params.set('cursor', lineCursor.value);
    const data: { items: TransmissionLineSummary[]; nextCursor?: string | null } = await apiRequest(`/api/master/lines?${params.toString()}`);
    if (token !== lineRequest) return;
    lines.value = append ? [...lines.value, ...data.items] : data.items;
    lineCursor.value = data.nextCursor ?? null;
  } catch (cause) {
    if (token === lineRequest) error.value = cause instanceof Error ? cause.message : '线路读取失败';
  } finally {
    if (token === lineRequest) loading.value = false;
  }
}

async function loadTowers(append = false) {
  const line = activeLine.value;
  const token = ++towerRequest;
  if (!line) { towers.value = []; towerCursor.value = null; return; }
  try {
    const params = new URLSearchParams({ lineId: line.id, limit: '100' });
    if (towerSearch.value.trim()) params.set('query', towerSearch.value.trim());
    if (append && towerCursor.value) params.set('cursor', towerCursor.value);
    const data: { items: TransmissionTowerSummary[]; nextCursor?: string | null } = await apiRequest(`/api/master/towers?${params.toString()}`);
    if (token !== towerRequest) return;
    towers.value = append ? [...towers.value, ...data.items] : data.items;
    towerCursor.value = data.nextCursor ?? null;
  } catch (cause) {
    if (token === towerRequest) error.value = cause instanceof Error ? cause.message : '杆塔读取失败';
  }
}

async function loadAll() {
  error.value = '';
  await loadVoltageLevels();
  await loadLines();
  if (activeLine.value) await loadTowers();
}

async function openLineDetail(item: TransmissionLineSummary) {
  activeLine.value = item;
  towerSearch.value = '';
  towers.value = [];
  towerCursor.value = null;
  await loadTowers();
}

function backToLines() {
  activeLine.value = null;
  towers.value = [];
  towerCursor.value = null;
  towerSearch.value = '';
}

async function setVoltageFilter(value: string) {
  lineVoltageFilter.value = value;
  lineCursor.value = null;
  await loadLines();
}

async function setStatusFilter(value: 'all' | 'enabled' | 'disabled') {
  lineStatusFilter.value = value;
  lineCursor.value = null;
  await loadLines();
}

async function removeObject(kind: string, item: { id: string; version: number }) {
  saving.value = true;
  try {
    await apiRequest(`/api/master/${kind}/${item.id}`, jsonRequestInit('DELETE', { expectedVersion: item.version }));
    if (kind === 'lines' && activeLine.value?.id === item.id) backToLines();
    await loadAll();
    message.success('已删除未引用的台账对象');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '删除失败'); }
  finally { saving.value = false; }
}

const settingsModal = ref(false);
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
    if (editingVoltage.value) await apiRequest(`/api/master/voltage-levels/${editingVoltage.value.id}`, jsonRequestInit('PATCH', { ...body, expectedVersion: editingVoltage.value.version }));
    else await apiRequest('/api/master/voltage-levels', jsonRequestInit('POST', body));
    voltageModal.value = false;
    await loadVoltageLevels();
    await loadLines();
    message.success('电压等级已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

function openLine(item?: TransmissionLineSummary) {
  editingLine.value = item ?? null;
  const defaultVoltage = lineVoltageFilter.value !== 'all' ? lineVoltageFilter.value : voltageLevels.value.find((v) => v.enabled)?.id ?? '';
  lineForm.value = item
    ? { voltageLevelId: item.voltageLevelId, lineCode: item.lineCode ?? '', lineName: item.lineName, enabled: item.enabled }
    : { voltageLevelId: defaultVoltage, lineCode: '', lineName: '', enabled: true };
  lineModal.value = true;
}

async function saveLine() {
  if (!lineForm.value.voltageLevelId || !lineForm.value.lineName.trim()) { message.warning('请选择电压等级并填写线路名称'); return; }
  saving.value = true;
  try {
    const body = { ...lineForm.value, lineName: lineForm.value.lineName.trim(), lineCode: lineForm.value.lineCode.trim() || null };
    if (editingLine.value) {
      await apiRequest(`/api/master/lines/${editingLine.value.id}`, jsonRequestInit('PATCH', { ...body, expectedVersion: editingLine.value.version }));
      if (activeLine.value?.id === editingLine.value.id) activeLine.value = { ...activeLine.value, ...body, lineCode: body.lineCode, version: activeLine.value.version + 1 };
    } else await apiRequest('/api/master/lines', jsonRequestInit('POST', body));
    lineModal.value = false;
    await loadLines();
    message.success('线路属性已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

function openTower(item?: TransmissionTowerSummary) {
  editingTower.value = item ?? null;
  towerForm.value = item
    ? { lineId: item.lineId, towerNo: item.towerNo, towerType: item.towerType ?? '', enabled: item.enabled }
    : { lineId: activeLine.value?.id ?? '', towerNo: '', towerType: '', enabled: true };
  towerModal.value = true;
}

async function saveTower() {
  const towerNo = normalizeTowerNo(towerForm.value.towerNo);
  if (!towerForm.value.lineId || !towerNo) { message.warning('请选择线路，并填写如 10、10-1、#010 的有效杆塔编号'); return; }
  saving.value = true;
  try {
    const body = { ...towerForm.value, towerNo, towerType: towerForm.value.towerType.trim() || null };
    if (editingTower.value) await apiRequest(`/api/master/towers/${editingTower.value.id}`, jsonRequestInit('PATCH', { ...body, expectedVersion: editingTower.value.version }));
    else {
      await apiRequest('/api/master/towers', jsonRequestInit('POST', body));
      if (activeLine.value) activeLine.value = { ...activeLine.value, towerOrderVersion: activeLine.value.towerOrderVersion + 1, towerCount: (activeLine.value.towerCount ?? towers.value.length) + 1 };
    }
    towerModal.value = false;
    await loadTowers();
    message.success('杆塔属性已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

const lineRenameModal = ref(false);
const lineRenameForm = ref({ lineName: '', reason: '' });
function openLineRename() {
  if (!activeLine.value) return;
  lineRenameForm.value = { lineName: activeLine.value.lineName, reason: '' };
  lineRenameModal.value = true;
}
async function saveLineRename() {
  const line = activeLine.value, lineName = lineRenameForm.value.lineName.trim();
  if (!line || !lineName) return;
  saving.value = true;
  try {
    const data = await apiRequest<TransmissionLineSummary>(`/api/master/lines/${line.id}/rename`, jsonRequestInit('POST', {
      expectedVersion: line.version, lineName, reason: lineRenameForm.value.reason.trim() || null,
    }));
    activeLine.value = data;
    lineRenameModal.value = false;
    await loadLines();
    message.success('线路更名已保存，旧名称已进入历史');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '线路更名失败'); }
  finally { saving.value = false; }
}

const towerRenameModal = ref(false);
const towerRenameTarget = ref<TransmissionTowerSummary | null>(null);
const towerRenameForm = ref({ towerNo: '', reason: '' });
function openTowerRename(item: TransmissionTowerSummary) {
  towerRenameTarget.value = item;
  towerRenameForm.value = { towerNo: item.towerNo, reason: '' };
  towerRenameModal.value = true;
}
async function saveTowerRename() {
  const target = towerRenameTarget.value;
  const towerNo = normalizeTowerNo(towerRenameForm.value.towerNo);
  if (!target || !towerNo) { message.warning('请输入可识别的杆塔编号'); return; }
  saving.value = true;
  try {
    await apiRequest<TransmissionTowerSummary>(`/api/master/towers/${target.id}/rename`, jsonRequestInit('POST', {
      expectedVersion: target.version, towerNo, reason: towerRenameForm.value.reason.trim() || null,
    }));
    towerRenameModal.value = false;
    await loadTowers();
    message.success('杆塔更名已保存，旧编号已进入历史');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '杆塔更名失败'); }
  finally { saving.value = false; }
}

const historyModal = ref(false);
const historyTitle = ref('');
const historyCurrent = ref('');
const historyRows = ref<Array<{ value: string; validFrom: string; validTo: string; reason: string | null }>>([]);
async function openLineHistory() {
  const line = activeLine.value; if (!line) return;
  const data = await apiRequest<{ items: TransmissionLineNameHistoryEntry[] }>(`/api/master/lines/${line.id}/name-history`);
  historyTitle.value = '线路名称历史'; historyCurrent.value = line.lineName;
  historyRows.value = data.items.map((item) => ({ value: item.lineName, validFrom: item.validFrom, validTo: item.validTo, reason: item.reason }));
  historyModal.value = true;
}
async function openTowerHistory(item: TransmissionTowerSummary) {
  const data = await apiRequest<{ items: TransmissionTowerNoHistoryEntry[] }>(`/api/master/towers/${item.id}/number-history`);
  historyTitle.value = '杆塔编号历史'; historyCurrent.value = item.towerNo;
  historyRows.value = data.items.map((entry) => ({ value: entry.towerNo, validFrom: entry.validFrom, validTo: entry.validTo, reason: entry.reason }));
  historyModal.value = true;
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

const orderModal = ref(false);
const orderDraft = ref<TransmissionTowerSummary[]>([]);
const orderVersion = ref(0);
const orderMoving = ref('');
const orderTarget = ref('');
const orderPlacement = ref<'before' | 'after'>('before');
const draggingTowerId = ref<string | null>(null);
const orderOptions = computed(() => orderDraft.value.map((item) => ({ label: item.towerNo, value: item.id })));
const placementOptions = [{ label: '目标之前', value: 'before' }, { label: '目标之后', value: 'after' }];
async function openOrderEditor() {
  const line = activeLine.value; if (!line) return;
  orderDraft.value = await loadCompleteTowers(line.id);
  orderVersion.value = line.towerOrderVersion;
  orderMoving.value = orderDraft.value[0]?.id ?? '';
  orderTarget.value = orderDraft.value[1]?.id ?? orderDraft.value[0]?.id ?? '';
  orderPlacement.value = 'before';
  orderModal.value = true;
}
function moveDraft(movingId: string, targetId: string, placement: 'before' | 'after') {
  if (!movingId || !targetId || movingId === targetId) return;
  const next = [...orderDraft.value];
  const movingIndex = next.findIndex((item) => item.id === movingId);
  if (movingIndex < 0) return;
  const [moving] = next.splice(movingIndex, 1);
  const targetIndex = next.findIndex((item) => item.id === targetId);
  if (!moving || targetIndex < 0) return;
  next.splice(placement === 'before' ? targetIndex : targetIndex + 1, 0, moving);
  orderDraft.value = next;
}
function applyOrderMove() { moveDraft(orderMoving.value, orderTarget.value, orderPlacement.value); }
function dropOrder(targetId: string) {
  if (draggingTowerId.value) moveDraft(draggingTowerId.value, targetId, 'before');
  draggingTowerId.value = null;
}
async function saveOrder() {
  const line = activeLine.value; if (!line) return;
  saving.value = true;
  try {
    const data = await apiRequest<{ towerOrderVersion: number }>(`/api/master/lines/${line.id}/towers/reorder`, jsonRequestInit('POST', {
      expectedTowerOrderVersion: orderVersion.value, towerIds: orderDraft.value.map((item) => item.id),
    }));
    activeLine.value = { ...line, towerOrderVersion: data.towerOrderVersion };
    orderModal.value = false;
    towerSearch.value = '';
    await loadTowers();
    message.success('杆塔顺序已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '顺序保存失败'); }
  finally { saving.value = false; }
}

const bulkModal = ref(false);
const bulkText = ref('');
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

async function openBulk() {
  bulkText.value = ''; bulkPreview.value = null; bulkSourceLabel.value = ''; bulkMode.value = 'merge';
  bulkGlobalErrors.value = []; bulkChunks.value = []; bulkChunkKeys.value = []; bulkNextChunk.value = 0;
  bulkProcessed.value = 0; bulkOrderVersion.value = null; bulkReorderKey.value = crypto.randomUUID(); bulkModal.value = true;
}
function setBulkMode(value: 'merge' | 'full-order') {
  bulkMode.value = value; bulkPreview.value = null; bulkGlobalErrors.value = []; bulkChunks.value = []; bulkChunkKeys.value = [];
  bulkNextChunk.value = 0; bulkProcessed.value = 0; bulkOrderVersion.value = null; bulkReorderKey.value = crypto.randomUUID();
}
async function prepareBulkPreview(sourceRows: TowerImportSourceRow[], label: string) {
  const line = activeLine.value; if (!line) return;
  bulkPreparing.value = true;
  try {
    const existing = await loadCompleteTowers(line.id);
    bulkPreview.value = buildTowerImportPreview(sourceRows, existing);
    bulkGlobalErrors.value = bulkMode.value === 'full-order' ? completeTowerCoverageErrors(bulkPreview.value, existing) : [];
    bulkSourceLabel.value = label;
    bulkChunks.value = towerImportChunks(bulkPreview.value.rows);
    bulkChunkKeys.value = bulkChunks.value.map(() => crypto.randomUUID());
    bulkNextChunk.value = 0; bulkProcessed.value = 0; bulkOrderVersion.value = line.towerOrderVersion; bulkReorderKey.value = crypto.randomUUID();
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '杆塔导入预览失败'); }
  finally { bulkPreparing.value = false; }
}
async function previewBulkPaste() {
  const rows = parseTowerPaste(bulkText.value);
  if (!rows.length) { message.warning('请粘贴至少一行杆塔数据'); return; }
  await prepareBulkPreview(rows, '粘贴数据');
}
async function onBulkFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  bulkPreparing.value = true;
  try { await prepareBulkPreview(towerRowsFromSpreadsheet(await parseFileInWorker(file)), file.name); }
  catch (cause) { message.error(cause instanceof Error ? cause.message : '杆塔文件解析失败'); }
  finally { bulkPreparing.value = false; input.value = ''; }
}
async function saveBulk() {
  const preview = bulkPreview.value, line = activeLine.value;
  if (!preview || !line || bulkOrderVersion.value === null) return;
  if (preview.counts.error || bulkGlobalErrors.value.length) { message.warning('请先修正预览中的错误'); return; }
  if (!bulkChunks.value.length && bulkMode.value === 'merge') { message.success('导入内容没有需要写入的变化'); return; }
  saving.value = true;
  try {
    while (bulkNextChunk.value < bulkChunks.value.length) {
      const index = bulkNextChunk.value, chunk = bulkChunks.value[index]!;
      const items = chunk.map((row) => ({
        action: row.action,
        ...(row.action === 'update' ? { id: row.id, expectedVersion: row.expectedVersion } : {}),
        towerNo: row.towerNo, towerType: row.towerType, enabled: row.enabled,
      }));
      const result: { towerOrderVersion: number } = await apiRequest(`/api/master/lines/${line.id}/towers/import-chunk`, jsonRequestInit('POST', {
        expectedTowerOrderVersion: bulkOrderVersion.value, items,
      }, bulkChunkKeys.value[index]!));
      bulkOrderVersion.value = result.towerOrderVersion; bulkProcessed.value += chunk.length; bulkNextChunk.value += 1;
    }
    if (bulkMode.value === 'full-order') {
      const current = await loadCompleteTowers(line.id);
      const towerIds = towerIdsInSourceOrder(preview, current);
      if (!towerIds) throw new Error('完整清单与当前线路对象无法唯一对应，请重新生成预览');
      const result: { towerOrderVersion: number } = await apiRequest(`/api/master/lines/${line.id}/towers/reorder`, jsonRequestInit('POST', {
        expectedTowerOrderVersion: bulkOrderVersion.value, towerIds,
      }, bulkReorderKey.value));
      bulkOrderVersion.value = result.towerOrderVersion;
    }
    activeLine.value = {
      ...line,
      towerOrderVersion: bulkOrderVersion.value,
      ...(line.towerCount === undefined ? {} : { towerCount: line.towerCount + preview.counts.create }),
    };
    bulkModal.value = false; towerSearch.value = ''; await loadTowers(); await loadLines();
    message.success(`杆塔导入完成：新增 ${preview.counts.create}，更新 ${preview.counts.update}，无变化 ${preview.counts.unchanged}${bulkMode.value === 'full-order' ? '；已按完整清单重排' : ''}`);
  } catch (cause) { message.error(`${cause instanceof Error ? cause.message : '杆塔导入失败'}；已完成部分不会重复写入，可直接继续`); }
  finally { saving.value = false; }
}

type TowerRow = TransmissionTowerSummary & { displayOrder: number };
const towerRows = computed<TowerRow[]>(() => towers.value.map((item, index) => ({ ...item, displayOrder: index + 1 })));
const towerColumns = computed(() => [
  { title: '序号', key: 'displayOrder', width: 64 },
  { title: '杆塔编号', key: 'towerNo', render: (row: TowerRow) => h('div', [h('strong', row.towerNo), row.matchedHistoricalNo ? h('small', `曾用编号匹配：${row.matchedHistoricalNo}`) : null]) },
  { title: '类型', key: 'towerType', render: (row: TowerRow) => row.towerType ?? '—' },
  { title: '状态', key: 'enabled', render: (row: TowerRow) => row.enabled ? '启用' : '停用' },
  ...(isAdmin.value ? [{ title: '操作', key: 'actions', width: 270, render: (row: TowerRow) => h(NSpace, { size: 4 }, { default: () => [
    h(NButton, { size: 'tiny', onClick: () => openTower(row) }, { default: () => '编辑属性' }),
    h(NButton, { size: 'tiny', 'data-test': `open-tower-rename-${row.id}`, onClick: () => openTowerRename(row) }, { default: () => '杆塔更名' }),
    h(NButton, { size: 'tiny', onClick: () => openTowerHistory(row) }, { default: () => '历史' }),
    h(NButton, { size: 'tiny', disabled: saving.value, onClick: () => removeObject('towers', row) }, { default: () => '删除' }),
  ] }) }] : []),
]);

onMounted(loadAll);
</script>

<template>
  <div class="view-stack master-data-view">
    <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>

    <section v-if="!selectedLine" class="line-home" data-test="line-home">
      <header class="page-heading">
        <div><span class="eyebrow">基础台账</span><h2>线路台账</h2><p>以线路为主维护设备位置；电压等级仅作为筛选和线路属性。</p></div>
        <n-space v-if="isAdmin"><n-button @click="settingsModal=true">台账设置</n-button><n-button type="primary" @click="openLine()">新增线路</n-button></n-space>
      </header>
      <div class="line-toolbar">
        <n-select data-test="voltage-filter" :value="lineVoltageFilter" :options="lineVoltageOptions" @update:value="setVoltageFilter" />
        <n-input v-model:value="lineSearch" data-test="line-search" placeholder="搜索当前线路名或曾用名" @keyup.enter="loadLines()" />
        <n-select data-test="line-status-filter" :value="lineStatusFilter" :options="lineStatusOptions" @update:value="setStatusFilter" />
        <n-button :loading="loading" @click="loadLines()">查询</n-button>
      </div>
      <div class="line-list">
        <article v-for="item in lines" :key="item.id" class="line-card">
          <button class="line-open" :data-test="`select-line-${item.id}`" @click="openLineDetail(item)">
            <div class="line-card-title"><n-tag size="small" :bordered="false">{{ item.voltageLevelName }}</n-tag><strong>{{ item.lineName }}</strong></div>
            <p v-if="item.matchedHistoricalName" class="history-match">曾用名匹配：{{ item.matchedHistoricalName }}</p>
            <div class="line-card-meta"><span>{{ item.towerCount ?? 0 }} 基杆塔</span><span>{{ item.enabled ? '启用' : '停用' }}</span><span v-if="item.lineCode">{{ item.lineCode }}</span></div>
          </button>
          <div v-if="isAdmin" class="line-card-actions"><n-button text size="tiny" @click="openLine(item)">编辑属性</n-button><n-button text size="tiny" :disabled="saving" @click="removeObject('lines',item)">删除</n-button></div>
        </article>
      </div>
      <n-empty v-if="!lines.length && !loading" description="没有符合条件的线路" />
      <n-button v-if="lineCursor" :loading="loading" @click="loadLines(true)">加载更多线路</n-button>
    </section>

    <section v-else class="line-detail" data-test="line-detail">
      <button class="back-button" data-test="back-lines" @click="backToLines">← 返回线路台账</button>
      <header class="detail-heading">
        <div>
          <div class="detail-title-row"><n-tag :bordered="false">{{ selectedLine.voltageLevelName }}</n-tag><h2>{{ selectedLine.lineName }}</h2></div>
          <p>{{ selectedLine.towerCount ?? towers.length }} 基杆塔 · {{ selectedLine.enabled ? '启用' : '停用' }}<template v-if="selectedLine.lineCode"> · {{ selectedLine.lineCode }}</template></p>
          <p v-if="selectedLine.matchedHistoricalName" class="history-match">由曾用名“{{ selectedLine.matchedHistoricalName }}”匹配到当前线路</p>
        </div>
        <n-space v-if="isAdmin" class="detail-actions">
          <n-button @click="openLine(selectedLine)">编辑属性</n-button>
          <n-button data-test="open-line-rename" @click="openLineRename">线路更名</n-button>
          <n-button @click="openLineHistory">名称历史</n-button>
          <n-button data-test="open-new-tower" :disabled="!selectedLine.enabled || !selectedVoltage?.enabled" @click="openTower()">新增杆塔</n-button>
          <n-button data-test="open-bulk-towers" :disabled="!selectedLine.enabled || !selectedVoltage?.enabled" @click="openBulk">导入杆塔</n-button>
          <n-button data-test="open-order-editor" @click="openOrderEditor">调整顺序</n-button>
        </n-space>
      </header>
      <div class="tower-toolbar">
        <n-input v-model:value="towerSearch" placeholder="输入 10、10-1 等当前或曾用编号" @keyup.enter="loadTowers()" />
        <n-button @click="loadTowers()">查找杆塔</n-button>
        <n-button v-if="towerSearch" @click="towerSearch='';loadTowers()">清除</n-button>
      </div>
      <n-data-table v-if="towerRows.length" :columns="towerColumns" :data="towerRows" :pagination="false" :scroll-x="760" />
      <n-empty v-else description="当前线路下暂无匹配杆塔" />
      <n-button v-if="towerCursor" @click="loadTowers(true)">加载更多杆塔</n-button>
    </section>

    <n-modal v-model:show="settingsModal" preset="card" title="台账设置" style="width:min(700px,calc(100vw - 32px))">
      <div class="settings-head"><p>维护全系统统一使用的电压等级。</p><n-button v-if="isAdmin" type="primary" @click="openVoltage()">新增电压等级</n-button></div>
      <div class="setting-row" v-for="item in voltageLevels" :key="item.id"><div><strong>{{ item.displayName }}</strong><small>{{ item.code }} · {{ item.systemType==='AC' ? '交流' : '直流' }} · {{ item.enabled ? '启用' : '停用' }}</small></div><n-space><n-button size="small" @click="openVoltage(item)">编辑</n-button><n-button size="small" :disabled="saving" @click="removeObject('voltage-levels',item)">删除</n-button></n-space></div>
    </n-modal>

    <n-modal v-model:show="voltageModal" preset="card" title="电压等级" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="显示名称"><n-input v-model:value="voltageForm.displayName" /></n-form-item><n-form-item label="内部编码"><n-input v-model:value="voltageForm.code" /></n-form-item><n-form-item label="制式"><n-select v-model:value="voltageForm.systemType" :options="systemOptions" /></n-form-item><n-form-item label="标称电压 kV"><n-input v-model:value="voltageForm.nominalKv" /></n-form-item><n-form-item label="排序"><n-input v-model:value="voltageForm.sortOrder" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="voltageForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="voltageModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveVoltage">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="lineModal" preset="card" :title="editingLine ? '编辑线路属性' : '新增线路'" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="电压等级"><n-select v-model:value="lineForm.voltageLevelId" :options="voltageOptions" /></n-form-item><n-form-item label="线路名称"><span v-if="editingLine">{{ editingLine.lineName }}（更名请使用“线路更名”）</span><n-input v-else v-model:value="lineForm.lineName" placeholder="请输入线路名称" /></n-form-item><n-form-item label="线路编码（可选）"><n-input v-model:value="lineForm.lineCode" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="lineForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="lineModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveLine">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="lineRenameModal" preset="card" title="线路更名" style="width:min(520px,calc(100vw - 32px))">
      <n-alert type="info" :bordered="false">更名不会创建新线路；稳定 ID 不变，旧名称永久进入历史并可继续搜索。</n-alert>
      <n-form label-placement="top"><n-form-item label="新线路名称"><n-input data-test="line-rename-input" v-model:value="lineRenameForm.lineName" /></n-form-item><n-form-item label="更名原因（可选）"><n-input v-model:value="lineRenameForm.reason" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="lineRenameModal=false">取消</n-button><n-button data-test="save-line-rename" type="primary" :loading="saving" @click="saveLineRename">确认更名</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="towerModal" preset="card" :title="editingTower ? '编辑杆塔属性' : '新增杆塔'" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="所属线路"><span>{{ selectedLine?.lineName }}</span></n-form-item><n-form-item label="杆塔编号"><span v-if="editingTower">{{ editingTower.towerNo }}（更名请使用“杆塔更名”）</span><n-input v-else v-model:value="towerForm.towerNo" data-test="tower-number-input" placeholder="例如：10-1" /></n-form-item><n-alert v-if="!editingTower" type="info" :bordered="false">新增杆塔会按规范化编号自动插入合适位置，后续仍可手动调整顺序。</n-alert><n-form-item label="杆塔类型（可选）"><n-input v-model:value="towerForm.towerType" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="towerForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="towerModal=false">取消</n-button><n-button data-test="save-tower" type="primary" :loading="saving" @click="saveTower">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="towerRenameModal" preset="card" title="杆塔更名" style="width:min(520px,calc(100vw - 32px))">
      <n-alert type="info" :bordered="false">更名只改变当前编号；杆塔稳定 ID、业务引用和历史链保持不变。</n-alert>
      <n-form label-placement="top"><n-form-item label="新杆塔编号"><n-input data-test="tower-rename-input" v-model:value="towerRenameForm.towerNo" placeholder="例如：21-1" /></n-form-item><n-form-item label="更名原因（可选）"><n-input v-model:value="towerRenameForm.reason" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="towerRenameModal=false">取消</n-button><n-button data-test="save-tower-rename" type="primary" :loading="saving" @click="saveTowerRename">确认更名</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="historyModal" preset="card" :title="historyTitle" style="width:min(640px,calc(100vw - 32px))">
      <p>当前：<strong>{{ historyCurrent }}</strong></p>
      <div v-if="historyRows.length" class="history-list"><div v-for="row in historyRows" :key="`${row.value}-${row.validFrom}`"><strong>{{ row.value }}</strong><span>{{ row.validFrom }} → {{ row.validTo }}</span><small v-if="row.reason">{{ row.reason }}</small></div></div>
      <n-empty v-else description="暂无更名历史" />
    </n-modal>

    <n-modal v-model:show="orderModal" preset="card" title="调整杆塔顺序" style="width:min(720px,calc(100vw - 32px))">
      <p>可拖动短距离调整；长距离可选择“移动杆塔 → 目标杆塔 → 目标前/后”。保存时一次性提交完整稳定 ID 顺序。</p>
      <div class="order-controls"><n-select data-test="order-moving" v-model:value="orderMoving" :options="orderOptions" /><n-select data-test="order-target" v-model:value="orderTarget" :options="orderOptions" /><n-select v-model:value="orderPlacement" :options="placementOptions" /><n-button data-test="apply-order-move" @click="applyOrderMove">应用移动</n-button></div>
      <div class="order-list"><div v-for="(item,index) in orderDraft" :key="item.id" class="order-row" draggable="true" @dragstart="draggingTowerId=item.id" @dragover.prevent @drop="dropOrder(item.id)"><span class="drag-handle">≡</span><b>{{ index+1 }}</b><strong>{{ item.towerNo }}</strong><span>{{ item.towerType ?? '—' }}</span></div></div>
      <template #footer><div class="actions"><n-button @click="orderModal=false">取消</n-button><n-button data-test="save-order" type="primary" :loading="saving" @click="saveOrder">保存顺序</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="bulkModal" preset="card" title="导入杆塔" style="width:min(780px,calc(100vw - 32px))">
      <p>当前线路：{{ selectedLine?.lineName }}。可选择 .xlsx / .csv，或直接从表格粘贴“杆塔编号、杆塔类型、状态”。系统会先规范编号并与完整线路台账对比，再一次确认导入。</p>
      <n-form-item label="导入模式"><n-select data-test="tower-import-mode" :value="bulkMode" :options="bulkModeOptions" @update:value="setBulkMode" /></n-form-item>
      <n-alert v-if="bulkMode==='full-order'" type="warning" :bordered="false">完整清单模式要求当前线路每个杆塔对象都在文件中唯一出现；不会把缺失行当作删除。导入完成后，文件行顺序将成为线路顺序。</n-alert>
      <div class="tower-import-source"><input data-test="tower-import-file" type="file" accept=".xlsx,.csv" :disabled="bulkPreparing || saving" @change="onBulkFile" /><span>或</span><n-button size="small" :loading="bulkPreparing" data-test="preview-bulk-towers" @click="previewBulkPaste">预览粘贴数据</n-button></div>
      <n-input v-model:value="bulkText" data-test="bulk-tower-text" type="textarea" :rows="8" placeholder="杆塔编号[TAB]杆塔类型[TAB]状态，例如：10-1    角钢塔    启用。第一行也可以带表头。" />
      <div v-if="bulkPreview" class="tower-import-preview" data-test="tower-import-preview"><p><strong>{{ bulkSourceLabel }}</strong>：共 {{ bulkPreview.counts.total }} 行；新增 {{ bulkPreview.counts.create }}，更新 {{ bulkPreview.counts.update }}，无变化 {{ bulkPreview.counts.unchanged }}，错误 {{ bulkPreview.counts.error }}。</p><p v-if="!bulkPreview.counts.error && !bulkGlobalErrors.length">{{ bulkMode==='full-order' ? '完整清单校验通过；属性变化会先自动分批写入，随后按文件顺序原子重排。' : '系统将自动分批写入；新增杆塔按规范编号自动插入合适位置，不改变已有杆塔的人工顺序。' }}</p><div v-if="bulkPreview.counts.error" class="tower-import-errors"><p v-for="row in bulkPreview.rows.filter(item => item.action === 'error').slice(0,20)" :key="`${row.source}-${row.rowNumber}`">{{ row.source }}第 {{ row.rowNumber }} 行：{{ row.message }}</p><p v-if="bulkPreview.counts.error > 20">另有 {{ bulkPreview.counts.error - 20 }} 条错误，请修正后重新预览。</p></div><div v-if="bulkGlobalErrors.length" class="tower-import-errors"><p v-for="issue in bulkGlobalErrors" :key="issue">{{ issue }}</p></div><p v-if="bulkChunks.length">进度：{{ bulkProcessed }} / {{ bulkChunks.reduce((total, chunk) => total + chunk.length, 0) }} 条需要写入的数据。</p></div>
      <template #footer><div class="actions"><n-button @click="bulkModal=false">取消</n-button><n-button data-test="save-bulk-towers" type="primary" :loading="saving" :disabled="!bulkPreview || bulkPreview.counts.error>0 || bulkGlobalErrors.length>0" @click="saveBulk">{{ bulkNextChunk > 0 ? '继续导入' : '开始导入' }}</n-button></div></template>
    </n-modal>
  </div>
</template>

<style scoped>
.master-data-view{max-width:1480px;margin:0 auto}.page-heading,.detail-heading{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:20px 22px;border:1px solid #e5e9f0;border-radius:16px;background:#fff}.eyebrow{font-size:11px;font-weight:700;color:#315fd3;letter-spacing:.08em}.page-heading h2,.detail-heading h2{margin:4px 0 5px;font-size:24px}.page-heading p,.detail-heading p{margin:0;color:#7b8493}.line-toolbar,.tower-toolbar{display:grid;grid-template-columns:minmax(170px,220px) minmax(240px,1fr) minmax(150px,190px) auto;gap:10px;margin:16px 0}.tower-toolbar{grid-template-columns:minmax(260px,1fr) auto auto}.line-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.line-card{border:1px solid #e5e9f0;border-radius:14px;background:#fff;overflow:hidden}.line-open{display:block;width:100%;padding:17px;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer}.line-open:hover{background:#f8faff}.line-card-title{display:flex;align-items:center;gap:10px;font-size:16px}.line-card-meta{display:flex;gap:16px;margin-top:12px;color:#737d8d;font-size:12px}.history-match{color:#7a5af8!important;font-size:12px}.line-card-actions{display:flex;gap:14px;padding:0 17px 13px}.back-button{border:0;background:transparent;color:#315fd3;cursor:pointer;padding:4px 0 10px}.detail-title-row{display:flex;align-items:center;gap:10px}.detail-actions{justify-content:flex-end}.actions{display:flex;justify-content:flex-end;gap:10px}.settings-head{display:flex;justify-content:space-between;align-items:center}.setting-row{display:flex;justify-content:space-between;gap:15px;align-items:center;padding:12px 0;border-top:1px solid #edf0f4}.setting-row div:first-child{display:flex;flex-direction:column;gap:3px}.setting-row small{color:#7b8493}.history-list>div{display:grid;grid-template-columns:minmax(120px,1fr) minmax(220px,1.6fr);gap:6px 14px;padding:11px 0;border-top:1px solid #edf0f4}.history-list small{grid-column:1/-1;color:#7b8493}.order-controls{display:grid;grid-template-columns:1fr 1fr 150px auto;gap:8px;margin:12px 0}.order-list{max-height:420px;overflow:auto;border:1px solid #e5e9f0;border-radius:10px}.order-row{display:grid;grid-template-columns:26px 42px 120px 1fr;gap:8px;align-items:center;padding:9px 12px;border-bottom:1px solid #edf0f4;background:#fff}.drag-handle{cursor:grab;color:#8a94a4}.tower-import-source{display:flex;align-items:center;gap:10px;margin:12px 0}.tower-import-preview{margin-top:14px;padding:12px 14px;border-radius:10px;background:#f7f9fc;border:1px solid #e6eaf1}.tower-import-preview p{margin:5px 0}.tower-import-errors{max-height:180px;overflow:auto;color:#b42318}
@media(max-width:900px){.line-list{grid-template-columns:1fr}.page-heading,.detail-heading{flex-direction:column}.line-toolbar{grid-template-columns:1fr 1fr}.detail-actions{justify-content:flex-start}.order-controls{grid-template-columns:1fr 1fr}.order-row{grid-template-columns:24px 34px 100px 1fr}}
@media(max-width:600px){.line-toolbar,.tower-toolbar,.order-controls{grid-template-columns:1fr}.page-heading,.detail-heading{padding:16px}.page-heading h2,.detail-heading h2{font-size:20px}.line-card-meta{flex-wrap:wrap}.tower-import-source{align-items:flex-start;flex-direction:column}}
</style>
