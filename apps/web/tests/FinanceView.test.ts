import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

const routeQuery = vi.hoisted(() => ({} as Record<string, string>));
const push = vi.fn();
const replace = vi.fn();
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery }), useRouter: () => ({ push, replace }) }));

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
    name: 'NInput', props: { value: { type: String, default: '' }, placeholder: String }, emits: ['update:value'],
    setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, placeholder: props.placeholder, onInput: (e: Event) => emit('update:value', (e.target as HTMLInputElement).value) }); },
  });
  const NSelect = vue.defineComponent({
    name: 'NSelect', props: { value: [String, Number], options: { type: Array, default: () => [] }, disabled: Boolean }, emits: ['update:value'],
    setup(props, { emit, attrs }) {
      return () => vue.h('select', { ...attrs, value: props.value ?? '', disabled: props.disabled, onChange: (e: Event) => emit('update:value', (e.target as HTMLSelectElement).value || null) },
        [vue.h('option', { value: '' }, '—'), ...(props.options as Array<{ label: string; value: string }>).map((option) => vue.h('option', { value: option.value }, option.label))]);
    },
  });
  const NDataTable = vue.defineComponent({
    name: 'NDataTable', props: { data: { type: Array, default: () => [] }, columns: { type: Array, default: () => [] } },
    setup(props) {
      return () => vue.h('div', { 'data-stub': 'NDataTable' }, (props.data as Array<Record<string, unknown>>).map((row, rowIndex) =>
        vue.h('div', { 'data-row': rowIndex }, (props.columns as Array<{ key?: string; render?: (row: Record<string, unknown>) => unknown }>).map((column, columnIndex) =>
          vue.h('span', { 'data-cell': columnIndex }, column.render ? column.render(row) as never : String(row[column.key ?? ''] ?? '')),
        )),
      ));
    },
  });
  const NTabPane = vue.defineComponent({
    name: 'NTabPane', props: { name: String, tab: String },
    setup(props, { slots }) { return () => vue.h('section', { 'data-tab': props.name }, [vue.h('h3', props.tab), slots.default?.()]); },
  });
  const NTabs = vue.defineComponent({
    name: 'NTabs', props: { value: String }, emits: ['update:value'],
    setup(props, { slots, attrs }) { return () => vue.h('div', { ...attrs, 'data-stub': 'NTabs', 'data-value': props.value }, slots.default?.()); },
  });
  return {
    NAlert: wrap('NAlert'), NButton, NCard: wrap('NCard'), NDataTable, NEmpty: wrap('NEmpty'), NForm: wrap('NForm'),
    NFormItem: wrap('NFormItem'), NInput, NSelect, NSpace: wrap('NSpace'), NSpin: wrap('NSpin'), NStatistic: wrap('NStatistic'),
    NTabPane, NTabs, NTag: wrap('NTag'),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});

import FinanceView from '../src/views/FinanceView.vue';

const admin: CurrentUser = {
  id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};
