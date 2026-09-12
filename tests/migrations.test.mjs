import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  applyLocalMigrations,
  cleanupStateDir,
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

test('clean database applies the current development schema and remains repeatable', () => {
  const state = tempState('tpm-migration-clean-');
  applyLocalMigrations(state);
  applyLocalMigrations(state);

  const migrations = rows(queryLocalD1(state, 'SELECT name FROM d1_migrations ORDER BY id;')).map((row) => row.name);
  assert.deepEqual(migrations, ['0001_p1_identity_and_config.sql']);

  const tables = rows(queryLocalD1(state,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  )).map((row) => row.name);
  for (const table of [
    'members', 'member_scopes', 'auth_sessions', 'settings_versions',
    'dictionary_items', 'audit_events', 'idempotency_records',
  ]) assert.ok(tables.includes(table), `missing table ${table}`);
});

test('member schema is username/credential based and contains no email identity column', () => {
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
