import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReserveProjectSummary } from '@tpm/shared';

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({
    name, inheritAttrs: false, props: { show: Boolean, description: String }, emits: ['update:show'],
    setup(props, { slots, attrs }) { return () => name === 'NDrawer' && !props.show ? null : vue.h('div', { ...attrs, 'data-stub': name }, slots.default?.()); },
  });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { disabled: Boolean, loading: Boolean }, emits: ['click'], inheritAttrs: false,
    setup(props, { emit, slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.disabled || props.loading, onClick: () => emit('click') }, slots.default?.()); },
  });
  const NInput = vue.defineComponent({
    name: 'NInput', props: { value: { type: [String, Number], default: '' } }, emits: ['update:value'], inheritAttrs: false,
    setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value) }); },
  });
  const NCheckbox = vue.defineComponent({
    name: 'NCheckbox', props: { checked: Boolean }, emits: ['update:checked'], inheritAttrs: false,
    setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, type: 'checkbox', checked: props.checked, onChange: (event: Event) => emit('update:checked', (event.target as HTMLInputElement).checked) }); },
  });
  const NSelect = vue.defineComponent({
    name: 'NSelect', props: { value: [String, Number], options: Array }, emits: ['update:value'], inheritAttrs: false,
    setup(props, { emit, attrs }) { return () => vue.h('select', { ...attrs, value: props.value, onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value || null) }, (props.options as Array<{ label: string; value: string }> ?? []).map((item) => vue.h('option', { value: item.value }, item.label))); },
  });
  return { NAlert: wrap('NAlert'), NButton, NCheckbox, NDrawer: wrap('NDrawer'), NDrawerContent: wrap('NDrawerContent'), NEmpty: wrap('NEmpty'), NInput, NSelect, NSpin: wrap('NSpin') };
});

import ProjectSourceEditor from '../src/features/projects/ProjectSourceEditor.vue';
import ProjectMaterialsEditor from '../src/features/projects/ProjectMaterialsEditor.vue';

const project: ReserveProjectSummary = {
  id: 'p1', name: '龙城线治理', year: 2026, owner: '张三', status: 'confirmed', reserveVersion: 2, frameworkId: null, version: 5,
  demandLinks: [{ id: 'link1', demandId: 'd1', sequenceNo: 'D-001', year: 2026, voltage: '220kV', lineName: '龙城线', section: '#001-#010', category: '防断线', owner: null, createdAt: '' }],
  materialRequirements: [{ id: 'pm1', projectId: 'p1', materialId: null, model: 'FXBW-110', unit: '套', requiredQuantityScaled: 1000000, unitPriceScaled: null, amountFen: null, reserveCategoryId: null, reserveCategory: null, version: 1, createdAt: '', updatedAt: '' }],
  knownMaterialAmountFen: 0, missingPriceCount: 1, materialPriceCompletenessBasisPoints: 0, createdAt: '', updatedAt: '',
};

function ok(data: unknown) { return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function conflict() { return new Response(JSON.stringify({ ok: false, error: { code: 'VERSION_CONFLICT', message: '项目已被修改' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }); }

describe('project definition editors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps an existing source demand while adding a searched demand', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'idem-source') });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/demands?')) return ok({ items: [{ id: 'd2', sequenceNo: 'D-002', year: 2026, voltageLevelId: null, lineId: null, locationType: null, startTowerPositionId: null, endTowerPositionId: null, voltageRaw: '220kV', voltageVerified: '220kV', lineName: '龙城线', section: '#011-#020', category: '防断线', owner: null, version: 1, createdAt: '' }], nextCursor: null });
      if (url === '/api/reserve-projects/p1/demands' && init?.method === 'PUT') return ok({ projectId: 'p1', version: 6, demandIds: ['d1', 'd2'] });
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    }));
    const wrapper = mount(ProjectSourceEditor, { props: { show: false, project } });
    await wrapper.setProps({ show: true });
    await flushPromises();
    const checkbox = wrapper.get('input[type="checkbox"]');
    await checkbox.setValue(true);
    await wrapper.get('[data-test="save-project-sources"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/reserve-projects/p1/demands' && init?.method === 'PUT');
    expect(JSON.parse(String(call![1]!.body)).demandIds.sort()).toEqual(['d1', 'd2']);
  });

  it('allows a project material revision to intentionally clear the project to zero materials', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'idem-materials') });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/reserve-categories') return ok({ items: [] });
      if (url === '/api/reserve-projects/p1/materials' && init?.method === 'PUT') return ok({ ...project, status: 'draft', version: 6, materialRequirements: [] });
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    }));
    const wrapper = mount(ProjectMaterialsEditor, { props: { show: false, project } });
    await wrapper.setProps({ show: true });
    await flushPromises();
    await wrapper.get('.material-row-head button').trigger('click');
    expect(wrapper.find('.material-editor-row').exists()).toBe(false);
    await wrapper.get('[data-test="material-revision-reason"]').setValue('本轮不需要项目物资');
    await wrapper.get('[data-test="save-project-materials"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/reserve-projects/p1/materials' && init?.method === 'PUT');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({ expectedVersion: 5, reason: '本轮不需要项目物资', materials: [] });
  });

  it('keeps source-selection draft on a version conflict and exposes an in-place refresh action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/demands?')) return ok({ items: [{ id: 'd2', sequenceNo: 'D-002', year: 2026, voltageLevelId: null, lineId: null, locationType: null, startTowerPositionId: null, endTowerPositionId: null, voltageRaw: '220kV', voltageVerified: '220kV', lineName: '龙城线', section: '#011-#020', category: '防断线', owner: null, version: 1, createdAt: '' }], nextCursor: null });
      if (url === '/api/reserve-projects/p1/demands' && init?.method === 'PUT') return conflict();
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    }));
    const wrapper = mount(ProjectSourceEditor, { props: { show: false, project } });
    await wrapper.setProps({ show: true });
    await flushPromises();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.get('[data-test="save-project-sources"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('当前选择已保留');
    expect(wrapper.find('[data-test="refresh-project-source-conflict"]').exists()).toBe(true);
    expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    await wrapper.get('[data-test="refresh-project-source-conflict"]').trigger('click');
    expect(wrapper.emitted('request-refresh')).toHaveLength(1);
  });

  it('keeps material draft on a version conflict and exposes an in-place refresh action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/reserve-categories') return ok({ items: [] });
      if (url === '/api/reserve-projects/p1/materials' && init?.method === 'PUT') return conflict();
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    }));
    const wrapper = mount(ProjectMaterialsEditor, { props: { show: false, project } });
    await wrapper.setProps({ show: true });
    await flushPromises();
    await wrapper.get('.material-fields input').setValue('FXBW-110-新');
    await wrapper.get('[data-test="material-revision-reason"]').setValue('现场调整');
    await wrapper.get('[data-test="save-project-materials"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('当前物资草稿已保留');
    expect(wrapper.find('[data-test="refresh-project-material-conflict"]').exists()).toBe(true);
    expect((wrapper.get('.material-fields input').element as HTMLInputElement).value).toBe('FXBW-110-新');
    await wrapper.get('[data-test="refresh-project-material-conflict"]').trigger('click');
    expect(wrapper.emitted('request-refresh')).toHaveLength(1);
  });
});
