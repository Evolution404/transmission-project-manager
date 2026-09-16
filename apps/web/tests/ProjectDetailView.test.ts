import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

const push = vi.fn();
const replace = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { projectId: 'p1' }, query: {}, fullPath: '/projects/p1' }),
  useRouter: () => ({ push, replace }),
}));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({ name, inheritAttrs: false, setup(_, { slots, attrs }) { return () => vue.h('div', { ...attrs }, slots.default?.()); } });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { disabled: Boolean, loading: Boolean }, emits: ['click'], inheritAttrs: false,
    setup(props, { emit, slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.disabled || props.loading, onClick: () => emit('click') }, slots.default?.()); },
  });
  const NInput = vue.defineComponent({
    name: 'NInput', props: { value: { type: [String, Number], default: '' } }, emits: ['update:value'], inheritAttrs: false,
    setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value) }); },
  });
  const NModal = vue.defineComponent({
    name: 'NModal', props: { show: Boolean }, inheritAttrs: false,
    setup(props, { slots, attrs }) { return () => props.show ? vue.h('div', { ...attrs, 'data-stub': 'modal' }, slots.default?.()) : null; },
  });
  return {
    NAlert: wrap('NAlert'), NButton, NDatePicker: NInput, NEmpty: wrap('NEmpty'), NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NInput,
    NModal, NProgress: wrap('NProgress'), NSpin: wrap('NSpin'), NTag: wrap('NTag'),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});

import ProjectDetailView from '../src/views/ProjectDetailView.vue';

const admin: CurrentUser = {
  id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};
const readonly: CurrentUser = { ...admin, id: 'read', username: 'read', role: 'readonly' };

const project = {
  id: 'p1', name: '220kV 龙城线防断线治理', year: 2026, owner: '张三', status: 'confirmed' as const,
  reserveVersion: 2, frameworkId: null, version: 5,
  demandLinks: [{ id: 'link1', demandId: 'd1', sequenceNo: 'D-001', year: 2026, voltage: '220kV', lineName: '龙城线', section: '#001-#010', category: '防断线', owner: null, createdAt: '' }],
  materialRequirements: [{ id: 'pm1', projectId: 'p1', materialId: null, model: 'FXBW-110', unit: '套', requiredQuantityScaled: 1000000, unitPriceScaled: null, amountFen: null, reserveCategoryId: null, reserveCategory: null, version: 1, createdAt: '', updatedAt: '' }],
  knownMaterialAmountFen: 0, missingPriceCount: 1, materialPriceCompletenessBasisPoints: 0, createdAt: '', updatedAt: '',
};

function execution(released = false) {
  return { projectId: 'p1', projectVersion: released ? 6 : 5, released, tasks: [], demands: [], implementationComplete: false, settlementComplete: false, projectState: 'unimplemented_unsettled' as const };
}

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(options: { conflict?: boolean } = {}) {
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'release-idem-1') });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/reserve-projects/p1') return ok(project);
    if (url === '/api/projects/p1/execution') return ok(execution(false));
    if (url === '/api/project-releases' && init?.method === 'POST') {
      if (options.conflict) return new Response(JSON.stringify({ ok: false, error: { code: 'VERSION_CONFLICT', message: '项目已被修改' } }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      return ok({ id: 'release1' }, 201);
    }
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  }));
}

describe('ProjectDetailView project release', () => {
  afterEach(() => { vi.unstubAllGlobals(); push.mockReset(); replace.mockReset(); });

  it('confirms the one-time project release with current project version and no material release lines', async () => {
    installFetch();
    const wrapper = mount(ProjectDetailView, { props: { currentUser: admin } });
    await flushPromises();

    await wrapper.get('[data-test="open-project-release"]').trigger('click');
    expect(wrapper.text()).toContain('不是物资发货');
    expect(wrapper.get('[data-test="release-demand-count"]').text()).toBe('1 项');
    expect(wrapper.get('[data-test="release-material-count"]').text()).toBe('1 项');
    await wrapper.get('[data-test="release-note"]').setValue('准备进入执行');
    await wrapper.get('[data-test="confirm-project-release"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/project-releases' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(new Headers(call![1]!.headers).get('Idempotency-Key')).toBe('release-idem-1');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({ projectId: 'p1', expectedProjectVersion: 5, note: '准备进入执行' });
    expect(JSON.parse(String(call![1]!.body))).not.toHaveProperty('releaseLines');
  });

  it('keeps release confirmation open on a 409 instead of overwriting the newer project version', async () => {
    installFetch({ conflict: true });
    const wrapper = mount(ProjectDetailView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="open-project-release"]').trigger('click');
    await wrapper.get('[data-test="release-note"]').setValue('保留这段输入');
    await wrapper.get('[data-test="confirm-project-release"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('项目已被更新');
    expect(wrapper.get('[data-test="release-note"]').attributes('value')).toBe('保留这段输入');
    expect(wrapper.find('[data-test="reload-release-project"]').exists()).toBe(true);
  });

  it('hides project release mutation from readonly users', async () => {
    installFetch();
    const wrapper = mount(ProjectDetailView, { props: { currentUser: readonly } });
    await flushPromises();
    expect(wrapper.find('[data-test="open-project-release"]').exists()).toBe(false);
  });
});
