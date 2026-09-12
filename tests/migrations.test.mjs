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

test('P1 database upgrades to P1.1 without losing member, scope, settings or audit data', () => {
  const state = tempState('tpm-migration-upgrade-');
  executeLocalD1(state, { file: 'migrations/0001_p1_identity_and_config.sql' });
  executeLocalD1(state, {
    command: `
      INSERT INTO members (id,email,display_name,role,enabled,version,created_at,updated_at)
      VALUES ('legacy-member','legacy@example.test','旧成员','project_manager',1,7,'2026-01-02T03:04:05.000Z','2026-02-03T04:05:06.000Z');
      INSERT INTO member_scopes (id,member_id,scope_type,scope_id,created_at)
      VALUES ('legacy-scope','legacy-member','project','project-42','2026-01-02T03:04:05.000Z');
      INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
      VALUES ('legacy-audit','legacy-member','legacy.test','member','legacy-member',NULL,'{}','2026-02-03T04:05:06.000Z');
    `,
  });

  executeLocalD1(state, { file: 'migrations/0002_p1_1_member_lifecycle.sql' });

  const member = rows(queryLocalD1(state, `
    SELECT id,email,display_name,role,enabled,version,created_at,updated_at,invited_at,first_login_at,last_login_at
    FROM members WHERE id='legacy-member';
  `))[0];
  assert.deepEqual(member, {
    id: 'legacy-member',
    email: 'legacy@example.test',
    display_name: '旧成员',
    role: 'project_manager',
    enabled: 1,
    version: 7,
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-02-03T04:05:06.000Z',
    invited_at: '2026-01-02T03:04:05.000Z',
    first_login_at: null,
    last_login_at: null,
  });

  assert.equal(rows(queryLocalD1(state, "SELECT COUNT(*) AS count FROM member_scopes WHERE member_id='legacy-member';"))[0].count, 1);
  assert.equal(rows(queryLocalD1(state, "SELECT COUNT(*) AS count FROM audit_events WHERE id='legacy-audit';"))[0].count, 1);
  assert.equal(rows(queryLocalD1(state, "SELECT COUNT(*) AS count FROM settings_versions;"))[0].count, 2);
});

test('full migration chain and local seed are repeatable on a clean database', () => {
  const state = tempState('tpm-migration-repeat-');
  applyLocalMigrations(state);
  executeLocalD1(state, { file: 'seeds/local.sql' });
  executeLocalD1(state, { file: 'seeds/local.sql' });
  applyLocalMigrations(state);

  const members = rows(queryLocalD1(state, 'SELECT email, COUNT(*) AS count FROM members GROUP BY email ORDER BY email;'));
  assert.equal(members.length, 3);
  assert.ok(members.every((row) => row.count === 1));

  const migrations = rows(queryLocalD1(state, 'SELECT name FROM d1_migrations ORDER BY id;')).map((row) => row.name);
  assert.deepEqual(migrations, [
    '0001_p1_identity_and_config.sql',
    '0002_p1_1_member_lifecycle.sql',
  ]);
});
