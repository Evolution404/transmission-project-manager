import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FilesystemObjectStoreAdapter } from '../apps/api/src/adapters/node/filesystem-object-store.ts';
import { R2ObjectStoreAdapter } from '../apps/api/src/adapters/cloudflare/r2-object-store.ts';
import { NotionObjectStoreAdapter } from '../apps/api/src/adapters/notion/notion-object-store.ts';

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

test('Notion object store maps portable put/get/delete semantics onto file uploads and data-source pages', async () => {
  const requests = [];
  let queryCount = 0;
  const activePage = {
    object: 'page',
    id: 'page-1',
    in_trash: false,
    properties: {
      'Object Key': { type: 'title', title: [{ plain_text: 'x.txt' }] },
      File: { type: 'files', files: [{ type: 'file', name: 'x.txt', file: { url: 'https://files.example/object', expiry_time: '2026-09-14T11:00:00Z' } }] },
      'Content Type': { type: 'rich_text', rich_text: [{ plain_text: 'text/plain' }] },
      'Size Bytes': { type: 'number', number: 3 },
      'Custom Metadata': { type: 'rich_text', rich_text: [{ plain_text: '{"a":"b"}' }] },
      State: { type: 'select', select: { name: 'active' } },
    },
  };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method ?? 'GET';
    requests.push({ url, method, headers: new Headers(init.headers), body: init.body });
    if (url === 'https://files.example/object') return new Response(new Uint8Array([97, 98, 99]), { status: 200 });
    if (url.endsWith('/data_sources/data-source-1/query')) {
      queryCount += 1;
      return json({ object: 'list', results: queryCount === 1 || queryCount === 4 ? [] : [activePage], has_more: false, next_cursor: null });
    }
    if (url.endsWith('/file_uploads') && method === 'POST') return json({ object: 'file_upload', id: 'upload-1', status: 'pending' });
    if (url.endsWith('/file_uploads/upload-1/send') && method === 'POST') return json({ object: 'file_upload', id: 'upload-1', status: 'uploaded' });
    if (url.endsWith('/pages') && method === 'POST') return json({ object: 'page', id: 'page-1' });
    if (url.endsWith('/pages/page-1') && method === 'PATCH') return json({ object: 'page', id: 'page-1', in_trash: true });
    throw new Error(`Unexpected request ${method} ${url}`);
  };

  const store = new NotionObjectStoreAdapter({ token: 'secret-test-token', dataSourceId: 'data-source-1', fetchFn, now: () => '2026-09-14T10:00:00.000Z' });
  await store.put('x.txt', 'abc', { contentType: 'text/plain', custom: { a: 'b' } });
  const object = await store.get('x.txt');
  assert.ok(object);
  assert.equal(new TextDecoder().decode(await object.bytes()), 'abc');
  assert.deepEqual(object.metadata, { contentType: 'text/plain', sizeBytes: 3, custom: { a: 'b' } });
  await store.delete('x.txt');
  assert.equal(await store.get('x.txt'), null);

  const notionRequests = requests.filter(({ url }) => url.startsWith('https://api.notion.com/'));
  assert.ok(notionRequests.every(({ headers }) => headers.get('authorization') === 'Bearer secret-test-token'));
  assert.ok(notionRequests.every(({ headers }) => headers.get('notion-version') === '2026-03-11'));
  const uploadSend = requests.find(({ url }) => url.endsWith('/file_uploads/upload-1/send'));
  assert.ok(uploadSend.body instanceof FormData);
  const trash = requests.find(({ url, method }) => url.endsWith('/pages/page-1') && method === 'PATCH');
  assert.match(String(trash.body), /in_trash|\[object Object\]/);
});
