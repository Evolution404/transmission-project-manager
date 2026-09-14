import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMigrationSnapshot, stageSnapshot, snapshotSignature } from '../scripts/dev/migration-snapshot.mjs';
import { createOutputCapture } from '../scripts/dev/process-output.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tpm-migration-watch-'));
  const lockPath = join(dir, 'lock.json');
  const name = '0001_initial_schema.sql';
  const content = 'CREATE TABLE test(id TEXT);\n';
  const lock = (value) => writeFileSync(lockPath, JSON.stringify({ [`apps/api/migrations/${name}`]: hash(value) }));
  try { run({ dir, lockPath, name, content, lock }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('development schema accepts only one checksum-locked 0001 baseline', () => fixture(({ dir, lockPath, name, content, lock }) => {
  writeFileSync(lockPath, '{}');
  writeFileSync(join(dir, name), 'CREATE');
  assert.throws(() => readMigrationSnapshot({ migrationsDir: dir, lockPath }), /MIGRATION_NOT_READY/);

  lock(content);
  assert.throws(() => readMigrationSnapshot({ migrationsDir: dir, lockPath }), /MIGRATION_NOT_READY/);
  writeFileSync(join(dir, name), content);
  assert.equal(readMigrationSnapshot({ migrationsDir: dir, lockPath })[0].hash, hash(content));

  writeFileSync(join(dir, '0002_forbidden.sql'), 'CREATE TABLE forbidden(id TEXT);\n');
  assert.throws(() => readMigrationSnapshot({ migrationsDir: dir, lockPath }), /DEVELOPMENT_SCHEMA_BASELINE_ONLY/);
}));

test('development baseline may be rewritten in place when its checksum lock is updated', () => fixture(({ dir, lockPath, name, content, lock }) => {
  writeFileSync(join(dir, name), content);
  lock(content);
  const original = readMigrationSnapshot({ migrationsDir: dir, lockPath });

  const revised = `${content}CREATE INDEX idx_test_id ON test(id);\n`;
  writeFileSync(join(dir, name), revised);
  lock(revised);
  const next = readMigrationSnapshot({ migrationsDir: dir, lockPath });
  assert.notEqual(next[0].hash, original[0].hash);
  assert.equal(next[0].hash, hash(revised));
}));

test('execution uses immutable snapshot bytes, not a file edited after readiness', () => fixture(({ dir, lockPath, name, content, lock }) => {
  writeFileSync(join(dir, name), content);
  lock(content);
  const snapshot = readMigrationSnapshot({ migrationsDir: dir, lockPath });
  writeFileSync(join(dir, name), 'unfinished change');
  const staged = join(dir, 'staged');
  stageSnapshot(snapshot, staged);
  assert.equal(readFileSync(join(staged, name), 'utf8'), content);
  assert.equal(snapshotSignature(snapshot), snapshotSignature([{ ...snapshot[0] }]));
}));

test('launcher keeps stderr diagnostics out of machine-readable wrangler stdout', () => {
  const capture = createOutputCapture();
  capture.appendStderr('(node:1) ExperimentalWarning: loader warning\n');
  capture.appendStdout('[{"results":[{"name":"0001_initial_schema.sql"}]}]\n');
  assert.equal(JSON.parse(capture.stdout())[0].results[0].name, '0001_initial_schema.sql');
  assert.match(capture.diagnostic(), /ExperimentalWarning/);

  const launcher = readFileSync(new URL('../scripts/dev/api-dev.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /createOutputCapture/, 'api-dev launcher must keep stdout and stderr in separate buffers');
  assert.match(launcher, /重建本地 D1/);
  assert.doesNotMatch(launcher, /APPLIED_MIGRATION_CHANGED|追加新版本/);
});
