<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
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
  ApiResponse,
  CurrentUser,
  DemandDetail,
  DemandSummary,
  ImportFieldMapping,
  ImportMappingTemplate,
  ImportRowSummary,
  MaterialSummary,
} from '@tpm/shared';
import { parseApiResponse } from '../api/response';
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

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const canWrite = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');

const loading = ref(true);
const error = ref('');
const demands = ref<DemandSummary[]>([]);
const demandCursor = ref<string | null>(null);
const demandQuery = ref('');
const selectedDemand = ref<DemandDetail | null>(null);
const materials = ref<MaterialSummary[]>([]);
const mappingTemplates = ref<ImportMappingTemplate[]>([]);

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
const savingManualDemand = ref(false);
const savingDemandMaterial = ref(false);
const demandMaterialForm = ref({ rawModel: '', quantity: '', unit: '' });
const manualDemandForm = ref({
  sequenceNo: '', voltage: '', lineName: '', section: '', materialModel: '', materialQuantity: '',
  unit: '', year: '', category: '', owner: '',
});

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
const importReady = computed(() => Boolean(
  selectedFile.value && parsedFile.value &&
  mapping.value.sequenceNo && mapping.value.voltage && mapping.value.lineName && mapping.value.section &&
  mapping.value.materialModel && mapping.value.materialQuantity,
));

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
  return result.data;
}

function writeInit(method: 'POST' | 'PATCH' | 'PUT', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  };
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

