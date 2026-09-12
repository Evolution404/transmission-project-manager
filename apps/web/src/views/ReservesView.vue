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
  ProjectDetail,
  ProjectSummary,
  ReserveCandidate,
  ReserveCategorySummary,
} from '@tpm/shared';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const canWrite = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');

const loading = ref(true);
const error = ref('');
const projects = ref<ProjectSummary[]>([]);
const projectCursor = ref<string | null>(null);
const candidates = ref<ReserveCandidate[]>([]);
const candidateCursor = ref<string | null>(null);
const suggestions = ref<Array<{ year: number | null; category: string | null; voltage: string; lineName: string; itemCount: number }>>([]);
const reserveCategories = ref<ReserveCategorySummary[]>([]);
const categoryMappings = ref<CategoryMappingSummary[]>([]);
const selectedProject = ref<ProjectDetail | null>(null);

const selectedCandidates = ref<Record<string, boolean>>({});
const allocationQuantities = ref<Record<string, string>>({});
const projectName = ref('');
const projectYear = ref('');
const projectOwner = ref('');
const creatingProject = ref(false);

const materialPriceDraft = ref<Record<string, string>>({});
const constructionCost = ref('');
const otherCost = ref('');
const savingCosts = ref(false);
const categoryDrafts = ref<Record<string, Array<{ categoryId: string | null; amountYuan: string }>>>({});
const savingCategories = ref(false);
const confirmationReason = ref('');
const confirming = ref(false);

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

function parseDecimalScaled(value: string, digits: number): number | null {
  const raw = value.trim();
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const scale = 10n ** BigInt(digits);
  const integer = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(digits, '0') || '0');
  const scaled = integer * scale + fraction;
  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

function formatScaled(value: number, digits: number) {
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

async function loadProjects(reset = true) {
  const url = reset || !projectCursor.value
    ? '/api/projects?limit=50'
    : `/api/projects?limit=50&cursor=${encodeURIComponent(projectCursor.value)}`;
  const data = await apiRequest<{ items: ProjectSummary[]; nextCursor: string | null }>(url);
  projects.value = reset ? data.items : [...projects.value, ...data.items];
  projectCursor.value = data.nextCursor;
}

async function loadCandidates(reset = true) {
  const url = reset || !candidateCursor.value
    ? '/api/projects/candidates?limit=100'
    : `/api/projects/candidates?limit=100&cursor=${encodeURIComponent(candidateCursor.value)}`;
  if (reset) {
    const [candidateData, suggestionData] = await Promise.all([
      apiRequest<{ items: ReserveCandidate[]; nextCursor: string | null }>(url),
      apiRequest<{ items: typeof suggestions.value }>('/api/projects/suggestions?limit=100'),
    ]);
    candidates.value = candidateData.items;
    candidateCursor.value = candidateData.nextCursor;
    suggestions.value = suggestionData.items;
    return;
  }
  const candidateData = await apiRequest<{ items: ReserveCandidate[]; nextCursor: string | null }>(url);
  candidates.value = [...candidates.value, ...candidateData.items];
  candidateCursor.value = candidateData.nextCursor;
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
    await Promise.all([loadProjects(), loadCandidates(), loadRules()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取 P3 储备数据失败';
  } finally {
    loading.value = false;
  }
}

function candidateChanged(candidate: ReserveCandidate, checked: boolean) {
  selectedCandidates.value[candidate.demandMaterialId] = checked;
  if (checked) {
    allocationQuantities.value[candidate.demandMaterialId] ||= formatScaled(candidate.remainingQuantityScaled, 4);
    if (!projectYear.value && candidate.year) projectYear.value = String(candidate.year);
  }
}

async function createProject() {
  const selected = candidates.value.filter((item) => selectedCandidates.value[item.demandMaterialId]);
  if (!projectName.value.trim() || selected.length === 0) {
    message.warning('请输入项目名称并至少选择一条需求物资');
    return;
  }
  const allocations = selected.map((item) => ({
    demandMaterialId: item.demandMaterialId,
    quantityScaled: parseDecimalScaled(allocationQuantities.value[item.demandMaterialId] ?? '', 4),
  }));
  if (allocations.some((item) => item.quantityScaled === null || item.quantityScaled <= 0)) {
    message.warning('分配数量必须为正数且最多 4 位小数');
    return;
  }
  const year = projectYear.value.trim() ? Number(projectYear.value) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
    message.warning('年度格式无效');
    return;
  }
  creatingProject.value = true;
  try {
    await apiRequest<ProjectSummary>('/api/projects', writeInit('POST', {
      name: projectName.value.trim(),
      year,
      owner: projectOwner.value.trim() || null,
      allocations: allocations.map((item) => ({ demandMaterialId: item.demandMaterialId, quantityScaled: item.quantityScaled! })),
    }));
    projectName.value = '';
    projectOwner.value = '';
    selectedCandidates.value = {};
    allocationQuantities.value = {};
    await Promise.all([loadProjects(), loadCandidates()]);
    message.success('储备项目草稿已创建');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '储备项目创建失败');
  } finally {
    creatingProject.value = false;
  }
}

