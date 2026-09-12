PRAGMA foreign_keys = ON;

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'project_manager', 'implementation', 'finance', 'readonly')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE member_scopes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'framework', 'project')),
  scope_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((scope_type = 'all' AND scope_id IS NULL) OR (scope_type != 'all' AND scope_id IS NOT NULL)),
  UNIQUE(member_id, scope_type, scope_id)
);

CREATE INDEX idx_member_scopes_member ON member_scopes(member_id);
CREATE INDEX idx_member_scopes_target ON member_scopes(scope_type, scope_id);

CREATE TABLE settings_versions (
  id TEXT PRIMARY KEY,
  setting_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  value_json TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  UNIQUE(setting_key, version)
);

CREATE INDEX idx_settings_versions_key_version ON settings_versions(setting_key, version DESC);

CREATE TABLE dictionary_items (
  id TEXT PRIMARY KEY,
  dictionary_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(dictionary_key, item_key)
);

CREATE INDEX idx_dictionary_items_lookup ON dictionary_items(dictionary_key, enabled, sort_order, item_key);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_member_id TEXT REFERENCES members(id),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_events_object ON audit_events(object_type, object_id, created_at DESC);
CREATE INDEX idx_audit_events_actor ON audit_events(actor_member_id, created_at DESC);

CREATE TABLE idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  actor_member_id TEXT NOT NULL REFERENCES members(id),
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_idempotency_actor_created ON idempotency_records(actor_member_id, created_at DESC);

INSERT INTO settings_versions (id, setting_key, version, value_json, effective_from, created_by, created_at)
VALUES (
  '00000000-0000-4000-8000-000000000010',
  'business.timezone',
  1,
  '{"timezone":"Asia/Shanghai"}',
  '2026-09-12T00:00:00.000Z',
  NULL,
  '2026-09-12T00:00:00.000Z'
), (
  '00000000-0000-4000-8000-000000000011',
  'pagination.default',
  1,
  '{"defaultPageSize":50,"maxPageSize":100}',
  '2026-09-12T00:00:00.000Z',
  NULL,
  '2026-09-12T00:00:00.000Z'
);

INSERT INTO dictionary_items (id, dictionary_key, item_key, label, value_json, enabled, sort_order, version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000020', 'member_role', 'admin', '管理员', NULL, 1, 10, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000021', 'member_role', 'project_manager', '项目管理', NULL, 1, 20, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000022', 'member_role', 'implementation', '实施', NULL, 1, 30, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000023', 'member_role', 'finance', '财务', NULL, 1, 40, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000024', 'member_role', 'readonly', '只读', NULL, 1, 50, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
