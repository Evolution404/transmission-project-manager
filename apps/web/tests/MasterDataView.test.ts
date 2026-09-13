import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue');
  const wrap = (name: string) => defineComponent({ name, setup(_, { slots }) { return () => h('div', [slots['header-extra']?.(), slots.default?.(), slots.footer?.()]); } });
  return {
    NAlert: wrap('NAlert'), NCard: wrap('NCard'), NEmpty: wrap('NEmpty'), NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NSpace: wrap('NSpace'), NTag: wrap('NTag'),
    NButton: defineComponent({ props: { disabled: Boolean }, emits: ['click'], setup(p, { slots, emit }) { return () => h('button', { disabled: p.disabled, onClick: () => emit('click') }, slots.default?.()); } }),
    NInput: defineComponent({ props: ['value'], emits: ['update:value'], setup(p, { emit }) { return () => h('textarea', { value: p.value, onInput: (e: Event) => emit('update:value', (e.target as HTMLTextAreaElement).value) }); } }),
    NSelect: defineComponent({ props: ['value', 'options'], emits: ['update:value'], setup(p, { emit }) { return () => h('select', { value: p.value, onChange: (e: Event) => emit('update:value', (e.target as HTMLSelectElement).value) }, p.options?.map((o: { value: string; label: string }) => h('option', { value: o.value }, o.label))); } }),
    NSwitch: wrap('NSwitch'),
    NModal: defineComponent({ props: ['show'], setup(p, { slots }) { return () => p.show ? h('div', [slots.default?.(), slots.footer?.()]) : null; } }),
    NDataTable: defineComponent({ props: ['data', 'columns'], setup(p) { return () => h('div', p.data.map((r: Record<string, unknown>) => h('div', p.columns.map((c: { key: string; render?: (r: Record<string, unknown>) => unknown }) => h('span', c.render ? c.render(r) as never : String(r[c.key] ?? '')))))); } }),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});
import MasterDataView from '../src/views/MasterDataView.vue';
const admin = { id: 'a', role: 'admin' } as CurrentUser;
const voltages = [{ id: 'v1', displayName: '110kV', enabled: true, version: 1 }, { id: 'v2', displayName: '220kV', enabled: true, version: 1 }];
const line = { id: 'l1', voltageLevelId: 'v1', voltageLevelName: '110kV', lineName: '甲线', enabled: true, version: 1 };
const tower = { id: 't1', lineId: 'l1', lineName: '甲线', towerNo: '#20+1', sortIndex: 2, towerType: null, enabled: true, version: 3 };
const ok = (items: unknown[]) => new Response(JSON.stringify({ ok: true, data: { items } }), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method) return ok([]);
  if (url === '/api/master/voltage-levels') return ok(voltages);
  if (url.startsWith('/api/master/lines?voltageLevelId=v1')) return ok([line]);
  if (url.startsWith('/api/master/lines?voltageLevelId=v2')) return ok([]);
  if (url.startsWith('/api/master/towers?lineId=l1')) return ok([tower]);
  throw new Error(`unexpected ${url}`);
})));
afterEach(() => vi.unstubAllGlobals());

it('drills into parents, loads only selected children and clears stale tower selection', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/api/master/towers'))).toBe(false);
  await w.get('[data-test="select-voltage-v1"]').trigger('click'); await flushPromises();
  expect(w.get('[data-test="master-columns"]').attributes('data-step')).toBe('lines');
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  expect(w.text()).toContain('#20+1');
  expect(w.get('[data-test="master-columns"]').attributes('data-step')).toBe('towers');
  await w.get('[data-test="select-voltage-v2"]').trigger('click'); await flushPromises();
  expect(w.text()).not.toContain('#20+1');
  await w.get('[data-test="back-voltage"]').trigger('click');
  expect(w.get('[data-test="master-columns"]').attributes('data-step')).toBe('voltage');
});

it('bulk paste creates new towers and submits current versions for existing towers', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  await w.get('[data-test="open-bulk-towers"]').trigger('click');
  await w.get('[data-test="bulk-tower-text"]').setValue('#20+1\t2\t角钢塔\t停用\nG1\t3\t\t启用');
  await w.get('[data-test="save-bulk-towers"]').trigger('click'); await flushPromises();
  const call = vi.mocked(fetch).mock.calls.find(([u, init]) => String(u).endsWith('/towers/batch') && init?.method === 'POST');
  expect(call).toBeTruthy();
  expect(JSON.parse(String(call![1]!.body))).toEqual({ items: [
    { id: 't1', expectedVersion: 3, towerNo: '#20+1', sortIndex: 2, towerType: '角钢塔', enabled: false },
    { towerNo: 'G1', sortIndex: 3, towerType: null, enabled: true },
  ] });
});

it('readonly users navigate the same hierarchy without mutation controls', async () => {
  const w = mount(MasterDataView, { props: { currentUser: { ...admin, role: 'readonly' } } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  expect(w.text()).toContain('#20+1');
  for (const label of ['新增电压等级', '新增线路', '新增杆塔', '编辑', '删除', '批量维护']) expect(w.text()).not.toContain(label);
});
