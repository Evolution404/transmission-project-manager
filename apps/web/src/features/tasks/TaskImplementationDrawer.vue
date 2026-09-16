<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NDatePicker, NDrawer, NDrawerContent, NForm, NFormItem, NInput, useMessage } from 'naive-ui';
import type { ProjectTaskExecutionSummary } from '@tpm/shared';
import { ApiRequestError, apiRequest, jsonRequestInit } from '../../api/client';

const props = defineProps<{ show: boolean; task: ProjectTaskExecutionSummary }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; saved: []; 'request-refresh': [] }>();
const message = useMessage();
const saving = ref(false);
const recordDate = ref(Date.now());
const completedQuantity = ref('');
const note = ref('');
const scopeQuantities = ref<Record<string, string>>({});
const materialUsages = ref<Record<string, string>>({});
const formError = ref('');
const conflict = ref(false);
const idempotencyKey = ref('');

function parseScaled(value: string) {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,4}))?$/);
  if (!match) return null;
  const scaled = BigInt(match[1]!) * 10000n + BigInt((match[2] ?? '').padEnd(4, '0') || '0');
  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

function formatScaled(value: number) {
  const whole = Math.floor(value / 10000);
  const fraction = String(value % 10000).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function businessDateFromTimestamp(value: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

const remainingQuantity = computed(() => Math.max(0, props.task.plannedQuantityScaled - props.task.implementedQuantityScaled));

function reset() {
  recordDate.value = Date.now();
  completedQuantity.value = '';
  note.value = '';
  scopeQuantities.value = {};
  materialUsages.value = {};
  formError.value = '';
  conflict.value = false;
  idempotencyKey.value = crypto.randomUUID();
}

watch(() => props.show, (show) => { if (show) reset(); });
watch([recordDate, completedQuantity, note, scopeQuantities, materialUsages], () => {
  if (!props.show || saving.value) return;
  idempotencyKey.value = crypto.randomUUID();
  formError.value = '';
  conflict.value = false;
}, { deep: true });
watch(() => props.task.implementationVersion, () => {
  if (conflict.value) {
    conflict.value = false;
    formError.value = '';
    idempotencyKey.value = crypto.randomUUID();
  }
});

function close() {
  if (!saving.value) emit('update:show', false);
}

function setShow(value: boolean) {
  if (!saving.value || value) emit('update:show', value);
}

async function save() {
  const completedQuantityScaled = parseScaled(completedQuantity.value);
  if (completedQuantityScaled === null || completedQuantityScaled <= 0) {
    formError.value = '请输入大于 0 的本次实施完成量';
    return;
  }
  if (completedQuantityScaled > remainingQuantity.value) {
    formError.value = `本次最多可记录 ${formatScaled(remainingQuantity.value)} ${props.task.unit}`;
    return;
  }
  const scopeLines = props.task.demandScopes.flatMap((scope) => {
    const quantity = parseScaled(scopeQuantities.value[scope.id] ?? '');
    return quantity !== null && quantity > 0 ? [{ taskDemandScopeId: scope.id, completedQuantityScaled: quantity }] : [];
  });
  const scoped = scopeLines.reduce((sum, item) => sum + item.completedQuantityScaled, 0);
  const fullyLinked = props.task.demandScopes.reduce((sum, item) => sum + item.plannedQuantityScaled, 0) === props.task.plannedQuantityScaled;
  if (scoped > completedQuantityScaled || (fullyLinked && scoped !== completedQuantityScaled)) {
    formError.value = fullyLinked ? '本任务计划量已全部关联需求，本次需求范围完成量合计必须等于本次实施量' : '需求范围完成量合计不能超过本次实施量';
    return;
  }
  const materialUsageLines = props.task.materials.flatMap((material) => {
    const raw = materialUsages.value[material.id] ?? '';
    const quantity = parseScaled(raw);
    return raw.trim() && quantity !== null && quantity >= 0 ? [{ taskMaterialRequirementId: material.id, quantityScaled: quantity }] : [];
  });
  if (props.task.materials.some((material) => {
    const raw = materialUsages.value[material.id] ?? '';
    return raw.trim() && parseScaled(raw) === null;
  })) {
    formError.value = '实际物资使用量格式无效，最多 4 位小数';
    return;
  }

  saving.value = true;
  formError.value = '';
  conflict.value = false;
  try {
    await apiRequest('/api/task-implementations', jsonRequestInit('POST', {
      taskId: props.task.id,
      expectedImplementationVersion: props.task.implementationVersion,
      recordDate: businessDateFromTimestamp(recordDate.value),
      completedQuantityScaled,
      scopeLines,
      materialUsages: materialUsageLines,
      note: note.value.trim() || null,
    }, idempotencyKey.value));
    emit('update:show', false);
    emit('saved');
    message.success('实施事实已记录');
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) {
      conflict.value = true;
      formError.value = '实施状态已被更新。当前输入已保留，请读取最新数据后再确认。';
    } else {
      formError.value = cause instanceof Error ? cause.message : '实施记录保存失败';
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <n-drawer :show="show" placement="right" :width="560" :mask-closable="!saving" class="task-progress-drawer" @update:show="setShow" @mask-click="close">
    <n-drawer-content title="记录实施" :closable="!saving">
      <div class="progress-context">
        <strong>{{ task.name }}</strong>
        <span>实施独立于供应和结算，不以到货状态作为额外门槛。</span>
      </div>
      <div class="progress-current">
        <div><span>任务计划</span><strong>{{ formatScaled(task.plannedQuantityScaled) }} {{ task.unit }}</strong></div>
        <div><span>累计已实施</span><strong>{{ formatScaled(task.implementedQuantityScaled) }} {{ task.unit }}</strong></div>
        <div class="remaining-row"><span>本次最多</span><strong>{{ formatScaled(remainingQuantity) }} {{ task.unit }}</strong></div>
      </div>
      <n-alert v-if="formError" :type="conflict ? 'warning' : 'error'" :bordered="false" class="progress-alert">{{ formError }}</n-alert>
      <n-button v-if="conflict" secondary block class="progress-alert" @click="emit('request-refresh')">读取最新任务数据</n-button>
      <n-form label-placement="top">
        <n-form-item label="本次实施完成量"><n-input v-model:value="completedQuantity" data-test="implementation-quantity" inputmode="decimal" /></n-form-item>
        <n-form-item label="实施日期"><n-date-picker v-model:value="recordDate" type="date" :clearable="false" /></n-form-item>
        <div v-if="task.demandScopes.length" class="drawer-subsection">
          <strong>本次完成的需求范围</strong>
          <span>只有任务计划量全部关联需求时，明细合计才必须等于本次实施量。</span>
          <div v-for="scope in task.demandScopes" :key="scope.id" class="drawer-line">
            <div><strong>{{ scope.demand?.lineName }} {{ scope.demand?.section }}</strong><span>任务范围 {{ formatScaled(scope.plannedQuantityScaled) }}</span></div>
            <n-input :data-test="`implementation-scope-${scope.id}`" :value="scopeQuantities[scope.id] ?? ''" inputmode="decimal" placeholder="本次完成量" @update:value="(value: string) => { scopeQuantities[scope.id] = value; }" />
          </div>
        </div>
        <div v-if="task.materials.length" class="drawer-subsection">
          <strong>实际物资使用（可选）</strong>
          <span>记录本次实际使用，不反推或改写项目物资计划。</span>
          <div v-for="material in task.materials" :key="material.id" class="drawer-line">
            <div><strong>{{ material.model }}</strong><span>{{ material.unit }}</span></div>
            <n-input :value="materialUsages[material.id] ?? ''" inputmode="decimal" placeholder="本次实际使用量" @update:value="(value: string) => { materialUsages[material.id] = value; }" />
          </div>
        </div>
        <n-form-item label="备注"><n-input v-model:value="note" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" /></n-form-item>
      </n-form>
      <div class="progress-actions"><n-button @click="close">取消</n-button><n-button data-test="save-implementation" type="primary" :loading="saving" @click="save">记录实施</n-button></div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.progress-context { display: grid; gap: 4px; margin-bottom: 18px; }
.progress-context strong { font-size: 18px; }
.progress-context span, .drawer-subsection > span { color: var(--ui-text-secondary); font-size: 13px; line-height: 1.55; }
.progress-current { display: grid; gap: 1px; overflow: hidden; margin-bottom: 18px; border: 1px solid var(--ui-border); border-radius: 14px; background: var(--ui-border); }
.progress-current > div { display: flex; justify-content: space-between; gap: 16px; padding: 11px 14px; background: var(--ui-surface); }
.progress-current span, .drawer-line span { color: var(--ui-text-secondary); font-size: 13px; }
.remaining-row { background: var(--ui-accent-soft) !important; }
.progress-alert { margin-bottom: 14px; }
.drawer-subsection { display: grid; gap: 4px; margin: 4px 0 18px; padding-top: 14px; border-top: 1px solid var(--ui-border); }
.drawer-line { display: grid; grid-template-columns: minmax(0, 1fr) 190px; gap: 14px; align-items: center; padding: 9px 0; }
.drawer-line > div { display: grid; gap: 3px; }
.progress-actions { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 10px; padding-top: 14px; background: var(--ui-surface); }
@media (max-width: 767px) {
  :global(.task-progress-drawer.n-drawer) { left: 0 !important; right: auto !important; top: 0 !important; bottom: auto !important; width: 100dvw !important; max-width: 100dvw !important; height: 100dvh !important; max-height: 100dvh !important; min-height: 0; overflow: hidden; }
  .drawer-line { grid-template-columns: 1fr; gap: 7px; padding: 11px 0; }
  .progress-actions { padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .progress-actions .n-button:last-child { flex: 1; }
}
</style>
