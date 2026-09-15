import { app } from './app.ts';
import { runScheduledOperations } from './system-tasks.ts';
import type { WorkerBindings } from './env';
import type { RuntimeBindings } from './runtime-env';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence.ts';

function runtimeBindings(env: WorkerBindings): RuntimeBindings {
  return { ...env, PERSISTENCE: createCloudflarePersistence(env) };
}

export default {
  fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext) {
    return app.fetch(request, runtimeBindings(env), ctx);
  },
  scheduled(controller: ScheduledController, env: WorkerBindings, ctx: ExecutionContext) {
    if (env.MAINTENANCE_MODE === 'data-migration') return;
    ctx.waitUntil(runScheduledOperations(runtimeBindings(env), new Date(controller.scheduledTime).toISOString()).then(() => undefined));
  },
};
