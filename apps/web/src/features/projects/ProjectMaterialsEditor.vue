<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NDrawer, NDrawerContent, NEmpty, NInput, NSelect } from 'naive-ui';
import type { ReserveCategorySummary, ReserveProjectSummary } from '@tpm/shared';
import { ApiRequestError, apiRequest, jsonRequestInit } from '../../api/client';

const props = defineProps<{ show: boolean; project: ReserveProjectSummary }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; saved: []; 'request-refresh': [] }>();

type Draft = { id: string | null; materialId: string | null; model: string; unit: string; quantity: string; unitPrice: string; reserveCategoryId: string | null };
const drafts = ref<Draft[]>([]);
const categories = ref<ReserveCategorySummary[]>([]);
const reason = ref('');
const saving = ref(false);
const error = ref('');
const conflict = ref(false);

function formatScaled(value: number) { const whole = Math.floor(value / 10000); const fraction = String(value % 10000).padStart(4, '0').replace(/0+$/, ''); return fraction ? `${whole}.${fraction}` : String(whole); }
function parseScaled(value: string) { const match = value.trim().match(/^(\d+)(?:\.(\d{1,4}))?$/); if (!match) return null; const scaled = BigInt(match[1]!) * 10000n + BigInt((match[2] ?? '').padEnd(4, '0') || '0'); return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null; }

const categoryOptions = computed(() => categories.value.filter((item) => item.enabled).map((item) => ({ label: item.label, value: item.id })));

async function initialize() {
  drafts.value = props.project.materialRequirements.map((item) => ({ id: item.id, materialId: item.materialId, model: item.model, unit: item.unit, quantity: formatScaled(item.requiredQuantityScaled), unitPrice: item.unitPriceScaled === null ? '' : formatScaled(item.unitPriceScaled), reserveCategoryId: item.reserveCategoryId }));
  reason.value = '';
  error.value = '';
  conflict.value = false;
  try { categories.value = (await apiRequest<{ items: ReserveCategorySummary[] }>('/api/reserve-categories')).items; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '读取储备分类失败'; }
}
function setShow(value: boolean) { if (!saving.value || value) emit('update:show', value); }
function add() { drafts.value.push({ id: null, materialId: null, model: '', unit: '', quantity: '', unitPrice: '', reserveCategoryId: null }); }
function remove(index: number) { drafts.value.splice(index, 1); }

async function save() {
  if (!reason.value.trim()) { error.value = '请填写本次项目物资调整原因'; return; }
  const materials = [] as Array<{ id?: string; materialId: string | null; model: string; unit: string; requiredQuantityScaled: number; unitPriceScaled: number | null; reserveCategoryId: string | null }>;
  for (const row of drafts.value) {
    const quantity = parseScaled(row.quantity);
    const price = row.unitPrice.trim() ? parseScaled(row.unitPrice) : null;
    if (!row.model.trim() || !row.unit.trim() || quantity === null || quantity <= 0) { error.value = '每条项目物资都必须填写型号、单位和正数数量，数量最多 4 位小数'; return; }
    if (row.unitPrice.trim() && price === null) { error.value = '项目物资单价最多 4 位小数；留空表示未知'; return; }
    materials.push({ ...(row.id ? { id: row.id } : {}), materialId: row.materialId, model: row.model.trim(), unit: row.unit.trim(), requiredQuantityScaled: quantity, unitPriceScaled: price, reserveCategoryId: row.reserveCategoryId });
  }
  saving.value = true; error.value = ''; conflict.value = false;
  try {
    await apiRequest(`/api/reserve-projects/${encodeURIComponent(props.project.id)}/materials`, jsonRequestInit('PUT', { expectedVersion: props.project.version, reason: reason.value.trim(), materials }));
    emit('update:show', false); emit('saved');
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) { conflict.value = true; error.value = '项目已被其他人修改。当前物资草稿已保留，请读取最新项目后再确认。'; }
    else error.value = cause instanceof Error ? cause.message : '保存项目物资失败';
  } finally { saving.value = false; }
}
watch(() => props.show, (show) => { if (show) void initialize(); });
</script>

