<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NEmpty, NInput, NSelect, NSpin, NTag, useMessage } from 'naive-ui';
import type { CategoryMappingSummary, ReserveCategorySummary } from '@tpm/shared';
import { apiRequest, jsonRequestInit } from '../../api/client';

const message = useMessage();
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const categories = ref<ReserveCategorySummary[]>([]);
const mappings = ref<CategoryMappingSummary[]>([]);
const categoryFormOpen = ref(false);
const mappingFormOpen = ref(false);
const categoryKey = ref('');
const categoryLabel = ref('');
const mappingDemandCategory = ref('');
const mappingCategoryId = ref<string | null>(null);

const categoryOptions = computed(() => categories.value
  .filter((item) => item.enabled)
  .map((item) => ({ label: item.label, value: item.id })));

function categoryName(id: string) {
  return categories.value.find((item) => item.id === id)?.label ?? '分类已停用或不存在';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [categoryData, mappingData] = await Promise.all([
      apiRequest<{ items: ReserveCategorySummary[] }>('/api/reserve-categories'),
      apiRequest<{ items: CategoryMappingSummary[] }>('/api/category-mappings'),
    ]);
    categories.value = categoryData.items;
    mappings.value = mappingData.items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取储备分类规则失败';
  } finally {
    loading.value = false;
  }
}

async function createCategory() {
  const key = categoryKey.value.trim();
  const label = categoryLabel.value.trim();
  if (!key || !label) { message.warning('请填写分类键和名称'); return; }
  saving.value = true;
  try {
    await apiRequest('/api/reserve-categories', jsonRequestInit('POST', { key, label }));
    categoryKey.value = '';
    categoryLabel.value = '';
    categoryFormOpen.value = false;
    await load();
    message.success('储备大类已新增');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '储备大类保存失败');
  } finally {
    saving.value = false;
  }
}

async function saveMapping() {
  const demandCategory = mappingDemandCategory.value.trim();
  if (!demandCategory || !mappingCategoryId.value) { message.warning('请填写需求类别并选择储备大类'); return; }
  const current = mappings.value.find((item) => item.demandCategory.toLowerCase() === demandCategory.toLowerCase());
  saving.value = true;
  try {
    await apiRequest(`/api/category-mappings/${encodeURIComponent(demandCategory)}`, jsonRequestInit('PUT', {
      expectedVersion: current?.version ?? null,
      reserveCategoryId: mappingCategoryId.value,
    }));
    mappingDemandCategory.value = '';
    mappingCategoryId.value = null;
    mappingFormOpen.value = false;
    await load();
    message.success('类别映射已保存');
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '类别映射保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="section-panel classification-panel" data-test="reserve-classification-panel">
    <div class="section-panel-header">
      <div>
        <h3>储备分类规则</h3>
        <p>维护储备大类和需求类别的默认映射。映射只提供分类建议，不改变需求物资与项目物资关系。</p>
      </div>
    </div>
    <div class="section-panel-body classification-body">
      <div v-if="error" class="classification-error">{{ error }} <n-button text @click="load">重新加载</n-button></div>
      <n-spin :show="loading">
        <div class="classification-grid">
          <section class="classification-group">
            <div class="classification-heading">
              <div><strong>储备大类</strong><small>{{ categories.length }} 个分类</small></div>
              <n-button size="small" secondary @click="categoryFormOpen = !categoryFormOpen">{{ categoryFormOpen ? '收起' : '新增大类' }}</n-button>
            </div>
            <div v-if="categoryFormOpen" class="inline-editor category-editor">
              <n-input v-model:value="categoryKey" placeholder="分类键，例如 line_protection" />
              <n-input v-model:value="categoryLabel" placeholder="显示名称，例如 防断线" />
              <n-button :loading="saving" @click="createCategory">保存</n-button>
            </div>
            <div v-if="categories.length" class="category-list">
              <div v-for="item in categories" :key="item.id" class="category-row">
                <div><strong>{{ item.label }}</strong><small>{{ item.key }}</small></div>
                <n-tag size="small" :bordered="false" :type="item.enabled ? 'success' : 'default'">{{ item.enabled ? '启用' : '停用' }}</n-tag>
              </div>
            </div>
            <n-empty v-else description="暂无储备大类" />
          </section>

          <section class="classification-group mapping-group">
            <div class="classification-heading">
              <div><strong>默认映射</strong><small>需求类别 → 储备大类</small></div>
              <n-button size="small" secondary @click="mappingFormOpen = !mappingFormOpen">{{ mappingFormOpen ? '收起' : '设置映射' }}</n-button>
            </div>
            <div v-if="mappingFormOpen" class="inline-editor mapping-editor">
              <n-input v-model:value="mappingDemandCategory" placeholder="需求类别" />
              <n-select v-model:value="mappingCategoryId" :options="categoryOptions" placeholder="选择储备大类" />
              <n-button :loading="saving" @click="saveMapping">保存</n-button>
            </div>
            <div v-if="mappings.length" class="mapping-list">
              <div v-for="item in mappings" :key="item.demandCategory" class="mapping-row">
                <strong>{{ item.demandCategory }}</strong>
                <span aria-hidden="true">→</span>
                <span>{{ categoryName(item.reserveCategoryId) }}</span>
              </div>
            </div>
            <n-empty v-else description="暂无默认映射" />
          </section>
        </div>
      </n-spin>
    </div>
  </section>
</template>

<style scoped>
.classification-body { padding: 0; }
.classification-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px; padding: 10px 12px; border-radius: 10px; background: var(--ui-danger-soft); color: var(--ui-danger); font-size: 12px; }
.classification-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.classification-group { min-width: 0; padding: 18px; }
.mapping-group { border-left: 1px solid var(--ui-border); }
.classification-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.classification-heading > div { display: grid; gap: 3px; }
.classification-heading strong { color: var(--ui-text); font-size: 13px; font-weight: 680; }
.classification-heading small { color: var(--ui-text-tertiary); font-size: 12px; }
.inline-editor { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; margin-bottom: 14px; padding: 12px; border: 1px solid var(--ui-border); border-radius: 11px; background: var(--ui-surface-subtle); }
.category-list, .mapping-list { display: grid; border-top: 1px solid var(--ui-border); }
.category-row, .mapping-row { min-height: 48px; border-bottom: 1px solid var(--ui-border); }
.category-row:last-child, .mapping-row:last-child { border-bottom: 0; }
.category-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; }
.category-row > div { display: grid; gap: 2px; }
.category-row strong, .mapping-row strong { font-size: 12px; font-weight: 650; }
.category-row small { color: var(--ui-text-tertiary); font-size: 12px; }
.mapping-row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: center; color: var(--ui-text-secondary); font-size: 12px; }
.mapping-row > :last-child { text-align: right; }
@media (max-width: 900px) {
  .classification-grid { grid-template-columns: 1fr; }
  .mapping-group { border-top: 1px solid var(--ui-border); border-left: 0; }
}
@media (max-width: 560px) {
  .classification-group { padding: 14px; }
  .classification-heading { align-items: flex-start; }
  .inline-editor { grid-template-columns: 1fr; }
}
</style>
