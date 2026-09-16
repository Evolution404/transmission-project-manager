<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NProgress,
  NSelect,
  NSpace,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui';
import type {
  CurrentUser,
  DemandDetail,
  DemandSummary,
  ImportFieldMapping,
  ImportMappingTemplate,
  ImportRowSummary,
  LineTowerPositionSummary,
  MaterialSummary,
  TransmissionLineSummary,
  VoltageLevelSummary,
  DemandLocationType,
} from '@tpm/shared';
import { apiRequest, jsonRequestInit } from '../api/client';
import { downloadDemandImportTemplate } from '../imports/demandTemplate';
import { parseFileInWorker } from '../imports/workerClient';
import type { ParsedSpreadsheet } from '../imports/parser';
import {
  ImportReviewRequiredError,
  executeImportWorkflow,
  flattenParsedSheets,
  sha256File,
  type ImportWorkflowProgress,
} from '../imports/workflow';
import AppFilePicker from '../app/AppFilePicker.vue';
import AppPressable from '../app/AppPressable.vue';

const props = defineProps<{ currentUser: CurrentUser }>();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const canWrite = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');

type DemandWorkspaceTab = 'pool' | 'import' | 'materials';
const demandWorkspaceTabs = new Set<DemandWorkspaceTab>(['pool', 'import', 'materials']);

const loading = ref(true);
const error = ref('');
const demands = ref<DemandSummary[]>([]);
const demandCursor = ref<string | null>(null);
const demandQuery = ref(typeof route.query.query === 'string' ? route.query.query : '');
const requestedTab = typeof route.query.tab === 'string' ? route.query.tab : '';
const activeTab = ref<DemandWorkspaceTab>(demandWorkspaceTabs.has(requestedTab as DemandWorkspaceTab) ? requestedTab as DemandWorkspaceTab : 'pool');
const selectedDemand = ref<DemandDetail | null>(null);
const materials = ref<MaterialSummary[]>([]);
const mappingTemplates = ref<ImportMappingTemplate[]>([]);
const voltageLevels = ref<VoltageLevelSummary[]>([]);
const transmissionLines = ref<TransmissionLineSummary[]>([]);
const transmissionTowers = ref<LineTowerPositionSummary[]>([]);

const selectedFile = ref<File | null>(null);
const parsedFile = ref<ParsedSpreadsheet | null>(null);
const parsing = ref(false);
const importing = ref(false);
const importError = ref('');
const importProgress = ref<ImportWorkflowProgress | null>(null);
const reviewRows = ref<ImportRowSummary[]>([]);
const selectedTemplateId = ref<string | null>(null);
const templateName = ref('');
const savingTemplate = ref(false);
const mapping = ref<ImportFieldMapping>({
  sequenceNo: '', voltage: '', lineName: '', section: '', materialModel: '', materialQuantity: '',
});

const showMaterialForm = ref(false);
const savingMaterial = ref(false);
const materialForm = ref({ code: '', name: '', model: '', unit: '' });
const manualDemandModalOpen = ref(false);
const savingManualDemand = ref(false);
const savingDemandMaterial = ref(false);
const demandMaterialForm = ref({ rawModel: '', quantity: '', unit: '' });
const manualDemandForm = ref({
  sequenceNo: '', voltageLevelId: '', lineId: '', locationType: 'tower_range' as DemandLocationType,
  startTowerPositionId: '', endTowerPositionId: '', year: '', category: '', owner: '',
});
const manualDemandMaterials = ref<Array<{ id: string; model: string; quantity: string; unit: string }>>([]);
const mappingBusy = computed(() => savingTemplate.value || importing.value);
const workspaceMutationBusy = computed(() => mappingBusy.value || savingMaterial.value);

function setActiveTab(value: string | number) {
  if (workspaceMutationBusy.value) return;
  const nextTab = String(value) as DemandWorkspaceTab;
  if (!demandWorkspaceTabs.has(nextTab)) return;
  activeTab.value = nextTab;
  const query = { ...route.query };
  if (nextTab === 'pool') delete query.tab;
  else query.tab = nextTab;
  void router.replace({ query });
}

function syncDemandQuery() {
  const query = { ...route.query };
  const term = demandQuery.value.trim();
  if (term) query.query = term;
  else delete query.query;
  void router.replace({ query });
}

async function applyDemandQuery() {
  demandCursor.value = null;
  syncDemandQuery();
  await loadDemands();
}

const fieldDefinitions: Array<{ key: keyof ImportFieldMapping; label: string; required: boolean }> = [
  { key: 'sequenceNo', label: '序号', required: true },
  { key: 'voltage', label: '电压等级', required: true },
  { key: 'lineName', label: '线路名称', required: true },
  { key: 'section', label: '杆段', required: true },
  { key: 'materialModel', label: '物资型号', required: true },
  { key: 'materialQuantity', label: '物资数量', required: true },
  { key: 'unit', label: '单位', required: false },
  { key: 'year', label: '年度', required: false },
  { key: 'category', label: '类别', required: false },
  { key: 'owner', label: '负责人', required: false },
];

const exactHeaderNames: Record<keyof ImportFieldMapping, string[]> = {
  sequenceNo: ['序号'],
  voltage: ['电压等级', '电压'],
  lineName: ['线路名称', '线路'],
  section: ['杆段', '杆塔区段'],
  materialModel: ['物资型号', '型号'],
  materialQuantity: ['物资数量', '数量'],
  unit: ['单位'],
  year: ['年度', '年份'],
  category: ['类别', '需求类别'],
  owner: ['负责人'],
};

