<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NDatePicker, NEmpty, NForm, NFormItem, NInput, NModal, NProgress, NSpin, NTag, useMessage } from 'naive-ui';
import type { AttachmentSummary, CurrentUser, ProjectExecutionSummary, ReserveProjectSummary } from '@tpm/shared';
import { ApiRequestError, apiRequest, jsonRequestInit } from '../api/client';
import { parseApiResponse } from '../api/response';
import AppPressable from '../app/AppPressable.vue';
import AppFilePicker from '../app/AppFilePicker.vue';
import ProjectFinancePanel from '../features/projects/ProjectFinancePanel.vue';
import ProjectSourceEditor from '../features/projects/ProjectSourceEditor.vue';
import ProjectMaterialsEditor from '../features/projects/ProjectMaterialsEditor.vue';

const props = defineProps<{ currentUser: CurrentUser }>();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const projectId = computed(() => String(route.params.projectId));
const project = ref<ReserveProjectSummary | null>(null);
const execution = ref<ProjectExecutionSummary | null>(null);
const loading = ref(true);
const error = ref('');
const tab = ref(String(route.query.tab || 'overview'));
const releaseOpen = ref(false);
const releasing = ref(false);
const releaseDate = ref(Date.now());
const releaseNote = ref('');
const releaseError = ref('');
const releaseConflict = ref(false);
const releaseIdempotencyKey = ref('');
const sourceEditorOpen = ref(false);
const materialsEditorOpen = ref(false);
const reserveConfirmOpen = ref(false);
const reserveConfirming = ref(false);
const reserveConfirmReason = ref('');
const reserveConfirmError = ref('');
const reserveConfirmConflict = ref(false);
const reserveConfirmIdempotencyKey = ref('');
const attachments = ref<AttachmentSummary[]>([]);
const attachmentFile = ref<File | null>(null);
const uploadingAttachment = ref(false);

const canManage = computed(() => ['admin', 'project_manager'].includes(props.currentUser.role));
const canCreateTask = computed(() => ['admin', 'project_manager', 'implementation'].includes(props.currentUser.role));
const canUploadAttachment = computed(() => ['admin', 'project_manager', 'implementation', 'finance'].includes(props.currentUser.role));
const implementationProgress = computed(() => {
  const tasks = execution.value?.tasks ?? [];
  const planned = tasks.reduce((sum, item) => sum + item.plannedQuantityScaled, 0);
  const done = tasks.reduce((sum, item) => sum + item.implementedQuantityScaled, 0);
  return planned ? Math.min(100, Math.round(done / planned * 100)) : 0;
});
const settlementProgress = computed(() => {
  const tasks = execution.value?.tasks ?? [];
  const planned = tasks.reduce((sum, item) => sum + item.plannedQuantityScaled, 0);
  const done = tasks.reduce((sum, item) => sum + item.settledQuantityScaled, 0);
  return planned ? Math.min(100, Math.round(done / planned * 100)) : 0;
});

function formatMoneyFen(value: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value / 100);
}

function businessDateFromTimestamp(value: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [detail, summary, attachmentData] = await Promise.all([
      apiRequest<ReserveProjectSummary>(`/api/reserve-projects/${encodeURIComponent(projectId.value)}`),
      apiRequest<ProjectExecutionSummary>(`/api/projects/${encodeURIComponent(projectId.value)}/execution`),
      apiRequest<{ items: AttachmentSummary[] }>(`/api/attachments?objectType=project&objectId=${encodeURIComponent(projectId.value)}`),
    ]);
    project.value = detail;
    execution.value = summary;
    attachments.value = attachmentData.items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '项目详情读取失败';
  } finally { loading.value = false; }
}

