<script setup lang="ts">
import { ref } from 'vue';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput } from 'naive-ui';
import type { ApiResponse, CredentialKdfDescriptor, CurrentUser } from '@tpm/shared';
import { createDerivedCredential, deriveCredential, validatePasswordForClient } from '../auth/credentials';

const props = defineProps<{ currentUser: CurrentUser }>();
const emit = defineEmits<{ changed: [user: CurrentUser] }>();
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const saving = ref(false);
const error = ref('');

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await response.json() as ApiResponse<T>;
  if (!response.ok || !result.ok) throw new Error(result.ok ? '请求失败' : result.error.message);
  return result.data;
}

async function submit() {
  error.value = '';
  const passwordError = validatePasswordForClient(newPassword.value);
  if (!currentPassword.value) {
    error.value = '请输入当前密码。';
    return;
  }
  if (passwordError) {
    error.value = passwordError;
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的新密码不一致。';
    return;
  }

  saving.value = true;
  try {
    const kdf = await api<CredentialKdfDescriptor>('/api/auth/kdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: props.currentUser.username }),
    });
    const currentCredential = await deriveCredential(currentPassword.value, kdf.salt);
    const next = await createDerivedCredential(newPassword.value);
    const user = await api<CurrentUser>('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentCredential, next }),
    });
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    emit('changed', user);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '修改密码失败';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <n-card class="login-card" title="修改密码">
      <n-alert v-if="currentUser.mustChangePassword" type="warning" class="login-alert">
        首次登录必须修改密码，完成后才能进入业务页面。
      </n-alert>
      <n-alert v-if="error" type="error" class="login-alert">{{ error }}</n-alert>
      <n-form label-placement="top">
        <n-form-item label="当前密码">
          <n-input
            v-model:value="currentPassword"
            data-test="current-password"
            type="password"
            autocomplete="current-password"
          />
        </n-form-item>
        <n-form-item label="新密码">
          <n-input
            v-model:value="newPassword"
            data-test="new-password"
            type="password"
            autocomplete="new-password"
          />
        </n-form-item>
        <n-form-item label="确认新密码">
          <n-input
            v-model:value="confirmPassword"
            data-test="confirm-password"
            type="password"
            autocomplete="new-password"
          />
        </n-form-item>
        <n-button
          data-test="change-password-submit"
          type="primary"
          block
          :loading="saving"
          @click="submit"
        >
          保存新密码
        </n-button>
      </n-form>
    </n-card>
  </div>
</template>
