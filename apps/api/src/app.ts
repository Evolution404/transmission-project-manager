import { Hono } from 'hono';
import type { HealthResponse } from '@tpm/shared';
import { accountApp } from './account.ts';
import { administrationApp } from './administration.ts';
import { analysisOperationsApp } from './analysis-operations.ts';
import { requireAuthentication, type AppEnv } from './auth.ts';
import { demandImportApp } from './demand-import.ts';
import { financeApp } from './finance.ts';
import { apiError } from './http/request-values.ts';
import { masterDataConfigApp } from './master-data-config.ts';
import { physicalTowersApp } from './physical-towers.ts';
import { projectExecutionApp } from './project-execution.ts';
import { projectLifecycleApp } from './project-lifecycle.ts';
import { publicAuthenticationApp } from './public-authentication.ts';
import { reservePlanningApp } from './reserve-planning.ts';
import { resolvePersistence } from './runtime/persistence.ts';
import { schemaReadiness } from './schema.ts';
import { structuredDemandApp } from './structured-demand.ts';
import { transmissionGridApp } from './transmission-grid.ts';
import { transmissionGridOperationsApp } from './transmission-grid-operations.ts';

export const app = new Hono<AppEnv>();

app.get('/api/health', async (c) => {
  const { database } = resolvePersistence(c.env);
  const body: HealthResponse = {
    ok: true,
    data: {
      service: 'transmission-project-manager',
      schema: await schemaReadiness(database),
    },
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});

// Public authentication routes must stay registered before authentication middleware.
app.route('/api', publicAuthenticationApp);

app.use('/api/*', async (c, next) => {
  const publicPaths = new Set(['/api/health', '/api/auth/status', '/api/auth/kdf', '/api/auth/bootstrap', '/api/auth/login']);
  if (publicPaths.has(c.req.path)) return next();
  return requireAuthentication(c, next);
});

app.use('/api/*', async (c, next) => {
  const schemaExemptPaths = new Set([
    '/api/health',
    '/api/auth/status',
    '/api/auth/kdf',
    '/api/auth/bootstrap',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/change-password',
    '/api/me',
  ]);
  if (schemaExemptPaths.has(c.req.path)) return next();
  const { database } = resolvePersistence(c.env);
  const schema = await schemaReadiness(database);
  if (!schema.ready) {
    return c.json(apiError(
      'SCHEMA_OUTDATED',
      `数据库结构未升级到当前代码要求（当前：${schema.currentMigration ?? '未初始化'}；要求：${schema.requiredMigration}）`,
      schema,
    ), 503);
  }
  return next();
});

app.route('/api', accountApp);
app.route('/api', administrationApp);
app.route('/api', transmissionGridApp);
app.route('/api', transmissionGridOperationsApp);
app.route('/api', masterDataConfigApp);
app.route('/api', physicalTowersApp);
app.route('/api', structuredDemandApp);
app.route('/api', projectExecutionApp);
app.route('/api', demandImportApp);
app.route('/api', reservePlanningApp);
app.route('/api', financeApp);
app.route('/api', projectLifecycleApp);
app.route('/api', analysisOperationsApp);

app.notFound((c) => c.json(apiError('NOT_FOUND', '接口不存在或尚未实现'), 404));