async function loadInitial() {
  loading.value = true;
  error.value = '';
  try {
    await Promise.all([loadDemands(), loadMaterials(), loadTemplates()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取 P2 数据失败';
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
    const template = await apiRequest<ImportMappingTemplate>('/api/import-mappings', writeInit('POST', { name, mapping: mapping.value }));
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
    message.success(`导入完成，已发布 ${result.publishedRows} 行需求`);
    await loadDemands();
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
  } finally {
    importing.value = false;
  }
}

async function openDemand(row: DemandSummary) {
  try {
    selectedDemand.value = await apiRequest<DemandDetail>(`/api/demands/${row.id}`);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '需求详情读取失败');
  }
}

async function createManualDemand() {
  const form = manualDemandForm.value;
  if (!form.sequenceNo.trim() || !form.voltage.trim() || !form.lineName.trim() || !form.section.trim()) {
    message.warning('序号、电压等级、线路名称和杆段不能为空');
    return;
  }
  if (Boolean(form.materialModel.trim()) !== Boolean(form.materialQuantity.trim())) {
    message.warning('初始物资型号和数量要么同时填写，要么都留空');
    return;
  }
  const year = form.year.trim() ? Number(form.year) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
    message.warning('年度必须为 1900-2200 的四位年份');
    return;
  }
  savingManualDemand.value = true;
  try {
    const materials = form.materialModel.trim() && form.materialQuantity.trim()
      ? [{
          rawModel: form.materialModel.trim(),
          quantityScaled: parseDecimalScaled(form.materialQuantity, 4)!,
          unit: form.unit.trim() || null,
        }]
      : [];
    if (materials.length && (!materials[0]!.quantityScaled || materials[0]!.quantityScaled <= 0)) {
      message.warning('初始物资数量必须为正数且最多 4 位小数');
      return;
    }
    await apiRequest<DemandDetail>('/api/demands', writeInit('POST', {
      sequenceNo: form.sequenceNo.trim(),
      voltage: form.voltage.trim(),
      lineName: form.lineName.trim(),
      section: form.section.trim(),
      materials,
      year,
      category: form.category.trim() || null,
      owner: form.owner.trim() || null,
    }));
    manualDemandForm.value = {
      sequenceNo: '', voltage: '', lineName: '', section: '', materialModel: '', materialQuantity: '',
      unit: '', year: '', category: '', owner: '',
    };
    await loadDemands();
    message.success('需求已手工创建');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '需求创建失败');
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
    const updated = await apiRequest<DemandDetail>(`/api/demands/${selectedDemand.value.id}/materials`, writeInit('POST', {
      expectedVersion: selectedDemand.value.version,
      materials: [{ rawModel, quantityScaled, unit: demandMaterialForm.value.unit.trim() || null, materialId: null }],
    }));
    selectedDemand.value = updated;
    demandMaterialForm.value = { rawModel: '', quantity: '', unit: '' };
    await loadDemands();
    message.success('需求物资子明细已添加');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '需求物资添加失败');
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
    await apiRequest<MaterialSummary>('/api/materials', writeInit('POST', payload));
    materialForm.value = { code: '', name: '', model: '', unit: '' };
    showMaterialForm.value = false;
    await loadMaterials();
    message.success('标准物资已添加');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '物资保存失败');
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
    <div class="view-stack">
      <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>

      <n-tabs type="line" animated>
        <n-tab-pane name="pool" tab="需求池">
          <n-card v-if="canWrite" title="手工新增需求" class="detail-card">
            <n-alert type="info" :bordered="false" class="section-note">
              需求是抽象业务事项，序号、电压等级、线路名称和杆段是核心信息；物资可以创建时填写，也可以先留空、后续再追加为需求物资子明细。
            </n-alert>
            <n-form data-test="manual-demand-form" class="manual-demand-form" label-placement="top">
              <n-form-item label="序号"><n-input v-model:value="manualDemandForm.sequenceNo" data-test="manual-sequence" /></n-form-item>
              <n-form-item label="电压等级"><n-input v-model:value="manualDemandForm.voltage" data-test="manual-voltage" /></n-form-item>
              <n-form-item label="线路名称"><n-input v-model:value="manualDemandForm.lineName" data-test="manual-line" /></n-form-item>
              <n-form-item label="杆段"><n-input v-model:value="manualDemandForm.section" data-test="manual-section" /></n-form-item>
              <n-form-item label="初始物资型号（可选）"><n-input v-model:value="manualDemandForm.materialModel" data-test="manual-material-model" /></n-form-item>
              <n-form-item label="初始物资数量（可选）"><n-input v-model:value="manualDemandForm.materialQuantity" data-test="manual-material-quantity" /></n-form-item>
              <n-form-item label="初始物资单位（可选）"><n-input v-model:value="manualDemandForm.unit" data-test="manual-unit" /></n-form-item>
              <n-form-item label="年度"><n-input v-model:value="manualDemandForm.year" data-test="manual-year" /></n-form-item>
              <n-form-item label="类别"><n-input v-model:value="manualDemandForm.category" data-test="manual-category" /></n-form-item>
              <n-form-item label="负责人"><n-input v-model:value="manualDemandForm.owner" data-test="manual-owner" /></n-form-item>
              <n-form-item><n-button data-test="save-manual-demand" type="primary" :loading="savingManualDemand" @click="createManualDemand">新增需求</n-button></n-form-item>
            </n-form>
          </n-card>

          <n-alert v-else type="info" title="只读模式" class="section-note">
            仅管理员或项目管理角色可以手工新增或批量导入需求。
          </n-alert>

          <n-card title="正式需求">
            <template #header-extra>
              <n-space>
                <n-input v-model:value="demandQuery" placeholder="线路 / 杆段 / 序号" clearable @keyup.enter="loadDemands()" />
                <n-button @click="loadDemands()">查询</n-button>
              </n-space>
            </template>
            <n-data-table v-if="demands.length" :columns="demandColumns" :data="demands" :pagination="false" :scroll-x="900" />
            <n-empty v-else description="暂无正式需求；可手工新增或通过模板导入。" />
            <div v-if="demandCursor" class="load-more">
              <n-button secondary @click="loadDemands(false)">加载更多</n-button>
            </div>
          </n-card>

          <n-card v-if="selectedDemand" title="需求来源追溯" class="detail-card">
            <div class="detail-grid">
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
              <n-form v-if="canWrite" class="material-form" label-placement="top">
                <n-form-item label="新增物资型号"><n-input v-model:value="demandMaterialForm.rawModel" /></n-form-item>
                <n-form-item label="数量"><n-input v-model:value="demandMaterialForm.quantity" /></n-form-item>
                <n-form-item label="单位"><n-input v-model:value="demandMaterialForm.unit" /></n-form-item>
                <n-form-item><n-button type="primary" :loading="savingDemandMaterial" @click="addDemandMaterial">追加需求物资</n-button></n-form-item>
              </n-form>
            </div>
          </n-card>
        </n-tab-pane>

        <n-tab-pane name="import" tab="导入需求">
          <n-alert v-if="!canWrite" type="info" title="只读模式">
            仅管理员或项目管理角色可以导入需求。你仍可在“需求池”查看正式数据。
          </n-alert>

          <template v-else>
            <n-card title="1. 下载模板并选择文件">
              <template #header-extra>
                <n-button data-test="download-demand-template" secondary @click="downloadTemplate">下载标准模板</n-button>
              </template>
              <n-alert type="info" :bordered="false" class="section-note">
                推荐先下载系统标准模板填写后导入；标准模板可直接自动映射。文件仅在浏览器 Web Worker 中解析；同时兼容 .xlsx 和 UTF-8 .csv，旧 .xls 请先另存为 .xlsx。
              </n-alert>
              <input data-test="file-input" type="file" accept=".xlsx,.csv" :disabled="parsing || importing" @change="onFileChange" />
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
            </n-card>

            <n-card v-if="parsedFile" title="2. 字段映射">
              <div class="template-row">
                <n-select
                  :value="selectedTemplateId"
                  :options="templateOptions"
                  clearable
                  placeholder="选择已保存的映射模板"
                  @update:value="applyTemplate"
                />
                <n-input v-model:value="templateName" placeholder="新模板名称" />
                <n-button :loading="savingTemplate" @click="saveTemplate">保存当前映射</n-button>
              </div>
              <div class="mapping-grid">
                <n-form-item v-for="field in fieldDefinitions" :key="field.key" :label="`${field.label}${field.required ? ' *' : ''}`">
                  <n-select
                    :value="mapping[field.key] ?? null"
                    :options="headerOptions"
                    clearable
                    :placeholder="field.required ? '请选择源列' : '可选'"
                    @update:value="(value: string | null) => { if (value) mapping[field.key] = value; else delete mapping[field.key]; }"
                  />
                </n-form-item>
              </div>
            </n-card>

            <n-card v-if="parsedFile" title="3. 服务端校验并发布">
              <n-alert type="warning" :bordered="false" class="section-note">
                浏览器映射不是最终真相：服务端会重新校验必填字段、数量精度和标准物资匹配。阻断错误不会进入正式需求池；未知物资会明确警告，不会当作零价或自动匹配。
              </n-alert>
              <n-button data-test="start-import" type="primary" :disabled="!importReady" :loading="importing" @click="startImport">
                开始导入并发布
              </n-button>
              <div v-if="importProgress" class="progress-block">
                <n-progress type="line" :percentage="Math.round(importProgress.total ? importProgress.current / importProgress.total * 100 : 0)" />
                <span>{{ importProgress.message }}</span>
              </div>
            </n-card>
          </template>
        </n-tab-pane>

        <n-tab-pane name="materials" tab="物资字典">
          <n-card title="标准物资">
            <template #header-extra>
              <n-button v-if="canWrite" data-test="add-material" type="primary" @click="showMaterialForm = !showMaterialForm">
                {{ showMaterialForm ? '收起' : '新增物资' }}
              </n-button>
            </template>
            <n-alert type="info" :bordered="false" class="section-note">
              标准物资按“型号 + 单位”区分；相同型号不同单位不会自动合并。导入时找不到完全匹配项只产生警告。
            </n-alert>
            <n-form v-if="showMaterialForm && canWrite" class="material-form" label-placement="top">
              <n-form-item label="编码（可选）"><n-input v-model:value="materialForm.code" /></n-form-item>
              <n-form-item label="名称"><n-input v-model:value="materialForm.name" data-test="material-name" /></n-form-item>
              <n-form-item label="型号"><n-input v-model:value="materialForm.model" data-test="material-model" /></n-form-item>
              <n-form-item label="单位"><n-input v-model:value="materialForm.unit" data-test="material-unit" /></n-form-item>
              <n-form-item><n-button data-test="save-material" type="primary" :loading="savingMaterial" @click="addMaterial">保存物资</n-button></n-form-item>
            </n-form>
            <n-data-table v-if="materials.length" :columns="materialColumns" :data="materials" :pagination="false" :scroll-x="720" />
            <n-empty v-else description="暂无标准物资。导入需求可以先进行，但未知物资会被标记为待核实。" />
          </n-card>
        </n-tab-pane>
      </n-tabs>
    </div>
  </n-spin>
