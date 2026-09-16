<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NDatePicker, NDrawer, NDrawerContent, NEmpty, NForm, NFormItem, NInput, NProgress, NSpin, NTag, useMessage } from 'naive-ui';
import type { CurrentUser, ProjectExecutionSummary, ProjectTaskExecutionSummary, ReserveProjectSummary, TaskMaterialRequirementSummary } from '@tpm/shared';
import { ApiRequestError, apiRequest, jsonRequestInit } from '../api/client';
import TaskImplementationDrawer from '../features/tasks/TaskImplementationDrawer.vue';
import TaskSettlementDrawer from '../features/tasks/TaskSettlementDrawer.vue';

const props = defineProps<{ currentUser: CurrentUser }>();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const projectId = computed(() => String(route.params.projectId));
const taskId = computed(() => String(route.params.taskId));
const project = ref<ReserveProjectSummary | null>(null);
const execution = ref<ProjectExecutionSummary | null>(null);
const task = ref<ProjectTaskExecutionSummary | null>(null);
const loading = ref(true);
const error = ref('');
const activeSection = ref('supply');
const arrivalOpen = ref(false);
const arrivalMaterialId = ref<string | null>(null);
const arrivalQuantity = ref('');
const arrivalDate = ref(Date.now());
const arrivalNote = ref('');
const arrivalError = ref('');
const arrivalConflict = ref(false);
const savingArrival = ref(false);
const arrivalIdempotencyKey = ref('');
const implementationOpen = ref(false);
const settlementOpen = ref(false);

