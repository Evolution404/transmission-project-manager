import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeJsonCursor, encodeJsonCursor } from '../apps/api/src/http/cursor.ts';

test('JSON cursor codec round-trips opaque ASCII pagination state', () => {
  const value = {
    createdAt: '2026-09-16T15:12:57.000Z',
    id: 'project-123',
    plannedKey: '9999-12-31',
  };

  const encoded = encodeJsonCursor(value);

  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeJsonCursor(encoded), value);
});

test('JSON cursor codec rejects empty, malformed and non-JSON input', () => {
  assert.equal(decodeJsonCursor(undefined), null);
  assert.equal(decodeJsonCursor('not-a-valid-cursor'), null);
  assert.equal(decodeJsonCursor('bm90LWpzb24'), null);
});
