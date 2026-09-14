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
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      session_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
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
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,
      actor_member_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      status_code INTEGER NOT NULL,
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

test('member admin repository creates a member, scopes, audit and idempotency atomically', async () => {
  const { sqlite, database, repository } = createRepository();
  try {
    assert.equal(await repository.bootstrapAdmin(bootstrapInput()), true);
    await repository.createMember({
      memberId: 'member-2',
      username: 'zhangsan',
      displayName: '张三',
      role: 'project_manager',
      enabled: true,
      salt: 'salt-2',
      verifier: 'verifier-2',
      credentialParamsJson: '{"m":19456}',
      nowIso: '2026-09-14T00:01:00.000Z',
      actorId: 'admin-1',
      scopes: [
        { id: 'scope-2a', type: 'project', scopeId: 'project-1' },
        { id: 'scope-2b', type: 'framework', scopeId: 'framework-1' },
      ],
      auditEventId: 'audit-create-2',
      auditAfterJson: JSON.stringify({ id: 'member-2', username: 'zhangsan' }),
      idempotency: {
        key: 'idem-create-2', operation: 'members.create:zhangsan', requestHash: 'request-hash', responseJson: '{"ok":true}', statusCode: 201,
      },
    });

    assert.equal(await repository.usernameExists('ZHANGSAN'), true);
    assert.deepEqual(await database.all({ sql: "SELECT scope_type,scope_id FROM member_scopes WHERE member_id='member-2' ORDER BY scope_type" }), [
      { scope_type: 'framework', scope_id: 'framework-1' },
      { scope_type: 'project', scope_id: 'project-1' },
    ]);
    assert.equal((await database.first({ sql: "SELECT action FROM audit_events WHERE id='audit-create-2'" }))?.action, 'member.create');
    assert.equal((await database.first({ sql: "SELECT status_code FROM idempotency_records WHERE idempotency_key='idem-create-2'" }))?.status_code, 201);

    await assert.rejects(repository.createMember({
      memberId: 'member-3', username: 'zhangsan', displayName: '重复', role: 'readonly', enabled: true,
      salt: 'salt-3', verifier: 'verifier-3', credentialParamsJson: '{}', nowIso: '2026-09-14T00:02:00.000Z', actorId: 'admin-1',
      scopes: [{ id: 'scope-3', type: 'all', scopeId: null }], auditEventId: 'audit-create-3', auditAfterJson: '{}',
      idempotency: { key: 'idem-create-3', operation: 'members.create:zhangsan', requestHash: 'other', responseJson: '{}', statusCode: 201 },
    }));
    assert.equal(await database.first({ sql: "SELECT id FROM member_scopes WHERE id='scope-3'" }), null);
    assert.equal(await database.first({ sql: "SELECT id FROM audit_events WHERE id='audit-create-3'" }), null);
  } finally {
    sqlite.close();
  }
});

test('member admin repository update is atomic on stale versions and protects the last enabled admin', async () => {
  const first = createRepository();
  try {
    assert.equal(await first.repository.bootstrapAdmin(bootstrapInput()), true);
    const protectedResult = await first.repository.updateMember({
      memberId: 'admin-1', expectedVersion: 1, displayName: '管理员', role: 'readonly', enabled: true,
      protectsLastAdmin: true, invalidateSessions: false, nowIso: '2026-09-14T00:03:00.000Z', actorId: 'admin-1',
      scopes: [{ id: 'scope-update-protected', type: 'all', scopeId: null }],
      auditEventId: 'audit-update-protected', beforeJson: '{"version":1}', afterJson: '{"version":2}',
      idempotency: { key: 'idem-update-protected', operation: 'members.patch:admin-1', requestHash: 'protected', responseJson: '{}', statusCode: 200 },
    });
    assert.equal(protectedResult, 'last_admin');
    assert.equal((await first.database.first({ sql: "SELECT role,version FROM members WHERE id='admin-1'" })).role, 'admin');
    assert.equal(await first.database.first({ sql: "SELECT id FROM audit_events WHERE id='audit-update-protected'" }), null);
  } finally {
    first.sqlite.close();
  }

  const second = createRepository();
  try {
    assert.equal(await second.repository.bootstrapAdmin(bootstrapInput()), true);
    await second.repository.createMember({
      memberId: 'admin-2', username: 'admin2', displayName: '管理员2', role: 'admin', enabled: true,
      salt: 'salt-2', verifier: 'verifier-2', credentialParamsJson: '{}', nowIso: '2026-09-14T00:01:00.000Z', actorId: 'admin-1',
      scopes: [{ id: 'scope-admin-2', type: 'all', scopeId: null }], auditEventId: 'audit-admin-2', auditAfterJson: '{}',
      idempotency: { key: 'idem-admin-2', operation: 'members.create:admin2', requestHash: 'create-admin2', responseJson: '{}', statusCode: 201 },
    });

    const updated = await second.repository.updateMember({
      memberId: 'admin-1', expectedVersion: 1, displayName: '管理员A', role: 'readonly', enabled: true,
      protectsLastAdmin: true, invalidateSessions: false, nowIso: '2026-09-14T00:04:00.000Z', actorId: 'admin-1',
      scopes: [{ id: 'scope-update-1', type: 'project', scopeId: 'project-1' }],
      auditEventId: 'audit-update-1', beforeJson: '{"version":1}', afterJson: '{"version":2}',
      idempotency: { key: 'idem-update-1', operation: 'members.patch:admin-1', requestHash: 'update-1', responseJson: '{}', statusCode: 200 },
    });
    assert.equal(updated, 'updated');
    assert.deepEqual(await second.database.all({ sql: "SELECT scope_type,scope_id FROM member_scopes WHERE member_id='admin-1'" }), [
      { scope_type: 'project', scope_id: 'project-1' },
    ]);

    const stale = await second.repository.updateMember({
      memberId: 'admin-1', expectedVersion: 1, displayName: '不应写入', role: 'readonly', enabled: false,
      protectsLastAdmin: false, invalidateSessions: true, nowIso: '2026-09-14T00:05:00.000Z', actorId: 'admin-2',
      scopes: [{ id: 'scope-stale', type: 'all', scopeId: null }], auditEventId: 'audit-stale', beforeJson: '{}', afterJson: '{}',
      idempotency: { key: 'idem-stale', operation: 'members.patch:admin-1', requestHash: 'stale', responseJson: '{}', statusCode: 200 },
    });
    assert.equal(stale, 'version_conflict');
    assert.equal(await second.database.first({ sql: "SELECT id FROM member_scopes WHERE id='scope-stale'" }), null);
    assert.equal(await second.database.first({ sql: "SELECT id FROM audit_events WHERE id='audit-stale'" }), null);
    assert.equal(await second.database.first({ sql: "SELECT idempotency_key FROM idempotency_records WHERE idempotency_key='idem-stale'" }), null);
  } finally {
    second.sqlite.close();
  }
});

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
