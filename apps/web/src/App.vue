<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
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

const route = useRoute();
const router = useRouter();
const currentUser = ref<CurrentUser | null>(null);
const authError = ref('');
const loading = ref(true);

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
  authError.value = '';
  try {
    const response = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    const result = await response.json() as ApiResponse<CurrentUser>;
    if (!response.ok || !result.ok) {
      authError.value = result.ok ? '身份验证失败' : result.error.message;
      currentUser.value = null;
      return;
    }
    currentUser.value = result.data;
  } catch {
    authError.value = '无法连接身份接口，请确认 API 服务与数据库迁移已经启动。';
    currentUser.value = null;
  } finally {
    loading.value = false;
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
      <n-layout has-sider class="app-shell">
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
            <span>P1</span>
            <small>身份与基础配置</small>
          </div>
        </n-layout-sider>

        <n-layout>
          <n-layout-header bordered class="topbar">
            <div>
              <div class="page-kicker">输电项目全流程管理台</div>
              <h1>{{ pageTitle }}</h1>
            </div>
            <div v-if="currentUser" class="identity-card">
              <div>
                <strong>{{ currentUser.displayName }}</strong>
                <small>{{ currentUser.email }}</small>
              </div>
              <n-tag size="small" :bordered="false">{{ currentUser.role }}</n-tag>
            </div>
          </n-layout-header>

          <n-layout-content class="content-wrap">
            <n-spin :show="loading">
              <n-alert v-if="authError" type="error" title="身份未就绪" class="auth-alert">
                {{ authError }}
              </n-alert>
              <router-view v-else-if="currentUser" :current-user="currentUser" />
            </n-spin>
          </n-layout-content>
        </n-layout>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>