const parsedRowsCount = computed(() => parsedFile.value?.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) ?? 0);
const headerOptions = computed(() => {
  const names = new Set<string>();
  for (const sheet of parsedFile.value?.sheets ?? []) for (const header of sheet.headers) names.add(header);
  return [...names].map((name) => ({ label: name, value: name }));
});
const templateOptions = computed(() => mappingTemplates.value.map((item) => ({ label: item.name, value: item.id })));
const voltageOptions = computed(() => voltageLevels.value.filter((item) => item.enabled).map((item) => ({ label: item.displayName, value: item.id })));
const lineOptions = computed(() => transmissionLines.value.filter((item) => item.enabled && item.voltageLevelId === manualDemandForm.value.voltageLevelId).map((item) => ({ label: item.lineName, value: item.id })));
const towerOptions = computed(() => transmissionTowers.value.filter((item) => item.enabled && item.lineId === manualDemandForm.value.lineId).map((item) => ({ label: item.towerNo, value: item.id })));
const locationTypeOptions = [
  { label: '整条线路', value: 'whole_line' },
  { label: '单基杆塔', value: 'tower' },
  { label: '连续杆段', value: 'tower_range' },
];
const importReady = computed(() => Boolean(
  selectedFile.value && parsedFile.value &&
  mapping.value.sequenceNo && mapping.value.voltage && mapping.value.lineName && mapping.value.section &&
  mapping.value.materialModel && mapping.value.materialQuantity,
));

async function refreshAfterCommittedWrite(successMessage: string, refresh: () => Promise<unknown>) {
  try {
    await refresh();
    error.value = '';
    message.success(successMessage);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : '读取最新数据失败';
    error.value = `${successMessage}，但最新数据刷新失败：${detail}`;
    message.warning(`${successMessage}，但最新数据刷新失败，请重新加载`);
  }
}

function parseDecimalScaled(value: string, digits = 4): number | null {
  const raw = value.trim();
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const scale = 10n ** BigInt(digits);
  const scaled = BigInt(match[1]!) * scale + BigInt((match[2] ?? '').padEnd(digits, '0') || '0');
  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

async function loadDemands(reset = true) {
  const params = new URLSearchParams({ limit: '50' });
  if (demandQuery.value.trim()) params.set('query', demandQuery.value.trim());
  if (!reset && demandCursor.value) params.set('cursor', demandCursor.value);
  const data = await apiRequest<{ items: DemandSummary[]; nextCursor: string | null }>(`/api/demands?${params}`);
  demands.value = reset ? data.items : [...demands.value, ...data.items];
  demandCursor.value = data.nextCursor;
}

async function loadMaterials() {
  const data = await apiRequest<{ items: MaterialSummary[] }>('/api/materials?limit=100');
  materials.value = data.items;
}

async function loadTemplates() {
  const data = await apiRequest<{ items: ImportMappingTemplate[] }>('/api/import-mappings');
  mappingTemplates.value = data.items;
}

const gridLineCursor = ref<string | null>(null), gridTowerCursor = ref<string | null>(null);
let lineLoad = 0, towerLoad = 0;
async function loadMasterData() {
  voltageLevels.value = (await apiRequest<{ items: VoltageLevelSummary[] }>('/api/master/voltage-levels')).items;
}
async function loadGridLines(append = false) {
  const token = ++lineLoad, id = manualDemandForm.value.voltageLevelId;
  if (!id) return;
  try {
    const data = await apiRequest<{ items: TransmissionLineSummary[]; nextCursor?: string | null }>(`/api/master/lines?voltageLevelId=${encodeURIComponent(id)}${append && gridLineCursor.value ? '&cursor=' + encodeURIComponent(gridLineCursor.value) : ''}`);
    if (token !== lineLoad) return;
    transmissionLines.value = append ? [...transmissionLines.value, ...data.items] : data.items; gridLineCursor.value = data.nextCursor ?? null;
  } catch (cause) { if (token === lineLoad) message.error(cause instanceof Error ? cause.message : '线路读取失败'); }
}
async function loadGridTowers(append = false) {
  const token = ++towerLoad, id = manualDemandForm.value.lineId;
  if (!id) return;
  try {
    const data = await apiRequest<{ items: LineTowerPositionSummary[]; nextCursor?: string | null }>(`/api/master/towers?lineId=${encodeURIComponent(id)}${append && gridTowerCursor.value ? '&cursor=' + encodeURIComponent(gridTowerCursor.value) : ''}`);
    if (token !== towerLoad) return;
    transmissionTowers.value = append ? [...transmissionTowers.value, ...data.items] : data.items; gridTowerCursor.value = data.nextCursor ?? null;
  } catch (cause) { if (token === towerLoad) message.error(cause instanceof Error ? cause.message : '杆塔读取失败'); }
}
function chooseVoltage(value: string) {
  manualDemandForm.value.voltageLevelId = value; manualDemandForm.value.lineId = '';
  manualDemandForm.value.startTowerPositionId = ''; manualDemandForm.value.endTowerPositionId = '';
  transmissionLines.value = []; transmissionTowers.value = []; gridLineCursor.value = null; gridTowerCursor.value = null;
  lineLoad++; towerLoad++; void loadGridLines();
}
function chooseLine(value: string) {
  manualDemandForm.value.lineId = value; manualDemandForm.value.startTowerPositionId = ''; manualDemandForm.value.endTowerPositionId = '';
  transmissionTowers.value = []; gridTowerCursor.value = null; towerLoad++; void loadGridTowers();
}
function chooseLocationType(value: DemandLocationType) {
  manualDemandForm.value.locationType = value; manualDemandForm.value.startTowerPositionId = ''; manualDemandForm.value.endTowerPositionId = '';
}

async function loadInitial() {
  loading.value = true;
  error.value = '';
  try {
    await Promise.all([loadDemands(), loadMaterials(), loadTemplates(), loadMasterData()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取需求数据失败';
  } finally {
    loading.value = false;
  }
}

function autoMap(headers: string[]) {
  const next: ImportFieldMapping = {
    sequenceNo: '', voltage: '', lineName: '', section: '', materialModel: '', materialQuantity: '',
  };
  for (const field of fieldDefinitions) {
    const candidates = exactHeaderNames[field.key];
    const match = headers.find((header) => candidates.includes(header.trim()));
    if (match) next[field.key] = match;
  }
  mapping.value = next;
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  selectedFile.value = file;
  parsedFile.value = null;
  importProgress.value = null;
  reviewRows.value = [];
  importError.value = '';
  if (!file) return;
  parsing.value = true;
  try {
    const parsed = await parseFileInWorker(file);
    parsedFile.value = parsed;
    autoMap(parsed.sheets.flatMap((sheet) => sheet.headers));
  } catch (cause) {
    selectedFile.value = null;
    importError.value = cause instanceof Error ? cause.message : '文件解析失败';
  } finally {
    parsing.value = false;
  }
}

function applyTemplate(id: string | null) {
  selectedTemplateId.value = id;
  const template = mappingTemplates.value.find((item) => item.id === id);
  if (template) mapping.value = { ...template.mapping };
}

async function downloadTemplate() {
  try {
    await downloadDemandImportTemplate();
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '标准模板下载失败');
  }
}

async function saveTemplate() {
  const name = templateName.value.trim();
  if (!name) {
    message.warning('请先输入模板名称');
    return;
  }
  savingTemplate.value = true;
  try {
    const template = await apiRequest<ImportMappingTemplate>('/api/import-mappings', jsonRequestInit('POST', { name, mapping: mapping.value }));
    mappingTemplates.value = [...mappingTemplates.value, template].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    selectedTemplateId.value = template.id;
    templateName.value = '';
    message.success('字段映射模板已保存');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '模板保存失败');
  } finally {
    savingTemplate.value = false;
  }
}

async function startImport() {
  if (!selectedFile.value || !parsedFile.value || !importReady.value) return;
  importing.value = true;
  importError.value = '';
  importProgress.value = null;
  reviewRows.value = [];
  let publishedRows: number;
  try {
    const fileHash = await sha256File(selectedFile.value);
    const result = await executeImportWorkflow({
      fileName: selectedFile.value.name,
      fileType: parsedFile.value.fileType,
      fileSha256: fileHash,
      mapping: mapping.value,
      rows: flattenParsedSheets(parsedFile.value),
      onProgress: (progress) => { importProgress.value = progress; },
    });
    publishedRows = result.publishedRows;
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : '导入失败';
    if (cause instanceof ImportReviewRequiredError) {
      try {
        const detail = await apiRequest<{ rows: ImportRowSummary[] }>(`/api/imports/${cause.batchId}`);
        reviewRows.value = detail.rows;
      } catch (detailCause) {
        const detailMessage = detailCause instanceof Error ? detailCause.message : '校验明细读取失败';
        importError.value = `${importError.value}；${detailMessage}`;
      }
    }
    return;
  } finally {
    importing.value = false;
  }
  await refreshAfterCommittedWrite(`导入完成，已发布 ${publishedRows} 行需求`, loadDemands);
}

async function openDemand(row: DemandSummary) {
  try {
    selectedDemand.value = await apiRequest<DemandDetail>(`/api/demands/${row.id}`);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '需求详情读取失败');
  }
}

