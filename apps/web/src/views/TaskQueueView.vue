<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NEmpty, NInput, NProgress, NSelect, NSpin, NTag } from 'naive-ui';
import type { CurrentUser, TaskQueueItemSummary, TaskQueuePage, TaskQueueStatus } from '@tpm/shared';
import { apiRequest } from '../api/client';
import AppPressable from '../app/AppPressable.vue';

defineProps<{ currentUser: CurrentUser }>();

const router = useRouter();
const route = useRoute();
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const items = ref<TaskQueueItemSummary[]>([]);
const nextCursor = ref<string | null>(null);
const query = ref(typeof route.query.query === 'string' ? route.query.query : '');
const status = ref<TaskQueueStatus>(['all', 'implementation_pending', 'settlement_pending'].includes(String(route.query.status))
  ? String(route.query.status) as TaskQueueStatus
  : 'all');
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let requestSequence = 0;

const statusOptions = [
  { label: '全部任务', value: 'all' },
  { label: '待实施', value: 'implementation_pending' },
  { label: '待结算', value: 'settlement_pending' },
];

function formatScaled(value: number) {
  const whole = Math.floor(value / 10000);
  const fraction = String(value % 10000).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function progress(done: number, planned: number) {
  return planned > 0 ? Math.min(100, Math.round(done / planned * 100)) : 0;
}

function stateLabel(item: TaskQueueItemSummary) {
  if (item.implementationComplete && item.settlementComplete) return '已实施已结算';
  if (item.implementationComplete) return '已实施未结算';
  if (item.settlementComplete) return '未实施已结算';
  return '未实施未结算';
}

function stateType(item: TaskQueueItemSummary) {
  if (item.implementationComplete && item.settlementComplete) return 'success' as const;
  if (item.settlementComplete) return 'info' as const;
  return 'default' as const;
}

const resultSummary = computed(() => {
  if (loading.value && !items.value.length) return '正在读取任务';
  return `${items.value.length} 个已加载任务`;
});

async function load(options: { append?: boolean } = {}) {
  const append = options.append === true;
  const sequence = ++requestSequence;
  if (append) loadingMore.value = true;
  else loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({ limit: '50', status: status.value });
    const term = query.value.trim();
    if (term) params.set('query', term);
    if (append && nextCursor.value) params.set('cursor', nextCursor.value);
    const page = await apiRequest<TaskQueuePage>(`/api/tasks?${params.toString()}`);
    if (sequence !== requestSequence) return;
    items.value = append ? [...items.value, ...page.items] : page.items;
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    if (sequence !== requestSequence) return;
    error.value = cause instanceof Error ? cause.message : '读取执行任务失败';
  } finally {
    if (sequence === requestSequence) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function openTask(item: TaskQueueItemSummary) {
  void router.push({
    path: `/projects/${encodeURIComponent(item.projectId)}/tasks/${encodeURIComponent(item.id)}`,
    query: { from: route.fullPath },
  });
}

function syncRouteFilters() {
  const next: Record<string, string> = {};
  const term = query.value.trim();
  if (status.value !== 'all') next.status = status.value;
  if (term) next.query = term;
  void router.replace({ query: next });
}

watch(status, () => {
  nextCursor.value = null;
  syncRouteFilters();
  void load();
});

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    nextCursor.value = null;
    syncRouteFilters();
    void load();
  }, 220);
});

onMounted(() => load());
</script>

