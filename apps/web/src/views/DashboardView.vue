<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NAlert, NCard, NGrid, NGridItem, NSpin, NStatistic, NTag } from 'naive-ui';
import type { AnalysisDashboardSummary, CurrentUser } from '@tpm/shared';
import { parseApiResponse } from '../api/response';

const props = defineProps<{ currentUser: CurrentUser }>();

const loading = ref(true);
const error = ref('');
const dashboard = ref<AnalysisDashboardSummary | null>(null);

function businessToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/analysis/dashboard?asOf=${businessToday()}`);
    const result = await parseApiResponse<AnalysisDashboardSummary>(response);
    if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
    dashboard.value = result.data;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取总览失败';
  } finally {
    loading.value = false;
  }
}

const roleLabels: Record<CurrentUser['role'], string> = {
  admin: '系统管理员',
  project_manager: '项目管理',
  implementation: '实施人员',
  finance: '财务人员',
  readonly: '只读用户',
};

onMounted(loadDashboard);
</script>

<template>
  <div class="view-stack dashboard-view">
    <n-alert v-if="error" type="error" title="数据读取失败">{{ error }}</n-alert>

    <div class="dashboard-hero">
      <div>
        <span class="eyebrow">业务总览</span>
        <h2>从需求到结算，一屏掌握当前状态</h2>
        <p>关注待进入执行的项目、实施后的结算待办和需要处理的活动预警。</p>
      </div>
      <n-tag :bordered="false" type="info">数据日期 {{ dashboard?.asOf ?? '—' }}</n-tag>
    </div>

    <n-spin :show="loading">
      <n-grid :cols="5" :x-gap="14" :y-gap="14" responsive="screen">
        <n-grid-item>
          <n-card class="metric-card">
            <span class="metric-label">已纳入需求</span>
            <n-statistic :value="dashboard?.demandCount ?? 0" />
            <small>已进入项目范围的需求</small>
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card class="metric-card">
            <span class="metric-label">项目总数</span>
            <n-statistic :value="dashboard?.projectCount ?? 0" />
            <small>当前授权范围内项目</small>
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card class="metric-card metric-card-attention">
            <span class="metric-label">待项目级出库</span>
            <n-statistic :value="dashboard?.unreleasedProjectCount ?? 0" />
            <small>尚未正式进入执行阶段</small>
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card class="metric-card metric-card-attention">
            <span class="metric-label">结算待办</span>
            <n-statistic :value="dashboard?.pendingSettlementCount ?? 0" />
            <small>已有实施事实、尚未最终结算</small>
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card class="metric-card metric-card-alert">
            <span class="metric-label">活动预警</span>
            <n-statistic :value="dashboard?.activeAlertCount ?? 0" />
            <small>规则越线或年度事项提醒</small>
          </n-card>
        </n-grid-item>
      </n-grid>
    </n-spin>

    <n-card title="业务主线" class="flow-card">
      <div class="flow-grid">
        <div class="flow-node"><span>01</span><strong>项目需求</strong><small>抽象事项，可附需求物资</small></div>
        <div class="flow-arrow">→</div>
        <div class="flow-node"><span>02</span><strong>项目储备</strong><small>确认来源与项目物资</small></div>
        <div class="flow-arrow">→</div>
        <div class="flow-node"><span>03</span><strong>项目级出库</strong><small>一次进入正式执行阶段</small></div>
        <div class="flow-arrow">→</div>
        <div class="flow-node"><span>04</span><strong>执行任务</strong><small>供应、实施、结算并行</small></div>
        <div class="flow-arrow">→</div>
        <div class="flow-node"><span>05</span><strong>需求反馈</strong><small>四状态回投原始需求</small></div>
      </div>
    </n-card>

    <n-card title="当前工作身份" class="identity-panel">
      <div class="identity-summary">
        <div><span>成员</span><strong>{{ props.currentUser.displayName }}</strong></div>
        <div><span>角色</span><strong>{{ roleLabels[props.currentUser.role] }}</strong></div>
        <div><span>授权范围</span><strong>{{ props.currentUser.scopes.length ? props.currentUser.scopes.length + ' 项' : '未配置' }}</strong></div>
        <div><span>登录账号</span><strong>@{{ props.currentUser.username }}</strong></div>
      </div>
    </n-card>
  </div>
</template>

<style scoped>
.dashboard-view { gap: 16px; }
.dashboard-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 22px;
  border: 1px solid #e4e9f1;
  border-radius: 14px;
  background: linear-gradient(115deg, #fff 0%, #f6f8fd 100%);
  box-shadow: 0 8px 24px rgba(18, 32, 61, 0.04);
}
.eyebrow { color: #2457d6; font-size: 11px; font-weight: 700; letter-spacing: .08em; }
.dashboard-hero h2 { margin: 4px 0 5px; font-size: 21px; color: #182033; letter-spacing: -.01em; }
.dashboard-hero p { margin: 0; color: #7e8898; font-size: 13px; }
.metric-card { position: relative; min-height: 132px; overflow: hidden; }
.metric-card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: #6f8de0; }
.metric-card-attention::before { background: #d89a32; }
.metric-card-alert::before { background: #c45e5e; }
.metric-label { display: block; margin-bottom: 8px; color: #697388; font-size: 12px; font-weight: 650; }
.metric-card :deep(.n-statistic-value) { font-size: 28px; font-weight: 720; color: #1b2740; letter-spacing: -.02em; }
.metric-card small { display: block; margin-top: 8px; color: #98a0ae; font-size: 10px; line-height: 1.5; }
.flow-grid { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr auto 1fr; gap: 10px; align-items: stretch; }
.flow-node { display: grid; gap: 5px; min-height: 100px; padding: 14px; border: 1px solid #e8ecf2; border-radius: 11px; background: #fafbfc; }
.flow-node span { color: #2457d6; font-size: 10px; font-weight: 750; letter-spacing: .08em; }
.flow-node strong { color: #2b3650; font-size: 13px; }
.flow-node small { color: #8a94a4; font-size: 11px; line-height: 1.5; }
.flow-arrow { align-self: center; color: #b0b7c4; font-size: 16px; }
@media (max-width: 1100px) { .flow-grid { grid-template-columns: 1fr; } .flow-arrow { display: none; } }
@media (max-width: 700px) { .dashboard-hero { align-items: flex-start; flex-direction: column; } }
</style>
