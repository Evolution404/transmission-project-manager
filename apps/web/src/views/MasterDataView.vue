<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NDataTable, NEmpty, NForm, NFormItem, NInput, NModal, NSelect,
  NSpace, NSwitch, NTabPane, NTabs, NTag, useMessage,
} from 'naive-ui';
import type { CurrentUser, TransmissionLineSummary, TransmissionTowerSummary, VoltageLevelSummary, VoltageSystemType } from '@tpm/shared';
import { parseApiResponse } from '../api/response';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const isAdmin = computed(() => props.currentUser.role === 'admin');

const voltageLevels = ref<VoltageLevelSummary[]>([]);
const lines = ref<TransmissionLineSummary[]>([]);
const towers = ref<TransmissionTowerSummary[]>([]);
const selectedVoltageId = ref<string | null>(null);
const selectedLineId = ref<string | null>(null);
const error = ref('');

const voltageModal = ref(false);
const lineModal = ref(false);
const towerModal = ref(false);
const editingVoltage = ref<VoltageLevelSummary | null>(null);
const editingLine = ref<TransmissionLineSummary | null>(null);
const editingTower = ref<TransmissionTowerSummary | null>(null);
const saving = ref(false);

const voltageForm = ref({ displayName: '', code: '', systemType: 'AC' as VoltageSystemType, nominalKv: '', sortOrder: '', enabled: true });
const lineForm = ref({ voltageLevelId: '', lineCode: '', lineName: '', enabled: true });
const towerForm = ref({ lineId: '', towerNo: '', sortIndex: '', towerType: '', enabled: true });

const voltageOptions = computed(() => voltageLevels.value.filter((item) => item.enabled).map((item) => ({ label: item.displayName, value: item.id })));
const lineOptions = computed(() => lines.value.filter((item) => item.enabled).map((item) => ({ label: `${item.voltageLevelName} · ${item.lineName}`, value: item.id })));
const systemOptions = [{ label: '交流', value: 'AC' }, { label: '直流', value: 'DC' }];

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
  return result.data;
}

async function loadAll() {
  error.value = '';
  try {
    const [voltageData, lineData, towerData] = await Promise.all([
      apiRequest<{ items: VoltageLevelSummary[] }>('/api/master/voltage-levels'),
      apiRequest<{ items: TransmissionLineSummary[] }>('/api/master/lines'),
      apiRequest<{ items: TransmissionTowerSummary[] }>('/api/master/towers'),
    ]);
    voltageLevels.value = voltageData.items;
    lines.value = lineData.items;
    towers.value = towerData.items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '基础台账读取失败';
  }
}

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) };
}

function openVoltage(item?: VoltageLevelSummary) {
  editingVoltage.value = item ?? null;
  voltageForm.value = item ? {
    displayName: item.displayName, code: item.code, systemType: item.systemType,
    nominalKv: String(item.nominalKv), sortOrder: String(item.sortOrder), enabled: item.enabled,
  } : { displayName: '', code: '', systemType: 'AC', nominalKv: '', sortOrder: String((voltageLevels.value.length + 1) * 10), enabled: true };
  voltageModal.value = true;
}

