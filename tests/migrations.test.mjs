import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  applyLocalMigrations,
  cleanupStateDir,
  makeStateDir,
  queryLocalD1,
} from './helpers/wrangler.mjs';

const apiDir = resolve(import.meta.dirname, '../apps/api');
const migrationsDir = resolve(apiDir, 'migrations');
const baselineName = '0001_initial_schema.sql';
const baselineSql = readFileSync(resolve(migrationsDir, baselineName), 'utf8');
const stateDirs = new Set();

function rows(result) {
  return result.flatMap((entry) => entry.results ?? []);
}

afterEach(() => {
  for (const dir of stateDirs) cleanupStateDir(dir);
  stateDirs.clear();
});

test('development database uses exactly one initial schema baseline', () => {
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  assert.deepEqual(migrationFiles, [baselineName]);
});

test('single initial schema creates the complete current database without historical upgrade steps', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(baselineSql);
    const objectCount = (type) => Number(db.prepare(
      'SELECT COUNT(*) AS count FROM sqlite_master WHERE type=? AND name NOT LIKE ?',
    ).get(type, 'sqlite_%').count);

    assert.equal(objectCount('table'), 71);
    assert.equal(objectCount('index'), 103);
    assert.equal(objectCount('trigger'), 0);
    assert.doesNotMatch(baselineSql, /\bCREATE\s+TRIGGER\b/i, 'single development baseline must stay compatible with standard Cloudflare D1 migrations');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM settings_versions').get().count), 2);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM dictionary_items WHERE dictionary_key='member_role'").get().count), 5);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM field_definitions').get().count), 10);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM voltage_levels').get().count), 8);

    const expectedTables = [
      'members', 'auth_sessions', 'demands', 'demand_materials', 'projects',
      'project_material_requirements', 'project_tasks', 'task_settlements',
      'frameworks', 'agreements', 'financial_entries', 'attachments',
      'backup_runs', 'voltage_levels', 'transmission_lines', 'transmission_towers',
      'transmission_line_name_history', 'transmission_tower_no_history',
    ];
    for (const name of expectedTables) {
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type=? AND name=?').get('table', name).count),
        1,
        `missing table ${name}`,
      );
    }

    const lineColumns = db.prepare('PRAGMA table_info(transmission_lines)').all().map((row) => row.name);
    const towerColumns = db.prepare('PRAGMA table_info(transmission_towers)').all().map((row) => row.name);
    assert.ok(lineColumns.includes('tower_order_version'));
    assert.ok(towerColumns.includes('sort_rank'));
    assert.ok(!towerColumns.includes('sort_index'));

    const lineSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transmission_lines'").get().sql);
    const towerSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transmission_towers'").get().sql);
    assert.doesNotMatch(lineSql, /UNIQUE\s*\(\s*voltage_level_id\s*,\s*line_name/i);
    assert.doesNotMatch(towerSql, /UNIQUE\s*\(\s*line_id\s*,\s*tower_no/i);
    assert.match(towerSql, /UNIQUE\s*\(\s*line_id\s*,\s*sort_rank\s*\)/i);

    assert.throws(
      () => db.exec('INSERT INTO master_data_guards (id,invalid_grid_location) VALUES (1,0)'),
      /INVALID_GRID_LOCATION/,
    );
    db.exec('INSERT INTO master_data_guards (id,invalid_grid_location) VALUES (1,1)');
    db.exec('INSERT INTO master_data_guards (id,invalid_grid_location) VALUES (1,1) ON CONFLICT(id) DO UPDATE SET invalid_grid_location=excluded.invalid_grid_location');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM master_data_guards').get().count), 1);
  } finally {
    db.close();
  }
});

test('Wrangler standard migration command applies the one-file baseline and is repeatable', () => {
  const stateDir = makeStateDir('tpm-single-baseline-');
  stateDirs.add(stateDir);

  applyLocalMigrations(stateDir);
  const first = rows(queryLocalD1(stateDir, 'SELECT id,name FROM d1_migrations ORDER BY id'));
  assert.deepEqual(first, [{ id: 1, name: baselineName }]);

  applyLocalMigrations(stateDir);
  const second = rows(queryLocalD1(stateDir, 'SELECT id,name FROM d1_migrations ORDER BY id'));
  assert.deepEqual(second, first);
  assert.equal(rows(queryLocalD1(stateDir, "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'"))[0].count, 0);
});
