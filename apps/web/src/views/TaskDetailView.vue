<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NDatePicker, NDrawer, NDrawerContent, NEmpty, NForm, NFormItem, NInput, NProgress, NSelect, NSpin, NTag, useMessage } from 'naive-ui';
import type { CurrentUser, ProjectExecutionSummary, ProjectTaskExecutionSummary, ReserveProjectSummary, TaskMaterialRequirementSummary } from '@tpm/shared';
import { ApiRequestError, apiRequest, jsonRequestInit } from '../api/client';
import TaskImplementationDrawer from '../features/tasks/TaskImplementationDrawer.vue';
import TaskSettlementDrawer from '../features/tasks/TaskSettlementDrawer.vue';
import AppPressable from '../app/AppPressable.vue';

const props = defineProps<{ currentUser: CurrentUser }>();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const projectId = computed(() => String(route.params.projectId));
const taskId = computed(() => String(route.params.taskId));
const projectTasksPath = computed(() => `/projects/${encodeURIComponent(projectId.value)}?tab=tasks`);
const returnTarget = computed(() => {
  const from = typeof route.query.from === 'string' ? route.query.from : '';
  if (from.startsWith('/tasks')) return from;
  const projectPath = `/projects/${encodeURIComponent(projectId.value)}`;
  if (from === projectPath || from.startsWith(`${projectPath}?`)) return from;
  return projectTasksPath.value;
});
const returnLabel = computed(() => returnTarget.value.startsWith('/tasks') ? '返回任务队列' : '返回项目');
const project = ref<ReserveProjectSummary | null>(null);
const execution = ref<ProjectExecutionSummary | null>(null);
const task = ref<ProjectTaskExecutionSummary | null>(null);
const loading = ref(true);
const error = ref('');
type TaskDetailSection = 'supply' | 'implementation' | 'settlement' | 'scope';
const taskDetailSections = new Set<TaskDetailSection>(['supply', 'implementation', 'settlement', 'scope']);
const requestedSection = typeof route.query.section === 'string' ? route.query.section : '';
const activeSection = ref<TaskDetailSection>(taskDetailSections.has(requestedSection as TaskDetailSection) ? requestedSection as TaskDetailSection : 'supply');
type SupplyStage = 'reported' | 'shipped' | 'arrived';
const supplyOpen = ref(false);
const supplyMaterialId = ref<string | null>(null);
const supplyStage = ref<SupplyStage>('reported');
const supplyQuantity = ref('');
const supplyDate = ref(Date.now());
const supplyNote = ref('');
const supplyError = ref('');
const supplyConflict = ref(false);
const savingSupply = ref(false);
const supplyIdempotencyKey = ref('');
const implementationOpen = ref(false);
const settlementOpen = ref(false);

const canSupply = computed(() => ['admin', 'project_manager', 'implementation'].includes(props.currentUser.role));
const canSettle = computed(() => ['admin', 'project_manager', 'finance'].includes(props.currentUser.role));
const selectedMaterial = computed(() => task.value?.materials.find((item) => item.id === supplyMaterialId.value) ?? null);
const selectedSupply = computed(() => task.value?.supplyTotals.find((item) => item.taskMaterialRequirementId === supplyMaterialId.value) ?? null);
const supplyStageOptions = [
  { label: '已上报', value: 'reported' },
  { label: '已发货', value: 'shipped' },
  { label: '已到货', value: 'arrived' },
];
const supplyStageLabel = computed(() => supplyStageOptions.find((item) => item.value === supplyStage.value)?.label ?? '供应');

function formatScaled(value: number) {
  const whole = Math.floor(value / 10000);
  const fraction = String(value % 10000).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function parseScaled(value: string): number | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,4}))?$/);
  if (!match) return null;
  const scaled = BigInt(match[1]!) * 10000n + BigInt((match[2] ?? '').padEnd(4, '0') || '0');
  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

function progress(done: number, planned: number) {
  return planned ? Math.min(100, Math.round(done / planned * 100)) : 0;
}

