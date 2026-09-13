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
    name: 'NInput', props: { value: { type: String, default: '' }, placeholder: String, disabled: Boolean }, emits: ['update:value'],
    setup(props, { emit, attrs }) {
      return () => vue.h('input', { ...attrs, value: props.value, placeholder: props.placeholder, disabled: props.disabled, onInput: (e: Event) => emit('update:value', (e.target as HTMLInputElement).value) });
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
    name: 'NCheckbox', inheritAttrs: false, props: { checked: Boolean, disabled: Boolean }, emits: ['update:checked'],
    setup(props, { emit, attrs, slots }) {
      return () => vue.h('label', [vue.h('input', { ...attrs, type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: (e: Event) => emit('update:checked', (e.target as HTMLInputElement).checked) }), slots.default?.()]);
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

const demand1 = {
  id: 'd1', sequenceNo: 'D-001', year: 2026, voltageRaw: '220kV', voltageVerified: '220kV',
  lineName: '龙城线', section: '#1-#2', category: '防断线', owner: null, version: 1, createdAt: '2026-09-12T00:00:00.000Z',
};
const demand2 = {
  id: 'd2', sequenceNo: 'D-002', year: 2026, voltageRaw: '110kV', voltageVerified: '110kV',
  lineName: '江北线', section: '#3-#4', category: '通道治理', owner: null, version: 1, createdAt: '2026-09-12T00:00:00.000Z',
};
const demandLink = {
  id: 'link1', demandId: 'd1', sequenceNo: 'D-001', year: 2026, voltage: '220kV', lineName: '龙城线', section: '#1-#2',
  category: '防断线', owner: null, createdAt: '2026-09-12T00:00:00.000Z',
};
const materialRequirement = {
  id: 'pm1', projectId: 'p1', materialId: null, model: 'JX-01', unit: '套', requiredQuantityScaled: 10000,
  unitPriceScaled: 100000, amountFen: 10000, reserveCategoryId: 'cat1', reserveCategory: { id: 'cat1', key: 'line', label: '防断线' },
  version: 1, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
};
const project = {
  id: 'p1', name: '储备A', year: 2026, owner: null, status: 'draft' as const, reserveVersion: 0, frameworkId: null, version: 1,
  demandLinks: [demandLink], materialRequirements: [materialRequirement], knownMaterialAmountFen: 10000,
  missingPriceCount: 0, materialPriceCompletenessBasisPoints: 10000,
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
};
const createdProject = {
  ...project, id: 'new-project', name: '新储备', demandLinks: [demandLink], materialRequirements: [], knownMaterialAmountFen: 0,
  missingPriceCount: 0, materialPriceCompletenessBasisPoints: 10000,
};

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/reserve-projects?limit=100') return ok({ items: [project], nextCursor: null });
    if (url === '/api/demands?limit=100') return ok({ items: [demand1, demand2], nextCursor: null });
    if (url === '/api/reserve-categories') return ok({ items: [{ id: 'cat1', key: 'line', label: '防断线', enabled: true, version: 1 }] });
    if (url === '/api/category-mappings') return ok({ items: [] });
    if (url === '/api/reserve-projects/p1') return ok(project);
    if (url === '/api/reserve-projects/new-project') return ok(createdProject);
    if (url === '/api/reserve-projects' && init?.method === 'POST') return ok(createdProject, 201);
    if (url === '/api/reserve-projects/p1/demands' && init?.method === 'PUT') return ok({ projectId: 'p1', version: 2, demandIds: ['d2'] });
    if (url === '/api/reserve-projects/p1/materials' && init?.method === 'PUT') return ok({ projectId: 'p1', version: 2, materialRequirements: [] });
    if (url === '/api/reserve-projects/p1/confirm' && init?.method === 'POST') return ok({ id: 'p1', status: 'confirmed', version: 2, reserveVersion: 1 });
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  }));
}

describe('ReservesView final business baseline', () => {
  beforeEach(() => installFetch());
  afterEach(() => vi.unstubAllGlobals());

  it('lets readonly users inspect reserve projects while hiding all project mutation controls', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: readonly } });
    await flushPromises();
    expect(wrapper.text()).toContain('储备A');
    expect(wrapper.text()).toContain('当前账号只能查看储备项目');
    expect(wrapper.find('[data-test="create-project"]').exists()).toBe(false);
  });

  it('creates a reserve project from abstract demand links without inheriting demand material quantities', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="create-demand-d1"]').setValue(true);
    await wrapper.get('[data-test="project-name"]').setValue('新储备');
    await wrapper.get('[data-test="create-project"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/reserve-projects' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      name: '新储备', year: null, owner: null, demandIds: ['d1'], materials: [],
    });
  });

  it('updates demand provenance independently from project material requirements', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="open-project-p1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="project-demand-d1"]').setValue(false);
    await wrapper.get('[data-test="project-demand-d2"]').setValue(true);
    await wrapper.get('[data-test="save-demand-links"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/reserve-projects/p1/demands' && init?.method === 'PUT');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({ expectedVersion: 1, demandIds: ['d2'] });
  });

  it('revises project materials with fixed-point quantity and unit price plus an explicit reason', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="open-project-p1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="material-quantity-pm1"]').setValue('1.5');
    await wrapper.get('[data-test="material-price-pm1"]').setValue('12.3456');
    await wrapper.get('[data-test="material-revision-reason"]').setValue('设计复核调整');
    await wrapper.get('[data-test="save-project-materials"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/reserve-projects/p1/materials' && init?.method === 'PUT');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      expectedVersion: 1,
      reason: '设计复核调整',
      materials: [{
        id: 'pm1', materialId: null, model: 'JX-01', unit: '套', requiredQuantityScaled: 15000,
        unitPriceScaled: 123456, reserveCategoryId: 'cat1',
      }],
    });
  });

  it('confirms the currently loaded reserve version instead of a stale hard-coded version', async () => {
    const wrapper = mount(ReservesView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="open-project-p1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test="confirm-project"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/reserve-projects/p1/confirm' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({ expectedVersion: 1, reason: null });
  });
});
