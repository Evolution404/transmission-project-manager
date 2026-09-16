<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NDataTable, NDrawer, NDrawerContent, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag, useMessage } from 'naive-ui';
import type { CurrentUser, ReserveProjectSummary } from '@tpm/shared';
import { apiRequest, jsonRequestInit } from '../api/client';
import AppPressable from '../app/AppPressable.vue';

const props = defineProps<{ currentUser: CurrentUser }>();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const projects = ref<ReserveProjectSummary[]>([]);
const search = ref(typeof route.query.query === 'string' ? route.query.query : '');
const stage = ref<'all' | 'reserve'>(route.query.stage === 'reserve' ? 'reserve' : 'all');
const nextCursor = ref<string | null>(null);
const createOpen = ref(false);
const creating = ref(false);
const createName = ref('');
const createYear = ref('');
const createOwner = ref('');
const createError = ref('');
const canCreate = computed(() => props.currentUser.role === 'admin' || props.currentUser.role === 'project_manager');
const stageOptions = [
  { label: '全部项目', value: 'all' },
  { label: '待出库', value: 'reserve' },
];

const emptyDescription = computed(() => search.value.trim() ? '没有匹配当前条件的项目' : stage.value === 'reserve' ? '当前没有待出库项目' : '暂无项目');
let requestSequence = 0;

function openProject(projectId: string) {
  const from = route.fullPath?.startsWith('/projects') ? route.fullPath : '/projects';
  void router.push({ name: 'project-detail', params: { projectId }, query: { from } });
}
function openCreateProject() {
  createName.value = '';
  createYear.value = String(new Date().getFullYear());
  createOwner.value = '';
  createError.value = '';
  createOpen.value = true;
}

function setCreateOpen(value: boolean) {
  if (!creating.value || value) createOpen.value = value;
}

async function saveProject() {
  const name = createName.value.trim();
  if (!name) { createError.value = '请输入项目名称'; return; }
  const year = createYear.value.trim() ? Number(createYear.value) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
    createError.value = '年度需为 1900–2200 的整数';
    return;
  }
  creating.value = true;
  createError.value = '';
  try {
    const created = await apiRequest<ReserveProjectSummary>('/api/reserve-projects', jsonRequestInit('POST', {
      name,
      year,
      owner: createOwner.value.trim() || null,
      demandIds: [],
    }));
    createOpen.value = false;
    message.success('项目已创建，可继续补充来源需求和项目物资');
    const from = route.fullPath?.startsWith('/projects') ? route.fullPath : '/projects';
    void router.push({ name: 'project-detail', params: { projectId: created.id }, query: { from } });
  } catch (cause) {
    createError.value = cause instanceof Error ? cause.message : '项目创建失败';
  } finally {
    creating.value = false;
  }
}

async function loadPage(cursor?: string) {
  const append = Boolean(cursor);
  const sequence = ++requestSequence;
  if (append) loadingMore.value = true;
  else loading.value = true;
  error.value = '';
  try {
    const query = new URLSearchParams({ limit: '50' });
    if (stage.value === 'reserve') query.set('stage', 'reserve');
    const term = search.value.trim();
    if (term) query.set('query', term);
    if (cursor) query.set('cursor', cursor);
    const page = await apiRequest<{ items: ReserveProjectSummary[]; nextCursor: string | null }>(`/api/reserve-projects?${query.toString()}`);
    if (sequence !== requestSequence) return;
    projects.value = cursor ? [...projects.value, ...page.items] : page.items;
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    if (sequence !== requestSequence) return;
    error.value = cause instanceof Error ? cause.message : '读取项目失败';
  } finally {
    if (sequence === requestSequence) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function syncRouteFilters() {
  const next: Record<string, string> = {};
  const term = search.value.trim();
  if (stage.value === 'reserve') next.stage = 'reserve';
  if (term) next.query = term;
  void router.replace({ query: next });
}

watch(stage, () => {
  projects.value = [];
  nextCursor.value = null;
  syncRouteFilters();
  void loadPage();
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    projects.value = [];
    nextCursor.value = null;
    syncRouteFilters();
    void loadPage();
  }, 220);
});

