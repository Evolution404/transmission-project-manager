PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO members (id, email, display_name, role, enabled, version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'dev-admin@example.invalid', '本地开发管理员', 'admin', 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000003', 'dev-readonly@example.invalid', '本地只读测试成员', 'readonly', 1, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000004', 'dev-disabled@example.invalid', '本地停用测试成员', 'readonly', 0, 1, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');

INSERT OR IGNORE INTO member_scopes (id, member_id, scope_type, scope_id, created_at)
VALUES
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'all', NULL, '2026-09-12T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000003', 'project', 'synthetic-project-a', '2026-09-12T00:00:00.000Z');