function initializeEstimateDraft(detail: ProjectDetail) {
  const prices: Record<string, string> = {};
  for (const allocation of detail.allocations) {
    const line = detail.costLines.find((item) => item.kind === 'material' && item.demandAllocationId === allocation.id);
    prices[allocation.id] = line?.unitPriceScaled === null || line?.unitPriceScaled === undefined
      ? ''
      : formatScaled(line.unitPriceScaled, 4);
  }
  materialPriceDraft.value = prices;
  const construction = detail.costLines.filter((item) => item.kind === 'construction' && item.amountFen !== null).reduce((sum, item) => sum + (item.amountFen ?? 0), 0);
  const other = detail.costLines.filter((item) => item.kind === 'other' && item.amountFen !== null).reduce((sum, item) => sum + (item.amountFen ?? 0), 0);
  constructionCost.value = construction ? formatScaled(construction, 2) : '';
  otherCost.value = other ? formatScaled(other, 2) : '';

  const drafts: Record<string, Array<{ categoryId: string | null; amountYuan: string }>> = {};
  for (const line of detail.costLines.filter((item) => item.amountFen !== null)) {
    const existing = detail.categoryAllocations.filter((item) => item.costLineId === line.id);
    drafts[line.id] = existing.length
      ? existing.map((item) => ({ categoryId: item.reserveCategoryId, amountYuan: formatScaled(item.amountFen, 2) }))
      : [{ categoryId: line.suggestedReserveCategoryId, amountYuan: formatScaled(line.amountFen ?? 0, 2) }];
  }
  categoryDrafts.value = drafts;
}

async function openProject(row: Pick<ProjectSummary, 'id'>) {
  try {
    const detail = await apiRequest<ProjectDetail>(`/api/projects/${row.id}`);
    selectedProject.value = detail;
    initializeEstimateDraft(detail);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '储备项目详情读取失败');
  }
}

async function reloadSelectedProject() {
  if (!selectedProject.value) return;
  await openProject({ id: selectedProject.value.id });
  await loadProjects();
}

async function saveCosts() {
  if (!selectedProject.value) return;
  const materialPrices = selectedProject.value.allocations.map((allocation) => {
    const raw = materialPriceDraft.value[allocation.id]?.trim() ?? '';
    const unitPriceScaled = raw ? parseDecimalScaled(raw, 4) : null;
    return { demandAllocationId: allocation.id, unitPriceScaled, source: null, priceDate: null, taxInclusive: null };
  });
  if (materialPrices.some((item) => item.unitPriceScaled === null && (materialPriceDraft.value[item.demandAllocationId]?.trim() ?? '') !== '')) {
    message.warning('物资单价必须为非负数且最多 4 位小数');
    return;
  }
  const fixedCosts: Array<{ kind: 'construction' | 'other'; label: string; amountFen: number; source: null; priceDate: null; taxInclusive: null }> = [];
  for (const [kind, label, raw] of [
    ['construction', '施工费', constructionCost.value],
    ['other', '其他费', otherCost.value],
  ] as const) {
    if (!raw.trim()) continue;
    const amountFen = parseDecimalScaled(raw, 2);
    if (amountFen === null) {
      message.warning(`${label}必须为非负金额且最多 2 位小数`);
      return;
    }
    fixedCosts.push({ kind, label, amountFen, source: null, priceDate: null, taxInclusive: null });
  }
  savingCosts.value = true;
  try {
    await apiRequest(`/api/projects/${selectedProject.value.id}/costs`, writeInit('PUT', {
      expectedVersion: selectedProject.value.version,
      materialPrices,
      fixedCosts,
    }));
    await reloadSelectedProject();
    message.success('估算已保存');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '估算保存失败');
  } finally {
    savingCosts.value = false;
  }
}