const implementationProgress = computed(() => task.value ? progress(task.value.implementedQuantityScaled, task.value.plannedQuantityScaled) : 0);
const settlementProgress = computed(() => task.value ? progress(task.value.settledQuantityScaled, task.value.plannedQuantityScaled) : 0);
const supplyMaximumScaled = computed(() => {
  const material = selectedMaterial.value;
  const supply = selectedSupply.value;
  if (!material || !supply) return 0;
  if (supplyStage.value === 'reported') return Math.max(0, material.requiredQuantityScaled - supply.totals.reportedQuantityScaled);
  if (supplyStage.value === 'shipped') return Math.max(0, supply.totals.reportedQuantityScaled - supply.totals.shippedQuantityScaled);
  return Math.max(0, supply.totals.shippedQuantityScaled - supply.totals.arrivedQuantityScaled);
});
const supplyCurrentScaled = computed(() => {
  const supply = selectedSupply.value;
  if (!supply) return 0;
  if (supplyStage.value === 'reported') return supply.totals.reportedQuantityScaled;
  if (supplyStage.value === 'shipped') return supply.totals.shippedQuantityScaled;
  return supply.totals.arrivedQuantityScaled;
});
const supplyPreviewScaled = computed(() => {
  const quantity = parseScaled(supplyQuantity.value);
  if (quantity === null) return null;
  return supplyCurrentScaled.value + quantity;
});

function businessDateFromTimestamp(value: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [projectData, executionData] = await Promise.all([
      apiRequest<ReserveProjectSummary>(`/api/reserve-projects/${encodeURIComponent(projectId.value)}`),
      apiRequest<ProjectExecutionSummary>(`/api/projects/${encodeURIComponent(projectId.value)}/execution`),
    ]);
    const selectedTask = executionData.tasks.find((item) => item.id === taskId.value) ?? null;
    if (!selectedTask) throw new Error('执行任务不存在或当前账号无权访问');
    project.value = projectData;
    execution.value = executionData;
    task.value = selectedTask;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '任务详情读取失败';
  } finally { loading.value = false; }
}

function supplyFor(material: TaskMaterialRequirementSummary) {
  return task.value?.supplyTotals.find((item) => item.taskMaterialRequirementId === material.id) ?? null;
}

function preferredSupplyStage(materialId: string): SupplyStage {
  const material = task.value?.materials.find((item) => item.id === materialId);
  const supply = task.value?.supplyTotals.find((item) => item.taskMaterialRequirementId === materialId);
  if (!material || !supply) return 'reported';
  if (supply.totals.reportedQuantityScaled < material.requiredQuantityScaled) return 'reported';
  if (supply.totals.shippedQuantityScaled < supply.totals.reportedQuantityScaled) return 'shipped';
  return 'arrived';
}

function openSupply(materialId: string) {
  supplyMaterialId.value = materialId;
  supplyStage.value = preferredSupplyStage(materialId);
  supplyQuantity.value = '';
  supplyNote.value = '';
  supplyError.value = '';
  supplyConflict.value = false;
  supplyIdempotencyKey.value = crypto.randomUUID();
  supplyDate.value = Date.now();
  supplyOpen.value = true;
}

function closeSupply() {
  if (savingSupply.value) return;
  supplyOpen.value = false;
}

watch([supplyStage, supplyQuantity, supplyDate, supplyNote], () => {
  supplyError.value = '';
  supplyConflict.value = false;
  if (supplyOpen.value) supplyIdempotencyKey.value = crypto.randomUUID();
});

