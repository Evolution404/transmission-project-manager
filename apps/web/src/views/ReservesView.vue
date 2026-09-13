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
  CategoryMappingSummary,
  CurrentUser,
  DemandSummary,
  ProjectMaterialRequirementSummary,
  ReserveCategorySummary,
  ReserveProjectSummary,
} from '@tpm/shared';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const canWrite = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');

const loading = ref(true);
const error = ref('');
const projects = ref<ReserveProjectSummary[]>([]);
const demands = ref<DemandSummary[]>([]);
const reserveCategories = ref<ReserveCategorySummary[]>([]);
const categoryMappings = ref<CategoryMappingSummary[]>([]);
const selectedProject = ref<ReserveProjectSummary | null>(null);
const selectedCreateDemands = ref<Record<string, boolean>>({});
const selectedProjectDemands = ref<Record<string, boolean>>({});
const projectName = ref('');
const projectYear = ref('');
const projectOwner = ref('');
const creatingProject = ref(false);
const savingDemandLinks = ref(false);
const savingMaterials = ref(false);
const confirming = ref(false);
const materialRevisionReason = ref('');
const confirmationReason = ref('');
const materialDrafts = ref<Array<{
  id: string | null;
  materialId: string | null;
  model: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  reserveCategoryId: string | null;
}>>([]);

const newCategoryKey = ref('');
const newCategoryLabel = ref('');
const mappingDemandCategory = ref('');
const mappingCategoryId = ref<string | null>(null);
const savingRules = ref(false);

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

function parseScaled(value: string, digits: number): number | null {
  const raw = value.trim();
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const scale = 10n ** BigInt(digits);
  const scaled = BigInt(match[1]!) * scale + BigInt((match[2] ?? '').padEnd(digits, '0') || '0');
  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
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

function formatCompleteness(value: number) {
  return `${(value / 100).toFixed(2)}%`;
}

const categoryOptions = computed(() => reserveCategories.value
  .filter((item) => item.enabled)
  .map((item) => ({ label: item.label, value: item.id })));

async function loadProjects() {
  const data = await apiRequest<{ items: ReserveProjectSummary[]; nextCursor: string | null }>('/api/reserve-projects?limit=100');
  projects.value = data.items;
}

async function loadDemands() {
  const data = await apiRequest<{ items: DemandSummary[]; nextCursor: string | null }>('/api/demands?limit=100');
  demands.value = data.items;
}

async function loadRules() {
  const [categories, mappings] = await Promise.all([
    apiRequest<{ items: ReserveCategorySummary[] }>('/api/reserve-categories'),
    apiRequest<{ items: CategoryMappingSummary[] }>('/api/category-mappings'),
  ]);
  reserveCategories.value = categories.items;
  categoryMappings.value = mappings.items;
}

async function loadInitial() {
  loading.value = true;
  error.value = '';
  try {
    await Promise.all([loadProjects(), loadDemands(), loadRules()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取项目储备数据失败';
  } finally {
    loading.value = false;
  }
}

function initializeProjectDrafts(detail: ReserveProjectSummary) {
  const linked = new Set(detail.demandLinks.map((item) => item.demandId));
  selectedProjectDemands.value = Object.fromEntries(demands.value.map((item) => [item.id, linked.has(item.id)]));
  materialDrafts.value = detail.materialRequirements.map((item) => ({
    id: item.id,
    materialId: item.materialId,
    model: item.model,
    unit: item.unit,
    quantity: formatScaled(item.requiredQuantityScaled),
    unitPrice: item.unitPriceScaled === null ? '' : formatScaled(item.unitPriceScaled),
    reserveCategoryId: item.reserveCategoryId,
  }));
}

async function openProject(row: Pick<ReserveProjectSummary, 'id'>) {
  try {
    const detail = await apiRequest<ReserveProjectSummary>(`/api/reserve-projects/${encodeURIComponent(row.id)}`);
    selectedProject.value = detail;
    initializeProjectDrafts(detail);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '储备项目详情读取失败');
  }
}

async function reloadSelectedProject() {
  const id = selectedProject.value?.id;
  await loadProjects();
  if (id) await openProject({ id });
}

async function createProject() {
  const name = projectName.value.trim();
  if (!name) { message.warning('请输入项目名称'); return; }
  const year = projectYear.value.trim() ? Number(projectYear.value) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) { message.warning('年度格式无效'); return; }
  const demandIds = demands.value.filter((item) => selectedCreateDemands.value[item.id]).map((item) => item.id);
  creatingProject.value = true;
  try {
    const created = await apiRequest<ReserveProjectSummary>('/api/reserve-projects', writeInit('POST', {
      name,
      year,
      owner: projectOwner.value.trim() || null,
      demandIds,
      materials: [],
    }));
    projectName.value = '';
    projectYear.value = '';
    projectOwner.value = '';
    selectedCreateDemands.value = {};
    await loadProjects();
    await openProject(created);
    message.success('储备项目已创建；项目物资可独立补充');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '储备项目创建失败');
  } finally {
    creatingProject.value = false;
  }
}

