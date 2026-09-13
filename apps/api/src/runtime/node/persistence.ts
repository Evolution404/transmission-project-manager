import type { DatabaseSync } from 'node:sqlite';
import { FilesystemObjectStoreAdapter } from '../../adapters/node/filesystem-object-store.ts';
import { SqliteDatabaseAdapter } from '../../adapters/node/sqlite-database.ts';
import type { PersistencePorts } from '../../ports/runtime.ts';

export interface NodePersistenceOptions {
  database: DatabaseSync;
  objectRoot: string;
}

export function createNodePersistence(options: NodePersistenceOptions): PersistencePorts {
  return {
    database: new SqliteDatabaseAdapter(options.database),
    objectStore: new FilesystemObjectStoreAdapter(options.objectRoot),
  };
}
