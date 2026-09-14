import type { PersistencePorts } from './ports/runtime';

export interface RuntimeConfig {
  APP_ENV: 'development' | 'test' | 'production';
  AUTH_CREDENTIAL_PEPPER?: string;
  BOOTSTRAP_TOKEN?: string;
  NOTIFICATION_DELIVERY_URL?: string;
  NOTIFICATION_DELIVERY_TOKEN?: string;
}

export interface RuntimeBindings extends RuntimeConfig {
  PERSISTENCE: PersistencePorts;
}