<template>
  <div class="view-stack task-queue-view">
    <header class="page-header">
      <div class="page-header-copy">
        <span class="page-eyebrow">任务执行</span>
        <h2 class="page-title">执行任务</h2>
        <p class="page-description">跨项目查看当前授权范围内的任务，供应、实施和结算保持独立进度。</p>
      </div>
    </header>

    <section class="task-list-surface">
      <div class="task-toolbar">
        <n-input v-model:value="query" clearable placeholder="搜索任务、项目、范围或负责人" class="task-search" />
        <n-select
          v-model:value="status"
          data-test="task-status-filter"
          :options="statusOptions"
          class="task-status-filter"
        />
        <span class="result-count">{{ resultSummary }}</span>
      </div>

      <div v-if="error" class="inline-error">
        <span>{{ error }}</span>
        <n-button text @click="load()">重新加载</n-button>
      </div>

      <n-spin :show="loading">
        <div v-if="items.length" class="desktop-task-list">
          <div class="task-table-head" aria-hidden="true">
            <span>任务 / 项目</span><span>计划</span><span>供应</span><span>实施</span><span>结算</span><span></span>
          </div>
          <app-pressable
            v-for="item in items"
            :key="item.id"
            :data-test="`open-task-${item.id}`"
            class="task-table-row"
            @click="openTask(item)"
          >
            <span class="task-identity">
              <strong>{{ item.name }}</strong>
              <small>{{ item.projectName }}<template v-if="item.scopeText"> · {{ item.scopeText }}</template></small>
            </span>
            <span class="task-plan">
              <strong>{{ item.plannedDate || '未设日期' }}</strong>
              <small>{{ item.owner || '未指定负责人' }}</small>
            </span>
            <span class="supply-summary-list">
              <template v-if="item.supplyTotals.length">
                <small v-for="supply in item.supplyTotals" :key="supply.taskMaterialRequirementId">
                  {{ supply.model }} · 到货 {{ formatScaled(supply.totals.arrivedQuantityScaled) }} {{ supply.unit }}
                </small>
              </template>
              <small v-else>无任务物资</small>
            </span>
            <span class="progress-cell">
              <span><strong>实施 {{ progress(item.implementedQuantityScaled, item.plannedQuantityScaled) }}%</strong><small>{{ formatScaled(item.implementedQuantityScaled) }} / {{ formatScaled(item.plannedQuantityScaled) }} {{ item.unit }}</small></span>
              <n-progress type="line" :height="4" :show-indicator="false" :percentage="progress(item.implementedQuantityScaled, item.plannedQuantityScaled)" />
            </span>
            <span class="progress-cell">
              <span><strong>结算 {{ progress(item.settledQuantityScaled, item.plannedQuantityScaled) }}%</strong><small>{{ formatScaled(item.settledQuantityScaled) }} / {{ formatScaled(item.plannedQuantityScaled) }} {{ item.unit }}</small></span>
              <n-progress type="line" :height="4" :show-indicator="false" :percentage="progress(item.settledQuantityScaled, item.plannedQuantityScaled)" />
            </span>
            <span class="task-row-end"><n-tag size="small" :bordered="false" :type="stateType(item)">{{ stateLabel(item) }}</n-tag><span class="row-chevron">›</span></span>
          </app-pressable>
        </div>

        <div v-if="items.length" class="mobile-task-list">
          <app-pressable v-for="item in items" :key="item.id" class="mobile-task-row" :data-test="`mobile-open-task-${item.id}`" @click="openTask(item)">
            <div class="mobile-task-heading">
              <div><strong>{{ item.name }}</strong><small>{{ item.projectName }}</small></div>
              <span class="row-chevron">›</span>
            </div>
            <div class="mobile-task-meta">
              <span>{{ item.scopeText || '未填写范围' }}</span><span>{{ item.plannedDate || '未设计划日' }}</span><span>{{ item.owner || '未指定负责人' }}</span>
            </div>
            <div class="mobile-task-status-row">
              <n-tag size="small" :bordered="false" :type="stateType(item)">{{ stateLabel(item) }}</n-tag>
              <span>计划 {{ formatScaled(item.plannedQuantityScaled) }} {{ item.unit }}</span>
            </div>
            <div v-if="item.supplyTotals.length" class="mobile-supply-lines">
              <span v-for="supply in item.supplyTotals" :key="supply.taskMaterialRequirementId">{{ supply.model }} · 到货 {{ formatScaled(supply.totals.arrivedQuantityScaled) }} {{ supply.unit }}</span>
            </div>
            <div class="mobile-progress-grid">
              <div><span>实施</span><strong>{{ progress(item.implementedQuantityScaled, item.plannedQuantityScaled) }}%</strong></div>
              <div><span>结算</span><strong>{{ progress(item.settledQuantityScaled, item.plannedQuantityScaled) }}%</strong></div>
            </div>
          </app-pressable>
        </div>

        <n-empty v-if="!loading && !items.length" description="当前筛选下没有执行任务" class="task-empty" />
      </n-spin>

      <div v-if="nextCursor" class="load-more">
        <n-button :loading="loadingMore" @click="load({ append: true })">加载更多</n-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.task-queue-view { max-width: 1480px; }
