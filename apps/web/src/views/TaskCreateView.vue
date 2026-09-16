<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NDatePicker, NEmpty, NForm, NFormItem, NInput, NSpin, useMessage } from 'naive-ui';
import type { CurrentUser, ProjectExecutionSummary, ProjectTaskExecutionSummary, ReserveProjectSummary } from '@tpm/shared';
import { ApiRequestError, apiRequest, jsonRequestInit } from '../api/client';
import AppPressable from '../app/AppPressable.vue';

const props = defineProps<{ currentUser: CurrentUser }>();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const projectId = computed(() => String(route.params.projectId));
const project = ref<ReserveProjectSummary | null>(null);
const execution = ref<ProjectExecutionSummary | null>(null);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const conflict = ref(false);
const formError = ref('');
const idempotencyKey = ref('');
const name = ref('');
const scopeText = ref('');
const owner = ref('');
const plannedDate = ref<number | null>(Date.now());
const plannedQuantity = ref('');
const unit = ref('项');
const demandQuantities = ref<Record<string, string>>({});
const materialQuantities = ref<Record<string, string>>({});

const canCreate = computed(() => ['admin', 'project_manager', 'implementation'].includes(props.currentUser.role));

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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

function assignedMaterialQuantity(projectMaterialRequirementId: string) {
  return (execution.value?.tasks ?? []).reduce((sum, task) => sum + task.materials
    .filter((item) => item.projectMaterialRequirementId === projectMaterialRequirementId)
    .reduce((taskSum, item) => taskSum + item.requiredQuantityScaled, 0), 0);
}

function availableMaterialQuantity(requirementId: string, required: number) {
  return Math.max(0, required - assignedMaterialQuantity(requirementId));
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [projectData, executionData] = await Promise.all([
      apiRequest<ReserveProjectSummary>(`/api/reserve-projects/${encodeURIComponent(projectId.value)}`),
      apiRequest<ProjectExecutionSummary>(`/api/projects/${encodeURIComponent(projectId.value)}/execution`),
    ]);
    project.value = projectData;
    execution.value = executionData;
    if (!executionData.released) error.value = '项目尚未完成项目出库，不能创建正式执行任务。';
    if (!name.value) owner.value = projectData.owner ?? '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取项目上下文失败';
  } finally {
    loading.value = false;
  }
}

function buildDemandScopes() {
  if (!project.value) return [];
  return project.value.demandLinks.flatMap((link) => {
    const quantity = parseScaled(demandQuantities.value[link.demandId] ?? '');
    return quantity !== null && quantity > 0 ? [{ demandId: link.demandId, quantityScaled: quantity }] : [];
  });
}

function buildMaterials() {
  if (!project.value) return [];
  return project.value.materialRequirements.flatMap((item) => {
    const quantity = parseScaled(materialQuantities.value[item.id] ?? '');
    return quantity !== null && quantity > 0 ? [{ projectMaterialRequirementId: item.id, quantityScaled: quantity }] : [];
  });
}

async function saveTask() {
  if (!project.value || !execution.value || !execution.value.released) return;
  const quantityScaled = parseScaled(plannedQuantity.value);
  if (!name.value.trim()) { formError.value = '请输入任务名称'; return; }
  if (quantityScaled === null || quantityScaled <= 0) { formError.value = '任务计划量必须是大于 0 的数字，最多 4 位小数'; return; }
  if (!unit.value.trim()) { formError.value = '请输入任务单位'; return; }
  const demandScopes = buildDemandScopes();
  const scoped = demandScopes.reduce((sum, item) => sum + item.quantityScaled, 0);
  if (scoped > quantityScaled) { formError.value = '需求范围数量合计不能超过任务计划量'; return; }
  const materials = buildMaterials();
  for (const requested of materials) {
    const source = project.value.materialRequirements.find((item) => item.id === requested.projectMaterialRequirementId)!;
    const available = availableMaterialQuantity(source.id, source.requiredQuantityScaled);
    if (requested.quantityScaled > available) {
      formError.value = `${source.model} 本次最多可分配 ${formatScaled(available)} ${source.unit}`;
      return;
    }
  }

  saving.value = true;
  conflict.value = false;
  formError.value = '';
  try {
    const created = await apiRequest<ProjectTaskExecutionSummary>('/api/project-tasks', jsonRequestInit('POST', {
      projectId: project.value.id,
      expectedProjectVersion: execution.value.projectVersion,
      name: name.value.trim(),
      description: null,
      scopeText: scopeText.value.trim() || null,
      owner: owner.value.trim() || null,
      plannedDate: plannedDate.value ? businessDateFromTimestamp(plannedDate.value) : null,
      plannedQuantityScaled: quantityScaled,
      unit: unit.value.trim(),
      demandScopes,
      materials,
    }, idempotencyKey.value));
    message.success('执行任务已创建');
    void router.push(`/projects/${encodeURIComponent(project.value.id)}/tasks/${encodeURIComponent(created.id)}`);
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 409) {
      conflict.value = true;
      formError.value = '项目已被更新。你的任务草稿仍保留，请读取最新项目数据后重新确认。';
    } else {
      formError.value = cause instanceof Error ? cause.message : '执行任务创建失败';
    }
  } finally {
    saving.value = false;
  }
}