async function saveSupply() {
  const material = selectedMaterial.value;
  const supply = selectedSupply.value;
  const quantityScaled = parseScaled(supplyQuantity.value);
  if (!material || !supply || quantityScaled === null || quantityScaled <= 0) {
    supplyError.value = '请输入大于 0 的本次数量';
    return;
  }
  if (quantityScaled > supplyMaximumScaled.value) {
    supplyError.value = `本次最多可登记 ${formatScaled(supplyMaximumScaled.value)} ${material.unit}`;
    return;
  }
  savingSupply.value = true;
  supplyError.value = '';
  supplyConflict.value = false;
  try {
    await apiRequest('/api/task-material-supply-events', jsonRequestInit('POST', {
      taskMaterialRequirementId: material.id,
      expectedSupplyVersion: material.supplyVersion,
      stage: supplyStage.value,
      quantityScaled,
      eventDate: businessDateFromTimestamp(supplyDate.value),
      note: supplyNote.value.trim() || null,
    }, supplyIdempotencyKey.value));
    await load();
    supplyOpen.value = false;
    message.success(`${supplyStageLabel.value}已登记`);
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) {
      supplyConflict.value = true;
      supplyError.value = '记录已被更新。你的输入仍保留，请读取最新数据后再确认。';
    } else {
      supplyError.value = cause instanceof Error ? cause.message : '供应进度登记失败';
    }
  } finally { savingSupply.value = false; }
}

async function reloadSupplyAfterConflict() {
  const draftQuantity = supplyQuantity.value;
  const draftStage = supplyStage.value;
  const draftDate = supplyDate.value;
  const draftNote = supplyNote.value;
  await load();
  supplyStage.value = draftStage;
  supplyQuantity.value = draftQuantity;
  supplyDate.value = draftDate;
  supplyNote.value = draftNote;
  supplyConflict.value = false;
  supplyError.value = '';
  supplyIdempotencyKey.value = crypto.randomUUID();
}

function backToOrigin() { void router.push(returnTarget.value); }
function setActiveSection(value: string) {
  const nextSection = value as TaskDetailSection;
  if (!taskDetailSections.has(nextSection)) return;
  activeSection.value = nextSection;
  const query = { ...route.query };
  if (nextSection === 'supply') delete query.section;
  else query.section = nextSection;
  void router.replace({ query });
}

onMounted(load);
</script>

