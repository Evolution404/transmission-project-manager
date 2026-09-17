import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coercedPositiveIntegerValue,
  positiveIntegerValue,
} from '../apps/api/src/http/request-values.ts';

test('positive integer request parser accepts only safe positive JSON numbers', () => {
  assert.equal(positiveIntegerValue(1), 1);
  assert.equal(positiveIntegerValue(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  for (const value of [0, -1, 1.5, '1', true, false, null, undefined, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(positiveIntegerValue(value), null, `expected ${String(value)} to be rejected`);
  }
});

test('coerced positive integer parser preserves legacy numeric coercion semantics', () => {
  assert.equal(coercedPositiveIntegerValue(1), 1);
  assert.equal(coercedPositiveIntegerValue('1'), 1);
  assert.equal(coercedPositiveIntegerValue(' 2 '), 2);
  assert.equal(coercedPositiveIntegerValue(true), 1);

  for (const value of [0, -1, 1.5, '', false, null, undefined, Number.NaN]) {
    assert.equal(coercedPositiveIntegerValue(value), null, `expected ${String(value)} to be rejected`);
  }
});
