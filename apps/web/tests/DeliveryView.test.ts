import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({
    name,
    setup(_, { slots }) { return () => vue.h('div', { 'data-stub': name }, [slots['header-extra']?.(), slots.default?.()]); },
  });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { disabled: Boolean }, emits: ['click'],
    setup(props, { emit, slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); },
  });
  const NInput = vue.defineComponent({
    name: 'NInput', props: { value: { type: String, default: '' }, placeholder: String, disabled: Boolean }, emits: ['update:value'],
    setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, placeholder: props.placeholder, disabled: props.disabled, onInput: (e: Event) => emit('update:value', (e.target as HTMLInputElement).value) }); },
  });
  const NSelect = vue.defineComponent({
    name: 'NSelect', props: { value: [String, Number], options: { type: Array, default: () => [] }, disabled: Boolean }, emits: ['update:value'],
    setup(props, { emit, attrs }) {
      return () => vue.h('select', { ...attrs, value: props.value ?? '', disabled: props.disabled, onChange: (e: Event) => emit('update:value', (e.target as HTMLSelectElement).value || null) },
        [vue.h('option', { value: '' }, '—'), ...(props.options as Array<{ label: string; value: string }>).map((option) => vue.h('option', { value: option.value }, option.label))]);
    },
  });
  const NCheckbox = vue.defineComponent({
    name: 'NCheckbox', inheritAttrs: false, props: { checked: Boolean }, emits: ['update:checked'],
    setup(props, { emit, attrs, slots }) { return () => vue.h('label', [vue.h('input', { ...attrs, type: 'checkbox', checked: props.checked, onChange: (e: Event) => emit('update:checked', (e.target as HTMLInputElement).checked) }), slots.default?.()]); },
  });
  const NDataTable = vue.defineComponent({
    name: 'NDataTable', props: { data: { type: Array, default: () => [] }, columns: { type: Array, default: () => [] } },
    setup(props) {
      return () => vue.h('div', { 'data-stub': 'NDataTable' },
        (props.data as Array<Record<string, unknown>>).map((row, rowIndex) =>
          vue.h('div', { 'data-row': rowIndex },
            (props.columns as Array<{ key?: string; render?: (row: Record<string, unknown>) => unknown }>).map((column, columnIndex) =>
              vue.h('span', { 'data-cell': columnIndex }, column.render ? column.render(row) as never : String(row[column.key ?? ''] ?? '')),
            ),
          ),
        ),
      );
    },
  });
  const NTabPane = vue.defineComponent({
    name: 'NTabPane', props: { name: String, tab: String },
    setup(props, { slots }) { return () => vue.h('section', { 'data-tab': props.name }, [vue.h('h3', props.tab), slots.default?.()]); },
  });
  return {
    NAlert: wrap('NAlert'), NButton, NCard: wrap('NCard'), NCheckbox, NDataTable, NEmpty: wrap('NEmpty'),
    NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NInput, NSelect, NSpace: wrap('NSpace'), NSpin: wrap('NSpin'),
    NTabPane, NTabs: wrap('NTabs'), NTag: wrap('NTag'),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});

import DeliveryView from '../src/views/DeliveryView.vue';

const baseUser: CurrentUser = {
  id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};
const implementationUser: CurrentUser = { ...baseUser, id: 'impl', username: 'impl', role: 'implementation' };
const financeUser: CurrentUser = { ...baseUser, id: 'finance', username: 'finance', role: 'finance' };
const readonlyUser: CurrentUser = { ...baseUser, id: 'read', username: 'read', role: 'readonly' };

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

