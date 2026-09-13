PRAGMA foreign_keys = OFF;

CREATE TABLE demands_next (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'import' CHECK (source_type IN ('import', 'manual')),
  source_key TEXT NOT NULL UNIQUE,
  source_batch_id TEXT REFERENCES import_batches(id),
  source_file_sha256 TEXT,
  source_file_name TEXT,
  source_sheet TEXT,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  sequence_no TEXT NOT NULL,
  business_year INTEGER,
  voltage_raw TEXT NOT NULL,
  voltage_verified TEXT,
  line_name TEXT NOT NULL,
  section_text TEXT NOT NULL,
  category_key TEXT,
  owner TEXT,
  business_signature TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (source_type = 'import'
      AND source_batch_id IS NOT NULL
      AND source_file_sha256 IS NOT NULL
      AND source_file_name IS NOT NULL
      AND source_sheet IS NOT NULL
      AND source_row_number IS NOT NULL)
    OR
    (source_type = 'manual'
      AND source_batch_id IS NULL
      AND source_file_sha256 IS NULL
      AND source_file_name IS NULL
      AND source_sheet IS NULL
      AND source_row_number IS NULL)
  )
);

INSERT INTO demands_next (
  id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,
  sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,
  raw_json,extra_json,version,created_by,created_at,updated_at
)
SELECT
  id,'import',source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,
  sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,
  raw_json,extra_json,version,created_by,created_at,updated_at
FROM demands;

DROP TABLE demands;
ALTER TABLE demands_next RENAME TO demands;

CREATE INDEX idx_demands_created ON demands(created_at DESC, id DESC);
CREATE INDEX idx_demands_year_line ON demands(business_year, line_name COLLATE NOCASE);
CREATE INDEX idx_demands_category ON demands(category_key, created_at DESC);
CREATE INDEX idx_demands_signature ON demands(business_signature);
CREATE INDEX idx_demands_source_type ON demands(source_type, created_at DESC, id DESC);

PRAGMA foreign_keys = ON;