async function reloadProject() {
  await load();
  conflict.value = false;
  formError.value = '';
  idempotencyKey.value = crypto.randomUUID();
}

function backToProject() { void router.push(`/projects/${encodeURIComponent(projectId.value)}?tab=tasks`); }

watch([name, scopeText, owner, plannedDate, plannedQuantity, unit, demandQuantities, materialQuantities], () => {
  idempotencyKey.value = crypto.randomUUID();
  if (!saving.value) {
    conflict.value = false;
    formError.value = '';
  }
}, { deep: true });

onMounted(() => {
  idempotencyKey.value = crypto.randomUUID();
  void load();
});
</script>

<template>
  <div class="view-stack task-create-view">
    <app-pressable class="breadcrumb-back" @click="backToProject">‹ 返回项目</app-pressable>
    <n-spin :show="loading">
      <template v-if="project && execution">
        <section class="create-header">
          <div>
            <div class="object-kicker">{{ project.name }} / 执行任务</div>
            <h2>新建执行任务</h2>
            <p>定义现场工作范围；供应、实施和结算将在任务创建后独立推进。</p>
          </div>
        </section>

        <n-alert v-if="error" type="warning" :bordered="false">{{ error }}</n-alert>
        <n-alert v-if="!canCreate" type="info" :bordered="false">当前账号只能查看项目，不能创建执行任务。</n-alert>
        <template v-if="canCreate && execution.released">
          <n-alert v-if="formError" :type="conflict ? 'warning' : 'error'" :bordered="false">{{ formError }}</n-alert>
          <n-button v-if="conflict" secondary @click="reloadProject">读取最新项目数据</n-button>

          <div class="task-form-layout">
            <section class="form-surface basics-surface">
              <div class="section-heading"><h3>任务信息</h3><span>必填项保持最少</span></div>
              <n-form label-placement="top">
                <n-form-item label="任务名称"><n-input v-model:value="name" data-test="task-name" placeholder="例如：龙城线 #001-#010 更换任务" /></n-form-item>
                <n-form-item label="现场范围"><n-input v-model:value="scopeText" placeholder="可选：用易读文字说明现场范围" /></n-form-item>
                <div class="two-column-fields">
                  <n-form-item label="负责人"><n-input v-model:value="owner" /></n-form-item>
                  <n-form-item label="计划日期"><n-date-picker v-model:value="plannedDate" type="date" clearable /></n-form-item>
                </div>
                <div class="quantity-fields">
                  <n-form-item label="任务计划量"><n-input v-model:value="plannedQuantity" data-test="planned-quantity" inputmode="decimal" /></n-form-item>
                  <n-form-item label="单位"><n-input v-model:value="unit" /></n-form-item>
                </div>
              </n-form>
            </section>

            <div class="allocation-stack">
              <section class="form-surface">
                <div class="section-heading"><div><h3>需求范围</h3><span>可选；合计不能超过任务计划量</span></div><strong>{{ project.demandLinks.length }} 项</strong></div>
                <div v-if="project.demandLinks.length" class="allocation-list">
                  <div v-for="link in project.demandLinks" :key="link.id" class="allocation-row">
                    <div><strong>{{ link.sequenceNo }}</strong><span>{{ link.lineName }} {{ link.section }}</span></div>
                    <n-input :data-test="`demand-${link.demandId}`" :value="demandQuantities[link.demandId] ?? ''" inputmode="decimal" placeholder="本任务覆盖量" @update:value="(value: string) => { demandQuantities[link.demandId] = value; }" />
                  </div>
                </div>
                <n-empty v-else description="项目没有来源需求；仍可创建执行任务" />
              </section>

              <section class="form-surface">
                <div class="section-heading"><div><h3>任务物资</h3><span>可选；只分配当前项目剩余物资</span></div><strong>{{ project.materialRequirements.length }} 项</strong></div>
                <div v-if="project.materialRequirements.length" class="allocation-list">
                  <div v-for="material in project.materialRequirements" :key="material.id" class="allocation-row material-row">
                    <div>
                      <strong>{{ material.model }}</strong>
                      <span>剩余可分配 {{ formatScaled(availableMaterialQuantity(material.id, material.requiredQuantityScaled)) }} {{ material.unit }}</span>
                    </div>
                    <div class="material-input"><n-input :data-test="`material-${material.id}`" :value="materialQuantities[material.id] ?? ''" inputmode="decimal" placeholder="本任务需要量" @update:value="(value: string) => { materialQuantities[material.id] = value; }" /><span>{{ material.unit }}</span></div>
                  </div>
                </div>
                <n-empty v-else description="项目没有项目物资；任务可以不带物资" />
              </section>
            </div>
          </div>

          <div class="form-actions">
            <n-button @click="backToProject">取消</n-button>
            <n-button data-test="save-task" type="primary" :loading="saving" @click="saveTask">创建执行任务</n-button>
          </div>
        </template>
      </template>
    </n-spin>
  </div>