function backToProjects() {
  const from = typeof route.query.from === 'string' && route.query.from.startsWith('/projects') ? route.query.from : '/projects';
  void router.push(from);
}
function openTask(taskId: string) { void router.push(`/projects/${encodeURIComponent(projectId.value)}/tasks/${encodeURIComponent(taskId)}`); }
function createTask() { void router.push(`/projects/${encodeURIComponent(projectId.value)}/tasks/new`); }
function openFinanceWorkspace() { void router.push({ path: '/finance', query: { projectId: projectId.value } }); }

function attachmentChanged(event: Event) {
  attachmentFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function uploadAttachment() {
  const file = attachmentFile.value;
  if (!file) { message.warning('请选择附件'); return; }
  uploadingAttachment.value = true;
  try {
    const response = await fetch(`/api/attachments?objectType=project&objectId=${encodeURIComponent(projectId.value)}&fileName=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'Idempotency-Key': crypto.randomUUID() },
      body: file,
    });
    const result = await parseApiResponse<AttachmentSummary>(response);
    if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
    attachmentFile.value = null;
    attachments.value = (await apiRequest<{ items: AttachmentSummary[] }>(`/api/attachments?objectType=project&objectId=${encodeURIComponent(projectId.value)}`)).items;
    message.success('附件已上传');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '附件上传失败');
  } finally {
    uploadingAttachment.value = false;
  }
}

function openReserveConfirm() {
  reserveConfirmReason.value = '';
  reserveConfirmError.value = '';
  reserveConfirmConflict.value = false;
  reserveConfirmIdempotencyKey.value = crypto.randomUUID();
  reserveConfirmOpen.value = true;
}

async function confirmReserve() {
  if (!project.value) return;
  reserveConfirming.value = true;
  reserveConfirmError.value = '';
  reserveConfirmConflict.value = false;
  try {
    await apiRequest(`/api/reserve-projects/${encodeURIComponent(project.value.id)}/confirm`, jsonRequestInit('POST', {
      expectedVersion: project.value.version,
      reason: reserveConfirmReason.value.trim() || null,
    }, reserveConfirmIdempotencyKey.value));
    reserveConfirmOpen.value = false;
    await load();
    message.success('储备版本已确认');
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) {
      reserveConfirmConflict.value = true;
      reserveConfirmError.value = '储备确认前项目已被更新。当前说明已保留，请读取最新项目后重新确认。';
    } else {
      reserveConfirmError.value = cause instanceof Error ? cause.message : '储备确认失败';
    }
  } finally { reserveConfirming.value = false; }
}

async function reloadReserveProject() {
  const reason = reserveConfirmReason.value;
  await load();
  reserveConfirmReason.value = reason;
  reserveConfirmConflict.value = false;
  reserveConfirmError.value = '';
  reserveConfirmIdempotencyKey.value = crypto.randomUUID();
  if (project.value?.status === 'confirmed') reserveConfirmOpen.value = false;
}

async function projectDefinitionSaved() {
  await load();
}

function openProjectRelease() {
  releaseDate.value = Date.now();
  releaseNote.value = '';
  releaseError.value = '';
  releaseConflict.value = false;
  releaseIdempotencyKey.value = crypto.randomUUID();
  releaseOpen.value = true;
}

async function confirmProjectRelease() {
  if (!project.value || !releaseDate.value) return;
  releasing.value = true;
  releaseError.value = '';
  releaseConflict.value = false;
  try {
    await apiRequest('/api/project-releases', jsonRequestInit('POST', {
      projectId: project.value.id,
      expectedProjectVersion: project.value.version,
      releaseDate: businessDateFromTimestamp(releaseDate.value),
      note: releaseNote.value.trim() || null,
    }, releaseIdempotencyKey.value));
    releaseOpen.value = false;
    await load();
    message.success('项目已出库，正式进入执行阶段');
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) {
      releaseConflict.value = true;
      releaseError.value = '项目已被更新。当前输入已保留，请读取最新数据后重新确认。';
    } else {
      releaseError.value = cause instanceof Error ? cause.message : '项目出库失败';
    }
  } finally {
    releasing.value = false;
  }
}

async function reloadReleaseProject() {
  const note = releaseNote.value;
  await load();
  releaseNote.value = note;
  releaseConflict.value = false;
  releaseError.value = '';
  releaseIdempotencyKey.value = crypto.randomUUID();
  if (execution.value?.released) releaseOpen.value = false;
}

function setTab(value: string) {
  tab.value = value;
  void router.replace({ query: { ...route.query, tab: value } });
}

onMounted(load);
</script>

<template>
  <div class="view-stack project-detail-view">
    <app-pressable class="breadcrumb-back" @click="backToProjects">← 返回项目</app-pressable>
    <div v-if="error" class="detail-error">{{ error }} <n-button text @click="load">重新加载</n-button></div>
    <n-spin :show="loading">
      <template v-if="project && execution">
        <header class="object-header">
          <div>
            <div class="object-kicker">项目 · {{ project.year ?? '未设年度' }}</div>
            <h2>{{ project.name }}</h2>
            <div class="object-tags">
              <n-tag size="small" :bordered="false" :type="execution.released ? 'info' : project.status === 'confirmed' ? 'success' : 'default'">
                {{ execution.released ? '执行中' : project.status === 'confirmed' ? '储备已确认' : '储备草稿' }}
              </n-tag>
              <span>项目 v{{ project.version }}</span>
              <span>储备 v{{ project.reserveVersion }}</span>
            </div>
          </div>
          <div class="object-actions">
            <n-button v-if="canManage && project.status === 'draft'" data-test="open-reserve-confirm" type="primary" @click="openReserveConfirm">确认储备</n-button>
            <n-button v-else-if="canManage && project.status === 'confirmed' && !execution.released" data-test="open-project-release" type="primary" @click="openProjectRelease">项目出库</n-button>
            <n-button v-else-if="canCreateTask && execution.released && !execution.tasks.length" type="primary" @click="createTask">新建执行任务</n-button>
            <n-button v-else-if="execution.tasks.length" secondary @click="setTab('tasks')">查看执行任务</n-button>
          </div>
        </header>

        <nav class="segment-nav" aria-label="项目详情分段">
          <app-pressable v-for="item in [
            ['overview', '概览'], ['demands', '来源需求'], ['materials', '项目物资'], ['tasks', '执行任务'], ['finance', '资金'], ['history', '附件与历史'],
          ]" :key="item[0]" :data-test="`project-tab-${item[0]}`" :class="{ active: tab === item[0] }" @click="setTab(item[0])">{{ item[1] }}</app-pressable>
        </nav>

        <section v-if="tab === 'overview'" class="detail-section overview-section">
          <div class="overview-grid">
            <div class="overview-primary">
              <div class="metric-row"><span>执行任务</span><strong>{{ execution.tasks.length }}</strong></div>
              <div class="metric-row"><span>来源需求</span><strong>{{ project.demandLinks.length }}</strong></div>
              <div class="progress-metric">
                <div><span>实施进度</span><strong>{{ implementationProgress }}%</strong></div>
                <n-progress type="line" :show-indicator="false" :percentage="implementationProgress" />
              </div>
              <div class="progress-metric">
                <div><span>结算进度</span><strong>{{ settlementProgress }}%</strong></div>
                <n-progress type="line" :show-indicator="false" :percentage="settlementProgress" />
              </div>
            </div>
            <div class="money-summary">
              <span>已知项目物资金额</span>
              <strong>{{ formatMoneyFen(project.knownMaterialAmountFen) }}</strong>
              <small v-if="project.missingPriceCount">另有 {{ project.missingPriceCount }} 项物资待估价</small>
              <small v-else>当前项目物资价格完整</small>
            </div>
          </div>
        </section>

        <section v-else-if="tab === 'tasks'" class="detail-section">
          <div class="section-heading"><div><h3>执行任务</h3><p>供应、实施、结算分别推进，不强制串行。</p></div><n-button v-if="canCreateTask && execution.released" secondary @click="createTask">新建任务</n-button></div>
          <div v-if="execution.tasks.length" class="task-list">
            <app-pressable v-for="task in execution.tasks" :key="task.id" class="task-row" @click="openTask(task.id)">
              <div><strong>{{ task.name }}</strong><span>{{ task.scopeText || '未填写现场范围' }}</span></div>
              <div class="task-progress-pair"><span>实施 {{ Math.round(task.implementedQuantityScaled / task.plannedQuantityScaled * 100) }}%</span><span>结算 {{ Math.round(task.settledQuantityScaled / task.plannedQuantityScaled * 100) }}%</span></div>
              <span class="row-chevron">›</span>
            </app-pressable>
          </div>
          <n-empty v-else description="项目出库后可以创建执行任务" />
        </section>

        <section v-else-if="tab === 'demands'" class="detail-section">
          <div class="section-heading"><div><h3>来源需求</h3><p>这里只表达项目来源，不等同于项目物资。</p></div><n-button v-if="canManage" data-test="edit-project-sources" secondary @click="sourceEditorOpen = true">编辑来源</n-button></div>
          <div v-if="project.demandLinks.length" class="fact-list">
            <div v-for="item in project.demandLinks" :key="item.id"><strong>{{ item.sequenceNo }}</strong><span>{{ item.lineName }} {{ item.section }}</span></div>
          </div>
          <n-empty v-else description="当前项目未关联来源需求" />
        </section>

        <section v-else-if="tab === 'materials'" class="detail-section">
          <div class="section-heading"><div><h3>项目物资</h3><p>项目物资独立于需求阶段物资，可持续修订并保留历史。</p></div><n-button v-if="canManage" data-test="edit-project-materials" secondary @click="materialsEditorOpen = true">修订物资</n-button></div>
          <div v-if="project.materialRequirements.length" class="fact-list">
            <div v-for="item in project.materialRequirements" :key="item.id"><strong>{{ item.model }}</strong><span>{{ item.requiredQuantityScaled / 10000 }} {{ item.unit }}</span></div>
          </div>
          <n-empty v-else description="当前项目没有项目物资；0 物资项目仍然合法" />
        </section>

        <section v-else-if="tab === 'finance'" class="detail-section">
          <project-finance-panel :project="project" @open-workspace="openFinanceWorkspace" />
        </section>

        <section v-else-if="tab === 'history'" class="detail-section">
          <div class="section-heading">
            <div><h3>附件与历史</h3><p>项目附件按当前项目权限读取；项目与储备版本用于追踪当前定义。</p></div>
          </div>
          <div class="history-version-strip">
            <div><span>项目版本</span><strong>v{{ project.version }}</strong></div>
            <div><span>储备版本</span><strong>v{{ project.reserveVersion }}</strong></div>
            <div><span>当前阶段</span><strong>{{ execution.released ? '执行中' : project.status === 'confirmed' ? '储备已确认' : '储备草稿' }}</strong></div>
          </div>
          <div class="attachment-section">
            <div class="attachment-heading"><div><strong>项目附件</strong><small>{{ attachments.length }} 个文件</small></div></div>
            <div v-if="canUploadAttachment" class="attachment-upload-row">
              <app-file-picker
                test-id="project-attachment-file"
                label="选择附件"
                :selected-name="attachmentFile?.name ?? null"
                :disabled="uploadingAttachment"
                @change="attachmentChanged"
              />
              <n-button data-test="upload-project-attachment" :disabled="!attachmentFile" :loading="uploadingAttachment" @click="uploadAttachment">上传附件</n-button>
            </div>
            <div v-if="attachments.length" class="attachment-list">
              <a v-for="item in attachments" :key="item.id" class="attachment-row" :href="`/api/attachments/${item.id}/content`">
                <span class="attachment-name">{{ item.fileName }}</span>
                <span class="attachment-meta">{{ Math.max(1, Math.ceil(item.sizeBytes / 1024)) }} KB · {{ item.contentType || '文件' }}</span>
                <span class="attachment-action">下载</span>
              </a>
            </div>
            <n-empty v-else description="暂无项目附件" />
          </div>
        </section>

      </template>
    </n-spin>

    <project-source-editor
      v-if="project"
      v-model:show="sourceEditorOpen"
      :project="project"
      @saved="projectDefinitionSaved"
      @request-refresh="load"
    />
    <project-materials-editor
      v-if="project"
      v-model:show="materialsEditorOpen"
      :project="project"
      @saved="projectDefinitionSaved"
      @request-refresh="load"
    />

    <n-modal
      v-model:show="reserveConfirmOpen"
      preset="card"
      title="确认储备版本"
      :mask-closable="!reserveConfirming"
      class="reserve-confirm-modal"
      :style="{ width: 'min(520px, calc(100vw - 24px))' }"
    >
      <template v-if="project">
        <div class="release-intro">
          <strong>确认当前项目定义作为新的储备版本</strong>
          <p>来源需求和项目物资都允许为空。确认只冻结当前储备快照，不代表项目出库，也不会创建执行任务或资金流水。</p>
        </div>
        <div class="release-facts">
          <div><span>当前储备版本</span><strong>v{{ project.reserveVersion }}</strong></div>
          <div><span>来源需求</span><strong>{{ project.demandLinks.length }} 项</strong></div>
          <div><span>项目物资</span><strong>{{ project.materialRequirements.length }} 项</strong></div>
        </div>
        <n-alert v-if="reserveConfirmError" :type="reserveConfirmConflict ? 'warning' : 'error'" :bordered="false" class="release-error">{{ reserveConfirmError }}</n-alert>
        <n-button v-if="reserveConfirmConflict" data-test="reload-reserve-project" secondary block class="release-reload" @click="reloadReserveProject">读取最新项目数据</n-button>
        <n-form label-placement="top">
          <n-form-item label="确认说明"><n-input v-model:value="reserveConfirmReason" data-test="reserve-confirm-reason" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="可选：记录本次储备版本确认说明" /></n-form-item>
        </n-form>
        <div class="release-actions">
          <n-button :disabled="reserveConfirming" @click="reserveConfirmOpen = false">取消</n-button>
          <n-button data-test="confirm-reserve" type="primary" :loading="reserveConfirming" @click="confirmReserve">确认储备版本</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal
      v-model:show="releaseOpen"
      preset="card"
      title="确认项目出库"
      :mask-closable="!releasing"
      class="release-modal"
      :style="{ width: 'min(520px, calc(100vw - 24px))' }"
    >
      <template v-if="project">
        <div class="release-intro">
          <strong>项目出库是进入执行阶段的一次正式确认</strong>
          <p>它不是物资发货，不登记仓库数量，也不会自动创建执行任务或资金流水。</p>
        </div>
        <div class="release-facts">
          <div><span>储备版本</span><strong>v{{ project.reserveVersion }}</strong></div>
          <div><span>来源需求</span><strong data-test="release-demand-count">{{ project.demandLinks.length }} 项</strong></div>
          <div><span>项目物资</span><strong data-test="release-material-count">{{ project.materialRequirements.length }} 项</strong></div>
        </div>
        <n-alert v-if="releaseError" :type="releaseConflict ? 'warning' : 'error'" :bordered="false" class="release-error">{{ releaseError }}</n-alert>
        <n-button v-if="releaseConflict" data-test="reload-release-project" secondary block class="release-reload" @click="reloadReleaseProject">读取最新项目数据</n-button>
        <n-form label-placement="top">
          <n-form-item label="出库日期"><n-date-picker v-model:value="releaseDate" type="date" :clearable="false" /></n-form-item>
          <n-form-item label="备注"><n-input v-model:value="releaseNote" data-test="release-note" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="可选：记录本次进入执行阶段的说明" /></n-form-item>
        </n-form>
        <div class="release-actions">
          <n-button :disabled="releasing" @click="releaseOpen = false">取消</n-button>
          <n-button data-test="confirm-project-release" type="primary" :loading="releasing" @click="confirmProjectRelease">确认项目出库</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.project-detail-view { max-width: 1380px; }
.breadcrumb-back { justify-self: start; padding: 0; border: 0; background: transparent; color: var(--ui-text-secondary); font-size: 12px; cursor: pointer; }
.breadcrumb-back:hover { color: var(--ui-accent); }
.object-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; padding: 6px 0 4px; }
.object-kicker { margin-bottom: 7px; color: var(--ui-text-tertiary); font-size: 10px; font-weight: 700; letter-spacing: .08em; }
.object-header h2 { margin: 0; color: var(--ui-text); font-size: 28px; font-weight: 720; line-height: 1.23; letter-spacing: -.026em; }
.object-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; margin-top: 10px; color: var(--ui-text-secondary); font-size: 11px; }
.object-actions { display: flex; align-items: center; gap: 8px; }
.segment-nav { display: flex; gap: 24px; overflow-x: auto; min-height: 46px; padding: 0 2px; border-bottom: 1px solid var(--ui-border); scrollbar-width: none; }
.segment-nav button { position: relative; min-height: 45px; padding: 0; border: 0; background: transparent; color: var(--ui-text-secondary); font-size: 12px; font-weight: 570; white-space: nowrap; cursor: pointer; }
.segment-nav button.active { color: var(--ui-text); font-weight: 670; }
.segment-nav button.active::after { position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: 2px; background: var(--ui-accent); content: ''; }
.detail-section { padding: 20px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.overview-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .75fr); gap: 28px; }
.overview-primary { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); overflow: hidden; }
.metric-row, .progress-metric { display: grid; gap: 7px; min-height: 88px; align-content: center; padding: 15px 17px; }
.metric-row:nth-child(odd), .progress-metric:nth-child(odd) { border-right: 1px solid var(--ui-border); }
.metric-row:nth-child(n+3), .progress-metric:nth-child(n+3) { border-top: 1px solid var(--ui-border); }
.metric-row span, .progress-metric span, .money-summary span { color: var(--ui-text-secondary); font-size: 11px; }
.metric-row strong { font-size: 24px; font-weight: 690; }
.progress-metric > div { display: flex; justify-content: space-between; gap: 14px; }
.progress-metric strong { font-size: 13px; }
.money-summary { display: grid; align-content: center; min-height: 176px; padding: 20px; border-left: 2px solid var(--ui-accent); background: var(--ui-surface-subtle); }
.money-summary strong { margin: 8px 0; font-size: 27px; font-weight: 690; font-variant-numeric: tabular-nums; letter-spacing: -.025em; }
.money-summary small { color: var(--ui-text-secondary); font-size: 11px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; margin-bottom: 14px; }
.section-heading h3, .muted-placeholder h3 { margin: 0; font-size: 15px; font-weight: 680; }
.section-heading p, .muted-placeholder p { margin: 4px 0 0; color: var(--ui-text-secondary); font-size: 11px; }
.task-list, .fact-list { display: grid; }
.task-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 24px; gap: 20px; align-items: center; min-height: 68px; padding: 12px 2px; border: 0; border-bottom: 1px solid var(--ui-border); background: transparent; color: inherit; text-align: left; cursor: pointer; }
.task-row:last-child { border-bottom: 0; }
.task-row:hover { background: var(--ui-surface-subtle); }
.task-row > div:first-child { display: grid; gap: 4px; }
.task-row span, .fact-list span { color: var(--ui-text-secondary); font-size: 11px; }
.task-progress-pair { display: flex; gap: 16px; }
.row-chevron { color: var(--ui-text-tertiary); font-size: 20px; }
.fact-list > div { display: flex; justify-content: space-between; gap: 20px; padding: 13px 2px; border-bottom: 1px solid var(--ui-border); }
.history-version-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; margin-bottom: 22px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); }
.history-version-strip > div { display: grid; gap: 5px; padding: 13px 15px; }
.history-version-strip > div + div { border-left: 1px solid var(--ui-border); }
.history-version-strip span { color: var(--ui-text-tertiary); font-size: 11px; }
.history-version-strip strong { font-size: 13px; font-weight: 650; }
.attachment-section { display: grid; gap: 14px; }
.attachment-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.attachment-heading > div { display: grid; gap: 3px; }
.attachment-heading strong { font-size: 13px; font-weight: 680; }
.attachment-heading small { color: var(--ui-text-tertiary); font-size: 11px; }
.attachment-upload-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 12px; border: 1px solid var(--ui-border); border-radius: 11px; background: var(--ui-surface-subtle); }
.attachment-list { display: grid; border-top: 1px solid var(--ui-border); }
.attachment-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 14px; align-items: center; min-height: 54px; border-bottom: 1px solid var(--ui-border); text-decoration: none; }
.attachment-row:last-child { border-bottom: 0; }
.attachment-row:hover .attachment-name { color: var(--ui-accent); }
.attachment-name { overflow: hidden; color: var(--ui-text); font-size: 12px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.attachment-meta { color: var(--ui-text-tertiary); font-size: 10px; }
.attachment-action { color: var(--ui-accent); font-size: 11px; font-weight: 620; }
.detail-error { padding: 12px 14px; border-radius: 10px; background: var(--ui-danger-soft); color: var(--ui-danger); font-size: 12px; }
.release-intro { margin-bottom: 18px; padding: 13px 14px; border: 1px solid var(--ui-border); border-radius: 11px; background: var(--ui-surface-subtle); }
.release-intro strong { font-size: 14px; }
.release-intro p { margin: 6px 0 0; color: var(--ui-text-secondary); font-size: 12px; line-height: 1.6; }
.release-facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 18px; }
.release-facts > div { display: grid; gap: 4px; padding: 11px 12px; border: 1px solid var(--ui-border); border-radius: 10px; }
.release-facts span { color: var(--ui-text-secondary); font-size: 11px; }
.release-facts strong { font-size: 14px; }
.release-error, .release-reload { margin-bottom: 14px; }
.release-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
@media (max-width: 767px) {
  .object-header { align-items: flex-start; flex-direction: column; gap: 16px; }
  .object-header h2 { font-size: 24px; }
  .object-actions { width: 100%; }
  .object-actions > .n-button { flex: 1; }
  .segment-nav { gap: 20px; margin-inline: -2px; }
  .detail-section { padding: 16px 14px; }
  .overview-grid { grid-template-columns: 1fr; gap: 16px; }
  .overview-primary { grid-template-columns: 1fr 1fr; }
  .metric-row, .progress-metric { min-height: 72px; padding: 12px; }
  .metric-row strong { font-size: 18px; }
  .money-summary { min-height: 118px; border-left-width: 2px; }
  .money-summary strong { font-size: 22px; }
  .task-row { grid-template-columns: 1fr 20px; gap: 12px; }
  .task-progress-pair { grid-column: 1 / -1; justify-content: flex-start; }
  .row-chevron { grid-column: 2; grid-row: 1; }
  .release-facts { grid-template-columns: 1fr; }
  .history-version-strip { grid-template-columns: 1fr; }
  .history-version-strip > div + div { border-top: 1px solid var(--ui-border); border-left: 0; }
  .attachment-upload-row { grid-template-columns: 1fr; }
  .attachment-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; padding: 10px 0; }
  .attachment-meta { grid-column: 1; grid-row: 2; }
  .attachment-action { grid-column: 2; grid-row: 1 / span 2; align-self: center; }
  .release-actions { position: sticky; bottom: 0; padding: 12px 0 max(4px, env(safe-area-inset-bottom)); background: var(--ui-surface); }
  .release-actions .n-button:last-child { flex: 1; }
}
</style>