const finance: CurrentUser = { ...admin, id: 'finance', username: 'finance', role: 'finance' };

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const framework = {
  id: 'fw1', code: 'FW-001', name: '年度框架', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000,
  startDate: '2026-01-01', endDate: '2026-12-31', version: 1, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
};
const framework2 = { ...framework, id: 'fw2', code: 'FW-002', name: '专项框架' };
const project = { id: 'p1', name: '子项目A', year: 2026, status: 'confirmed', frameworkId: 'fw1', version: 2 };
const project2 = { ...project, id: 'p2', name: '子项目B', frameworkId: 'fw2' };
const agreementA = { id: 'ag1', frameworkId: 'fw1', code: 'AG-1', name: '协议一', amountFen: 600_000, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', version: 1, createdAt: '', updatedAt: '' };
const agreementB = { ...agreementA, id: 'ag2', code: 'AG-2', name: '协议二', amountFen: 500_000 };

function installFetch({ withEntryCursor = false } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/frameworks') return ok({ items: [framework, framework2] });
    if (url === '/api/finance/projects') return ok({ items: [project, project2] });
    if (url === '/api/agreements?frameworkId=fw1') return ok({ items: [agreementA, agreementB] });
    if (url === '/api/agreements?frameworkId=fw2') return ok({ items: [] });
    if (url === '/api/budgets?projectId=p1') return ok({ items: [] });
    if (url.startsWith('/api/finance/summary?frameworkId=fw1')) return ok({
      framework, asOf: '2026-09-12', confirmedBudgetFen: 800_000, budgetOccurrenceFen: 800_000, actualCostFen: 700_000,
      agreementReservedFen: 1_100_000, frameworkUsageBasisPoints: 8000, frameworkUsageConfigured: true,
      frameworkUsageWarning: true, annualProgressBasisPoints: 8000, annualProgressConfigured: true,
      budgetOverFrameworkWarning: false,
      agreements: [
        { id: 'ag1', code: 'AG-1', name: '协议一', amountFen: 600_000, budgetCommittedFen: 400_000, budgetOccurrenceFen: 540_000, actualCostFen: 300_000, usageBasisPoints: 9000, usageConfigured: true, usageWarning: true },
        { id: 'ag2', code: 'AG-2', name: '协议二', amountFen: 500_000, budgetCommittedFen: 400_000, budgetOccurrenceFen: 260_000, actualCostFen: 400_000, usageBasisPoints: 5200, usageConfigured: true, usageWarning: false },
      ],
    });
    if (url.startsWith('/api/finance/summary?frameworkId=fw2')) return ok({
      framework: framework2, asOf: '2026-09-12', confirmedBudgetFen: 0, budgetOccurrenceFen: 0, actualCostFen: 0,
      agreementReservedFen: 0, frameworkUsageBasisPoints: 0, frameworkUsageConfigured: true,
      frameworkUsageWarning: false, annualProgressBasisPoints: 0, annualProgressConfigured: true,
      budgetOverFrameworkWarning: false, agreements: [],
    });
    if (url === '/api/financial-entries?frameworkId=fw1&limit=50') return ok(withEntryCursor
      ? { items: [{ id: 'e-first', frameworkId: 'fw1', projectId: 'p1', projectName: '子项目A', type: 'actual_cost', businessDate: '2026-09-12', amountFen: 100, note: null, reversesEntryId: null, allocations: [], createdAt: '2026-09-12T08:00:00.000Z' }], nextCursor: 'cursor-2' }
      : { items: [], nextCursor: null });
    if (url === '/api/financial-entries?frameworkId=fw2&limit=50') return ok({ items: [], nextCursor: null });
    if (url === '/api/financial-entries?frameworkId=fw1&limit=50&cursor=cursor-2') return ok({ items: [{ id: 'e-second', frameworkId: 'fw1', projectId: 'p1', projectName: '子项目A', type: 'actual_cost', businessDate: '2026-09-11', amountFen: 200, note: null, reversesEntryId: null, allocations: [], createdAt: '2026-09-11T08:00:00.000Z' }], nextCursor: null });
    if (url === '/api/frameworks' && init?.method === 'POST') return ok({ ...framework, id: 'fw-new', code: 'FW-NEW', name: '新框架', totalAmountFen: 1_234_567 }, 201);
    if (url === '/api/projects/p1/framework' && init?.method === 'PUT') return ok({ projectId: 'p1', frameworkId: 'fw1', version: 3 });
    if (url === '/api/budgets' && init?.method === 'POST') return ok({ id: 'b1', projectId: 'p1', projectName: '子项目A', frameworkId: 'fw1', totalAmountFen: 700_000, note: null, status: 'draft', budgetVersion: 0, version: 1, allocations: [], createdAt: '', updatedAt: '' }, 201);
    if (url === '/api/financial-entries' && init?.method === 'POST') return ok({ id: 'e1', frameworkId: 'fw1', projectId: 'p1', projectName: '子项目A', type: 'actual_cost', businessDate: '2026-09-12', amountFen: 100_000, note: null, reversesEntryId: null, allocations: [], createdAt: '' }, 201);
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  }));
}

