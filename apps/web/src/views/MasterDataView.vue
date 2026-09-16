<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NDataTable, NDropdown, NEmpty, NForm, NFormItem, NInput, NModal, NSelect,
  NSpace, NSwitch, NTabPane, NTabs, NTag, useMessage,
} from 'naive-ui';
import {
  type CustomFieldDataType,
  type CustomFieldDefinitionSummary,
  type CustomFieldEntityType,
  normalizeTowerNo,
  type CurrentUser,
  type LineTowerPositionNoHistoryEntry,
  type LineTowerPositionSummary,
  type PhysicalTowerSummary,
  type TeamSummary,
  type TransmissionLineNameHistoryEntry,
  type TransmissionLineSummary,
  type TowerTypeSummary,
  type VoltageLevelSummary,
  type VoltageSystemType,
} from '@tpm/shared';
import { apiRequest, jsonRequestInit } from '../api/client';
import { formatBusinessDateTime } from '../businessTime';
import { parseFileInWorker } from '../imports/workerClient';
import AppPressable from '../app/AppPressable.vue';
import AppFilePicker from '../app/AppFilePicker.vue';
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
const towers = ref<LineTowerPositionSummary[]>([]);
const physicalTowers = ref<PhysicalTowerSummary[]>([]);
const teams = ref<TeamSummary[]>([]);
const towerTypes = ref<TowerTypeSummary[]>([]);
const customFields = ref<CustomFieldDefinitionSummary[]>([]);
const lineCursor = ref<string | null>(null);
const towerCursor = ref<string | null>(null);
const lineVoltageFilter = ref('all');
const lineStatusFilter = ref<'all' | 'enabled' | 'disabled'>('all');
const lineSearch = ref('');
const towerSearch = ref('');
const loading = ref(false);
const towerLoading = ref(false);
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
    error.value = '';
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
  towerLoading.value = true;
  try {
    const params = new URLSearchParams({ lineId: line.id, limit: '100' });
    if (towerSearch.value.trim()) params.set('query', towerSearch.value.trim());
    if (append && towerCursor.value) params.set('cursor', towerCursor.value);
    const data: { items: LineTowerPositionSummary[]; nextCursor?: string | null } = await apiRequest(`/api/master/towers?${params.toString()}`);
    if (token !== towerRequest) return;
    error.value = '';
    towers.value = append ? [...towers.value, ...data.items] : data.items;
    towerCursor.value = data.nextCursor ?? null;
  } catch (cause) {
    if (token === towerRequest) error.value = cause instanceof Error ? cause.message : '杆塔读取失败';
  } finally {
    if (token === towerRequest) towerLoading.value = false;
  }
}

async function loadAll() {
  error.value = '';
  loading.value = true;
  try {
    await loadVoltageLevels();
    await loadLines();
    if (activeLine.value) await loadTowers();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '基础台账读取失败';
  } finally {
    loading.value = false;
  }
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

type DeleteKind = 'voltage-levels' | 'lines' | 'towers' | 'teams' | 'tower-types' | 'custom-fields';
type DeleteTarget = { kind: DeleteKind; item: { id: string; version: number; lineId?: string }; label: string };
const deleteConfirmModal = ref(false);
const deleteTarget = ref<DeleteTarget | null>(null);
function requestDelete(kind: DeleteKind, item: DeleteTarget['item'], label: string) {
  deleteTarget.value = { kind, item, label };
  deleteConfirmModal.value = true;
}
async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  deleteConfirmModal.value = false;
  deleteTarget.value = null;
  await removeObject(target.kind, target.item);
}

async function removeObject(kind: DeleteKind, item: { id: string; version: number; lineId?: string }) {
  saving.value = true;
  try {
    await apiRequest(`/api/master/${kind}/${item.id}`, jsonRequestInit('DELETE', { expectedVersion: item.version }));
    if (kind === 'voltage-levels') {
      voltageLevels.value = voltageLevels.value.filter((row) => row.id !== item.id);
      if (lineVoltageFilter.value === item.id) {
        lineVoltageFilter.value = 'all';
        lineCursor.value = null;
        await loadLines();
      }
    } else if (kind === 'lines') {
      lines.value = lines.value.filter((row) => row.id !== item.id);
      if (activeLine.value?.id === item.id) backToLines();
    } else if (kind === 'towers') {
      towers.value = towers.value.filter((row) => row.id !== item.id);
      if (item.lineId) {
        lines.value = lines.value.map((line) => line.id === item.lineId ? {
          ...line,
          towerCount: Math.max(0, (line.towerCount ?? 0) - 1),
          towerOrderVersion: line.towerOrderVersion + 1,
        } : line);
        if (activeLine.value?.id === item.lineId) {
          activeLine.value = {
            ...activeLine.value,
            towerCount: Math.max(0, (activeLine.value.towerCount ?? towers.value.length + 1) - 1),
            towerOrderVersion: activeLine.value.towerOrderVersion + 1,
          };
        }
      }
    } else {
      await loadConfigChoices();
    }
    message.success('已删除未引用的台账对象');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '删除失败'); }
  finally { saving.value = false; }
}

const settingsModal = ref(false);
const settingsTab = ref<'voltage' | 'teams' | 'tower-types' | 'custom-fields'>('voltage');
const voltageModal = ref(false);
const teamModal = ref(false);
const towerTypeModal = ref(false);
const customFieldModal = ref(false);
const lineModal = ref(false);
const towerModal = ref(false);
const physicalTowerModal = ref(false);
const rebindPhysicalModal = ref(false);
const customValuesModal = ref(false);
const editingVoltage = ref<VoltageLevelSummary | null>(null);
const editingTeam = ref<TeamSummary | null>(null);
const editingTowerType = ref<TowerTypeSummary | null>(null);
const editingCustomField = ref<CustomFieldDefinitionSummary | null>(null);
const editingLine = ref<TransmissionLineSummary | null>(null);
const editingTower = ref<LineTowerPositionSummary | null>(null);
const editingPhysicalTower = ref<PhysicalTowerSummary | null>(null);
const rebindTower = ref<LineTowerPositionSummary | null>(null);
const customValuesTower = ref<PhysicalTowerSummary | null>(null);
const saving = ref(false);
const voltageForm = ref({ displayName: '', code: '', systemType: 'AC' as VoltageSystemType, nominalKv: '', sortOrder: '', enabled: true });
const teamForm = ref({ code: '', name: '', enabled: true });
const towerTypeForm = ref({ code: '', label: '', sortOrder: '', enabled: true });
const customFieldForm = ref({
  entityType: 'physical_tower' as CustomFieldEntityType,
  fieldKey: '', label: '', dataType: 'text' as CustomFieldDataType,
  required: false, filterable: false, optionsText: '', min: '', max: '', maxLength: '', minItems: '', maxItems: '', sortOrder: '', enabled: true,
});
const lineForm = ref({ voltageLevelId: '', lineCode: '', lineName: '', enabled: true });
const towerForm = ref({ lineId: '', towerNo: '', physicalTowerId: '', assetCode: '', towerTypeId: '', maintenanceTeamId: '', positionLabel: '', enabled: true });
const physicalTowerForm = ref({ assetCode: '', towerTypeId: '', maintenanceTeamId: '', enabled: true });
const rebindPhysicalTowerId = ref('');
const customValuesVersion = ref<number | null>(null);
const customValueForm = ref<Record<string, unknown>>({});
const physicalTowerMode = ref<'new' | 'existing'>('new');
const physicalTowerModeOptions = [{ label: '新建物理杆塔', value: 'new' }, { label: '关联已有物理杆塔（同塔线路）', value: 'existing' }];
const physicalTowerOptions = computed(() => physicalTowers.value.filter((item) => item.enabled).map((item) => ({
  label: `${item.assetCode ?? '未编号物理塔'} · ${item.towerTypeLabel ?? '未配置塔型'} · 已关联 ${item.linePositionCount ?? 0} 个线路节点`,
  value: item.id,
})));
const teamOptions = computed(() => teams.value.filter((item) => item.enabled).map((item) => ({ label: item.name, value: item.id })));
const towerTypeOptions = computed(() => towerTypes.value.filter((item) => item.enabled).map((item) => ({ label: item.label, value: item.id })));
const customFieldEntityOptions: Array<{ label: string; value: CustomFieldEntityType }> = [
  { label: '物理杆塔', value: 'physical_tower' },
  { label: '线路', value: 'transmission_line' },
  { label: '线路杆塔节点', value: 'line_tower_position' },
  { label: '需求', value: 'demand' },
  { label: '项目', value: 'project' },
  { label: '执行任务', value: 'project_task' },
];
const customFieldTypeOptions: Array<{ label: string; value: CustomFieldDataType }> = [
  { label: '文本', value: 'text' }, { label: '整数', value: 'integer' }, { label: '数量', value: 'quantity' },
  { label: '年度', value: 'year' }, { label: '布尔值', value: 'boolean' }, { label: '日期', value: 'date' },
  { label: '单选', value: 'single_select' }, { label: '多选', value: 'multi_select' },
];
const customFieldEntityLabel = (value: CustomFieldEntityType) => customFieldEntityOptions.find((item) => item.value === value)?.label ?? value;
const customFieldTypeLabel = (value: CustomFieldDataType) => customFieldTypeOptions.find((item) => item.value === value)?.label ?? value;
const customFieldNeedsOptions = computed(() => customFieldForm.value.dataType === 'single_select' || customFieldForm.value.dataType === 'multi_select');
const customFieldIsNumeric = computed(() => ['integer', 'quantity', 'year'].includes(customFieldForm.value.dataType));
const physicalCustomFields = computed(() => customFields.value.filter((item) => item.entityType === 'physical_tower' && item.enabled));

