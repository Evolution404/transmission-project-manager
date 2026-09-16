<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NEmpty, NSpin, NTag } from 'naive-ui';
import type { FinancialEntryPage, FinancialEntrySummary, FrameworkSummary, ProjectBudgetSummary, ReserveProjectSummary } from '@tpm/shared';
import { apiRequest } from '../../api/client';

const props = defineProps<{ project: ReserveProjectSummary }>();
const emit = defineEmits<{ openWorkspace: [] }>();

const loading = ref(true);
const error = ref('');
const frameworks = ref<FrameworkSummary[]>([]);
const budgets = ref<ProjectBudgetSummary[]>([]);
const entries = ref<FinancialEntrySummary[]>([]);
const hasMoreEntries = ref(false);

const framework = computed(() => frameworks.value.find((item) => item.id === props.project.frameworkId) ?? null);
const currentBudget = computed(() => [...budgets.value].sort((a, b) => b.version - a.version)[0] ?? null);
const recentEntries = computed(() => entries.value.slice(0, 6));

function formatMoney(value: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value / 100);
}

function entryTypeLabel(item: FinancialEntrySummary) {
  return item.type === 'budget_occurrence' ? '预算发生' : '实际发生';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [frameworkData, budgetData, entryData] = await Promise.all([
      apiRequest<{ items: FrameworkSummary[] }>('/api/frameworks'),
      apiRequest<{ items: ProjectBudgetSummary[] }>(`/api/budgets?projectId=${encodeURIComponent(props.project.id)}`),
      apiRequest<FinancialEntryPage>(`/api/financial-entries?projectId=${encodeURIComponent(props.project.id)}&limit=20`),
    ]);
    frameworks.value = frameworkData.items;
    budgets.value = budgetData.items;
    entries.value = entryData.items;
    hasMoreEntries.value = Boolean(entryData.nextCursor) || entryData.items.length > 6;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取项目资金信息失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="project-finance-panel" data-test="project-finance-panel">
    <div class="section-heading finance-heading">
      <div>
        <h3>项目资金</h3>
        <p>展示项目当前预算和最近流水；最近流水不是累计统计。</p>
      </div>
      <n-button secondary @click="emit('openWorkspace')">打开资金工作区</n-button>
    </div>

    <div v-if="error" class="finance-error">{{ error }} <n-button text @click="load">重新加载</n-button></div>
    <n-spin :show="loading">
      <div class="finance-facts">
        <div>
          <span>所属框架</span>
          <strong>{{ framework ? `${framework.code} · ${framework.name}` : project.frameworkId ? '框架信息不可见' : '未归属框架' }}</strong>
        </div>
        <div>
          <span>当前预算</span>
          <strong>{{ currentBudget ? formatMoney(currentBudget.totalAmountFen) : '未建立预算' }}</strong>
          <small v-if="currentBudget">{{ currentBudget.status === 'confirmed' ? `已确认 v${currentBudget.budgetVersion}` : '预算草稿' }}</small>
        </div>
        <div>
          <span>协议分配</span>
          <strong>{{ currentBudget ? `${currentBudget.allocations.length} 项` : '—' }}</strong>
          <small>预算协议分配，不等同于资金发生</small>
        </div>
      </div>

      <div class="recent-finance">
        <div class="recent-heading">
          <div><strong>最近流水</strong><small>最多显示最近 6 条，不据此计算累计金额</small></div>
        </div>
        <div v-if="recentEntries.length" class="recent-list">
          <div v-for="item in recentEntries" :key="item.id" class="finance-entry-row">
            <span class="entry-date">{{ item.businessDate }}</span>
            <n-tag size="small" :bordered="false" :type="item.type === 'actual_cost' ? 'info' : 'default'">{{ entryTypeLabel(item) }}</n-tag>
            <strong>{{ formatMoney(item.amountFen) }}</strong>
            <span class="entry-note">{{ item.note || '无备注' }}</span>
          </div>
          <p v-if="hasMoreEntries" class="more-note">还有更多流水，请进入资金工作区继续查看。</p>
        </div>
        <n-empty v-else description="当前项目暂无资金流水" />
      </div>
    </n-spin>
  </section>
</template>

<style scoped>
.project-finance-panel { display: grid; gap: 18px; }
.finance-heading { margin-bottom: 0; }
.finance-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; border-radius: 10px; background: var(--ui-danger-soft); color: var(--ui-danger); font-size: 12px; }
.finance-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); }
.finance-facts > div { display: grid; gap: 5px; min-height: 100px; align-content: center; padding: 15px 17px; }
.finance-facts > div + div { border-left: 1px solid var(--ui-border); }
.finance-facts span, .finance-facts small, .recent-heading small { color: var(--ui-text-tertiary); font-size: 13px; line-height: 1.45; }
.finance-facts strong { font-size: 14px; font-weight: 670; font-variant-numeric: tabular-nums; }
.recent-finance { display: grid; gap: 10px; }
.recent-heading > div { display: grid; gap: 3px; }
.recent-heading strong { font-size: 13px; font-weight: 680; }
.recent-list { display: grid; border-top: 1px solid var(--ui-border); }
.finance-entry-row { display: grid; grid-template-columns: 100px 92px 130px minmax(0, 1fr); gap: 12px; align-items: center; min-height: 52px; border-bottom: 1px solid var(--ui-border); }
.entry-date { color: var(--ui-text-secondary); font-size: 13px; font-variant-numeric: tabular-nums; }
.finance-entry-row > strong { font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; }
.entry-note { overflow: hidden; color: var(--ui-text-secondary); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.more-note { margin: 10px 0 0; color: var(--ui-text-tertiary); font-size: 12px; }
@media (max-width: 767px) {
  .finance-heading { align-items: flex-start; gap: 12px; }
  .finance-heading > .n-button { flex: 0 0 auto; }
  .finance-facts { grid-template-columns: 1fr; }
  .finance-facts > div { min-height: 0; padding: 13px 14px; }
  .finance-facts > div + div { border-top: 1px solid var(--ui-border); border-left: 0; }
  .finance-entry-row { grid-template-columns: minmax(0, 1fr) auto; gap: 5px 10px; padding: 10px 0; }
  .entry-date { grid-column: 1; grid-row: 1; }
  .finance-entry-row .n-tag { grid-column: 2; grid-row: 1; }
  .finance-entry-row > strong { grid-column: 1; grid-row: 2; }
  .entry-note { grid-column: 1 / -1; grid-row: 3; }
}
</style>
