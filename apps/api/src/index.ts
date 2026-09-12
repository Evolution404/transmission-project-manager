import { app } from './app';
import { runP6Tick } from './p6';
import type { WorkerBindings } from './env';

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: WorkerBindings, ctx: ExecutionContext) {
    ctx.waitUntil(runP6Tick(env, new Date(controller.scheduledTime).toISOString()).then(() => undefined));
  },
};
