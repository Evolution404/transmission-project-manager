export interface WorkerBindings {
  APP_ENV: 'development' | 'test' | 'production';
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  AUTH_CREDENTIAL_PEPPER?: string;
  BOOTSTRAP_TOKEN?: string;
  NOTIFICATION_DELIVERY_URL?: string;
  NOTIFICATION_DELIVERY_TOKEN?: string;
}
