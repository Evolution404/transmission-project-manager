import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

const { chartSetOption, chartResize, chartClear } = vi.hoisted(() => ({ chartSetOption: vi.fn(), chartResize: vi.fn(), chartClear: vi.fn() }));
const routeQuery = vi.hoisted(() => ({} as Record<string, string>));
const replace = vi.fn();
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery }), useRouter: () => ({ replace }) }));
vi.mock('../src/charts/echarts', () => ({ init: () => ({ setOption: chartSetOption, resize: chartResize, clear: chartClear, dispose: vi.fn() }) }));
vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({ name, setup(_, { slots }) { return () => vue.h('div', { 'data-stub': name }, [slots['header-extra']?.(), slots.default?.()]); } });
  const NButton = vue.defineComponent({ name: 'NButton', props: { disabled: Boolean }, emits: ['click'], setup(props, { emit, slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); } });
  const NInput = vue.defineComponent({ name: 'NInput', props: { value: { type: [String, Number], default: '' } }, emits: ['update:value'], setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value) }); } });
  const NSelect = vue.defineComponent({ name: 'NSelect', props: { value: [String, Number], options: { type: Array, default: () => [] } }, emits: ['update:value'], setup(props, { emit, attrs }) { return () => vue.h('select', { ...attrs, value: props.value ?? '', onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value || null) }, [vue.h('option', { value: '' }, '—'), ...(props.options as Array<{label:string;value:string|number}>).map((item) => vue.h('option', { value: item.value }, item.label))]); } });
  const NDataTable = vue.defineComponent({
    name: 'NDataTable',
    props: { data: { type: Array, default: () => [] }, columns: { type: Array, default: () => [] } },
    setup(props) {
      return () => vue.h('div', (props.data as Array<Record<string, unknown>>).map((row) =>
        vue.h('div', (props.columns as Array<{ key?: string; render?: (row: Record<string, unknown>) => unknown }>).map((column) =>
          vue.h('span', column.render ? column.render(row) as never : String(row[column.key ?? ''] ?? '')),
        )),
      ));
    },
  });
  const NTabPane = vue.defineComponent({ name: 'NTabPane', props: { name: String, tab: String }, setup(props, { slots }) { return () => vue.h('section', { 'data-tab': props.name }, [vue.h('h3', props.tab), slots.default?.()]); } });
  const NTabs = vue.defineComponent({ name: 'NTabs', props: { value: String }, emits: ['update:value'], setup(props, { slots, attrs }) { return () => vue.h('div', { ...attrs, 'data-stub': 'NTabs', 'data-value': props.value }, slots.default?.()); } });
  const NStatistic = vue.defineComponent({ name: 'NStatistic', props: { label: String, value: [String, Number] }, setup(props) { return () => vue.h('div', `${props.label ?? ''}${props.value ?? ''}`); } });
  return { NAlert: wrap('NAlert'), NButton, NCard: wrap('NCard'), NDataTable, NEmpty: wrap('NEmpty'), NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NGrid: wrap('NGrid'), NGridItem: wrap('NGridItem'), NInput, NSelect, NSpace: wrap('NSpace'), NSpin: wrap('NSpin'), NStatistic, NTabPane, NTabs, NTag: wrap('NTag'), useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }) };
});

import AnalysisView from '../src/views/AnalysisView.vue';

