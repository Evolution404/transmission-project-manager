import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlMemberAdminRepository } from '../apps/api/src/repositories/sql-member-admin-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      version INTEGER NOT NULL,
      credential_salt TEXT NOT NULL,
      credential_verifier TEXT NOT NULL,
      credential_algorithm TEXT NOT NULL,
      credential_params_json TEXT NOT NULL,
      must_change_password INTEGER NOT NULL,
      session_version INTEGER NOT NULL,
      failed_login_count INTEGER NOT NULL,
      locked_until TEXT,
      last_failed_login_at TEXT,
      credential_changed_at TEXT NOT NULL,
      invited_at TEXT,
      first_login_at TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE member_scopes (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      actor_member_id TEXT,
      action TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const database = new SqliteDatabaseAdapter(sqlite);
  return { sqlite, database, repository: new SqlMemberAdminRepository(database) };
}

function bootstrapInput(id = 'admin-1') {
  const nowIso = '2026-09-14T00:00:00.000Z';
  return {
    memberId: id,
    username: id === 'admin-1' ? 'admin' : 'other-admin',
    displayName: '管理员',
    salt: 'salt',
    verifier: 'verifier',
    credentialParamsJson: '{"m":19456}',
    nowIso,
    scopeId: `scope-${id}`,
    auditEventId: `audit-${id}`,
    auditAfterJson: JSON.stringify({ id, role: 'admin' }),
  };
}

test('member admin repository bootstraps exactly one administrator on an empty database', async () => {
  const { sqlite, database, repository } = createRepository();
  try {
    assert.equal(await repository.bootstrapAdmin(bootstrapInput()), true);
    assert.equal(await repository.bootstrapAdmin(bootstrapInput('admin-2')), false);

    const members = await database.all({ sql: 'SELECT id,username,role,enabled FROM members ORDER BY id' });
    assert.deepEqual(members, [{ id: 'admin-1', username: 'admin', role: 'admin', enabled: 1 }]);
    assert.deepEqual(await database.all({ sql: 'SELECT member_id,scope_type,scope_id FROM member_scopes' }), [
      { member_id: 'admin-1', scope_type: 'all', scope_id: null },
    ]);
    assert.deepEqual(await database.all({ sql: 'SELECT action,object_id FROM audit_events' }), [
      { action: 'auth.bootstrap', object_id: 'admin-1' },
    ]);
  } finally {
    sqlite.close();
  }
});
