<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NConfigProvider,
  NDrawer,
  NDrawerContent,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
  NMessageProvider,
  NSpin,
  NTag,
  darkTheme,
  dateZhCN,
  zhCN,
  type GlobalThemeOverrides,
  type MenuOption,
} from 'naive-ui';
import type { ApiResponse, CurrentUser } from '@tpm/shared';
import { parseApiResponse } from './api/response';
import LoginView from './views/LoginView.vue';
import ChangePasswordView from './views/ChangePasswordView.vue';

const route = useRoute();
const router = useRouter();
const currentUser = ref<CurrentUser | null>(null);
const loading = ref(true);
const connectionError = ref('');
const loggingOut = ref(false);
const mobileMenuOpen = ref(false);
const prefersDark = ref(false);

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#2457d6',
    primaryColorHover: '#1f4fc5',
    primaryColorPressed: '#193fa0',
    borderRadius: '10px',
    borderRadiusSmall: '8px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
};

const roleLabels: Record<CurrentUser['role'], string> = {
  admin: '系统管理员',
  project_manager: '项目管理',
  implementation: '实施人员',
  finance: '财务人员',
  readonly: '只读用户',
};

const menuOptions: MenuOption[] = [
  {
    type: 'group', label: '工作', key: 'work', children: [
      { label: '工作台', key: '/' },
      { label: '需求', key: '/demands' },
      { label: '项目', key: '/projects' },
      { label: '执行任务', key: '/delivery' },
    ],
  },
  {
    type: 'group', label: '管理', key: 'management', children: [
      { label: '资金', key: '/finance' },
      { label: '分析', key: '/analysis' },
    ],
  },
  { label: '基础台账', key: '/master-data' },
  { label: '设置', key: '/administration' },
];

const activeKey = computed(() => {
  if (route.path.startsWith('/projects/')) return '/projects';
  return route.path;
});
const pageTitle = computed(() => String(route.meta.title ?? '输电项目全流程管理台'));
const naiveTheme = computed(() => prefersDark.value ? darkTheme : null);

async function loadIdentity() {
  loading.value = true;
  connectionError.value = '';
  try {
    const response = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    const result = await parseApiResponse<CurrentUser>(response);
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
  mobileMenuOpen.value = false;
  void router.push(key);
}

function navigateMobile(key: string) {
  if (key === 'more') {
    mobileMenuOpen.value = true;
    return;
  }
  navigate(key);
}

onMounted(() => {
  void loadIdentity();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  prefersDark.value = media.matches;
  media.addEventListener?.('change', (event) => { prefersDark.value = event.matches; });
});
</script>

<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme="naiveTheme" :theme-overrides="themeOverrides">
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
            <div class="brand-mark">TP</div>
            <div>
              <div class="brand-title">输电项目</div>
              <div class="brand-subtitle">全流程工作台</div>
            </div>
          </div>
          <n-menu
            :value="activeKey"
            :options="menuOptions"
            @update:value="navigate"
          />
          <div class="sidebar-account">
            <div class="account-avatar">{{ currentUser.displayName.slice(0, 1) }}</div>
            <div><strong>{{ currentUser.displayName }}</strong><small>{{ roleLabels[currentUser.role] }}</small></div>
          </div>
        </n-layout-sider>

        <n-layout>
          <n-layout-header class="topbar">
            <div class="topbar-title-wrap">
              <div>
                <div class="page-kicker">输电项目全流程</div>
                <h1>{{ pageTitle }}</h1>
              </div>
            </div>
            <div class="identity-card">
              <div>
                <strong>{{ currentUser.displayName }}</strong>
                <small>@{{ currentUser.username }}</small>
              </div>
              <n-button size="small" quaternary :loading="loggingOut" @click="logout">退出</n-button>
            </div>
          </n-layout-header>

          <n-layout-content class="content-wrap">
            <router-view :current-user="currentUser" />
          </n-layout-content>

          <nav class="mobile-bottom-nav" aria-label="手机主导航">
            <button :class="{ active: activeKey === '/' }" @click="navigateMobile('/')"><small>工作台</small></button>
            <button :class="{ active: activeKey === '/projects' }" @click="navigateMobile('/projects')"><small>项目</small></button>
            <button :class="{ active: activeKey === '/delivery' }" @click="navigateMobile('/delivery')"><small>任务</small></button>
            <button @click="navigateMobile('more')"><small>更多</small></button>
          </nav>

          <n-drawer v-model:show="mobileMenuOpen" placement="left" :width="280">
            <n-drawer-content title="项目全流程" closable>
              <div class="mobile-drawer-brand">
                <div class="brand-mark">TP</div>
                <div>
                  <strong>输电项目管理</strong>
                  <small>需求 · 储备 · 执行 · 结算</small>
                </div>
              </div>
              <n-menu
                :value="activeKey"
                :options="menuOptions"
                @update:value="navigate"
              />
            </n-drawer-content>
          </n-drawer>
        </n-layout>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>
