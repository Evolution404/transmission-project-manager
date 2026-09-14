PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_voltage_levels_enabled_sort ON voltage_levels(enabled, sort_order, nominal_kv);

CREATE TABLE IF NOT EXISTS transmission_lines (
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

CREATE INDEX IF NOT EXISTS idx_transmission_lines_voltage ON transmission_lines(voltage_level_id, enabled, line_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS transmission_towers (
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

CREATE INDEX IF NOT EXISTS idx_transmission_towers_line_sort ON transmission_towers(line_id, enabled, sort_index);

ALTER TABLE demands ADD COLUMN voltage_level_id TEXT REFERENCES voltage_levels(id) ON DELETE RESTRICT;
ALTER TABLE demands ADD COLUMN line_id TEXT REFERENCES transmission_lines(id) ON DELETE RESTRICT;
ALTER TABLE demands ADD COLUMN location_type TEXT;
ALTER TABLE demands ADD COLUMN start_tower_id TEXT REFERENCES transmission_towers(id) ON DELETE RESTRICT;
ALTER TABLE demands ADD COLUMN end_tower_id TEXT REFERENCES transmission_towers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_demands_line_location ON demands(line_id, location_type, start_tower_id, end_tower_id);

INSERT OR IGNORE INTO voltage_levels
(id,code,display_name,system_type,nominal_kv,sort_order,enabled,version,created_at,updated_at)
VALUES
('vl-ac-35','AC_35KV','35kV','AC',35,10,1,1,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'),
('vl-ac-110','AC_110KV','110kV','AC',110,20,1,1,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'),
('vl-ac-220','AC_220KV','220kV','AC',220,30,1,1,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'),
('vl-ac-500','AC_500KV','500kV','AC',500,40,1,1,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'),
('vl-ac-1000','AC_1000KV','1000kV','AC',1000,50,1,1,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'),
('vl-dc-500','DC_PM500KV','±500kV','DC',500,60,1,1,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'),
('vl-dc-800','DC_PM800KV','±800kV','DC',800,70,1,1,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'),
('vl-dc-1100','DC_PM1100KV','±1100kV','DC',1100,80,1,1,'2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z');