async function saveDemandLinks() {
  if (!selectedProject.value) return;
  const demandIds = demands.value.filter((item) => selectedProjectDemands.value[item.id]).map((item) => item.id);
  savingDemandLinks.value = true;
  try {
    await apiRequest(`/api/reserve-projects/${encodeURIComponent(selectedProject.value.id)}/demands`, writeInit('PUT', {
      expectedVersion: selectedProject.value.version,
      demandIds,
    }));
    await reloadSelectedProject();
    message.success('项目需求来源关系已保存');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '需求来源关系保存失败');
  } finally {
    savingDemandLinks.value = false;
  }
}

function addProjectMaterial() {
  materialDrafts.value.push({ id: null, materialId: null, model: '', unit: '', quantity: '', unitPrice: '', reserveCategoryId: null });
}

function removeProjectMaterial(index: number) {
  materialDrafts.value.splice(index, 1);
}

async function saveProjectMaterials() {
  if (!selectedProject.value) return;
  const reason = materialRevisionReason.value.trim();
  if (!reason) { message.warning('请填写本次项目物资调整原因'); return; }
  const materials: Array<{
    id?: string;
    materialId: string | null;
    model: string;
    unit: string;
    requiredQuantityScaled: number;
    unitPriceScaled: number | null;
    reserveCategoryId: string | null;
  }> = [];
  for (const row of materialDrafts.value) {
    const model = row.model.trim();
    const unit = row.unit.trim();
    const requiredQuantityScaled = parseScaled(row.quantity, 4);
    const unitPriceScaled = row.unitPrice.trim() ? parseScaled(row.unitPrice, 4) : null;
    if (!model || !unit || requiredQuantityScaled === null || requiredQuantityScaled <= 0) {
      message.warning('每条项目物资都必须填写型号、单位和正数数量（最多 4 位小数）');
      return;
    }
    if (row.unitPrice.trim() && unitPriceScaled === null) {
      message.warning('项目物资单价最多 4 位小数；留空表示未知');
      return;
    }
    materials.push({
      ...(row.id ? { id: row.id } : {}),
      materialId: row.materialId,
      model,
      unit,
      requiredQuantityScaled,
      unitPriceScaled,
      reserveCategoryId: row.reserveCategoryId,
    });
  }
  savingMaterials.value = true;
  try {
    await apiRequest(`/api/reserve-projects/${encodeURIComponent(selectedProject.value.id)}/materials`, writeInit('PUT', {
      expectedVersion: selectedProject.value.version,
      reason,
      materials,
    }));
    materialRevisionReason.value = '';
    await reloadSelectedProject();
    message.success('项目物资已按独立版本调整');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '项目物资调整失败');
  } finally {
    savingMaterials.value = false;
  }
}

