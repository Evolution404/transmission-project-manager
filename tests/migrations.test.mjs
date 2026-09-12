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

test('P4 database upgrades to P5 without losing framework, budget, and financial history', () => {
  const state = tempState('tpm-migration-p5-upgrade-');
  executeLocalD1(state, { file: 'migrations/0001_p1_identity_and_config.sql' });
  executeLocalD1(state, { file: 'migrations/0002_p2_import_demands_materials.sql' });
  executeLocalD1(state, { file: 'migrations/0003_p3_reserve_projects.sql' });
  executeLocalD1(state, { file: 'migrations/0004_p4_finance.sql' });
  executeLocalD1(state, {
    command: `
      INSERT INTO members
        (id,username,display_name,role,enabled,version,credential_salt,credential_verifier,credential_algorithm,credential_params_json,
         must_change_password,session_version,failed_login_count,credential_changed_at,created_at,updated_at)
      VALUES ('p5-existing','p5-existing','P5升级保留成员','admin',1,1,'salt','verifier','argon2id-v1','{}',0,1,0,
        '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO import_batches
        (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
      VALUES ('p5-batch','保留.xlsx','${'8'.repeat(64)}','xlsx','{}','published',1,1,0,0,1,1,'p5-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO demands
        (id,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
      VALUES ('p5-demand','p5-source','p5-batch','${'8'.repeat(64)}','保留.xlsx','需求',2,'1',2026,'220kV','220kV','P5保留线','#1','防断线',NULL,'p5-signature','{}','{}',1,'p5-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
      VALUES ('p5-demand-material','p5-demand','JX-01',NULL,10000,'套','2026-09-01T00:00:00.000Z');
      INSERT INTO frameworks (id,code,name,total_amount_fen,annual_target_fen,start_date,end_date,version,created_by,created_at,updated_at)
      VALUES ('p5-framework','FW-P5','P5保留框架',1000000,800000,'2026-01-01','2026-12-31',1,'p5-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO framework_versions
        (id,framework_id,version,code,name,total_amount_fen,annual_target_fen,start_date,end_date,reason,created_by,created_at)
      VALUES ('p5-framework-v1','p5-framework',1,'FW-P5','P5保留框架',1000000,800000,'2026-01-01','2026-12-31',NULL,'p5-existing','2026-09-01T00:00:00.000Z');
      INSERT INTO agreements (id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_by,created_at,updated_at)
      VALUES ('p5-agreement','p5-framework','AG-P5','P5保留协议',900000,'2026-01-01','2026-12-31','active',1,'p5-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO agreement_versions
        (id,agreement_id,version,framework_id,code,name,amount_fen,valid_from,valid_to,status,reason,created_by,created_at)
      VALUES ('p5-agreement-v1','p5-agreement',1,'p5-framework','AG-P5','P5保留协议',900000,'2026-01-01','2026-12-31','active',NULL,'p5-existing','2026-09-01T00:00:00.000Z');
      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES ('p5-project','P5保留项目',2026,NULL,'confirmed',1,'p5-framework',4,'p5-existing','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z');
      INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
      VALUES ('p5-allocation','p5-project','p5-demand-material',10000,'2026-09-01T00:00:00.000Z');
      INSERT INTO project_budgets (id,project_id,total_amount_fen,note,status,budget_version,version,created_by,created_at,updated_at)
      VALUES ('p5-budget','p5-project',600000,NULL,'confirmed',1,2,'p5-existing','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z');
      INSERT INTO budget_allocations (id,budget_id,agreement_id,amount_fen,created_at)
      VALUES ('p5-budget-current-allocation','p5-budget','p5-agreement',600000,'2026-09-02T00:00:00.000Z');
      INSERT INTO budget_versions (id,budget_id,project_id,framework_id,budget_version,total_amount_fen,note,confirmed_by,confirmed_at)
      VALUES ('p5-budget-v1','p5-budget','p5-project','p5-framework',1,600000,NULL,'p5-existing','2026-09-02T00:00:00.000Z');
      INSERT INTO budget_version_allocations (id,budget_version_id,agreement_id,amount_fen,created_at)
      VALUES ('p5-budget-v1-allocation','p5-budget-v1','p5-agreement',600000,'2026-09-02T00:00:00.000Z');
      INSERT INTO financial_entries
        (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
      VALUES ('p5-entry','p5-framework','p5-project','budget_occurrence','2026-09-03',200000,NULL,NULL,'p5-existing','2026-09-03T00:00:00.000Z');
      INSERT INTO financial_entry_allocations (id,financial_entry_id,agreement_id,amount_fen,created_at)
      VALUES ('p5-entry-allocation','p5-entry','p5-agreement',200000,'2026-09-03T00:00:00.000Z');
    `,
  });

  executeLocalD1(state, { file: 'migrations/0005_p5_delivery_implementation_settlement.sql' });

  assert.deepEqual(rows(queryLocalD1(state,
    "SELECT name,framework_id,version FROM projects WHERE id='p5-project';",
  ))[0], { name: 'P5保留项目', framework_id: 'p5-framework', version: 4 });
  assert.equal(rows(queryLocalD1(state, "SELECT total_amount_fen,budget_version FROM project_budgets WHERE id='p5-budget';"))[0].total_amount_fen, 600000);
  assert.equal(rows(queryLocalD1(state, "SELECT amount_fen FROM financial_entries WHERE id='p5-entry';"))[0].amount_fen, 200000);
  assert.equal(rows(queryLocalD1(state,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('release_batches','release_lines','implementation_records','implementation_lines','settlements','settlement_coverage','settlement_agreement_allocations','attachments');",
  ))[0].count, 8);
});

