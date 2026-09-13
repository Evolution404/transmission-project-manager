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

    const cloudflare = createCloudflarePersistence({
      DB: {
        prepare() { throw new Error('not invoked'); },
        batch() { throw new Error('not invoked'); },
      },
      FILES: {
        put() { throw new Error('not invoked'); },
        get() { throw new Error('not invoked'); },
        delete() { throw new Error('not invoked'); },
      },
    });
    assert.equal(typeof cloudflare.database.first, 'function');
    assert.equal(typeof cloudflare.database.batch, 'function');
    assert.equal(typeof cloudflare.objectStore.put, 'function');
  } finally {
    nodeDb.close();
    await rm(nodeRoot, { recursive: true, force: true });
  }
});
