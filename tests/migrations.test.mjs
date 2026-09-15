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

    assert.equal(objectCount('table'), 79);
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
      'backup_runs', 'voltage_levels', 'transmission_lines', 'physical_towers',
      'line_tower_positions', 'transmission_line_name_history', 'line_tower_position_no_history',
      'teams', 'tower_types', 'custom_field_definitions', 'custom_field_values', 'custom_field_value_sets',
      'custom_field_index', 'custom_field_multi_select_index',
    ];
    for (const name of expectedTables) {
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type=? AND name=?').get('table', name).count),
        1,
        `missing table ${name}`,
      );
    }

    const lineColumns = db.prepare('PRAGMA table_info(transmission_lines)').all().map((row) => row.name);
    const towerColumns = db.prepare('PRAGMA table_info(line_tower_positions)').all().map((row) => row.name);
    assert.ok(lineColumns.includes('tower_order_version'));
    assert.ok(towerColumns.includes('sort_rank'));
    assert.ok(towerColumns.includes('physical_tower_id'));
    assert.ok(!towerColumns.includes('sort_index'));
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='transmission_towers'").get().count), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='transmission_tower_no_history'").get().count), 0);

    const lineSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transmission_lines'").get().sql);
    const towerSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='line_tower_positions'").get().sql);
    assert.doesNotMatch(lineSql, /UNIQUE\s*\(\s*voltage_level_id\s*,\s*line_name/i);
    assert.doesNotMatch(towerSql, /UNIQUE\s*\(\s*line_id\s*,\s*tower_no/i);
    assert.match(towerSql, /UNIQUE\s*\(\s*line_id\s*,\s*sort_rank\s*\)/i);

    const physicalTowerId = 'physical-shared';
    db.prepare("INSERT INTO members (id,username,display_name,role,enabled,version,credential_salt,credential_verifier,credential_algorithm,credential_params_json,must_change_password,session_version,failed_login_count,credential_changed_at,created_at,updated_at) VALUES ('m','m','m','admin',1,1,'s','v','argon2id-v1','{}',0,1,0,'2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z')").run();
    db.prepare("INSERT INTO transmission_lines (id,voltage_level_id,line_name,name_valid_from,enabled,version,tower_order_version,created_at,updated_at) VALUES ('line-a','vl-ac-110','A线','2026-09-15T00:00:00.000Z',1,1,1,'2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z'),('line-b','vl-ac-110','B线','2026-09-15T00:00:00.000Z',1,1,1,'2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z')").run();
    db.prepare("INSERT INTO physical_towers (id,asset_code,enabled,version,created_at,updated_at) VALUES (?,?,1,1,'2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z')").run(physicalTowerId, 'PT-001');
    db.prepare("INSERT INTO line_tower_positions (id,line_id,physical_tower_id,tower_no,number_valid_from,sort_rank,enabled,version,created_at,updated_at) VALUES ('pos-a','line-a',?,'#001','2026-09-15T00:00:00.000Z',1000,1,1,'2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z'),('pos-b','line-b',?,'#003','2026-09-15T00:00:00.000Z',1000,1,1,'2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z')").run(physicalTowerId, physicalTowerId);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM line_tower_positions WHERE physical_tower_id=?').get(physicalTowerId).count), 2);

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