</template>

<style scoped>
.task-create-view { max-width: 1260px; }
.breadcrumb-back { justify-self: start; padding: 3px 0; border: 0; background: transparent; color: var(--ui-text-secondary); cursor: pointer; }
.create-header { padding: 4px 2px 8px; }
.object-kicker { margin-bottom: 5px; color: var(--ui-text-secondary); font-size: 13px; }
.create-header h2 { margin: 0; font-size: 28px; line-height: 1.25; letter-spacing: -.025em; }
.create-header p { margin: 7px 0 0; color: var(--ui-text-secondary); font-size: 14px; }
.task-form-layout { display: grid; grid-template-columns: minmax(340px, .8fr) minmax(460px, 1.2fr); gap: 16px; align-items: start; }
.allocation-stack { display: grid; gap: 16px; }
.form-surface { padding: 20px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.section-heading h3 { margin: 0; font-size: 18px; }
.section-heading span { display: block; margin-top: 4px; color: var(--ui-text-secondary); font-size: 12px; font-weight: 400; }
.section-heading > strong { color: var(--ui-text-secondary); font-size: 13px; white-space: nowrap; }
.two-column-fields, .quantity-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.quantity-fields { grid-template-columns: 1.5fr .5fr; }
.allocation-list { display: grid; }
.allocation-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 210px); gap: 18px; align-items: center; min-height: 68px; padding: 10px 0; border-bottom: 1px solid var(--ui-border); }
.allocation-row:last-child { border-bottom: 0; }
.allocation-row > div:first-child { display: grid; gap: 4px; }
.allocation-row span { color: var(--ui-text-secondary); font-size: 12px; }
.material-input { display: flex; align-items: center; gap: 8px; }
.material-input > span { flex: 0 0 auto; }
.form-actions { position: sticky; bottom: 0; z-index: 5; display: flex; justify-content: flex-end; gap: 10px; padding: 14px 0; background: linear-gradient(180deg, transparent, var(--ui-canvas) 24%); }
@media (max-width: 900px) {
  .task-form-layout { grid-template-columns: 1fr; }
}
@media (max-width: 767px) {
  .create-header h2 { font-size: 24px; }
  .form-surface { padding: 17px 16px; }
  .two-column-fields, .quantity-fields { grid-template-columns: 1fr; gap: 0; }
  .allocation-row { grid-template-columns: 1fr; gap: 9px; padding: 14px 0; }
  .form-actions { margin-inline: -12px; padding: 12px 12px max(12px, env(safe-area-inset-bottom)); background: var(--ui-canvas); }
  .form-actions .n-button:last-child { flex: 1; }
}
</style>
