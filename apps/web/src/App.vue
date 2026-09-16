<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NConfigProvider,
  NDrawer,
  NDrawerContent,
  NMessageProvider,
  NSpin,
  darkTheme,
  dateZhCN,
  zhCN,
  type GlobalThemeOverrides,
} from 'naive-ui';
import type { ApiResponse, CurrentUser } from '@tpm/shared';
import { parseApiResponse } from './api/response';
import LoginView from './views/LoginView.vue';
import ChangePasswordView from './views/ChangePasswordView.vue';
import AppIcon from './app/AppIcon.vue';
import AppPressable from './app/AppPressable.vue';
import BrandLockup from './brand/BrandLockup.vue';
import { BRAND_SUBTITLE } from './brand/brand';

const route = useRoute();
const router = useRouter();
const currentUser = ref<CurrentUser | null>(null);
const loading = ref(true);
const connectionError = ref('');
const loggingOut = ref(false);
const mobileMenuOpen = ref(false);
const prefersDark = ref(false);

const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: {
    primaryColor: prefersDark.value ? '#7aa7ff' : '#2563eb',
    primaryColorHover: prefersDark.value ? '#96b9ff' : '#1d4ed8',
    primaryColorPressed: prefersDark.value ? '#638fe8' : '#1e40af',
    primaryColorSuppl: prefersDark.value ? '#84adff' : '#3b82f6',
    borderRadius: '12px',
    borderRadiusSmall: '9px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  Button: { heightMedium: '38px', heightSmall: '32px', borderRadiusMedium: '10px', borderRadiusSmall: '9px' },
  Input: { heightMedium: '40px', borderRadius: '10px' },
  Select: { peers: { InternalSelection: { heightMedium: '40px', borderRadius: '10px' } } },
  Card: { borderRadius: '14px' },
  DataTable: prefersDark.value
    ? { thColor: '#1b212a', thColorHover: '#1f2732', tdColorHover: '#1b222c' }
    : { thColor: '#f8fafc', thColorHover: '#f8fafc', tdColorHover: '#f8fafc' },
}));

const roleLabels: Record<CurrentUser['role'], string> = {
  admin: '系统管理员',
  project_manager: '项目管理',
  implementation: '实施人员',
  finance: '财务人员',
  readonly: '只读用户',
};

type NavIcon = 'workspace' | 'demands' | 'projects' | 'tasks' | 'finance' | 'analysis' | 'master' | 'settings';
type NavItem = { label: string; key: string; icon: NavIcon };
const workNav: NavItem[] = [
  { label: '工作台', key: '/', icon: 'workspace' },
  { label: '需求', key: '/demands', icon: 'demands' },
  { label: '项目', key: '/projects', icon: 'projects' },
  { label: '执行任务', key: '/tasks', icon: 'tasks' },
];
const managementNav: NavItem[] = [
  { label: '资金', key: '/finance', icon: 'finance' },
  { label: '分析', key: '/analysis', icon: 'analysis' },
  { label: '基础台账', key: '/master-data', icon: 'master' },
];
const systemNav: NavItem[] = [
  { label: '设置', key: '/administration', icon: 'settings' },
];

