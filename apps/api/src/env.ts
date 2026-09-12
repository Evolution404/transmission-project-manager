export interface WorkerBindings {
  APP_ENV: 'development' | 'test' | 'production';
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_AUTH_EMAIL?: string;
}