async function loadPhysicalTowerChoices() {
  const [physical, teamData, towerTypeData] = await Promise.all([
    apiRequest<{ items: PhysicalTowerSummary[] }>('/api/master/physical-towers?limit=100'),
    apiRequest<{ items: TeamSummary[] }>('/api/master/teams'),
    apiRequest<{ items: TowerTypeSummary[] }>('/api/master/tower-types'),
  ]);
  physicalTowers.value = physical.items;
  teams.value = teamData.items;
  towerTypes.value = towerTypeData.items;
}

async function loadConfigChoices() {
  const [teamData, towerTypeData, customFieldData] = await Promise.all([
    apiRequest<{ items: TeamSummary[] }>('/api/master/teams'),
    apiRequest<{ items: TowerTypeSummary[] }>('/api/master/tower-types'),
    apiRequest<{ items: CustomFieldDefinitionSummary[] }>('/api/master/custom-fields'),
  ]);
  teams.value = teamData.items;
  towerTypes.value = towerTypeData.items;
  customFields.value = customFieldData.items;
}

async function openSettings() {
  settingsModal.value = true;
  try { await loadConfigChoices(); }
  catch (cause) { message.error(cause instanceof Error ? cause.message : '配置读取失败'); }
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
    if (editingVoltage.value) await apiRequest(`/api/master/voltage-levels/${editingVoltage.value.id}`, jsonRequestInit('PATCH', { ...body, expectedVersion: editingVoltage.value.version }));
    else await apiRequest('/api/master/voltage-levels', jsonRequestInit('POST', body));
    voltageModal.value = false;
    await loadVoltageLevels();
    await loadLines();
    message.success('电压等级已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

function openTeam(item?: TeamSummary) {
  editingTeam.value = item ?? null;
  teamForm.value = item ? { code: item.code ?? '', name: item.name, enabled: item.enabled } : { code: '', name: '', enabled: true };
  teamModal.value = true;
}

async function saveTeam() {
  const name = teamForm.value.name.trim();
  if (!name) { message.warning('班组名称不能为空'); return; }
  saving.value = true;
  try {
    const body = { code: teamForm.value.code.trim() || null, name, enabled: teamForm.value.enabled };
    if (editingTeam.value) await apiRequest(`/api/master/teams/${editingTeam.value.id}`, jsonRequestInit('PATCH', { ...body, expectedVersion: editingTeam.value.version }));
    else await apiRequest('/api/master/teams', jsonRequestInit('POST', body));
    teamModal.value = false;
    await loadConfigChoices();
    message.success('班组配置已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '班组保存失败'); }
  finally { saving.value = false; }
}

function openTowerType(item?: TowerTypeSummary) {
  editingTowerType.value = item ?? null;
  towerTypeForm.value = item
    ? { code: item.code ?? '', label: item.label, sortOrder: String(item.sortOrder), enabled: item.enabled }
    : { code: '', label: '', sortOrder: String((towerTypes.value.length + 1) * 10), enabled: true };
  towerTypeModal.value = true;
}

async function saveTowerType() {
  const label = towerTypeForm.value.label.trim(), sortOrder = Number(towerTypeForm.value.sortOrder);
  if (!label || !Number.isInteger(sortOrder) || sortOrder < 0) { message.warning('请填写杆塔类型名称和有效排序'); return; }
  saving.value = true;
  try {
    const body = { code: towerTypeForm.value.code.trim() || null, label, sortOrder, enabled: towerTypeForm.value.enabled };
    if (editingTowerType.value) await apiRequest(`/api/master/tower-types/${editingTowerType.value.id}`, jsonRequestInit('PATCH', { ...body, expectedVersion: editingTowerType.value.version }));
    else await apiRequest('/api/master/tower-types', jsonRequestInit('POST', body));
    towerTypeModal.value = false;
    await loadConfigChoices();
    message.success('杆塔类型已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '杆塔类型保存失败'); }
  finally { saving.value = false; }
}

function ruleText(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}

function openCustomField(item?: CustomFieldDefinitionSummary) {
  editingCustomField.value = item ?? null;
  const validation = item?.validation ?? {};
  customFieldForm.value = item ? {
    entityType: item.entityType,
    fieldKey: item.fieldKey,
    label: item.label,
    dataType: item.dataType,
    required: item.required,
    filterable: item.filterable,
    optionsText: Array.isArray(item.options) ? item.options.join('\n') : '',
    min: ruleText(validation.min),
    max: ruleText(validation.max),
    maxLength: ruleText(validation.maxLength),
    minItems: ruleText(validation.minItems),
    maxItems: ruleText(validation.maxItems),
    sortOrder: String(item.sortOrder),
    enabled: item.enabled,
  } : {
    entityType: 'physical_tower', fieldKey: '', label: '', dataType: 'text', required: false, filterable: false,
    optionsText: '', min: '', max: '', maxLength: '', minItems: '', maxItems: '', sortOrder: String((customFields.value.length + 1) * 10), enabled: true,
  };
  customFieldModal.value = true;
}

function optionalRuleNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

async function saveCustomField() {
  const form = customFieldForm.value;
  const fieldKey = form.fieldKey.trim().toLowerCase(), label = form.label.trim(), sortOrder = Number(form.sortOrder);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(fieldKey) || !label || !Number.isInteger(sortOrder) || sortOrder < 0) {
    message.warning('字段键必须以小写字母开头且只含小写字母、数字、下划线；同时请填写名称和排序'); return;
  }
  const validation: Record<string, number> = {};
  for (const [key, raw] of [
    ['min', form.min], ['max', form.max], ['maxLength', form.maxLength], ['minItems', form.minItems], ['maxItems', form.maxItems],
  ] as const) {
    const parsed = optionalRuleNumber(raw);
    if (Number.isNaN(parsed)) { message.warning('自定义字段校验规则必须填写数字'); return; }
    if (parsed !== undefined) validation[key] = parsed;
  }
  const options = form.optionsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (customFieldNeedsOptions.value && (!options.length || new Set(options).size !== options.length)) {
    message.warning('单选/多选字段必须配置至少一个且不重复的选项'); return;
  }
  saving.value = true;
  try {
    const body = {
      entityType: form.entityType,
      fieldKey,
      label,
      dataType: form.dataType,
      required: form.required,
      filterable: form.filterable,
      ...(customFieldNeedsOptions.value ? { options } : {}),
      validation,
      sortOrder,
      enabled: form.enabled,
    };
    if (editingCustomField.value) await apiRequest(`/api/master/custom-fields/${editingCustomField.value.id}`, jsonRequestInit('PATCH', { ...body, expectedVersion: editingCustomField.value.version }));
    else await apiRequest('/api/master/custom-fields', jsonRequestInit('POST', body));
    customFieldModal.value = false;
    await loadConfigChoices();
    message.success('自定义字段已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '自定义字段保存失败'); }
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

async function openTower(item?: LineTowerPositionSummary) {
  editingTower.value = item ?? null;
  towerForm.value = item
    ? {
        lineId: item.lineId,
        towerNo: item.towerNo,
        physicalTowerId: item.physicalTowerId,
        assetCode: item.physicalAssetCode ?? '',
        towerTypeId: item.towerTypeId ?? '',
        maintenanceTeamId: item.maintenanceTeamId ?? '',
        positionLabel: item.positionLabel ?? '',
        enabled: item.enabled,
      }
    : { lineId: activeLine.value?.id ?? '', towerNo: '', physicalTowerId: '', assetCode: '', towerTypeId: '', maintenanceTeamId: '', positionLabel: '', enabled: true };
  physicalTowerMode.value = item ? 'existing' : 'new';
  towerModal.value = true;
  if (!item) {
    try { await loadPhysicalTowerChoices(); }
    catch (cause) { message.error(cause instanceof Error ? cause.message : '物理杆塔配置读取失败'); }
  }
}

async function saveTower() {
  const towerNo = normalizeTowerNo(towerForm.value.towerNo);
  if (!towerForm.value.lineId || !towerNo) { message.warning('请选择线路，并填写如 10、10-1、#010 的有效杆塔编号'); return; }
  saving.value = true;
  try {
    const body = editingTower.value
      ? {
          lineId: towerForm.value.lineId,
          physicalTowerId: editingTower.value.physicalTowerId,
          towerNo,
          positionLabel: towerForm.value.positionLabel.trim() || null,
          enabled: towerForm.value.enabled,
        }
      : {
          lineId: towerForm.value.lineId,
          towerNo,
          positionLabel: towerForm.value.positionLabel.trim() || null,
          physicalTowerId: physicalTowerMode.value === 'existing' ? towerForm.value.physicalTowerId : null,
          assetCode: physicalTowerMode.value === 'new' ? towerForm.value.assetCode.trim() || null : null,
          towerTypeId: physicalTowerMode.value === 'new' ? towerForm.value.towerTypeId || null : null,
          maintenanceTeamId: physicalTowerMode.value === 'new' ? towerForm.value.maintenanceTeamId || null : null,
          enabled: towerForm.value.enabled,
        };
    if (!editingTower.value && physicalTowerMode.value === 'existing' && !towerForm.value.physicalTowerId) {
      message.warning('请选择需要关联的物理杆塔'); return;
    }
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

async function openPhysicalTower(row: LineTowerPositionSummary) {
  try {
    await loadPhysicalTowerChoices();
    const physical = physicalTowers.value.find((item) => item.id === row.physicalTowerId);
    if (!physical) { message.error('物理杆塔不存在或当前列表未加载'); return; }
    editingPhysicalTower.value = physical;
    physicalTowerForm.value = {
      assetCode: physical.assetCode ?? '',
      towerTypeId: physical.towerTypeId ?? '',
      maintenanceTeamId: physical.maintenanceTeamId ?? '',
      enabled: physical.enabled,
    };
    physicalTowerModal.value = true;
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '物理杆塔读取失败'); }
}

async function savePhysicalTower() {
  const physical = editingPhysicalTower.value;
  if (!physical) return;
  saving.value = true;
  try {
    await apiRequest(`/api/master/physical-towers/${physical.id}`, jsonRequestInit('PATCH', {
      expectedVersion: physical.version,
      assetCode: physicalTowerForm.value.assetCode.trim() || null,
      towerTypeId: physicalTowerForm.value.towerTypeId || null,
      maintenanceTeamId: physicalTowerForm.value.maintenanceTeamId || null,
      enabled: physicalTowerForm.value.enabled,
    }));
    physicalTowerModal.value = false;
    await Promise.all([loadTowers(), loadPhysicalTowerChoices()]);
    message.success('物理杆塔属性已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '物理杆塔保存失败'); }
  finally { saving.value = false; }
}

async function openRebindPhysical(row: LineTowerPositionSummary) {
  try {
    await loadPhysicalTowerChoices();
    rebindTower.value = row;
    rebindPhysicalTowerId.value = row.physicalTowerId;
    rebindPhysicalModal.value = true;
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '物理杆塔读取失败'); }
}

async function saveRebindPhysical() {
  const row = rebindTower.value;
  if (!row || !rebindPhysicalTowerId.value || rebindPhysicalTowerId.value === row.physicalTowerId) {
    message.warning('请选择另一基物理杆塔'); return;
  }
  saving.value = true;
  try {
    await apiRequest(`/api/master/towers/${row.id}/rebind-physical`, jsonRequestInit('POST', {
      expectedVersion: row.version,
      physicalTowerId: rebindPhysicalTowerId.value,
    }));
    rebindPhysicalModal.value = false;
    await loadTowers();
    message.success('同塔关系已更新');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '同塔关系更新失败'); }
  finally { saving.value = false; }
}

function formValueForField(field: CustomFieldDefinitionSummary, value: unknown): unknown {
  if (field.dataType === 'boolean') return typeof value === 'boolean' ? value : false;
  if (field.dataType === 'multi_select') return Array.isArray(value) ? value : [];
  return value === null || value === undefined ? '' : String(value);
}

function setCustomValue(fieldKey: string, value: unknown) {
  customValueForm.value = { ...customValueForm.value, [fieldKey]: value };
}

async function openCustomValues(row: LineTowerPositionSummary) {
  try {
    await loadConfigChoices();
    const physical = (await apiRequest<{ items: PhysicalTowerSummary[] }>(`/api/master/physical-towers?query=${encodeURIComponent(row.physicalTowerId)}&limit=100`)).items.find((item) => item.id === row.physicalTowerId);
    if (!physical) { message.error('物理杆塔不存在'); return; }
    const data = await apiRequest<{ entityType: 'physical_tower'; entityId: string; version: number | null; values: Record<string, unknown> }>(`/api/master/custom-values/physical_tower/${row.physicalTowerId}`);
    customValuesTower.value = physical;
    customValuesVersion.value = data.version;
    customValueForm.value = Object.fromEntries(physicalCustomFields.value.map((field) => [field.fieldKey, formValueForField(field, data.values[field.fieldKey])]));
    customValuesModal.value = true;
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '自定义字段读取失败'); }
}

async function saveCustomValues() {
  const physical = customValuesTower.value;
  if (!physical) return;
  const values: Record<string, unknown> = {};
  for (const field of physicalCustomFields.value) {
    const raw = customValueForm.value[field.fieldKey];
    if (field.dataType === 'integer' || field.dataType === 'quantity' || field.dataType === 'year') {
      if (raw === '' || raw === null || raw === undefined) continue;
      const number = Number(raw);
      if (!Number.isSafeInteger(number)) { message.warning(`${field.label}必须为整数`); return; }
      values[field.fieldKey] = number;
    } else if (field.dataType === 'boolean') values[field.fieldKey] = Boolean(raw);
    else if (field.dataType === 'multi_select') {
      if (Array.isArray(raw) && raw.length) values[field.fieldKey] = raw;
    } else if (typeof raw === 'string' && raw.trim()) values[field.fieldKey] = raw.trim();
  }
  saving.value = true;
  try {
    const data = await apiRequest<{ version: number; values: Record<string, unknown> }>(`/api/master/custom-values/physical_tower/${physical.id}`, jsonRequestInit('PUT', {
      expectedVersion: customValuesVersion.value,
      values,
    }));
    customValuesVersion.value = data.version;
    customValuesModal.value = false;
    await loadPhysicalTowerChoices();
    message.success('物理杆塔自定义字段已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '自定义字段保存失败'); }
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
const towerRenameTarget = ref<LineTowerPositionSummary | null>(null);
const towerRenameForm = ref({ towerNo: '', reason: '' });
function openTowerRename(item: LineTowerPositionSummary) {
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
    await apiRequest<LineTowerPositionSummary>(`/api/master/towers/${target.id}/rename`, jsonRequestInit('POST', {
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
  historyRows.value = data.items.map((item) => ({ value: item.lineName, validFrom: formatBusinessDateTime(item.validFrom), validTo: formatBusinessDateTime(item.validTo), reason: item.reason }));
  historyModal.value = true;
}
async function openTowerHistory(item: LineTowerPositionSummary) {
  const data = await apiRequest<{ items: LineTowerPositionNoHistoryEntry[] }>(`/api/master/towers/${item.id}/number-history`);
  historyTitle.value = '杆塔编号历史'; historyCurrent.value = item.towerNo;
  historyRows.value = data.items.map((entry) => ({ value: entry.towerNo, validFrom: formatBusinessDateTime(entry.validFrom), validTo: formatBusinessDateTime(entry.validTo), reason: entry.reason }));
  historyModal.value = true;
}

async function loadCompleteTowers(lineId: string): Promise<LineTowerPositionSummary[]> {
  const result: LineTowerPositionSummary[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `/api/master/towers?lineId=${encodeURIComponent(lineId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page: { items: LineTowerPositionSummary[]; nextCursor?: string | null } = await apiRequest(query);
    result.push(...page.items);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return result;
}

const orderModal = ref(false);
const orderDraft = ref<LineTowerPositionSummary[]>([]);
const orderVersion = ref(0);
const orderMoving = ref('');
const orderTarget = ref('');
const orderPlacement = ref<'before' | 'after'>('before');
const draggingTowerId = ref<string | null>(null);
const orderOptions = computed(() => orderDraft.value.map((item, index) => ({
  label: `${index + 1} · ${item.towerNo}${item.towerTypeLabel ? ` · ${item.towerTypeLabel}` : ''}`,
  value: item.id,
})));
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
function moveDraftStep(id: string, direction: -1 | 1) {
  const index = orderDraft.value.findIndex((item) => item.id === id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= orderDraft.value.length) return;
  const next = [...orderDraft.value];
  const current = next[index];
  const target = next[targetIndex];
  if (!current || !target) return;
  next[index] = target;
  next[targetIndex] = current;
  orderDraft.value = next;
}
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
        towerNo: row.towerNo, positionLabel: row.positionLabel, enabled: row.enabled,
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

type TowerRow = LineTowerPositionSummary & { displayOrder: number };
const towerRows = computed<TowerRow[]>(() => towers.value.map((item, index) => ({ ...item, displayOrder: index + 1 })));
const lineMoreOptions = [
  { label: '编辑线路属性', key: 'edit' },
  { label: '线路更名', key: 'rename' },
  { label: '名称历史', key: 'history' },
];
function handleLineMoreAction(key: string) {
  if (!activeLine.value) return;
  if (key === 'edit') openLine(activeLine.value);
  else if (key === 'rename') openLineRename();
  else if (key === 'history') void openLineHistory();
}
const towerMoreOptions = [
  { label: '编辑物理杆塔', key: 'physical' },
  { label: '重新关联物理杆塔', key: 'rebind' },
  { label: '自定义字段', key: 'custom-values' },
  { label: '杆塔更名', key: 'rename' },
  { label: '编号历史', key: 'history' },
  { label: '删除杆塔', key: 'delete' },
];
function handleTowerMoreAction(key: string, row: TowerRow) {
  if (key === 'physical') void openPhysicalTower(row);
  else if (key === 'rebind') void openRebindPhysical(row);
  else if (key === 'custom-values') void openCustomValues(row);
  else if (key === 'rename') openTowerRename(row);
  else if (key === 'history') void openTowerHistory(row);
  else if (key === 'delete') requestDelete('towers', row, `杆塔“${row.towerNo}”`);
}
const towerColumns = computed(() => [
  { title: '序号', key: 'displayOrder', width: 64 },
  { title: '杆塔编号', key: 'towerNo', render: (row: TowerRow) => h('div', [h('strong', row.towerNo), row.matchedHistoricalNo ? h('small', `曾用编号匹配：${row.matchedHistoricalNo}`) : null]) },
  { title: '物理杆塔', key: 'physicalTower', render: (row: TowerRow) => row.physicalAssetCode ?? row.physicalTowerId },
  { title: '杆塔类型', key: 'towerTypeLabel', render: (row: TowerRow) => row.towerTypeLabel ?? '—' },
  { title: '班组', key: 'maintenanceTeamName', render: (row: TowerRow) => row.maintenanceTeamName ?? '—' },
  { title: '同塔位置', key: 'positionLabel', render: (row: TowerRow) => row.positionLabel ?? '—' },
  { title: '状态', key: 'enabled', render: (row: TowerRow) => row.enabled ? '启用' : '停用' },
  ...(isAdmin.value ? [{ title: '操作', key: 'actions', width: 180, render: (row: TowerRow) => h(NSpace, { size: 6 }, { default: () => [
    h(NButton, { size: 'tiny', onClick: () => openTower(row) }, { default: () => '编辑属性' }),
    h(NDropdown, {
      trigger: 'click',
      options: towerMoreOptions,
      disabled: saving.value,
      'data-test': `tower-more-${row.id}`,
      onSelect: (key: string) => handleTowerMoreAction(key, row),
    }, { default: () => h(NButton, { size: 'tiny' }, { default: () => '更多' }) }),
  ] }) }] : []),
]);

onMounted(loadAll);
</script>

<template>
  <div class="view-stack master-data-view">
    <n-alert v-if="error" type="error" title="读取失败">
      <div class="error-recovery"><span>{{ error }}</span><n-button data-test="retry-master-data" size="small" @click="loadAll">重新加载</n-button></div>
    </n-alert>

    <section v-if="!selectedLine" class="line-home" data-test="line-home">
      <header class="page-heading">
        <div><span class="eyebrow">基础台账</span><h2>线路台账</h2><p>以线路为主维护设备位置；电压等级仅作为筛选和线路属性。</p></div>
        <n-space v-if="isAdmin"><n-button data-test="open-master-settings" @click="openSettings">台账设置</n-button><n-button type="primary" @click="openLine()">新增线路</n-button></n-space>
      </header>
      <div class="line-toolbar">
        <n-select data-test="voltage-filter" :value="lineVoltageFilter" :options="lineVoltageOptions" @update:value="setVoltageFilter" />
        <n-input v-model:value="lineSearch" data-test="line-search" placeholder="搜索当前线路名或曾用名" @keyup.enter="loadLines()" />
        <n-select data-test="line-status-filter" :value="lineStatusFilter" :options="lineStatusOptions" @update:value="setStatusFilter" />
        <n-button :loading="loading" @click="loadLines()">查询</n-button>
      </div>
      <div class="line-list">
        <article v-for="item in lines" :key="item.id" class="line-card">
          <app-pressable class="line-open" :data-test="`select-line-${item.id}`" @click="openLineDetail(item)">
            <div class="line-card-title"><n-tag size="small" :bordered="false">{{ item.voltageLevelName }}</n-tag><strong>{{ item.lineName }}</strong></div>
            <p v-if="item.matchedHistoricalName" class="history-match">曾用名匹配：{{ item.matchedHistoricalName }}</p>
            <div class="line-card-meta"><span>{{ item.towerCount ?? 0 }} 基杆塔</span><span>{{ item.enabled ? '启用' : '停用' }}</span><span v-if="item.lineCode">{{ item.lineCode }}</span></div>
          </app-pressable>
          <div v-if="isAdmin" class="line-card-actions"><n-button text size="tiny" @click="openLine(item)">编辑属性</n-button><n-button text size="tiny" :disabled="saving" @click="requestDelete('lines',item,`线路“${item.lineName}”`)">删除</n-button></div>
        </article>
      </div>
      <n-empty v-if="!lines.length && !loading" description="没有符合条件的线路" />
      <n-button v-if="lineCursor" :loading="loading" @click="loadLines(true)">加载更多线路</n-button>
    </section>

    <section v-else class="line-detail" data-test="line-detail">
      <app-pressable class="back-button" data-test="back-lines" @click="backToLines">← 返回线路台账</app-pressable>
      <header class="detail-heading">
        <div>
          <div class="detail-title-row"><n-tag :bordered="false">{{ selectedLine.voltageLevelName }}</n-tag><h2>{{ selectedLine.lineName }}</h2></div>
          <p>{{ selectedLine.towerCount ?? towers.length }} 基杆塔 · {{ selectedLine.enabled ? '启用' : '停用' }}<template v-if="selectedLine.lineCode"> · {{ selectedLine.lineCode }}</template></p>
          <p v-if="selectedLine.matchedHistoricalName" class="history-match">由曾用名“{{ selectedLine.matchedHistoricalName }}”匹配到当前线路</p>
        </div>
        <n-space v-if="isAdmin" class="detail-actions">
          <n-button data-test="open-new-tower" type="primary" :disabled="!selectedLine.enabled || !selectedVoltage?.enabled" @click="openTower()">新增杆塔</n-button>
          <n-button data-test="open-bulk-towers" :disabled="!selectedLine.enabled || !selectedVoltage?.enabled" @click="openBulk">导入杆塔</n-button>
          <n-button data-test="open-order-editor" @click="openOrderEditor">调整顺序</n-button>
          <n-dropdown data-test="line-more-actions" trigger="click" :options="lineMoreOptions" @select="handleLineMoreAction">
            <n-button>更多操作</n-button>
          </n-dropdown>
        </n-space>
      </header>
      <div class="tower-toolbar">
        <n-input v-model:value="towerSearch" placeholder="输入 10、10-1 等当前或曾用编号" @keyup.enter="loadTowers()" />
        <n-button :loading="towerLoading" @click="loadTowers()">查找杆塔</n-button>
        <n-button v-if="towerSearch" @click="towerSearch='';loadTowers()">清除</n-button>
      </div>
      <div v-if="towerRows.length" class="tower-desktop-table">
        <n-data-table :columns="towerColumns" :data="towerRows" :pagination="false" :loading="towerLoading" :scroll-x="760" />
      </div>
      <div v-if="towerRows.length" class="tower-mobile-list" data-test="tower-mobile-list">
        <article v-for="row in towerRows" :key="row.id" class="tower-mobile-card" :data-test="`tower-mobile-card-${row.id}`">
          <div class="tower-mobile-main">
            <span class="tower-mobile-order">{{ row.displayOrder }}</span>
            <div>
              <strong>{{ row.towerNo }}</strong>
              <small v-if="row.matchedHistoricalNo" class="history-match">曾用编号匹配：{{ row.matchedHistoricalNo }}</small>
            </div>
            <n-tag size="small" :bordered="false" :type="row.enabled ? 'success' : 'default'">{{ row.enabled ? '启用' : '停用' }}</n-tag>
          </div>
          <div class="tower-mobile-meta"><span>物理杆塔</span><strong>{{ row.physicalAssetCode ?? row.physicalTowerId }}</strong></div>
          <div class="tower-mobile-meta"><span>杆塔类型</span><strong>{{ row.towerTypeLabel ?? '—' }}</strong></div>
          <div class="tower-mobile-meta"><span>班组</span><strong>{{ row.maintenanceTeamName ?? '—' }}</strong></div>
          <div class="tower-mobile-meta"><span>同塔位置</span><strong>{{ row.positionLabel ?? '—' }}</strong></div>
          <div v-if="isAdmin" class="tower-mobile-actions">
            <n-button size="small" @click="openTower(row)">编辑</n-button>
            <n-dropdown trigger="click" :options="towerMoreOptions" :disabled="saving" @select="(key) => handleTowerMoreAction(key, row)">
              <n-button size="small">更多</n-button>
            </n-dropdown>
          </div>
        </article>
      </div>
      <n-empty v-else-if="!towerLoading" description="当前线路下暂无匹配杆塔" />
      <n-button v-if="towerCursor" :loading="towerLoading" @click="loadTowers(true)">加载更多杆塔</n-button>
    </section>

    <n-modal v-model:show="settingsModal" preset="card" title="台账与字段配置" style="width:min(820px,calc(100vw - 32px))">
      <n-alert type="info" :bordered="false">电压等级、班组、杆塔类型都是稳定配置对象；自定义字段用于长尾业务属性，不需要新增数据库列。已被业务数据使用的配置只能停用，不能直接删除。</n-alert>
      <n-tabs v-model:value="settingsTab" type="line" animated>
        <n-tab-pane name="voltage" tab="电压等级">
          <div class="settings-head"><p>维护线路统一使用的电压等级。</p><n-button v-if="isAdmin" type="primary" @click="openVoltage()">新增电压等级</n-button></div>
          <div class="setting-row" v-for="item in voltageLevels" :key="item.id"><div><strong>{{ item.displayName }}</strong><small>{{ item.code }} · {{ item.systemType==='AC' ? '交流' : '直流' }} · {{ item.enabled ? '启用' : '停用' }}</small></div><n-space><n-button size="small" @click="openVoltage(item)">编辑</n-button><n-button size="small" :disabled="saving" @click="requestDelete('voltage-levels',item,`电压等级“${item.displayName}”`)">删除</n-button></n-space></div>
        </n-tab-pane>
        <n-tab-pane name="teams" tab="班组">
          <div class="settings-head"><p>班组作为稳定对象供物理杆塔等业务引用。</p><n-button type="primary" data-test="open-new-team" @click="openTeam()">新增班组</n-button></div>
          <div class="setting-row" v-for="item in teams" :key="item.id"><div><strong>{{ item.name }}</strong><small>{{ item.code ?? '无编码' }} · {{ item.enabled ? '启用' : '停用' }}</small></div><n-space><n-button size="small" @click="openTeam(item)">编辑</n-button><n-button size="small" @click="requestDelete('teams',item,`班组“${item.name}”`)">删除</n-button></n-space></div>
          <n-empty v-if="!teams.length" description="尚未配置班组" />
        </n-tab-pane>
        <n-tab-pane name="tower-types" tab="杆塔类型">
          <div class="settings-head"><p>杆塔类型属于物理杆塔属性，不属于某条线路的编号节点。</p><n-button type="primary" data-test="open-new-tower-type" @click="openTowerType()">新增杆塔类型</n-button></div>
          <div class="setting-row" v-for="item in towerTypes" :key="item.id"><div><strong>{{ item.label }}</strong><small>{{ item.code ?? '无编码' }} · 排序 {{ item.sortOrder }} · {{ item.enabled ? '启用' : '停用' }}</small></div><n-space><n-button size="small" @click="openTowerType(item)">编辑</n-button><n-button size="small" @click="requestDelete('tower-types',item,`杆塔类型“${item.label}”`)">删除</n-button></n-space></div>
          <n-empty v-if="!towerTypes.length" description="尚未配置杆塔类型" />
        </n-tab-pane>
        <n-tab-pane name="custom-fields" tab="自定义字段">
          <div class="settings-head"><p>新增字段不会修改数据库结构；字段键、对象类型和数据类型创建后不可变。</p><n-button type="primary" data-test="open-new-custom-field" @click="openCustomField()">新增字段</n-button></div>
          <div class="setting-row" v-for="item in customFields" :key="item.id"><div><strong>{{ item.label }}</strong><small>{{ customFieldEntityLabel(item.entityType) }} · {{ item.fieldKey }} · {{ customFieldTypeLabel(item.dataType) }} · {{ item.required ? '必填' : '可选' }} · {{ item.filterable ? '可筛选' : '不建索引' }} · {{ item.enabled ? '启用' : '停用' }}</small></div><n-space><n-button size="small" @click="openCustomField(item)">编辑</n-button><n-button size="small" @click="requestDelete('custom-fields',item,`自定义字段“${item.label}”`)">删除</n-button></n-space></div>
          <n-empty v-if="!customFields.length" description="尚未配置自定义字段" />
        </n-tab-pane>
      </n-tabs>
    </n-modal>

    <n-modal v-model:show="deleteConfirmModal" preset="card" title="确认删除" style="width:min(480px,calc(100vw - 32px))">
      <n-alert type="warning" :bordered="false">删除只允许用于尚未被业务引用的台账对象，删除后不可通过界面恢复。</n-alert>
      <p>确定删除{{ deleteTarget?.label }}吗？</p>
      <template #footer><div class="actions"><n-button @click="deleteConfirmModal=false;deleteTarget=null">取消</n-button><n-button data-test="confirm-master-delete" type="error" :loading="saving" @click="confirmDelete">确认删除</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="voltageModal" preset="card" title="电压等级" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="显示名称"><n-input v-model:value="voltageForm.displayName" /></n-form-item><n-form-item label="内部编码"><n-input v-model:value="voltageForm.code" /></n-form-item><n-form-item label="制式"><n-select v-model:value="voltageForm.systemType" :options="systemOptions" /></n-form-item><n-form-item label="标称电压 kV"><n-input v-model:value="voltageForm.nominalKv" /></n-form-item><n-form-item label="排序"><n-input v-model:value="voltageForm.sortOrder" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="voltageForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="voltageModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveVoltage">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="teamModal" preset="card" :title="editingTeam ? '编辑班组' : '新增班组'" style="width:min(520px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="班组名称"><n-input data-test="team-name-input" v-model:value="teamForm.name" /></n-form-item><n-form-item label="班组编码（可选）"><n-input v-model:value="teamForm.code" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="teamForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="teamModal=false">取消</n-button><n-button data-test="save-team" type="primary" :loading="saving" @click="saveTeam">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="towerTypeModal" preset="card" :title="editingTowerType ? '编辑杆塔类型' : '新增杆塔类型'" style="width:min(520px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="类型名称"><n-input data-test="tower-type-label-input" v-model:value="towerTypeForm.label" /></n-form-item><n-form-item label="类型编码（可选）"><n-input v-model:value="towerTypeForm.code" /></n-form-item><n-form-item label="排序"><n-input v-model:value="towerTypeForm.sortOrder" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="towerTypeForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="towerTypeModal=false">取消</n-button><n-button data-test="save-tower-type" type="primary" :loading="saving" @click="saveTowerType">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="customFieldModal" preset="card" :title="editingCustomField ? '编辑自定义字段' : '新增自定义字段'" style="width:min(640px,calc(100vw - 32px))">
      <n-alert v-if="editingCustomField" type="info" :bordered="false">对象类型、字段键和数据类型决定已保存值的语义，因此创建后锁定。需要变更时请新建字段并停用旧字段。</n-alert>
      <n-form label-placement="top">
        <n-form-item label="所属对象"><n-select data-test="custom-field-entity" v-model:value="customFieldForm.entityType" :options="customFieldEntityOptions" :disabled="Boolean(editingCustomField)" /></n-form-item>
        <n-form-item label="字段键"><n-input data-test="custom-field-key" v-model:value="customFieldForm.fieldKey" :disabled="Boolean(editingCustomField)" placeholder="例如：owner_unit" /></n-form-item>
        <n-form-item label="显示名称"><n-input data-test="custom-field-label" v-model:value="customFieldForm.label" /></n-form-item>
        <n-form-item label="数据类型"><n-select v-model:value="customFieldForm.dataType" :options="customFieldTypeOptions" :disabled="Boolean(editingCustomField)" /></n-form-item>
        <n-form-item v-if="customFieldNeedsOptions" label="可选项（每行一个）"><n-input v-model:value="customFieldForm.optionsText" type="textarea" :rows="5" /></n-form-item>
        <n-form-item v-if="customFieldIsNumeric" label="最小值（可选）"><n-input v-model:value="customFieldForm.min" /></n-form-item>
        <n-form-item v-if="customFieldIsNumeric" label="最大值（可选）"><n-input v-model:value="customFieldForm.max" /></n-form-item>
        <n-form-item v-if="customFieldForm.dataType==='text'" label="最大字符数（可选）"><n-input v-model:value="customFieldForm.maxLength" /></n-form-item>
        <n-form-item v-if="customFieldForm.dataType==='multi_select'" label="最少选择项（可选）"><n-input v-model:value="customFieldForm.minItems" /></n-form-item>
        <n-form-item v-if="customFieldForm.dataType==='multi_select'" label="最多选择项（可选）"><n-input v-model:value="customFieldForm.maxItems" /></n-form-item>
        <n-form-item label="排序"><n-input v-model:value="customFieldForm.sortOrder" /></n-form-item>
        <n-form-item label="必填"><n-switch v-model:value="customFieldForm.required" /></n-form-item>
        <n-form-item label="可筛选"><n-switch v-model:value="customFieldForm.filterable" /></n-form-item>
        <n-form-item label="启用"><n-switch v-model:value="customFieldForm.enabled" /></n-form-item>
      </n-form>
      <template #footer><div class="actions"><n-button @click="customFieldModal=false">取消</n-button><n-button data-test="save-custom-field" type="primary" :loading="saving" @click="saveCustomField">保存</n-button></div></template>
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

    <n-modal v-model:show="towerModal" preset="card" :title="editingTower ? '编辑线路杆塔节点' : '新增线路杆塔节点'" style="width:min(620px,calc(100vw - 32px))">
      <n-form label-placement="top">
        <n-form-item label="所属线路"><span>{{ selectedLine?.lineName }}</span></n-form-item>
        <n-form-item label="杆塔编号"><span v-if="editingTower">{{ editingTower.towerNo }}（更名请使用“杆塔更名”）</span><n-input v-else v-model:value="towerForm.towerNo" data-test="tower-number-input" placeholder="例如：10-1" /></n-form-item>
        <n-alert v-if="!editingTower" type="info" :bordered="false">线路杆塔节点和物理杆塔分开管理。同一基物理塔可以同时关联 A线#001、B线#003 等多个线路节点；新增线路节点仍会按规范化编号自动插入合适位置。</n-alert>
        <template v-if="!editingTower">
          <n-form-item label="物理杆塔关系"><n-select data-test="physical-tower-mode" v-model:value="physicalTowerMode" :options="physicalTowerModeOptions" /></n-form-item>
          <n-form-item v-if="physicalTowerMode==='existing'" label="已有物理杆塔"><n-select data-test="physical-tower-select" v-model:value="towerForm.physicalTowerId" :options="physicalTowerOptions" filterable placeholder="请选择物理杆塔" /></n-form-item>
          <template v-else>
            <n-form-item label="物理资产编号（可选）"><n-input v-model:value="towerForm.assetCode" placeholder="例如：PT-001" /></n-form-item>
            <n-form-item label="杆塔类型（可选）"><n-select v-model:value="towerForm.towerTypeId" :options="towerTypeOptions" clearable placeholder="请选择杆塔类型" /></n-form-item>
            <n-form-item label="运维班组（可选）"><n-select v-model:value="towerForm.maintenanceTeamId" :options="teamOptions" clearable placeholder="请选择班组" /></n-form-item>
          </template>
        </template>
        <template v-else>
          <n-form-item label="物理杆塔"><span>{{ editingTower.physicalAssetCode ?? editingTower.physicalTowerId }}</span></n-form-item>
          <n-form-item label="杆塔类型"><span>{{ editingTower.towerTypeLabel ?? '未配置' }}</span></n-form-item>
          <n-form-item label="运维班组"><span>{{ editingTower.maintenanceTeamName ?? '未配置' }}</span></n-form-item>
        </template>
        <n-form-item label="同塔位置标识（可选）"><n-input v-model:value="towerForm.positionLabel" placeholder="例如：左回、右回、上层" /></n-form-item>
        <n-form-item label="启用"><n-switch v-model:value="towerForm.enabled" /></n-form-item>
      </n-form>
      <template #footer><div class="actions"><n-button @click="towerModal=false">取消</n-button><n-button data-test="save-tower" type="primary" :loading="saving" @click="saveTower">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="physicalTowerModal" preset="card" title="编辑物理杆塔" style="width:min(560px,calc(100vw - 32px))">
      <n-alert type="info" :bordered="false">这里修改的是一基真实物理杆塔的公共属性。若该物理塔承载多回线路，所有关联线路节点都会看到相同的塔型和班组。</n-alert>
      <n-form label-placement="top">
        <n-form-item label="物理资产编号"><n-input data-test="physical-asset-code" v-model:value="physicalTowerForm.assetCode" /></n-form-item>
        <n-form-item label="杆塔类型"><n-select v-model:value="physicalTowerForm.towerTypeId" :options="towerTypeOptions" clearable placeholder="请选择杆塔类型" /></n-form-item>
        <n-form-item label="运维班组"><n-select v-model:value="physicalTowerForm.maintenanceTeamId" :options="teamOptions" clearable placeholder="请选择班组" /></n-form-item>
        <n-form-item label="启用"><n-switch v-model:value="physicalTowerForm.enabled" /></n-form-item>
      </n-form>
      <template #footer><div class="actions"><n-button @click="physicalTowerModal=false">取消</n-button><n-button data-test="save-physical-tower" type="primary" :loading="saving" @click="savePhysicalTower">保存物理属性</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="rebindPhysicalModal" preset="card" title="重新关联物理杆塔" style="width:min(600px,calc(100vw - 32px))">
      <n-alert type="warning" :bordered="false">该操作只改变“这个线路编号属于哪一基物理杆塔”，不会改变线路、杆塔编号、更名历史或需求位置 ID。用于把原先分别录入的多回线路节点合并到同一基物理塔。</n-alert>
      <n-form label-placement="top">
        <n-form-item label="当前线路杆塔"><span>{{ rebindTower?.lineName }} {{ rebindTower?.towerNo }}</span></n-form-item>
        <n-form-item label="目标物理杆塔"><n-select data-test="rebind-physical-select" v-model:value="rebindPhysicalTowerId" :options="physicalTowerOptions" filterable /></n-form-item>
      </n-form>
      <template #footer><div class="actions"><n-button @click="rebindPhysicalModal=false">取消</n-button><n-button data-test="save-rebind-physical" type="primary" :loading="saving" @click="saveRebindPhysical">确认关联</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="customValuesModal" preset="card" title="物理杆塔自定义字段" style="width:min(620px,calc(100vw - 32px))">
      <n-alert type="info" :bordered="false">字段由“台账与字段配置”统一定义。这里保存的是当前物理杆塔的字段值，使用独立版本控制，不会修改线路节点版本。</n-alert>
      <n-form v-if="physicalCustomFields.length" label-placement="top">
        <n-form-item v-for="field in physicalCustomFields" :key="field.id" :label="`${field.label}${field.required ? ' *' : ''}`">
          <n-switch v-if="field.dataType==='boolean'" :value="Boolean(customValueForm[field.fieldKey])" @update:value="(value) => setCustomValue(field.fieldKey,value)" />
          <n-select v-else-if="field.dataType==='single_select'" :value="customValueForm[field.fieldKey] as string" :options="(Array.isArray(field.options) ? field.options : []).map((value) => ({label:String(value),value:String(value)}))" clearable @update:value="(value) => setCustomValue(field.fieldKey,value)" />
          <n-select v-else-if="field.dataType==='multi_select'" :value="customValueForm[field.fieldKey] as string[]" :options="(Array.isArray(field.options) ? field.options : []).map((value) => ({label:String(value),value:String(value)}))" multiple clearable @update:value="(value) => setCustomValue(field.fieldKey,value)" />
          <n-input v-else :value="String(customValueForm[field.fieldKey] ?? '')" :placeholder="field.dataType==='date' ? '请输入日期，如 2026-09-15' : ''" @update:value="(value) => setCustomValue(field.fieldKey,value)" />
        </n-form-item>
      </n-form>
      <n-empty v-else description="尚未配置物理杆塔自定义字段" />
      <template #footer><div class="actions"><n-button @click="customValuesModal=false">取消</n-button><n-button data-test="save-custom-values" type="primary" :disabled="!physicalCustomFields.length" :loading="saving" @click="saveCustomValues">保存字段值</n-button></div></template>
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
      <p>桌面可拖动；手机可直接上移/下移。跨很长距离时，使用“移动杆塔 → 目标杆塔 → 目标前/后”。保存时一次性提交完整稳定 ID 顺序。</p>
      <div class="order-controls"><n-select data-test="order-moving" v-model:value="orderMoving" :options="orderOptions" /><n-select data-test="order-target" v-model:value="orderTarget" :options="orderOptions" /><n-select v-model:value="orderPlacement" :options="placementOptions" /><n-button data-test="apply-order-move" @click="applyOrderMove">应用移动</n-button></div>
      <div class="order-list"><div v-for="(item,index) in orderDraft" :key="item.id" class="order-row" draggable="true" @dragstart="draggingTowerId=item.id" @dragover.prevent @drop="dropOrder(item.id)"><span class="drag-handle">≡</span><b>{{ index+1 }}</b><strong>{{ item.towerNo }}</strong><span>{{ item.towerTypeLabel ?? item.positionLabel ?? '—' }}</span><div class="order-row-actions"><n-button size="tiny" :data-test="`order-up-${item.id}`" :disabled="index===0" @click="moveDraftStep(item.id,-1)">上移</n-button><n-button size="tiny" :data-test="`order-down-${item.id}`" :disabled="index===orderDraft.length-1" @click="moveDraftStep(item.id,1)">下移</n-button></div></div></div>
      <template #footer><div class="actions"><n-button @click="orderModal=false">取消</n-button><n-button data-test="save-order" type="primary" :loading="saving" @click="saveOrder">保存顺序</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="bulkModal" preset="card" title="导入杆塔" style="width:min(780px,calc(100vw - 32px))">
      <p>当前线路：{{ selectedLine?.lineName }}。可选择 .xlsx / .csv，或直接从表格粘贴“杆塔编号、同塔位置标识、状态”。系统会先规范编号并与完整线路台账对比，再一次确认导入。批量新增默认每个线路节点创建独立物理杆塔；同塔关联请使用单个新增。</p>
      <n-form-item label="导入模式"><n-select data-test="tower-import-mode" :value="bulkMode" :options="bulkModeOptions" @update:value="setBulkMode" /></n-form-item>
      <n-alert v-if="bulkMode==='full-order'" type="warning" :bordered="false">完整清单模式要求当前线路每个杆塔对象都在文件中唯一出现；不会把缺失行当作删除。导入完成后，文件行顺序将成为线路顺序。</n-alert>
      <div class="tower-import-source"><app-file-picker test-id="tower-import-file" accept=".xlsx,.csv" label="选择台账文件" :selected-name="bulkSourceLabel || null" :disabled="bulkPreparing || saving" @change="onBulkFile" /><span>或</span><n-button size="small" :loading="bulkPreparing" data-test="preview-bulk-towers" @click="previewBulkPaste">预览粘贴数据</n-button></div>
      <n-input v-model:value="bulkText" data-test="bulk-tower-text" type="textarea" :rows="8" placeholder="杆塔编号[TAB]同塔位置标识[TAB]状态，例如：10-1    左回    启用。第一行也可以带表头。" />
      <div v-if="bulkPreview" class="tower-import-preview" data-test="tower-import-preview"><p><strong>{{ bulkSourceLabel }}</strong>：共 {{ bulkPreview.counts.total }} 行；新增 {{ bulkPreview.counts.create }}，更新 {{ bulkPreview.counts.update }}，无变化 {{ bulkPreview.counts.unchanged }}，错误 {{ bulkPreview.counts.error }}。</p><p v-if="!bulkPreview.counts.error && !bulkGlobalErrors.length">{{ bulkMode==='full-order' ? '完整清单校验通过；属性变化会先自动分批写入，随后按文件顺序原子重排。' : '系统将自动分批写入；新增杆塔按规范编号自动插入合适位置，不改变已有杆塔的人工顺序。' }}</p><div v-if="bulkPreview.counts.error" class="tower-import-errors"><p v-for="row in bulkPreview.rows.filter(item => item.action === 'error').slice(0,20)" :key="`${row.source}-${row.rowNumber}`">{{ row.source }}第 {{ row.rowNumber }} 行：{{ row.message }}</p><p v-if="bulkPreview.counts.error > 20">另有 {{ bulkPreview.counts.error - 20 }} 条错误，请修正后重新预览。</p></div><div v-if="bulkGlobalErrors.length" class="tower-import-errors"><p v-for="issue in bulkGlobalErrors" :key="issue">{{ issue }}</p></div><p v-if="bulkChunks.length">进度：{{ bulkProcessed }} / {{ bulkChunks.reduce((total, chunk) => total + chunk.length, 0) }} 条需要写入的数据。</p></div>
      <template #footer><div class="actions"><n-button @click="bulkModal=false">取消</n-button><n-button data-test="save-bulk-towers" type="primary" :loading="saving" :disabled="!bulkPreview || bulkPreview.counts.error>0 || bulkGlobalErrors.length>0" @click="saveBulk">{{ bulkNextChunk > 0 ? '继续导入' : '开始导入' }}</n-button></div></template>
    </n-modal>
  </div>
</template>

<style scoped>
.master-data-view{max-width:1480px;margin:0 auto}.error-recovery{display:flex;align-items:center;justify-content:space-between;gap:12px}.page-heading,.detail-heading{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:20px 22px;border:1px solid #e5e9f0;border-radius:16px;background:#fff}.eyebrow{font-size:11px;font-weight:700;color:#315fd3;letter-spacing:.08em}.page-heading h2,.detail-heading h2{margin:4px 0 5px;font-size:24px}.page-heading p,.detail-heading p{margin:0;color:#7b8493}.line-toolbar,.tower-toolbar{display:grid;grid-template-columns:minmax(170px,220px) minmax(240px,1fr) minmax(150px,190px) auto;gap:10px;margin:16px 0}.tower-toolbar{grid-template-columns:minmax(260px,1fr) auto auto}.line-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.line-card{border:1px solid #e5e9f0;border-radius:14px;background:#fff;overflow:hidden}.line-open{display:block;width:100%;padding:17px;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer}.line-open:hover{background:#f8faff}.line-card-title{display:flex;align-items:center;gap:10px;font-size:16px}.line-card-meta{display:flex;gap:16px;margin-top:12px;color:#737d8d;font-size:12px}.history-match{color:#7a5af8!important;font-size:12px}.line-card-actions{display:flex;gap:14px;padding:0 17px 13px}.back-button{border:0;background:transparent;color:#315fd3;cursor:pointer;padding:4px 0 10px}.detail-title-row{display:flex;align-items:center;gap:10px}.detail-actions{justify-content:flex-end}.actions{display:flex;justify-content:flex-end;gap:10px}.settings-head{display:flex;justify-content:space-between;align-items:center}.setting-row{display:flex;justify-content:space-between;gap:15px;align-items:center;padding:12px 0;border-top:1px solid #edf0f4}.setting-row div:first-child{display:flex;flex-direction:column;gap:3px}.setting-row small{color:#7b8493}.history-list>div{display:grid;grid-template-columns:minmax(120px,1fr) minmax(220px,1.6fr);gap:6px 14px;padding:11px 0;border-top:1px solid #edf0f4}.history-list small{grid-column:1/-1;color:#7b8493}.tower-mobile-list{display:none}.tower-mobile-card{border:1px solid #e5e9f0;border-radius:12px;background:#fff;padding:13px}.tower-mobile-main{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:10px;align-items:center}.tower-mobile-main strong,.tower-mobile-main small{display:block}.tower-mobile-main small{margin-top:3px}.tower-mobile-order{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#f3f6fb;color:#667085;font-size:12px;font-weight:700}.tower-mobile-meta{display:flex;justify-content:space-between;gap:12px;margin-top:10px;padding-top:10px;border-top:1px solid #edf0f4;font-size:12px}.tower-mobile-meta span{color:#7b8493}.tower-mobile-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}.order-controls{display:grid;grid-template-columns:1fr 1fr 150px auto;gap:8px;margin:12px 0}.order-list{max-height:420px;overflow:auto;border:1px solid #e5e9f0;border-radius:10px}.order-row{display:grid;grid-template-columns:26px 42px 120px 1fr auto;gap:8px;align-items:center;padding:9px 12px;border-bottom:1px solid #edf0f4;background:#fff}.order-row-actions{display:flex;gap:6px}.drag-handle{cursor:grab;color:#8a94a4}.tower-import-source{display:flex;align-items:center;gap:10px;margin:12px 0}.tower-import-preview{margin-top:14px;padding:12px 14px;border-radius:10px;background:#f7f9fc;border:1px solid #e6eaf1}.tower-import-preview p{margin:5px 0}.tower-import-errors{max-height:180px;overflow:auto;color:#b42318}
@media(max-width:900px){.line-list{grid-template-columns:1fr}.page-heading,.detail-heading{flex-direction:column}.line-toolbar{grid-template-columns:1fr 1fr}.detail-actions{justify-content:flex-start}.order-controls{grid-template-columns:1fr 1fr}.order-row{grid-template-columns:24px 34px 100px 1fr auto}}
@media(max-width:720px){.tower-desktop-table{display:none}.tower-mobile-list{display:grid;gap:10px}}
@media(max-width:600px){.error-recovery{align-items:flex-start;flex-direction:column}.line-toolbar,.tower-toolbar,.order-controls{grid-template-columns:1fr}.page-heading,.detail-heading{padding:16px}.page-heading h2,.detail-heading h2{font-size:20px}.line-card-meta{flex-wrap:wrap}.tower-import-source{align-items:flex-start;flex-direction:column}}
</style>