const activeKey = computed(() => String(route.meta.navKey ?? route.path));
const moreNavKeys = new Set(['/demands', '/finance', '/analysis', '/master-data', '/administration']);
const mobileMoreActive = computed(() => mobileMenuOpen.value || moreNavKeys.has(activeKey.value));
const pageTitle = computed(() => String(route.meta.title ?? BRAND_SUBTITLE));
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

      <div v-else class="app-shell">
        <aside class="app-sider" aria-label="主导航">
          <app-pressable class="brand-block" aria-label="返回工作台" @click="navigate('/')">
            <BrandLockup :icon-size="52" />
          </app-pressable>

          <div class="nav-scroll">
            <section class="nav-section">
              <span class="nav-section-label">业务</span>
              <app-pressable
                v-for="item in workNav"
                :key="item.key"
                class="nav-item"
                :class="{ active: activeKey === item.key }"
                :title="item.label"
                :aria-current="activeKey === item.key ? 'page' : undefined"
                @click="navigate(item.key)"
              >
                <app-icon :name="item.icon" />
                <span>{{ item.label }}</span>
              </app-pressable>
            </section>
            <section class="nav-section">
              <span class="nav-section-label">管理</span>
              <app-pressable
                v-for="item in managementNav"
                :key="item.key"
                class="nav-item"
                :class="{ active: activeKey === item.key }"
                :title="item.label"
                :aria-current="activeKey === item.key ? 'page' : undefined"
                @click="navigate(item.key)"
              >
                <app-icon :name="item.icon" />
                <span>{{ item.label }}</span>
              </app-pressable>
            </section>
          </div>

          <div class="nav-bottom">
            <span class="nav-section-label nav-bottom-label">系统</span>
            <app-pressable
              v-for="item in systemNav"
              :key="item.key"
              class="nav-item"
              :class="{ active: activeKey === item.key }"
              :title="item.label"
              :aria-current="activeKey === item.key ? 'page' : undefined"
              @click="navigate(item.key)"
            >
              <app-icon :name="item.icon" />
              <span>{{ item.label }}</span>
            </app-pressable>
            <div class="sidebar-account">
              <div class="account-avatar">{{ currentUser.displayName.slice(0, 1) }}</div>
              <div class="account-copy"><strong>{{ currentUser.displayName }}</strong><small>{{ roleLabels[currentUser.role] }}</small></div>
            </div>
          </div>
        </aside>

        <div class="app-stage">
          <header class="topbar">
            <div class="topbar-context">
              <span class="topbar-product">项目管理台</span>
              <span class="topbar-divider" aria-hidden="true"></span>
              <strong>{{ pageTitle }}</strong>
            </div>
            <div class="identity-card">
              <div class="identity-copy">
                <strong>{{ currentUser.displayName }}</strong>
                <small>@{{ currentUser.username }}</small>
              </div>
              <n-button circle quaternary size="small" :loading="loggingOut" aria-label="退出登录" title="退出登录" @click="logout">
                <template #icon><app-icon name="logout" :size="18" /></template>
              </n-button>
            </div>
          </header>

          <main class="content-wrap">
            <router-view :current-user="currentUser" />
          </main>

          <nav class="mobile-bottom-nav" aria-label="手机主导航">
            <app-pressable :class="{ active: activeKey === '/' }" :aria-current="activeKey === '/' ? 'page' : undefined" @click="navigateMobile('/')"><app-icon name="workspace" /><small>工作台</small></app-pressable>
            <app-pressable :class="{ active: activeKey === '/projects' }" :aria-current="activeKey === '/projects' ? 'page' : undefined" @click="navigateMobile('/projects')"><app-icon name="projects" /><small>项目</small></app-pressable>
            <app-pressable :class="{ active: activeKey === '/tasks' }" :aria-current="activeKey === '/tasks' ? 'page' : undefined" @click="navigateMobile('/tasks')"><app-icon name="tasks" /><small>任务</small></app-pressable>
            <app-pressable :class="{ active: mobileMoreActive }" :aria-current="moreNavKeys.has(activeKey) ? 'page' : undefined" @click="navigateMobile('more')"><app-icon name="more" /><small>更多</small></app-pressable>
          </nav>

          <n-drawer v-model:show="mobileMenuOpen" placement="bottom" height="auto" class="mobile-more-drawer">
            <n-drawer-content title="更多" closable>
              <div class="mobile-more-grid">
                <app-pressable v-for="item in [...workNav.slice(1, 2), ...managementNav, ...systemNav]" :key="item.key" :class="{ active: activeKey === item.key }" :aria-current="activeKey === item.key ? 'page' : undefined" @click="navigate(item.key)">
                  <span class="mobile-more-icon"><app-icon :name="item.icon" /></span>
                  <span>{{ item.label }}</span>
                  <app-icon name="chevron" :size="16" class="mobile-more-chevron" />
                </app-pressable>
              </div>
              <div class="mobile-account-row">
                <div class="account-avatar">{{ currentUser.displayName.slice(0, 1) }}</div>
                <div><strong>{{ currentUser.displayName }}</strong><small>{{ roleLabels[currentUser.role] }} · @{{ currentUser.username }}</small></div>
                <n-button quaternary size="small" :loading="loggingOut" @click="logout">退出</n-button>
              </div>
            </n-drawer-content>
          </n-drawer>
        </div>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>
