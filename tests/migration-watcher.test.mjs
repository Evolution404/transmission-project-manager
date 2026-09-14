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
  const name = '0001_test.sql', content = 'CREATE TABLE test(id TEXT);\n';
  const lock = (value) => writeFileSync(lockPath, JSON.stringify({ [`apps/api/migrations/${name}`]: hash(value) }));
  try { run({ dir, lockPath, name, content, lock }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('watcher never executes an unlocked, empty or partially written migration', () => fixture(({ dir, lockPath, name, content, lock }) => {
  writeFileSync(lockPath, '{}'); writeFileSync(join(dir, name), 'CREATE');
  assert.throws(() => readMigrationSnapshot({ migrationsDir: dir, lockPath, applied: {} }), /MIGRATION_NOT_READY/);
  lock(content);
  assert.throws(() => readMigrationSnapshot({ migrationsDir: dir, lockPath, applied: {} }), /MIGRATION_NOT_READY/);
  writeFileSync(join(dir, name), content);
  assert.equal(readMigrationSnapshot({ migrationsDir: dir, lockPath, applied: {} })[0].hash, hash(content));
}));

test('applied migrations cannot change or disappear even if the checksum lock is rewritten', () => fixture(({ dir, lockPath, name, content, lock }) => {
  const applied = { [name]: hash(content) };
  writeFileSync(join(dir, name), content + '-- edit'); lock(content + '-- edit');
  assert.throws(() => readMigrationSnapshot({ migrationsDir: dir, lockPath, applied }), /APPLIED_MIGRATION_CHANGED/);
  rmSync(join(dir, name));
  assert.throws(() => readMigrationSnapshot({ migrationsDir: dir, lockPath, applied }), /APPLIED_MIGRATION_CHANGED/);
}));

test('execution uses immutable snapshot bytes, not a file edited after readiness', () => fixture(({ dir, lockPath, name, content, lock }) => {
  writeFileSync(join(dir, name), content); lock(content);
  const snapshot = readMigrationSnapshot({ migrationsDir: dir, lockPath, applied: {} });
  writeFileSync(join(dir, name), 'unfinished change');
  const staged = join(dir, 'staged'); stageSnapshot(snapshot, staged);
  assert.equal(readFileSync(join(staged, name), 'utf8'), content);
  assert.equal(snapshotSignature(snapshot), snapshotSignature([{ ...snapshot[0] }]));
}));

test('launcher keeps stderr diagnostics out of machine-readable wrangler stdout', () => {
  const capture = createOutputCapture();
  capture.appendStderr('(node:1) ExperimentalWarning: loader warning\n');
  capture.appendStdout('[{"results":[{"name":"0012_master_data_write_guards.sql"}]}]\n');
  assert.equal(JSON.parse(capture.stdout())[0].results[0].name, '0012_master_data_write_guards.sql');
  assert.match(capture.diagnostic(), /ExperimentalWarning/);

  const launcher = readFileSync(new URL('../scripts/dev/api-dev.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /createOutputCapture/, 'api-dev launcher must keep stdout and stderr in separate buffers');
});
