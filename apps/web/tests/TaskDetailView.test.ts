import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

const push = vi.fn();
const replace = vi.fn();
const routeQuery = vi.hoisted(() => ({} as Record<string, string>));
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { projectId: 'p1', taskId: 't1' }, query: routeQuery, fullPath: '/projects/p1/tasks/t1' }),
  useRouter: () => ({ push, replace, back: vi.fn() }),
}));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({
    name,
    inheritAttrs: false,
    setup(_, { slots, attrs }) { return () => vue.h('div', { ...attrs, 'data-stub': name }, [slots['header-extra']?.(), slots.default?.()]); },
  });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { disabled: Boolean, loading: Boolean }, emits: ['click'], inheritAttrs: false,
    setup(props, { emit, slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.disabled || props.loading, onClick: () => emit('click') }, slots.default?.()); },
  });
  const NInput = vue.defineComponent({
    name: 'NInput', props: { value: { type: [String, Number], default: '' }, disabled: Boolean }, emits: ['update:value'], inheritAttrs: false,
    setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, disabled: props.disabled, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value) }); },
  });
  const NSelect = vue.defineComponent({
    name: 'NSelect', props: { value: String, options: { type: Array, default: () => [] } }, emits: ['update:value'], inheritAttrs: false,
    setup(props, { emit, attrs }) {
      return () => vue.h('select', {
        ...attrs,
        value: props.value ?? '',
        onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
      }, (props.options as Array<{ label: string; value: string }>).map((item) => vue.h('option', { value: item.value }, item.label)));
    },
  });
  const NDrawer = vue.defineComponent({
    name: 'NDrawer', props: { show: Boolean }, emits: ['update:show'], inheritAttrs: false,
    setup(props, { slots, attrs }) { return () => props.show ? vue.h('aside', { ...attrs, 'data-stub': 'NDrawer' }, slots.default?.()) : null; },
  });
  const NProgress = vue.defineComponent({
    name: 'NProgress', props: { percentage: Number }, setup(props) { return () => vue.h('span', `${props.percentage ?? 0}%`); },
  });
  const NCheckbox = vue.defineComponent({
    name: 'NCheckbox', props: { checked: Boolean }, emits: ['update:checked'], inheritAttrs: false,
    setup(props, { emit, slots, attrs }) { return () => vue.h('label', [vue.h('input', { ...attrs, type: 'checkbox', checked: props.checked, onChange: (event: Event) => emit('update:checked', (event.target as HTMLInputElement).checked) }), slots.default?.()]); },
  });
  return {
    NAlert: wrap('NAlert'), NButton, NCard: wrap('NCard'), NCheckbox, NDatePicker: NInput, NDrawer,
    NDrawerContent: wrap('NDrawerContent'), NEmpty: wrap('NEmpty'), NForm: wrap('NForm'), NFormItem: wrap('NFormItem'),
    NInput, NProgress, NSelect, NSpin: wrap('NSpin'), NTag: wrap('NTag'),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});

import TaskDetailView from '../src/views/TaskDetailView.vue';

const admin: CurrentUser = {
  id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};
const readonly: CurrentUser = { ...admin, id: 'readonly', username: 'readonly', role: 'readonly' };

const project = {
  id: 'p1', name: '220kV 龙城线防断线治理', year: 2026, owner: '张三', status: 'confirmed' as const,
  reserveVersion: 2, frameworkId: null, version: 5, demandLinks: [], materialRequirements: [],
  knownMaterialAmountFen: 0, missingPriceCount: 0, materialPriceCompletenessBasisPoints: 10000,
  createdAt: '', updatedAt: '',
};

