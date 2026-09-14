import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const hash = (content) => createHash('sha256').update(content).digest('hex');
export function readMigrationSnapshot({ migrationsDir, lockPath, applied }) {
  const names = readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const snapshot = names.map((name) => {
    const content = readFileSync(join(migrationsDir, name), 'utf8');
    return { name, content, hash: hash(content) };
  });
  for (const [name, checksum] of Object.entries(applied)) {
    if (snapshot.find((file) => file.name === name)?.hash !== checksum) throw new Error(`APPLIED_MIGRATION_CHANGED: 已执行 migration ${name} 被修改或删除；恢复原文件并追加新版本。`);
  }
  let lock;
  try { lock = Object.fromEntries(Object.entries(JSON.parse(readFileSync(lockPath, 'utf8'))).map(([path, value]) => [basename(path), value])); }
  catch { throw new Error('MIGRATION_NOT_READY: checksum lock 尚未写完。'); }
  if (!snapshot.length || snapshot.some((file) => !file.content.trim() || lock[file.name] !== file.hash) || Object.keys(lock).some((name) => !names.includes(name))) {
    throw new Error('MIGRATION_NOT_READY: 新 migration 尚未完整写入并匹配 tests/migrations.lock.json；暂不执行。');
  }
  return snapshot;
}
export function snapshotSignature(snapshot) { return JSON.stringify(snapshot.map(({ name, hash: checksum }) => [name, checksum])); }
export function stageSnapshot(snapshot, directory) {
  mkdirSync(directory, { recursive: true });
  for (const file of snapshot) writeFileSync(join(directory, file.name), file.content, { flag: 'wx' });
}