</template>

<style scoped>
.section-note { margin-bottom: 16px; }
.status-line { margin-top: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.template-row { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) auto; gap: 10px; margin-bottom: 18px; }
.mapping-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.progress-block { display: grid; gap: 8px; margin-top: 18px; }
.review-list { display: grid; gap: 10px; margin-top: 14px; }
.review-row { display: grid; gap: 5px; padding: 12px; border: 1px solid #e5e9f0; border-radius: 8px; background: #fafbfc; }
.review-issue { font-size: 13px; }
.review-issue.error { color: #b42318; }
.review-issue.warning { color: #a15c00; }
.load-more { display: flex; justify-content: center; margin-top: 16px; }
.detail-card { margin-top: 16px; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.detail-grid div { display: grid; gap: 3px; }
.detail-grid span { color: #7c8798; font-size: 12px; }
.material-lines { display: grid; gap: 8px; margin-top: 20px; }
.material-line { display: grid; grid-template-columns: 1fr 140px minmax(160px, auto); align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid #edf0f4; }
.material-form { display: grid; grid-template-columns: 1fr 1fr 1fr 120px auto; gap: 12px; align-items: end; margin-bottom: 18px; }
.manual-demand-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
@media (max-width: 850px) {
  .template-row, .mapping-grid, .detail-grid, .material-form, .manual-demand-form { grid-template-columns: 1fr; }
  .material-line { grid-template-columns: 1fr; }
}
</style>