const task = {
  id: 't1', projectId: 'p1', projectReleaseId: 'pr1', name: '龙城线 #001-#010 更换任务', description: null,
  scopeText: '#001-#010', owner: '李四', plannedDate: '2026-09-20', plannedQuantityScaled: 1000000, unit: '项',
  version: 1, implementationVersion: 4, settlementVersion: 7,
  demandScopes: [{ id: 'scope1', taskId: 't1', demandId: 'd1', plannedQuantityScaled: 1000000, demand: { sequenceNo: 'D-001', lineName: '龙城线', section: '#001-#010' } }],
  materials: [{ id: 'tm1', taskId: 't1', projectMaterialRequirementId: 'pm1', materialId: null, model: 'FXBW-110', unit: '套', requiredQuantityScaled: 600000, supplyVersion: 3, createdAt: '', updatedAt: '' }],
  supplyTotals: [{ taskMaterialRequirementId: 'tm1', model: 'FXBW-110', unit: '套', totals: { reportedQuantityScaled: 600000, shippedQuantityScaled: 400000, arrivedQuantityScaled: 200000 } }],
  implementedQuantityScaled: 300000, settledQuantityScaled: 100000, implementationComplete: false, settlementComplete: false,
  state: 'unimplemented_unsettled' as const,
  settlementReminder: { needed: true, firstImplementationDate: '2026-09-15', dueDate: '2026-10-15', finalSettlementId: null },
  createdAt: '', updatedAt: '',
};

function execution(taskOverride = task) {
  return {
    projectId: 'p1', projectVersion: 5, released: true, tasks: [taskOverride], demands: [],
    implementationComplete: false, settlementComplete: false, projectState: 'unimplemented_unsettled' as const,
  };
}

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

function conflict() {
  return new Response(JSON.stringify({ ok: false, error: { code: 'VERSION_CONFLICT', message: '供应记录已被其他人更新，请读取最新数据' } }), {
    status: 409, headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(options: { conflictOnSave?: boolean; taskOverride?: typeof task } = {}) {
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'idem-arrival-1') });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/reserve-projects/p1') return ok(project);
    if (url === '/api/projects/p1/execution') return ok(execution(options.taskOverride ?? task));
    if (url === '/api/task-material-supply-events' && init?.method === 'POST') {
      return options.conflictOnSave ? conflict() : ok({ id: 'event1', supplyVersion: 4 }, 201);
    }
    if (url === '/api/task-implementations' && init?.method === 'POST') return ok({ id: 'implementation1', implementationVersion: 5 }, 201);
    if (url === '/api/task-settlements' && init?.method === 'POST') return ok({ id: 'settlement1', settlementVersion: 8 }, 201);
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  }));
}

