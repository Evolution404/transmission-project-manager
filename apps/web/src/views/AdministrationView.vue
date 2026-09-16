<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui';
import type {
  CreateMemberRequest,
  CurrentUser,
  MemberRole,
  MemberScope,
  MemberSummary,
  SettingVersion,
  UpdateMemberRequest,
} from '@tpm/shared';
import { apiRequest, jsonRequestInit } from '../api/client';
import { createDerivedCredential, normalizeUsername, validatePasswordForClient } from '../auth/credentials';
import AppPressable from '../app/AppPressable.vue';
import ReserveClassificationPanel from '../features/settings/ReserveClassificationPanel.vue';
import SystemOperationsPanel from '../features/settings/SystemOperationsPanel.vue';

const props = defineProps<{ currentUser: CurrentUser }>();
const message = useMessage();
const loading = ref(true);
const error = ref('');
const members = ref<MemberSummary[]>([]);
const settings = ref<SettingVersion[]>([]);
const modalOpen = ref(false);
const resetModalOpen = ref(false);
const saving = ref(false);
const formError = ref('');
const resetError = ref('');
const editing = ref<MemberSummary | null>(null);
const resetTarget = ref<MemberSummary | null>(null);
const scopeMode = ref<'all' | 'custom'>('all');
const scopeRows = ref<Array<{ type: 'framework' | 'project'; id: string }>>([]);
const memberForm = ref({
  displayName: '',
  username: '',
  initialPassword: '',
  role: 'readonly' as MemberRole,
  enabled: true,
});
const resetPassword = ref('');
const resetPasswordConfirm = ref('');

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
  return row.mustChangePassword ? '待改密' : '正常';
}

function scopeLabel(row: MemberSummary) {
  if (row.scopes.some((scope) => scope.type === 'all')) return '全部';
  if (!row.scopes.length) return '未授权';
  const frameworks = row.scopes.filter((scope) => scope.type === 'framework').length;
  const projects = row.scopes.filter((scope) => scope.type === 'project').length;
  return [frameworks ? `${frameworks} 个框架` : '', projects ? `${projects} 个项目` : ''].filter(Boolean).join('、');
}

const settingMeta: Record<string, { label: string; description: string }> = {
  'business.timezone': { label: '业务时区', description: '日期、月报、提醒和业务截止日统一使用。' },
  'pagination.default': { label: '默认分页', description: '控制列表默认每页数量与服务端单页上限。' },
};

function settingLabel(item: SettingVersion) {
  return settingMeta[item.key]?.label ?? item.key;
}

function settingDescription(item: SettingVersion) {
  return settingMeta[item.key]?.description ?? '版本化系统配置。';
}

