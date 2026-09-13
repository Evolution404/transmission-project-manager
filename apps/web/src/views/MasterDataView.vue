<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NCard, NDataTable, NEmpty, NForm, NFormItem, NInput, NModal, NSelect,
  NSpace, NSwitch, NTag, useMessage,
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
const mobileStep = ref<'voltage' | 'lines' | 'towers'>('voltage');
const lineCursor = ref<string | null>(null), towerCursor = ref<string | null>(null);
const loading = ref(false);
let lineRequest = 0, towerRequest = 0;
const bulkModal = ref(false), bulkText = ref('');
const selectedVoltage = computed(() => voltageLevels.value.find((v) => v.id === selectedVoltageId.value));
const selectedLine = computed(() => lines.value.find((l) => l.id === selectedLineId.value));

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

const voltageOptions = computed(() => voltageLevels.value.map((item) => ({ label: item.displayName + (item.enabled ? '' : '（停用）'), value: item.id, disabled: !item.enabled && item.id !== editingLine.value?.voltageLevelId })));
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
    voltageLevels.value = (await apiRequest<{ items: VoltageLevelSummary[] }>('/api/master/voltage-levels')).items;
    if (!voltageLevels.value.some((v) => v.id === selectedVoltageId.value)) selectedVoltageId.value = voltageLevels.value[0]?.id ?? null;
    await loadLines();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '基础台账读取失败'; }
}
async function loadLines(append = false) {
  const token = ++lineRequest, voltageId = selectedVoltageId.value;
  if (!voltageId) { lines.value = []; return; }
  loading.value = true;
  try {
    const data = await apiRequest<{ items: TransmissionLineSummary[]; nextCursor?: string | null }>(`/api/master/lines?voltageLevelId=${encodeURIComponent(voltageId)}${append && lineCursor.value ? '&cursor=' + encodeURIComponent(lineCursor.value) : ''}`);
    if (token !== lineRequest) return;
    lines.value = append ? [...lines.value, ...data.items] : data.items; lineCursor.value = data.nextCursor ?? null;
    if (selectedLineId.value && !lines.value.some((l) => l.id === selectedLineId.value)) { selectedLineId.value = null; towers.value = []; }
    if (selectedLineId.value) await loadTowers();
  } catch (cause) { if (token === lineRequest) error.value = cause instanceof Error ? cause.message : '线路读取失败'; }
  finally { if (token === lineRequest) loading.value = false; }
}
async function loadTowers(append = false) {
  const token = ++towerRequest, lineId = selectedLineId.value;
  if (!lineId) { towers.value = []; return; }
  try {
    const data = await apiRequest<{ items: TransmissionTowerSummary[]; nextCursor?: string | null }>(`/api/master/towers?lineId=${encodeURIComponent(lineId)}${append && towerCursor.value ? '&cursor=' + encodeURIComponent(towerCursor.value) : ''}`);
    if (token !== towerRequest) return;
    towers.value = append ? [...towers.value, ...data.items] : data.items; towerCursor.value = data.nextCursor ?? null;
  } catch (cause) { if (token === towerRequest) error.value = cause instanceof Error ? cause.message : '杆塔读取失败'; }
}
async function selectVoltage(id: string) {
  selectedVoltageId.value = id; selectedLineId.value = null; lines.value = []; towers.value = [];
  lineCursor.value = null; towerCursor.value = null; towerRequest++; mobileStep.value = 'lines';
  await loadLines();
}
async function selectLine(id: string) {
  selectedLineId.value = id; towers.value = []; towerCursor.value = null; mobileStep.value = 'towers'; await loadTowers();
}
async function removeObject(kind: string, item: { id: string; version: number }) {
  saving.value = true;
  try {
    await apiRequest(`/api/master/${kind}/${item.id}`, jsonInit('DELETE', { expectedVersion: item.version }));
    await loadAll(); message.success('已删除未引用的台账对象');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '删除失败'); }
  finally { saving.value = false; }
}
async function openBulk() {
  bulkText.value = ''; bulkModal.value = true;
}
async function saveBulk() {
  const rows = bulkText.value.trim().split(/\r?\n/).filter((row) => row.trim());
  if (!rows.length || rows.length > 20) { message.warning('每次请填写 1–20 行'); return; }
  const items = [];
  for (const row of rows) {
    const cells = row.split('\t').map((v) => v.trim());
    const [towerNo, order, towerType = '', state = '启用'] = cells;
    const sortIndex = Number(order);
    if (cells.length < 2 || cells.length > 4 || !towerNo || !Number.isInteger(sortIndex) || sortIndex <= 0 || !['启用', '停用', '1', '0', ''].includes(state)) { message.warning('请按“杆塔号、顺序、类型、启用/停用”粘贴，每列用制表符分隔'); return; }
    const existing = towers.value.find((t) => t.towerNo.toLowerCase() === towerNo.toLowerCase());
    items.push({ ...(existing ? { id: existing.id, expectedVersion: existing.version } : {}), towerNo, sortIndex, towerType: towerType || null, enabled: !['停用', '0'].includes(state) });
  }
  saving.value = true;
  try {
    await apiRequest(`/api/master/lines/${selectedLineId.value}/towers/batch`, jsonInit('POST', { items }));
    bulkModal.value = false; await loadTowers(); message.success('杆塔批量维护已保存');
  } catch (cause) { message.error(cause instanceof Error ? cause.message : '批量保存失败'); }
  finally { saving.value = false; }
}

