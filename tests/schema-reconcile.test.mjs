import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const reconcileSql = readFileSync(new URL('../ops/production/master-data-schema-reconcile.sql', import.meta.url), 'utf8');

function oldDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = on;');
  db.exec(`
    CREATE TABLE members (id TEXT PRIMARY KEY);
    CREATE TABLE voltage_levels (id TEXT PRIMARY KEY);
    CREATE TABLE transmission_lines (
      id TEXT PRIMARY KEY,
      voltage_level_id TEXT NOT NULL REFERENCES voltage_levels(id) ON DELETE RESTRICT,
      line_code TEXT,
      line_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(voltage_level_id, line_name COLLATE NOCASE)
    );
    CREATE TABLE transmission_towers (
      id TEXT PRIMARY KEY,
      line_id TEXT NOT NULL REFERENCES transmission_lines(id) ON DELETE RESTRICT,
      tower_no TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      tower_type TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(line_id, tower_no COLLATE NOCASE),
      UNIQUE(line_id, sort_index)
    );
    CREATE INDEX idx_transmission_lines_voltage ON transmission_lines(voltage_level_id, enabled, line_name COLLATE NOCASE);
    CREATE INDEX idx_transmission_towers_line_sort ON transmission_towers(line_id, enabled, sort_index);
    CREATE TABLE demands (
      id TEXT PRIMARY KEY,
      line_id TEXT REFERENCES transmission_lines(id) ON DELETE RESTRICT,
      start_tower_id TEXT REFERENCES transmission_towers(id) ON DELETE RESTRICT,
      end_tower_id TEXT REFERENCES transmission_towers(id) ON DELETE RESTRICT
    );
    INSERT INTO members(id) VALUES ('admin');
    INSERT INTO voltage_levels(id) VALUES ('vl-220');
    INSERT INTO transmission_lines(id,voltage_level_id,line_name,enabled,version,created_at,updated_at)
      VALUES ('line-a','vl-220','测试线',1,3,'2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z');
    INSERT INTO transmission_towers(id,line_id,tower_no,sort_index,tower_type,enabled,version,created_at,updated_at)
      VALUES
      ('tower-2','line-a','#002',20,'角钢塔',1,2,'2026-01-02T00:00:00.000Z','2026-02-02T00:00:00.000Z'),
      ('tower-1','line-a','#001',10,NULL,1,1,'2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z');
  `);
  return db;
}

test('schema reconciliation preserves stable ids on an empty-demand production database', () => {
  const db = oldDatabase();
  db.exec(reconcileSql);

  const lineColumns = db.prepare('PRAGMA table_info(transmission_lines)').all().map((row) => row.name);
  const towerColumns = db.prepare('PRAGMA table_info(transmission_towers)').all().map((row) => row.name);
  assert.ok(lineColumns.includes('name_valid_from'));
  assert.ok(lineColumns.includes('tower_order_version'));
  assert.ok(towerColumns.includes('number_valid_from'));
  assert.ok(towerColumns.includes('sort_rank'));
  assert.ok(!towerColumns.includes('sort_index'));

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM demands').get().count, 0);
  assert.deepEqual(
    db.prepare('SELECT id,tower_no,sort_rank FROM transmission_towers ORDER BY sort_rank').all().map((row) => ({ ...row })),
    [
      { id: 'tower-1', tower_no: '#001', sort_rank: 1000 },
      { id: 'tower-2', tower_no: '#002', sort_rank: 2000 },
    ],
  );

  db.prepare(`INSERT INTO transmission_lines
    (id,voltage_level_id,line_name,name_valid_from,enabled,version,tower_order_version,created_at,updated_at)
    VALUES ('line-b','vl-220','测试线','2026-03-01T00:00:00.000Z',1,1,1,'2026-03-01T00:00:00.000Z','2026-03-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO transmission_towers
    (id,line_id,tower_no,number_valid_from,sort_rank,enabled,version,created_at,updated_at)
    VALUES ('tower-3','line-a','#001','2026-03-01T00:00:00.000Z',3000,1,1,'2026-03-01T00:00:00.000Z','2026-03-01T00:00:00.000Z')`).run();

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transmission_line_name_history').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transmission_tower_no_history').get().count, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