const categoryOptions = computed(() => reserveCategories.value.filter((item) => item.enabled).map((item) => ({ label: item.label, value: item.id })));

function addCategorySplit(costLineId: string) {
  (categoryDrafts.value[costLineId] ??= []).push({ categoryId: null, amountYuan: '' });
}

function removeCategorySplit(costLineId: string, index: number) {
  categoryDrafts.value[costLineId]?.splice(index, 1);
}

async function saveCategoryAllocations() {
  if (!selectedProject.value) return;
  const allocations: Array<{ costLineId: string; reserveCategoryId: string; amountFen: number }> = [];
  for (const line of selectedProject.value.costLines.filter((item) => item.amountFen !== null)) {
    for (const split of categoryDrafts.value[line.id] ?? []) {
      if (!split.categoryId || !split.amountYuan.trim()) continue;
      const amountFen = parseDecimalScaled(split.amountYuan, 2);
      if (amountFen === null) {
        message.warning('分类分摊金额必须为非负金额且最多 2 位小数');
        return;
      }
      allocations.push({ costLineId: line.id, reserveCategoryId: split.categoryId, amountFen });
    }
  }
  savingCategories.value = true;
  try {
    await apiRequest(`/api/projects/${selectedProject.value.id}/category-allocations`, writeInit('PUT', {
      expectedVersion: selectedProject.value.version,
      allocations,
    }));
    await reloadSelectedProject();
    message.success('分类金额分摊已保存');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '分类金额分摊失败');
  } finally {
    savingCategories.value = false;
  }
}

