import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const NUpload = vue.defineComponent({ name: 'NUpload', setup(_, { slots }) { return () => vue.h('div', { 'data-stub': 'NUpload' }, slots.default?.()); } });
  return {
    NAlert: wrap('NAlert'), NButton, NCard: wrap('NCard'), NCheckbox, NDataTable, NEmpty: wrap('NEmpty'),
    NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NInput, NSelect, NSpace: wrap('NSpace'), NSpin: wrap('NSpin'),
    NTabPane, NTabs: wrap('NTabs'), NTag: wrap('NTag'), NUpload,
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

const project = {
  id: 'p1', name: '子项目A', year: 2026, owner: null, status: 'confirmed', reserveVersion: 1, version: 5,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
  knownAmountFen: 0, missingPriceCount: 0, completenessBasisPoints: 10000,
};
const lifecycle = {
  projectId: 'p1', projectVersion: 5, implementationComplete: false, settlementComplete: false, projectState: 'unimplemented_unsettled',
  lines: [{
    demandId: 'd1', demandMaterialId: 'dm1', lineName: '龙城线', section: '#1-#2', rawModel: 'JX-01', unit: '套',
    allocatedQuantityScaled: 1000000, releasedQuantityScaled: 600000, implementedQuantityScaled: 300000, settledQuantityScaled: 0,
    implementationComplete: false, settlementComplete: false, state: 'unimplemented_unsettled',
  }],
  demands: [{ demandId: 'd1', lineName: '龙城线', section: '#1-#2', implementationComplete: false, settlementComplete: false, state: 'unimplemented_unsettled' }],
  settlementTodo: { needed: false, implementationCompletedDate: null, dueDate: null, finalSettlementId: null },
};
const release = {
  id: 'r1', projectId: 'p1', releaseDate: '2026-09-10', note: null, projectVersionSnapshot: 3, reserveVersionSnapshot: 1, projectVersion: 5,
  lines: [{ id: 'rl1', releaseBatchId: 'r1', demandMaterialId: 'dm1', quantityScaled: 600000, snapshot: { demandId: 'd1', lineName: '龙城线', section: '#1-#2', rawModel: 'JX-01', unit: '套', projectVersion: 3, reserveVersion: 1 } }],
  createdAt: '2026-09-10T00:00:00.000Z',
};

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/projects?limit=50') return ok({ items: [project], nextCursor: null });
    if (url === '/api/projects/p1/lifecycle') return ok(lifecycle);
    if (url === '/api/release-batches?projectId=p1') return ok({ items: [release] });
    if (url === '/api/implementations?projectId=p1') return ok({ items: [] });
    if (url === '/api/settlements?projectId=p1') return ok({ items: [] });
    if (url === '/api/implementations?unlinked=true') return ok({ items: [] });
    if (url === '/api/release-batches' && init?.method === 'POST') return ok({ ...release, projectVersion: 6 }, 201);
    if (url === '/api/implementations' && init?.method === 'POST') return ok({ id: 'i1', projectId: 'p1', historical: false, recordDate: '2026-09-12', personnel: null, note: null, version: 1, projectVersion: 6, lines: [], createdAt: '', updatedAt: '' }, 201);
    if (url === '/api/settlements' && init?.method === 'POST') return ok({ id: 's1', projectId: 'p1', settlementDate: '2026-09-12', amountFen: 12345, final: false, note: null, version: 1, voidedAt: null, voidReason: null, projectVersion: 6, coverage: [], agreementAllocations: [], createdAt: '', updatedAt: '' }, 201);
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  }));
}

describe('DeliveryView P5 behavior', () => {
  beforeEach(() => installFetch());
  afterEach(() => vi.unstubAllGlobals());

  it('shows partial lifecycle progress while readonly users cannot write', async () => {
    const wrapper = mount(DeliveryView, { props: { currentUser: readonlyUser } });
    await flushPromises();
    expect(wrapper.text()).toContain('未实施未结算');
    expect(wrapper.text()).toContain('30 / 100');
    expect(wrapper.find('[data-test="create-release"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="create-implementation"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="create-settlement"]').exists()).toBe(false);
  });

  it('creates release ranges using quantity fixed-point values and the current project version', async () => {
    const wrapper = mount(DeliveryView, { props: { currentUser: baseUser } });
    await flushPromises();
    await wrapper.get('[data-test="release-quantity-dm1"]').setValue('40');
    await wrapper.get('[data-test="create-release"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/release-batches' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      projectId: 'p1', expectedProjectVersion: 5, releaseDate: expect.any(String), note: null,
      lines: [{ demandMaterialId: 'dm1', quantityScaled: 400000 }],
    });
  });

  it('lets implementation role record only released scope and hides settlement/release writes', async () => {
    const wrapper = mount(DeliveryView, { props: { currentUser: implementationUser } });
    await flushPromises();
    expect(wrapper.find('[data-test="create-release"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="create-settlement"]').exists()).toBe(false);
    await wrapper.get('[data-test="implementation-release-line"]').setValue('rl1');
    await wrapper.get('[data-test="implementation-quantity"]').setValue('20.5');
    await wrapper.get('[data-test="create-implementation"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/implementations' && init?.method === 'POST');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      historical: false, projectId: 'p1', expectedProjectVersion: 5,
      lines: [{ releaseLineId: 'rl1', completedQuantityScaled: 205000, actualUsedQuantityScaled: 205000 }],
    });
  });

  it('lets finance role create settlement with integer-fen amount while hiding implementation writes', async () => {
    const wrapper = mount(DeliveryView, { props: { currentUser: financeUser } });
    await flushPromises();
    expect(wrapper.find('[data-test="create-release"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="create-implementation"]').exists()).toBe(false);
    await wrapper.get('[data-test="settlement-amount"]').setValue('123.45');
    await wrapper.get('[data-test="settlement-quantity-dm1"]').setValue('100');
    await wrapper.get('[data-test="create-settlement"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/settlements' && init?.method === 'POST');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      projectId: 'p1', expectedProjectVersion: 5, amountFen: 12345, final: false,
      coverage: [{ demandMaterialId: 'dm1', quantityScaled: 1000000 }], agreementAllocations: [],
    });
  });
});
