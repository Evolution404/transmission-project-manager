<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NDatePicker, NDrawer, NDrawerContent, NForm, NFormItem, NInput, useMessage } from 'naive-ui';
import type { ProjectTaskExecutionSummary } from '@tpm/shared';
import { ApiRequestError, apiRequest, jsonRequestInit } from '../../api/client';

const props = defineProps<{ show: boolean; task: ProjectTaskExecutionSummary }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; saved: []; 'request-refresh': [] }>();
const message = useMessage();
const saving = ref(false);
const settlementDate = ref(Date.now());
const amount = ref('');
const coverageQuantity = ref('');
const finalSettlement = ref(false);
const note = ref('');
const scopeCoverage = ref<Record<string, string>>({});
const formError = ref('');
const conflict = ref(false);
const idempotencyKey = ref('');

function parseScaled(value: string) {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,4}))?$/);
  if (!match) return null;
  const scaled = BigInt(match[1]!) * 10000n + BigInt((match[2] ?? '').padEnd(4, '0') || '0');
  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

function parseMoneyFen(value: string) {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const fen = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return fen <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fen) : null;
}

function formatScaled(value: number) {
  const whole = Math.floor(value / 10000);
  const fraction = String(value % 10000).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function businessDateFromTimestamp(value: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

const remainingCoverage = computed(() => Math.max(0, props.task.plannedQuantityScaled - props.task.settledQuantityScaled));

function reset() {
  settlementDate.value = Date.now();
  amount.value = '';
  coverageQuantity.value = '';
  finalSettlement.value = false;
  note.value = '';
  scopeCoverage.value = {};
  formError.value = '';
  conflict.value = false;
  idempotencyKey.value = crypto.randomUUID();
}

watch(() => props.show, (show) => { if (show) reset(); });
watch([settlementDate, amount, coverageQuantity, finalSettlement, note, scopeCoverage], () => {
  if (!props.show || saving.value) return;
  idempotencyKey.value = crypto.randomUUID();
  formError.value = '';
  conflict.value = false;
}, { deep: true });
watch(() => props.task.settlementVersion, () => {
  if (conflict.value) {
    conflict.value = false;
    formError.value = '';
    idempotencyKey.value = crypto.randomUUID();
  }
});

function close() {
  if (!saving.value) emit('update:show', false);
}

async function save() {
  const amountFen = parseMoneyFen(amount.value);
  const coverageQuantityScaled = parseScaled(coverageQuantity.value);
  if (amountFen === null) { formError.value = '请输入有效结算金额，最多 2 位小数'; return; }
  if (coverageQuantityScaled === null || coverageQuantityScaled <= 0) { formError.value = '请输入大于 0 的本次结算覆盖量'; return; }
  if (coverageQuantityScaled > remainingCoverage.value) {
    formError.value = `本次最多可覆盖 ${formatScaled(remainingCoverage.value)} ${props.task.unit}`;
    return;
  }
  const coverage = props.task.demandScopes.flatMap((scope) => {
    const quantity = parseScaled(scopeCoverage.value[scope.id] ?? '');
    return quantity !== null && quantity > 0 ? [{ taskDemandScopeId: scope.id, quantityScaled: quantity }] : [];
  });
  const scoped = coverage.reduce((sum, item) => sum + item.quantityScaled, 0);
  const fullyLinked = props.task.demandScopes.reduce((sum, item) => sum + item.plannedQuantityScaled, 0) === props.task.plannedQuantityScaled;
  if (scoped > coverageQuantityScaled || (fullyLinked && scoped !== coverageQuantityScaled)) {
    formError.value = fullyLinked ? '本任务计划量已全部关联需求，本次需求覆盖量合计必须等于本次结算覆盖量' : '需求覆盖量合计不能超过本次结算覆盖量';
    return;
  }
  if (finalSettlement.value && props.task.settledQuantityScaled + coverageQuantityScaled !== props.task.plannedQuantityScaled) {
    formError.value = '最终结算必须一次覆盖任务剩余全部计划量';
    return;
  }

  saving.value = true;
  formError.value = '';
  conflict.value = false;
  try {
    await apiRequest('/api/task-settlements', jsonRequestInit('POST', {
      taskId: props.task.id,
      expectedSettlementVersion: props.task.settlementVersion,
      settlementDate: businessDateFromTimestamp(settlementDate.value),
      coverageQuantityScaled,
      amountFen,
      final: finalSettlement.value,
      note: note.value.trim() || null,
      coverage,
      agreementAllocations: [],
    }, idempotencyKey.value));
    emit('update:show', false);
    emit('saved');
    message.success('结算事实已记录');
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) {
      conflict.value = true;
      formError.value = '结算状态已被更新。当前输入已保留，请读取最新数据后再确认。';
    } else {
      formError.value = cause instanceof Error ? cause.message : '结算记录保存失败';
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <n-drawer :show="show" placement="right" :width="560" class="task-progress-drawer" @update:show="emit('update:show', $event)" @mask-click="close">
    <n-drawer-content title="登记结算" closable>
      <div class="progress-context">
        <strong>{{ task.name }}</strong>
        <span>结算与实施独立，允许在实施前发生；“最终结算”仅用于明确关闭全部任务范围。</span>
      </div>
      <div class="progress-current">
        <div><span>任务计划</span><strong>{{ formatScaled(task.plannedQuantityScaled) }} {{ task.unit }}</strong></div>
        <div><span>累计已覆盖</span><strong>{{ formatScaled(task.settledQuantityScaled) }} {{ task.unit }}</strong></div>
        <div class="remaining-row"><span>本次最多</span><strong>{{ formatScaled(remainingCoverage) }} {{ task.unit }}</strong></div>
      </div>
      <n-alert v-if="formError" :type="conflict ? 'warning' : 'error'" :bordered="false" class="progress-alert">{{ formError }}</n-alert>
      <n-button v-if="conflict" secondary block class="progress-alert" @click="emit('request-refresh')">读取最新任务数据</n-button>
      <n-form label-placement="top">
        <div class="money-quantity-fields">
          <n-form-item label="结算金额（元）"><n-input v-model:value="amount" data-test="settlement-amount" inputmode="decimal" /></n-form-item>
          <n-form-item label="本次覆盖量"><n-input v-model:value="coverageQuantity" data-test="settlement-quantity" inputmode="decimal" /></n-form-item>
        </div>
        <n-form-item label="结算日期"><n-date-picker v-model:value="settlementDate" type="date" :clearable="false" /></n-form-item>
        <div v-if="task.demandScopes.length" class="drawer-subsection">
          <strong>本次覆盖的需求范围</strong>
          <span>结算覆盖是独立事实，不从实施进度自动推断。</span>
          <div v-for="scope in task.demandScopes" :key="scope.id" class="drawer-line">
            <div><strong>{{ scope.demand?.lineName }} {{ scope.demand?.section }}</strong><span>任务范围 {{ formatScaled(scope.plannedQuantityScaled) }}</span></div>
            <n-input :data-test="`settlement-scope-${scope.id}`" :value="scopeCoverage[scope.id] ?? ''" inputmode="decimal" placeholder="本次覆盖量" @update:value="(value: string) => { scopeCoverage[scope.id] = value; }" />
          </div>
        </div>
        <n-form-item><n-checkbox v-model:checked="finalSettlement">最终结算</n-checkbox></n-form-item>
        <n-alert v-if="finalSettlement" type="warning" :bordered="false" class="final-warning">最终结算会明确关闭任务结算范围；必须完整覆盖任务剩余计划量。</n-alert>
        <n-form-item label="备注"><n-input v-model:value="note" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" /></n-form-item>
      </n-form>
      <div class="progress-actions"><n-button @click="close">取消</n-button><n-button data-test="save-settlement" type="primary" :loading="saving" @click="save">登记结算</n-button></div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.progress-context { display: grid; gap: 4px; margin-bottom: 18px; }
.progress-context strong { font-size: 18px; }
.progress-context span, .drawer-subsection > span { color: var(--ui-text-secondary, #566174); font-size: 12px; line-height: 1.55; }
.progress-current { display: grid; gap: 1px; overflow: hidden; margin-bottom: 18px; border: 1px solid var(--ui-border, #dce2ea); border-radius: 14px; background: var(--ui-border, #dce2ea); }
.progress-current > div { display: flex; justify-content: space-between; gap: 16px; padding: 11px 14px; background: var(--ui-surface, #fff); }
.progress-current span, .drawer-line span { color: var(--ui-text-secondary, #566174); font-size: 12px; }
.remaining-row { background: var(--ui-accent-soft, #e6efff) !important; }
.progress-alert, .final-warning { margin-bottom: 14px; }
.money-quantity-fields { display: grid; grid-template-columns: 1.2fr .8fr; gap: 12px; }
.drawer-subsection { display: grid; gap: 4px; margin: 4px 0 18px; padding-top: 14px; border-top: 1px solid var(--ui-border, #dce2ea); }
.drawer-line { display: grid; grid-template-columns: minmax(0, 1fr) 190px; gap: 14px; align-items: center; padding: 9px 0; }
.drawer-line > div { display: grid; gap: 3px; }
.progress-actions { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 10px; padding-top: 14px; background: var(--ui-surface, #fff); }
@media (max-width: 767px) {
  :global(.task-progress-drawer .n-drawer) { width: 100vw !important; max-width: 100vw !important; }
  .money-quantity-fields, .drawer-line { grid-template-columns: 1fr; gap: 7px; }
  .drawer-line { padding: 11px 0; }
  .progress-actions { padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .progress-actions .n-button:last-child { flex: 1; }
}
</style>