const columns = [
  {
    title: '项目', key: 'name', minWidth: 260,
    render: (row: ReserveProjectSummary) => h(AppPressable, { class: 'project-link', onClick: () => openProject(row.id) }, { default: () => row.name }),
  },
  { title: '年度', key: 'year', width: 90, render: (row: ReserveProjectSummary) => row.year ?? '—' },
  {
    title: '状态', key: 'status', width: 120,
    render: (row: ReserveProjectSummary) => h(NTag, { size: 'small', bordered: false, type: row.status === 'confirmed' ? 'success' : 'default' }, { default: () => row.status === 'confirmed' ? '储备已确认' : '储备草稿' }),
  },
  { title: '负责人', key: 'owner', width: 130, render: (row: ReserveProjectSummary) => row.owner || '未指定' },
  { title: '来源需求', key: 'demands', width: 110, render: (row: ReserveProjectSummary) => `${row.demandLinks.length} 项` },
  { title: '项目物资', key: 'materials', width: 110, render: (row: ReserveProjectSummary) => `${row.materialRequirements.length} 项` },
];

onMounted(() => loadPage());
</script>

<template>
  <div class="view-stack projects-view">
    <header class="page-header">
      <div class="page-header-copy">
        <span class="page-eyebrow">项目中心</span>
        <h2 class="page-title">项目</h2>
        <p class="page-description">一个项目身份贯穿储备、出库、执行、资金和历史，不按阶段重复建档。</p>
      </div>
      <div class="page-actions"><n-button v-if="canCreate" data-test="open-create-project" type="primary" @click="openCreateProject">新建项目</n-button></div>
    </header>

    <section class="list-surface">
      <div class="list-toolbar">
        <n-input v-model:value="search" data-test="project-search" clearable placeholder="搜索项目名称、负责人或年度" />
        <n-select v-model:value="stage" data-test="project-stage-filter" :options="stageOptions" class="stage-filter" />
        <div class="toolbar-spacer"></div>
        <span class="result-count">当前显示 {{ projects.length }} 个项目</span>
      </div>

      <div v-if="error" class="inline-error">{{ error }} <n-button text @click="loadPage()">重新加载</n-button></div>
      <n-spin :show="loading">
        <n-data-table v-if="projects.length" class="desktop-project-table" :data="projects" :columns="columns" :pagination="false" :scroll-x="900" />
        <div v-if="projects.length" class="mobile-project-list">
          <app-pressable v-for="item in projects" :key="item.id" class="mobile-project-card" @click="openProject(item.id)">
            <div class="mobile-project-title-row">
              <strong>{{ item.name }}</strong>
              <span class="status-pill" :class="item.status === 'confirmed' ? 'confirmed' : 'draft'">{{ item.status === 'confirmed' ? '储备已确认' : '储备草稿' }}</span>
            </div>
            <div class="mobile-project-meta">{{ item.year ?? '未设年度' }} · {{ item.owner || '未指定负责人' }}</div>
            <div class="mobile-project-facts">
              <span>需求 {{ item.demandLinks.length }}</span>
              <span>物资 {{ item.materialRequirements.length }}</span>
              <span v-if="item.missingPriceCount">{{ item.missingPriceCount }} 项待估价</span>
            </div>
          </app-pressable>
        </div>
        <n-empty v-if="!loading && !projects.length" :description="emptyDescription" />
      </n-spin>
      <div v-if="nextCursor" class="load-more"><n-button :loading="loadingMore" @click="loadPage(nextCursor)">加载更多</n-button></div>
    </section>

    <n-drawer
      :show="createOpen"
      placement="right"
      :width="520"
      :mask-closable="!creating"
      :close-on-esc="!creating"
      class="project-create-drawer"
      @update:show="setCreateOpen"
    >
      <n-drawer-content title="新建项目" :closable="!creating">
        <div class="create-intro">
          <strong>先建立项目，再逐步补充业务事实</strong>
          <span>来源需求和项目物资都可以为空，创建后在项目详情继续维护。</span>
        </div>
        <div v-if="createError" class="create-error">{{ createError }}</div>
        <n-form label-placement="top" class="create-form">
          <n-form-item label="项目名称"><n-input v-model:value="createName" data-test="project-name" /></n-form-item>
          <n-form-item label="年度"><n-input v-model:value="createYear" data-test="project-year" inputmode="numeric" /></n-form-item>
          <n-form-item label="负责人"><n-input v-model:value="createOwner" data-test="project-owner" /></n-form-item>
        </n-form>
        <div class="drawer-actions">
          <n-button :disabled="creating" @click="setCreateOpen(false)">取消</n-button>
          <n-button data-test="save-project" type="primary" :loading="creating" @click="saveProject">创建项目</n-button>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.projects-view { max-width: 1420px; }