const demandLink = {
  id: 'link1', demandId: 'd1', sequenceNo: 'D-001', year: 2026, voltage: '220kV', lineName: '龙城线', section: '#1-#2',
  category: '防断线', owner: null, createdAt: '2026-09-12T00:00:00.000Z',
};
const projectMaterial = {
  id: 'pm1', projectId: 'p1', materialId: null, model: 'JX-01', unit: '套', requiredQuantityScaled: 1000000,
  unitPriceScaled: null, amountFen: null, reserveCategoryId: null, reserveCategory: null, version: 1,
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
};
const project = {
  id: 'p1', name: '子项目A', year: 2026, owner: null, status: 'confirmed' as const, reserveVersion: 1, frameworkId: null, version: 5,
  demandLinks: [demandLink], materialRequirements: [projectMaterial], knownMaterialAmountFen: 0, missingPriceCount: 1,
  materialPriceCompletenessBasisPoints: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
};
const task = {
  id: 't1', projectId: 'p1', projectReleaseId: 'pr1', name: '任务一', description: null, scopeText: '#1-#2', owner: null,
  plannedDate: '2026-09-15', plannedQuantityScaled: 1000000, unit: '项', version: 1, implementationVersion: 4, settlementVersion: 7,
  demandScopes: [{ id: 'ts1', taskId: 't1', demandId: 'd1', plannedQuantityScaled: 1000000, demand: { sequenceNo: 'D-001', lineName: '龙城线', section: '#1-#2' } }],
  materials: [{ id: 'tm1', taskId: 't1', projectMaterialRequirementId: 'pm1', materialId: null, model: 'JX-01', unit: '套', requiredQuantityScaled: 600000, supplyVersion: 3, createdAt: '', updatedAt: '' }],
  supplyTotals: [{ taskMaterialRequirementId: 'tm1', model: 'JX-01', unit: '套', totals: { reportedQuantityScaled: 600000, shippedQuantityScaled: 400000, arrivedQuantityScaled: 200000 } }],
  implementedQuantityScaled: 300000, settledQuantityScaled: 100000, implementationComplete: false, settlementComplete: false,
  state: 'unimplemented_unsettled' as const,
  settlementReminder: { needed: true, firstImplementationDate: '2026-09-15', dueDate: '2026-10-15', finalSettlementId: null },
  createdAt: '', updatedAt: '',
};
const projectRelease = {
  id: 'pr1', projectId: 'p1', releaseDate: '2026-09-10', note: null, projectVersionSnapshot: 4, reserveVersionSnapshot: 1, projectVersion: 5,
  snapshot: { demandLinks: [demandLink], materialRequirements: [projectMaterial], projectVersion: 4, reserveVersion: 1 }, createdAt: '',
};

function execution(released: boolean) {
  return {
    projectId: 'p1', projectVersion: 5, released,
    tasks: released ? [task] : [],
    demands: [{ demandId: 'd1', sequenceNo: 'D-001', lineName: '龙城线', section: '#1-#2', plannedQuantityScaled: released ? 1000000 : 0, implementedQuantityScaled: released ? 300000 : 0, settledQuantityScaled: released ? 100000 : 0, implementationProgressBasisPoints: released ? 3000 : 0, settlementProgressBasisPoints: released ? 1000 : 0, implementationComplete: false, settlementComplete: false, state: 'unimplemented_unsettled' as const }],
    implementationComplete: false, settlementComplete: false, projectState: 'unimplemented_unsettled' as const,
  };
}

function installFetch(released = true) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/reserve-projects?limit=100') return ok({ items: [project], nextCursor: null });
    if (url === '/api/reserve-projects/p1') return ok(project);
    if (url === '/api/projects/p1/execution') return ok(execution(released));
    if (url === '/api/project-releases?projectId=p1') return ok({ items: released ? [projectRelease] : [] });
    if (url === '/api/attachments?objectType=project&objectId=p1') return ok({ items: [] });
    if (url === '/api/project-releases' && init?.method === 'POST') return ok(projectRelease, 201);
    if (url === '/api/project-tasks' && init?.method === 'POST') return ok({ ...task, id: 't2', name: '新任务' }, 201);
    if (url === '/api/task-material-supply-events' && init?.method === 'POST') return ok({ id: 'se1', supplyVersion: 4 }, 201);
    if (url === '/api/task-implementations' && init?.method === 'POST') return ok({ id: 'i1', implementationVersion: 5 }, 201);
    if (url === '/api/task-settlements' && init?.method === 'POST') return ok({ id: 's1', settlementVersion: 8 }, 201);
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  }));
}