const canSupply = computed(() => ['admin', 'project_manager', 'implementation'].includes(props.currentUser.role));
const canSettle = computed(() => ['admin', 'project_manager', 'finance'].includes(props.currentUser.role));
const selectedMaterial = computed(() => task.value?.materials.find((item) => item.id === arrivalMaterialId.value) ?? null);
const selectedSupply = computed(() => task.value?.supplyTotals.find((item) => item.taskMaterialRequirementId === arrivalMaterialId.value) ?? null);

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
const arrivalMaximumScaled = computed(() => {
  const supply = selectedSupply.value;
  if (!supply) return 0;
  return Math.max(0, supply.totals.shippedQuantityScaled - supply.totals.arrivedQuantityScaled);
});
const arrivalPreviewScaled = computed(() => {
  const supply = selectedSupply.value;
  const quantity = parseScaled(arrivalQuantity.value);
  if (!supply || quantity === null) return null;
  return supply.totals.arrivedQuantityScaled + quantity;
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

function openArrival(materialId: string) {
  arrivalMaterialId.value = materialId;
  arrivalQuantity.value = '';
  arrivalNote.value = '';
  arrivalError.value = '';
  arrivalConflict.value = false;
  arrivalIdempotencyKey.value = crypto.randomUUID();
  arrivalDate.value = Date.now();
  arrivalOpen.value = true;
}

function closeArrival() {
  if (savingArrival.value) return;
  arrivalOpen.value = false;
}

watch(arrivalQuantity, () => {
  arrivalError.value = '';
  arrivalConflict.value = false;
});
watch([arrivalDate, arrivalNote], () => {
  if (arrivalOpen.value) arrivalIdempotencyKey.value = crypto.randomUUID();
});

async function saveArrival() {
  const material = selectedMaterial.value;
  const supply = selectedSupply.value;
  const quantityScaled = parseScaled(arrivalQuantity.value);
  if (!material || !supply || quantityScaled === null || quantityScaled <= 0) {
    arrivalError.value = '请输入大于 0 的到货数量';
    return;
  }
  if (quantityScaled > arrivalMaximumScaled.value) {
    arrivalError.value = `本次最多可登记 ${formatScaled(arrivalMaximumScaled.value)} ${material.unit}`;
    return;
  }
  savingArrival.value = true;
  arrivalError.value = '';
  arrivalConflict.value = false;
  try {
    await apiRequest('/api/task-material-supply-events', jsonRequestInit('POST', {
      taskMaterialRequirementId: material.id,
      expectedSupplyVersion: material.supplyVersion,
      stage: 'arrived',
      quantityScaled,
      eventDate: businessDateFromTimestamp(arrivalDate.value),
      note: arrivalNote.value.trim() || null,
    }, arrivalIdempotencyKey.value));
    await load();
    arrivalOpen.value = false;
    message.success('到货已登记');
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) {
      arrivalConflict.value = true;
      arrivalError.value = '记录已被更新。你的输入仍保留，请读取最新数据后再确认。';
    } else {
      arrivalError.value = cause instanceof Error ? cause.message : '登记到货失败';
    }
  } finally { savingArrival.value = false; }
}

async function reloadAfterConflict() {
  const draft = arrivalQuantity.value;
  await load();
  arrivalQuantity.value = draft;
  arrivalConflict.value = false;
  arrivalError.value = '';
  arrivalIdempotencyKey.value = crypto.randomUUID();
}

function backToProject() { void router.push(`/projects/${encodeURIComponent(projectId.value)}?tab=tasks`); }

onMounted(load);
</script>

<template>
  <div class="view-stack task-detail-view">
    <button class="breadcrumb-back" @click="backToProject">‹ 返回项目</button>
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
          <n-button quaternary>更多</n-button>
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
          <button v-for="item in [['supply','供应'],['implementation','实施'],['settlement','结算'],['scope','范围']]" :key="item[0]" :data-test="`task-section-${item[0]}`" :class="{ active: activeSection === item[0] }" @click="activeSection = item[0]">{{ item[1] }}</button>
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
              <n-button v-if="canSupply && supplyFor(material) && supplyFor(material)!.totals.arrivedQuantityScaled < supplyFor(material)!.totals.shippedQuantityScaled" :data-test="`open-arrival-${material.id}`" secondary @click="openArrival(material.id)">登记到货</n-button>
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

    <n-drawer v-model:show="arrivalOpen" placement="right" :width="520" class="arrival-drawer" @mask-click="closeArrival">
      <n-drawer-content title="登记到货" closable>
        <template v-if="selectedMaterial && selectedSupply">
          <div class="arrival-context">
            <strong>{{ selectedMaterial.model }}</strong>
            <span>{{ task?.name }}</span>
          </div>
          <div class="arrival-current">
            <div><span>已发货</span><strong>{{ formatScaled(selectedSupply.totals.shippedQuantityScaled) }} {{ selectedMaterial.unit }}</strong></div>
            <div><span>已到货</span><strong>{{ formatScaled(selectedSupply.totals.arrivedQuantityScaled) }} {{ selectedMaterial.unit }}</strong></div>
            <div class="max-row"><span>本次最多</span><strong>{{ formatScaled(arrivalMaximumScaled) }} {{ selectedMaterial.unit }}</strong></div>
          </div>
          <n-alert v-if="arrivalError" :type="arrivalConflict ? 'warning' : 'error'" :bordered="false" class="arrival-alert">{{ arrivalError }}</n-alert>
          <n-button v-if="arrivalConflict" data-test="reload-after-conflict" secondary block class="conflict-reload" @click="reloadAfterConflict">读取最新数据</n-button>
          <n-form label-placement="top" class="arrival-form">
            <n-form-item label="本次到货数量">
              <div class="quantity-input"><n-input data-test="arrival-quantity" v-model:value="arrivalQuantity" inputmode="decimal" /><span>{{ selectedMaterial.unit }}</span></div>
            </n-form-item>
            <n-form-item label="到货日期"><n-date-picker v-model:value="arrivalDate" type="date" clearable /></n-form-item>
            <n-form-item label="备注"><n-input v-model:value="arrivalNote" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" /></n-form-item>
          </n-form>
          <div v-if="arrivalPreviewScaled !== null && parseScaled(arrivalQuantity) && parseScaled(arrivalQuantity)! <= arrivalMaximumScaled" class="arrival-preview">
            保存后累计到货将为 <strong>{{ formatScaled(arrivalPreviewScaled) }} {{ selectedMaterial.unit }}</strong>
          </div>
          <div class="drawer-actions"><n-button @click="closeArrival">取消</n-button><n-button data-test="save-arrival" type="primary" :loading="savingArrival" @click="saveArrival">登记到货</n-button></div>
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
.breadcrumb-back { justify-self: start; padding: 3px 0; border: 0; background: transparent; color: var(--ui-text-secondary, #566174); cursor: pointer; }
.object-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 4px 2px 8px; }
.object-kicker { margin-bottom: 5px; color: var(--ui-text-secondary, #566174); font-size: 13px; }
.object-header h2 { margin: 0; font-size: 28px; line-height: 1.25; letter-spacing: -.025em; }
.object-tags { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 10px; color: var(--ui-text-secondary, #566174); font-size: 13px; }
.parallel-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.summary-card { display: grid; gap: 10px; min-height: 148px; padding: 18px 20px; border: 1px solid var(--ui-border, #dce2ea); border-radius: 18px; background: var(--ui-surface, #fff); }
.summary-label { color: var(--ui-text-secondary, #566174); font-size: 13px; font-weight: 650; }
.summary-card > strong { align-self: end; font-size: 24px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.summary-foot, .summary-empty { color: var(--ui-text-secondary, #566174); font-size: 12px; }
.supply-facts { display: flex; flex-wrap: wrap; gap: 7px 14px; color: var(--ui-text-secondary, #566174); font-size: 12px; }
.segment-nav { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--ui-border, #dce2ea); border-radius: 14px; background: rgba(255,255,255,.72); overflow-x: auto; scrollbar-width: none; }
.segment-nav button { min-width: 88px; min-height: 38px; padding: 0 15px; border: 0; border-radius: 10px; background: transparent; color: var(--ui-text-secondary, #566174); cursor: pointer; }
.segment-nav button.active { background: var(--ui-surface, #fff); color: var(--ui-text, #18212f); font-weight: 700; box-shadow: 0 1px 3px rgba(25,40,65,.08); }
.detail-section { padding: 22px; border: 1px solid var(--ui-border, #dce2ea); border-radius: 18px; background: var(--ui-surface, #fff); }
.section-heading h3, .placeholder-section h3 { margin: 0; font-size: 18px; }
.section-heading p, .placeholder-section p { margin: 4px 0 0; color: var(--ui-text-secondary, #566174); font-size: 13px; }
.supply-list { display: grid; }
.supply-line { display: grid; grid-template-columns: minmax(220px, 1.6fr) repeat(3, minmax(80px, .55fr)) auto; gap: 16px; align-items: center; min-height: 72px; border-bottom: 1px solid var(--ui-border, #dce2ea); }
.supply-line:last-child { border-bottom: 0; }
.material-main, .stage-value { display: grid; gap: 4px; }
.material-main span, .stage-value span { color: var(--ui-text-secondary, #566174); font-size: 12px; }
.stage-value strong { font-variant-numeric: tabular-nums; }
.placeholder-section { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.scope-list { display: grid; }
.scope-list > div { display: flex; justify-content: space-between; gap: 20px; padding: 13px 0; border-bottom: 1px solid var(--ui-border, #dce2ea); }
.scope-list span { color: var(--ui-text-secondary, #566174); }
.detail-error { padding: 14px 16px; border-radius: 12px; background: #fff4f3; color: #b42318; }
.arrival-context { display: grid; gap: 3px; margin-bottom: 20px; }
.arrival-context strong { font-size: 18px; }
.arrival-context span { color: var(--ui-text-secondary, #566174); font-size: 13px; }
.arrival-current { display: grid; gap: 1px; overflow: hidden; margin-bottom: 20px; border: 1px solid var(--ui-border, #dce2ea); border-radius: 14px; background: var(--ui-border, #dce2ea); }
.arrival-current > div { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; background: var(--ui-surface, #fff); }
.arrival-current span { color: var(--ui-text-secondary, #566174); font-size: 13px; }
.max-row { background: var(--ui-accent-soft, #e6efff) !important; }
.arrival-alert, .conflict-reload { margin-bottom: 14px; }
.quantity-input { display: flex; align-items: center; gap: 10px; width: 100%; }
.quantity-input > span { flex: 0 0 auto; color: var(--ui-text-secondary, #566174); }
.arrival-preview { margin: 4px 0 18px; padding: 12px 14px; border-radius: 12px; background: var(--ui-surface-muted, #eef1f5); color: var(--ui-text-secondary, #566174); font-size: 13px; }
.arrival-preview strong { color: var(--ui-text, #18212f); }
.drawer-actions { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 10px; padding-top: 14px; background: var(--ui-surface, #fff); }
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
  :global(.arrival-drawer .n-drawer) { width: 100vw !important; max-width: 100vw !important; }
  .drawer-actions { padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .drawer-actions .n-button:last-child { flex: 1; }
}
</style>
