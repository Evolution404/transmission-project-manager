PRAGMA foreign_keys = ON;

CREATE TABLE frameworks (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  total_amount_fen INTEGER NOT NULL CHECK (total_amount_fen >= 0),
  annual_target_fen INTEGER CHECK (annual_target_fen IS NULL OR annual_target_fen >= 0),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_date <= end_date)
);

CREATE INDEX idx_frameworks_period ON frameworks(start_date, end_date, id);

CREATE TABLE framework_versions (
  id TEXT PRIMARY KEY,
  framework_id TEXT NOT NULL REFERENCES frameworks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  total_amount_fen INTEGER NOT NULL CHECK (total_amount_fen >= 0),
  annual_target_fen INTEGER CHECK (annual_target_fen IS NULL OR annual_target_fen >= 0),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  UNIQUE(framework_id, version)
);

CREATE INDEX idx_framework_versions_framework ON framework_versions(framework_id, version DESC);

CREATE TABLE agreements (
  id TEXT PRIMARY KEY,
  framework_id TEXT NOT NULL REFERENCES frameworks(id),
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','expired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (valid_from <= valid_to)
);

CREATE INDEX idx_agreements_framework ON agreements(framework_id, status, valid_from, valid_to, id);

CREATE TABLE agreement_versions (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  framework_id TEXT NOT NULL REFERENCES frameworks(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','expired')),
  reason TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  UNIQUE(agreement_id, version)
);

CREATE INDEX idx_agreement_versions_agreement ON agreement_versions(agreement_id, version DESC);

CREATE TABLE project_budgets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  total_amount_fen INTEGER NOT NULL CHECK (total_amount_fen >= 0),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
  budget_version INTEGER NOT NULL DEFAULT 0 CHECK (budget_version >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_project_budgets_status ON project_budgets(status, project_id);

CREATE TABLE budget_allocations (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES project_budgets(id) ON DELETE CASCADE,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(budget_id, agreement_id)
);

CREATE INDEX idx_budget_allocations_budget ON budget_allocations(budget_id, agreement_id);
CREATE INDEX idx_budget_allocations_agreement ON budget_allocations(agreement_id, budget_id);

CREATE TABLE budget_versions (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES project_budgets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  framework_id TEXT NOT NULL REFERENCES frameworks(id),
  budget_version INTEGER NOT NULL CHECK (budget_version >= 1),
  total_amount_fen INTEGER NOT NULL CHECK (total_amount_fen >= 0),
  note TEXT,
  confirmed_by TEXT NOT NULL REFERENCES members(id),
  confirmed_at TEXT NOT NULL,
  UNIQUE(budget_id, budget_version)
);

CREATE INDEX idx_budget_versions_project ON budget_versions(project_id, budget_version DESC);
CREATE INDEX idx_budget_versions_framework ON budget_versions(framework_id, project_id, budget_version DESC);

CREATE TABLE budget_version_allocations (
  id TEXT PRIMARY KEY,
  budget_version_id TEXT NOT NULL REFERENCES budget_versions(id) ON DELETE CASCADE,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(budget_version_id, agreement_id)
);

CREATE INDEX idx_budget_version_allocations_version ON budget_version_allocations(budget_version_id, agreement_id);
CREATE INDEX idx_budget_version_allocations_agreement ON budget_version_allocations(agreement_id, budget_version_id);

CREATE TABLE financial_entries (
  id TEXT PRIMARY KEY,
  framework_id TEXT NOT NULL REFERENCES frameworks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('budget_occurrence','actual_cost')),
  business_date TEXT NOT NULL,
  amount_fen INTEGER NOT NULL,
  note TEXT,
  reverses_entry_id TEXT REFERENCES financial_entries(id),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  CHECK (amount_fen <> 0)
);

CREATE UNIQUE INDEX idx_financial_entries_reversal_once ON financial_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX idx_financial_entries_framework_date ON financial_entries(framework_id, business_date, id);
CREATE INDEX idx_financial_entries_project_date ON financial_entries(project_id, business_date, id);
CREATE INDEX idx_financial_entries_type_date ON financial_entries(entry_type, business_date, id);

CREATE TABLE financial_entry_allocations (
  id TEXT PRIMARY KEY,
  financial_entry_id TEXT NOT NULL REFERENCES financial_entries(id) ON DELETE CASCADE,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  amount_fen INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (amount_fen <> 0),
  UNIQUE(financial_entry_id, agreement_id)
);

CREATE INDEX idx_financial_allocations_entry ON financial_entry_allocations(financial_entry_id, agreement_id);
CREATE INDEX idx_financial_allocations_agreement ON financial_entry_allocations(agreement_id, financial_entry_id);
