<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NSpin } from 'naive-ui';
import type { ApiResponse, CredentialKdfDescriptor, CurrentUser } from '@tpm/shared';
import { parseApiResponse } from '../api/response';
import {
  createDerivedCredential,
  deriveCredential,
  normalizeUsername,
  validatePasswordForClient,
} from '../auth/credentials';

const emit = defineEmits<{ authenticated: [user: CurrentUser] }>();
const initialized = ref<boolean | null>(null);
const loading = ref(false);
const error = ref('');
const username = ref('');
const password = ref('');
const bootstrapDisplayName = ref('系统管理员');
const bootstrapToken = ref('');
const confirmPassword = ref('');

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) throw new Error(result.ok ? '请求失败' : result.error.message);
  return result.data;
}

async function loadStatus() {
  try {
    const data = await api<{ initialized: boolean }>('/api/auth/status');
    initialized.value = data.initialized;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取系统初始化状态';
    initialized.value = true;
  }
}

async function login() {
  error.value = '';
  const normalized = normalizeUsername(username.value);
  if (!normalized || !password.value) {
    error.value = '请输入账号和密码。';
    return;
  }
  loading.value = true;
  try {
    const kdf = await api<CredentialKdfDescriptor>('/api/auth/kdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: normalized }),
    });
    const credential = await deriveCredential(password.value, kdf.salt);
    const user = await api<CurrentUser>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: normalized, credential }),
    });
    password.value = '';
    emit('authenticated', user);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '登录失败';
  } finally {
    loading.value = false;
  }
}

async function bootstrap() {
  error.value = '';
  const normalized = normalizeUsername(username.value);
  const passwordError = validatePasswordForClient(password.value);
  if (!normalized) {
    error.value = '账号需为 3-64 位字母、数字、点、横线或下划线。';
    return;
  }
  if (!bootstrapDisplayName.value.trim()) {
    error.value = '请输入管理员姓名。';
    return;
  }
  if (passwordError) {
    error.value = passwordError;
    return;
  }
  if (password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致。';
    return;
  }
  if (!bootstrapToken.value.trim()) {
    error.value = '请输入初始化令牌。';
    return;
  }

  loading.value = true;
  try {
    const derived = await createDerivedCredential(password.value);
    const user = await api<CurrentUser>('/api/auth/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bootstrap-Token': bootstrapToken.value.trim(),
      },
      body: JSON.stringify({
        username: normalized,
        displayName: bootstrapDisplayName.value.trim(),
        ...derived,
      }),
    });
    password.value = '';
    confirmPassword.value = '';
    bootstrapToken.value = '';
    initialized.value = true;
    emit('authenticated', user);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '管理员初始化失败';
  } finally {
    loading.value = false;
  }
}

onMounted(loadStatus);
</script>

<template>
  <div class="login-page">
    <div class="auth-shell">
      <section class="auth-brand-panel">
        <div class="auth-brand-mark" aria-hidden="true"><span></span></div>
        <div class="auth-brand-copy">
          <span>TRANSMISSION PROJECTS</span>
          <h1>输电项目全流程管理</h1>
          <p>需求、储备、执行、资金和分析保持同一业务上下文，桌面与移动端使用同一套真实数据。</p>
        </div>
        <div class="auth-brand-foot">南京供电 · 内部业务系统</div>
      </section>

      <section class="auth-form-panel">
        <div class="auth-form-header">
          <span>{{ initialized === false ? 'SYSTEM SETUP' : 'ACCOUNT' }}</span>
          <h2>{{ initialized === false ? '初始化系统管理员' : '登录管理台' }}</h2>
          <p>{{ initialized === false ? '仅首次部署需要完成此步骤。' : '使用系统账号继续进入项目工作区。' }}</p>
        </div>
        <n-spin :show="loading || initialized === null">
          <n-alert v-if="error" type="error" class="login-alert">{{ error }}</n-alert>

          <n-form v-if="initialized !== null" label-placement="top" @submit.prevent="initialized === false ? bootstrap() : login()">
            <n-form-item v-if="initialized === false" label="管理员姓名">
              <n-input v-model:value="bootstrapDisplayName" autocomplete="name" />
            </n-form-item>
            <n-form-item label="账号">
              <n-input
                v-model:value="username"
                data-test="login-username"
                autocomplete="username"
                :input-props="{
                  id: 'username',
                  name: 'username',
                  autocomplete: 'username',
                  autocapitalize: 'none',
                  spellcheck: false,
                }"
                :placeholder="initialized === false ? '请输入管理员账号' : '请输入账号'"
              />
            </n-form-item>
            <n-form-item label="密码">
              <n-input
                v-model:value="password"
                data-test="login-password"
                type="password"
                show-password-on="mousedown"
                placeholder="请输入密码"
                :autocomplete="initialized === false ? 'new-password' : 'current-password'"
                :input-props="{
                  id: 'password',
                  name: 'password',
                  autocomplete: initialized === false ? 'new-password' : 'current-password',
                }"
              />
            </n-form-item>

            <template v-if="initialized === false">
              <n-form-item label="确认密码">
                <n-input
                  v-model:value="confirmPassword"
                  data-test="bootstrap-confirm-password"
                  type="password"
                  placeholder="请再次输入密码"
                  autocomplete="new-password"
                />
              </n-form-item>
              <n-form-item label="初始化令牌（仅首次使用）">
                <n-input
                  v-model:value="bootstrapToken"
                  data-test="bootstrap-token"
                  type="password"
                  placeholder="请输入一次性初始化令牌"
                  autocomplete="off"
                />
              </n-form-item>
              <p class="login-help">初始化令牌仅用于首次创建系统管理员，由部署方提供；创建成功后该入口自动关闭。</p>
              <n-button data-test="login-submit" type="primary" attr-type="submit" block :loading="loading">创建首个管理员</n-button>
            </template>
            <template v-else>
              <n-button data-test="login-submit" type="primary" attr-type="submit" block :loading="loading">登录</n-button>
            <p class="login-help">忘记密码请联系管理员重置。</p>
            </template>
          </n-form>
        </n-spin>
      </section>
    </div>
  </div>
</template>
