import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({
    name,
    setup(_, { slots }) {
      return () => vue.h('div', { 'data-stub': name }, [slots['header-extra']?.(), slots.default?.()]);
    },
  });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { disabled: Boolean }, emits: ['click'],
    setup(props, { emit, slots, attrs }) {
      return () => vue.h('button', { ...attrs, disabled: props.disabled, onClick: () => emit('click') }, slots.default?.());
    },
  });
  const NInput = vue.defineComponent({
    name: 'NInput', props: { value: { type: String, default: '' }, placeholder: String }, emits: ['update:value'],
    setup(props, { emit, attrs }) {
      return () => vue.h('input', { ...attrs, value: props.value, placeholder: props.placeholder, onInput: (e: Event) => emit('update:value', (e.target as HTMLInputElement).value) });
    },
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
    setup(props, { emit, attrs, slots }) {
      return () => vue.h('label', [vue.h('input', { ...attrs, type: 'checkbox', checked: props.checked, onChange: (e: Event) => emit('update:checked', (e.target as HTMLInputElement).checked) }), slots.default?.()]);
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
  return {
    NAlert: wrap('NAlert'), NButton, NCard: wrap('NCard'), NCheckbox, NDataTable, NEmpty: wrap('NEmpty'),
    NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NInput, NSelect, NSpace: wrap('NSpace'), NSpin: wrap('NSpin'),
    NTabPane, NTabs: wrap('NTabs'), NTag: wrap('NTag'),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});

import ReservesView from '../src/views/ReservesView.vue';

const admin: CurrentUser = {
  id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};
const readonly: CurrentUser = { ...admin, id: 'read', username: 'read', role: 'readonly' };

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

const projectSummary = {
  id: 'p1', name: '储备A', year: 2026, owner: null, status: 'draft', reserveVersion: 0, version: 1,
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
  knownAmountFen: 0, missingPriceCount: 1, completenessBasisPoints: 0,
};
const projectDetail = {
  ...projectSummary,
  allocations: [{
    id: 'a1', demandMaterialId: 'dm1', quantityScaled: 10000, rawModel: 'JX-01', unit: '套',
    material: { id: 'm1', code: null, name: '线夹', model: 'JX-01', unit: '套', enabled: true, version: 1 },
    demand: { id: 'd1', sequenceNo: '1', year: 2026, category: '防断线', voltage: '220kV', lineName: '龙城线', section: '#1' },
    source: { fileName: '需求.xlsx', sheetName: '需求', rowNumber: 2 },
  }],
  materialSummary: [{ materialId: 'm1', rawModel: 'JX-01', model: 'JX-01', name: '线夹', unit: '套', quantityScaled: 10000 }],
  costLines: [], categoryAllocations: [], categories: [], classifiedAmountFen: 0, unclassifiedAmountFen: 0,
};

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/projects?limit=50') return ok({ items: [projectSummary], nextCursor: null });
    if (url === '/api/projects/candidates?limit=100') return ok({ items: [{
      demandMaterialId: 'dm1', demandId: 'd1', sequenceNo: '1', year: 2026, category: '防断线', voltage: '220kV',
      lineName: '龙城线', section: '#1', rawModel: 'JX-01', unit: '套', material: projectDetail.allocations[0]!.material,
      originalQuantityScaled: 100000, allocatedQuantityScaled: 0, remainingQuantityScaled: 100000,
      source: { fileName: '需求.xlsx', sheetName: '需求', rowNumber: 2 },
    }], nextCursor: 'candidate-next' });
    if (url === '/api/projects/candidates?limit=100&cursor=candidate-next') return ok({ items: [{
      demandMaterialId: 'dm2', demandId: 'd2', sequenceNo: '2', year: 2026, category: '防鸟', voltage: '110kV',
      lineName: '江北线', section: '#2', rawModel: 'JX-02', unit: '只', material: null,
      originalQuantityScaled: 20000, allocatedQuantityScaled: 0, remainingQuantityScaled: 20000,
      source: { fileName: '需求.xlsx', sheetName: '需求', rowNumber: 3 },
    }], nextCursor: null });
    if (url === '/api/projects/suggestions?limit=100') return ok({ items: [{ year: 2026, category: '防断线', voltage: '220kV', lineName: '龙城线', itemCount: 1 }] });
    if (url === '/api/reserve-categories') return ok({ items: [{ id: 'cat1', key: 'line', label: '防断线', enabled: true, version: 1 }] });
    if (url === '/api/category-mappings') return ok({ items: [] });
    if (url === '/api/projects/p1') return ok(projectDetail);
    if (url === '/api/projects' && init?.method === 'POST') return ok({ ...projectSummary, id: 'new-project', name: '新储备', missingPriceCount: 1 }, 201);
    if (url === '/api/projects/p1/costs' && init?.method === 'PUT') return ok({ version: 2, knownAmountFen: 11260, missingPriceCount: 0, completenessBasisPoints: 10000 });
    if (url === '/api/projects/p1/confirm' && init?.method === 'POST') return ok({ id: 'p1', status: 'confirmed', version: 2, reserveVersion: 1, knownAmountFen: 0, missingPriceCount: 1, completenessBasisPoints: 0 });
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  }));
}