describe('TaskDetailView redesign sample', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockReset();
    replace.mockReset();
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
  });

  it('restores task detail section from the URL and persists section navigation', async () => {
    routeQuery.section = 'settlement';
    installFetch();
    const wrapper = mount(TaskDetailView, { props: { currentUser: admin } });
    await flushPromises();

    expect(wrapper.get('[data-test="task-section-settlement"]').classes()).toContain('active');
    await wrapper.get('[data-test="task-section-scope"]').trigger('click');
    expect(replace).toHaveBeenCalledWith({ query: { section: 'scope' } });
  });

  it('returns to the originating task queue URL instead of forcing project navigation', async () => {
    routeQuery.from = '/tasks?status=settlement_pending&query=%E9%BE%99%E5%9F%8E';
    installFetch();
    const wrapper = mount(TaskDetailView, { props: { currentUser: admin } });
    await flushPromises();

    expect(wrapper.get('.breadcrumb-back').text()).toContain('返回任务队列');
    await wrapper.get('.breadcrumb-back').trigger('click');
    expect(push).toHaveBeenCalledWith('/tasks?status=settlement_pending&query=%E9%BE%99%E5%9F%8E');
  });

  it('keeps supply, implementation and settlement summaries visible together', async () => {
    installFetch();
    const wrapper = mount(TaskDetailView, { props: { currentUser: admin } });
    await flushPromises();

    expect(wrapper.text()).toContain('供应');
    expect(wrapper.text()).toContain('实施');
    expect(wrapper.text()).toContain('结算');
    expect(wrapper.text()).toContain('上报 60');
    expect(wrapper.text()).toContain('发货 40');
    expect(wrapper.text()).toContain('到货 20');
    expect(wrapper.text()).toContain('30 / 100');
    expect(wrapper.text()).toContain('10 / 100');
  });

  it('registers arrival through the unified supply editor and enforces the remaining shipped quantity', async () => {
    installFetch();
    const wrapper = mount(TaskDetailView, { props: { currentUser: admin } });
    await flushPromises();

    await wrapper.get('[data-test="open-supply-tm1"]').trigger('click');
    await wrapper.get('[data-test="supply-stage"]').setValue('arrived');
    expect(wrapper.text()).toContain('本次最多');
    expect(wrapper.text()).toContain('20 套');

    await wrapper.get('[data-test="supply-quantity"]').setValue('21');
    await wrapper.get('[data-test="save-supply"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('本次最多可登记 20 套');
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/api/task-material-supply-events' && init?.method === 'POST')).toHaveLength(0);

    await wrapper.get('[data-test="supply-quantity"]').setValue('10');
    expect(wrapper.text()).toContain('累计已到货将为 30 套');
    await wrapper.get('[data-test="save-supply"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/task-material-supply-events' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(new Headers(call![1]!.headers).get('Idempotency-Key')).toBe('idem-arrival-1');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      taskMaterialRequirementId: 'tm1', expectedSupplyVersion: 3, stage: 'arrived', quantityScaled: 100000,
    });
  });

  it('registers shipment independently up to the reported cumulative quantity', async () => {
    installFetch();
    const wrapper = mount(TaskDetailView, { props: { currentUser: admin } });
    await flushPromises();

    await wrapper.get('[data-test="open-supply-tm1"]').trigger('click');
    await wrapper.get('[data-test="supply-stage"]').setValue('shipped');
    expect(wrapper.text()).toContain('已上报60 套');
    expect(wrapper.text()).toContain('已发货40 套');
    expect(wrapper.text()).toContain('本次最多');
    expect(wrapper.text()).toContain('20 套');
    await wrapper.get('[data-test="supply-quantity"]').setValue('10');
    expect(wrapper.text()).toContain('累计已发货将为 50 套');
    await wrapper.get('[data-test="save-supply"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/task-material-supply-events' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      taskMaterialRequirementId: 'tm1', expectedSupplyVersion: 3, stage: 'shipped', quantityScaled: 100000,
    });
  });

  it('keeps the arrival draft visible on a 409 conflict and offers an explicit refresh path', async () => {
    installFetch({ conflictOnSave: true });
    const wrapper = mount(TaskDetailView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="open-supply-tm1"]').trigger('click');
    await wrapper.get('[data-test="supply-stage"]').setValue('arrived');
    await wrapper.get('[data-test="supply-quantity"]').setValue('10');
    await wrapper.get('[data-test="save-supply"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test="supply-quantity"]').attributes('value')).toBe('10');
    expect(wrapper.text()).toContain('记录已被更新');
    expect(wrapper.find('[data-test="reload-supply-after-conflict"]').exists()).toBe(true);
  });

  it('does not expose arrival mutations to readonly users', async () => {
    installFetch();
    const wrapper = mount(TaskDetailView, { props: { currentUser: readonly } });
    await flushPromises();
    expect(wrapper.find('[data-test="open-supply-tm1"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('只读');
  });

  it('records implementation independently even when delivered material is behind the implementation quantity', async () => {
    installFetch();
    const wrapper = mount(TaskDetailView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="task-section-implementation"]').trigger('click');
    await wrapper.get('[data-test="open-implementation"]').trigger('click');
    await wrapper.get('[data-test="implementation-quantity"]').setValue('40');
    await wrapper.get('[data-test="implementation-scope-scope1"]').setValue('40');
    await wrapper.get('[data-test="save-implementation"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/task-implementations' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      taskId: 't1', expectedImplementationVersion: 4, completedQuantityScaled: 400000,
      scopeLines: [{ taskDemandScopeId: 'scope1', completedQuantityScaled: 400000 }], materialUsages: [],
    });
  });

  it('allows settlement before any implementation and keeps settlement on its own version', async () => {
    installFetch({ taskOverride: { ...task, implementedQuantityScaled: 0, settledQuantityScaled: 0 } });
    const wrapper = mount(TaskDetailView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="task-section-settlement"]').trigger('click');
    await wrapper.get('[data-test="open-settlement"]').trigger('click');
    await wrapper.get('[data-test="settlement-amount"]').setValue('100');
    await wrapper.get('[data-test="settlement-quantity"]').setValue('20');
    await wrapper.get('[data-test="settlement-scope-scope1"]').setValue('20');
    await wrapper.get('[data-test="save-settlement"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/task-settlements' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      taskId: 't1', expectedSettlementVersion: 7, coverageQuantityScaled: 200000, amountFen: 10000, final: false,
      coverage: [{ taskDemandScopeId: 'scope1', quantityScaled: 200000 }], agreementAllocations: [],
    });
  });
});