async function confirmProject() {
  if (!selectedProject.value) return;
  confirming.value = true;
  try {
    await apiRequest(`/api/reserve-projects/${encodeURIComponent(selectedProject.value.id)}/confirm`, writeInit('POST', {
      expectedVersion: selectedProject.value.version,
      reason: confirmationReason.value.trim() || null,
    }));
    confirmationReason.value = '';
    await reloadSelectedProject();
    message.success('储备版本已确认');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '储备确认失败');
  } finally {
    confirming.value = false;
  }
}

async function createReserveCategory() {
  if (!newCategoryKey.value.trim() || !newCategoryLabel.value.trim()) { message.warning('请填写大类 key 和名称'); return; }
  savingRules.value = true;
  try {
    await apiRequest('/api/reserve-categories', writeInit('POST', { key: newCategoryKey.value.trim(), label: newCategoryLabel.value.trim() }));
    newCategoryKey.value = '';
    newCategoryLabel.value = '';
    await loadRules();
    message.success('储备大类已新增');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '储备大类保存失败');
  } finally {
    savingRules.value = false;
  }
}

async function saveCategoryMapping() {
  const demandCategory = mappingDemandCategory.value.trim();
  if (!demandCategory || !mappingCategoryId.value) { message.warning('请选择需求类别与储备大类'); return; }
  const current = categoryMappings.value.find((item) => item.demandCategory.toLowerCase() === demandCategory.toLowerCase());
  savingRules.value = true;
  try {
    await apiRequest(`/api/category-mappings/${encodeURIComponent(demandCategory)}`, writeInit('PUT', {
      expectedVersion: current?.version ?? null,
      reserveCategoryId: mappingCategoryId.value,
    }));
    await loadRules();
    message.success('类别映射已保存');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '类别映射保存失败');
  } finally {
    savingRules.value = false;
  }
}

const projectColumns = [
  { title: '项目', key: 'name', minWidth: 180 },
  { title: '年度', key: 'year', width: 90, render: (row: ReserveProjectSummary) => row.year ?? '—' },
  { title: '来源需求', key: 'demandLinks', width: 100, render: (row: ReserveProjectSummary) => row.demandLinks.length },
  { title: '项目物资', key: 'materialRequirements', width: 100, render: (row: ReserveProjectSummary) => row.materialRequirements.length },
  { title: '状态', key: 'status', width: 110, render: (row: ReserveProjectSummary) => h(NTag, { size: 'small', bordered: false, type: row.status === 'confirmed' ? 'success' : 'warning' }, { default: () => row.status === 'confirmed' ? `已确认 v${row.reserveVersion}` : '草稿' }) },
  { title: '当前物资金额', key: 'knownMaterialAmountFen', width: 150, render: (row: ReserveProjectSummary) => formatMoneyFen(row.knownMaterialAmountFen) },
  { title: '估价完整度', key: 'materialPriceCompletenessBasisPoints', width: 120, render: (row: ReserveProjectSummary) => formatCompleteness(row.materialPriceCompletenessBasisPoints) },
  { title: '操作', key: 'actions', width: 90, render: (row: ReserveProjectSummary) => h(NButton, { size: 'small', 'data-test': `open-project-${row.id}`, onClick: () => void openProject(row) }, { default: () => '查看' }) },
];

onMounted(loadInitial);
</script>

