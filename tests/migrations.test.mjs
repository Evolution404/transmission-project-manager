import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  applyLocalMigrations,
  cleanupStateDir,
  executeLocalD1,
  makeStateDir,
  queryLocalD1,
} from './helpers/wrangler.mjs';

const stateDirs = new Set();

function tempState(prefix) {
  const dir = makeStateDir(prefix);
  stateDirs.add(dir);
  return dir;
}

function rows(result) {
  return result.flatMap((entry) => entry.results ?? []);
}

afterEach(() => {
  for (const dir of stateDirs) cleanupStateDir(dir);
  stateDirs.clear();
});

test('P1.2 database upgrades to P2 without losing account, scope, settings or audit data', () => {
  const state = tempState('tpm-migration-p2-upgrade-');
  executeLocalD1(state, { file: 'migrations/0001_p1_identity_and_config.sql' });
  executeLocalD1(state, {
    command: `
      INSERT INTO members
        (id,username,display_name,role,enabled,version,credential_salt,credential_verifier,
         credential_algorithm,credential_params_json,must_change_password,session_version,
         failed_login_count,credential_changed_at,invited_at,first_login_at,last_login_at,created_at,updated_at)
      VALUES
        ('p2-existing','p2-existing','P2升级保留成员','admin',1,3,'test-salt','test-verifier',
         'argon2id-v1','{"algorithm":"argon2id-v1","memoryCostKiB":19456,"timeCost":2,"parallelism":1,"hashLength":32,"version":19}',
         0,2,0,'2026-03-01T00:00:00.000Z','2026-03-01T00:00:00.000Z',
         '2026-03-02T00:00:00.000Z','2026-04-01T00:00:00.000Z','2026-03-01T00:00:00.000Z','2026-04-01T00:00:00.000Z');
      INSERT INTO member_scopes (id,member_id,scope_type,scope_id,created_at)
      VALUES ('p2-scope','p2-existing','all',NULL,'2026-03-01T00:00:00.000Z');
      INSERT INTO auth_sessions
        (id,member_id,token_hash,session_version,created_at,last_seen_at,expires_at,revoked_at)
      VALUES
        ('p2-session','p2-existing','p2-session-token-hash',2,'2026-04-01T00:00:00.000Z',
         '2026-04-01T01:00:00.000Z','2026-04-08T00:00:00.000Z',NULL);
      INSERT INTO settings_versions (id,setting_key,version,value_json,effective_from,created_by,created_at)
      VALUES
        ('p2-setting','p2.retained.setting',1,'{"retained":true}','2026-04-01T00:00:00.000Z',
         'p2-existing','2026-04-01T00:00:00.000Z');
      INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
      VALUES ('p2-audit','p2-existing','pre.p2','member','p2-existing',NULL,'{}','2026-04-01T00:00:00.000Z');
    `,
  });

  executeLocalD1(state, { file: 'migrations/0002_p2_import_demands_materials.sql' });

  const member = rows(queryLocalD1(state,
    "SELECT username,display_name,role,version,session_version,first_login_at,last_login_at FROM members WHERE id='p2-existing';",
  ))[0];
  assert.deepEqual(member, {
    username: 'p2-existing',
    display_name: 'P2升级保留成员',
    role: 'admin',
    version: 3,
    session_version: 2,
    first_login_at: '2026-03-02T00:00:00.000Z',
    last_login_at: '2026-04-01T00:00:00.000Z',
  });
  assert.equal(rows(queryLocalD1(state, "SELECT COUNT(*) AS count FROM member_scopes WHERE member_id='p2-existing';"))[0].count, 1);
  assert.deepEqual(rows(queryLocalD1(state,
    "SELECT member_id,session_version,expires_at,revoked_at FROM auth_sessions WHERE id='p2-session';",
  ))[0], {
    member_id: 'p2-existing',
    session_version: 2,
    expires_at: '2026-04-08T00:00:00.000Z',
    revoked_at: null,
  });
  assert.equal(rows(queryLocalD1(state,
    "SELECT value_json FROM settings_versions WHERE id='p2-setting' AND created_by='p2-existing';",
  ))[0].value_json, '{"retained":true}');
  assert.equal(rows(queryLocalD1(state, "SELECT COUNT(*) AS count FROM audit_events WHERE id='p2-audit';"))[0].count, 1);
  assert.equal(rows(queryLocalD1(state, 'SELECT COUNT(*) AS count FROM field_definitions;'))[0].count, 10);
  assert.equal(rows(queryLocalD1(state,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('materials','import_batches','import_rows','demands','demand_materials');",
  ))[0].count, 5);
});

test('clean database applies the current P2 development schema and remains repeatable', () => {
  const state = tempState('tpm-migration-clean-');
  applyLocalMigrations(state);
  applyLocalMigrations(state);

  const migrations = rows(queryLocalD1(state, 'SELECT name FROM d1_migrations ORDER BY id;')).map((row) => row.name);
  assert.deepEqual(migrations, [
    '0001_p1_identity_and_config.sql',
    '0002_p2_import_demands_materials.sql',
  ]);

  const tables = rows(queryLocalD1(state,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  )).map((row) => row.name);
  for (const table of [
    'members', 'member_scopes', 'auth_sessions', 'settings_versions', 'dictionary_items',
    'audit_events', 'idempotency_records', 'materials', 'import_mapping_templates',
    'import_batches', 'import_rows', 'demands', 'demand_materials', 'field_definitions',
  ]) assert.ok(tables.includes(table), `missing table ${table}`);
});

test('member schema remains username/credential based after P2 migration', () => {
  const state = tempState('tpm-migration-auth-schema-');
  applyLocalMigrations(state);
  const columns = rows(queryLocalD1(state, 'PRAGMA table_info(members);')).map((row) => row.name);
  for (const required of [
    'username', 'credential_salt', 'credential_verifier', 'credential_algorithm',
    'credential_params_json', 'must_change_password', 'session_version',
    'failed_login_count', 'locked_until', 'credential_changed_at',
  ]) assert.ok(columns.includes(required), `members missing ${required}`);
  assert.equal(columns.includes('email'), false);
  assert.equal(columns.includes('password'), false);
  assert.equal(columns.includes('password_hash'), false);
});

test('default configuration and role dictionary are present without synthetic accounts', () => {
  const state = tempState('tpm-migration-defaults-');
  applyLocalMigrations(state);
  assert.equal(rows(queryLocalD1(state, 'SELECT COUNT(*) AS count FROM members;'))[0].count, 0);
  assert.equal(rows(queryLocalD1(state, 'SELECT COUNT(*) AS count FROM settings_versions;'))[0].count, 2);
  const roles = rows(queryLocalD1(state,
    "SELECT item_key FROM dictionary_items WHERE dictionary_key='member_role' ORDER BY sort_order;",
  )).map((row) => row.item_key);
  assert.deepEqual(roles, ['admin', 'project_manager', 'implementation', 'finance', 'readonly']);
});