<template>
  <div class="view-stack task-detail-view">
    <app-pressable class="breadcrumb-back" @click="backToOrigin">‹ {{ returnLabel }}</app-pressable>
    <div v-if="error" class="detail-error">{{ error }} <n-button text @click="load">重新加载</n-button></div>
    <n-spin :show="loading">
      <template v-if="project && task">
        <section class="object-header">
          <div>
            <div class="object-kicker">{{ project.name }} / 执行任务</div>
            <h2>{{ task.name }}</h2>
            <div class="object-tags">
              <span>{{ task.scopeText || '未填写现场范围' }}</span>
              <span>{{ task.plannedDate || '未设计划日' }}</span>
              <span>{{ task.owner || '未指定负责人' }}</span>
              <n-tag v-if="props.currentUser.role === 'readonly'" size="small" :bordered="false">只读</n-tag>
            </div>
          </div>
        </section>

        <section class="parallel-summary" aria-label="任务三线摘要">
          <article class="summary-card supply-summary">
            <span class="summary-label">供应</span>
            <template v-if="task.supplyTotals.length">
              <strong>到货 {{ formatScaled(task.supplyTotals.reduce((sum, item) => sum + item.totals.arrivedQuantityScaled, 0)) }}</strong>
              <div class="supply-facts">
                <span>上报 {{ formatScaled(task.supplyTotals.reduce((sum, item) => sum + item.totals.reportedQuantityScaled, 0)) }}</span>
                <span>发货 {{ formatScaled(task.supplyTotals.reduce((sum, item) => sum + item.totals.shippedQuantityScaled, 0)) }}</span>
                <span>到货 {{ formatScaled(task.supplyTotals.reduce((sum, item) => sum + item.totals.arrivedQuantityScaled, 0)) }}</span>
              </div>
            </template>
            <span v-else class="summary-empty">该任务没有物资</span>
          </article>
          <article class="summary-card">
            <span class="summary-label">实施</span>
            <strong>{{ formatScaled(task.implementedQuantityScaled) }} / {{ formatScaled(task.plannedQuantityScaled) }}</strong>
            <n-progress type="line" :show-indicator="false" :percentage="implementationProgress" />
            <span class="summary-foot">{{ implementationProgress }}% 已完成</span>
          </article>
          <article class="summary-card">
            <span class="summary-label">结算</span>
            <strong>{{ formatScaled(task.settledQuantityScaled) }} / {{ formatScaled(task.plannedQuantityScaled) }}</strong>
            <n-progress type="line" :show-indicator="false" :percentage="settlementProgress" />
            <span class="summary-foot">{{ settlementProgress }}% 已覆盖</span>
          </article>
        </section>

        <nav class="segment-nav" aria-label="任务详情分段">
          <app-pressable v-for="item in [['supply','供应'],['implementation','实施'],['settlement','结算'],['scope','范围']]" :key="item[0]" :data-test="`task-section-${item[0]}`" :class="{ active: activeSection === item[0] }" @click="setActiveSection(item[0]!)">{{ item[1] }}</app-pressable>
        </nav>

        <section v-if="activeSection === 'supply'" class="detail-section">
          <div class="section-heading"><div><h3>物资供应</h3><p>供应数量按任务物资分别记录，不跨单位合并。</p></div></div>
          <div v-if="task.materials.length" class="supply-list">
            <div v-for="material in task.materials" :key="material.id" class="supply-line">
              <div class="material-main"><strong>{{ material.model }}</strong><span>任务需求 {{ formatScaled(material.requiredQuantityScaled) }} {{ material.unit }}</span></div>
              <template v-if="supplyFor(material)">
                <div class="stage-value"><span>上报</span><strong>{{ formatScaled(supplyFor(material)!.totals.reportedQuantityScaled) }}</strong></div>
                <div class="stage-value"><span>发货</span><strong>{{ formatScaled(supplyFor(material)!.totals.shippedQuantityScaled) }}</strong></div>
                <div class="stage-value"><span>到货</span><strong>{{ formatScaled(supplyFor(material)!.totals.arrivedQuantityScaled) }}</strong></div>
              </template>
              <n-button v-if="canSupply && supplyFor(material)" :data-test="`open-supply-${material.id}`" secondary @click="openSupply(material.id)">登记供应</n-button>
            </div>
          </div>
          <n-empty v-else description="该任务未配置物资，可以直接推进实施与结算" />
        </section>

        <section v-else-if="activeSection === 'implementation'" class="detail-section placeholder-section">
          <div><h3>现场实施</h3><p>当前已实施 {{ formatScaled(task.implementedQuantityScaled) }} / {{ formatScaled(task.plannedQuantityScaled) }} {{ task.unit }}。实施不等待物资到货或结算。</p></div>
          <n-button v-if="canSupply && !task.implementationComplete" data-test="open-implementation" type="primary" @click="implementationOpen = true">记录实施</n-button>
        </section>
        <section v-else-if="activeSection === 'settlement'" class="detail-section placeholder-section">
          <div><h3>任务结算</h3><p>当前已覆盖 {{ formatScaled(task.settledQuantityScaled) }} / {{ formatScaled(task.plannedQuantityScaled) }} {{ task.unit }}；结算与实施独立。</p></div>
          <n-button v-if="canSettle && !task.settlementComplete" data-test="open-settlement" type="primary" @click="settlementOpen = true">登记结算</n-button>
        </section>
        <section v-else class="detail-section">
          <div class="section-heading"><div><h3>任务范围</h3><p>范围事实决定实施与结算如何回投到原始需求。</p></div></div>
          <div class="scope-list"><div v-for="scope in task.demandScopes" :key="scope.id"><strong>{{ scope.demand?.lineName }} {{ scope.demand?.section }}</strong><span>{{ formatScaled(scope.plannedQuantityScaled) }} {{ task.unit }}</span></div></div>
        </section>
      </template>
    </n-spin>

    <n-drawer v-model:show="supplyOpen" placement="right" :width="520" :mask-closable="!savingSupply" class="supply-drawer" @mask-click="closeSupply">
      <n-drawer-content title="登记供应进度" :closable="!savingSupply">
        <template v-if="selectedMaterial && selectedSupply">
          <div class="supply-context">
            <strong>{{ selectedMaterial.model }}</strong>
            <span>{{ task?.name }}</span>
          </div>
          <div class="supply-current">
            <div><span>任务需求</span><strong>{{ formatScaled(selectedMaterial.requiredQuantityScaled) }} {{ selectedMaterial.unit }}</strong></div>
            <div><span>已上报</span><strong>{{ formatScaled(selectedSupply.totals.reportedQuantityScaled) }} {{ selectedMaterial.unit }}</strong></div>
            <div><span>已发货</span><strong>{{ formatScaled(selectedSupply.totals.shippedQuantityScaled) }} {{ selectedMaterial.unit }}</strong></div>
            <div><span>已到货</span><strong>{{ formatScaled(selectedSupply.totals.arrivedQuantityScaled) }} {{ selectedMaterial.unit }}</strong></div>
            <div class="max-row"><span>本次最多</span><strong>{{ formatScaled(supplyMaximumScaled) }} {{ selectedMaterial.unit }}</strong></div>
          </div>
          <n-alert v-if="supplyError" :type="supplyConflict ? 'warning' : 'error'" :bordered="false" class="supply-alert">{{ supplyError }}</n-alert>
          <n-button v-if="supplyConflict" data-test="reload-supply-after-conflict" secondary block class="conflict-reload" @click="reloadSupplyAfterConflict">读取最新数据</n-button>
          <n-form label-placement="top" class="supply-form">
            <n-form-item label="供应阶段">
              <n-select v-model:value="supplyStage" data-test="supply-stage" :options="supplyStageOptions" />
            </n-form-item>
            <n-form-item :label="`本次${supplyStageLabel}数量`">
              <div class="quantity-input"><n-input data-test="supply-quantity" v-model:value="supplyQuantity" inputmode="decimal" /><span>{{ selectedMaterial.unit }}</span></div>
            </n-form-item>
            <n-form-item label="业务日期"><n-date-picker v-model:value="supplyDate" type="date" clearable /></n-form-item>
            <n-form-item label="备注"><n-input v-model:value="supplyNote" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" /></n-form-item>
          </n-form>
          <div v-if="supplyPreviewScaled !== null && parseScaled(supplyQuantity) && parseScaled(supplyQuantity)! <= supplyMaximumScaled" class="supply-preview">
            保存后累计{{ supplyStageLabel }}将为 <strong>{{ formatScaled(supplyPreviewScaled) }} {{ selectedMaterial.unit }}</strong>
          </div>
          <div class="drawer-actions"><n-button @click="closeSupply">取消</n-button><n-button data-test="save-supply" type="primary" :loading="savingSupply" @click="saveSupply">保存供应进度</n-button></div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <task-implementation-drawer
      v-if="task"
      v-model:show="implementationOpen"
      :task="task"
      @saved="load"
      @request-refresh="load"
    />
    <task-settlement-drawer
      v-if="task"
      v-model:show="settlementOpen"
      :task="task"
      @saved="load"
      @request-refresh="load"
    />
  </div>
