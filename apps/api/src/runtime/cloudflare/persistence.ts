import { D1DatabaseAdapter } from '../../adapters/cloudflare/d1-database.ts';
import { R2ObjectStoreAdapter } from '../../adapters/cloudflare/r2-object-store.ts';
import { NotionObjectStoreAdapter } from '../../adapters/notion/notion-object-store.ts';
import type { ObjectStorePort } from '../../ports/object-store.ts';
import type { PersistencePorts } from '../../ports/runtime.ts';
import type { WorkerBindings } from '../../env.ts';

class UnavailableObjectStoreAdapter implements ObjectStorePort {
  async put(): Promise<void> { throw new Error('OBJECT_STORAGE_NOT_CONFIGURED'); }
  async get(): Promise<null> { throw new Error('OBJECT_STORAGE_NOT_CONFIGURED'); }
  async delete(): Promise<void> { throw new Error('OBJECT_STORAGE_NOT_CONFIGURED'); }
}

export function createCloudflarePersistence(bindings: Pick<
  WorkerBindings,
  'DB' | 'FILES' | 'OBJECT_STORAGE_PROVIDER' | 'NOTION_API_TOKEN' | 'NOTION_API_VERSION' | 'NOTION_STORAGE_DATA_SOURCE_ID'
>): PersistencePorts {
  let objectStore: ObjectStorePort;
  const provider = bindings.OBJECT_STORAGE_PROVIDER ?? (bindings.FILES ? 'r2' : undefined);

  if (provider === 'notion') {
    objectStore = new NotionObjectStoreAdapter({
      token: bindings.NOTION_API_TOKEN ?? '',
      dataSourceId: bindings.NOTION_STORAGE_DATA_SOURCE_ID ?? '',
      apiVersion: bindings.NOTION_API_VERSION ?? '2026-03-11',
    });
  } else if (provider === 'r2') {
    objectStore = bindings.FILES ? new R2ObjectStoreAdapter(bindings.FILES) : new UnavailableObjectStoreAdapter();
  } else if (provider === 'filesystem') {
    throw new Error('FILESYSTEM_OBJECT_STORAGE_NOT_AVAILABLE_IN_CLOUDFLARE_RUNTIME');
  } else {
    objectStore = new UnavailableObjectStoreAdapter();
  }

  return {
    database: new D1DatabaseAdapter(bindings.DB),
    objectStore,
  };
}