<template>
  <n-drawer :show="show" placement="right" :width="760" :mask-closable="!saving" class="project-materials-drawer" @update:show="setShow">
    <n-drawer-content title="修订项目物资" :closable="!saving">
      <div class="editor-intro"><strong>项目物资是项目阶段独立确认的事实</strong><span>可以新增、换型、增减数量；已经被执行任务占用的范围由服务端保护，不会静默改写历史。</span></div>
      <n-alert v-if="error" :type="conflict ? 'warning' : 'error'" :bordered="false" class="editor-alert">{{ error }}</n-alert>
      <n-button v-if="conflict" data-test="refresh-project-material-conflict" secondary block class="editor-alert" @click="emit('request-refresh')">读取最新项目数据</n-button>
      <div v-if="drafts.length" class="material-editor-list">
        <section v-for="(row,index) in drafts" :key="row.id ?? `new-${index}`" class="material-editor-row">
          <div class="material-row-head"><strong>物资 {{ index + 1 }}</strong><n-button quaternary type="error" size="small" @click="remove(index)">移除</n-button></div>
          <div class="material-fields">
            <label><span>型号</span><n-input v-model:value="row.model" /></label>
            <label><span>数量</span><n-input v-model:value="row.quantity" inputmode="decimal" /></label>
            <label><span>单位</span><n-input v-model:value="row.unit" /></label>
            <label><span>单价（元/单位）</span><n-input v-model:value="row.unitPrice" inputmode="decimal" placeholder="留空表示未知" /></label>
            <label><span>储备大类</span><n-select v-model:value="row.reserveCategoryId" :options="categoryOptions" clearable placeholder="可不分类" /></label>
          </div>
        </section>
      </div>
      <n-empty v-else description="当前没有项目物资；0 物资项目是合法状态" />
      <n-button secondary class="add-material" @click="add">新增项目物资</n-button>
      <div class="reason-field"><span>本次调整原因</span><n-input v-model:value="reason" data-test="material-revision-reason" placeholder="必填，用于保留修订历史" /></div>
      <div class="editor-actions"><n-button :disabled="saving" @click="setShow(false)">取消</n-button><n-button data-test="save-project-materials" type="primary" :loading="saving" @click="save">保存物资修订</n-button></div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.editor-intro{display:grid;gap:5px;margin-bottom:16px;padding:13px 14px;border:1px solid var(--ui-border);border-radius:11px;background:var(--ui-surface-subtle)}.editor-intro strong{font-size:13px}.editor-intro span{color:var(--ui-text-secondary);font-size:11px;line-height:1.6}.editor-alert{margin-bottom:14px}.material-editor-list{display:grid;border-top:1px solid var(--ui-border)}.material-editor-row{padding:15px 0;border-bottom:1px solid var(--ui-border)}.material-row-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.material-row-head strong{font-size:12px}.material-fields{display:grid;grid-template-columns:minmax(150px,1.3fr) minmax(100px,.7fr) minmax(85px,.55fr) minmax(150px,1fr) minmax(150px,1fr);gap:9px}.material-fields label,.reason-field{display:grid;gap:5px}.material-fields label>span,.reason-field>span{color:var(--ui-text-secondary);font-size:10px;font-weight:600}.add-material{margin-top:14px}.reason-field{margin-top:18px;padding-top:16px;border-top:1px solid var(--ui-border)}.editor-actions{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:9px;padding:14px 0 max(4px,env(safe-area-inset-bottom));background:var(--ui-surface)}
@media(max-width:900px){.material-fields{grid-template-columns:1fr 1fr}.material-fields label:first-child{grid-column:1/-1}}@media(max-width:767px){:global(.project-materials-drawer .n-drawer){width:100vw!important;max-width:100vw!important}.material-fields{grid-template-columns:1fr 1fr}.editor-actions .n-button:last-child{flex:1}}
</style>