<template>
  <n-spin :show="loading">
    <div class="view-stack reserve-view">
      <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>
      <n-tabs type="line" animated>
        <n-tab-pane name="create" tab="建立储备">
          <n-alert type="info" :bordered="false" class="section-note">
            需求只说明“为什么做、在哪做、做什么事项”，项目物资是项目阶段独立确认的“需要什么、需要多少”。两者只建立来源关系，不做数量继承或上限绑定。
          </n-alert>
          <n-card v-if="canWrite" title="新建储备项目">
            <n-form class="project-form" label-placement="top">
              <n-form-item label="项目名称"><n-input v-model:value="projectName" data-test="project-name" /></n-form-item>
              <n-form-item label="年度"><n-input v-model:value="projectYear" placeholder="如 2026" /></n-form-item>
              <n-form-item label="负责人"><n-input v-model:value="projectOwner" /></n-form-item>
            </n-form>
            <div class="demand-list">
              <strong>关联需求来源（可为空）</strong>
              <n-checkbox v-for="demand in demands" :key="demand.id" v-model:checked="selectedCreateDemands[demand.id]" :data-test="`create-demand-${demand.id}`">
                {{ demand.sequenceNo }} · {{ demand.lineName }} {{ demand.section }} · {{ demand.category ?? '未分类' }}
              </n-checkbox>
            </div>
            <n-button data-test="create-project" type="primary" :loading="creatingProject" @click="createProject">创建储备项目</n-button>
          </n-card>
          <n-alert v-else type="info">当前账号只能查看储备项目。</n-alert>
        </n-tab-pane>

        <n-tab-pane name="projects" tab="储备项目">
          <n-card title="储备列表">
            <n-data-table v-if="projects.length" :columns="projectColumns" :data="projects" :pagination="false" :scroll-x="1050" />
            <n-empty v-else description="暂无储备项目" />
          </n-card>

          <template v-if="selectedProject">
            <n-card title="项目详情" class="detail-card">
              <div class="detail-grid">
                <div><span>项目</span><strong>{{ selectedProject.name }}</strong></div>
                <div><span>项目版本</span><strong>v{{ selectedProject.version }}</strong></div>
                <div><span>储备状态</span><strong>{{ selectedProject.status === 'confirmed' ? `已确认 v${selectedProject.reserveVersion}` : '草稿' }}</strong></div>
                <div><span>当前项目物资金额</span><strong>{{ formatMoneyFen(selectedProject.knownMaterialAmountFen) }}</strong></div>
              </div>
            </n-card>

            <n-card title="1. 需求来源关系" class="detail-card">
              <n-alert type="info" :bordered="false" class="section-note">这里维护项目由哪些抽象需求形成，只表示业务来源，不把需求物资数量当成项目物资上限。</n-alert>
              <div class="demand-list">
                <n-checkbox v-for="demand in demands" :key="demand.id" v-model:checked="selectedProjectDemands[demand.id]" :disabled="!canWrite" :data-test="`project-demand-${demand.id}`">
                  {{ demand.sequenceNo }} · {{ demand.lineName }} {{ demand.section }} · {{ demand.category ?? '未分类' }}
                </n-checkbox>
              </div>
              <n-button v-if="canWrite" data-test="save-demand-links" type="primary" :loading="savingDemandLinks" @click="saveDemandLinks">保存需求来源关系</n-button>
            </n-card>

            <n-card title="2. 项目物资" class="detail-card">
              <n-alert type="info" :bordered="false" class="section-note">
                项目物资可新增、换型、增减数量并保留修订历史；已经分配到执行任务的物资不能删除、换型或缩减到任务分配量以下。单价留空表示未知。
              </n-alert>
              <div v-if="materialDrafts.length" class="material-list">
                <div v-for="(row, index) in materialDrafts" :key="row.id ?? `new-${index}`" class="material-edit-row">
                  <n-input v-model:value="row.model" placeholder="型号" :disabled="!canWrite" :data-test="`material-model-${row.id ?? index}`" />
                  <n-input v-model:value="row.quantity" placeholder="数量" :disabled="!canWrite" :data-test="`material-quantity-${row.id ?? index}`" />
                  <n-input v-model:value="row.unit" placeholder="单位" :disabled="!canWrite" :data-test="`material-unit-${row.id ?? index}`" />
                  <n-input v-model:value="row.unitPrice" placeholder="单价 元/单位（可空）" :disabled="!canWrite" :data-test="`material-price-${row.id ?? index}`" />
                  <n-select v-model:value="row.reserveCategoryId" :options="categoryOptions" clearable placeholder="储备大类（可空）" :disabled="!canWrite" />
                  <n-button v-if="canWrite" quaternary type="error" @click="removeProjectMaterial(index)">移除</n-button>
                </div>
              </div>
              <n-empty v-else description="当前没有项目物资；这是有效状态。" />
              <template v-if="canWrite">
                <n-space vertical class="material-actions">
                  <n-button data-test="add-project-material" secondary @click="addProjectMaterial">新增项目物资</n-button>
                  <n-input data-test="material-revision-reason" v-model:value="materialRevisionReason" placeholder="本次调整原因（必填）" />
                  <n-button data-test="save-project-materials" type="primary" :loading="savingMaterials" @click="saveProjectMaterials">保存项目物资修订</n-button>
                </n-space>
              </template>
            </n-card>

            <n-card title="3. 确认储备版本" class="detail-card">
              <n-alert type="warning" :bordered="false" class="section-note">确认只固化当前储备版本；项目正式进入执行阶段还需要后续做一次“项目级出库”。</n-alert>
              <template v-if="canWrite">
                <n-input v-model:value="confirmationReason" placeholder="确认说明（可选）" />
                <n-button data-test="confirm-project" type="primary" :loading="confirming" @click="confirmProject">确认当前储备版本</n-button>
              </template>
            </n-card>
          </template>
        </n-tab-pane>

        <n-tab-pane name="rules" tab="储备分类规则">
          <n-card title="储备大类">
            <div class="category-grid">
              <n-tag v-for="item in reserveCategories" :key="item.id" :bordered="false" :type="item.enabled ? 'success' : 'default'">{{ item.label }}</n-tag>
            </div>
            <n-form v-if="canWrite" class="rule-form" label-placement="top">
              <n-form-item label="大类 key"><n-input v-model:value="newCategoryKey" /></n-form-item>
              <n-form-item label="大类名称"><n-input v-model:value="newCategoryLabel" /></n-form-item>
              <n-form-item><n-button :loading="savingRules" @click="createReserveCategory">新增大类</n-button></n-form-item>
            </n-form>
          </n-card>
          <n-card title="需求类别 → 储备大类默认映射" class="detail-card">
            <n-alert type="info" :bordered="false" class="section-note">映射只用于建议分类，不会把需求物资自动转换成项目物资。</n-alert>
            <div v-for="item in categoryMappings" :key="item.demandCategory" class="mapping-row">
              <span>{{ item.demandCategory }}</span><strong>{{ reserveCategories.find((category) => category.id === item.reserveCategoryId)?.label ?? '未找到储备大类' }}</strong>
            </div>
            <n-form v-if="canWrite" class="rule-form" label-placement="top">
              <n-form-item label="需求类别"><n-input v-model:value="mappingDemandCategory" /></n-form-item>
              <n-form-item label="储备大类"><n-select v-model:value="mappingCategoryId" :options="categoryOptions" /></n-form-item>
              <n-form-item><n-button :loading="savingRules" @click="saveCategoryMapping">保存映射</n-button></n-form-item>
            </n-form>
          </n-card>
        </n-tab-pane>
      </n-tabs>
    </div>
  </n-spin>
</template>

<style scoped>
.reserve-view { gap: 16px; }
.section-note { margin-bottom: 14px; }
.detail-card { margin-top: 14px; }
.project-form, .rule-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: end; }
.demand-list { display: grid; gap: 8px; margin: 14px 0; max-height: 320px; overflow: auto; }
.detail-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.detail-grid > div { display: grid; gap: 4px; padding: 12px; border: 1px solid #e5e9f0; border-radius: 9px; }
.detail-grid span { color: #6f7b8c; font-size: 12px; }
.material-list { display: grid; gap: 10px; margin-bottom: 12px; }
.material-edit-row { display: grid; grid-template-columns: 1.2fr .7fr .6fr 1fr 1fr auto; gap: 8px; align-items: center; }
.material-actions { margin-top: 12px; }
.category-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.mapping-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid #eef1f5; }
@media (max-width: 980px) {
  .project-form, .rule-form, .detail-grid { grid-template-columns: 1fr 1fr; }
  .material-edit-row { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 640px) {
  .project-form, .rule-form, .detail-grid, .material-edit-row { grid-template-columns: 1fr; }
}
</style>