function setManualDemandOpen(value: boolean) {
  if (!savingManualDemand.value || value) manualDemandModalOpen.value = value;
}

function setDemandDetailOpen(value: boolean) {
  if (!value && savingDemandMaterial.value) return;
  if (!value) selectedDemand.value = null;
}

function addManualDemandMaterial() {
  manualDemandMaterials.value.push({ id: crypto.randomUUID(), model: '', quantity: '', unit: '' });
}

function removeManualDemandMaterial(id: string) {
  manualDemandMaterials.value = manualDemandMaterials.value.filter((item) => item.id !== id);
}

async function createManualDemand() {
  const form = manualDemandForm.value;
  if (!form.sequenceNo.trim() || !form.voltageLevelId || !form.lineId) {
    message.warning('序号、电压等级和线路不能为空');
    return;
  }
  if (form.locationType !== 'whole_line' && !form.startTowerPositionId) {
    message.warning('请选择杆塔');
    return;
  }
  if (form.locationType === 'tower_range' && !form.endTowerPositionId) {
    message.warning('请选择终止杆塔');
    return;
  }
  const year = form.year.trim() ? Number(form.year) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
    message.warning('年度必须为 1900-2200 的四位年份');
    return;
  }

  const materials: Array<{ rawModel: string; quantityScaled: number; unit: string | null }> = [];
  for (const [index, row] of manualDemandMaterials.value.entries()) {
    const model = row.model.trim();
    const quantity = row.quantity.trim();
    const unit = row.unit.trim();
    if (!model && !quantity && !unit) continue;
    if (!model || !quantity) {
      message.warning(`第 ${index + 1} 条物资必须同时填写型号和数量`);
      return;
    }
    const quantityScaled = parseDecimalScaled(quantity, 4);
    if (quantityScaled === null || quantityScaled <= 0) {
      message.warning(`第 ${index + 1} 条物资数量必须为正数且最多 4 位小数`);
      return;
    }
    materials.push({ rawModel: model, quantityScaled, unit: unit || null });
  }

  savingManualDemand.value = true;
  try {
    try {
      await apiRequest<DemandDetail>('/api/demands', jsonRequestInit('POST', {
        sequenceNo: form.sequenceNo.trim(),
        voltageLevelId: form.voltageLevelId,
        lineId: form.lineId,
        locationType: form.locationType,
        startTowerPositionId: form.locationType === 'whole_line' ? null : form.startTowerPositionId,
        endTowerPositionId: form.locationType === 'tower_range' ? form.endTowerPositionId : form.locationType === 'tower' ? form.startTowerPositionId : null,
        materials,
        year,
        category: form.category.trim() || null,
        owner: form.owner.trim() || null,
      }));
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '需求创建失败');
      return;
    }
    manualDemandForm.value = {
      sequenceNo: '', voltageLevelId: '', lineId: '', locationType: 'tower_range', startTowerPositionId: '', endTowerPositionId: '', year: '', category: '', owner: '',
    };
    manualDemandMaterials.value = [];
    manualDemandModalOpen.value = false;
    await refreshAfterCommittedWrite('需求已创建', loadDemands);
  } finally {
    savingManualDemand.value = false;
  }
}

