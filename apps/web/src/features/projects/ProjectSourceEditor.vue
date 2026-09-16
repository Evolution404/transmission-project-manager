<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NDrawer, NDrawerContent, NEmpty, NInput, NSpin } from 'naive-ui';
import type { DemandSummary, ProjectDemandLinkSummary, ReserveProjectSummary } from '@tpm/shared';
import { ApiRequestError, apiRequest, jsonRequestInit } from '../../api/client';

const props = defineProps<{ show: boolean; project: ReserveProjectSummary }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; saved: [] }>();

const query = ref('');
const searching = ref(false);
const saving = ref(false);
const error = ref('');
const conflict = ref(false);
const results = ref<DemandSummary[]>([]);
const selected = ref(new Set<string>());
const labels = ref(new Map<string, { sequenceNo: string; lineName: string; section: string; category: string | null }>());
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSequence = 0;

const selectedItems = computed(() => [...selected.value].map((id) => ({ id, label: labels.value.get(id) })).filter((item) => item.label));

function initialize() {
  query.value = '';
  error.value = '';
  conflict.value = false;
  selected.value = new Set(props.project.demandLinks.map((item) => item.demandId));
  labels.value = new Map(props.project.demandLinks.map((item) => [item.demandId, {
    sequenceNo: item.sequenceNo, lineName: item.lineName, section: item.section, category: item.category,
  }]));
  void search();
}

async function search() {
  const sequence = ++searchSequence;
  searching.value = true;
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (query.value.trim()) params.set('query', query.value.trim());
    const page = await apiRequest<{ items: DemandSummary[]; nextCursor: string | null }>(`/api/demands?${params.toString()}`);
    if (sequence !== searchSequence) return;
    results.value = page.items;
    const next = new Map(labels.value);
    for (const item of page.items) next.set(item.id, { sequenceNo: item.sequenceNo, lineName: item.lineName, section: item.section, category: item.category });
    labels.value = next;
  } catch (cause) {
    if (sequence === searchSequence) error.value = cause instanceof Error ? cause.message : '读取需求失败';
  } finally {
    if (sequence === searchSequence) searching.value = false;
  }
}

function toggle(id: string, checked: boolean) {
  const next = new Set(selected.value);
  if (checked) next.add(id); else next.delete(id);
  selected.value = next;
  conflict.value = false;
  error.value = '';
}

async function save() {
  saving.value = true;
  error.value = '';
  conflict.value = false;
  try {
    await apiRequest(`/api/reserve-projects/${encodeURIComponent(props.project.id)}/demands`, jsonRequestInit('PUT', {
      expectedVersion: props.project.version,
      demandIds: [...selected.value],
    }));
    emit('update:show', false);
    emit('saved');
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) {
      conflict.value = true;
      error.value = '项目已被其他人修改。当前选择已保留，请关闭后读取最新项目，再重新确认。';
    } else {
      error.value = cause instanceof Error ? cause.message : '保存来源需求失败';
    }
  } finally { saving.value = false; }
}

watch(() => props.show, (show) => { if (show) initialize(); });
watch(query, () => {
  if (!props.show) return;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void search(), 220);
});
</script>

<template>
  <n-drawer :show="show" placement="right" :width="640" class="project-source-drawer" @update:show="emit('update:show', $event)">
    <n-drawer-content title="编辑来源需求" closable>
      <div class="editor-intro">
        <strong>来源需求只表达项目从哪里来</strong>
        <span>这里不会把需求物资自动复制为项目物资，也不会把需求数量当作项目物资上限。</span>
      </div>
      <n-alert v-if="error" :type="conflict ? 'warning' : 'error'" :bordered="false" class="editor-alert">{{ error }}</n-alert>

      <section class="selected-section">
        <div class="editor-heading"><div><h4>已关联</h4><p>{{ selectedItems.length }} 项</p></div></div>
        <div v-if="selectedItems.length" class="selected-list">
          <div v-for="item in selectedItems" :key="item.id">
            <span><strong>{{ item.label!.sequenceNo }}</strong><small>{{ item.label!.lineName }} {{ item.label!.section }}</small></span>
            <n-button quaternary size="small" @click="toggle(item.id, false)">移除</n-button>
          </div>
        </div>
        <n-empty v-else description="当前项目没有来源需求；这是合法状态" size="small" />
      </section>

      <section class="search-section">
        <div class="editor-heading"><div><h4>添加需求</h4><p>搜索只影响候选结果，不会清掉已选对象。</p></div></div>
        <n-input v-model:value="query" clearable placeholder="搜索需求序号、线路、杆段或类别" />
        <n-spin :show="searching">
          <div v-if="results.length" class="candidate-list">
            <label v-for="item in results" :key="item.id">
              <n-checkbox :checked="selected.has(item.id)" @update:checked="toggle(item.id, $event)" />
              <span><strong>{{ item.sequenceNo }}</strong><small>{{ item.lineName }} {{ item.section }} · {{ item.category || '未分类' }}</small></span>
            </label>
          </div>
          <n-empty v-else-if="!searching" description="没有匹配需求" size="small" />
        </n-spin>
      </section>

      <div class="editor-actions"><n-button :disabled="saving" @click="emit('update:show', false)">取消</n-button><n-button data-test="save-project-sources" type="primary" :loading="saving" @click="save">保存来源关系</n-button></div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.editor-intro { display: grid; gap: 5px; margin-bottom: 16px; padding: 13px 14px; border: 1px solid var(--ui-border); border-radius: 11px; background: var(--ui-surface-subtle); }
.editor-intro strong { font-size: 13px; }.editor-intro span { color: var(--ui-text-secondary); font-size: 11px; line-height: 1.6; }
.editor-alert { margin-bottom: 14px; }.selected-section,.search-section { padding: 16px 0; border-top: 1px solid var(--ui-border); }.selected-section { border-top: 0; padding-top: 0; }
.editor-heading { display: flex; justify-content: space-between; margin-bottom: 10px; }.editor-heading h4 { margin: 0; font-size: 13px; }.editor-heading p { margin: 3px 0 0; color: var(--ui-text-tertiary); font-size: 10px; }
.selected-list,.candidate-list { display: grid; }.selected-list > div,.candidate-list label { display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 8px 2px; border-bottom: 1px solid var(--ui-border); }.selected-list > div { justify-content: space-between; }.candidate-list label { cursor: pointer; }
.selected-list span,.candidate-list label > span:last-child { display: grid; gap: 2px; min-width: 0; flex: 1; }.selected-list strong,.candidate-list strong { font-size: 12px; }.selected-list small,.candidate-list small { overflow: hidden; color: var(--ui-text-secondary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.candidate-list { max-height: 360px; margin-top: 10px; overflow: auto; }.editor-actions { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 9px; padding: 14px 0 max(4px, env(safe-area-inset-bottom)); background: var(--ui-surface); }
@media(max-width:767px){ :global(.project-source-drawer .n-drawer){width:100vw!important;max-width:100vw!important}.editor-actions .n-button:last-child{flex:1}.candidate-list{max-height:none} }
</style>
