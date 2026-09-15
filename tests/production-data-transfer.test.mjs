import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planProductionDataTransfer } from '../scripts/production/data-transfer.mjs';

async function withFiles(sourceSql, targetSql, run) {
  const root = await mkdtemp(join(tmpdir(), 'tpm-data-transfer-'));
  try {
    const source = join(root, 'source.sql');
    const target = join(root, 'target.sql');
    await writeFile(source, sourceSql);
    await writeFile(target, targetSql);
    return await run({ root, source, target });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('production data transfer skips rebuild when source data layout already matches current baseline', async () => {
  const schema = `
    CREATE TABLE members (id TEXT PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO members VALUES ('m1','zhangsan');
  `;
  await withFiles(schema, 'CREATE TABLE members (id TEXT PRIMARY KEY, username TEXT NOT NULL);', async ({ source, target }) => {
    const plan = await planProductionDataTransfer({ sourceSqlPath: source, targetBaselinePath: target });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.rebuildRequired, false);
    assert.deepEqual(plan.decisionRequired, []);
    assert.deepEqual(plan.autoCopiedTables, ['members']);
  });
});

test('production data transfer automatically preserves rows when target only adds nullable/defaulted columns', async () => {
  await withFiles(
    `CREATE TABLE members (id TEXT PRIMARY KEY, username TEXT NOT NULL); INSERT INTO members VALUES ('m1','zhangsan');`,
    `CREATE TABLE members (id TEXT PRIMARY KEY, username TEXT NOT NULL, note TEXT, enabled INTEGER NOT NULL DEFAULT 1);`,
    async ({ source, target }) => {
      const plan = await planProductionDataTransfer({ sourceSqlPath: source, targetBaselinePath: target });
      assert.equal(plan.status, 'ready');
      assert.equal(plan.rebuildRequired, true);
      assert.deepEqual(plan.decisionRequired, []);
      assert.deepEqual(plan.autoCopiedTables, ['members']);
      assert.equal(plan.targetRows.members, 1);
    },
  );
});

test('production data transfer refuses to silently discard populated legacy columns', async () => {
  await withFiles(
    `CREATE TABLE members (id TEXT PRIMARY KEY, username TEXT NOT NULL, legacy_note TEXT); INSERT INTO members VALUES ('m1','zhangsan','keep me');`,
    `CREATE TABLE members (id TEXT PRIMARY KEY, username TEXT NOT NULL);`,
    async ({ source, target }) => {
      const plan = await planProductionDataTransfer({ sourceSqlPath: source, targetBaselinePath: target });
      assert.equal(plan.status, 'decision_required');
      assert.equal(plan.rebuildRequired, true);
      assert.ok(plan.decisionRequired.some((item) => item.table === 'members' && /legacy_note/.test(item.reason)));
    },
  );
});

test('production data transfer refuses to silently drop populated legacy tables', async () => {
  await withFiles(
    `CREATE TABLE legacy_items (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO legacy_items VALUES ('x','history');`,
    `CREATE TABLE current_items (id TEXT PRIMARY KEY, value TEXT NOT NULL);`,
    async ({ source, target }) => {
      const plan = await planProductionDataTransfer({ sourceSqlPath: source, targetBaselinePath: target });
      assert.equal(plan.status, 'decision_required');
      assert.ok(plan.decisionRequired.some((item) => item.table === 'legacy_items'));
    },
  );
});

test('explicit one-time transform can migrate changed historical data into the current model', async () => {
  await withFiles(
    `CREATE TABLE legacy_items (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO legacy_items VALUES ('x','history');`,
    `CREATE TABLE current_items (id TEXT PRIMARY KEY, label TEXT NOT NULL);`,
    async ({ root, source, target }) => {
      const initial = await planProductionDataTransfer({ sourceSqlPath: source, targetBaselinePath: target });
      const transform = join(root, 'transform.mjs');
      await writeFile(transform, `
        export const sourceFingerprint = '${initial.sourceFingerprint}';
        export const handledSourceTables = ['legacy_items'];
        export function transform({ source, target }) {
          const rows = source.prepare('SELECT id,value FROM legacy_items').all();
          const insert = target.prepare('INSERT INTO current_items(id,label) VALUES (?,?)');
          for (const row of rows) insert.run(row.id, row.value);
        }
        export function verify({ source, target }) {
          const oldCount = source.prepare('SELECT COUNT(*) AS count FROM legacy_items').get().count;
          const newCount = target.prepare('SELECT COUNT(*) AS count FROM current_items').get().count;
          return oldCount === newCount ? [] : ['legacy_items row count mismatch'];
        }
      `);
      const plan = await planProductionDataTransfer({ sourceSqlPath: source, targetBaselinePath: target, transformPath: transform });
      assert.equal(plan.status, 'ready');
      assert.equal(plan.rebuildRequired, true);
      assert.deepEqual(plan.decisionRequired, []);
      assert.deepEqual(plan.transformedSourceTables, ['legacy_items']);
      assert.equal(plan.targetRows.current_items, 1);
    },
  );
});

test('one-time transform is rejected when it was authored for a different source schema', async () => {
  await withFiles(
    `CREATE TABLE legacy_items (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO legacy_items VALUES ('x','history');`,
    `CREATE TABLE current_items (id TEXT PRIMARY KEY, label TEXT NOT NULL);`,
    async ({ root, source, target }) => {
      const transform = join(root, 'transform.mjs');
      await writeFile(transform, `
        export const sourceFingerprint = '${'0'.repeat(64)}';
        export const handledSourceTables = ['legacy_items'];
        export function transform() {}
        export function verify() { return []; }
      `);
      const plan = await planProductionDataTransfer({ sourceSqlPath: source, targetBaselinePath: target, transformPath: transform });
      assert.equal(plan.status, 'decision_required');
      assert.ok(plan.decisionRequired.some((item) => /指纹/.test(item.reason)));
    },
  );
});