describe('FinanceView P4 behavior', () => {
  beforeEach(() => {
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); push.mockReset(); replace.mockReset(); });

  it('shows framework usage warnings and keeps budget occurrence distinct from actual cost', async () => {
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();
    expect(wrapper.text()).toContain('预算发生');
    expect(wrapper.text()).toContain('实际发生');
    expect(wrapper.text()).toContain('80.00%');
    expect(wrapper.text()).toContain('协议一');
    expect(wrapper.text()).toContain('90.00%');
    const tables = wrapper.findAll('[data-stub="NDataTable"]');
    expect(tables[1]?.text()).toContain('有效');
    expect(tables[1]?.text()).not.toContain('active');
    const mobileLists = wrapper.findAll('.mobile-finance-list');
    expect(mobileLists[0]?.text()).toContain('年度框架');
    expect(mobileLists[1]?.text()).toContain('协议一');
    expect(mobileLists[1]?.text()).toContain('有效');
  });

  it('creates a framework using integer fen instead of floating point yuan', async () => {
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();
    expect(wrapper.find('[data-test="framework-code"]').exists()).toBe(false);
    await wrapper.get('[data-test="open-framework-form"]').trigger('click');
    await wrapper.get('[data-test="framework-code"]').setValue('FW-NEW');
    await wrapper.get('[data-test="framework-name"]').setValue('新框架');
    await wrapper.get('[data-test="framework-total"]').setValue('12345.67');
    await wrapper.get('[data-test="create-framework"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/frameworks' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body)).totalAmountFen).toBe(1_234_567);
  });

  it('creates a multi-agreement budget with exact fen allocations', async () => {
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="budget-project"]').setValue('p1');
    await flushPromises();
    await wrapper.get('[data-test="budget-total"]').setValue('7000');
    await wrapper.get('[data-test="budget-agreement-0"]').setValue('ag1');
    await wrapper.get('[data-test="budget-allocation-0"]').setValue('4000');
    await wrapper.get('[data-test="add-budget-split"]').trigger('click');
    await wrapper.get('[data-test="budget-agreement-1"]').setValue('ag2');
    await wrapper.get('[data-test="budget-allocation-1"]').setValue('3000');
    await wrapper.get('[data-test="save-budget"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/budgets' && init?.method === 'POST');
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      projectId: 'p1', totalAmountFen: 700_000, note: null,
      allocations: [{ agreementId: 'ag1', amountFen: 400_000 }, { agreementId: 'ag2', amountFen: 300_000 }],
    });
  });

  it('loads additional financial-entry pages when the server returns a cursor', async () => {
    installFetch({ withEntryCursor: true });
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();
    expect(wrapper.text()).toContain('1.00 元');
    expect(wrapper.find('[data-test="load-more-entries"]').exists()).toBe(true);
    await wrapper.get('[data-test="load-more-entries"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('2.00 元');
    expect(wrapper.find('[data-test="load-more-entries"]').exists()).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/financial-entries?frameworkId=fw1&limit=50&cursor=cursor-2')).toBe(true);
  });

  it('lets finance role post financial entries but hides framework creation controls', async () => {
    const wrapper = mount(FinanceView, { props: { currentUser: finance } });
    await flushPromises();
    expect(wrapper.find('[data-test="create-framework"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="open-framework-form"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="entry-project"]').exists()).toBe(false);
    await wrapper.get('[data-test="open-entry-form"]').trigger('click');
    await wrapper.get('[data-test="entry-project"]').setValue('p1');
    await wrapper.get('[data-test="entry-type"]').setValue('actual_cost');
    await wrapper.get('[data-test="entry-amount"]').setValue('1000');
    await wrapper.get('[data-test="entry-date"]').setValue('2026-09-12');
    await wrapper.get('[data-test="entry-agreement-0"]').setValue('ag1');
    await wrapper.get('[data-test="entry-allocation-0"]').setValue('1000');
    await wrapper.get('[data-test="post-entry"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/financial-entries' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      type: 'actual_cost', projectId: 'p1', amountFen: 100_000, businessDate: '2026-09-12', note: null,
      allocations: [{ agreementId: 'ag1', amountFen: 100_000 }],
    });
  });

  it('honors projectId from the route so project detail can deep-link into the matching budget context', async () => {
    routeQuery.projectId = 'p1';
    routeQuery.tab = 'budgets';
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();
    expect(wrapper.get('[data-test="budget-project"]').attributes('value')).toBe('p1');
    expect(wrapper.findComponent({ name: 'NTabs' }).props('value')).toBe('budgets');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/budgets?projectId=p1')).toBe(true);
  });

  it('persists finance workspace tab changes without discarding project context', async () => {
    routeQuery.projectId = 'p1';
    routeQuery.tab = 'budgets';
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();
    wrapper.findComponent({ name: 'NTabs' }).vm.$emit('update:value', 'entries');
    await flushPromises();
    expect(replace).toHaveBeenCalledWith({ query: { projectId: 'p1', tab: 'entries' } });
  });

  it('restores the selected framework from the URL and preserves the active tab when switching frameworks', async () => {
    routeQuery.framework = 'fw2';
    routeQuery.tab = 'entries';
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();

    expect(wrapper.get('[data-test="finance-framework"]').attributes('value')).toBe('fw2');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/finance/summary?frameworkId=fw2'))).toBe(true);

    await wrapper.get('[data-test="finance-framework"]').setValue('fw1');
    await flushPromises();
    expect(replace).toHaveBeenCalledWith({ query: { framework: 'fw1', tab: 'entries' } });
  });

  it('ignores a stale framework response that returns after the user switches back', async () => {
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const staleGate = deferred<void>();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('frameworkId=fw2')) await staleGate.promise;
      return fallback(input, init);
    });

    await wrapper.get('[data-test="finance-framework"]').setValue('fw2');
    await Promise.resolve();
    await wrapper.get('[data-test="finance-framework"]').setValue('fw1');
    await flushPromises();
    expect(wrapper.get('[data-test="finance-framework"]').attributes('value')).toBe('fw1');
    expect(wrapper.text()).toContain('协议一');

    staleGate.resolve();
    await flushPromises();
    expect(wrapper.get('[data-test="finance-framework"]').attributes('value')).toBe('fw1');
    expect(wrapper.text()).toContain('协议一');
  });

  it('ignores a stale budget-project response after another project is selected', async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const staleGate = deferred<void>();
    const project3 = { ...project, id: 'p3', name: '子项目C' };
    const staleBudget = { id: 'b-old', projectId: 'p1', projectName: '子项目A', frameworkId: 'fw1', totalAmountFen: 100_000, note: '旧项目', status: 'draft', budgetVersion: 0, version: 1, allocations: [], createdAt: '', updatedAt: '' };
    const currentBudget = { ...staleBudget, id: 'b-new', projectId: 'p3', projectName: '子项目C', totalAmountFen: 200_000, note: '当前项目' };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/finance/projects') return ok({ items: [project, project2, project3] });
      if (url === '/api/budgets?projectId=p1') {
        await staleGate.promise;
        return ok({ items: [staleBudget] });
      }
      if (url === '/api/budgets?projectId=p3') return ok({ items: [currentBudget] });
      return fallback(input, init);
    });

    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();

    await wrapper.get('[data-test="budget-project"]').setValue('p1');
    await Promise.resolve();
    await wrapper.get('[data-test="budget-project"]').setValue('p3');
    await flushPromises();
    expect(wrapper.get('[data-test="budget-project"]').attributes('value')).toBe('p3');
    expect((wrapper.get('[data-test="budget-total"]').element as HTMLInputElement).value).toBe('2000.00');

    staleGate.resolve();
    await flushPromises();
    expect(wrapper.get('[data-test="budget-project"]').attributes('value')).toBe('p3');
    expect((wrapper.get('[data-test="budget-total"]').element as HTMLInputElement).value).toBe('2000.00');
  });

  it('clears a budget project from another framework when the user switches framework context', async () => {
    routeQuery.projectId = 'p1';
    routeQuery.tab = 'budgets';
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();
    expect(wrapper.get('[data-test="budget-project"]').attributes('value')).toBe('p1');

    await wrapper.get('[data-test="finance-framework"]').setValue('fw2');
    await flushPromises();

    expect(wrapper.get('[data-test="budget-project"]').attributes('value')).toBe('');
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'budgets', framework: 'fw2' } });
  });

  it('offers a safe return to the originating project when opened from project detail', async () => {
    routeQuery.projectId = 'p1';
    routeQuery.from = '/projects/p1?tab=finance&from=%2Fprojects%3Fstage%3Dreserve';
    const wrapper = mount(FinanceView, { props: { currentUser: admin } });
    await flushPromises();

    expect(wrapper.find('[data-test="back-to-project"]').exists()).toBe(true);
    await wrapper.get('[data-test="back-to-project"]').trigger('click');
    expect(push).toHaveBeenCalledWith('/projects/p1?tab=finance&from=%2Fprojects%3Fstage%3Dreserve');
  });
});
