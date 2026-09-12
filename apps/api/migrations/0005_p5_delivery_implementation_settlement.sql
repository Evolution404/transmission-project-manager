PRAGMA foreign_keys = ON;

CREATE TABLE release_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  release_date TEXT NOT NULL,
  note TEXT,
  project_version_snapshot INTEGER NOT NULL CHECK (project_version_snapshot >= 1),
  reserve_version_snapshot INTEGER NOT NULL CHECK (reserve_version_snapshot >= 0),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_release_batches_project_date ON release_batches(project_id, release_date DESC, created_at DESC, id DESC);

CREATE TABLE release_lines (
  id TEXT PRIMARY KEY,
  release_batch_id TEXT NOT NULL REFERENCES release_batches(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  demand_material_id TEXT NOT NULL REFERENCES demand_materials(id),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(release_batch_id, demand_material_id)
);

CREATE INDEX idx_release_lines_project_material ON release_lines(project_id, demand_material_id, created_at, id);
CREATE INDEX idx_release_lines_batch ON release_lines(release_batch_id, id);

CREATE TABLE implementation_records (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  historical INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0,1)),
  record_date TEXT NOT NULL,
  personnel TEXT,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((historical=0 AND project_id IS NOT NULL) OR historical=1)
);

CREATE INDEX idx_implementation_records_project_date ON implementation_records(project_id, record_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_implementation_records_unlinked ON implementation_records(historical, project_id, record_date DESC, id DESC);

CREATE TABLE implementation_lines (
  id TEXT PRIMARY KEY,
  implementation_id TEXT NOT NULL REFERENCES implementation_records(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id),
  release_line_id TEXT REFERENCES release_lines(id),
  demand_material_id TEXT REFERENCES demand_materials(id),
  description TEXT,
  unit TEXT,
  completed_quantity_scaled INTEGER NOT NULL CHECK (completed_quantity_scaled > 0),
  actual_used_quantity_scaled INTEGER CHECK (actual_used_quantity_scaled IS NULL OR actual_used_quantity_scaled >= 0),
  created_at TEXT NOT NULL,
  CHECK (
    (release_line_id IS NOT NULL AND project_id IS NOT NULL AND demand_material_id IS NOT NULL)
    OR
    (release_line_id IS NULL)
  )
);

CREATE INDEX idx_implementation_lines_release ON implementation_lines(release_line_id, implementation_id);
CREATE INDEX idx_implementation_lines_project_material ON implementation_lines(project_id, demand_material_id, implementation_id);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  settlement_date TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0,1)),
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  voided_at TEXT,
  voided_by TEXT REFERENCES members(id),
  void_reason TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);

CREATE INDEX idx_settlements_project_date ON settlements(project_id, settlement_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_settlements_active_final ON settlements(project_id, final, voided_at, settlement_date DESC, id DESC);

CREATE TABLE settlement_coverage (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  demand_material_id TEXT NOT NULL REFERENCES demand_materials(id),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  created_at TEXT NOT NULL,
  UNIQUE(settlement_id, demand_material_id)
);

CREATE INDEX idx_settlement_coverage_project_material ON settlement_coverage(project_id, demand_material_id, settlement_id);

CREATE TABLE settlement_agreement_allocations (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(settlement_id, agreement_id)
);

CREATE INDEX idx_settlement_agreement ON settlement_agreement_allocations(agreement_id, settlement_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  object_type TEXT NOT NULL CHECK (object_type IN ('project','release','implementation','settlement')),
  object_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  uploaded_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_attachments_object ON attachments(object_type, object_id, deleted_at, created_at DESC, id DESC);
CREATE INDEX idx_attachments_project ON attachments(project_id, deleted_at, created_at DESC, id DESC);
