import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

const push = vi.fn();
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({ name, inheritAttrs: false, setup(_, { slots, attrs }) { return () => vue.h('div', { ...attrs }, slots.default?.()); } });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { disabled: Boolean, loading: Boolean }, emits: ['click'], inheritAttrs: false,
    setup(props, { emit, slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.disabled || props.loading, onClick: () => emit('click') }, slots.default?.()); },
  });
  const NInput = vue.defineComponent({
    name: 'NInput', props: { value: { type: String, default: '' } }, emits: ['update:value'], inheritAttrs: false,
    setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value) }); },
  });
  const NDrawer = vue.defineComponent({
    name: 'NDrawer', props: { show: Boolean }, inheritAttrs: false,
    setup(props, { slots, attrs }) { return () => props.show ? vue.h('aside', { ...attrs }, slots.default?.()) : null; },
  });
  return {
    NButton, NDataTable: wrap('NDataTable'), NDrawer, NDrawerContent: wrap('NDrawerContent'), NEmpty: wrap('NEmpty'),
    NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NInput, NSpin: wrap('NSpin'), NTag: wrap('NTag'),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});

import ProjectsView from '../src/views/ProjectsView.vue';

const admin: CurrentUser = {
  id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};
const readonly: CurrentUser = { ...admin, id: 'readonly', username: 'readonly', role: 'readonly' };

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ProjectsView', () => {
  afterEach(() => { vi.unstubAllGlobals(); push.mockReset(); });

  it('creates a valid project without requiring demand or material rows', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'project-idem-1') });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/reserve-projects?limit=50') return ok({ items: [], nextCursor: null });
      if (url === '/api/reserve-projects' && init?.method === 'POST') return ok({ id: 'p-new', name: '新项目' }, 201);
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    }));

    const wrapper = mount(ProjectsView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="open-create-project"]').trigger('click');
    await wrapper.get('[data-test="project-name"]').setValue('新项目');
    await wrapper.get('[data-test="project-year"]').setValue('2026');
    await wrapper.get('[data-test="project-owner"]').setValue('张三');
    await wrapper.get('[data-test="save-project"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/reserve-projects' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({ name: '新项目', year: 2026, owner: '张三', demandIds: [] });
    expect(push).toHaveBeenCalledWith({ name: 'project-detail', params: { projectId: 'p-new' } });
  });

  it('does not expose project creation to readonly users', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ items: [], nextCursor: null })));
    const wrapper = mount(ProjectsView, { props: { currentUser: readonly } });
    await flushPromises();
    expect(wrapper.find('[data-test="open-create-project"]').exists()).toBe(false);
  });
});
