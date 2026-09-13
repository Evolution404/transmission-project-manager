PRAGMA foreign_keys = ON;

-- Demand provenance is many-to-one: several source rows may describe one abstract demand.
CREATE TABLE demand_source_rows (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  import_row_id TEXT NOT NULL REFERENCES import_rows(id),
  source_key TEXT NOT NULL UNIQUE,
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 1),
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(demand_id, import_row_id)
);
CREATE INDEX idx_demand_source_rows_demand ON demand_source_rows(demand_id, source_row_number, id);

ALTER TABLE demand_materials ADD COLUMN source_import_row_id TEXT REFERENCES import_rows(id);
ALTER TABLE demand_materials ADD COLUMN created_by TEXT REFERENCES members(id);
ALTER TABLE demand_materials ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);

INSERT INTO demand_source_rows
  (id,demand_id,import_row_id,source_key,file_sha256,file_name,sheet_name,source_row_number,raw_json,created_at)
SELECT
  'legacy-source:' || d.id,
  d.id,
  ir.id,
  d.source_key,
  d.source_file_sha256,
  d.source_file_name,
  d.source_sheet,
  d.source_row_number,
  d.raw_json,
  d.created_at
FROM demands d
INNER JOIN import_rows ir ON ir.source_key=d.source_key
WHERE d.source_type='import';

UPDATE demand_materials
SET source_import_row_id=(
      SELECT ir.id FROM demands d
      INNER JOIN import_rows ir ON ir.source_key=d.source_key
      WHERE d.id=demand_materials.demand_id
      LIMIT 1
    ),
    created_by=(SELECT d.created_by FROM demands d WHERE d.id=demand_materials.demand_id)
WHERE source_import_row_id IS NULL;

-- Project origin and project material plan are deliberately separate facts.
CREATE TABLE project_demand_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  demand_id TEXT NOT NULL REFERENCES demands(id),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, demand_id)
);
CREATE INDEX idx_project_demand_links_project ON project_demand_links(project_id, demand_id);
CREATE INDEX idx_project_demand_links_demand ON project_demand_links(demand_id, project_id);

