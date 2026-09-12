import { Hono } from 'hono';
import type { ApiError, HealthResponse } from '@tpm/shared';
import type { WorkerBindings } from './env';

export const app = new Hono<{ Bindings: WorkerBindings }>();

// Liveness only: this does not imply D1, R2, Access or business features are ready.
app.get('/api/health', (c) => {
  const body: HealthResponse = {
    ok: true,
    data: { service: 'transmission-project-manager', stage: 'scaffold' },
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});

app.notFound((c) => {
  const body: ApiError = {
    ok: false,
    error: { code: 'NOT_FOUND', message: '接口不存在或尚未实现' },
  };
  return c.json(body, 404);
});
