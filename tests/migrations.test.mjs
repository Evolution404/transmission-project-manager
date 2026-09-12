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

test('P2 database upgrades to P3 without losing imported demand and material provenance', () => {
  const state = tempState('tpm-migration-p3-upgrade-');
  executeLocalD1(state, { file: 'migrations/0001_p1_identity_and_config.sql' });
  executeLocalD1(state, { file: 'migrations/0002_p2_import_demands_materials.sql' });
  executeLocalD1(state, {
    command: `
      INSERT INTO members
        (id,username,display_name,role,enabled,version,credential_salt,credential_verifier,
         credential_algorithm,credential_params_json,must_change_password,session_version,
         failed_login_count,credential_changed_at,created_at,updated_at)
      VALUES
        ('p3-existing','p3-existing','P3升级保留成员','admin',1,1,'salt','verifier','argon2id-v1',
         '{"algorithm":"argon2id-v1"}',0,1,0,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO materials (id,code,name,model,unit,enabled,version,created_by,created_at,updated_at)
      VALUES ('p3-material','P3-M','保留物资','JX-01','套',1,1,'p3-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO import_batches
        (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
      VALUES ('p3-batch','保留.xlsx','${'5'.repeat(64)}','xlsx','{}','published',1,1,0,0,1,1,'p3-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO demands
        (id,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
      VALUES ('p3-demand','p3-source','p3-batch','${'5'.repeat(64)}','保留.xlsx','需求',2,'1',2026,'220kV','220kV','保留线','#1','防断线',NULL,'p3-signature','{}','{}',1,'p3-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
      VALUES ('p3-demand-material','p3-demand','JX-01','p3-material',10000,'套','2026-09-01T00:00:00.000Z');
    `,
  });

  executeLocalD1(state, { file: 'migrations/0003_p3_reserve_projects.sql' });

  assert.deepEqual(rows(queryLocalD1(state,
    "SELECT source_file_name,source_sheet,source_row_number,line_name FROM demands WHERE id='p3-demand';",
  ))[0], {
    source_file_name: '保留.xlsx', source_sheet: '需求', source_row_number: 2, line_name: '保留线',
  });
  assert.deepEqual(rows(queryLocalD1(state,
    "SELECT raw_model,material_id,quantity_scaled,unit FROM demand_materials WHERE id='p3-demand-material';",
  ))[0], { raw_model: 'JX-01', material_id: 'p3-material', quantity_scaled: 10000, unit: '套' });
  assert.equal(rows(queryLocalD1(state,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('projects','project_versions','demand_allocations','project_cost_lines','reserve_categories','category_mappings','category_cost_allocations');",
  ))[0].count, 7);
});

test('P3 database upgrades to P4 without losing reserve project versions and allocations', () => {
  const state = tempState('tpm-migration-p4-upgrade-');
  executeLocalD1(state, { file: 'migrations/0001_p1_identity_and_config.sql' });
  executeLocalD1(state, { file: 'migrations/0002_p2_import_demands_materials.sql' });
  executeLocalD1(state, { file: 'migrations/0003_p3_reserve_projects.sql' });
  executeLocalD1(state, {
    command: `
      INSERT INTO members
        (id,username,display_name,role,enabled,version,credential_salt,credential_verifier,credential_algorithm,credential_params_json,
         must_change_password,session_version,failed_login_count,credential_changed_at,created_at,updated_at)
      VALUES ('p4-existing','p4-existing','P4升级保留成员','admin',1,1,'salt','verifier','argon2id-v1','{}',0,1,0,
        '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO import_batches
        (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
      VALUES ('p4-batch','保留.xlsx','${'7'.repeat(64)}','xlsx','{}','published',1,1,0,0,1,1,'p4-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO demands
        (id,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
      VALUES ('p4-demand','p4-source','p4-batch','${'7'.repeat(64)}','保留.xlsx','需求',2,'1',2026,'220kV','220kV','保留线','#1','防断线',NULL,'p4-signature','{}','{}',1,'p4-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
      VALUES ('p4-demand-material','p4-demand','JX-01',NULL,10000,'套','2026-09-01T00:00:00.000Z');
      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES ('p4-project','保留储备项目',2026,NULL,'confirmed',1,NULL,3,'p4-existing','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z');
      INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
      VALUES ('p4-allocation','p4-project','p4-demand-material',10000,'2026-09-01T00:00:00.000Z');
      INSERT INTO project_versions
        (id,project_id,reserve_version,snapshot_json,known_amount_fen,missing_price_count,completeness_basis_points,reason,confirmed_by,confirmed_at)
      VALUES ('p4-project-version','p4-project',1,'{"name":"保留储备项目"}',12345,0,10000,'初始确认','p4-existing','2026-09-02T00:00:00.000Z');
    `,
  });

  executeLocalD1(state, { file: 'migrations/0004_p4_finance.sql' });

  assert.deepEqual(rows(queryLocalD1(state,
    "SELECT name,status,reserve_version,version FROM projects WHERE id='p4-project';",
  ))[0], { name: '保留储备项目', status: 'confirmed', reserve_version: 1, version: 3 });
  assert.equal(rows(queryLocalD1(state, "SELECT quantity_scaled FROM demand_allocations WHERE id='p4-allocation';"))[0].quantity_scaled, 10000);
  assert.equal(rows(queryLocalD1(state, "SELECT known_amount_fen FROM project_versions WHERE id='p4-project-version';"))[0].known_amount_fen, 12345);
  assert.equal(rows(queryLocalD1(state,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('frameworks','framework_versions','agreements','agreement_versions','project_budgets','budget_allocations','budget_versions','budget_version_allocations','financial_entries','financial_entry_allocations');",
  ))[0].count, 10);
});

test('clean database applies the current P4 development schema and remains repeatable', () => {
  const state = tempState('tpm-migration-clean-');
  applyLocalMigrations(state);
  applyLocalMigrations(state);

  const migrations = rows(queryLocalD1(state, 'SELECT name FROM d1_migrations ORDER BY id;')).map((row) => row.name);
  assert.deepEqual(migrations, [
    '0001_p1_identity_and_config.sql',
    '0002_p2_import_demands_materials.sql',
    '0003_p3_reserve_projects.sql',
    '0004_p4_finance.sql',
  ]);

  const tables = rows(queryLocalD1(state,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  )).map((row) => row.name);
  for (const table of [
    'members', 'member_scopes', 'auth_sessions', 'settings_versions', 'dictionary_items',
    'audit_events', 'idempotency_records', 'materials', 'import_mapping_templates',
    'import_batches', 'import_rows', 'demands', 'demand_materials', 'field_definitions',
    'projects', 'project_versions', 'demand_allocations', 'project_cost_lines',
    'reserve_categories', 'category_mappings', 'category_cost_allocations',
    'frameworks', 'framework_versions', 'agreements', 'agreement_versions', 'project_budgets',
    'budget_allocations', 'budget_versions', 'budget_version_allocations', 'financial_entries', 'financial_entry_allocations',
  ]) assert.ok(tables.includes(table), `missing table ${table}`);
});

test('member schema remains username/credential based after P4 migration', () => {
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