describe('DeliveryView final business baseline', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows demand feedback from task facts while readonly users cannot mutate execution', async () => {
    installFetch(true);
    const wrapper = mount(DeliveryView, { props: { currentUser: readonlyUser } });
    await flushPromises();
    expect(wrapper.text()).toContain('未实施未结算');
    expect(wrapper.text()).toContain('实施 30/100');
    expect(wrapper.text()).toContain('结算 10/100');
    expect(wrapper.find('[data-test="create-project-release"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="create-task"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="create-task-implementation"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="create-task-settlement"]').exists()).toBe(false);
  });

  it('performs a single project-level release without per-material release lines', async () => {
    installFetch(false);
    const wrapper = mount(DeliveryView, { props: { currentUser: baseUser } });
    await flushPromises();
    await wrapper.get('[data-test="create-project-release"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/project-releases' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      projectId: 'p1', expectedProjectVersion: 5, releaseDate: expect.any(String), note: null,
    });
  });

  it('creates an execution task from demand scope and independent project-material quantities', async () => {
    installFetch(true);
    const wrapper = mount(DeliveryView, { props: { currentUser: baseUser } });
    await flushPromises();
    await wrapper.get('[data-test="task-name"]').setValue('新任务');
    await wrapper.get('[data-test="task-planned-quantity"]').setValue('60');
    await wrapper.get('[data-test="task-demand-d1"]').setValue('60');
    await wrapper.get('[data-test="task-material-pm1"]').setValue('20');
    await wrapper.get('[data-test="create-task"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/project-tasks' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      projectId: 'p1', expectedProjectVersion: 5, name: '新任务', plannedQuantityScaled: 600000, unit: '项',
      demandScopes: [{ demandId: 'd1', quantityScaled: 600000 }],
      materials: [{ projectMaterialRequirementId: 'pm1', quantityScaled: 200000 }],
    });
  });

  it('advances material supply and implementation with independent task versions', async () => {
    installFetch(true);
    const wrapper = mount(DeliveryView, { props: { currentUser: implementationUser } });
    await flushPromises();
    expect(wrapper.find('[data-test="create-task-settlement"]').exists()).toBe(false);

    await wrapper.get('[data-test="supply-quantity"]').setValue('10');
    await wrapper.get('[data-test="create-supply-event"]').trigger('click');
    await flushPromises();
    const supplyCall = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/task-material-supply-events' && init?.method === 'POST');
    expect(JSON.parse(String(supplyCall![1]!.body))).toMatchObject({
      taskMaterialRequirementId: 'tm1', expectedSupplyVersion: 3, stage: 'reported', quantityScaled: 100000,
    });

    await wrapper.get('[data-test="implementation-scope-ts1"]').setValue('20.5');
    await wrapper.get('[data-test="create-task-implementation"]').trigger('click');
    await flushPromises();
    const implementationCall = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/task-implementations' && init?.method === 'POST');
    expect(JSON.parse(String(implementationCall![1]!.body))).toMatchObject({
      taskId: 't1', expectedImplementationVersion: 4, completedQuantityScaled: 205000,
      scopeLines: [{ taskDemandScopeId: 'ts1', completedQuantityScaled: 205000 }],
    });
  });

  it('lets finance settle a task independently from implementation using the settlement version', async () => {
    installFetch(true);
    const wrapper = mount(DeliveryView, { props: { currentUser: financeUser } });
    await flushPromises();
    expect(wrapper.find('[data-test="create-task-implementation"]').exists()).toBe(false);
    await wrapper.get('[data-test="task-settlement-amount"]').setValue('123.45');
    await wrapper.get('[data-test="task-settlement-scope-ts1"]').setValue('100');
    await wrapper.get('[data-test="create-task-settlement"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/task-settlements' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      taskId: 't1', expectedSettlementVersion: 7, coverageQuantityScaled: 1000000, amountFen: 12345, final: false,
      coverage: [{ taskDemandScopeId: 'ts1', quantityScaled: 1000000 }], agreementAllocations: [],
    });
  });
});