async function saveVoltage() {
  const nominalKv = Number(voltageForm.value.nominalKv), sortOrder = Number(voltageForm.value.sortOrder);
  if (!voltageForm.value.displayName.trim() || !voltageForm.value.code.trim() || !Number.isInteger(nominalKv) || nominalKv <= 0 || !Number.isInteger(sortOrder)) {
    message.warning('请完整填写电压等级名称、编码、标称电压和排序'); return;
  }
  saving.value = true;
  try {
    const body = { ...voltageForm.value, displayName: voltageForm.value.displayName.trim(), code: voltageForm.value.code.trim(), nominalKv, sortOrder };
    if (editingVoltage.value) await apiRequest(`/api/master/voltage-levels/${editingVoltage.value.id}`, jsonInit('PATCH', { ...body, expectedVersion: editingVoltage.value.version }));
    else await apiRequest('/api/master/voltage-levels', jsonInit('POST', body));
    voltageModal.value = false; await loadAll(); message.success('电压等级已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

function openLine(item?: TransmissionLineSummary) {
  editingLine.value = item ?? null;
  lineForm.value = item ? { voltageLevelId: item.voltageLevelId, lineCode: item.lineCode ?? '', lineName: item.lineName, enabled: item.enabled } : { voltageLevelId: selectedVoltageId.value ?? voltageOptions.value[0]?.value ?? '', lineCode: '', lineName: '', enabled: true };
  lineModal.value = true;
}

async function saveLine() {
  if (!lineForm.value.voltageLevelId || !lineForm.value.lineName.trim()) { message.warning('请选择电压等级并填写线路名称'); return; }
  saving.value = true;
  try {
    const body = { ...lineForm.value, lineName: lineForm.value.lineName.trim(), lineCode: lineForm.value.lineCode.trim() || null };
    if (editingLine.value) await apiRequest(`/api/master/lines/${editingLine.value.id}`, jsonInit('PATCH', { ...body, expectedVersion: editingLine.value.version }));
    else await apiRequest('/api/master/lines', jsonInit('POST', body));
    lineModal.value = false; await loadAll(); message.success('线路已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

function openTower(item?: TransmissionTowerSummary) {
  editingTower.value = item ?? null;
  towerForm.value = item ? { lineId: item.lineId, towerNo: item.towerNo, sortIndex: String(item.sortIndex), towerType: item.towerType ?? '', enabled: item.enabled } : { lineId: selectedLineId.value ?? lineOptions.value[0]?.value ?? '', towerNo: '', sortIndex: '', towerType: '', enabled: true };
  towerModal.value = true;
}

async function saveTower() {
  const sortIndex = Number(towerForm.value.sortIndex);
  if (!towerForm.value.lineId || !towerForm.value.towerNo.trim() || !Number.isInteger(sortIndex) || sortIndex <= 0) { message.warning('请选择线路并填写杆塔号和有效顺序'); return; }
  saving.value = true;
  try {
    const body = { ...towerForm.value, towerNo: towerForm.value.towerNo.trim(), sortIndex, towerType: towerForm.value.towerType.trim() || null };
    if (editingTower.value) await apiRequest(`/api/master/towers/${editingTower.value.id}`, jsonInit('PATCH', { ...body, expectedVersion: editingTower.value.version }));
    else await apiRequest('/api/master/towers', jsonInit('POST', body));
    towerModal.value = false; await loadAll(); message.success('杆塔已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '保存失败'); }
  finally { saving.value = false; }
}

const voltageColumns = [
  { title: '排序', key: 'sortOrder', width: 70 }, { title: '电压等级', key: 'displayName' },
  { title: '制式', key: 'systemType', render: (row: VoltageLevelSummary) => row.systemType === 'AC' ? '交流' : '直流' },
  { title: '标称电压', key: 'nominalKv', render: (row: VoltageLevelSummary) => `${row.nominalKv} kV` },
  { title: '状态', key: 'enabled', render: (row: VoltageLevelSummary) => row.enabled ? '启用' : '停用' },
  { title: '操作', key: 'actions', render: (row: VoltageLevelSummary) => h(NButton, { size: 'small', onClick: () => openVoltage(row) }, { default: () => '编辑' }) },
];
const lineColumns = [
  { title: '电压等级', key: 'voltageLevelName' }, { title: '线路名称', key: 'lineName' }, { title: '线路编码', key: 'lineCode', render: (row: TransmissionLineSummary) => row.lineCode ?? '—' },
  { title: '杆塔数量', key: 'towerCount', render: (row: TransmissionLineSummary) => row.towerCount ?? 0 },
  { title: '状态', key: 'enabled', render: (row: TransmissionLineSummary) => row.enabled ? '启用' : '停用' },
  { title: '操作', key: 'actions', render: (row: TransmissionLineSummary) => h(NButton, { size: 'small', onClick: () => openLine(row) }, { default: () => '编辑' }) },
];
const towerColumns = [
  { title: '线路', key: 'lineName' }, { title: '顺序', key: 'sortIndex', width: 80 }, { title: '杆塔号', key: 'towerNo' },
  { title: '类型', key: 'towerType', render: (row: TransmissionTowerSummary) => row.towerType ?? '—' },
  { title: '状态', key: 'enabled', render: (row: TransmissionTowerSummary) => row.enabled ? '启用' : '停用' },
  { title: '操作', key: 'actions', render: (row: TransmissionTowerSummary) => h(NButton, { size: 'small', onClick: () => openTower(row) }, { default: () => '编辑' }) },
];

const visibleLines = computed(() => selectedVoltageId.value ? lines.value.filter((item) => item.voltageLevelId === selectedVoltageId.value) : lines.value);
const visibleTowers = computed(() => selectedLineId.value ? towers.value.filter((item) => item.lineId === selectedLineId.value) : towers.value);

onMounted(loadAll);
</script>

<template>
  <div class="view-stack master-data-view">
    <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>
    <div class="master-hero">
      <div><span>基础台账</span><h2>统一维护电压等级、线路和杆塔</h2><p>业务表单只引用这里的对象，不再手工录入电压、线路名称或杆段字符串。</p></div>
      <n-tag :bordered="false" :type="isAdmin ? 'success' : 'default'">{{ isAdmin ? '管理员可维护' : '只读' }}</n-tag>
    </div>

    <n-tabs type="line" animated>
      <n-tab-pane name="voltage" tab="电压等级">
        <n-card title="电压等级序列">
          <template #header-extra><n-button v-if="isAdmin" type="primary" @click="openVoltage()">新增电压等级</n-button></template>
          <n-data-table :columns="voltageColumns" :data="voltageLevels" :pagination="false" />
        </n-card>
      </n-tab-pane>
      <n-tab-pane name="lines" tab="线路台账">
        <n-card title="线路清单">
          <template #header-extra><n-space><n-select v-model:value="selectedVoltageId" clearable :options="voltageOptions" placeholder="按电压等级筛选" style="width: 180px" /><n-button v-if="isAdmin" type="primary" @click="openLine()">新增线路</n-button></n-space></template>
          <n-data-table v-if="visibleLines.length" :columns="lineColumns" :data="visibleLines" :pagination="false" :scroll-x="760" /><n-empty v-else description="暂无线路，请先新增线路。" />
        </n-card>
      </n-tab-pane>
      <n-tab-pane name="towers" tab="杆塔台账">
        <n-card title="杆塔清单">
          <template #header-extra><n-space><n-select v-model:value="selectedLineId" clearable filterable :options="lineOptions" placeholder="按线路筛选" style="width: 240px" /><n-button v-if="isAdmin" type="primary" @click="openTower()">新增杆塔</n-button></n-space></template>
          <n-data-table v-if="visibleTowers.length" :columns="towerColumns" :data="visibleTowers" :pagination="false" :scroll-x="760" /><n-empty v-else description="暂无杆塔，请先选择线路并新增杆塔。" />
        </n-card>
      </n-tab-pane>
    </n-tabs>

    <n-modal v-model:show="voltageModal" preset="card" title="电压等级" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="显示名称"><n-input v-model:value="voltageForm.displayName" placeholder="例如：220kV、±800kV" /></n-form-item><n-form-item label="内部编码"><n-input v-model:value="voltageForm.code" placeholder="例如：AC_220KV" /></n-form-item><n-form-item label="制式"><n-select v-model:value="voltageForm.systemType" :options="systemOptions" /></n-form-item><n-form-item label="标称电压 kV"><n-input v-model:value="voltageForm.nominalKv" placeholder="请输入整数" /></n-form-item><n-form-item label="排序"><n-input v-model:value="voltageForm.sortOrder" placeholder="请输入排序号" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="voltageForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="voltageModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveVoltage">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="lineModal" preset="card" title="线路" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="电压等级"><n-select v-model:value="lineForm.voltageLevelId" :options="voltageOptions" /></n-form-item><n-form-item label="线路名称"><n-input v-model:value="lineForm.lineName" placeholder="请输入线路名称" /></n-form-item><n-form-item label="线路编码（可选）"><n-input v-model:value="lineForm.lineCode" placeholder="请输入线路编码" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="lineForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="lineModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveLine">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="towerModal" preset="card" title="杆塔" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="所属线路"><n-select v-model:value="towerForm.lineId" filterable :options="lineOptions" /></n-form-item><n-form-item label="杆塔号"><n-input v-model:value="towerForm.towerNo" placeholder="例如：#20" /></n-form-item><n-form-item label="线路顺序"><n-input v-model:value="towerForm.sortIndex" placeholder="例如：20" /></n-form-item><n-form-item label="杆塔类型（可选）"><n-input v-model:value="towerForm.towerType" placeholder="例如：角钢塔、钢管杆" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="towerForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="towerModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveTower">保存</n-button></div></template>
    </n-modal>
  </div>
</template>

<style scoped>
.master-hero{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:20px 22px;border:1px solid #e4e9f1;border-radius:14px;background:linear-gradient(120deg,#fff,#f6f8fd)}
.master-hero span{color:#2457d6;font-size:11px;font-weight:700;letter-spacing:.08em}.master-hero h2{margin:4px 0 5px;font-size:21px}.master-hero p{margin:0;color:#7d8798;font-size:13px}.actions{display:flex;justify-content:flex-end;gap:10px}
@media(max-width:640px){.master-hero{align-items:flex-start;flex-direction:column;padding:16px}.master-hero h2{font-size:18px}}
</style>