describe('ReservesView P3 behavior', () => {
  beforeEach(() => installFetch());
  afterEach(() => vi.unstubAllGlobals());

  it('lets readonly users inspect reserves but hides conversion write controls', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: readonly } });
    await flushPromises();
    expect(wrapper.text()).toContain('储备A');
    expect(wrapper.text()).toContain('仅管理员或项目管理角色可以归并、分配、估算和确认储备');
    expect(wrapper.find('[data-test="create-project"]').exists()).toBe(false);
  });

  it('loads candidate demand materials page by page instead of capping the conversion pool at 100 rows', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: admin } });
    await flushPromises();
    expect(wrapper.find('[data-test="candidate-dm1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="candidate-dm2"]').exists()).toBe(false);
    await wrapper.get('[data-test="load-more-candidates"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="candidate-dm2"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="load-more-candidates"]').exists()).toBe(false);
  });

  it('converts selected demand quantities to fixed-point allocation payloads', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="candidate-dm1"]').setValue(true);
    await wrapper.get('[data-test="project-name"]').setValue('新储备');
    await wrapper.get('[data-test="allocation-dm1"]').setValue('6.5');
    await wrapper.get('[data-test="create-project"]').trigger('click');
    await flushPromises();

    const fetchMock = vi.mocked(fetch);
    const call = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/projects' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      name: '新储备', year: 2026, owner: null,
      allocations: [{ demandMaterialId: 'dm1', quantityScaled: 65000 }],
    });
  });

  it('converts yuan inputs into exact scaled price and fen payloads', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="open-project-p1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="material-price-a1"]').setValue('12.3456');
    await wrapper.get('[data-test="construction-cost"]').setValue('100.25');
    await wrapper.get('[data-test="save-costs"]').trigger('click');
    await flushPromises();

    const fetchMock = vi.mocked(fetch);
    const call = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/projects/p1/costs' && init?.method === 'PUT');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      expectedVersion: 1,
      materialPrices: [{ demandAllocationId: 'a1', unitPriceScaled: 123456, source: null, priceDate: null, taxInclusive: null }],
      fixedCosts: [{ kind: 'construction', label: '施工费', amountFen: 10025, source: null, priceDate: null, taxInclusive: null }],
    });
  });

  it('confirms the currently loaded project version instead of a stale hard-coded version', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="open-project-p1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="confirm-project"]').trigger('click');
    await flushPromises();

    const fetchMock = vi.mocked(fetch);
    const call = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/projects/p1/confirm' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({ expectedVersion: 1, reason: null });
  });
});
