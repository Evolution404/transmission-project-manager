import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@tpm/shared';

const push = vi.fn();
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));

vi.mock('naive-ui', async () => {
  const vue = await import('vue');
  const wrap = (name: string) => vue.defineComponent({ name, props: { label: String, value: [String, Number] }, setup(props, { slots }) { return () => vue.h('div', { 'data-stub': name }, [props.label, props.value, slots['header-extra']?.(), slots.default?.()]); } });
  return { NAlert: wrap('NAlert'), NCard: wrap('NCard'), NEmpty: wrap('NEmpty'), NGrid: wrap('NGrid'), NGridItem: wrap('NGridItem'), NSpin: wrap('NSpin'), NStatistic: wrap('NStatistic'), NTag: wrap('NTag') };
});

import DashboardView from '../src/views/DashboardView.vue';

const user: CurrentUser = { id: 'a', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, version: 1, scopes: [{ type: 'all', id: null }], invitedAt: null, firstLoginAt: null, lastLoginAt: null, lifecycleStatus: 'active', mustChangePassword: false, authSource: 'session' };

describe('DashboardView P6 statistics', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { asOf: '2026-09-12', projectCount: 12, demandCount: 34, unreleasedProjectCount: 5, pendingSettlementCount: 3, activeAlertCount: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => { vi.unstubAllGlobals(); push.mockReset(); });

  it('loads current business statistics instead of placeholder dashes', async () => {
    const wrapper = mount(DashboardView, { props: { currentUser: user } });
    await flushPromises();
    expect(wrapper.text()).toContain('34');
    expect(wrapper.text()).toContain('12');
    expect(wrapper.text()).toContain('3');
    expect(wrapper.text()).toContain('2');
    expect(wrapper.text()).not.toContain('P6 接入');
  });
});