async function addDemandMaterial() {
  if (!selectedDemand.value) return;
  const rawModel = demandMaterialForm.value.rawModel.trim();
  const quantityScaled = parseDecimalScaled(demandMaterialForm.value.quantity, 4);
  if (!rawModel || quantityScaled === null || quantityScaled <= 0) {
    message.warning('物资型号不能为空，数量必须为正数且最多 4 位小数');
    return;
  }
  savingDemandMaterial.value = true;
  try {
    let updated: DemandDetail;
    try {
      updated = await apiRequest<DemandDetail>(`/api/demands/${selectedDemand.value.id}/materials`, jsonRequestInit('POST', {
        expectedVersion: selectedDemand.value.version,
        materials: [{ rawModel, quantityScaled, unit: demandMaterialForm.value.unit.trim() || null, materialId: null }],
      }));
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '需求物资添加失败');
      return;
    }
    selectedDemand.value = updated;
    demandMaterialForm.value = { rawModel: '', quantity: '', unit: '' };
    await refreshAfterCommittedWrite('需求物资子明细已添加', loadDemands);
  } finally {
    savingDemandMaterial.value = false;
  }
}

async function addMaterial() {
  const payload = {
    code: materialForm.value.code.trim() || null,
    name: materialForm.value.name.trim(),
    model: materialForm.value.model.trim(),
    unit: materialForm.value.unit.trim(),
  };
  if (!payload.name || !payload.model || !payload.unit) {
    message.warning('物资名称、型号和单位均不能为空');
    return;
  }
  savingMaterial.value = true;
  try {
    try {
      await apiRequest<MaterialSummary>('/api/materials', jsonRequestInit('POST', payload));
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '物资保存失败');
      return;
    }
    materialForm.value = { code: '', name: '', model: '', unit: '' };
    showMaterialForm.value = false;
    await refreshAfterCommittedWrite('标准物资已添加', loadMaterials);
  } finally {
    savingMaterial.value = false;
  }
}

const demandColumns = [
  { title: '序号', key: 'sequenceNo', width: 90 },
  { title: '年度', key: 'year', width: 90, render: (row: DemandSummary) => row.year ?? '—' },
  { title: '电压等级', key: 'voltageRaw', width: 110 },
  { title: '线路名称', key: 'lineName', minWidth: 150 },
  { title: '杆段', key: 'section', minWidth: 130 },
  { title: '类别', key: 'category', minWidth: 110, render: (row: DemandSummary) => row.category ?? '—' },
  {
    title: '来源', key: 'source', width: 100,
    render(row: DemandSummary) {
      return h(NButton, { size: 'small', onClick: () => void openDemand(row) }, { default: () => '查看来源' });
    },
  },
];

const materialColumns = [
  { title: '编码', key: 'code', width: 140, render: (row: MaterialSummary) => row.code ?? '—' },
  { title: '名称', key: 'name', minWidth: 150 },
  { title: '型号', key: 'model', minWidth: 160 },
  { title: '单位', key: 'unit', width: 100 },
  {
    title: '状态', key: 'enabled', width: 90,
    render: (row: MaterialSummary) => h(NTag, { size: 'small', bordered: false, type: row.enabled ? 'success' : 'default' }, { default: () => row.enabled ? '启用' : '停用' }),
  },
];

onMounted(loadInitial);
</script>

