import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlCredentialRepository } from '../apps/api/src/repositories/sql-credential-repository.ts';
import { SqlMemberRepository } from '../apps/api/src/repositories/sql-member-repository.ts';
import { SqlSessionRepository } from '../apps/api/src/repositories/sql-session-repository.ts';

function createRepositories() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      version INTEGER NOT NULL,
      credential_salt TEXT NOT NULL DEFAULT 'salt',
      credential_verifier TEXT NOT NULL DEFAULT 'verifier',
      credential_algorithm TEXT NOT NULL DEFAULT 'argon2id-v1',
      credential_params_json TEXT NOT NULL DEFAULT '{}',
      must_change_password INTEGER NOT NULL,
      session_version INTEGER NOT NULL,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_failed_login_at TEXT,
      credential_changed_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00.000Z',
      invited_at TEXT,
      first_login_at TEXT,
      last_login_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00.000Z'
    );
    CREATE TABLE member_scopes (
      member_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT
    );
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
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
  `);
  const database = new SqliteDatabaseAdapter(sqlite);
  return {
    sqlite,
    database,
    credentials: new SqlCredentialRepository(database),
    members: new SqlMemberRepository(database),
    sessions: new SqlSessionRepository(database),
  };
}

test('portable auth repositories resolve session version, member summary and scopes', async () => {
  const { sqlite, database, members, sessions } = createRepositories();
  try {
    await database.batch([
      {
        sql: 'INSERT INTO members (id,username,display_name,role,enabled,version,must_change_password,session_version,invited_at,first_login_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        params: ['member-1', 'alice', 'Alice', 'project_manager', 1, 3, 0, 7, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z'],
      },
      { sql: 'INSERT INTO member_scopes (member_id,scope_type,scope_id) VALUES (?,?,?)', params: ['member-1', 'project', 'project-1'] },
      {
        sql: 'INSERT INTO auth_sessions (id,member_id,token_hash,session_version,created_at,last_seen_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,NULL)',
        params: ['session-1', 'member-1', 'hash-1', 7, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', '2026-09-20T00:00:00.000Z'],
      },
    ]);

    assert.deepEqual(await sessions.findByTokenHash('hash-1'), {
      memberId: 'member-1',
      sessionVersion: 7,
      memberSessionVersion: 7,
      lastSeenAt: '2026-09-03T00:00:00.000Z',
      expiresAt: '2026-09-20T00:00:00.000Z',
      revokedAt: null,
    });
    const member = await members.findById('member-1');
    assert.equal(member?.username, 'alice');
    assert.equal(member?.lifecycleStatus, 'active');
    assert.deepEqual(member?.scopes, [{ type: 'project', id: 'project-1' }]);
    assert.equal(await members.count(), 1);
    const refreshed = await members.recordSuccessfulLogin(member, '2026-09-14T00:00:00.000Z', '2026-09-13T23:00:00.000Z');
    assert.equal(refreshed.lastLoginAt, '2026-09-14T00:00:00.000Z');
  } finally {
    sqlite.close();
  }
});

test('credential repository handles case-insensitive lookup and atomic login failure audit', async () => {
  const { sqlite, database, credentials } = createRepositories();
  try {
    await database.run({
      sql: `INSERT INTO members
            (id,username,display_name,role,enabled,version,credential_salt,credential_verifier,credential_algorithm,credential_params_json,
             must_change_password,session_version,failed_login_count,locked_until,last_failed_login_at,credential_changed_at,invited_at,first_login_at,last_login_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        'member-1', 'alice', 'Alice', 'readonly', 1, 1, 'salt-1', 'verifier-1', 'argon2id-v1', '{"m":19456}',
        0, 4, 0, null, null, '2026-09-01T00:00:00.000Z', null, null, null, '2026-09-01T00:00:00.000Z',
      ],
    });

    const credential = await credentials.findByUsername('ALICE');
    assert.equal(credential?.memberId, 'member-1');
    assert.equal(credential?.credentialVerifier, 'verifier-1');
    assert.equal((await credentials.findByMemberId('member-1'))?.sessionVersion, 4);

    await credentials.recordLoginFailure({
      memberId: 'member-1',
      failedLoginCount: 5,
      lockedUntil: '2026-09-14T00:15:00.000Z',
      nowIso: '2026-09-14T00:00:00.000Z',
      auditEventId: 'audit-login-failure',
    });
    const failed = await credentials.findByMemberId('member-1');
    assert.equal(failed?.failedLoginCount, 5);
    assert.equal(failed?.lockedUntil, '2026-09-14T00:15:00.000Z');
    const audit = await database.first({ sql: 'SELECT action,after_json FROM audit_events WHERE id=?', params: ['audit-login-failure'] });
    assert.equal(audit?.action, 'auth.login_failed');
    assert.deepEqual(JSON.parse(audit.after_json), { failedLoginCount: 5, locked: true });

    await credentials.clearLoginFailures('member-1', '2026-09-14T00:01:00.000Z');
    const cleared = await credentials.findByMemberId('member-1');
    assert.equal(cleared?.failedLoginCount, 0);
    assert.equal(cleared?.lockedUntil, null);
  } finally {
    sqlite.close();
  }
});

test('session repository only touches stale non-revoked sessions', async () => {
  const { sqlite, database, sessions } = createRepositories();
  try {
    await database.run({
      sql: 'INSERT INTO members (id,username,display_name,role,enabled,version,must_change_password,session_version,invited_at,first_login_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      params: ['member-1', 'alice', 'Alice', 'readonly', 1, 1, 0, 1, null, null, null],
    });
    await sessions.create({
      id: 'session-1',
      memberId: 'member-1',
      tokenHash: 'hash-1',
      sessionVersion: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-20T00:00:00.000Z',
    });

    await sessions.touchLastSeen('hash-1', '2026-09-14T00:00:00.000Z', '2026-09-13T23:00:00.000Z');
    assert.equal((await sessions.findByTokenHash('hash-1'))?.lastSeenAt, '2026-09-14T00:00:00.000Z');
    await sessions.revokeByTokenHash('hash-1', '2026-09-14T00:01:00.000Z');
    assert.equal((await sessions.findByTokenHash('hash-1'))?.revokedAt, '2026-09-14T00:01:00.000Z');
  } finally {
    sqlite.close();
  }
});
