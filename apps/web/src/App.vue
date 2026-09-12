<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NConfigProvider,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
  NMessageProvider,
  NSpin,
  NTag,
  type MenuOption,
} from 'naive-ui';
import type { ApiResponse, CurrentUser } from '@tpm/shared';
import LoginView from './views/LoginView.vue';
import ChangePasswordView from './views/ChangePasswordView.vue';

const route = useRoute();
const router = useRouter();
const currentUser = ref<CurrentUser | null>(null);
const loading = ref(true);
const connectionError = ref('');
const loggingOut = ref(false);

const menuOptions: MenuOption[] = [
  { label: '总览', key: '/' },
  { label: '项目需求', key: '/demands' },
  { label: '储备出库', key: '/reserves' },
  { label: '实施结算', key: '/delivery' },
  { label: '框架费用', key: '/finance' },
  { label: '储备分析', key: '/analysis' },
  { label: '规则与成员', key: '/administration' },
];

const activeKey = computed(() => route.path);
const pageTitle = computed(() => String(route.meta.title ?? '输电项目全流程管理台'));

async function loadIdentity() {
  loading.value = true;
  connectionError.value = '';
  try {
    const response = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    const result = await response.json() as ApiResponse<CurrentUser>;
    if (!response.ok || !result.ok) {
      if (response.status === 401 || response.status === 403) {
        currentUser.value = null;
      } else {
        connectionError.value = result.ok ? '读取登录状态失败' : result.error.message;
      }
      return;
    }
    currentUser.value = result.data;
  } catch {
    connectionError.value = '无法连接系统接口，请确认本地 API 服务已经启动。';
  } finally {
    loading.value = false;
  }
}

function authenticated(user: CurrentUser) {
  connectionError.value = '';
  currentUser.value = user;
}

function passwordChanged(user: CurrentUser) {
  currentUser.value = user;
  if (route.path === '/administration' && user.role !== 'admin') void router.push('/');
}

async function logout() {
  loggingOut.value = true;
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } finally {
    currentUser.value = null;
    loggingOut.value = false;
    if (route.path !== '/') void router.push('/');
  }
}

function navigate(key: string) {
  void router.push(key);
}

onMounted(loadIdentity);
</script>

<template>
  <n-config-provider>
    <n-message-provider>
      <div v-if="loading" class="auth-loading">
        <n-spin size="large" />
      </div>

      <div v-else-if="connectionError && !currentUser" class="auth-loading">
        <n-alert type="error" title="系统接口不可用" class="auth-alert">
          {{ connectionError }}
          <div class="auth-retry"><n-button size="small" @click="loadIdentity">重新连接</n-button></div>
        </n-alert>
      </div>

      <login-view
        v-else-if="!currentUser"
        @authenticated="authenticated"
      />

      <change-password-view
        v-else-if="currentUser.mustChangePassword"
        :current-user="currentUser"
        @changed="passwordChanged"
      />

      <n-layout v-else has-sider class="app-shell">
        <n-layout-sider
          bordered
          collapse-mode="width"
          :collapsed-width="64"
          :width="224"
          class="app-sider"
        >
          <div class="brand-block">
            <div class="brand-mark">输</div>
            <div>
              <div class="brand-title">项目管理</div>
              <div class="brand-subtitle">全流程管理台</div>
            </div>
          </div>
          <n-menu
            :value="activeKey"
            :options="menuOptions"
            @update:value="navigate"
          />
          <div class="phase-badge">
            <span>P1.2</span>
            <small>本地账号与会话</small>
          </div>
        </n-layout-sider>

        <n-layout>
          <n-layout-header bordered class="topbar">
            <div>
              <div class="page-kicker">输电项目全流程管理台</div>
              <h1>{{ pageTitle }}</h1>
            </div>
            <div class="identity-card">
              <div>
                <strong>{{ currentUser.displayName }}</strong>
                <small>@{{ currentUser.username }}</small>
              </div>
              <n-tag size="small" :bordered="false">{{ currentUser.role }}</n-tag>
              <n-button size="small" quaternary :loading="loggingOut" @click="logout">退出</n-button>
            </div>
          </n-layout-header>

          <n-layout-content class="content-wrap">
            <router-view :current-user="currentUser" />
          </n-layout-content>
        </n-layout>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>
