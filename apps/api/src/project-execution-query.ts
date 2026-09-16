import { Hono } from 'hono';
import type { AppEnv } from './auth.ts';
import { decodeJsonCursor, encodeJsonCursor } from './http/cursor.ts';
import { apiError } from './http/request-values.ts';
import { executionLifecycleState, hasExecutionProjectAccess } from './project-execution-shared.ts';
import type { TaskQueueStatus } from '@tpm/shared';
import { SqlExecutionQueryRepository } from './repositories/sql-execution-query-repository.ts';
import { resolvePersistence } from './runtime/persistence.ts';

export const projectExecutionQueryApp = new Hono<AppEnv>();

function parseTaskCursor(value: string | undefined): { plannedKey: string; createdAt: string; id: string } | null {
  const decoded = decodeJsonCursor(value);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  if (typeof record.plannedKey !== 'string' || typeof record.createdAt !== 'string' || typeof record.id !== 'string') return null;
  return { plannedKey: record.plannedKey, createdAt: record.createdAt, id: record.id };
}

function taskCursor(value: { plannedKey: string; createdAt: string; id: string }) {
  return encodeJsonCursor(value);
}

projectExecutionQueryApp.get('/tasks', async (c) => {
  const limitRaw = Number(c.req.query('limit') ?? '50');
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : null;
  if (limit === null) return c.json(apiError('INVALID_LIMIT', 'limit 必须是 1–100 的整数'), 400);
  const query = (c.req.query('query') ?? '').trim();
  if (query.length > 160) return c.json(apiError('INVALID_QUERY', '搜索词过长'), 400);
  const status = (c.req.query('status') ?? 'all') as TaskQueueStatus;
  if (!['all', 'implementation_pending', 'settlement_pending'].includes(status)) return c.json(apiError('INVALID_TASK_STATUS', '任务状态筛选无效'), 400);
  const plannedBefore = c.req.query('plannedBefore')?.trim() || null;
  if (plannedBefore && !/^\d{4}-\d{2}-\d{2}$/.test(plannedBefore)) return c.json(apiError('INVALID_PLANNED_DATE', '计划日期筛选无效'), 400);
  const cursorParam = c.req.query('cursor');
  const cursor = parseTaskCursor(cursorParam);
  if (cursorParam && !cursor) return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400);
  const user = c.get('currentUser');
  const unrestricted = user.role === 'admin' || user.scopes.some((scope) => scope.type === 'all');
  const { database } = resolvePersistence(c.env);
  const page = await new SqlExecutionQueryRepository(database).listTaskQueue({
    memberId: user.id,
    unrestricted,
    query,
    status,
    plannedBefore,
    cursor,
    limit,
  });
  return c.json({ ok: true as const, data: {
    items: page.items,
    nextCursor: page.nextCursor ? taskCursor(page.nextCursor) : null,
  } });
});

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
