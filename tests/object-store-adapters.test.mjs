import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FilesystemObjectStoreAdapter } from '../apps/api/src/adapters/node/filesystem-object-store.ts';
import { R2ObjectStoreAdapter } from '../apps/api/src/adapters/cloudflare/r2-object-store.ts';

test('filesystem object store preserves bytes and metadata and blocks path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpm-object-store-'));
  try {
    const store = new FilesystemObjectStoreAdapter(root);
    await store.put('attachments/a.bin', new Uint8Array([1, 2, 3]), {
      contentType: 'application/octet-stream',
      custom: { owner: 'p1' },
    });
    const object = await store.get('attachments/a.bin');
    assert.ok(object);
    assert.deepEqual([...await object.bytes()], [1, 2, 3]);
    assert.deepEqual(object.metadata, {
      contentType: 'application/octet-stream',
      sizeBytes: 3,
      custom: { owner: 'p1' },
    });
    await store.delete('attachments/a.bin');
    assert.equal(await store.get('attachments/a.bin'), null);
    await assert.rejects(() => store.put('../escape', 'x'), /INVALID_OBJECT_KEY/);
    await assert.rejects(() => store.put('/absolute', 'x'), /INVALID_OBJECT_KEY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R2 object store maps portable metadata and bytes', async () => {
  const objects = new Map();
  const bucket = {
    async put(key, value, options) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      objects.set(key, {
        bytes,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
    },
    async get(key) {
      const item = objects.get(key);
      if (!item) return null;
      return {
        size: item.bytes.byteLength,
        httpMetadata: item.httpMetadata,
        customMetadata: item.customMetadata,
        arrayBuffer: async () => item.bytes.slice().buffer,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const store = new R2ObjectStoreAdapter(bucket);
  await store.put('x.txt', 'abc', { contentType: 'text/plain', custom: { a: 'b' } });
  const object = await store.get('x.txt');
  assert.ok(object);
  assert.equal(new TextDecoder().decode(await object.bytes()), 'abc');
  assert.deepEqual(object.metadata, { contentType: 'text/plain', sizeBytes: 3, custom: { a: 'b' } });
  await store.delete('x.txt');
  assert.equal(await store.get('x.txt'), null);
});
