import { D1DatabaseAdapter } from '../../adapters/cloudflare/d1-database.ts';
import { R2ObjectStoreAdapter } from '../../adapters/cloudflare/r2-object-store.ts';
import type { PersistencePorts } from '../../ports/runtime.ts';
import type { WorkerBindings } from '../../env.ts';

export function createCloudflarePersistence(bindings: Pick<WorkerBindings, 'DB' | 'FILES'>): PersistencePorts {
  return {
    database: new D1DatabaseAdapter(bindings.DB),
    objectStore: new R2ObjectStoreAdapter(bindings.FILES),
  };
}