.task-list-surface { overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.task-toolbar { display: flex; align-items: center; gap: 10px; min-height: 64px; padding: 12px 16px; border-bottom: 1px solid var(--ui-border); }
.task-search { width: min(420px, 42vw); }
.task-status-filter { width: 150px; }
.result-count { margin-left: auto; color: var(--ui-text-tertiary); font-size: 13px; white-space: nowrap; }
.inline-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 14px 16px 0; padding: 11px 13px; border-radius: 10px; background: var(--ui-danger-soft); color: var(--ui-danger); font-size: 13px; }
.task-table-head, .task-table-row { display: grid; grid-template-columns: minmax(260px, 1.55fr) 135px minmax(190px, 1.1fr) minmax(150px, .8fr) minmax(150px, .8fr) minmax(142px, auto); gap: 18px; align-items: center; }
.task-table-head { min-height: 42px; padding: 0 18px; border-bottom: 1px solid var(--ui-border); background: var(--ui-surface-subtle); color: var(--ui-text-tertiary); font-size: 13px; font-weight: 700; letter-spacing: .02em; }
.task-table-row { width: 100%; min-height: 88px; padding: 13px 18px; border: 0; border-bottom: 1px solid var(--ui-border); background: transparent; color: inherit; text-align: left; cursor: pointer; transition: background-color 120ms ease; }
.task-table-row:last-child { border-bottom: 0; }
.task-table-row:hover { background: var(--ui-surface-subtle); }
.task-identity, .task-plan, .supply-summary-list, .progress-cell, .progress-cell > span { display: grid; min-width: 0; gap: 4px; }
.task-identity strong { overflow: hidden; font-size: 13px; font-weight: 670; text-overflow: ellipsis; white-space: nowrap; }
.task-identity small, .task-plan small, .supply-summary-list small, .progress-cell small { overflow: hidden; color: var(--ui-text-secondary); font-size: 13px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.task-plan strong { font-size: 13px; font-weight: 620; font-variant-numeric: tabular-nums; }
.supply-summary-list { max-height: 54px; overflow: hidden; }
.progress-cell strong { font-size: 13px; font-weight: 650; }
.task-row-end { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.row-chevron { color: var(--ui-text-tertiary); font-size: 20px; line-height: 1; }
.mobile-task-list { display: none; }
.task-empty { padding: 56px 16px; }
.load-more { display: flex; justify-content: center; padding: 14px 16px; border-top: 1px solid var(--ui-border); }
@media (max-width: 1180px) {
  .task-table-head, .task-table-row { grid-template-columns: minmax(230px, 1.4fr) 120px minmax(170px, 1fr) minmax(135px, .75fr) minmax(135px, .75fr); }
  .task-table-head > :last-child, .task-row-end { display: none; }
}
@media (max-width: 767px) {
  .task-toolbar { align-items: stretch; flex-wrap: wrap; min-height: 0; padding: 12px 13px; }
  .task-search { width: 100%; }
  .task-status-filter { flex: 1; width: auto; }
  .result-count { display: flex; align-items: center; margin-left: 0; }
  .desktop-task-list { display: none; }
  .mobile-task-list { display: grid; }
  .mobile-task-row { display: grid; gap: 11px; width: 100%; padding: 15px 14px; border: 0; border-bottom: 1px solid var(--ui-border); background: transparent; color: inherit; text-align: left; }
  .mobile-task-row:last-child { border-bottom: 0; }
  .mobile-task-heading { display: grid; grid-template-columns: minmax(0,1fr) 18px; gap: 10px; align-items: center; }
  .mobile-task-heading > div { display: grid; gap: 3px; min-width: 0; }
  .mobile-task-heading strong { font-size: 14px; font-weight: 670; line-height: 1.45; overflow-wrap: anywhere; }
  .mobile-task-heading small { color: var(--ui-text-secondary); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
  .mobile-task-meta { display: flex; flex-wrap: wrap; gap: 5px 12px; color: var(--ui-text-tertiary); font-size: 13px; }
  .mobile-task-status-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--ui-text-secondary); font-size: 13px; }
  .mobile-task-status-row > span { font-variant-numeric: tabular-nums; }
  .mobile-supply-lines { display: grid; gap: 3px; padding: 9px 10px; border-radius: 9px; background: var(--ui-surface-muted); color: var(--ui-text-secondary); font-size: 13px; }
  .mobile-progress-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; overflow: hidden; border: 1px solid var(--ui-border); border-radius: 9px; background: var(--ui-border); }
  .mobile-progress-grid > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; background: var(--ui-surface); }
  .mobile-progress-grid span { color: var(--ui-text-secondary); font-size: 13px; }
  .mobile-progress-grid strong { font-size: 13px; font-variant-numeric: tabular-nums; }
}
</style>
