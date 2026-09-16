import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertReleaseState, selectDispatchedRun } from '../scripts/engineering/github-workflow.mjs';

test('production workflow requires clean main exactly synchronized with origin/main', () => {
  assert.doesNotThrow(() => assertReleaseState({
    branch: 'main',
    status: '',
    headSha: 'a'.repeat(40),
    originSha: 'a'.repeat(40),
  }));

  assert.throws(() => assertReleaseState({ branch: 'feature', status: '', headSha: 'a', originSha: 'a' }), /main/);
  assert.throws(() => assertReleaseState({ branch: 'main', status: ' M file', headSha: 'a', originSha: 'a' }), /未提交/);
  assert.throws(() => assertReleaseState({ branch: 'main', status: '', headSha: 'a', originSha: 'b' }), /origin\/main/);
});

test('workflow runner selects only a newly dispatched run for the exact approved SHA', () => {
  const beforeIds = new Set([10, 11]);
  const runs = [
    { databaseId: 13, headSha: 'b'.repeat(40), url: 'wrong-sha' },
    { databaseId: 11, headSha: 'a'.repeat(40), url: 'old-run' },
    { databaseId: 12, headSha: 'a'.repeat(40), url: 'expected' },
  ];
  assert.deepEqual(selectDispatchedRun(beforeIds, runs, 'a'.repeat(40)), runs[2]);
  assert.equal(selectDispatchedRun(beforeIds, runs, 'c'.repeat(40)), null);
});