test('P5 database upgrades to P6 without losing delivery, implementation, settlement, attachment, or finance history', () => {
  const state = tempState('tpm-migration-p6-upgrade-');
  for (const file of [
    'migrations/0001_p1_identity_and_config.sql',
    'migrations/0002_p2_import_demands_materials.sql',
    'migrations/0003_p3_reserve_projects.sql',
    'migrations/0004_p4_finance.sql',
    'migrations/0005_p5_delivery_implementation_settlement.sql',
  ]) executeLocalD1(state, { file });
  executeLocalD1(state, {
    command: `
      INSERT INTO members
        (id,username,display_name,role,enabled,version,credential_salt,credential_verifier,credential_algorithm,credential_params_json,
         must_change_password,session_version,failed_login_count,credential_changed_at,created_at,updated_at)
      VALUES ('p6-existing','p6-existing','P6升级保留成员','admin',1,1,'salt','verifier','argon2id-v1','{}',0,1,0,
        '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO import_batches
        (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
      VALUES ('p6-batch','保留.xlsx','${'9'.repeat(64)}','xlsx','{}','published',1,1,0,0,1,1,'p6-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO demands
        (id,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
      VALUES ('p6-demand','p6-source','p6-batch','${'9'.repeat(64)}','保留.xlsx','需求',2,'1',2026,'220kV','220kV','P6保留线','#1','防断线',NULL,'p6-signature','{}','{}',1,'p6-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
      VALUES ('p6-demand-material','p6-demand','JX-01',NULL,10000,'套','2026-09-01T00:00:00.000Z');
      INSERT INTO frameworks (id,code,name,total_amount_fen,annual_target_fen,start_date,end_date,version,created_by,created_at,updated_at)
      VALUES ('p6-framework','FW-P6','P6保留框架',1000000,800000,'2026-01-01','2026-12-31',1,'p6-existing','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO framework_versions
        (id,framework_id,version,code,name,total_amount_fen,annual_target_fen,start_date,end_date,reason,created_by,created_at)
      VALUES ('p6-framework-v1','p6-framework',1,'FW-P6','P6保留框架',1000000,800000,'2026-01-01','2026-12-31',NULL,'p6-existing','2026-09-01T00:00:00.000Z');
      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES ('p6-project','P6保留项目',2026,NULL,'confirmed',1,'p6-framework',5,'p6-existing','2026-09-01T00:00:00.000Z','2026-09-05T00:00:00.000Z');
      INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
      VALUES ('p6-allocation','p6-project','p6-demand-material',10000,'2026-09-01T00:00:00.000Z');
      INSERT INTO financial_entries (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
      VALUES ('p6-entry','p6-framework','p6-project','budget_occurrence','2026-09-02',120000,NULL,NULL,'p6-existing','2026-09-02T00:00:00.000Z');
      INSERT INTO release_batches (id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,created_by,created_at)
      VALUES ('p6-release','p6-project','2026-09-03',NULL,2,1,'p6-existing','2026-09-03T00:00:00.000Z');
      INSERT INTO release_lines (id,release_batch_id,project_id,demand_material_id,quantity_scaled,snapshot_json,created_at)
      VALUES ('p6-release-line','p6-release','p6-project','p6-demand-material',10000,'{}','2026-09-03T00:00:00.000Z');
      INSERT INTO implementation_records (id,project_id,historical,record_date,personnel,note,version,created_by,created_at,updated_at)
      VALUES ('p6-implementation','p6-project',0,'2026-09-04','班组',NULL,1,'p6-existing','2026-09-04T00:00:00.000Z','2026-09-04T00:00:00.000Z');
      INSERT INTO implementation_lines (id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled,created_at)
      VALUES ('p6-implementation-line','p6-implementation','p6-project','p6-release-line','p6-demand-material',NULL,'套',10000,10000,'2026-09-04T00:00:00.000Z');
      INSERT INTO settlements (id,project_id,settlement_date,amount_fen,final,note,version,voided_at,voided_by,void_reason,created_by,created_at,updated_at)
      VALUES ('p6-settlement','p6-project','2026-09-05',50000,1,NULL,1,NULL,NULL,NULL,'p6-existing','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z');
      INSERT INTO settlement_coverage (id,settlement_id,project_id,demand_material_id,quantity_scaled,created_at)
      VALUES ('p6-coverage','p6-settlement','p6-project','p6-demand-material',10000,'2026-09-05T00:00:00.000Z');
      INSERT INTO attachments (id,project_id,object_type,object_id,r2_key,file_name,content_type,size_bytes,uploaded_by,created_at,deleted_at)
      VALUES ('p6-attachment','p6-project','project','p6-project','attachments/p6-project/p6-attachment','凭据.pdf','application/pdf',1234,'p6-existing','2026-09-05T00:00:00.000Z',NULL);
    `,
  });

  executeLocalD1(state, { file: 'migrations/0006_p6_analysis_notifications_backups.sql' });

  assert.equal(rows(queryLocalD1(state, "SELECT amount_fen FROM financial_entries WHERE id='p6-entry';"))[0].amount_fen, 120000);
  assert.equal(rows(queryLocalD1(state, "SELECT quantity_scaled FROM release_lines WHERE id='p6-release-line';"))[0].quantity_scaled, 10000);
  assert.equal(rows(queryLocalD1(state, "SELECT completed_quantity_scaled FROM implementation_lines WHERE id='p6-implementation-line';"))[0].completed_quantity_scaled, 10000);
  assert.equal(rows(queryLocalD1(state, "SELECT final,amount_fen FROM settlements WHERE id='p6-settlement';"))[0].final, 1);
  assert.equal(rows(queryLocalD1(state, "SELECT r2_key FROM attachments WHERE id='p6-attachment';"))[0].r2_key, 'attachments/p6-project/p6-attachment');
  assert.equal(rows(queryLocalD1(state, "SELECT mode,threshold_basis_points FROM analysis_rules WHERE version=1;"))[0].mode, 'ratio');
  assert.equal(rows(queryLocalD1(state,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('analysis_rules','monthly_plans','report_snapshots','annual_milestones','notification_contacts','alert_events','notification_outbox','backup_runs','backup_chunks');",
  ))[0].count, 9);
});

test('clean database applies the current P6 development schema and remains repeatable', () => {
  const state = tempState('tpm-migration-clean-');
  applyLocalMigrations(state);
  applyLocalMigrations(state);

  const migrations = rows(queryLocalD1(state, 'SELECT name FROM d1_migrations ORDER BY id;')).map((row) => row.name);
  assert.deepEqual(migrations, [
    '0001_p1_identity_and_config.sql',
    '0002_p2_import_demands_materials.sql',
    '0003_p3_reserve_projects.sql',
    '0004_p4_finance.sql',
    '0005_p5_delivery_implementation_settlement.sql',
    '0006_p6_analysis_notifications_backups.sql',
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
    'release_batches', 'release_lines', 'implementation_records', 'implementation_lines',
    'settlements', 'settlement_coverage', 'settlement_agreement_allocations', 'attachments',
    'analysis_rules', 'monthly_plans', 'report_snapshots', 'annual_milestones', 'notification_contacts',
    'alert_events', 'notification_outbox', 'backup_runs', 'backup_chunks',
  ]) assert.ok(tables.includes(table), `missing table ${table}`);
});

test('member schema remains username/credential based after P6 migration', () => {
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