<template>
  <n-spin :show="loading">
    <div class="view-stack demands-view">
      <n-alert v-if="error" type="error" title="读取失败">
        <div class="load-error-content"><span>{{ error }}</span><n-button size="small" secondary @click="loadInitial">重新加载</n-button></div>
      </n-alert>

      <header class="page-header">
        <div class="page-header-copy">
          <span class="page-eyebrow">需求管理</span>
          <h2 class="page-title">项目需求</h2>
          <p class="page-description">维护抽象需求及来源事实；需求物资只属于需求阶段，不自动变成项目物资。</p>
        </div>
        <div class="page-actions">
          <n-button v-if="canWrite" data-test="open-manual-demand" type="primary" @click="manualDemandModalOpen = true">新增需求</n-button>
        </div>
      </header>

      <n-tabs :value="activeTab" type="line" animated class="workspace-tabs" @update:value="setActiveTab">
        <n-tab-pane name="pool" tab="需求池">
          <n-alert v-if="!canWrite" type="info" title="只读模式" class="section-note">
            仅管理员或项目管理角色可以手工新增或批量导入需求。
          </n-alert>

          <section class="demand-list-surface">
            <div class="demand-list-toolbar">
              <n-input v-model:value="demandQuery" class="search-input" data-test="demand-search" placeholder="搜索线路、杆段或序号" clearable @keyup.enter="applyDemandQuery" />
              <n-button data-test="demand-search-submit" secondary @click="applyDemandQuery">查询</n-button>
              <span class="list-count">已加载 {{ demands.length }} 条</span>
            </div>
            <n-data-table v-if="demands.length" class="desktop-demand-table" :columns="demandColumns" :data="demands" :pagination="false" :scroll-x="900" />
            <div v-if="demands.length" class="mobile-demand-list">
              <app-pressable
                v-for="item in demands"
                :key="item.id"
                class="mobile-demand-item"
                :data-test="`mobile-demand-${item.id}`"
                @click="openDemand(item)"
              >
                <div class="mobile-demand-heading">
                  <div><strong>{{ item.sequenceNo }}</strong><span>{{ item.voltageRaw }}</span></div>
                  <span class="mobile-demand-chevron">›</span>
                </div>
                <strong class="mobile-demand-line">{{ item.lineName }}</strong>
                <div class="mobile-demand-meta">
                  <span>{{ item.section }}</span>
                  <span>{{ item.year ?? '未设年度' }}</span>
                  <span>{{ item.category ?? '未分类' }}</span>
                </div>
              </app-pressable>
            </div>
            <n-empty v-else description="暂无正式需求；可新增需求或通过模板导入。" />
            <div v-if="demandCursor" class="load-more">
              <n-button secondary @click="loadDemands(false)">加载更多</n-button>
            </div>
          </section>
        </n-tab-pane>

        <n-tab-pane name="import" tab="导入需求">
          <n-alert v-if="!canWrite" type="info" title="只读模式">
            仅管理员或项目管理角色可以导入需求。你仍可在“需求池”查看正式数据。
          </n-alert>

          <template v-else>
            <section class="import-workflow">
              <div class="import-step">
                <header class="import-step-header">
                  <span class="step-number">1</span>
                  <div><h3>准备文件</h3><p>下载标准模板，填写后选择 .xlsx 或 UTF-8 .csv。</p></div>
                  <n-button data-test="download-demand-template" secondary @click="downloadTemplate">下载标准模板</n-button>
                </header>
                <div class="import-step-body">
                  <n-alert type="info" :bordered="false" class="section-note">
                    标准模板可直接自动映射；文件仅在浏览器 Web Worker 中解析。旧 .xls 请先另存为 .xlsx。
                  </n-alert>
                  <app-file-picker
                    test-id="file-input"
                    accept=".xlsx,.csv"
                    label="选择需求文件"
                    :selected-name="selectedFile?.name ?? null"
                    :disabled="parsing || importing"
                    @change="onFileChange"
                  />
                  <div v-if="parsing" class="status-line">正在后台解析文件…</div>
                  <div v-else-if="parsedFile" class="status-line">
                    <n-tag type="success" :bordered="false">{{ parsedFile.fileType.toUpperCase() }}</n-tag>
                    <span>{{ selectedFile?.name }}</span>
                    <strong>识别到 {{ parsedRowsCount }} 行</strong>
                    <span>{{ parsedFile.sheets.length }} 个工作表</span>
                  </div>
                  <n-alert v-if="importError" type="error" title="导入未完成" class="section-note">{{ importError }}</n-alert>
                  <div v-if="reviewRows.length" class="review-list">
                    <div v-for="row in reviewRows" :key="row.id" class="review-row">
                      <strong>{{ row.sheetName }} / 第 {{ row.rowNumber }} 行</strong>
                      <div v-for="issue in row.errors" :key="`error-${issue.code}-${issue.field ?? ''}`" class="review-issue error">
                        错误：{{ issue.message }}<span v-if="issue.field">（{{ issue.field }}）</span>
                      </div>
                      <div v-for="issue in row.warnings" :key="`warning-${issue.code}-${issue.field ?? ''}`" class="review-issue warning">
                        警告：{{ issue.message }}<span v-if="issue.field">（{{ issue.field }}）</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="parsedFile" class="import-step">
                <header class="import-step-header">
                  <span class="step-number">2</span>
                  <div><h3>确认字段映射</h3><p>标准模板会自动映射；其他文件可复用已保存的映射规则。</p></div>
                </header>
                <div class="import-step-body">
                  <div class="template-row">
                    <n-select
                      data-test="mapping-template"
                      :value="selectedTemplateId"
                      :options="templateOptions"
                      :disabled="mappingBusy"
                      clearable
                      placeholder="选择已保存的映射模板"
                      @update:value="applyTemplate"
                    />
                    <n-input v-model:value="templateName" :disabled="mappingBusy" placeholder="新模板名称" />
                    <n-button :loading="savingTemplate" :disabled="importing" @click="saveTemplate">保存当前映射</n-button>
                  </div>
                  <div class="mapping-grid">
                    <n-form-item v-for="field in fieldDefinitions" :key="field.key" :label="`${field.label}${field.required ? ' *' : ''}`">
                      <n-select
                        :data-test="`mapping-source-${field.key}`"
                        :value="mapping[field.key] ?? null"
                        :options="headerOptions"
                        :disabled="mappingBusy"
                        clearable
                        :placeholder="field.required ? '请选择源列' : '可选'"
                        @update:value="(value: string | null) => { if (value) mapping[field.key] = value; else delete mapping[field.key]; }"
                      />
                    </n-form-item>
                  </div>
                </div>
              </div>

              <div v-if="parsedFile" class="import-step final-step">
                <header class="import-step-header">
                  <span class="step-number">3</span>
                  <div><h3>校验并发布</h3><p>服务端重新验证业务字段后，才会写入正式需求池。</p></div>
                </header>
                <div class="import-step-body">
                  <n-alert type="warning" :bordered="false" class="section-note">
                    浏览器映射不是最终真相：服务端会重新校验必填字段、数量精度和标准物资匹配。阻断错误不会进入正式需求池；未知物资只明确警告，不会当作零价或自动匹配。
                  </n-alert>
                  <n-button data-test="start-import" type="primary" :disabled="!importReady || savingTemplate" :loading="importing" @click="startImport">
                    开始导入并发布
                  </n-button>
                  <div v-if="importProgress" class="progress-block">
                    <n-progress type="line" :percentage="Math.round(importProgress.total ? importProgress.current / importProgress.total * 100 : 0)" />
                    <span>{{ importProgress.message }}</span>
                  </div>
                </div>
              </div>
            </section>
          </template>
        </n-tab-pane>

        <n-tab-pane name="materials" tab="物资字典">
          <section class="dictionary-panel">
            <header class="dictionary-panel-header">
              <div><h3>标准物资</h3><p>按“型号 + 单位”区分；未知物资只标记待核实，不自动猜测匹配。</p></div>
              <n-button v-if="canWrite" data-test="add-material" :disabled="savingMaterial" type="primary" @click="showMaterialForm = !showMaterialForm">
                {{ showMaterialForm ? '收起' : '新增物资' }}
              </n-button>
            </header>
            <div v-if="showMaterialForm && canWrite" class="dictionary-edit">
              <n-form class="material-form" label-placement="top">
                <n-form-item label="编码（可选）"><n-input v-model:value="materialForm.code" :disabled="savingMaterial" /></n-form-item>
                <n-form-item label="名称"><n-input v-model:value="materialForm.name" data-test="material-name" :disabled="savingMaterial" /></n-form-item>
                <n-form-item label="型号"><n-input v-model:value="materialForm.model" data-test="material-model" :disabled="savingMaterial" /></n-form-item>
                <n-form-item label="单位"><n-input v-model:value="materialForm.unit" data-test="material-unit" :disabled="savingMaterial" /></n-form-item>
                <n-form-item><n-button data-test="save-material" type="primary" :loading="savingMaterial" @click="addMaterial">保存物资</n-button></n-form-item>
              </n-form>
            </div>
            <div class="dictionary-data">
              <n-data-table v-if="materials.length" class="desktop-material-table" :columns="materialColumns" :data="materials" :pagination="false" :scroll-x="720" />
              <div v-if="materials.length" class="mobile-material-list">
                <div v-for="item in materials" :key="item.id" class="mobile-material-item" :data-test="`mobile-material-${item.id}`">
                  <div class="mobile-material-head">
                    <div><strong>{{ item.name }}</strong><span>{{ item.code || '无编码' }}</span></div>
                    <n-tag size="small" :bordered="false" :type="item.enabled ? 'success' : 'default'">{{ item.enabled ? '启用' : '停用' }}</n-tag>
                  </div>
                  <div class="mobile-material-facts"><span>型号 {{ item.model }}</span><span>单位 {{ item.unit }}</span></div>
                </div>
              </div>
              <n-empty v-else description="暂无标准物资。导入需求可以先进行，但未知物资会被标记为待核实。" />
            </div>
          </section>
        </n-tab-pane>
      </n-tabs>

      <n-modal
        :show="manualDemandModalOpen"
        preset="card"
        title="新增需求"
        class="demand-modal"
        style="width: min(760px, calc(100vw - 32px))"
        :mask-closable="!savingManualDemand"
        :close-on-esc="!savingManualDemand"
        :closable="!savingManualDemand"
        @update:show="setManualDemandOpen"
      >
        <div class="modal-intro">
          <strong>先建立需求事项，再按需要附加物资。</strong>
          <span>核心信息必须填写；初始物资可以为 0 条，也可以一次添加任意多条。</span>
        </div>
        <n-form data-test="manual-demand-form" class="manual-demand-form" label-placement="top">
          <div class="form-section-title">基本信息</div>
          <n-form-item label="序号"><n-input v-model:value="manualDemandForm.sequenceNo" data-test="manual-sequence" placeholder="例如：D-001" /></n-form-item>
          <n-form-item label="电压等级">
            <n-select
              data-test="manual-voltage"
              :value="manualDemandForm.voltageLevelId || null"
              :options="voltageOptions"
              placeholder="请选择电压等级"
              @update:value="chooseVoltage"
            />
          </n-form-item>
          <n-form-item label="线路">
            <n-select
              data-test="manual-line"
              :value="manualDemandForm.lineId || null"
              :options="lineOptions"
              :disabled="!manualDemandForm.voltageLevelId"
              filterable
              placeholder="请选择线路"
              @update:value="chooseLine"
            />
          </n-form-item>
          <n-button v-if="gridLineCursor" @click="loadGridLines(true)">加载更多线路</n-button>
          <n-form-item label="设备范围">
            <n-select :value="manualDemandForm.locationType" data-test="manual-location-type" :options="locationTypeOptions" :disabled="!manualDemandForm.lineId" @update:value="chooseLocationType" />
          </n-form-item>
          <n-form-item v-if="manualDemandForm.locationType !== 'whole_line'" :label="manualDemandForm.locationType === 'tower' ? '杆塔' : '起始杆塔'">
            <n-select v-model:value="manualDemandForm.startTowerPositionId" data-test="manual-start-tower" :options="towerOptions" :disabled="!manualDemandForm.lineId" filterable placeholder="请选择杆塔" />
          </n-form-item>
          <n-form-item v-if="manualDemandForm.locationType === 'tower_range'" label="终止杆塔">
            <n-select v-model:value="manualDemandForm.endTowerPositionId" data-test="manual-end-tower" :options="towerOptions" :disabled="!manualDemandForm.lineId" filterable placeholder="请选择终止杆塔" />
          </n-form-item>
          <n-button v-if="gridTowerCursor" @click="loadGridTowers(true)">加载更多杆塔</n-button>
          <n-form-item label="年度"><n-input v-model:value="manualDemandForm.year" data-test="manual-year" placeholder="例如：2026" /></n-form-item>
          <n-form-item label="类别"><n-input v-model:value="manualDemandForm.category" data-test="manual-category" placeholder="请输入需求类别" /></n-form-item>
          <n-form-item label="负责人"><n-input v-model:value="manualDemandForm.owner" data-test="manual-owner" placeholder="请输入负责人" /></n-form-item>
          <div class="form-section-title form-section-wide material-section-heading">
            <div>
              <strong>初始物资（可选）</strong>
              <span>可添加任意条；创建后仍可继续追加物资子明细。</span>
            </div>
            <n-button data-test="add-manual-material" size="small" secondary @click="addManualDemandMaterial">添加物资</n-button>
          </div>
          <div v-if="manualDemandMaterials.length" class="manual-material-list form-section-wide">
            <div v-for="(row, index) in manualDemandMaterials" :key="row.id" class="manual-material-row">
              <div class="manual-material-index">{{ index + 1 }}</div>
              <n-form-item label="物资型号">
                <n-input v-model:value="row.model" :data-test="`manual-material-model-${index}`" placeholder="请输入物资型号" />
              </n-form-item>
              <n-form-item label="数量">
                <n-input v-model:value="row.quantity" :data-test="`manual-material-quantity-${index}`" placeholder="最多 4 位小数" />
              </n-form-item>
              <n-form-item label="单位">
                <n-input v-model:value="row.unit" :data-test="`manual-material-unit-${index}`" placeholder="例如：套、只、米" />
              </n-form-item>
              <n-button :data-test="`remove-manual-material-${index}`" quaternary type="error" class="manual-material-remove" @click="removeManualDemandMaterial(row.id)">删除</n-button>
            </div>
          </div>
          <div v-else class="manual-material-empty form-section-wide">
            当前不附带物资。需要时点击“添加物资”，可连续新增多条。
          </div>
        </n-form>
        <template #footer>
          <div class="modal-actions">
            <n-button :disabled="savingManualDemand" @click="setManualDemandOpen(false)">取消</n-button>
            <n-button data-test="save-manual-demand" type="primary" :loading="savingManualDemand" @click="createManualDemand">创建需求</n-button>
          </div>
        </template>
      </n-modal>

      <n-modal
        :show="Boolean(selectedDemand)"
        preset="card"
        title="需求详情与来源"
        class="demand-detail-modal"
        style="width: min(900px, calc(100vw - 32px))"
        :mask-closable="!savingDemandMaterial"
        :close-on-esc="!savingDemandMaterial"
        :closable="!savingDemandMaterial"
        @update:show="setDemandDetailOpen"
      >
        <template v-if="selectedDemand">
          <div class="detail-grid detail-grid-polished">
            <div><span>序号</span><strong>{{ selectedDemand.sequenceNo }}</strong></div>
            <div><span>电压等级</span><strong>{{ selectedDemand.voltageRaw }}</strong></div>
            <div><span>线路</span><strong>{{ selectedDemand.lineName }}</strong></div>
            <div><span>杆段</span><strong>{{ selectedDemand.section }}</strong></div>
            <template v-if="selectedDemand.source.type === 'import'">
              <div><span>来源方式</span><strong>文件导入</strong></div>
              <div><span>来源文件</span><strong>{{ selectedDemand.source.fileName }}</strong></div>
              <div><span>来源行数</span><strong>{{ selectedDemand.source.rows?.length ?? 1 }} 行</strong></div>
            </template>
            <div v-else><span>来源方式</span><strong>手工创建</strong></div>
          </div>
          <div v-if="selectedDemand.source.type === 'import' && selectedDemand.source.rows?.length" class="material-lines">
            <strong>Excel 来源行</strong>
            <div v-for="source in selectedDemand.source.rows" :key="`${source.fileSha256}-${source.sheetName}-${source.rowNumber}`" class="material-line">
              <span>{{ source.fileName }}</span><span>{{ source.sheetName }} / 第 {{ source.rowNumber }} 行</span>
            </div>
          </div>
          <div class="material-lines">
            <strong>需求物资子明细</strong>
            <div v-for="item in selectedDemand.materials" :key="item.id" class="material-line">
              <span>{{ item.rawModel }}</span>
              <span>{{ item.quantityScaled / 10000 }} {{ item.unit ?? '' }}</span>
              <n-tag size="small" :bordered="false" :type="item.material ? 'success' : 'warning'">
                {{ item.material ? `${item.material.model} / ${item.material.unit}` : '未匹配标准物资' }}
              </n-tag>
            </div>
            <n-empty v-if="!selectedDemand.materials.length" description="该需求当前没有物资子明细，可保持纯抽象事项。" />
            <n-form v-if="canWrite" class="material-form material-form-inline" label-placement="top">
              <n-form-item label="新增物资型号"><n-input v-model:value="demandMaterialForm.rawModel" placeholder="请输入物资型号" /></n-form-item>
              <n-form-item label="数量"><n-input v-model:value="demandMaterialForm.quantity" placeholder="请输入数量" /></n-form-item>
              <n-form-item label="单位"><n-input v-model:value="demandMaterialForm.unit" placeholder="请输入单位" /></n-form-item>
              <n-form-item><n-button type="primary" :loading="savingDemandMaterial" @click="addDemandMaterial">追加需求物资</n-button></n-form-item>
            </n-form>
          </div>
        </template>
      </n-modal>
    </div>
  </n-spin>
