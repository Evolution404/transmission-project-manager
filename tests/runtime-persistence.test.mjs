import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createCloudflarePersistence } from '../apps/api/src/runtime/cloudflare/persistence.ts';
import { createNodePersistence } from '../apps/api/src/runtime/node/persistence.ts';

test('runtime factories expose the same persistence capabilities', async () => {
  const nodeRoot = await mkdtemp(join(tmpdir(), 'tpm-runtime-'));
  const nodeDb = new DatabaseSync(':memory:');
  try {
    const node = createNodePersistence({ database: nodeDb, objectRoot: nodeRoot });
    assert.equal(typeof node.database.first, 'function');
    assert.equal(typeof node.database.batch, 'function');
    assert.equal(typeof node.objectStore.put, 'function');

    const DB = {
      prepare() { throw new Error('not invoked'); },
      batch() { throw new Error('not invoked'); },
    };
    const cloudflareR2 = createCloudflarePersistence({
      DB,
      OBJECT_STORAGE_PROVIDER: 'r2',
      FILES: {
        put() { throw new Error('not invoked'); },
        get() { throw new Error('not invoked'); },
        delete() { throw new Error('not invoked'); },
      },
    });
    assert.equal(typeof cloudflareR2.database.first, 'function');
    assert.equal(typeof cloudflareR2.database.batch, 'function');
    assert.equal(typeof cloudflareR2.objectStore.put, 'function');

    const cloudflareNotion = createCloudflarePersistence({
      DB,
      OBJECT_STORAGE_PROVIDER: 'notion',
      NOTION_API_TOKEN: 'secret-test-token',
      NOTION_STORAGE_DATA_SOURCE_ID: 'data-source-1',
      NOTION_API_VERSION: '2026-03-11',
    });
    assert.equal(typeof cloudflareNotion.objectStore.put, 'function');

    const cloudflareWithoutStorage = createCloudflarePersistence({ DB });
    await assert.rejects(() => cloudflareWithoutStorage.objectStore.get('x'), /OBJECT_STORAGE_NOT_CONFIGURED/);
    assert.throws(() => createCloudflarePersistence({ DB, OBJECT_STORAGE_PROVIDER: 'filesystem' }), /FILESYSTEM_OBJECT_STORAGE_NOT_AVAILABLE/);
  } finally {
    nodeDb.close();
    await rm(nodeRoot, { recursive: true, force: true });
  }
});
