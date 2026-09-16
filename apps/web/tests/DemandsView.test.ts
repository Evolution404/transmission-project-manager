import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import type { CurrentUser, ImportFieldMapping } from '@tpm/shared';

const { parseFileInWorker, sha256File, executeImportWorkflow, ImportReviewRequiredError, downloadDemandImportTemplate } = vi.hoisted(() => {
  class ReviewError extends Error {
    batchId: string;
    errorRows: number;
    warningRows: number;
    constructor(batchId: string, errorRows: number, warningRows: number) {
      super('IMPORT_REVIEW_REQUIRED');
      this.batchId = batchId;
      this.errorRows = errorRows;
      this.warningRows = warningRows;
    }
  }
  return {
    parseFileInWorker: vi.fn(),
    sha256File: vi.fn(),
    executeImportWorkflow: vi.fn(),
    ImportReviewRequiredError: ReviewError,
    downloadDemandImportTemplate: vi.fn(),
  };
});

vi.mock('../src/imports/demandTemplate', () => ({ downloadDemandImportTemplate }));
vi.mock('../src/imports/workerClient', () => ({ parseFileInWorker }));
vi.mock('../src/imports/workflow', () => ({
  sha256File,
  executeImportWorkflow,
  ImportReviewRequiredError,
  flattenParsedSheets: (parsed: { sheets: Array<{ name: string; rows: Array<{ rowNumber: number; cells: Record<string, unknown> }> }> }) =>
    parsed.sheets.flatMap((sheet) => sheet.rows.map((row) => ({ sheetName: sheet.name, rowNumber: row.rowNumber, cells: row.cells }))),
}));

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
    name: 'NSelect', props: { value: String, options: { type: Array, default: () => [] }, disabled: Boolean }, emits: ['update:value'],
    setup(props, { emit, attrs }) {
      return () => vue.h('select', { ...attrs, value: props.value, disabled: props.disabled, onChange: (e: Event) => emit('update:value', (e.target as HTMLSelectElement).value) },
        (props.options as Array<{ label: string; value: string }>).map((option) => vue.h('option', { value: option.value }, option.label)));
    },
  });
  const NModal = vue.defineComponent({
    name: 'NModal',
    props: { show: Boolean },
    emits: ['update:show'],
    setup(props, { slots, emit, attrs }) {
      return () => props.show
        ? vue.h('div', { ...attrs, 'data-stub': 'NModal' }, [slots.default?.(), slots.footer?.({ close: () => emit('update:show', false) })])
        : null;
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
    NAlert: wrap('NAlert'), NButton, NCard: wrap('NCard'), NDataTable, NEmpty: wrap('NEmpty'),
    NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NInput, NModal, NProgress: wrap('NProgress'), NSelect,
    NSpace: wrap('NSpace'), NSpin: wrap('NSpin'), NTabPane, NTabs: wrap('NTabs'), NTag: wrap('NTag'),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});

import DemandsView from '../src/views/DemandsView.vue';

const admin: CurrentUser = {
  id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};
const readonly: CurrentUser = { ...admin, id: 'read', username: 'read', role: 'readonly' };

function ok(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const expectedMapping: ImportFieldMapping = {
  sequenceNo: '序号', voltage: '电压等级', lineName: '线路名称', section: '杆段',
  materialModel: '物资型号', materialQuantity: '物资数量', unit: '单位', year: '年度', category: '类别',
};

describe('DemandsView P2 behavior', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/imports/batch-review') return ok({
        id: 'batch-review', status: 'review', errorRows: 1, warningRows: 1,
        rows: [{ id: 'r1', sheetName: '需求', rowNumber: 2, status: 'error', normalized: null, errors: [{ code: 'INVALID_QUANTITY', message: '物资数量不能为负数', field: 'materialQuantity' }], warnings: [{ code: 'MATERIAL_UNKNOWN', message: '未匹配标准物资' }] }],
      });
      if (url === '/api/demands/d1') return ok({
        id: 'd1', sequenceNo: '1', lineName: '龙城线', section: '#1', voltageRaw: '220kV', voltageVerified: null,
        year: 2026, category: '防断线', owner: null, createdAt: '2026-09-12T00:00:00.000Z',
        source: { type: 'import', batchId: 'b1', fileName: '需求.xlsx', fileSha256: 'a'.repeat(64), sheetName: '需求', rowNumber: 2, raw: { 线路名称: '龙城线' }, rows: [
          { fileName: '需求.xlsx', fileSha256: 'a'.repeat(64), sheetName: '需求', rowNumber: 2, raw: { 线路名称: '龙城线', 物资型号: 'JX-01' } },
          { fileName: '需求.xlsx', fileSha256: 'a'.repeat(64), sheetName: '需求', rowNumber: 3, raw: { 线路名称: '龙城线', 物资型号: 'JX-02' } },
        ] },
        materials: [{ id: 'dm1', rawModel: 'JX-01', quantityScaled: 10000, unit: '套', material: null }],
      });
      if (url === '/api/demands' && init?.method === 'POST') return new Response(JSON.stringify({ ok: true, data: {
        id: 'manual-1', sequenceNo: 'M-001', lineName: '手工需求线', section: '#1-#2', voltageRaw: '220kV', voltageVerified: '220kV',
        year: 2026, category: '临时补充', owner: '张三', createdAt: '2026-09-12T00:00:00.000Z',
        source: { type: 'manual', raw: {} },
        materials: [{ id: 'manual-dm-1', rawModel: 'JX-01', quantityScaled: 25000, unit: '套', material: null }],
      } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/demands')) return ok({ items: [{ id: 'd1', sequenceNo: '1', lineName: '龙城线', section: '#1', voltageRaw: '220kV', year: 2026, category: '防断线', owner: null, createdAt: '2026-09-12T00:00:00.000Z' }], nextCursor: null });
      if (url === '/api/import-mappings') return ok({ items: [] });
      if (url === '/api/master/voltage-levels') return ok({ items: [{ id: 'vl-ac-220', code: 'AC_220KV', displayName: '220kV', systemType: 'AC', nominalKv: 220, sortOrder: 30, enabled: true, version: 1 }] });
      if (url.startsWith('/api/master/lines?voltageLevelId=')) return ok({ items: [{ id: 'line-1', voltageLevelId: 'vl-ac-220', voltageLevelName: '220kV', lineCode: null, lineName: '手工需求线', enabled: true, version: 1, towerCount: 2 }] });
      if (url.startsWith('/api/master/towers?lineId=')) return ok({ items: [
        { id: 'tower-1', lineId: 'line-1', lineName: '手工需求线', towerNo: '#001', sortRank: 1000, towerType: null, enabled: true, version: 1 },
        { id: 'tower-2', lineId: 'line-1', lineName: '手工需求线', towerNo: '#002', sortRank: 2000, towerType: null, enabled: true, version: 1 },
      ] });
      if (url === '/api/materials' && init?.method === 'POST') return new Response(JSON.stringify({ ok: true, data: { id: 'm1', code: null, name: '线夹', model: 'JX-01', unit: '套', enabled: true, version: 1 } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/materials')) return ok({ items: [{ id: 'm1', code: 'MAT-001', name: '线夹', model: 'JX-01', unit: '套', enabled: true, version: 1 }] });
      throw new Error(`unexpected request ${url}`);
    }));
    parseFileInWorker.mockReset();
    sha256File.mockReset();
    executeImportWorkflow.mockReset();
    downloadDemandImportTemplate.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads the demand pool for readonly users but does not expose import/write controls', async () => {
    const wrapper = mount(DemandsView, { props: { currentUser: readonly } });
    await flushPromises();
    expect(wrapper.text()).toContain('龙城线');
    expect(wrapper.find('[data-test="mobile-demand-d1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="mobile-material-m1"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('仅管理员或项目管理角色可以导入需求');
    expect(wrapper.find('[data-test="file-input"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="add-material"]').exists()).toBe(false);
  });

  it('opens manual demand creation in a modal and supports any number of initial material lines', async () => {
    const wrapper = mount(DemandsView, { props: { currentUser: admin } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('当前加载');
    expect(wrapper.find('[data-test="manual-demand-form"]').exists()).toBe(false);
    await wrapper.get('[data-test="open-manual-demand"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="manual-demand-form"]').exists()).toBe(true);
    await wrapper.get('[data-test="manual-sequence"]').setValue('M-001');
    await wrapper.get('[data-test="manual-voltage"]').setValue('vl-ac-220'); await flushPromises();
    await wrapper.get('[data-test="manual-line"]').setValue('line-1'); await flushPromises();
    await wrapper.get('[data-test="manual-location-type"]').setValue('tower_range');
    await wrapper.get('[data-test="manual-start-tower"]').setValue('tower-1');
    await wrapper.get('[data-test="manual-end-tower"]').setValue('tower-2');
    await wrapper.get('[data-test="manual-year"]').setValue('2026');
    await wrapper.get('[data-test="manual-category"]').setValue('临时补充');
    await wrapper.get('[data-test="manual-owner"]').setValue('张三');

    await wrapper.get('[data-test="add-manual-material"]').trigger('click');
    await wrapper.get('[data-test="add-manual-material"]').trigger('click');
    await wrapper.get('[data-test="manual-material-model-0"]').setValue('JX-01');
    await wrapper.get('[data-test="manual-material-quantity-0"]').setValue('2.5');
    await wrapper.get('[data-test="manual-material-unit-0"]').setValue('套');
    await wrapper.get('[data-test="manual-material-model-1"]').setValue('JX-02');
    await wrapper.get('[data-test="manual-material-quantity-1"]').setValue('12');
    await wrapper.get('[data-test="manual-material-unit-1"]').setValue('只');

    await wrapper.get('[data-test="save-manual-demand"]').trigger('click');
    await flushPromises();

    const fetchMock = vi.mocked(fetch);
    const call = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/demands' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      sequenceNo: 'M-001', voltageLevelId: 'vl-ac-220', lineId: 'line-1', locationType: 'tower_range', startTowerPositionId: 'tower-1', endTowerPositionId: 'tower-2',
      materials: [
        { rawModel: 'JX-01', quantityScaled: 25000, unit: '套' },
        { rawModel: 'JX-02', quantityScaled: 120000, unit: '只' },
      ],
      year: 2026, category: '临时补充', owner: '张三',
    });
    expect(wrapper.find('[data-test="manual-demand-form"]').exists()).toBe(false);
  });

  it('loads the selected hierarchy on demand and clears downstream fields when a parent changes', async () => {
    const wrapper = mount(DemandsView, { props: { currentUser: admin } }); await flushPromises();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/master/towers'))).toBe(false);
    await wrapper.get('[data-test="open-manual-demand"]').trigger('click');
    expect(wrapper.get('[data-test="manual-location-type"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-test="manual-voltage"]').setValue('vl-ac-220'); await flushPromises(); await flushPromises();
    await wrapper.get('[data-test="manual-line"]').setValue('line-1'); await flushPromises(); await flushPromises();
    await wrapper.get('[data-test="manual-start-tower"]').setValue('tower-1');
    await wrapper.get('[data-test="manual-end-tower"]').setValue('tower-2');
    await wrapper.get('[data-test="manual-voltage"]').setValue(''); await flushPromises();
    expect((wrapper.get('[data-test="manual-line"]').element as HTMLSelectElement).value).toBe('');
    expect(wrapper.get('[data-test="manual-start-tower"]').findAll('option')).toHaveLength(0);
    expect(wrapper.get('[data-test="manual-location-type"]').attributes('disabled')).toBeDefined();
  });

  it('lets write roles download the canonical import template before selecting a file', async () => {
    const wrapper = mount(DemandsView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="download-demand-template"]').trigger('click');
    expect(downloadDemandImportTemplate).toHaveBeenCalledTimes(1);
  });

  it('loads source details on demand instead of treating list data as complete provenance', async () => {
    const wrapper = mount(DemandsView, { props: { currentUser: readonly } });
    await flushPromises();
    const sourceButton = wrapper.findAll('button').find((button) => button.text() === '查看来源');
    expect(sourceButton).toBeTruthy();
    await sourceButton!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('需求.xlsx');
    expect(wrapper.text()).toContain('2 行');
    expect(wrapper.text()).toContain('需求 / 第 2 行');
    expect(wrapper.text()).toContain('需求 / 第 3 行');
    expect(wrapper.text()).toContain('未匹配标准物资');
  });

  it('lets write roles create a standard material and reload the dictionary', async () => {
    const wrapper = mount(DemandsView, { props: { currentUser: admin } });
    await flushPromises();
    await wrapper.get('[data-test="add-material"]').trigger('click');
    await wrapper.get('[data-test="material-name"]').setValue('线夹');
    await wrapper.get('[data-test="material-model"]').setValue('JX-01');
    await wrapper.get('[data-test="material-unit"]').setValue('套');
    await wrapper.get('[data-test="save-material"]').trigger('click');
    await flushPromises();
    const fetchMock = vi.mocked(fetch);
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/materials' && init?.method === 'POST');
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall![1]!.body))).toEqual({ code: null, name: '线夹', model: 'JX-01', unit: '套' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/materials')).length).toBeGreaterThanOrEqual(3);
  });

  it('shows row-level validation errors when an import requires review', async () => {
    parseFileInWorker.mockResolvedValue({
      fileType: 'xlsx',
      sheets: [{ name: '需求', headers: ['序号', '电压等级', '线路名称', '杆段', '物资型号', '物资数量'], rows: [{ rowNumber: 2, cells: { 序号: 1, 电压等级: '220kV', 线路名称: '龙城线', 杆段: '#1', 物资型号: 'JX-01', 物资数量: -1 } }] }],
    });
    sha256File.mockResolvedValue('b'.repeat(64));
    executeImportWorkflow.mockRejectedValue(new ImportReviewRequiredError('batch-review', 1, 1));

    const wrapper = mount(DemandsView, { props: { currentUser: admin } });
    await flushPromises();
    const input = wrapper.get('[data-test="file-input"]');
    const file = new File(['fake'], '错误.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    await wrapper.get('[data-test="start-import"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('物资数量不能为负数');
    expect(wrapper.text()).toContain('未匹配标准物资');
    expect(wrapper.text()).toContain('需求 / 第 2 行');
  });

  it('auto-maps exact Chinese headers and runs the tested worker/import workflow', async () => {
    parseFileInWorker.mockResolvedValue({
      fileType: 'xlsx',
      sheets: [{
        name: '需求',
        headers: ['序号', '电压等级', '线路名称', '杆段', '物资型号', '物资数量', '单位', '年度', '类别'],
        rows: [{ rowNumber: 2, cells: { 序号: 1, 电压等级: '220kV', 线路名称: '龙城线', 杆段: '#1', 物资型号: 'JX-01', 物资数量: 1, 单位: '套', 年度: 2026, 类别: '防断线' } }],
      }],
    });
    sha256File.mockResolvedValue('a'.repeat(64));
    executeImportWorkflow.mockResolvedValue({ processed: 1, publishedRows: 1, done: true });

    const wrapper = mount(DemandsView, { props: { currentUser: admin } });
    await flushPromises();
    const input = wrapper.get('[data-test="file-input"]');
    const file = new File(['fake'], '需求.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();

    expect(parseFileInWorker).toHaveBeenCalledWith(file);
    expect(wrapper.text()).toContain('识别到 1 行');
    await wrapper.get('[data-test="start-import"]').trigger('click');
    await flushPromises();

    expect(sha256File).toHaveBeenCalledWith(file);
    expect(executeImportWorkflow).toHaveBeenCalledTimes(1);
    const call = executeImportWorkflow.mock.calls[0]![0];
    expect(call.mapping).toEqual(expectedMapping);
    expect(call.rows).toEqual([{ sheetName: '需求', rowNumber: 2, cells: expect.objectContaining({ 线路名称: '龙城线' }) }]);
  });
});