const admin: CurrentUser = { id: 'a', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1, scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null, lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session' };
const readonly: CurrentUser = { ...admin, id: 'r', username: 'reader', role: 'readonly' };
const framework = { id: 'fw1', code: 'FW-1', name: '框架一', totalAmountFen: 1_000_000, annualTargetFen: 800_000, startDate: '2026-01-01', endDate: '2026-12-31', version: 1, createdAt: '', updatedAt: '' };
const framework2 = { ...framework, id: 'fw2', code: 'FW-2', name: '框架二' };
const project = { id: 'p1', name: '项目一', year: 2026, status: 'confirmed', frameworkId: 'fw1', version: 3 };
const project2 = { ...project, id: 'p2', name: '项目二', frameworkId: 'fw2' };
const rule = { id: 'rule1', version: 2, mode: 'ratio', thresholdBasisPoints: 8000, effectiveFrom: '', createdAt: '' };
const plan = { id: 'plan1', projectId: 'p1', businessYear: 2026, month: 9, targetAmountFen: 100_000, version: 4, createdAt: '', updatedAt: '' };

function ok(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/frameworks') return ok({ items: [framework, framework2] });
    if (url === '/api/finance/projects') return ok({ items: [project, project2] });
    if (url.startsWith('/api/analysis/dashboard?')) return ok({ asOf: '2026-09-12', projectCount: 1, demandCount: 2, unreleasedProjectCount: 1, pendingSettlementCount: 1, activeAlertCount: 1 });
    if (url === '/api/analysis/reserve-remaining') return ok({ allocatedQuantityScaled: 1000000, releasedQuantityScaled: 400000, knownRemainingFen: 60000, missingPriceCount: 0, unclassifiedRemainingFen: 0, unscopedCommonCostFen: 0, categories: [{ reserveCategoryId: 'c1', categoryKey: 'cat', label: '防断线', knownRemainingFen: 60000 }] });
    if (url === '/api/analysis/rules') return ok(rule);
    if (url.startsWith('/api/milestones/due?')) return ok({ items: [] });
    if (url === '/api/alerts') return ok({ items: [{ id: 'alert1', ruleKey: 'analysis.lag', ruleVersion: 2, objectType: 'framework', objectId: 'fw1', periodKey: '2026-09', severity: 'warning', state: 'active', message: '框架一 实际进度低于同期计划', firstSeenAt: '', lastSeenAt: '', resolvedAt: null }] });
    if (url === '/api/backups') return ok({ items: [] });
    if (url === '/api/notification-contacts') return ok({ items: [] });
    if (url === '/api/notification-outbox') return ok({ items: [] });
    if (url.startsWith('/api/analysis/frameworks/fw1/progress?') || url.startsWith('/api/analysis/frameworks/fw2/progress?')) {
      const second = url.includes('/fw2/');
      return ok({ frameworkId: second ? 'fw2' : 'fw1', frameworkCode: second ? 'FW-2' : 'FW-1', frameworkName: second ? '框架二' : '框架一', businessYear: 2026, asOf: '2026-09-12', annualTargetFen: 800000, annualTargetConfigured: true, plannedToDateFen: 600000, actualToDateFen: 400000, plannedProgressBasisPoints: 7500, actualProgressBasisPoints: 5000, attainmentBasisPoints: 6667, lagging: true, planSource: 'custom', rule, quarters: [{ quarter: 1, cumulativeTargetBasisPoints: 2500, status: 'ended' }, { quarter: 2, cumulativeTargetBasisPoints: 5000, status: 'ended' }, { quarter: 3, cumulativeTargetBasisPoints: 7500, status: 'in_progress' }, { quarter: 4, cumulativeTargetBasisPoints: 10000, status: 'upcoming' }] });
    }
    if (url.startsWith('/api/analysis/projects/gaps?')) return ok({ items: [{ projectId: 'p1', projectName: '项目一', plannedToDateFen: 600000, actualToDateFen: 400000, gapFen: 200000 }] });
    if (url === '/api/analysis/plans?frameworkId=fw1&year=2026') return ok({ items: [plan] });
    if (url === '/api/analysis/plans?frameworkId=fw2&year=2026') return ok({ items: [] });
    if (url.startsWith('/api/reports/monthly?')) return ok({ items: [] });
    if (url === '/api/analysis/plans/p1/2026/9' && init?.method === 'PUT') return ok({ ...plan, targetAmountFen: 123456, version: 5 });
    if (url === '/api/analysis/rules' && init?.method === 'PUT') return ok({ ...rule, version: 3, thresholdBasisPoints: 8500 });
    if (url === '/api/backups' && init?.method === 'POST') return ok({ id: 'b1', backupDate: '2026-09-12', kind: 'daily', status: 'pending', currentTableIndex: 0, cursorRowid: 0, manifestKey: null, chunkCount: 0, error: null, startedAt: null, completedAt: null, verifiedAt: null, createdAt: '', updatedAt: '' }, 201);
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  }));
}

