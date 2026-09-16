<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NDataTable, NEmpty, NInput, NSpin, NTag } from 'naive-ui';
import type { CurrentUser, ReserveProjectSummary } from '@tpm/shared';
import { apiRequest } from '../api/client';

defineProps<{ currentUser: CurrentUser }>();
const router = useRouter();
const loading = ref(true);
const error = ref('');
const projects = ref<ReserveProjectSummary[]>([]);
const search = ref('');
const nextCursor = ref<string | null>(null);

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return projects.value;
  return projects.value.filter((project) => [project.name, project.owner ?? '', String(project.year ?? '')]
    .some((value) => value.toLowerCase().includes(query)));
});

function openProject(projectId: string) {
  void router.push({ name: 'project-detail', params: { projectId }, query: { from: '/projects' } });
}
function createProject() { void router.push('/reserves'); }

async function loadPage(cursor?: string) {
  loading.value = true;
  error.value = '';
  try {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const page = await apiRequest<{ items: ReserveProjectSummary[]; nextCursor: string | null }>(`/api/reserve-projects?${query.toString()}`);
    projects.value = cursor ? [...projects.value, ...page.items] : page.items;
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取项目失败';
  } finally {
    loading.value = false;
  }
}

const columns = [
  {
    title: '项目', key: 'name', minWidth: 260,
    render: (row: ReserveProjectSummary) => h('button', { class: 'project-link', onClick: () => openProject(row.id) }, row.name),
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
    <section class="page-heading">
      <div>
        <span class="eyebrow">项目中心</span>
        <h2>项目</h2>
        <p>从储备到执行，使用同一个项目身份持续管理。</p>
      </div>
      <n-button type="primary" @click="createProject">新建项目</n-button>
    </section>

    <section class="list-surface">
      <div class="list-toolbar">
        <n-input v-model:value="search" clearable placeholder="搜索项目名称、负责人或年度" />
        <span class="result-count">{{ filtered.length }} 个已加载项目</span>
      </div>

      <div v-if="error" class="inline-error">{{ error }} <n-button text @click="loadPage()">重新加载</n-button></div>
      <n-spin :show="loading">
        <n-data-table v-if="filtered.length" class="desktop-project-table" :data="filtered" :columns="columns" :pagination="false" :scroll-x="900" />
        <div v-if="filtered.length" class="mobile-project-list">
          <button v-for="item in filtered" :key="item.id" class="mobile-project-card" @click="openProject(item.id)">
            <div class="mobile-project-title-row">
              <strong>{{ item.name }}</strong>
              <n-tag size="small" :bordered="false" :type="item.status === 'confirmed' ? 'success' : 'default'">{{ item.status === 'confirmed' ? '已确认' : '草稿' }}</n-tag>
            </div>
            <div class="mobile-project-meta">{{ item.year ?? '未设年度' }} · {{ item.owner || '未指定负责人' }}</div>
            <div class="mobile-project-facts">
              <span>需求 {{ item.demandLinks.length }}</span>
              <span>物资 {{ item.materialRequirements.length }}</span>
              <span v-if="item.missingPriceCount">{{ item.missingPriceCount }} 项待估价</span>
            </div>
          </button>
        </div>
        <n-empty v-if="!loading && !filtered.length" description="暂无项目" />
      </n-spin>
      <div v-if="nextCursor" class="load-more"><n-button :loading="loading" @click="loadPage(nextCursor)">加载更多</n-button></div>
    </section>
  </div>
</template>

<style scoped>
.projects-view { max-width: 1320px; }
.page-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 8px 2px 4px; }
.page-heading h2 { margin: 2px 0 6px; font-size: 28px; line-height: 1.2; letter-spacing: -.025em; }
.page-heading p { margin: 0; color: var(--ui-text-secondary, #566174); font-size: 14px; }
.eyebrow { color: var(--ui-accent, #075dcc); font-size: 12px; font-weight: 700; }
.list-surface { overflow: hidden; border: 1px solid var(--ui-border, #dce2ea); border-radius: 18px; background: var(--ui-surface, #fff); }
.list-toolbar { display: flex; align-items: center; gap: 14px; padding: 18px 20px; border-bottom: 1px solid var(--ui-border, #dce2ea); }
.list-toolbar :deep(.n-input) { max-width: 420px; }
.result-count { color: var(--ui-text-secondary, #566174); font-size: 13px; white-space: nowrap; }
.project-link { padding: 0; border: 0; background: none; color: var(--ui-text, #18212f); font: inherit; font-weight: 650; cursor: pointer; text-align: left; }
.project-link:hover { color: var(--ui-accent, #075dcc); }
.inline-error { margin: 16px 20px 0; padding: 12px 14px; border-radius: 12px; background: #fff4f3; color: #b42318; }
.load-more { display: flex; justify-content: center; padding: 16px; border-top: 1px solid var(--ui-border, #dce2ea); }
.mobile-project-list { display: none; }
@media (max-width: 767px) {
  .page-heading { align-items: flex-start; padding: 4px 2px; }
  .page-heading h2 { font-size: 24px; }
  .page-heading p { max-width: 280px; }
  .page-heading > .n-button { display: none; }
  .list-toolbar { align-items: stretch; flex-direction: column; padding: 14px 16px; }
  .list-toolbar :deep(.n-input) { max-width: none; }
  .desktop-project-table { display: none; }
  .mobile-project-list { display: grid; }
  .mobile-project-card { display: grid; gap: 8px; width: 100%; padding: 16px; border: 0; border-bottom: 1px solid var(--ui-border, #dce2ea); background: transparent; color: inherit; text-align: left; }
  .mobile-project-card:last-child { border-bottom: 0; }
  .mobile-project-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .mobile-project-title-row strong { font-size: 15px; line-height: 1.45; }
  .mobile-project-meta, .mobile-project-facts { color: var(--ui-text-secondary, #566174); font-size: 13px; }
  .mobile-project-facts { display: flex; flex-wrap: wrap; gap: 12px; }
}
</style>
