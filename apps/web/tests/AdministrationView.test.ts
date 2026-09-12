import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import type { CurrentUser, MemberSummary, SettingVersion } from '@tpm/shared';

const authMocks = vi.hoisted(() => ({ createDerivedCredential: vi.fn() }));
vi.mock('../src/auth/credentials', () => ({
  normalizeUsername: (value: string) => value.trim().toLowerCase(),
  validatePasswordForClient: (value: string) => value.length < 15 ? '密码至少需要 15 个字符' : null,
  createDerivedCredential: authMocks.createDerivedCredential,
}));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({
    name,
    setup(_, { slots }) { return () => vue.h('div', { 'data-stub': name }, slots.default?.()); },
  });
  const NButton = vue.defineComponent({
    name: 'NButton',
    props: { disabled: Boolean },
    emits: ['click'],
    setup(props, { emit, slots }) {
      return () => vue.h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.());
    },
  });
  const NInput = vue.defineComponent({
    name: 'NInput',
    props: { value: { type: String, default: '' }, disabled: Boolean, placeholder: String },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => vue.h('input', {
        value: props.value,
        disabled: props.disabled,
        placeholder: props.placeholder,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      });
    },
  });
  const NSelect = vue.defineComponent({
    name: 'NSelect',
    props: { value: String, options: { type: Array, default: () => [] }, disabled: Boolean },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => vue.h('select', {
        value: props.value,
        disabled: props.disabled,
        onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
      }, (props.options as Array<{ label: string; value: string }>).map((option) =>
        vue.h('option', { value: option.value }, option.label)));
    },
  });
  const NSwitch = vue.defineComponent({
    name: 'NSwitch',
    props: { value: Boolean },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => vue.h('input', {
        type: 'checkbox',
        checked: props.value,
        onChange: (event: Event) => emit('update:value', (event.target as HTMLInputElement).checked),
      });
    },
  });
  const NFormItem = vue.defineComponent({
    name: 'NFormItem',
    props: { label: String },
    setup(props, { slots }) {
      return () => vue.h('label', { 'data-form-label': props.label }, [vue.h('span', props.label), slots.default?.()]);
    },
  });
  const NModal = vue.defineComponent({
    name: 'NModal',
    props: { show: Boolean, title: String },
    emits: ['update:show'],
    setup(props, { slots }) {
      return () => props.show ? vue.h('section', { 'data-modal-title': props.title }, slots.default?.()) : null;
    },
  });
  const NDataTable = vue.defineComponent({
    name: 'NDataTable',
    props: { columns: { type: Array, default: () => [] }, data: { type: Array, default: () => [] } },
    setup(props) {
      return () => vue.h('div', { 'data-stub': 'NDataTable' }, (props.data as MemberSummary[]).map((row) =>
        vue.h('div', { 'data-row': row.username }, (props.columns as Array<{ key: string; render?: (row: MemberSummary) => unknown }>).map((column) =>
          vue.h('div', { 'data-cell': column.key }, column.render ? column.render(row) as never : String((row as never)[column.key] ?? ''))))));
    },
  });
  const NCard = vue.defineComponent({
    name: 'NCard',
    props: { title: String },
    setup(props, { slots }) {
      return () => vue.h('section', { 'data-card': props.title }, [slots['header-extra']?.(), slots.default?.()]);
    },
  });
  const NAlert = vue.defineComponent({
    name: 'NAlert',
    props: { title: String },
    setup(props, { slots }) { return () => vue.h('div', { role: 'alert' }, [props.title, slots.default?.()]); },
  });
  const NEmpty = vue.defineComponent({
    name: 'NEmpty',
    props: { description: String },
    setup(props) { return () => vue.h('div', props.description); },
  });
  const NTag = wrap('NTag');
  const NSpin = wrap('NSpin');
  const NForm = wrap('NForm');
  const NSpace = wrap('NSpace');
  const NDescriptions = wrap('NDescriptions');
  const NDescriptionsItem = vue.defineComponent({
    name: 'NDescriptionsItem',
    props: { label: String },
    setup(props, { slots }) { return () => vue.h('div', [vue.h('strong', props.label), slots.default?.()]); },
  });
  return {
    NAlert, NButton, NCard, NDataTable, NDescriptions, NDescriptionsItem, NEmpty,
    NForm, NFormItem, NInput, NModal, NSelect, NSpace, NSpin, NSwitch, NTag,
    useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  };
});

import AdministrationView from '../src/views/AdministrationView.vue';

const admin: CurrentUser = {
  id: 'admin-1',
  username: 'admin',
  displayName: '管理员',
  role: 'admin',
  enabled: true,
  version: 1,
  scopes: [{ type: 'all', id: null }],
  invitedAt: '2026-09-12T00:00:00.000Z',
  firstLoginAt: '2026-09-12T00:01:00.000Z',
  lastLoginAt: '2026-09-12T00:02:00.000Z',
  lifecycleStatus: 'active',
  mustChangePassword: false,
  authSource: 'session',
};

const readonlyUser: CurrentUser = { ...admin, id: 'readonly-1', username: 'readonly-user', role: 'readonly' };
const settings: SettingVersion[] = [{
  id: 'setting-1', key: 'business.timezone', version: 1, value: { timezone: 'Asia/Shanghai' },
  effectiveFrom: '2026-09-12T00:00:00.000Z', createdBy: null, createdAt: '2026-09-12T00:00:00.000Z',
}];