function jsonInit(method: 'POST' | 'PATCH' | 'DELETE', body: unknown): RequestInit {
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
  lineForm.value = item ? { voltageLevelId: item.voltageLevelId, lineCode: item.lineCode ?? '', lineName: item.lineName, enabled: item.enabled } : { voltageLevelId: selectedVoltageId.value ?? '', lineCode: '', lineName: '', enabled: true };
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
  towerForm.value = item ? { lineId: item.lineId, towerNo: item.towerNo, sortIndex: String(item.sortIndex), towerType: item.towerType ?? '', enabled: item.enabled } : { lineId: selectedLineId.value ?? '', towerNo: '', sortIndex: '', towerType: '', enabled: true };
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

const towerColumns = computed(() => [
  { title: '顺序', key: 'sortIndex', width: 64 }, { title: '杆塔号', key: 'towerNo' },
  { title: '类型', key: 'towerType', render: (row: TransmissionTowerSummary) => row.towerType ?? '—' },
  { title: '状态', key: 'enabled', render: (row: TransmissionTowerSummary) => row.enabled ? '启用' : '停用' },
  ...(isAdmin.value ? [{ title: '操作', key: 'actions', width: 112, render: (row: TransmissionTowerSummary) => h(NSpace, { size: 4 }, { default: () => [
    h(NButton, { size: 'tiny', onClick: () => openTower(row) }, { default: () => '编辑' }),
    h(NButton, { size: 'tiny', disabled: saving.value, onClick: () => removeObject('towers', row) }, { default: () => '删除' }),
  ] }) }] : []),
]);

onMounted(loadAll);
</script>

<template>
  <div class="view-stack master-data-view">
    <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>
    <div class="master-hero">
      <div><span>基础台账</span><h2>统一维护电压等级、线路和杆塔</h2><p>先选电压等级，再选线路，查看并维护线路上的杆塔。</p></div>
      <n-tag :bordered="false" :type="isAdmin ? 'success' : 'default'">{{ isAdmin ? '管理员可维护' : '只读' }}</n-tag>
    </div>

    <nav class="master-breadcrumb" aria-label="台账层级">
      <button data-test="back-voltage" @click="mobileStep='voltage'">基础台账 / 电压等级</button>
      <template v-if="selectedVoltage"><span>/</span><button @click="mobileStep='lines'">{{ selectedVoltage.displayName }} · 线路</button></template>
      <template v-if="selectedLine"><span>/</span><button @click="mobileStep='towers'">{{ selectedLine.lineName }} · 杆塔清单</button></template>
    </nav>
    <div class="master-columns" data-test="master-columns" :data-step="mobileStep">
      <section class="master-panel voltage-panel">
        <header><div><small>01</small><h3>电压等级</h3></div><n-button v-if="isAdmin" size="small" @click="openVoltage()">新增电压等级</n-button></header>
        <div v-for="item in voltageLevels" :key="item.id" class="master-item" :class="{selected: selectedVoltageId===item.id}">
          <button class="master-select" :data-test="'select-voltage-'+item.id" :aria-pressed="selectedVoltageId===item.id" @click="selectVoltage(item.id)"><strong>{{ item.displayName }}</strong><span>{{ item.enabled ? '启用' : '停用' }}<b>›</b></span></button>
          <div v-if="isAdmin" class="item-actions"><n-button text size="tiny" @click="openVoltage(item)">编辑</n-button><n-button text size="tiny" :disabled="saving" @click="removeObject('voltage-levels', item)">删除</n-button></div>
        </div>
        <n-empty v-if="!voltageLevels.length" description="请先新增电压等级" />
      </section>
      <section class="master-panel line-panel">
        <header><div><small>02 · {{ selectedVoltage?.displayName ?? '请选择电压等级' }}</small><h3>线路</h3></div><n-button v-if="isAdmin" size="small" :disabled="!selectedVoltage?.enabled" @click="openLine()">新增线路</n-button></header>
        <div v-for="item in lines" :key="item.id" class="master-item" :class="{selected: selectedLineId===item.id}">
          <button class="master-select" :data-test="'select-line-'+item.id" :aria-pressed="selectedLineId===item.id" @click="selectLine(item.id)"><strong>{{ item.lineName }}</strong><span>{{ item.towerCount ?? 0 }} 基杆塔 · {{ item.enabled ? '启用' : '停用' }}<b>›</b></span></button>
          <div v-if="isAdmin" class="item-actions"><n-button text size="tiny" @click="openLine(item)">编辑</n-button><n-button text size="tiny" :disabled="saving" @click="removeObject('lines', item)">删除</n-button></div>
        </div>
        <n-empty v-if="!lines.length && !loading" description="当前电压等级下暂无线路" />
        <n-button v-if="lineCursor" :loading="loading" @click="loadLines(true)">加载更多线路</n-button>
      </section>
      <section class="master-panel tower-panel">
        <header><div><small>03 · {{ selectedLine?.lineName ?? '请选择线路' }}</small><h3>杆塔清单</h3></div></header>
        <n-space v-if="isAdmin && selectedLine" class="tower-actions"><n-button size="small" :disabled="!selectedLine.enabled || !selectedVoltage?.enabled" @click="openTower()">新增杆塔</n-button><n-button size="small" data-test="open-bulk-towers" :disabled="!selectedLine.enabled || !selectedVoltage?.enabled" @click="openBulk">批量维护</n-button></n-space>
        <n-data-table v-if="towers.length" :columns="towerColumns" :data="towers" :pagination="false" :scroll-x="420" />
        <n-empty v-else :description="selectedLine ? '当前线路下暂无杆塔' : '选择一条线路，查看杆塔清单'" />
        <n-button v-if="towerCursor" @click="loadTowers(true)">加载更多杆塔</n-button>
      </section>
    </div>
    <n-modal v-model:show="bulkModal" preset="card" title="批量维护杆塔" style="width:min(680px,calc(100vw - 32px))">
      <p>当前线路：{{ selectedLine?.lineName }}。从表格粘贴，每行依次为杆塔号、线路顺序、类型（可空）、启用/停用（可空）。每次最多 20 行。</p>
      <p>已加载的同号杆塔将更新，其余新增。未粘贴的杆塔保留。{{ towerCursor ? '还有未加载杆塔，请先加载对应记录再修改。' : '' }}</p>
      <n-button size="small" @click="bulkText=towers.slice(0,20).map(t => [t.towerNo,t.sortIndex,t.towerType ?? '',t.enabled ? '启用' : '停用'].join('\t')).join('\n')">填入已加载杆塔（最多 20 行）</n-button>
      <n-input v-model:value="bulkText" data-test="bulk-tower-text" type="textarea" :rows="10" placeholder="请粘贴杆塔号、顺序、类型、状态，例如从表格复制的四列数据" />
      <template #footer><div class="actions"><n-button @click="bulkModal=false">取消</n-button><n-button data-test="save-bulk-towers" type="primary" :loading="saving" @click="saveBulk">保存本批</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="voltageModal" preset="card" title="电压等级" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="显示名称"><n-input v-model:value="voltageForm.displayName" placeholder="例如：220kV、±800kV" /></n-form-item><n-form-item label="内部编码"><n-input v-model:value="voltageForm.code" placeholder="例如：AC_220KV" /></n-form-item><n-form-item label="制式"><n-select v-model:value="voltageForm.systemType" :options="systemOptions" /></n-form-item><n-form-item label="标称电压 kV"><n-input v-model:value="voltageForm.nominalKv" placeholder="请输入整数" /></n-form-item><n-form-item label="排序"><n-input v-model:value="voltageForm.sortOrder" placeholder="请输入排序号" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="voltageForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="voltageModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveVoltage">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="lineModal" preset="card" title="线路" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="电压等级"><n-select v-model:value="lineForm.voltageLevelId" :options="voltageOptions" /></n-form-item><n-form-item label="线路名称"><n-input v-model:value="lineForm.lineName" placeholder="请输入线路名称" /></n-form-item><n-form-item label="线路编码（可选）"><n-input v-model:value="lineForm.lineCode" placeholder="请输入线路编码" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="lineForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="lineModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveLine">保存</n-button></div></template>
    </n-modal>

    <n-modal v-model:show="towerModal" preset="card" title="杆塔" style="width:min(560px,calc(100vw - 32px))">
      <n-form label-placement="top"><n-form-item label="所属线路"><span>{{ selectedLine?.lineName }}</span></n-form-item><n-form-item label="杆塔号"><n-input v-model:value="towerForm.towerNo" placeholder="例如：#20" /></n-form-item><n-form-item label="线路顺序"><n-input v-model:value="towerForm.sortIndex" placeholder="例如：20" /></n-form-item><n-form-item label="杆塔类型（可选）"><n-input v-model:value="towerForm.towerType" placeholder="例如：角钢塔、钢管杆" /></n-form-item><n-form-item label="启用"><n-switch v-model:value="towerForm.enabled" /></n-form-item></n-form>
      <template #footer><div class="actions"><n-button @click="towerModal=false">取消</n-button><n-button type="primary" :loading="saving" @click="saveTower">保存</n-button></div></template>
    </n-modal>
  </div>
</template>

<style scoped>
.master-hero{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:20px 22px;border:1px solid #e4e9f1;border-radius:14px;background:linear-gradient(120deg,#fff,#f6f8fd)}
.master-hero span{color:#2457d6;font-size:11px;font-weight:700;letter-spacing:.08em}.master-hero h2{margin:4px 0 5px;font-size:21px}.master-hero p{margin:0;color:#7d8798;font-size:13px}.actions{display:flex;justify-content:flex-end;gap:10px}
@media(max-width:640px){.master-hero{align-items:flex-start;flex-direction:column;padding:16px}.master-hero h2{font-size:18px}}

.master-breadcrumb{display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:#7d8798}.master-breadcrumb button{border:0;background:transparent;color:#2457d6;cursor:pointer;padding:6px 0;font:inherit}
.master-columns{display:grid;grid-template-columns:minmax(210px,.8fr) minmax(240px,1fr) minmax(440px,1.8fr);gap:14px;align-items:start}
.master-panel{min-width:0;background:#fff;border:1px solid #e4e9f1;border-radius:14px;padding:16px;min-height:360px}
.master-panel header{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:16px}.master-panel h3{margin:4px 0 0;font-size:17px}.master-panel small{color:#7d8798}.master-item{border:1px solid #edf0f5;border-radius:10px;margin-bottom:8px;overflow:hidden}.master-item.selected{border-color:#84a5f5;background:#f0f5ff}.master-select{display:flex;flex-direction:column;text-align:left;width:100%;gap:7px;padding:12px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}.master-select strong{overflow-wrap:anywhere}.master-select span{font-size:12px;color:#7d8798;display:flex;justify-content:space-between}.master-select b{color:#2457d6}.item-actions{display:flex;gap:14px;padding:0 12px 10px}.tower-actions{margin-bottom:14px}
@media(max-width:1100px){.master-columns{grid-template-columns:minmax(180px,.8fr) minmax(200px,1fr) minmax(350px,1.5fr);gap:8px}.master-panel{padding:12px}}
@media(max-width:900px){.master-columns{display:block}.master-panel{display:none;min-height:260px}.master-columns[data-step="voltage"] .voltage-panel,.master-columns[data-step="lines"] .line-panel,.master-columns[data-step="towers"] .tower-panel{display:block}}
</style>
