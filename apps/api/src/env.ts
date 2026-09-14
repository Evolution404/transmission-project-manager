import type { RuntimeConfig } from './runtime-env';

export interface WorkerBindings extends RuntimeConfig {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
}
