import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  deriveCredential: vi.fn(),
  createDerivedCredential: vi.fn(),
}));

vi.mock('../src/auth/credentials', () => ({
  normalizeUsername: (value: string) => value.trim().toLowerCase(),
  validatePasswordForClient: (value: string) => value.length < 15 ? '密码至少需要 15 个字符' : null,
  deriveCredential: authMocks.deriveCredential,
  createDerivedCredential: authMocks.createDerivedCredential,
}));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const NInput = vue.defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: { value: { type: String, default: '' }, type: String, placeholder: String },
    emits: ['update:value'],
    setup(props, { emit, attrs }) {
      return () => vue.h('input', {
        ...attrs,
        value: props.value,
        type: props.type ?? 'text',
        placeholder: props.placeholder,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      });
    },
  });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { disabled: Boolean, loading: Boolean }, emits: ['click'],
    setup(props, { emit, slots, attrs }) {
      return () => vue.h('button', { ...attrs, disabled: props.disabled || props.loading, onClick: () => emit('click') }, slots.default?.());
    },
  });
  const wrap = (name: string) => vue.defineComponent({
    name,
    setup(_, { slots }) { return () => vue.h('div', { 'data-stub': name }, slots.default?.()); },
  });
  const NAlert = vue.defineComponent({
    name: 'NAlert', setup(_, { slots }) { return () => vue.h('div', { role: 'alert' }, slots.default?.()); },
  });
  const NCard = vue.defineComponent({
    name: 'NCard', setup(_, { slots }) { return () => vue.h('section', slots.default?.()); },
  });
  const NForm = vue.defineComponent({
    name: 'NForm', setup(_, { slots }) { return () => vue.h('form', slots.default?.()); },
  });
  const NFormItem = vue.defineComponent({
    name: 'NFormItem', props: { label: String }, setup(props, { slots }) {
      return () => vue.h('label', { 'data-form-label': props.label }, [vue.h('span', props.label), slots.default?.()]);
    },
  });
  return { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpin: wrap('NSpin') };
});

import LoginView from '../src/views/LoginView.vue';

function response(ok: boolean, data: unknown, status = ok ? 200 : 401) {
  return new Response(JSON.stringify(ok ? { ok: true, data } : { ok: false, error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const kdf = {
  algorithm: 'argon2id-v1', salt: 'AAAAAAAAAAAAAAAAAAAAAA', memoryCostKiB: 19456,
  timeCost: 2, parallelism: 1, hashLength: 32,
};

describe('LoginView local account contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    authMocks.deriveCredential.mockReset().mockResolvedValue('derived-credential-value-12345678901234567890');
    authMocks.createDerivedCredential.mockReset();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') return response(true, { initialized: true });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses Chinese placeholders and explains the one-time bootstrap token on first initialization', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') return response(true, { initialized: false });
      throw new Error(`unexpected ${url}`);
    });

    const wrapper = mount(LoginView);
    await flushPromises();
    expect(wrapper.text()).toContain('初始化令牌仅用于首次创建系统管理员');
    expect(wrapper.get('[data-test="login-username"]').attributes('placeholder')).toBe('请输入管理员账号');
    expect(wrapper.get('[data-test="login-password"]').attributes('placeholder')).toBe('请输入密码');
    expect(wrapper.get('[data-test="bootstrap-confirm-password"]').attributes('placeholder')).toBe('请再次输入密码');
    expect(wrapper.get('[data-test="bootstrap-token"]').attributes('placeholder')).toBe('请输入一次性初始化令牌');
  });

  it('uses account and password only, with no email verification UI', async () => {
    const wrapper = mount(LoginView);
    await flushPromises();
    expect(wrapper.text()).toContain('账号');
    expect(wrapper.text()).toContain('密码');
    expect(wrapper.text()).toContain('忘记密码请联系管理员');
    expect(wrapper.text()).not.toContain('邮箱');
    expect(wrapper.get('[data-test="login-username"]').attributes('autocomplete')).toBe('username');
    expect(wrapper.get('[data-test="login-password"]').attributes('autocomplete')).toBe('current-password');
    expect(wrapper.get('[data-test="login-password"]').attributes('type')).toBe('password');
  });

  it('derives the credential in the browser and submits no plaintext password', async () => {
    const user = {
      id: 'm1', username: 'zhangsan', displayName: '张三', role: 'readonly', enabled: true, version: 1,
      scopes: [], invitedAt: null, firstLoginAt: null, lastLoginAt: null, lifecycleStatus: 'pending_first_login',
      mustChangePassword: true, authSource: 'session',
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') return response(true, { initialized: true });
      if (url === '/api/auth/kdf') return response(true, kdf);
      if (url === '/api/auth/login') return response(true, user);
      throw new Error(`unexpected ${url}`);
    });

    const wrapper = mount(LoginView);
    await flushPromises();
    await wrapper.get('[data-test="login-username"]').setValue(' ZhangSan ');
    await wrapper.get('[data-test="login-password"]').setValue('成员初始长口令-2026-安全');
    await wrapper.get('[data-test="login-submit"]').trigger('click');
    await flushPromises();

    expect(authMocks.deriveCredential).toHaveBeenCalledWith('成员初始长口令-2026-安全', kdf.salt);
    const loginCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/auth/login');
    expect(loginCall).toBeTruthy();
    const [, init] = loginCall!;
    expect(JSON.parse(String(init?.body))).toEqual({
      username: 'zhangsan',
      credential: 'derived-credential-value-12345678901234567890',
    });
    expect(String(init?.body)).not.toContain('成员初始长口令');
    expect(wrapper.emitted('authenticated')?.[0]?.[0]).toEqual(user);
  });

  it('shows the generic server authentication error without exposing account existence', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') return response(true, { initialized: true });
      if (url === '/api/auth/kdf') return response(true, kdf);
      if (url === '/api/auth/login') return response(false, { code: 'INVALID_CREDENTIALS', message: '账号或密码错误' }, 401);
      throw new Error(`unexpected ${url}`);
    });
    const wrapper = mount(LoginView);
    await flushPromises();
    await wrapper.get('[data-test="login-username"]').setValue('unknown');
    await wrapper.get('[data-test="login-password"]').setValue('错误但长度足够的登录口令-2026');
    await wrapper.get('[data-test="login-submit"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('账号或密码错误');
    expect(wrapper.text()).not.toContain('账号不存在');
  });
});
