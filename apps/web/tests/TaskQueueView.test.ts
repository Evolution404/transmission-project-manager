import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser, TaskQueuePage } from '@tpm/shared';

const push = vi.fn();
const replace = vi.fn();
const routeQuery = vi.hoisted(() => ({} as Record<string, string>));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery, fullPath: '/tasks' }), useRouter: () => ({ push, replace }) }));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({ name, props: { show: Boolean, description: String }, setup(_, { slots }) { return () => vue.h('div', { 'data-stub': name }, slots.default?.()); } });
  const NButton = vue.defineComponent({ name: 'NButton', props: { loading: Boolean, disabled: Boolean }, emits: ['click'], inheritAttrs: false, setup(props, { emit, slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.loading || props.disabled, onClick: () => emit('click') }, slots.default?.()); } });
  const NInput = vue.defineComponent({ name: 'NInput', props: { value: String }, emits: ['update:value'], inheritAttrs: false, setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value) }); } });
  const NSelect = vue.defineComponent({ name: 'NSelect', props: { value: String, options: Array }, emits: ['update:value'], inheritAttrs: false, setup(props, { emit, attrs }) { return () => vue.h('select', { ...attrs, value: props.value, onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value) }, (props.options as Array<{ label: string; value: string }> ?? []).map((item) => vue.h('option', { value: item.value }, item.label))); } });
  const NProgress = vue.defineComponent({ name: 'NProgress', props: { percentage: Number }, setup(props) { return () => vue.h('span', `${props.percentage ?? 0}%`); } });
  return { NButton, NEmpty: wrap('NEmpty'), NInput, NProgress, NSelect, NSpin: wrap('NSpin'), NTag: wrap('NTag') };
});

import TaskQueueView from '../src/views/TaskQueueView.vue';

const user: CurrentUser = {
  id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};

const page: TaskQueuePage = {
  items: [{
    id: 't1', projectId: 'p1', projectName: '220kV 龙城线治理', projectYear: 2026, projectOwner: '张三',
    name: '龙城线 #001-#010 更换任务', scopeText: '#001-#010', owner: '李四', plannedDate: '2026-09-20',
    plannedQuantityScaled: 1000000, unit: '项',
    supplyTotals: [
      { taskMaterialRequirementId: 'm1', model: 'FXBW-110', unit: '套', totals: { reportedQuantityScaled: 600000, shippedQuantityScaled: 400000, arrivedQuantityScaled: 200000 } },
      { taskMaterialRequirementId: 'm2', model: '导线', unit: '米', totals: { reportedQuantityScaled: 1000000, shippedQuantityScaled: 1000000, arrivedQuantityScaled: 500000 } },
    ],
    implementedQuantityScaled: 300000, settledQuantityScaled: 100000, implementationComplete: false, settlementComplete: false,
    state: 'unimplemented_unsettled', settlementReminder: { needed: true, firstImplementationDate: '2026-09-15', dueDate: '2026-10-15', finalSettlementId: null },
    createdAt: '', updatedAt: '',
  }],
  nextCursor: 'next-1',
};

function ok(data: unknown) { return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }

describe('TaskQueueView', () => {
  afterEach(() => {
    vi.unstubAllGlobals(); push.mockReset(); replace.mockReset();
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
  });

  it('renders one cross-project task row with independent supply, implementation and settlement facts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(page)));
    const wrapper = mount(TaskQueueView, { props: { currentUser: user } });
    await flushPromises();
    expect(wrapper.text()).toContain('220kV 龙城线治理');
    expect(wrapper.text()).toContain('龙城线 #001-#010 更换任务');
    expect(wrapper.text()).toContain('实施 30%');
    expect(wrapper.text()).toContain('结算 10%');
    expect(wrapper.text()).toContain('FXBW-110 · 到货 20 套');
    expect(wrapper.text()).toContain('导线 · 到货 50 米');
    expect(wrapper.text()).not.toContain('到货 70');
    expect(wrapper.get('[data-test="mobile-open-task-t1"]').text()).toContain('未实施未结算');
    await wrapper.get('[data-test="open-task-t1"]').trigger('click');
    expect(push).toHaveBeenCalledWith({ path: '/projects/p1/tasks/t1', query: { from: '/tasks' } });
  });

  it('sends status filtering to the server and resets the cursor-backed list', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ok({ items: [], nextCursor: null } satisfies TaskQueuePage));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(TaskQueueView, { props: { currentUser: user } });
    await flushPromises();
    await wrapper.get('[data-test="task-status-filter"]').setValue('implementation_pending');
    await flushPromises();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=implementation_pending'))).toBe(true);
  });

  it('restores status and search from the URL and keeps later filter changes in the URL', async () => {
    routeQuery.status = 'settlement_pending';
    routeQuery.query = '龙城';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ok({ items: [], nextCursor: null } satisfies TaskQueuePage));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(TaskQueueView, { props: { currentUser: user } });
    await flushPromises();

    expect(wrapper.get('[data-test="task-status-filter"]').attributes('value')).toBe('settlement_pending');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=settlement_pending') && String(url).includes('query=%E9%BE%99%E5%9F%8E'))).toBe(true);

    await wrapper.get('[data-test="task-status-filter"]').setValue('all');
    await flushPromises();
    expect(replace).toHaveBeenCalledWith({ query: { query: '龙城' } });
  });
});
