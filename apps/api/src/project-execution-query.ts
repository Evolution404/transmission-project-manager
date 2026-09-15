import { Hono } from 'hono';
import type { AppEnv } from './auth.ts';
import { apiError } from './http/request-values.ts';
import { executionLifecycleState, hasExecutionProjectAccess } from './project-execution-shared.ts';
import { SqlExecutionQueryRepository } from './repositories/sql-execution-query-repository.ts';
import { resolvePersistence } from './runtime/persistence.ts';

export const projectExecutionQueryApp = new Hono<AppEnv>();

projectExecutionQueryApp.get('/demands/:id/execution', async (c) => {
  const { database } = resolvePersistence(c.env);
  const repository = new SqlExecutionQueryRepository(database);
  const result = await repository.findDemandExecution(c.req.param('id'));
  if (!result) return c.json(apiError('DEMAND_NOT_FOUND', '需求不存在'), 404);
  if (c.get('currentUser').role !== 'admin' && !c.get('currentUser').scopes.some((scope) => scope.type === 'all')) {
    const allowed = result.projects.some((project) => hasExecutionProjectAccess(c, project.id, project.frameworkId));
    if (!allowed && result.projects.length) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该需求执行反馈'), 403);
  }
  return c.json({ ok: true as const, data: result.summary });
});

projectExecutionQueryApp.get('/projects/:id/execution', async (c) => {
  const { database } = resolvePersistence(c.env);
  const repository = new SqlExecutionQueryRepository(database);
  const project = await repository.findProjectHeader(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!hasExecutionProjectAccess(c, project.id, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目执行状态'), 403);
  const [tasks, demands] = await Promise.all([
    repository.listProjectTasks(project.id),
    repository.listProjectDemands(project.id),
  ]);
  const implementationComplete = demands.length > 0 && demands.every((item) => item.implementationComplete);
  const settlementComplete = demands.length > 0 && demands.every((item) => item.settlementComplete);
  return c.json({ ok: true as const, data: {
    projectId: project.id,
    projectVersion: project.version,
    released: project.released,
    tasks,
    demands,
    implementationComplete,
    settlementComplete,
    projectState: executionLifecycleState(implementationComplete, settlementComplete),
  } });
});
