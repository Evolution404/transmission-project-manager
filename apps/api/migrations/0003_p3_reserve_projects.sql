PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  business_year INTEGER CHECK (business_year IS NULL OR (business_year >= 1900 AND business_year <= 2200)),
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  reserve_version INTEGER NOT NULL DEFAULT 0 CHECK (reserve_version >= 0),
  framework_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_projects_status_created ON projects(status, created_at DESC, id DESC);
CREATE INDEX idx_projects_year_created ON projects(business_year, created_at DESC, id DESC);
CREATE INDEX idx_projects_framework ON projects(framework_id, id);

CREATE TABLE project_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reserve_version INTEGER NOT NULL CHECK (reserve_version >= 1),
  snapshot_json TEXT NOT NULL,
  known_amount_fen INTEGER NOT NULL CHECK (known_amount_fen >= 0),
  missing_price_count INTEGER NOT NULL CHECK (missing_price_count >= 0),
  completeness_basis_points INTEGER NOT NULL CHECK (completeness_basis_points BETWEEN 0 AND 10000),
  reason TEXT,
  confirmed_by TEXT NOT NULL REFERENCES members(id),
  confirmed_at TEXT NOT NULL,
  UNIQUE(project_id, reserve_version)
);

CREATE INDEX idx_project_versions_project ON project_versions(project_id, reserve_version DESC);

CREATE TABLE demand_allocations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  demand_material_id TEXT NOT NULL REFERENCES demand_materials(id),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, demand_material_id)
);

CREATE INDEX idx_demand_allocations_project ON demand_allocations(project_id, id);
CREATE INDEX idx_demand_allocations_material ON demand_allocations(demand_material_id, project_id);

CREATE TABLE project_cost_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('material', 'construction', 'other')),
  demand_allocation_id TEXT REFERENCES demand_allocations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  unit_price_scaled INTEGER CHECK (unit_price_scaled IS NULL OR unit_price_scaled >= 0),
  amount_fen INTEGER CHECK (amount_fen IS NULL OR amount_fen >= 0),
  price_source TEXT,
  price_date TEXT,
  tax_inclusive INTEGER CHECK (tax_inclusive IS NULL OR tax_inclusive IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'material' AND demand_allocation_id IS NOT NULL)
    OR
    (kind IN ('construction', 'other') AND demand_allocation_id IS NULL AND unit_price_scaled IS NULL AND amount_fen IS NOT NULL)
  ),
  UNIQUE(project_id, demand_allocation_id)
);

CREATE INDEX idx_project_cost_lines_project ON project_cost_lines(project_id, kind, id);

CREATE TABLE reserve_categories (
  id TEXT PRIMARY KEY,
  category_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_reserve_categories_enabled ON reserve_categories(enabled, label COLLATE NOCASE);

CREATE TABLE category_mappings (
  id TEXT PRIMARY KEY,
  demand_category_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
  reserve_category_id TEXT NOT NULL REFERENCES reserve_categories(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_category_mappings_reserve ON category_mappings(reserve_category_id, demand_category_key);

CREATE TABLE category_cost_allocations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_line_id TEXT NOT NULL REFERENCES project_cost_lines(id) ON DELETE CASCADE,
  reserve_category_id TEXT NOT NULL REFERENCES reserve_categories(id),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(cost_line_id, reserve_category_id)
);

CREATE INDEX idx_category_cost_project ON category_cost_allocations(project_id, reserve_category_id, cost_line_id);
CREATE INDEX idx_category_cost_line ON category_cost_allocations(cost_line_id, reserve_category_id);
