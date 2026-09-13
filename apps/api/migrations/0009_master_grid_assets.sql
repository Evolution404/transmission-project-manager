PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS voltage_levels (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL UNIQUE,
  system_type TEXT NOT NULL,
  nominal_kv INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