.list-surface { overflow: hidden; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.list-toolbar { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 12px 16px; border-bottom: 1px solid var(--ui-border); }
.list-toolbar :deep(.n-input) { max-width: 420px; }
.stage-filter { width: 150px; }
.result-count { color: var(--ui-text-tertiary); font-size: 13px; white-space: nowrap; }
.project-link { padding: 0; border: 0; background: none; color: var(--ui-text); font: inherit; font-weight: 660; cursor: pointer; text-align: left; }
.project-link:hover { color: var(--ui-accent); }
.inline-error { margin: 14px 16px 0; padding: 11px 13px; border-radius: 10px; background: var(--ui-danger-soft); color: var(--ui-danger); font-size: 13px; }
.load-more { display: flex; justify-content: center; padding: 14px 16px; border-top: 1px solid var(--ui-border); }
.mobile-project-list { display: none; }
.create-intro { display: grid; gap: 5px; margin-bottom: 20px; padding: 13px 14px; border: 1px solid var(--ui-border); border-radius: 11px; background: var(--ui-surface-subtle); }
.create-intro strong { font-size: 14px; }
.create-intro span { color: var(--ui-text-secondary); font-size: 13px; line-height: 1.55; }
.create-error { margin-bottom: 14px; padding: 11px 13px; border-radius: 10px; background: var(--ui-danger-soft); color: var(--ui-danger); font-size: 13px; }
.drawer-actions { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 10px; padding-top: 16px; background: var(--ui-surface); }
.status-pill { display: inline-flex; align-items: center; min-height: 25px; padding: 0 9px; border-radius: 999px; font-size: 13px; font-weight: 650; white-space: nowrap; }
.status-pill.confirmed { background: var(--ui-success-soft); color: var(--ui-success); }
.status-pill.draft { background: var(--ui-surface-muted); color: var(--ui-text-secondary); }
@media (max-width: 767px) {
  .list-toolbar { align-items: stretch; flex-wrap: wrap; padding: 12px 13px; }
  .list-toolbar :deep(.n-input) { max-width: none; }
  .stage-filter { flex: 0 0 130px; width: 130px; }
  .list-toolbar .toolbar-spacer { display: none; }
  .result-count { width: 100%; }
  .desktop-project-table { display: none; }
  .mobile-project-list { display: grid; }
  .mobile-project-card { display: grid; gap: 8px; width: 100%; padding: 15px 14px; border: 0; border-bottom: 1px solid var(--ui-border); background: transparent; color: inherit; text-align: left; }
  .mobile-project-card:last-child { border-bottom: 0; }
  .mobile-project-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .mobile-project-title-row strong { font-size: 14px; line-height: 1.45; }
  .mobile-project-meta, .mobile-project-facts { color: var(--ui-text-secondary); font-size: 13px; }
  .mobile-project-facts { display: flex; flex-wrap: wrap; gap: 6px 12px; }
  :global(.project-create-drawer.n-drawer) { width: 100vw !important; max-width: 100vw !important; }
  .drawer-actions { padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .drawer-actions .n-button:last-child { flex: 1; }
}
</style>
