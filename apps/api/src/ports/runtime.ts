import type { DatabasePort } from './database';
import type { ObjectStorePort } from './object-store';

export interface PersistencePorts {
  database: DatabasePort;
  objectStore: ObjectStorePort;
}
