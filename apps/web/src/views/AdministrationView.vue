<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui';
import type {
  ApiResponse,
  CreateMemberRequest,
  CurrentUser,
  MemberRole,
  MemberScope,
  MemberSummary,
  SettingVersion,
  UpdateMemberRequest,
} from '@tpm/shared';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const loading = ref(true);
const error = ref('');
const members = ref<MemberSummary[]>([]);
const settings = ref<SettingVersion[]>([]);
const modalOpen = ref(false);
const saving = ref(false);
const formError = ref('');
const editing = ref<MemberSummary | null>(null);
const scopeMode = ref<'all' | 'custom'>('all');
const scopeRows = ref<Array<{ type: 'framework' | 'project'; id: string }>>([]);
const memberForm = ref({
  displayName: '',
  email: '',
  role: 'readonly' as MemberRole,
  enabled: true,
});

const roleOptions = [
  { label: '管理员', value: 'admin' },
  { label: '项目管理', value: 'project_manager' },
  { label: '实施', value: 'implementation' },
  { label: '财务', value: 'finance' },
  { label: '只读', value: 'readonly' },
];
const scopeModeOptions = [
  { label: '全部业务范围', value: 'all' },
  { label: '仅指定框架 / 项目', value: 'custom' },
];
const scopeTypeOptions = [
  { label: '框架', value: 'framework' },
  { label: '项目', value: 'project' },
];
const roleLabel = new Map(roleOptions.map((item) => [item.value, item.label]));
const isAdminRole = computed(() => memberForm.value.role === 'admin');

function formatTime(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function statusLabel(row: MemberSummary) {
  if (row.lifecycleStatus === 'disabled') return '停用';
  if (row.lifecycleStatus === 'pending_first_login') return '待首次登录';
  return '正常';
}

function scopeLabel(row: MemberSummary) {
  if (row.scopes.some((scope) => scope.type === 'all')) return '全部';
  if (!row.scopes.length) return '未授权';
  const frameworks = row.scopes.filter((scope) => scope.type === 'framework').length;
  const projects = row.scopes.filter((scope) => scope.type === 'project').length;
  return [frameworks ? `${frameworks} 个框架` : '', projects ? `${projects} 个项目` : ''].filter(Boolean).join('、');
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await response.json() as ApiResponse<T>;
  if (!response.ok || !result.ok) {
    throw new Error(result.ok ? '请求失败' : result.error.message);
  }
  return result.data;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const settingsData = await apiRequest<{ items: SettingVersion[] }>('/api/settings');
    settings.value = settingsData.items;
    if (props.currentUser.role === 'admin') {
      const memberData = await apiRequest<{ items: MemberSummary[] }>('/api/members');
      members.value = memberData.items;
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取基础配置失败';
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  memberForm.value = { displayName: '', email: '', role: 'readonly', enabled: true };
  scopeMode.value = 'all';
  scopeRows.value = [];
  formError.value = '';
  modalOpen.value = true;
}

function openEdit(row: MemberSummary) {
  editing.value = row;
  memberForm.value = {
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    enabled: row.enabled,
  };
  const all = row.scopes.some((scope) => scope.type === 'all');
  scopeMode.value = all ? 'all' : 'custom';
  scopeRows.value = row.scopes
    .filter((scope): scope is MemberScope & { type: 'framework' | 'project'; id: string } => scope.type !== 'all' && Boolean(scope.id))
    .map((scope) => ({ type: scope.type, id: scope.id }));
  formError.value = '';
  modalOpen.value = true;
}

function addScope() {
  scopeRows.value.push({ type: 'project', id: '' });
}

function removeScope(index: number) {
  scopeRows.value.splice(index, 1);
}

function buildScopes(): MemberScope[] {
  if (isAdminRole.value || scopeMode.value === 'all') return [{ type: 'all', id: null }];
  return scopeRows.value
    .map((scope) => ({ type: scope.type, id: scope.id.trim() }))
    .filter((scope) => scope.id.length > 0);
}

async function saveMember() {
  formError.value = '';
  const displayName = memberForm.value.displayName.trim();
  const email = memberForm.value.email.trim().toLowerCase();
  if (!displayName) {
    formError.value = '请输入成员姓名。';
    return;
  }
  if (!editing.value && !email) {
    formError.value = '请输入成员邮箱。';
    return;
  }
  if (!isAdminRole.value && scopeMode.value === 'custom' && buildScopes().length === 0) {
    formError.value = '指定范围模式下至少填写一个框架或项目 ID。';
    return;
  }

  saving.value = true;
  try {
    const scopes = buildScopes();
    if (editing.value) {
      const body: UpdateMemberRequest = {
        expectedVersion: editing.value.version,
        displayName,
        role: memberForm.value.role,
        enabled: memberForm.value.enabled,
        scopes,
      };
      await apiRequest<MemberSummary>(`/api/members/${editing.value.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      message.success('成员信息已更新');
    } else {
      const body: CreateMemberRequest = {
        displayName,
        email,
        role: memberForm.value.role,
        enabled: memberForm.value.enabled,
        scopes,
      };
      await apiRequest<MemberSummary>('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      message.success('成员已添加，等待首次登录');
    }
    modalOpen.value = false;
    await load();
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : '保存失败';
  } finally {
    saving.value = false;
  }
}

async function toggleMember(row: MemberSummary) {
  try {
    await apiRequest<MemberSummary>(`/api/members/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ expectedVersion: row.version, enabled: !row.enabled }),
    });
    message.success(row.enabled ? '成员已停用' : '成员已恢复');
    await load();
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '操作失败');
  }
}