async function confirmProject() {
  if (!selectedProject.value) return;
  confirming.value = true;
  try {
    await apiRequest(`/api/projects/${selectedProject.value.id}/confirm`, writeInit('POST', {
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
  if (!newCategoryKey.value.trim() || !newCategoryLabel.value.trim()) {
    message.warning('请填写大类 key 和名称');
    return;
  }
  savingRules.value = true;
  try {
    await apiRequest('/api/reserve-categories', writeInit('POST', {
      key: newCategoryKey.value.trim(),
      label: newCategoryLabel.value.trim(),
    }));
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
  if (!demandCategory || !mappingCategoryId.value) {
    message.warning('请选择需求类别与储备大类');
    return;
  }
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
  { title: '年度', key: 'year', width: 90, render: (row: ProjectSummary) => row.year ?? '—' },
  { title: '状态', key: 'status', width: 90, render: (row: ProjectSummary) => h(NTag, { size: 'small', bordered: false, type: row.status === 'confirmed' ? 'success' : 'warning' }, { default: () => row.status === 'confirmed' ? `已确认 v${row.reserveVersion}` : '草稿' }) },
  { title: '已知估算', key: 'knownAmountFen', width: 130, render: (row: ProjectSummary) => formatMoneyFen(row.knownAmountFen) },
  { title: '估价完整度', key: 'completenessBasisPoints', width: 110, render: (row: ProjectSummary) => formatCompleteness(row.completenessBasisPoints) },
  {
    title: '操作', key: 'actions', width: 100,
    render(row: ProjectSummary) {
      return h(NButton, { size: 'small', 'data-test': `open-project-${row.id}`, onClick: () => void openProject(row) }, { default: () => '查看' });
    },
  },
];

onMounted(loadInitial);
</script>

<template>
  <n-spin :show="loading">
    <div class="view-stack reserve-view">
      <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>

      <n-tabs type="line" animated>
        <n-tab-pane name="convert" tab="需求转储备">
          <n-alert v-if="!canWrite" type="info" title="只读模式" class="section-note">
            你可以查看储备项目和来源明细；仅管理员或项目管理角色可以归并、分配、估算和确认储备。
          </n-alert>

          <template v-else>
            <n-card title="1. 选择需求与归并建议">
              <n-alert type="info" :bordered="false" class="section-note">
                系统按年度、类别、电压和线路给出建议，但不会自动合并。可跨线路选择，也可只分配部分数量到当前项目。
              </n-alert>
              <div v-if="suggestions.length" class="suggestion-grid">
                <div v-for="group in suggestions" :key="`${group.year}-${group.category}-${group.voltage}-${group.lineName}`" class="suggestion-card">
                  <strong>{{ group.lineName }}</strong>
                  <span>{{ group.year ?? '未设年度' }} · {{ group.category ?? '未分类' }} · {{ group.voltage }}</span>
                  <small>{{ group.itemCount }} 条可分配物资</small>
                </div>
              </div>
              <div v-if="candidates.length" class="candidate-list">
                <div v-for="candidate in candidates" :key="candidate.demandMaterialId" class="candidate-row">
                  <n-checkbox
                    :checked="Boolean(selectedCandidates[candidate.demandMaterialId])"
                    :data-test="`candidate-${candidate.demandMaterialId}`"
                    @update:checked="(checked: boolean) => candidateChanged(candidate, checked)"
                  >
                    {{ candidate.lineName }} {{ candidate.section }} · {{ candidate.rawModel }} / {{ candidate.unit ?? '未设单位' }}
                  </n-checkbox>
                  <span>剩余 {{ formatScaled(candidate.remainingQuantityScaled, 4) }} {{ candidate.unit ?? '' }}</span>
                  <n-input
                    v-if="selectedCandidates[candidate.demandMaterialId]"
                    :value="allocationQuantities[candidate.demandMaterialId] ?? ''"
                    :data-test="`allocation-${candidate.demandMaterialId}`"
                    placeholder="本项目分配数量"
                    @update:value="(value: string) => { allocationQuantities[candidate.demandMaterialId] = value; }"
                  />
                </div>
              </div>
              <div v-if="candidateCursor" class="load-more">
                <n-button data-test="load-more-candidates" secondary @click="loadCandidates(false)">加载更多待分配需求</n-button>
              </div>
              <n-empty v-else-if="!candidates.length" description="暂无可分配需求物资。" />
            </n-card>

            <n-card title="2. 建立储备草稿">
              <n-form class="project-form" label-placement="top">
                <n-form-item label="项目名称"><n-input v-model:value="projectName" data-test="project-name" /></n-form-item>
                <n-form-item label="年度"><n-input v-model:value="projectYear" placeholder="如 2026" /></n-form-item>
                <n-form-item label="负责人（可选）"><n-input v-model:value="projectOwner" /></n-form-item>
                <n-form-item>
                  <n-button data-test="create-project" type="primary" :loading="creatingProject" @click="createProject">创建储备草稿</n-button>
                </n-form-item>
              </n-form>
            </n-card>
          </template>
        </n-tab-pane>

        <n-tab-pane name="projects" tab="储备项目">
          <n-card title="储备列表">
            <n-data-table v-if="projects.length" :columns="projectColumns" :data="projects" :pagination="false" :scroll-x="850" />
            <n-empty v-else description="暂无储备项目。" />
            <div v-if="projectCursor" class="load-more"><n-button @click="loadProjects(false)">加载更多</n-button></div>
          </n-card>

          <template v-if="selectedProject">
            <n-card title="项目详情" class="detail-card">
              <div class="detail-grid">
                <div><span>项目</span><strong>{{ selectedProject.name }}</strong></div>
                <div><span>状态</span><strong>{{ selectedProject.status === 'confirmed' ? `已确认 v${selectedProject.reserveVersion}` : '草稿' }}</strong></div>
                <div><span>已知估算</span><strong>{{ formatMoneyFen(selectedProject.knownAmountFen) }}</strong></div>
                <div><span>估价完整度</span><strong>{{ formatCompleteness(selectedProject.completenessBasisPoints) }}</strong></div>
              </div>
              <div class="material-summary">
                <strong>物资汇总</strong>
                <div v-for="item in selectedProject.materialSummary" :key="`${item.materialId}-${item.model}-${item.unit}`" class="summary-row">
                  <span>{{ item.name ?? '未匹配标准物资' }} · {{ item.model }}</span>
                  <span>{{ formatScaled(item.quantityScaled, 4) }} {{ item.unit ?? '' }}</span>
                </div>
              </div>
              <div class="trace-list">
                <strong>来源明细</strong>
                <div v-for="allocation in selectedProject.allocations" :key="allocation.id" class="summary-row">
                  <span>{{ allocation.demand.lineName }} {{ allocation.demand.section }} · {{ allocation.rawModel }}</span>
                  <span>{{ allocation.source.fileName }} / {{ allocation.source.sheetName }} / 第 {{ allocation.source.rowNumber }} 行</span>
                </div>
              </div>
            </n-card>

            <n-card title="3. 核对物资与估算" class="detail-card">
              <n-alert type="info" :bordered="false" class="section-note">
                物资单价按元/单位录入，最多 4 位小数。留空表示未知；明确填写 0 才表示零价。系统使用定点整数计算并四舍五入到分。
              </n-alert>
              <div class="estimate-list">
                <div v-for="allocation in selectedProject.allocations" :key="allocation.id" class="estimate-row">
                  <span>{{ allocation.material?.name ?? allocation.rawModel }} · {{ formatScaled(allocation.quantityScaled, 4) }} {{ allocation.unit ?? '' }}</span>
                  <n-input
                    :value="materialPriceDraft[allocation.id] ?? ''"
                    :data-test="`material-price-${allocation.id}`"
                    placeholder="单价（元/单位；留空=未知）"
                    :disabled="!canWrite"
                    @update:value="(value: string) => { materialPriceDraft[allocation.id] = value; }"
                  />
                </div>
                <div class="estimate-row">
                  <span>施工费</span>
                  <n-input v-model:value="constructionCost" data-test="construction-cost" placeholder="金额（元）" :disabled="!canWrite" />
                </div>
                <div class="estimate-row">
                  <span>其他费</span>
                  <n-input v-model:value="otherCost" placeholder="金额（元）" :disabled="!canWrite" />
                </div>
              </div>
              <n-button v-if="canWrite" data-test="save-costs" type="primary" :loading="savingCosts" @click="saveCosts">保存估算</n-button>
            </n-card>

            <n-card v-if="selectedProject.costLines.length" title="分类金额分摊" class="detail-card">
              <n-alert type="info" :bordered="false" class="section-note">
                每条已知费用必须完整分摊；共同费用可拆到多个大类。分类金额合计必须等于项目已知估算金额。
              </n-alert>
              <div v-for="line in selectedProject.costLines.filter((item) => item.amountFen !== null)" :key="line.id" class="classification-block">
                <strong>{{ line.label }} · {{ formatMoneyFen(line.amountFen ?? 0) }}</strong>
                <div v-for="(split, index) in categoryDrafts[line.id] ?? []" :key="`${line.id}-${index}`" class="split-row">
                  <n-select
                    :value="split.categoryId"
                    :options="categoryOptions"
                    :disabled="!canWrite"
                    placeholder="选择储备大类"
                    @update:value="(value: string | null) => { split.categoryId = value; }"
                  />
                  <n-input v-model:value="split.amountYuan" placeholder="分摊金额（元）" :disabled="!canWrite" />
                  <n-button v-if="canWrite" size="small" @click="removeCategorySplit(line.id, index)">删除</n-button>
                </div>
                <n-button v-if="canWrite" size="small" secondary @click="addCategorySplit(line.id)">拆分一行</n-button>
              </div>
              <n-button v-if="canWrite" type="primary" :loading="savingCategories" @click="saveCategoryAllocations">保存分类分摊</n-button>
            </n-card>

            <n-card title="4. 确认储备版本" class="detail-card">
              <n-alert type="warning" :bordered="false" class="section-note">
                确认会保存不可变版本快照；后续调整会回到草稿状态，再次确认形成新的储备版本，旧版本不会被覆盖。
              </n-alert>
              <n-input v-if="canWrite" v-model:value="confirmationReason" type="textarea" placeholder="本次确认/修订原因（可选）" />
              <n-button v-if="canWrite" data-test="confirm-project" type="primary" :loading="confirming" @click="confirmProject">确认当前储备版本</n-button>
            </n-card>
          </template>
        </n-tab-pane>

        <n-tab-pane name="rules" tab="分类规则">
          <n-card title="储备大类与需求类别映射">
            <n-alert v-if="!canWrite" type="info" title="只读模式" class="section-note">你可以查看分类规则，但不能修改。</n-alert>
            <template v-else>
              <n-form class="rule-form" label-placement="top">
                <n-form-item label="大类 key"><n-input v-model:value="newCategoryKey" /></n-form-item>
                <n-form-item label="大类名称"><n-input v-model:value="newCategoryLabel" /></n-form-item>
                <n-form-item><n-button :loading="savingRules" @click="createReserveCategory">新增大类</n-button></n-form-item>
              </n-form>
              <n-form class="rule-form" label-placement="top">
                <n-form-item label="需求类别"><n-input v-model:value="mappingDemandCategory" placeholder="如 防断线" /></n-form-item>
                <n-form-item label="映射到"><n-select v-model:value="mappingCategoryId" :options="categoryOptions" /></n-form-item>
                <n-form-item><n-button :loading="savingRules" @click="saveCategoryMapping">保存映射</n-button></n-form-item>
              </n-form>
            </template>
            <div class="rule-list">
              <div v-for="category in reserveCategories" :key="category.id" class="summary-row">
                <span>{{ category.label }}</span><code>{{ category.key }}</code>
              </div>
              <div v-for="mapping in categoryMappings" :key="mapping.id" class="summary-row">
                <span>{{ mapping.demandCategory }}</span>
                <span>→ {{ reserveCategories.find((item) => item.id === mapping.reserveCategoryId)?.label ?? mapping.reserveCategoryId }}</span>
              </div>
            </div>
          </n-card>
        </n-tab-pane>
      </n-tabs>
    </div>
  </n-spin>
</template>

<style scoped>
.section-note { margin-bottom: 16px; }
.suggestion-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 18px; }
.suggestion-card { display: grid; gap: 4px; padding: 12px; border: 1px solid #e5e9f0; border-radius: 9px; background: #fafbfc; }
.suggestion-card span, .suggestion-card small { color: #6f7b8c; }
.candidate-list { display: grid; gap: 8px; }
.candidate-row { display: grid; grid-template-columns: minmax(260px, 1fr) 180px 220px; gap: 12px; align-items: center; padding: 9px 0; border-top: 1px solid #edf0f4; }
.project-form, .rule-form { display: grid; grid-template-columns: 2fr 1fr 1fr auto; gap: 12px; align-items: end; }
.detail-card { margin-top: 16px; }
.detail-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.detail-grid div { display: grid; gap: 3px; }
.detail-grid span { color: #7c8798; font-size: 12px; }
.material-summary, .trace-list, .estimate-list, .classification-block, .rule-list { display: grid; gap: 8px; margin-top: 18px; }
.summary-row { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; border-top: 1px solid #edf0f4; }
.estimate-row { display: grid; grid-template-columns: minmax(260px, 1fr) 260px; gap: 12px; align-items: center; }
.split-row { display: grid; grid-template-columns: minmax(180px, 1fr) 180px auto; gap: 8px; align-items: center; }
.load-more { display: flex; justify-content: center; margin-top: 16px; }
code { color: #667085; }
@media (max-width: 900px) {
  .suggestion-grid, .detail-grid { grid-template-columns: 1fr 1fr; }
  .candidate-row, .project-form, .rule-form, .estimate-row, .split-row { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .suggestion-grid, .detail-grid { grid-template-columns: 1fr; }
  .summary-row { flex-direction: column; }
}
</style>
