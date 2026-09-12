<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NAlert, NCard, NDataTable, NDescriptions, NDescriptionsItem, NEmpty, NSpin, NTag } from 'naive-ui';
import type { ApiResponse, CurrentUser, MemberSummary, SettingVersion } from '@tpm/shared';

const props = defineProps<{ currentUser: CurrentUser }>();
const loading = ref(true);
const error = ref('');
const members = ref<MemberSummary[]>([]);
const settings = ref<SettingVersion[]>([]);

const memberColumns = [
  { title: '成员', key: 'displayName' },
  { title: '邮箱', key: 'email' },
  { title: '角色', key: 'role' },
  {
    title: '状态',
    key: 'enabled',
    render(row: MemberSummary) {
      return row.enabled ? '启用' : '停用';
    },
  },
  {
    title: '授权范围',
    key: 'scopes',
    render(row: MemberSummary) {
      if (row.scopes.some((scope) => scope.type === 'all')) return '全部';
      return row.scopes.length ? `${row.scopes.length} 项` : '未配置';
    },
  },
  { title: '版本', key: 'version' },
];

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const settingsResponse = await fetch('/api/settings');
    const settingsResult = await settingsResponse.json() as ApiResponse<{ items: SettingVersion[] }>;
    if (!settingsResponse.ok || !settingsResult.ok) {
      throw new Error(settingsResult.ok ? '配置读取失败' : settingsResult.error.message);
    }
    settings.value = settingsResult.data.items;

    if (props.currentUser.role === 'admin') {
      const membersResponse = await fetch('/api/members');
      const membersResult = await membersResponse.json() as ApiResponse<{ items: MemberSummary[] }>;
      if (!membersResponse.ok || !membersResult.ok) {
        throw new Error(membersResult.ok ? '成员读取失败' : membersResult.error.message);
      }
      members.value = membersResult.data.items;
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取基础配置失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <n-spin :show="loading">
    <div class="view-stack">
      <n-alert v-if="error" type="error" title="读取失败">{{ error }}</n-alert>

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

      <n-card title="成员与权限">
        <template #header-extra>
          <n-tag v-if="currentUser.role === 'admin'" type="success" :bordered="false">管理员可见</n-tag>
          <n-tag v-else :bordered="false">仅管理员可管理</n-tag>
        </template>
        <n-data-table
          v-if="currentUser.role === 'admin'"
          :columns="memberColumns"
          :data="members"
          :pagination="false"
          :bordered="false"
        />
        <n-empty v-else description="当前角色没有成员管理权限" />
      </n-card>
    </div>
  </n-spin>
</template>