function member(overrides: Partial<MemberSummary> = {}): MemberSummary {
  return {
    id: 'member-1', username: 'member', displayName: '测试成员', role: 'readonly', enabled: true, version: 1,
    scopes: [{ type: 'all', id: null }], invitedAt: '2026-09-12T00:00:00.000Z', firstLoginAt: null, lastLoginAt: null,
    lifecycleStatus: 'pending_first_login', mustChangePassword: true, ...overrides,
  };
}

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

function fail(message: string, status = 422) {
  return new Response(JSON.stringify({ ok: false, error: { code: 'TEST_ERROR', message } }), { status, headers: { 'Content-Type': 'application/json' } });
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().trim() === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

describe('AdministrationView member management contract', () => {
  let members: MemberSummary[];
  let fetchMock: ReturnType<typeof vi.fn>;
  const writes: Array<{ url: string; method: string; body: unknown }> = [];

  beforeEach(() => {
    members = [member()];
    writes.length = 0;
    authMocks.createDerivedCredential.mockReset().mockResolvedValue({
      salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      credential: 'derived-credential-value-12345678901234567890',
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') return ok({ items: settings });
      if (url === '/api/members' && method === 'GET') return ok({ items: members });
      if (url === '/api/members' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        writes.push({ url, method, body });
        const created = member({ id: 'created-1', username: body.username, displayName: body.displayName, role: body.role, enabled: body.enabled, scopes: body.scopes, mustChangePassword: true });
        members = [...members, created];
        return ok(created);
      }
      if (url.startsWith('/api/members/') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        writes.push({ url, method, body });
        const existing = members.find((item) => url.endsWith(item.id));
        if (!existing) return fail('成员不存在', 404);
        const updated = { ...existing, ...body, version: existing.version + 1, scopes: body.scopes ?? existing.scopes };
        members = members.map((item) => item.id === existing.id ? updated : item);
        return ok(updated);
      }
      return fail(`unexpected request ${method} ${url}`, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000999' });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads settings and members for an administrator and exposes lifecycle status', async () => {
    const wrapper = mount(AdministrationView, { props: { currentUser: admin } });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith('/api/settings', undefined);
    expect(fetchMock).toHaveBeenCalledWith('/api/members', undefined);
    expect(wrapper.text()).toContain('新增成员');
    expect(wrapper.text()).toContain('待首次登录');
    expect(wrapper.text()).toContain('member');
  });

  it('does not fetch or expose member administration for a non-admin role', async () => {
    const wrapper = mount(AdministrationView, { props: { currentUser: readonlyUser } });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/settings', undefined);
    expect(wrapper.text()).not.toContain('新增成员');
    expect(wrapper.text()).toContain('当前角色没有成员管理权限');
  });

  it('creates a username/password account without requiring email and submits the default all scope', async () => {
    const wrapper = mount(AdministrationView, { props: { currentUser: admin } });
    await flushPromises();
    await buttonByText(wrapper, '新增成员').trigger('click');
    await wrapper.get('[data-form-label="姓名"] input').setValue(' 张三 ');
    await wrapper.get('[data-form-label="账号"] input').setValue(' ZhangSan ');
    await wrapper.get('[data-form-label="初始密码"] input').setValue('成员初始长口令-2026-安全');
    await buttonByText(wrapper, '保存').trigger('click');
    await flushPromises();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      url: '/api/members', method: 'POST', body: {
        displayName: '张三', username: 'zhangsan',
        salt: 'AAAAAAAAAAAAAAAAAAAAAA', credential: 'derived-credential-value-12345678901234567890',
        role: 'readonly', enabled: true, scopes: [{ type: 'all', id: null }],
      },
    });
    expect(wrapper.text()).toContain('zhangsan');
    expect(wrapper.text()).not.toContain('邮箱');
  });

  it('blocks an empty custom scope before any member write request is sent', async () => {
    const wrapper = mount(AdministrationView, { props: { currentUser: admin } });
    await flushPromises();
    await buttonByText(wrapper, '新增成员').trigger('click');
    await wrapper.get('[data-form-label="姓名"] input').setValue('范围测试');
    await wrapper.get('[data-form-label="账号"] input').setValue('scope-user');
    await wrapper.get('[data-form-label="初始密码"] input').setValue('范围测试初始长口令-2026-安全');
    await wrapper.get('[data-form-label="授权范围"] select').setValue('custom');
    await buttonByText(wrapper, '保存').trigger('click');
    await flushPromises();

    expect(writes).toHaveLength(0);
    expect(wrapper.text()).toContain('指定范围模式下至少填写一个框架或项目 ID');
  });

  it('preserves an existing custom scope and version when editing a member', async () => {
    members = [member({
      id: 'project-member', role: 'project_manager', version: 4,
      scopes: [{ type: 'project', id: 'project-42' }],
    })];
    const wrapper = mount(AdministrationView, { props: { currentUser: admin } });
    await flushPromises();
    await buttonByText(wrapper, '编辑').trigger('click');
    await wrapper.get('[data-form-label="姓名"] input').setValue('改名成员');
    await buttonByText(wrapper, '保存').trigger('click');
    await flushPromises();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      url: '/api/members/project-member', method: 'PATCH', body: {
        expectedVersion: 4,
        displayName: '改名成员',
        role: 'project_manager',
        enabled: true,
        scopes: [{ type: 'project', id: 'project-42' }],
      },
    });
  });
});
