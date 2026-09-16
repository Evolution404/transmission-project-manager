import { describe, expect, it } from 'vitest';
import { router } from '../src/router';
import DemandsView from '../src/views/DemandsView.vue';
import FinanceView from '../src/views/FinanceView.vue';
import AnalysisView from '../src/views/AnalysisView.vue';
import TaskQueueView from '../src/views/TaskQueueView.vue';
import ProjectsView from '../src/views/ProjectsView.vue';
import ProjectDetailView from '../src/views/ProjectDetailView.vue';
import TaskDetailView from '../src/views/TaskDetailView.vue';
import TaskCreateView from '../src/views/TaskCreateView.vue';

describe('business routes', () => {
  it('lazy-loads the real demand pool at /demands instead of the P2 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/demands');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(DemandsView);
  });

  it('retires the legacy reserve workspace in favor of the unified project center', () => {
    const route = router.getRoutes().find((item) => item.path === '/reserves');
    expect(route?.redirect).toBe('/projects');
  });

  it('lazy-loads the real finance workspace at /finance instead of the P4 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/finance');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(FinanceView);
  });

  it('lazy-loads the real analysis workspace at /analysis instead of the P6 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/analysis');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(AnalysisView);
  });

  it('uses /tasks as the cross-project task queue and keeps /delivery as a compatibility redirect', async () => {
    const route = router.getRoutes().find((item) => item.path === '/tasks');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(TaskQueueView);
    const legacy = router.getRoutes().find((item) => item.path === '/delivery');
    expect(legacy?.redirect).toBe('/tasks');
  });

  it('provides stable project and task deep links for refresh-safe navigation', async () => {
    const cases = [
      ['/projects', ProjectsView],
      ['/projects/:projectId', ProjectDetailView],
      ['/projects/:projectId/tasks/new', TaskCreateView],
      ['/projects/:projectId/tasks/:taskId', TaskDetailView],
    ] as const;

    for (const [path, component] of cases) {
      const route = router.getRoutes().find((item) => item.path === path);
      expect(route, path).toBeTruthy();
      const loader = route?.components?.default;
      expect(typeof loader, path).toBe('function');
      const resolved = await (loader as () => Promise<{ default: unknown }>)();
      expect(resolved.default, path).toBe(component);
    }
  });
});