</template>

<style scoped>
.task-detail-view { max-width: 1260px; }
.breadcrumb-back { justify-self: start; padding: 3px 0; border: 0; background: transparent; color: var(--ui-text-secondary); cursor: pointer; }
.object-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 4px 2px 8px; }
.object-kicker { margin-bottom: 5px; color: var(--ui-text-secondary); font-size: 13px; }
.object-header h2 { margin: 0; font-size: 28px; line-height: 1.25; letter-spacing: -.025em; }
.object-tags { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 10px; color: var(--ui-text-secondary); font-size: 13px; }
.parallel-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.summary-card { display: grid; gap: 10px; min-height: 148px; padding: 18px 20px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.summary-label { color: var(--ui-text-secondary); font-size: 13px; font-weight: 650; }
.summary-card > strong { align-self: end; font-size: 24px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.summary-foot, .summary-empty { color: var(--ui-text-secondary); font-size: 13px; }
.supply-facts { display: flex; flex-wrap: wrap; gap: 7px 14px; color: var(--ui-text-secondary); font-size: 13px; }
.segment-nav { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--ui-border); border-radius: 14px; background: var(--ui-surface-muted); overflow-x: auto; scrollbar-width: none; }
.segment-nav button { min-width: 88px; min-height: 38px; padding: 0 15px; border: 0; border-radius: 10px; background: transparent; color: var(--ui-text-secondary); cursor: pointer; }
.segment-nav button.active { background: var(--ui-surface); color: var(--ui-text); font-weight: 700; }
.detail-section { padding: 22px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.section-heading h3, .placeholder-section h3 { margin: 0; font-size: 18px; }
.section-heading p, .placeholder-section p { margin: 4px 0 0; color: var(--ui-text-secondary); font-size: 13px; }
.supply-list { display: grid; }
.supply-line { display: grid; grid-template-columns: minmax(220px, 1.6fr) repeat(3, minmax(80px, .55fr)) auto; gap: 16px; align-items: center; min-height: 72px; border-bottom: 1px solid var(--ui-border); }
.supply-line:last-child { border-bottom: 0; }
.material-main, .stage-value { display: grid; gap: 4px; }
.material-main span, .stage-value span { color: var(--ui-text-secondary); font-size: 13px; }
.stage-value strong { font-variant-numeric: tabular-nums; }
.placeholder-section { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.scope-list { display: grid; }
.scope-list > div { display: flex; justify-content: space-between; gap: 20px; padding: 13px 0; border-bottom: 1px solid var(--ui-border); }
.scope-list span { color: var(--ui-text-secondary); }
.detail-error { padding: 14px 16px; border-radius: 12px; background: var(--ui-danger-soft); color: var(--ui-danger); }
.supply-context { display: grid; gap: 3px; margin-bottom: 20px; }
.supply-context strong { font-size: 18px; }
.supply-context span { color: var(--ui-text-secondary); font-size: 13px; }
.supply-current { display: grid; gap: 1px; overflow: hidden; margin-bottom: 20px; border: 1px solid var(--ui-border); border-radius: 14px; background: var(--ui-border); }
.supply-current > div { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; background: var(--ui-surface); }
.supply-current span { color: var(--ui-text-secondary); font-size: 13px; }
.max-row { background: var(--ui-accent-soft) !important; }
.supply-alert, .conflict-reload { margin-bottom: 14px; }
.quantity-input { display: flex; align-items: center; gap: 10px; width: 100%; }
.quantity-input > span { flex: 0 0 auto; color: var(--ui-text-secondary); }
.supply-preview { margin: 4px 0 18px; padding: 12px 14px; border-radius: 12px; background: var(--ui-surface-muted); color: var(--ui-text-secondary); font-size: 13px; }
.supply-preview strong { color: var(--ui-text); }
.drawer-actions { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 10px; padding-top: 14px; background: var(--ui-surface); }
@media (max-width: 900px) { .supply-line { grid-template-columns: minmax(180px, 1fr) repeat(3, 80px); } .supply-line > .n-button { grid-column: 1 / -1; justify-self: start; margin-bottom: 12px; } }
@media (max-width: 767px) {
  .object-header { align-items: flex-start; }
  .object-header h2 { font-size: 24px; }
  .parallel-summary { grid-template-columns: 1fr; gap: 10px; }
  .summary-card { min-height: 0; padding: 15px 16px; }
  .summary-card > strong { font-size: 20px; }
  .segment-nav { margin-inline: -2px; }
  .detail-section { padding: 17px 16px; }
  .supply-line { grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 15px 0; }
  .material-main { grid-column: 1 / -1; }
  .supply-line > .n-button { grid-column: 1 / -1; width: 100%; justify-self: stretch; margin: 2px 0 0; }
  .placeholder-section { align-items: stretch; flex-direction: column; }
  .placeholder-section > .n-button { width: 100%; }
  :global(.supply-drawer .n-drawer) { width: 100vw !important; max-width: 100vw !important; }
  .drawer-actions { padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .drawer-actions .n-button:last-child { flex: 1; }
}
</style>
