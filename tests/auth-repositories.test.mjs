import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
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
      must_change_password INTEGER NOT NULL,
      session_version INTEGER NOT NULL,
      invited_at TEXT,
      first_login_at TEXT,
      last_login_at TEXT
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
  `);
  const database = new SqliteDatabaseAdapter(sqlite);
  return {
    sqlite,
    database,
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
    await database.run({
      sql: 'INSERT INTO auth_sessions (id,member_id,token_hash,session_version,created_at,last_seen_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,NULL)',
      params: ['session-1', 'member-1', 'hash-1', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z'],
    });

    await sessions.touchLastSeen('hash-1', '2026-09-14T00:00:00.000Z', '2026-09-13T23:00:00.000Z');
    assert.equal((await sessions.findByTokenHash('hash-1'))?.lastSeenAt, '2026-09-14T00:00:00.000Z');
  } finally {
    sqlite.close();
  }
});