CREATE TABLE project_material_requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  material_id TEXT REFERENCES materials(id),
  model TEXT NOT NULL,
  unit TEXT NOT NULL,
  required_quantity_scaled INTEGER NOT NULL CHECK (required_quantity_scaled > 0),
  unit_price_scaled INTEGER CHECK (unit_price_scaled IS NULL OR unit_price_scaled >= 0),
  amount_fen INTEGER CHECK (amount_fen IS NULL OR amount_fen >= 0),
  reserve_category_id TEXT REFERENCES reserve_categories(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_material_requirements_project ON project_material_requirements(project_id, active, id);
CREATE INDEX idx_project_material_requirements_category ON project_material_requirements(reserve_category_id, active, project_id);

CREATE TABLE project_material_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version INTEGER NOT NULL CHECK (project_version >= 1),
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_project_material_revisions_project ON project_material_revisions(project_id, created_at DESC, id DESC);

-- Project release is one project-level transition snapshot, not a material shipment.
CREATE TABLE project_releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  release_date TEXT NOT NULL,
  note TEXT,
  project_version_snapshot INTEGER NOT NULL CHECK (project_version_snapshot >= 1),
  reserve_version_snapshot INTEGER NOT NULL CHECK (reserve_version_snapshot >= 1),
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_project_releases_date ON project_releases(release_date DESC, created_at DESC, id DESC);

CREATE TABLE project_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  project_release_id TEXT NOT NULL REFERENCES project_releases(id),
  name TEXT NOT NULL,
  description TEXT,
  scope_text TEXT,
  owner TEXT,
  planned_date TEXT,
  planned_quantity_scaled INTEGER NOT NULL CHECK (planned_quantity_scaled > 0),
  unit TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  implementation_version INTEGER NOT NULL DEFAULT 1 CHECK (implementation_version >= 1),
  settlement_version INTEGER NOT NULL DEFAULT 1 CHECK (settlement_version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_tasks_project ON project_tasks(project_id, created_at, id);
CREATE INDEX idx_project_tasks_release ON project_tasks(project_release_id, created_at, id);

CREATE TABLE task_demand_scopes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  demand_id TEXT NOT NULL REFERENCES demands(id),
  planned_quantity_scaled INTEGER NOT NULL CHECK (planned_quantity_scaled > 0),
  created_at TEXT NOT NULL,
  UNIQUE(task_id, demand_id)
);
CREATE INDEX idx_task_demand_scopes_task ON task_demand_scopes(task_id, id);
CREATE INDEX idx_task_demand_scopes_demand ON task_demand_scopes(demand_id, task_id);

CREATE TABLE task_material_requirements (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  project_material_requirement_id TEXT REFERENCES project_material_requirements(id),
  material_id TEXT REFERENCES materials(id),
  model TEXT NOT NULL,
  unit TEXT NOT NULL,
  required_quantity_scaled INTEGER NOT NULL CHECK (required_quantity_scaled > 0),
  supply_version INTEGER NOT NULL DEFAULT 1 CHECK (supply_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, project_material_requirement_id)
);
CREATE INDEX idx_task_material_requirements_task ON task_material_requirements(task_id, id);
CREATE INDEX idx_task_material_project_requirement ON task_material_requirements(project_material_requirement_id, task_id);

CREATE TABLE material_supply_events (
  id TEXT PRIMARY KEY,
  task_material_requirement_id TEXT NOT NULL REFERENCES task_material_requirements(id),
  stage TEXT NOT NULL CHECK (stage IN ('reported','shipped','arrived')),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  event_date TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_material_supply_events_requirement ON material_supply_events(task_material_requirement_id, stage, event_date, created_at, id);

CREATE TABLE task_implementation_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES project_tasks(id),
  record_date TEXT NOT NULL,
  completed_quantity_scaled INTEGER NOT NULL CHECK (completed_quantity_scaled > 0),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_implementation_records_task ON task_implementation_records(task_id, record_date, created_at, id);

CREATE TABLE task_implementation_scope_lines (
  id TEXT PRIMARY KEY,
  implementation_id TEXT NOT NULL REFERENCES task_implementation_records(id) ON DELETE CASCADE,
  task_demand_scope_id TEXT NOT NULL REFERENCES task_demand_scopes(id),
  completed_quantity_scaled INTEGER NOT NULL CHECK (completed_quantity_scaled > 0),
  created_at TEXT NOT NULL,
  UNIQUE(implementation_id, task_demand_scope_id)
);
CREATE INDEX idx_task_impl_scope_scope ON task_implementation_scope_lines(task_demand_scope_id, implementation_id);

CREATE TABLE task_material_usage_lines (
  id TEXT PRIMARY KEY,
  implementation_id TEXT NOT NULL REFERENCES task_implementation_records(id) ON DELETE CASCADE,
  task_material_requirement_id TEXT NOT NULL REFERENCES task_material_requirements(id),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(implementation_id, task_material_requirement_id)
);
CREATE INDEX idx_task_material_usage_requirement ON task_material_usage_lines(task_material_requirement_id, implementation_id);

CREATE TABLE task_settlements (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES project_tasks(id),
  settlement_date TEXT NOT NULL,
  coverage_quantity_scaled INTEGER NOT NULL CHECK (coverage_quantity_scaled > 0),
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
CREATE INDEX idx_task_settlements_task ON task_settlements(task_id, settlement_date, created_at, id);
CREATE INDEX idx_task_settlements_final ON task_settlements(task_id, final, voided_at, created_at, id);

CREATE TABLE task_settlement_scope_lines (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES task_settlements(id) ON DELETE CASCADE,
  task_demand_scope_id TEXT NOT NULL REFERENCES task_demand_scopes(id),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  created_at TEXT NOT NULL,
  UNIQUE(settlement_id, task_demand_scope_id)
);
CREATE INDEX idx_task_settlement_scope_scope ON task_settlement_scope_lines(task_demand_scope_id, settlement_id);

CREATE TABLE task_settlement_agreement_allocations (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES task_settlements(id) ON DELETE CASCADE,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(settlement_id, agreement_id)
);
CREATE INDEX idx_task_settlement_agreement ON task_settlement_agreement_allocations(agreement_id, settlement_id);

CREATE TABLE task_settlement_reminders (
  task_id TEXT PRIMARY KEY REFERENCES project_tasks(id) ON DELETE CASCADE,
  first_implementation_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  final_settlement_id TEXT REFERENCES task_settlements(id),
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_task_settlement_reminders_status_due ON task_settlement_reminders(status, due_date, task_id);