describe('AnalysisView P6 behavior', () => {
  beforeEach(() => {
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
    replace.mockReset();
    chartSetOption.mockReset();
    chartResize.mockReset();
    chartClear.mockReset();
    document.documentElement.style.setProperty('--ui-text', '#f8fafc');
    document.documentElement.style.setProperty('--ui-text-secondary', '#cbd5e1');
    document.documentElement.style.setProperty('--ui-border', '#334155');
    document.documentElement.style.setProperty('--ui-surface-raised', '#111827');
    document.documentElement.style.setProperty('--ui-accent', '#60a5fa');
    installFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
  });

  it('restores the analysis tab from the URL and persists tab navigation', async () => {
    routeQuery.tab = 'alerts';
    const wrapper = mount(AnalysisView, { props: { currentUser: readonly } });
    await flushPromises();
    const tabs = wrapper.findComponent({ name: 'NTabs' });
    expect(tabs.props('value')).toBe('alerts');
    tabs.vm.$emit('update:value', 'reserve');
    await flushPromises();
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'reserve' } });
  });

  it('restores the selected framework from the URL and preserves the active tab when switching frameworks', async () => {
    routeQuery.framework = 'fw2';
    routeQuery.tab = 'alerts';
    const wrapper = mount(AnalysisView, { props: { currentUser: readonly } });
    await flushPromises();

    expect(wrapper.get('[data-test="analysis-framework"]').attributes('value')).toBe('fw2');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/analysis/frameworks/fw2/progress?'))).toBe(true);

    await wrapper.get('[data-test="analysis-framework"]').setValue('fw1');
    await flushPromises();
    expect(replace).toHaveBeenCalledWith({ query: { framework: 'fw1', tab: 'alerts' } });
  });

  it('ignores a stale framework analysis response that returns after a newer selection', async () => {
    const wrapper = mount(AnalysisView, { props: { currentUser: readonly } });
    await flushPromises();
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const staleGate = deferred<void>();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/analysis/frameworks/fw2/') || url.includes('frameworkId=fw2')) await staleGate.promise;
      return fallback(input, init);
    });

    await wrapper.get('[data-test="analysis-framework"]').setValue('fw2');
    await Promise.resolve();
    await wrapper.get('[data-test="analysis-framework"]').setValue('fw1');
    await flushPromises();
    expect(wrapper.get('.analysis-warning').text()).toContain('框架一');

    staleGate.resolve();
    await flushPromises();
    expect(wrapper.get('[data-test="analysis-framework"]').attributes('value')).toBe('fw1');
    expect(wrapper.get('.analysis-warning').text()).toContain('框架一');
  });

  it('surfaces the latest framework analysis failure with an in-page retry path', async () => {
    const wrapper = mount(AnalysisView, { props: { currentUser: readonly } });
    await flushPromises();
    chartClear.mockReset();
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    let fail = true;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (fail && url.startsWith('/api/analysis/frameworks/fw2/progress?')) throw new Error('框架分析读取失败');
      return fallback(input, init);
    });

    await wrapper.get('[data-test="analysis-framework"]').setValue('fw2');
    await flushPromises();
    expect(wrapper.text()).toContain('框架分析读取失败');
    expect(chartClear).toHaveBeenCalledTimes(1);
    fail = false;
    await wrapper.get('[data-test="retry-analysis"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('框架分析读取失败');
    expect(wrapper.get('.analysis-warning').text()).toContain('框架二');
  });

  it('ignores stale milestone results after the statistics date changes again', async () => {
    const wrapper = mount(AnalysisView, { props: { currentUser: readonly } });
    await flushPromises();
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const staleGate = deferred<void>();
    const milestone = (id: string, title: string, dueDate: string) => ({
      id, businessYear: 2026, title, owner: null, projectId: null, datePrecision: 'day', month: Number(dueDate.slice(5, 7)), specificDate: dueDate,
      leadDays: [7, 3, 0], status: 'open', version: 1, createdAt: '', updatedAt: '', dueMonth: dueDate.slice(0, 7), dueDate,
      needsDate: false, reminderDue: true, reminderLeadDays: 0, overdue: false,
    });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/milestones/due?asOf=2026-08-31') {
        await staleGate.promise;
        return ok({ items: [milestone('m-old', '旧日期事项', '2026-08-31')] });
      }
      if (url === '/api/milestones/due?asOf=2026-09-30') return ok({ items: [milestone('m-new', '新日期事项', '2026-09-30')] });
      return fallback(input, init);
    });

    await wrapper.get('[data-test="analysis-as-of"]').setValue('2026-08-31');
    await Promise.resolve();
    await wrapper.get('[data-test="analysis-as-of"]').setValue('2026-09-30');
    await flushPromises();
    expect(wrapper.text()).toContain('新日期事项');
    expect(wrapper.text()).not.toContain('旧日期事项');

    staleGate.resolve();
    await flushPromises();
    expect(wrapper.text()).toContain('新日期事项');
    expect(wrapper.text()).not.toContain('旧日期事项');
  });

  it('surfaces the latest statistics-date load failure instead of rejecting silently', async () => {
    const wrapper = mount(AnalysisView, { props: { currentUser: readonly } });
    await flushPromises();
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    let fail = true;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (fail && url === '/api/milestones/due?asOf=2026-10-01') throw new Error('统计日期事项读取失败');
      return fallback(input, init);
    });

    await wrapper.get('[data-test="analysis-as-of"]').setValue('2026-10-01');
    await flushPromises();
    expect(wrapper.text()).toContain('统计日期事项读取失败');
    fail = false;
    await wrapper.get('[data-test="retry-analysis"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('统计日期事项读取失败');
    expect((wrapper.get('[data-test="analysis-as-of"]').element as HTMLInputElement).value).toBe('2026-10-01');
  });

  it('shows real progress, reserve categories and active alerts', async () => {
    const wrapper = mount(AnalysisView, { props: { currentUser: readonly } });
    await flushPromises();
    expect(wrapper.text()).toContain('框架一');
    expect(wrapper.text()).toContain('66.67%');
    expect(wrapper.text()).toContain('防断线');
    expect(wrapper.text()).toContain('实际进度低于同期计划');
    expect(wrapper.find('[data-test="save-plan"]').exists()).toBe(false);
  });

  it('renders charts with design tokens instead of light-only ECharts defaults', async () => {
    mount(AnalysisView, { props: { currentUser: readonly } });
    await flushPromises();
    expect(chartSetOption).toHaveBeenCalled();
    expect(chartSetOption.mock.calls[0]?.[0]).toMatchObject({
      tooltip: { backgroundColor: '#111827', borderColor: '#334155', textStyle: { color: '#f8fafc' } },
      xAxis: { axisLabel: { color: '#cbd5e1' }, axisLine: { lineStyle: { color: '#334155' } } },
      series: [{ itemStyle: { color: '#60a5fa' } }],
    });
  });

  it('updates an existing monthly plan with exact fen and its current version', async () => {
    const wrapper = mount(AnalysisView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="plan-project"]').setValue('p1');
    await wrapper.get('[data-test="plan-month"]').setValue('9');
    await wrapper.get('[data-test="plan-amount"]').setValue('1234.56');
    await wrapper.get('[data-test="save-plan"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/analysis/plans/p1/2026/9' && init?.method === 'PUT');
    expect(JSON.parse(String(call![1]!.body))).toEqual({ expectedVersion: 4, targetAmountFen: 123456 });
  });

  it('converts the rule percentage to basis points without loading system operations', async () => {
    const wrapper = mount(AnalysisView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="rule-threshold"]').setValue('85');
    await wrapper.get('[data-test="save-rule"]').trigger('click');
    await flushPromises();
    const ruleCall = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/analysis/rules' && init?.method === 'PUT');
    expect(JSON.parse(String(ruleCall![1]!.body))).toEqual({ expectedVersion: 2, mode: 'ratio', thresholdBasisPoints: 8500 });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => ['/api/backups', '/api/notification-contacts', '/api/notification-outbox'].includes(String(url)))).toBe(false);
    expect(wrapper.text()).not.toContain('备份运维');
    expect(wrapper.text()).not.toContain('Outbox');
  });
});
