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
    NDropdown: defineComponent({ inheritAttrs: false, props: ['options'], emits: ['select'], setup(p, { slots, emit, attrs }) { return () => h('div', attrs, [slots.default?.(), ...(p.options ?? []).map((o: { key: string; label: string }) => h('button', { 'data-dropdown-key': o.key, 'aria-label': o.label, onClick: () => emit('select', o.key) }))]); } }),
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
const tower2 = { id: 't2', lineId: 'l1', lineName: '甲线', towerNo: '#030', sortRank: 3000, towerType: null, enabled: true, version: 1 };
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
  if (init?.method && url.endsWith('/towers/reorder')) {
    importOrderVersion += 1;
    return data({ changed: true, towerOrderVersion: importOrderVersion, towerIds: JSON.parse(String(init.body)).towerIds });
  }
  if (init?.method && url.endsWith('/lines/l1/rename')) {
    const body = JSON.parse(String(init.body));
    return data({ ...line, lineName: body.lineName, version: line.version + 1 });
  }
  if (init?.method && url.endsWith('/towers/t1/rename')) {
    const body = JSON.parse(String(init.body));
    return data({ ...tower, towerNo: body.towerNo, version: tower.version + 1 });
  }
  if (init?.method) return ok([]);
  if (url === '/api/master/voltage-levels') return ok(voltages);
  if (url === '/api/master/lines/l1/name-history') return ok([]);
  if (url === '/api/master/towers/t1/number-history') return ok([]);
  if (url.startsWith('/api/master/lines?')) return url.includes('voltageLevelId=v2') ? ok([]) : ok([line]);
  if (url.startsWith('/api/master/towers?lineId=l1')) return ok([tower, tower2]);
  throw new Error(`unexpected ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('starts with a line-centric list and opens a full-width line detail without a three-column hierarchy', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/api/master/towers'))).toBe(false);
  expect(w.findAll('[data-test="line-home"]')).toHaveLength(1);
  expect(w.text()).toContain('线路台账');
  expect(w.text()).not.toContain('01');
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  expect(w.text()).toContain('#020-1');
  expect(w.findAll('[data-test="line-detail"]')).toHaveLength(1);
  expect(w.find('[data-test="tower-mobile-list"]').exists()).toBe(true);
  expect(w.find('[data-test="tower-mobile-card-t1"]').exists()).toBe(true);
  expect(w.text()).toContain('110kV');
  await w.get('[data-test="back-lines"]').trigger('click');
  expect(w.findAll('[data-test="line-home"]')).toHaveLength(1);
  expect(w.text()).not.toContain('#020-1');
});

it('sends line status filtering to the server before pagination instead of filtering only the loaded page', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="line-status-filter"]').setValue('disabled');
  await flushPromises();
  const lineCalls = vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/master/lines?'));
  expect(lineCalls.at(-1)).toContain('enabled=false');
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
    if (url.startsWith('/api/master/lines?')) return ok([line]);
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

it('full-list mode requires coverage and submits the source row order as stable tower ids', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  await w.get('[data-test="open-bulk-towers"]').trigger('click');
  await w.get('[data-test="tower-import-mode"]').setValue('full-order');
  await w.get('[data-test="bulk-tower-text"]').setValue('30\t\t启用\n20-1\t\t启用');
  await w.get('[data-test="preview-bulk-towers"]').trigger('click'); await flushPromises();
  expect(w.get('[data-test="tower-import-preview"]').text()).toContain('完整清单校验通过');
  await w.get('[data-test="save-bulk-towers"]').trigger('click'); await flushPromises();
  const reorder = vi.mocked(fetch).mock.calls.find(([u, init]) => String(u).endsWith('/towers/reorder') && init?.method === 'POST');
  expect(reorder).toBeTruthy();
  expect(JSON.parse(String(reorder![1]!.body)).towerIds).toEqual(['t2', 't1']);
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

it('uses dedicated line and tower rename actions instead of ordinary edit fields', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  await w.get('[data-test="line-more-actions"]').get('[data-dropdown-key="rename"]').trigger('click');
  await w.get('[data-test="line-rename-input"]').setValue('甲线新名');
  await w.get('[data-test="save-line-rename"]').trigger('click'); await flushPromises();
  const lineRename = vi.mocked(fetch).mock.calls.find(([u, init]) => String(u).endsWith('/lines/l1/rename') && init?.method === 'POST');
  expect(JSON.parse(String(lineRename![1]!.body)).lineName).toBe('甲线新名');

  await w.get('[data-test="tower-more-t1"]').get('[data-dropdown-key="rename"]').trigger('click');
  await w.get('[data-test="tower-rename-input"]').setValue('21-1');
  await w.get('[data-test="save-tower-rename"]').trigger('click'); await flushPromises();
  const towerRename = vi.mocked(fetch).mock.calls.find(([u, init]) => String(u).endsWith('/towers/t1/rename') && init?.method === 'POST');
  expect(JSON.parse(String(towerRename![1]!.body)).towerNo).toBe('#021-1');
});

it('manual order editor moves by business position and saves one complete stable-id order', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  await w.get('[data-test="open-order-editor"]').trigger('click'); await flushPromises();
  await w.get('[data-test="order-moving"]').setValue('t2');
  await w.get('[data-test="order-target"]').setValue('t1');
  await w.get('[data-test="apply-order-move"]').trigger('click');
  await w.get('[data-test="save-order"]').trigger('click'); await flushPromises();
  const reorder = vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).endsWith('/towers/reorder') && init?.method === 'POST').at(-1);
  expect(JSON.parse(String(reorder![1]!.body)).towerIds).toEqual(['t2', 't1']);
});

it('order editor exposes touch-friendly step controls and descriptive target labels', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  await w.get('[data-test="open-order-editor"]').trigger('click'); await flushPromises();

  expect(w.text()).toContain('1 · #020-1');
  expect(w.text()).toContain('2 · #030');
  expect(w.find('[data-test="order-up-t2"]').exists()).toBe(true);
  expect(w.find('[data-test="order-down-t1"]').exists()).toBe(true);

  await w.get('[data-test="order-up-t2"]').trigger('click');
  await w.get('[data-test="save-order"]').trigger('click'); await flushPromises();
  const reorder = vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).endsWith('/towers/reorder') && init?.method === 'POST').at(-1);
  expect(JSON.parse(String(reorder![1]!.body)).towerIds).toEqual(['t2', 't1']);
});

it('keeps only frequent line and tower actions visible while secondary actions live under more menus', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  expect(w.get('[data-test="line-detail"]').text()).toContain('更多操作');
  expect(w.get('[data-test="line-detail"]').text()).toContain('新增杆塔');
  expect(w.get('[data-test="line-detail"]').text()).toContain('导入杆塔');
  expect(w.get('[data-test="line-detail"]').text()).toContain('调整顺序');
  expect(w.get('[data-test="line-detail"]').text()).not.toContain('线路更名');
  expect(w.get('[data-test="line-detail"]').text()).not.toContain('名称历史');
  expect(w.find('[data-test="tower-more-t1"]').exists()).toBe(true);
});

it('removes a tower locally without reloading unrelated voltage data and advances the order version', async () => {
  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  const voltageCallsBefore = vi.mocked(fetch).mock.calls.filter(([u]) => String(u) === '/api/master/voltage-levels').length;

  await w.get('[data-test="tower-more-t1"]').get('[data-dropdown-key="delete"]').trigger('click'); await flushPromises();

  const voltageCallsAfter = vi.mocked(fetch).mock.calls.filter(([u]) => String(u) === '/api/master/voltage-levels').length;
  expect(voltageCallsAfter).toBe(voltageCallsBefore);
  expect(w.get('[data-test="line-detail"]').text()).toContain('1 基杆塔');
  expect(w.get('[data-test="line-detail"]').text()).not.toContain('#020-1');

  await w.get('[data-test="open-order-editor"]').trigger('click'); await flushPromises();
  await w.get('[data-test="save-order"]').trigger('click'); await flushPromises();
  const reorder = vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).endsWith('/towers/reorder') && init?.method === 'POST').at(-1);
  expect(JSON.parse(String(reorder![1]!.body)).expectedTowerOrderVersion).toBe(2);
});

it('recovers from an initial master-data load failure through one visible retry action', async () => {
  let voltageAttempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/master/voltage-levels') {
      voltageAttempts += 1;
      if (voltageAttempts === 1) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'TEMPORARY_FAILURE', message: '基础台账暂时不可用' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return ok(voltages);
    }
    if (url.startsWith('/api/master/lines?')) return ok([line]);
    if (url.startsWith('/api/master/towers?')) return ok([tower, tower2]);
    throw new Error(`unexpected ${url}`);
  }));

  const w = mount(MasterDataView, { props: { currentUser: admin } }); await flushPromises();
  expect(w.text()).toContain('基础台账暂时不可用');
  expect(w.find('[data-test="retry-master-data"]').exists()).toBe(true);

  await w.get('[data-test="retry-master-data"]').trigger('click'); await flushPromises();
  expect(voltageAttempts).toBe(2);
  expect(w.text()).not.toContain('基础台账暂时不可用');
  expect(w.text()).toContain('甲线');
});

it('readonly users can inspect line detail without mutation controls', async () => {
  const w = mount(MasterDataView, { props: { currentUser: { ...admin, role: 'readonly' } } }); await flushPromises();
  await w.get('[data-test="select-line-l1"]').trigger('click'); await flushPromises();
  expect(w.text()).toContain('#020-1');
  for (const label of ['新增线路', '新增杆塔', '编辑属性', '线路更名', '杆塔更名', '删除', '导入杆塔', '调整顺序', '台账设置']) expect(w.text()).not.toContain(label);
});