function settingValue(item: SettingVersion) {
  if (item.key === 'business.timezone') {
    const value = item.value as { timezone?: unknown };
    return typeof value.timezone === 'string' ? value.timezone : '未配置';
  }
  if (item.key === 'pagination.default') {
    const value = item.value as { defaultPageSize?: unknown; maxPageSize?: unknown };
    const defaultSize = typeof value.defaultPageSize === 'number' ? `${value.defaultPageSize} 条/页` : '默认值未配置';
    const maxSize = typeof value.maxPageSize === 'number' ? `上限 ${value.maxPageSize} 条` : '上限未配置';
    return `${defaultSize} · ${maxSize}`;
  }
  if (item.value && typeof item.value === 'object' && !Array.isArray(item.value)) {
    return Object.entries(item.value as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join('、') : String(value)}`)
      .join(' · ');
  }
  return String(item.value ?? '未配置');
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
  memberForm.value = { displayName: '', username: '', initialPassword: '', role: 'readonly', enabled: true };
  scopeMode.value = 'all';
  scopeRows.value = [];
  formError.value = '';
  modalOpen.value = true;
}

function openEdit(row: MemberSummary) {
  editing.value = row;
  memberForm.value = {
    displayName: row.displayName,
    username: row.username,
    initialPassword: '',
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

function openReset(row: MemberSummary) {
  resetTarget.value = row;
  resetPassword.value = '';
  resetPasswordConfirm.value = '';
  resetError.value = '';
  resetModalOpen.value = true;
}

function openResetFromEdit() {
  if (!editing.value) return;
  const target = editing.value;
  modalOpen.value = false;
  openReset(target);
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
  const username = normalizeUsername(memberForm.value.username);
  if (!displayName) {
    formError.value = '请输入成员姓名。';
    return;
  }
  if (!username) {
    formError.value = '账号需为 3-64 位字母、数字、点、横线或下划线。';
    return;
  }
  if (!editing.value) {
    const passwordError = validatePasswordForClient(memberForm.value.initialPassword);
    if (passwordError) {
      formError.value = passwordError;
      return;
    }
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
      await apiRequest<MemberSummary>(`/api/members/${editing.value.id}`, jsonRequestInit('PATCH', body));
      message.success('成员信息已更新');
    } else {
      const derived = await createDerivedCredential(memberForm.value.initialPassword);
      const body: CreateMemberRequest = {
        displayName,
        username,
        role: memberForm.value.role,
        enabled: memberForm.value.enabled,
        scopes,
        ...derived,
      };
      await apiRequest<MemberSummary>('/api/members', jsonRequestInit('POST', body));
      memberForm.value.initialPassword = '';
      message.success('账号已创建，首次登录必须修改密码');
    }
    modalOpen.value = false;
    await load();
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : '保存失败';
  } finally {
    saving.value = false;
  }
}

async function resetCredential() {
  resetError.value = '';
  if (!resetTarget.value) return;
  const passwordError = validatePasswordForClient(resetPassword.value);
  if (passwordError) {
    resetError.value = passwordError;
    return;
  }
  if (resetPassword.value !== resetPasswordConfirm.value) {
    resetError.value = '两次输入的新密码不一致。';
    return;
  }
  saving.value = true;
  try {
    const derived = await createDerivedCredential(resetPassword.value);
    await apiRequest<MemberSummary>(`/api/members/${resetTarget.value.id}/reset-password`, jsonRequestInit('POST', derived));
    resetPassword.value = '';
    resetPasswordConfirm.value = '';
    resetModalOpen.value = false;
    message.success('密码已重置，旧会话已失效');
    await load();
  } catch (cause) {
    resetError.value = cause instanceof Error ? cause.message : '重置密码失败';
  } finally {
    saving.value = false;
  }
}

const memberColumns = [
  {
    title: '成员', key: 'displayName', minWidth: 160,
    render(row: MemberSummary) {
      return h('div', { class: 'member-cell' }, [h('strong', row.displayName), h('small', row.username)]);
    },
  },
  { title: '角色', key: 'role', width: 110, render: (row: MemberSummary) => roleLabel.get(row.role) ?? '未知角色' },
  {
    title: '状态', key: 'status', width: 120,
    render(row: MemberSummary) {
      const type = row.lifecycleStatus === 'active' && !row.mustChangePassword ? 'success' : row.lifecycleStatus === 'disabled' ? 'error' : 'warning';
      return h(NTag, { size: 'small', bordered: false, type }, { default: () => statusLabel(row) });
    },
  },
  { title: '授权范围', key: 'scopes', minWidth: 130, render: scopeLabel },
  { title: '最近登录', key: 'lastLoginAt', minWidth: 150, render: (row: MemberSummary) => formatTime(row.lastLoginAt) },
  {
    title: '', key: 'actions', width: 90,
    render(row: MemberSummary) {
      return h(NButton, { size: 'small', quaternary: true, onClick: () => openEdit(row) }, { default: () => '管理' });
    },
  },
];

onMounted(load);
</script>

<template>
  <n-spin :show="loading">
    <div class="view-stack settings-view" data-test="settings-page">
      <n-alert v-if="error" type="error" title="读取失败">
        <div class="load-error-content"><span>{{ error }}</span><n-button size="small" secondary @click="load">重新加载</n-button></div>
      </n-alert>

      <header class="page-header">
        <div class="page-header-copy">
          <span class="page-eyebrow">系统设置</span>
          <h2 class="page-title">设置</h2>
          <p class="page-description">集中管理账号、权限与运行配置。业务数据维护仍在对应业务模块完成。</p>
        </div>
        <div class="page-actions">
          <n-button v-if="currentUser.role === 'admin'" type="primary" @click="openCreate">新增成员</n-button>
          <n-tag v-else :bordered="false">只读</n-tag>
        </div>
      </header>

      <section class="section-panel members-panel">
        <div class="section-panel-header">
          <div>
            <h3>账号与权限</h3>
            <p>系统自维护账号、角色与业务范围；成员密码不以明文发送到服务端。</p>
          </div>
          <span v-if="currentUser.role === 'admin'" class="section-count">{{ members.length }} 个成员</span>
        </div>
        <div class="section-panel-body">
          <template v-if="currentUser.role === 'admin'">
            <n-data-table
              v-if="members.length"
              class="desktop-member-table"
              :columns="memberColumns"
              :data="members"
              :pagination="false"
              :bordered="false"
              :scroll-x="820"
            />
            <div v-if="members.length" class="mobile-member-list" data-test="mobile-member-list">
              <app-pressable v-for="row in members" :key="row.id" class="member-mobile-row" @click="openEdit(row)">
                <span class="member-avatar">{{ row.displayName.slice(0, 1) }}</span>
                <span class="member-mobile-copy">
                  <strong>{{ row.displayName }}</strong>
                  <small>@{{ row.username }} · {{ roleLabel.get(row.role) ?? '未知角色' }} · {{ scopeLabel(row) }}</small>
                </span>
                <n-tag size="small" :bordered="false" :type="row.lifecycleStatus === 'active' && !row.mustChangePassword ? 'success' : row.lifecycleStatus === 'disabled' ? 'error' : 'warning'">{{ statusLabel(row) }}</n-tag>
              </app-pressable>
            </div>
            <n-empty v-else description="暂无成员账号" />
          </template>
          <n-empty v-else description="当前角色没有成员管理权限" />
        </div>
      </section>

      <section class="section-panel settings-panel">
        <div class="section-panel-header">
          <div>
            <h3>系统配置</h3>
            <p>当前生效的版本化运行参数。这里展示业务含义，不暴露底层数据结构。</p>
          </div>
          <n-tag :bordered="false">版本化</n-tag>
        </div>
        <div class="settings-list section-panel-body" v-if="settings.length">
          <div v-for="item in settings" :key="item.id" class="setting-row">
            <div class="setting-copy">
              <strong>{{ settingLabel(item) }}</strong>
              <small>{{ settingDescription(item) }}</small>
            </div>
            <div class="setting-value">
              <strong>{{ settingValue(item) }}</strong>
              <small>版本 {{ item.version }}</small>
            </div>
          </div>
        </div>
        <div v-else class="section-panel-body"><n-empty description="暂无基础配置" /></div>
      </section>

      <reserve-classification-panel v-if="currentUser.role === 'admin'" />
      <system-operations-panel v-if="currentUser.role === 'admin'" :members="members" />
    </div>
  </n-spin>

  <n-modal v-model:show="modalOpen" preset="card" :title="editing ? '编辑成员' : '新增成员'" class="member-modal" :mask-closable="!saving">
    <n-form label-placement="top">
      <n-alert v-if="formError" type="error" class="form-alert">{{ formError }}</n-alert>

      <div class="form-grid">
        <n-form-item label="姓名">
          <n-input v-model:value="memberForm.displayName" placeholder="例如：张三" maxlength="80" />
        </n-form-item>
        <n-form-item label="账号">
          <n-input v-model:value="memberForm.username" :disabled="Boolean(editing)" placeholder="例如：zhangsan" autocomplete="username" />
        </n-form-item>
      </div>

      <n-form-item v-if="!editing" label="初始密码">
        <n-input v-model:value="memberForm.initialPassword" type="password" autocomplete="new-password" placeholder="至少 15 个字符" />
      </n-form-item>

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
        <n-select v-model:value="scopeMode" :options="scopeModeOptions" :disabled="isAdminRole" />
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
        <n-button v-if="editing" secondary @click="openResetFromEdit">重置密码</n-button>
        <span class="modal-spacer"></span>
        <n-button :disabled="saving" @click="modalOpen = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="saveMember">保存</n-button>
      </div>
    </n-form>
  </n-modal>

  <n-modal v-model:show="resetModalOpen" preset="card" title="重置密码" class="member-modal" :mask-closable="!saving">
    <n-form label-placement="top">
      <n-alert v-if="resetError" type="error" class="form-alert">{{ resetError }}</n-alert>
      <n-alert type="warning" :bordered="false" class="form-alert">
        重置后该账号的所有旧会话立即失效，用户下次登录必须修改密码。
      </n-alert>
      <n-form-item label="新初始密码">
        <n-input v-model:value="resetPassword" type="password" autocomplete="new-password" />
      </n-form-item>
      <n-form-item label="确认新初始密码">
        <n-input v-model:value="resetPasswordConfirm" type="password" autocomplete="new-password" />
      </n-form-item>
      <div class="modal-actions">
        <n-button :disabled="saving" @click="resetModalOpen = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="resetCredential">确认重置</n-button>
      </div>
    </n-form>
  </n-modal>
</template>

<style scoped>
.settings-view { max-width: 1320px; }
.section-count { color: var(--ui-text-tertiary); font-size: 12px; white-space: nowrap; }
.mobile-member-list { display: none; }
.settings-list { padding: 0; }
.setting-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, auto);
  gap: 30px;
  align-items: center;
  min-height: 76px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--ui-border);
}
.setting-row:last-child { border-bottom: 0; }
.setting-copy, .setting-value { display: grid; gap: 4px; min-width: 0; }
.setting-copy strong, .setting-value strong { color: var(--ui-text); font-size: 13px; font-weight: 650; }
.setting-copy small, .setting-value small { color: var(--ui-text-tertiary); font-size: 11px; line-height: 1.5; }
.setting-value { text-align: right; }
.member-cell { display: grid; gap: 3px; }
.member-cell strong { font-size: 13px; font-weight: 650; }
.member-cell small { color: var(--ui-text-tertiary); font-size: 11px; }
.member-modal { width: min(640px, calc(100vw - 32px)); max-height: min(88vh, 780px); }
:deep(.member-modal .n-card__content) { overflow-y: auto; overscroll-behavior: contain; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }
.switch-row { display: flex; align-items: center; gap: 10px; min-height: 40px; color: var(--ui-text-secondary); font-size: 12px; }
.scope-note, .form-alert { margin-bottom: 14px; }
.scope-editor { display: grid; gap: 10px; margin: 4px 0 18px; }
.scope-row { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.modal-actions { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
.modal-spacer { flex: 1; }
@media (max-width: 767px) {
  .desktop-member-table { display: none; }
  .mobile-member-list { display: grid; margin: -18px; }
  .member-mobile-row {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    gap: 11px;
    align-items: center;
    min-height: 68px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--ui-border);
    background: transparent;
    color: inherit;
    text-align: left;
  }
  .member-mobile-row:last-child { border-bottom: 0; }
  .member-avatar { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--ui-surface-muted); color: var(--ui-text-secondary); font-size: 13px; font-weight: 700; }
  .member-mobile-copy { display: grid; gap: 3px; min-width: 0; }
  .member-mobile-copy strong { overflow: hidden; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .member-mobile-copy small { overflow: hidden; color: var(--ui-text-tertiary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .setting-row { grid-template-columns: 1fr; gap: 8px; min-height: 0; padding: 14px; }
  .setting-value { text-align: left; }
  .form-grid, .scope-row { grid-template-columns: 1fr; }
  .scope-row .n-button { width: 100%; justify-self: stretch; }
  .member-modal { width: calc(100vw - 20px); max-height: calc(100dvh - 20px); }
  .modal-actions { position: sticky; bottom: -1px; z-index: 2; flex-wrap: wrap; padding: 12px 0 max(10px, env(safe-area-inset-bottom)); background: var(--ui-surface); }
  .modal-actions .n-button:last-child { flex: 1; }
}
</style>
