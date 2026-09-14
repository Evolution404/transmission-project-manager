PRAGMA defer_foreign_keys = on;

CREATE TABLE transmission_lines_reconcile_20260914 (
  id TEXT PRIMARY KEY,
  voltage_level_id TEXT NOT NULL REFERENCES voltage_levels(id) ON DELETE RESTRICT,
  line_code TEXT,
  line_name TEXT NOT NULL,
  name_valid_from TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  tower_order_version INTEGER NOT NULL DEFAULT 1 CHECK (tower_order_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO transmission_lines_reconcile_20260914 (
  id, voltage_level_id, line_code, line_name, name_valid_from,
  enabled, version, tower_order_version, created_at, updated_at
)
SELECT id, voltage_level_id, line_code, line_name, created_at,
       enabled, version, 1, created_at, updated_at
FROM transmission_lines;

CREATE TABLE transmission_towers_reconcile_20260914 (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES transmission_lines_reconcile_20260914(id) ON DELETE RESTRICT,
  tower_no TEXT NOT NULL,
  number_valid_from TEXT NOT NULL,
  sort_rank INTEGER NOT NULL,
  tower_type TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(line_id, sort_rank)
);

INSERT INTO transmission_towers_reconcile_20260914 (
  id, line_id, tower_no, number_valid_from, sort_rank,
  tower_type, enabled, version, created_at, updated_at
)
SELECT id, line_id, tower_no, created_at,
       ROW_NUMBER() OVER (PARTITION BY line_id ORDER BY sort_index, id) * 1000,
       tower_type, enabled, version, created_at, updated_at
FROM transmission_towers;

DROP TABLE transmission_towers;
DROP TABLE transmission_lines;

ALTER TABLE transmission_lines_reconcile_20260914 RENAME TO transmission_lines;
ALTER TABLE transmission_towers_reconcile_20260914 RENAME TO transmission_towers;

CREATE TABLE transmission_line_name_history (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES transmission_lines(id) ON DELETE CASCADE,
  line_name TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES members(id),
  change_reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (valid_from < valid_to)
);

CREATE TABLE transmission_tower_no_history (
  id TEXT PRIMARY KEY,
  tower_id TEXT NOT NULL REFERENCES transmission_towers(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL REFERENCES transmission_lines(id) ON DELETE RESTRICT,
  tower_no TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES members(id),
  change_reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (valid_from < valid_to)
);

CREATE INDEX idx_transmission_line_name_history_lookup
  ON transmission_line_name_history(line_name COLLATE NOCASE, line_id, valid_to DESC);
CREATE INDEX idx_transmission_line_name_history_line
  ON transmission_line_name_history(line_id, valid_to DESC);
CREATE INDEX idx_transmission_lines_voltage
  ON transmission_lines(voltage_level_id, enabled, line_name COLLATE NOCASE, id);
CREATE INDEX idx_transmission_tower_no_history_lookup
  ON transmission_tower_no_history(tower_no COLLATE NOCASE, line_id, valid_to DESC);
CREATE INDEX idx_transmission_tower_no_history_tower
  ON transmission_tower_no_history(tower_id, valid_to DESC);
CREATE INDEX idx_transmission_towers_line_sort
  ON transmission_towers(line_id, enabled, sort_rank, id);
CREATE INDEX idx_transmission_towers_no_lookup
  ON transmission_towers(line_id, tower_no COLLATE NOCASE, id);

PRAGMA defer_foreign_keys = off;
