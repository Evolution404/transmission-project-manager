import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectSuccessfulCiRun,
  assertRequiredCiJobs,
} from '../scripts/engineering/verify-release-ci.mjs';

test('release gate selects only a successful main push for the exact release SHA', () => {
  const exactSha = 'a'.repeat(40);
  const runs = [
    { id: 1, head_sha: exactSha, head_branch: 'feature', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-09-16T10:00:00Z' },
    { id: 2, head_sha: exactSha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: '2026-09-16T10:01:00Z' },
    { id: 3, head_sha: 'b'.repeat(40), head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-09-16T10:02:00Z' },
    { id: 4, head_sha: exactSha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', created_at: '2026-09-16T10:03:00Z' },
    { id: 5, head_sha: exactSha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-09-16T10:04:00Z' },
  ];

  assert.equal(selectSuccessfulCiRun(runs, exactSha)?.id, 5);
});

test('release gate requires every release-critical CI job to pass', () => {
  const jobs = [
    { name: 'check', status: 'completed', conclusion: 'success' },
    { name: 'headless-ui', status: 'completed', conclusion: 'success' },
    { name: 'audit', status: 'completed', conclusion: 'success' },
  ];

  assert.doesNotThrow(() => assertRequiredCiJobs(jobs));
  assert.throws(
    () => assertRequiredCiJobs(jobs.map((job) => job.name === 'audit' ? { ...job, conclusion: 'failure' } : job)),
    /audit/,
  );
  assert.throws(
    () => assertRequiredCiJobs(jobs.filter((job) => job.name !== 'headless-ui')),
    /headless-ui/,
  );
});
