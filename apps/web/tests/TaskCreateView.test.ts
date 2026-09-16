import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

const push = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { projectId: 'p1' }, query: {} }),
  useRouter: () => ({ push }),
}));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({ name, inheritAttrs: false, setup(_, { slots, attrs }) { return () => vue.h('div', { ...attrs }, slots.default?.()); } });
  const NButton = vue.defineComponent({
    name: 'NButton', props: { disabled: Boolean, loading: Boolean }, emits: ['click'], inheritAttrs: false,
    setup(props, { emit, slots, attrs }) { return () => vue.h('button', { ...attrs, disabled: props.disabled || props.loading, onClick: () => emit('click') }, slots.default?.()); },
  });
  const NInput = vue.defineComponent({
    name: 'NInput', props: { value: { type: [String, Number], default: '' } }, emits: ['update:value'], inheritAttrs: false,
    setup(props, { emit, attrs }) { return () => vue.h('input', { ...attrs, value: props.value, onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value) }); },
  });
  return {
    NAlert: wrap('NAlert'), NButton, NDatePicker: NInput, NEmpty: wrap('NEmpty'), NForm: wrap('NForm'), NFormItem: wrap('NFormItem'), NInput,
    NSpin: wrap('NSpin'),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  };
});

import TaskCreateView from '../src/views/TaskCreateView.vue';

const manager: CurrentUser = {
  id: 'pm', username: 'pm', displayName: '项目经理', role: 'project_manager', enabled: true, version: 1,
  scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null,
  lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session',
};

const project = {
  id: 'p1', name: '线路治理项目', year: 2026, owner: '张三', status: 'confirmed' as const, reserveVersion: 1, frameworkId: null, version: 6,
  demandLinks: [{ id: 'link1', demandId: 'd1', sequenceNo: 'D-001', year: 2026, voltage: '220kV', lineName: '龙城线', section: '#001-#010', category: null, owner: null, createdAt: '' }],
  materialRequirements: [{ id: 'pm1', projectId: 'p1', materialId: null, model: 'FXBW-110', unit: '套', requiredQuantityScaled: 1000000, unitPriceScaled: null, amountFen: null, reserveCategoryId: null, reserveCategory: null, version: 1, createdAt: '', updatedAt: '' }],
  knownMaterialAmountFen: 0, missingPriceCount: 1, materialPriceCompletenessBasisPoints: 0, createdAt: '', updatedAt: '',
};

const existingTask = {
  id: 't-old', projectId: 'p1', projectReleaseId: 'r1', name: '已有任务', description: null, scopeText: null, owner: null, plannedDate: null,
  plannedQuantityScaled: 200000, unit: '项', version: 1, implementationVersion: 1, settlementVersion: 1, demandScopes: [],
  materials: [{ id: 'tm-old', taskId: 't-old', projectMaterialRequirementId: 'pm1', materialId: null, model: 'FXBW-110', unit: '套', requiredQuantityScaled: 300000, supplyVersion: 1, createdAt: '', updatedAt: '' }],
  supplyTotals: [], implementedQuantityScaled: 0, settledQuantityScaled: 0, implementationComplete: false, settlementComplete: false,
  state: 'unimplemented_unsettled' as const, settlementReminder: { needed: false, firstImplementationDate: null, dueDate: null, finalSettlementId: null }, createdAt: '', updatedAt: '',
};

function execution() {
  return { projectId: 'p1', projectVersion: 6, released: true, tasks: [existingTask], demands: [], implementationComplete: false, settlementComplete: false, projectState: 'unimplemented_unsettled' as const };
}

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('TaskCreateView', () => {
  afterEach(() => { vi.unstubAllGlobals(); push.mockReset(); });

  it('shows a recoverable page-level error when project context cannot be loaded', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'task-create-idem') });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('网络连接失败'); }));

    const wrapper = mount(TaskCreateView, { props: { currentUser: manager } });
    await flushPromises();

    expect(wrapper.text()).toContain('网络连接失败');
    expect(wrapper.text()).toContain('重新加载');
  });

  it('creates a task with optional demand scope and remaining project-material allocation', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'task-create-idem') });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/reserve-projects/p1') return ok(project);
      if (url === '/api/projects/p1/execution') return ok(execution());
      if (url === '/api/project-tasks' && init?.method === 'POST') return ok({ id: 't-new' }, 201);
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    }));

    const wrapper = mount(TaskCreateView, { props: { currentUser: manager } });
    await flushPromises();
    expect(wrapper.text()).toContain('剩余可分配 70 套');
    await wrapper.get('[data-test="task-name"]').setValue('新任务');
    await wrapper.get('[data-test="planned-quantity"]').setValue('50');
    await wrapper.get('[data-test="demand-d1"]').setValue('30');
    await wrapper.get('[data-test="material-pm1"]').setValue('20');
    await wrapper.get('[data-test="save-task"]').trigger('click');
    await flushPromises();

    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/project-tasks' && init?.method === 'POST');
    expect(call).toBeTruthy();
    expect(new Headers(call![1]!.headers).get('Idempotency-Key')).toBe('task-create-idem');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      projectId: 'p1', expectedProjectVersion: 6, name: '新任务', plannedQuantityScaled: 500000,
      demandScopes: [{ demandId: 'd1', quantityScaled: 300000 }],
      materials: [{ projectMaterialRequirementId: 'pm1', quantityScaled: 200000 }],
    });
    expect(push).toHaveBeenCalledWith({
      path: '/projects/p1/tasks/t-new',
      query: { from: '/projects/p1?tab=tasks' },
    });
  });

  it('allows a released project with no demand or material rows to create a task', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'task-create-idem') });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/reserve-projects/p1') return ok({ ...project, demandLinks: [], materialRequirements: [] });
      if (url === '/api/projects/p1/execution') return ok({ ...execution(), tasks: [] });
      if (url === '/api/project-tasks' && init?.method === 'POST') return ok({ id: 't-empty' }, 201);
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    }));
    const wrapper = mount(TaskCreateView, { props: { currentUser: manager } });
    await flushPromises();
    await wrapper.get('[data-test="task-name"]').setValue('无物资任务');
    await wrapper.get('[data-test="planned-quantity"]').setValue('1');
    await wrapper.get('[data-test="save-task"]').trigger('click');
    await flushPromises();
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/project-tasks' && init?.method === 'POST');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({ demandScopes: [], materials: [] });
  });
});