</template>

<style scoped>
.demands-view { max-width: 1420px; }
.section-note { margin-bottom: 16px; }
.workspace-tabs :deep(.n-tabs-nav) { margin-bottom: 2px; }
.workspace-tabs :deep(.n-tabs-tab) { padding-inline: 2px; margin-right: 24px; font-size: 14px; }
.demand-list-surface { overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.demand-list-toolbar { display: flex; align-items: center; gap: 10px; min-height: 64px; padding: 12px 16px; border-bottom: 1px solid var(--ui-border); }
.search-input { width: min(360px, 42vw); }
.list-count { margin-left: auto; color: var(--ui-text-tertiary); font-size: 13px; white-space: nowrap; }
.mobile-demand-list { display: none; }
.import-workflow, .dictionary-panel { overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.import-step + .import-step { border-top: 1px solid var(--ui-border); }
.import-step-header, .dictionary-panel-header { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 12px; align-items: center; min-height: 64px; padding: 13px 16px; }
.dictionary-panel-header { grid-template-columns: minmax(0, 1fr) auto; border-bottom: 1px solid var(--ui-border); }
.import-step-header h3, .dictionary-panel-header h3 { margin: 0; color: var(--ui-text); font-size: 14px; font-weight: 680; }
.import-step-header p, .dictionary-panel-header p { margin: 3px 0 0; color: var(--ui-text-secondary); font-size: 13px; line-height: 1.5; }
.step-number { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; background: var(--ui-accent-soft); color: var(--ui-accent); font-size: 12px; font-weight: 750; }
.import-step-body { padding: 0 16px 18px 58px; }
.final-step .import-step-body { padding-bottom: 20px; }
.dictionary-edit { padding: 16px; border-bottom: 1px solid var(--ui-border); background: var(--ui-surface-subtle); }
.dictionary-data :deep(.n-data-table) { border: 0; border-radius: 0; }
.dictionary-data > .n-empty { padding: 32px 16px; }
.mobile-material-list { display: none; }
.status-line { margin-top: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.template-row { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) auto; gap: 10px; margin-bottom: 18px; }
.mapping-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.progress-block { display: grid; gap: 8px; margin-top: 18px; }
.review-list { display: grid; gap: 10px; margin-top: 14px; }
.review-row { display: grid; gap: 5px; padding: 12px; border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-surface-subtle); }
.review-issue { font-size: 13px; }
.review-issue.error { color: var(--ui-danger); }
.review-issue.warning { color: var(--ui-warning); }
.load-more { display: flex; justify-content: center; padding: 14px 16px; border-top: 1px solid var(--ui-border); }
.detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.detail-grid div { display: grid; gap: 4px; padding: 12px 13px; border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-surface-subtle); }
.detail-grid span { color: var(--ui-text-tertiary); font-size: 13px; }
.detail-grid strong { color: var(--ui-text); font-size: 13px; }
.detail-grid-polished { margin-bottom: 6px; }
.material-lines { display: grid; gap: 8px; margin-top: 20px; }
.material-lines > strong { color: var(--ui-text); font-size: 13px; }
.material-line { display: grid; grid-template-columns: 1fr 150px minmax(160px, auto); align-items: center; gap: 12px; padding: 10px 2px; border-top: 1px solid var(--ui-border); }
.material-form { display: grid; grid-template-columns: 1fr 1fr 1fr 120px auto; gap: 12px; align-items: end; margin: 0; }
.material-form-inline { margin: 14px 0 0; padding-top: 14px; border-top: 1px solid var(--ui-border); }
.manual-demand-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.form-section-title {
  grid-column: 1 / -1;
  margin: 2px 0 10px;
  color: var(--ui-text);
  font-size: 13px;
  font-weight: 700;
}
.form-section-wide { margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--ui-border); }
.material-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.material-section-heading > div { display: grid; gap: 3px; }
.material-section-heading strong { color: var(--ui-text); font-size: 13px; }
.material-section-heading span { color: var(--ui-text-tertiary); font-size: 13px; font-weight: 400; }
.manual-material-list { display: grid; gap: 10px; }
.manual-material-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1.5fr) minmax(120px, .8fr) minmax(100px, .7fr) auto;
  gap: 10px;
  align-items: end;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 11px;
  background: var(--ui-surface-subtle);
}
.manual-material-row .n-form-item { margin-bottom: 0; }
.manual-material-index {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  margin-bottom: 7px;
  border-radius: 8px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-size: 13px;
  font-weight: 750;
}
.manual-material-remove { margin-bottom: 2px; }
.manual-material-empty {
  padding: 14px 16px;
  border: 1px dashed var(--ui-border-strong);
  border-radius: 10px;
  background: var(--ui-surface-subtle);
  color: var(--ui-text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}
.modal-intro {
  display: grid;
  gap: 4px;
  margin: -2px 0 16px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-accent-soft);
}
.modal-intro strong { color: var(--ui-text); font-size: 13px; }
.modal-intro span { color: var(--ui-text-secondary); font-size: 13px; line-height: 1.5; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
:global(.demand-modal), :global(.demand-detail-modal) { border-radius: 15px; overflow: hidden; box-shadow: var(--ui-shadow-popover); }
@media (max-width: 850px) {
  .template-row, .mapping-grid, .detail-grid, .material-form, .manual-demand-form { grid-template-columns: 1fr; }
  .manual-material-row { grid-template-columns: 28px minmax(0, 1fr); align-items: center; }
  .manual-material-row .n-form-item { grid-column: 2; }
  .manual-material-index { grid-column: 1; grid-row: 1 / span 3; align-self: start; margin-top: 28px; }
  .manual-material-remove { grid-column: 2; justify-self: end; margin-top: -2px; }
  .material-section-heading { align-items: center; }
  .material-line { grid-template-columns: 1fr; }
  .search-input { width: 100%; }
}
@media (max-width: 767px) {
  :global(.demand-modal), :global(.demand-detail-modal) { width: calc(100vw - 20px) !important; max-height: calc(100dvh - 20px); }
  :global(.demand-modal .n-card__content), :global(.demand-detail-modal .n-card__content) { min-height: 0; max-height: calc(100dvh - 142px); overflow-y: auto; overscroll-behavior: contain; }
  :global(.demand-modal .n-card__footer) { padding-bottom: max(14px, env(safe-area-inset-bottom)); background: var(--ui-surface); }
  .modal-actions { position: sticky; bottom: 0; }
  .modal-actions .n-button:last-child { flex: 1; }
  .import-step-header, .dictionary-panel-header { grid-template-columns: 30px minmax(0, 1fr); align-items: start; }
  .import-step-header > .n-button, .dictionary-panel-header > .n-button { grid-column: 2; justify-self: start; }
  .dictionary-panel-header > div { grid-column: 1 / -1; }
  .dictionary-panel-header > .n-button { grid-column: 1 / -1; width: 100%; }
  .import-step-body { padding: 0 14px 16px; }
  .demand-list-toolbar { align-items: stretch; flex-wrap: wrap; min-height: 0; padding: 12px 13px; }
  .demand-list-toolbar .search-input { flex: 1 1 calc(100% - 84px); }
  .list-count { width: 100%; margin-left: 0; }
  .desktop-demand-table { display: none; }
  .mobile-demand-list { display: grid; }
  .mobile-demand-item { display: grid; gap: 8px; width: 100%; padding: 15px 14px; border-bottom: 1px solid var(--ui-border); text-align: left; }
  .mobile-demand-item:last-child { border-bottom: 0; }
  .mobile-demand-heading { display: grid; grid-template-columns: minmax(0,1fr) 18px; align-items: center; gap: 12px; }
  .mobile-demand-heading > div { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .mobile-demand-heading strong { font-size: 13px; font-weight: 700; }
  .mobile-demand-heading span { color: var(--ui-text-tertiary); font-size: 13px; }
  .mobile-demand-chevron { justify-self: end; color: var(--ui-text-tertiary) !important; font-size: 20px !important; }
  .mobile-demand-line { font-size: 14px; font-weight: 650; line-height: 1.45; overflow-wrap: anywhere; }
  .mobile-demand-meta { display: flex; flex-wrap: wrap; gap: 5px 12px; color: var(--ui-text-secondary); font-size: 13px; }
  .desktop-material-table { display: none; }
  .mobile-material-list { display: grid; }
  .mobile-material-item { display: grid; gap: 8px; padding: 14px; border-bottom: 1px solid var(--ui-border); }
  .mobile-material-item:last-child { border-bottom: 0; }
  .mobile-material-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .mobile-material-head > div { display: grid; gap: 3px; min-width: 0; }
  .mobile-material-head strong { font-size: 13px; font-weight: 680; line-height: 1.45; overflow-wrap: anywhere; }
  .mobile-material-head span { color: var(--ui-text-tertiary); font-size: 13px; }
  .mobile-material-facts { display: flex; flex-wrap: wrap; gap: 5px 14px; color: var(--ui-text-secondary); font-size: 13px; }
}
@media (max-width: 560px) {
  .material-section-heading { align-items: flex-start; }
  .material-section-heading span { max-width: 210px; }
}
</style>
