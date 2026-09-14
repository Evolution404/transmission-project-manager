import type { PersistencePorts } from './ports/runtime';

export type ObjectStorageProvider = 'filesystem' | 'r2' | 'notion';

export interface RuntimeConfig {
  APP_ENV: 'development' | 'test' | 'production';
  OBJECT_STORAGE_PROVIDER?: ObjectStorageProvider;
  AUTH_CREDENTIAL_PEPPER?: string;
  BOOTSTRAP_TOKEN?: string;
  NOTIFICATION_DELIVERY_URL?: string;
  NOTIFICATION_DELIVERY_TOKEN?: string;
  NOTION_API_TOKEN?: string;
  NOTION_API_VERSION?: string;
  NOTION_STORAGE_DATA_SOURCE_ID?: string;
}

export interface RuntimeBindings extends RuntimeConfig {
  PERSISTENCE: PersistencePorts;
}
