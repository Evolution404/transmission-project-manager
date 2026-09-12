import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

const authMocks = vi.hoisted(() => ({
  deriveCredential: vi.fn(),
  createDerivedCredential: vi.fn(),
}));

vi.mock('../src/auth/credentials', () => ({
  validatePasswordForClient: (value: string) => value.length < 15 ? '密码至少需要 15 个字符' : null,
  deriveCredential: authMocks.deriveCredential,
  createDerivedCredential: authMocks.createDerivedCredential,
}));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const NInput = vue.defineComponent({
    name: 'NInput', inheritAttrs: false,
    props: { value: { type: String, default: '' }, type: String }, emits: ['update:value'],
    setup(props, { emit, attrs }) {
      return () => vue.h('input', {
        ...attrs, value: props.value, type: props.type ?? 'text',
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      });
    },
  });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { loading: Boolean }, emits: ['click'],
    setup(props, { emit, slots, attrs }) {
      return () => vue.h('button', { ...attrs, disabled: props.loading, onClick: () => emit('click') }, slots.default?.());
    },
  });
  const wrap = (name: string) => vue.defineComponent({
    name, setup(_, { slots }) { return () => vue.h('div', slots.default?.()); },
  });
  const NFormItem = vue.defineComponent({
    name: 'NFormItem', props: { label: String }, setup(props, { slots }) {
      return () => vue.h('label', { 'data-form-label': props.label }, [vue.h('span', props.label), slots.default?.()]);
    },
  });
  return { NAlert: wrap('NAlert'), NButton, NCard: wrap('NCard'), NForm: wrap('NForm'), NFormItem, NInput };
});

import ChangePasswordView from '../src/views/ChangePasswordView.vue';

const user: CurrentUser = {
  id: 'u1', username: 'zhangsan', displayName: '张三', role: 'readonly', enabled: true, version: 1,
  scopes: [], invitedAt: null, firstLoginAt: null, lastLoginAt: null, lifecycleStatus: 'active',
  mustChangePassword: true, authSource: 'session',
};

const kdf = {
  algorithm: 'argon2id-v1', salt: 'AAAAAAAAAAAAAAAAAAAAAA', memoryCostKiB: 19456,
  timeCost: 2, parallelism: 1, hashLength: 32,
};

describe('ChangePasswordView contract', () => {
  beforeEach(() => {
    authMocks.deriveCredential.mockReset().mockResolvedValue('current-derived-credential-123456789012345');
    authMocks.createDerivedCredential.mockReset().mockResolvedValue({
      salt: 'BBBBBBBBBBBBBBBBBBBBBB', credential: 'next-derived-credential-123456789012345678',
    });
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requires current password, a long new password, and confirmation', () => {
    const wrapper = mount(ChangePasswordView, { props: { currentUser: user } });
    expect(wrapper.text()).toContain('首次登录必须修改密码');
    expect(wrapper.get('[data-test="current-password"]').attributes('type')).toBe('password');
    expect(wrapper.get('[data-test="new-password"]').attributes('type')).toBe('password');
    expect(wrapper.get('[data-test="confirm-password"]').attributes('type')).toBe('password');
  });

  it('blocks mismatched confirmation before sending the request', async () => {
    const fetchMock = vi.mocked(fetch);
    const wrapper = mount(ChangePasswordView, { props: { currentUser: user } });
    await wrapper.get('[data-test="current-password"]').setValue('成员初始长口令-2026-安全');
    await wrapper.get('[data-test="new-password"]').setValue('成员修改后的长口令-2026-安全');
    await wrapper.get('[data-test="confirm-password"]').setValue('不一致的长口令-2026-安全');
    await wrapper.get('[data-test="change-password-submit"]').trigger('click');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('两次输入的新密码不一致');
  });

  it('derives both credentials in the browser and sends no plaintext password', async () => {
    const refreshed = { ...user, mustChangePassword: false };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/kdf') {
        return new Response(JSON.stringify({ ok: true, data: kdf }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/auth/change-password') {
        return new Response(JSON.stringify({ ok: true, data: refreshed }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const wrapper = mount(ChangePasswordView, { props: { currentUser: user } });
    await wrapper.get('[data-test="current-password"]').setValue('成员初始长口令-2026-安全');
    await wrapper.get('[data-test="new-password"]').setValue('成员修改后的长口令-2026-安全');
    await wrapper.get('[data-test="confirm-password"]').setValue('成员修改后的长口令-2026-安全');
    await wrapper.get('[data-test="change-password-submit"]').trigger('click');
    await flushPromises();

    expect(authMocks.deriveCredential).toHaveBeenCalledWith('成员初始长口令-2026-安全', kdf.salt);
    expect(authMocks.createDerivedCredential).toHaveBeenCalledWith('成员修改后的长口令-2026-安全');
    const call = fetchMock.mock.calls.find(([input]) => String(input) === '/api/auth/change-password');
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call![1]?.body));
    expect(body).toEqual({
      currentCredential: 'current-derived-credential-123456789012345',
      next: { salt: 'BBBBBBBBBBBBBBBBBBBBBB', credential: 'next-derived-credential-123456789012345678' },
    });
    expect(JSON.stringify(body)).not.toContain('成员初始长口令');
    expect(JSON.stringify(body)).not.toContain('成员修改后的长口令');
    expect(wrapper.emitted('changed')?.[0]?.[0]).toEqual(refreshed);
  });
});
