PRAGMA foreign_keys = ON;

CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  code TEXT COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  model TEXT NOT NULL COLLATE NOCASE,
  unit TEXT NOT NULL COLLATE NOCASE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(model, unit)
);

CREATE INDEX idx_materials_enabled_model ON materials(enabled, model, unit);

CREATE TABLE demand_categories (
  category_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE field_definitions (
  field_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('text', 'integer', 'quantity', 'year')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE import_mapping_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  mapping_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL COLLATE NOCASE UNIQUE,
  file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'csv')),
  mapping_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validating', 'review', 'ready', 'publishing', 'published')),
  uploaded_rows INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_rows >= 0),
  valid_rows INTEGER NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  error_rows INTEGER NOT NULL DEFAULT 0 CHECK (error_rows >= 0),
  warning_rows INTEGER NOT NULL DEFAULT 0 CHECK (warning_rows >= 0),
  published_rows INTEGER NOT NULL DEFAULT 0 CHECK (published_rows >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX idx_import_batches_status_created ON import_batches(status, created_at DESC, id DESC);

CREATE TABLE import_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 1),
  source_key TEXT NOT NULL UNIQUE,
  raw_json TEXT NOT NULL,
  normalized_json TEXT,
  errors_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  row_status TEXT NOT NULL DEFAULT 'uploaded' CHECK (row_status IN ('uploaded', 'valid', 'error', 'published')),
  published_demand_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, sheet_name, source_row_number)
);

CREATE INDEX idx_import_rows_batch_status ON import_rows(batch_id, row_status, source_row_number, id);
CREATE INDEX idx_import_rows_batch_chunk ON import_rows(batch_id, chunk_index, source_row_number);

CREATE TABLE demands (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  source_batch_id TEXT NOT NULL REFERENCES import_batches(id),
  source_file_sha256 TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
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
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_demands_created ON demands(created_at DESC, id DESC);
CREATE INDEX idx_demands_year_line ON demands(business_year, line_name COLLATE NOCASE);
CREATE INDEX idx_demands_category ON demands(category_key, created_at DESC);
CREATE INDEX idx_demands_signature ON demands(business_signature);

CREATE TABLE demand_materials (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  raw_model TEXT NOT NULL,
  material_id TEXT REFERENCES materials(id),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  unit TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_demand_materials_demand ON demand_materials(demand_id);
CREATE INDEX idx_demand_materials_material ON demand_materials(material_id, demand_id);

INSERT INTO field_definitions
  (field_key, label, data_type, required, sort_order, enabled, version, created_at, updated_at)
VALUES
  ('sequenceNo', '序号', 'text', 1, 10, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('voltage', '电压等级', 'text', 1, 20, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('lineName', '线路名称', 'text', 1, 30, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('section', '杆段', 'text', 1, 40, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('materialModel', '物资型号', 'text', 1, 50, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('materialQuantity', '物资数量', 'quantity', 1, 60, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('unit', '单位', 'text', 0, 70, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('year', '年度', 'year', 0, 80, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('category', '类别', 'text', 0, 90, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('owner', '负责人', 'text', 0, 100, 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
