import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const BASELINE = '0001_initial_schema.sql';
const hash = (content) => createHash('sha256').update(content).digest('hex');

export function readMigrationSnapshot({ migrationsDir, lockPath }) {
  const names = readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  if (names.length !== 1 || names[0] !== BASELINE) {
    throw new Error(`DEVELOPMENT_SCHEMA_BASELINE_ONLY: 开发阶段只允许 ${BASELINE}；除非用户明确要求兼容已有数据/升级路径，否则禁止新增 0002+ migration。`);
  }

  const snapshot = names.map((name) => {
    const content = readFileSync(join(migrationsDir, name), 'utf8');
    return { name, content, hash: hash(content) };
  });

  let lock;
  try {
    lock = Object.fromEntries(Object.entries(JSON.parse(readFileSync(lockPath, 'utf8'))).map(([path, value]) => [basename(path), value]));
  } catch {
    throw new Error('MIGRATION_NOT_READY: checksum lock 尚未写完。');
  }
  if (!snapshot[0].content.trim() || lock[BASELINE] !== snapshot[0].hash || Object.keys(lock).length !== 1) {
    throw new Error('MIGRATION_NOT_READY: 0001_initial_schema.sql 必须与 tests/migrations.lock.json 的唯一 checksum 完全一致。');
  }
  return snapshot;
}

export function snapshotSignature(snapshot) {
  return JSON.stringify(snapshot.map(({ name, hash: checksum }) => [name, checksum]));
}

export function stageSnapshot(snapshot, directory) {
  mkdirSync(directory, { recursive: true });
  for (const file of snapshot) writeFileSync(join(directory, file.name), file.content, { flag: 'wx' });
}
