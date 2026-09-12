<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpin } from 'naive-ui';
import type { ApiResponse, CredentialKdfDescriptor, CurrentUser } from '@tpm/shared';
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
  const result = await response.json() as ApiResponse<T>;
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
    <n-card class="login-card" :title="initialized === false ? '初始化系统管理员' : '登录输电项目管理台'">
      <n-spin :show="loading || initialized === null">
        <n-alert v-if="error" type="error" class="login-alert">{{ error }}</n-alert>

        <n-form v-if="initialized !== null" label-placement="top">
          <n-form-item v-if="initialized === false" label="管理员姓名">
            <n-input v-model:value="bootstrapDisplayName" autocomplete="name" />
          </n-form-item>
          <n-form-item label="账号">
            <n-input
              v-model:value="username"
              data-test="login-username"
              autocomplete="username"
              placeholder="例如：zhangsan"
            />
          </n-form-item>
          <n-form-item label="密码">
            <n-input
              v-model:value="password"
              data-test="login-password"
              type="password"
              show-password-on="mousedown"
              :autocomplete="initialized === false ? 'new-password' : 'current-password'"
              @keyup.enter="initialized === false ? bootstrap() : login()"
            />
          </n-form-item>

          <template v-if="initialized === false">
            <n-form-item label="确认密码">
              <n-input v-model:value="confirmPassword" type="password" autocomplete="new-password" />
            </n-form-item>
            <n-form-item label="初始化令牌">
              <n-input v-model:value="bootstrapToken" type="password" autocomplete="off" />
            </n-form-item>
            <n-button data-test="login-submit" type="primary" block :loading="loading" @click="bootstrap">
              创建首个管理员
            </n-button>
          </template>
          <template v-else>
            <n-button data-test="login-submit" type="primary" block :loading="loading" @click="login">
              登录
            </n-button>
            <p class="login-help">忘记密码请联系管理员重置。</p>
          </template>
        </n-form>
      </n-spin>
    </n-card>
  </div>
</template>
