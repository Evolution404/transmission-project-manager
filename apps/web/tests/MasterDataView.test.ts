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
const line = { id: 'l1', voltageLevelId: 'v1', voltageLevelName: '110kV', lineName: '甲线', enabled: true, version: 1, towerOrderVersion: 1 };
const tower = { id: 't1', lineId: 'l1', lineName: '甲线', towerNo: '#020-1', sortRank: 2000, towerType: null, enabled: true, version: 3 };
const ok = (items: unknown[]) => new Response(JSON.stringify({ ok: true, data: { items } }), { headers: { 'Content-Type': 'application/json' } });
const data = (value: unknown) => new Response(JSON.stringify({ ok: true, data: value }), { headers: { 'Content-Type': 'application/json' } });
let importOrderVersion = 1;
beforeEach(() => {
  importOrderVersion = 1;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method && url.endsWith('/towers/import-chunk')) {
    const body = JSON.parse(String(init.body)) as { items: Array<{ action: string }> };
    const created = body.items.filter((item) => item.action === 'create').length;
    if (created) importOrderVersion += 1;
    return data({ created, updated: body.items.length - created, towerOrderVersion: importOrderVersion, items: [] });
  }
  if (init?.method) return ok([]);
  if (url === '/api/master/voltage-levels') return ok(voltages);
  if (url.startsWith('/api/master/lines?voltageLevelId=v1')) return ok([line]);
  if (url.startsWith('/api/master/lines?voltageLevelId=v2')) return ok([]);
  if (url.startsWith('/api/master/towers?lineId=l1')) return ok([tower]);
  throw new Error(`unexpected ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('drills into parents, loads only selected children and clears stale tower selection', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/api/master/towers'))).toBe(false);
  await w.get('[data-test="select-voltage-v1"]').trigger('click'); await flushPromises();
  expect(w.get('[data-test="master-columns"]').attributes('data-step')).toBe('lines');
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  expect(w.text()).toContain('#020-1');
  expect(w.get('[data-test="master-columns"]').attributes('data-step')).toBe('towers');
  await w.get('[data-test="select-voltage-v2"]').trigger('click'); await flushPromises();
  expect(w.text()).not.toContain('#020-1');
  await w.get('[data-test="back-voltage"]').trigger('click');
  expect(w.get('[data-test="master-columns"]').attributes('data-step')).toBe('voltage');
});

it('previews a large paste once and automatically sends hidden safe import chunks without sort ranks', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  await w.get('[data-test="open-bulk-towers"]').trigger('click');
  const paste = Array.from({ length: 45 }, (_, index) => `${101 + index}\t角钢塔\t启用`).join('\n');
  await w.get('[data-test="bulk-tower-text"]').setValue(paste);
  await w.get('[data-test="preview-bulk-towers"]').trigger('click'); await flushPromises();
  expect(w.get('[data-test="tower-import-preview"]').text()).toContain('共 45 行');
  expect(w.get('[data-test="tower-import-preview"]').text()).toContain('新增 45');
  await w.get('[data-test="save-bulk-towers"]').trigger('click'); await flushPromises();
  const calls = vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).endsWith('/towers/import-chunk') && init?.method === 'POST');
  expect(calls).toHaveLength(3);
  expect(calls.map(([, init]) => JSON.parse(String(init!.body)).items.length)).toEqual([20, 20, 5]);
  for (const [, init] of calls) {
    const body = JSON.parse(String(init!.body));
    expect(body.items.every((item: Record<string, unknown>) => !('sortRank' in item))).toBe(true);
    expect(new Headers(init!.headers).get('Idempotency-Key')).toBeTruthy();
  }
});

it('resumes from the failed chunk and reuses its idempotency key without resending completed chunks', async () => {
  let orderVersion = 1;
  let importAttempt = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && url.endsWith('/towers/import-chunk')) {
      importAttempt += 1;
      const body = JSON.parse(String(init.body)) as { items: Array<{ action: string }> };
      if (importAttempt === 2) return new Response(JSON.stringify({ ok: false, error: { code: 'TEMPORARY_FAILURE', message: '暂时失败' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      if (body.items.some((item) => item.action === 'create')) orderVersion += 1;
      return data({ created: body.items.length, updated: 0, towerOrderVersion: orderVersion, items: [] });
    }
    if (init?.method) return ok([]);
    if (url === '/api/master/voltage-levels') return ok(voltages);
    if (url.startsWith('/api/master/lines?voltageLevelId=v1')) return ok([line]);
    if (url.startsWith('/api/master/towers?lineId=l1')) return ok([tower]);
    throw new Error(`unexpected ${url}`);
  }));

  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  await w.get('[data-test="open-bulk-towers"]').trigger('click');
  await w.get('[data-test="bulk-tower-text"]').setValue(Array.from({ length: 25 }, (_, index) => `${301 + index}\t\t启用`).join('\n'));
  await w.get('[data-test="preview-bulk-towers"]').trigger('click'); await flushPromises();
  await w.get('[data-test="save-bulk-towers"]').trigger('click'); await flushPromises();

  let calls = vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).endsWith('/towers/import-chunk') && init?.method === 'POST');
  expect(calls.map(([, init]) => JSON.parse(String(init!.body)).items.length)).toEqual([20, 5]);
  const failedKey = new Headers(calls[1]![1]!.headers).get('Idempotency-Key');

  await w.get('[data-test="save-bulk-towers"]').trigger('click'); await flushPromises();
  calls = vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).endsWith('/towers/import-chunk') && init?.method === 'POST');
  expect(calls.map(([, init]) => JSON.parse(String(init!.body)).items.length)).toEqual([20, 5, 5]);
  expect(new Headers(calls[2]![1]!.headers).get('Idempotency-Key')).toBe(failedKey);
});

it('single tower creation sends no manual order and explains automatic numeric placement', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  await w.get('[data-test="open-new-tower"]').trigger('click');
  expect(w.text()).toContain('按规范化编号自动插入合适位置');
  expect(w.text()).not.toContain('线路顺序');
  await w.get('[data-test="tower-number-input"]').setValue('10-1');
  await w.get('[data-test="save-tower"]').trigger('click'); await flushPromises();
  const call = vi.mocked(fetch).mock.calls.find(([u, init]) => String(u) === '/api/master/towers' && init?.method === 'POST');
  expect(call).toBeTruthy();
  const body = JSON.parse(String(call![1]!.body));
  expect(body.towerNo).toBe('#010-1');
  expect(body).not.toHaveProperty('sortRank');
});

it('readonly users navigate the same hierarchy without mutation controls', async () => {
  const w = mount(MasterDataView, { props: { currentUser: { ...admin, role: 'readonly' } } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  expect(w.text()).toContain('#020-1');
  for (const label of ['新增电压等级', '新增线路', '新增杆塔', '编辑', '删除', '批量维护']) expect(w.text()).not.toContain(label);
});