const memberColumns = [
  {
    title: '成员', key: 'displayName', minWidth: 150,
    render(row: MemberSummary) {
      return h('div', { class: 'member-cell' }, [h('strong', row.displayName), h('small', row.email)]);
    },
  },
  { title: '角色', key: 'role', width: 110, render: (row: MemberSummary) => roleLabel.get(row.role) ?? row.role },
  {
    title: '状态', key: 'status', width: 120,
    render(row: MemberSummary) {
      const type = row.lifecycleStatus === 'active' ? 'success' : row.lifecycleStatus === 'disabled' ? 'error' : 'warning';
      return h(NTag, { size: 'small', bordered: false, type }, { default: () => statusLabel(row) });
    },
  },
  { title: '授权范围', key: 'scopes', minWidth: 130, render: scopeLabel },
  { title: '最近登录', key: 'lastLoginAt', minWidth: 150, render: (row: MemberSummary) => formatTime(row.lastLoginAt) },
  {
    title: '操作', key: 'actions', width: 150,
    render(row: MemberSummary) {
      return h(NSpace, { size: 8 }, {
        default: () => [
          h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => '编辑' }),
          h(NButton, {
            size: 'small',
            type: row.enabled ? 'error' : 'success',
            secondary: true,
            onClick: () => void toggleMember(row),
          }, { default: () => row.enabled ? '停用' : '恢复' }),
        ],
      });
    },
  },
];

onMounted(load);
</script>

<template>
  <n-spin :show="loading">
    <div class="view-stack">
      <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>

      <n-card title="成员与权限">
        <template #header-extra>
          <n-button v-if="currentUser.role === 'admin'" type="primary" @click="openCreate">新增成员</n-button>
          <n-tag v-else :bordered="false">仅管理员可管理</n-tag>
        </template>

        <n-alert v-if="currentUser.role === 'admin'" type="info" :bordered="false" class="member-hint">
          Cloudflare Access 负责确认登录身份；这里决定成员是否准入、角色以及可访问的框架/项目。新增成员不创建系统密码。
        </n-alert>

        <n-data-table
          v-if="currentUser.role === 'admin'"
          :columns="memberColumns"
          :data="members"
          :pagination="false"
          :bordered="false"
          :scroll-x="900"
        />
        <n-empty v-else description="当前角色没有成员管理权限" />
      </n-card>

      <n-card title="基础配置">
        <template #header-extra><n-tag :bordered="false">版本化</n-tag></template>
        <n-descriptions v-if="settings.length" :column="1" bordered label-placement="left">
          <n-descriptions-item v-for="item in settings" :key="item.id" :label="item.key">
            <code>{{ JSON.stringify(item.value) }}</code>
            <span class="setting-version">v{{ item.version }}</span>
          </n-descriptions-item>
        </n-descriptions>
        <n-empty v-else description="暂无基础配置" />
      </n-card>
    </div>
  </n-spin>

  <n-modal
    v-model:show="modalOpen"
    preset="card"
    :title="editing ? '编辑成员' : '新增成员'"
    class="member-modal"
    :mask-closable="!saving"
  >
    <n-form label-placement="top">
      <n-alert v-if="formError" type="error" class="form-alert">{{ formError }}</n-alert>

      <div class="form-grid">
        <n-form-item label="姓名">
          <n-input v-model:value="memberForm.displayName" placeholder="例如：张三" maxlength="80" />
        </n-form-item>
        <n-form-item label="邮箱">
          <n-input v-model:value="memberForm.email" :disabled="Boolean(editing)" placeholder="name@example.com" />
        </n-form-item>
      </div>

      <div class="form-grid">
        <n-form-item label="角色">
          <n-select v-model:value="memberForm.role" :options="roleOptions" />
        </n-form-item>
        <n-form-item label="账号状态">
          <div class="switch-row">
            <n-switch v-model:value="memberForm.enabled" />
            <span>{{ memberForm.enabled ? '启用' : '停用' }}</span>
          </div>
        </n-form-item>
      </div>

      <n-form-item label="授权范围">
        <n-select
          v-model:value="scopeMode"
          :options="scopeModeOptions"
          :disabled="isAdminRole"
        />
      </n-form-item>
      <n-alert v-if="isAdminRole" type="info" :bordered="false" class="scope-note">
        管理员固定拥有全部业务范围；系统禁止停用或降权最后一个启用管理员。
      </n-alert>

      <div v-if="!isAdminRole && scopeMode === 'custom'" class="scope-editor">
        <div v-for="(scope, index) in scopeRows" :key="index" class="scope-row">
          <n-select v-model:value="scope.type" :options="scopeTypeOptions" class="scope-type" />
          <n-input v-model:value="scope.id" placeholder="框架或项目 ID" />
          <n-button tertiary type="error" @click="removeScope(index)">移除</n-button>
        </div>
        <n-button dashed block @click="addScope">+ 添加授权范围</n-button>
      </div>

      <div class="modal-actions">
        <n-button :disabled="saving" @click="modalOpen = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="saveMember">保存</n-button>
      </div>
    </n-form>
  </n-modal>
</template>

<style scoped>
.member-hint { margin-bottom: 16px; }
.member-cell { display: grid; gap: 2px; }
.member-cell small { color: #8a94a6; }
.form-alert { margin-bottom: 16px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.switch-row { min-height: 34px; display: flex; align-items: center; gap: 10px; }
.scope-note { margin: -8px 0 16px; }
.scope-editor { display: grid; gap: 10px; margin-bottom: 18px; }
.scope-row { display: grid; grid-template-columns: 120px 1fr auto; gap: 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
:global(.member-modal) { width: min(720px, calc(100vw - 32px)); }
@media (max-width: 700px) {
  .form-grid { grid-template-columns: 1fr; gap: 0; }
  .scope-row { grid-template-columns: 1fr; }
}
</style>
