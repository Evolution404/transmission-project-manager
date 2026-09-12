PRAGMA foreign_keys = ON;

CREATE TABLE analysis_rules (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('ratio','gap')),
  threshold_basis_points INTEGER NOT NULL CHECK (threshold_basis_points >= 0 AND threshold_basis_points <= 10000),
  effective_from TEXT NOT NULL,
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL
);

CREATE TABLE monthly_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  business_year INTEGER NOT NULL CHECK (business_year BETWEEN 2000 AND 2200),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  target_amount_fen INTEGER NOT NULL CHECK (target_amount_fen >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,business_year,month)
);
CREATE INDEX idx_monthly_plans_year_month ON monthly_plans(business_year,month,project_id);

CREATE TABLE report_snapshots (
  id TEXT PRIMARY KEY,
  framework_id TEXT NOT NULL REFERENCES frameworks(id),
  business_month TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  data_cutoff_date TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  rule_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  UNIQUE(framework_id,business_month,revision)
);
CREATE INDEX idx_report_snapshots_month ON report_snapshots(framework_id,business_month,revision DESC);

CREATE TABLE annual_milestones (
  id TEXT PRIMARY KEY,
  business_year INTEGER NOT NULL CHECK (business_year BETWEEN 2000 AND 2200),
  title TEXT NOT NULL,
  owner TEXT,
  project_id TEXT REFERENCES projects(id),
  date_precision TEXT NOT NULL CHECK (date_precision IN ('month','day','unknown')),
  month INTEGER CHECK (month BETWEEN 1 AND 12),
  specific_date TEXT,
  lead_days_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (date_precision='month' AND month IS NOT NULL AND specific_date IS NULL) OR
    (date_precision='day' AND month IS NOT NULL AND specific_date IS NOT NULL) OR
    (date_precision='unknown' AND month IS NULL AND specific_date IS NULL)
  )
);
CREATE INDEX idx_annual_milestones_year_status ON annual_milestones(business_year,status,month,specific_date);

CREATE TABLE notification_contacts (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  verified_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(member_id,address)
);
CREATE INDEX idx_notification_contacts_enabled ON notification_contacts(enabled,verified_at,member_id);

CREATE TABLE alert_events (
  id TEXT PRIMARY KEY,
  rule_key TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  state TEXT NOT NULL CHECK (state IN ('active','resolved')),
  unique_event_key TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_alert_events_state ON alert_events(state,last_seen_at DESC);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  notification_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','leased','sent','failed','unknown')),
  lease_token TEXT,
  lease_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_notification_outbox_claim ON notification_outbox(status,next_attempt_at,lease_until,created_at);

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  backup_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('daily','monthly')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  current_table_index INTEGER NOT NULL DEFAULT 0 CHECK (current_table_index >= 0),
  cursor_rowid INTEGER NOT NULL DEFAULT 0 CHECK (cursor_rowid >= 0),
  manifest_key TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(backup_date,kind)
);
CREATE INDEX idx_backup_runs_status ON backup_runs(status,backup_date);

CREATE TABLE backup_chunks (
  id TEXT PRIMARY KEY,
  backup_run_id TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  r2_key TEXT NOT NULL UNIQUE,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(backup_run_id,table_name,chunk_index)
);
CREATE INDEX idx_backup_chunks_run ON backup_chunks(backup_run_id,table_name,chunk_index);

INSERT INTO analysis_rules (id,version,mode,threshold_basis_points,effective_from,created_by,created_at)
VALUES ('analysis-rule-v1',1,'ratio',8000,'2026-01-01T00:00:00.000Z',NULL,'2026-01-01T00:00:00.000Z');
