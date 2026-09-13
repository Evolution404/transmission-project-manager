import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { applyLocalMigrations, cleanupStateDir, executeLocalD1, makeStateDir, queryLocalD1, runWrangler, startWranglerServer } from './helpers/wrangler.mjs';
import { bootstrapAdmin, cookiePair } from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-p6-analysis-');
let runtime;
let adminCookie;
let adminId;
let deliveryServer;
let deliveryUrl;
const deliveredMessages = [];

function idem(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function jsonRequest(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (adminCookie) headers.set('Cookie', adminCookie);
  const response = await runtime.request(path, { ...init, headers });
  let body = null;
  try { body = await response.json(); } catch { /* non-json */ }
  return { response, body };
}

function mutation(method, key, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  };
}

function rows(command) {
  return queryLocalD1(stateDir, command).flatMap((entry) => entry.results ?? []);
}

const restoreTableOrder = [
  'members', 'member_scopes', 'settings_versions', 'dictionary_items', 'audit_events', 'idempotency_records',
  'materials', 'import_mapping_templates', 'import_batches', 'import_rows', 'demands', 'demand_source_rows', 'demand_materials', 'field_definitions',
  'projects', 'project_versions', 'demand_allocations', 'project_cost_lines', 'reserve_categories', 'category_mappings', 'category_cost_allocations',
  'project_demand_links', 'project_material_requirements', 'project_material_revisions',
  'frameworks', 'framework_versions', 'agreements', 'agreement_versions', 'project_budgets', 'budget_allocations', 'budget_versions',
  'budget_version_allocations', 'financial_entries', 'financial_entry_allocations',
  'project_releases', 'project_tasks', 'task_demand_scopes', 'task_material_requirements', 'material_supply_events',
  'task_implementation_records', 'task_implementation_scope_lines', 'task_material_usage_lines',
  'task_settlements', 'task_settlement_scope_lines', 'task_settlement_agreement_allocations', 'task_settlement_reminders',
  'release_batches', 'release_lines', 'implementation_records', 'implementation_lines', 'settlements', 'settlement_coverage',
  'settlement_agreement_allocations', 'attachments',
  'analysis_rules', 'monthly_plans', 'report_snapshots', 'annual_milestones', 'notification_contacts', 'alert_events', 'notification_outbox',
];
function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), 'backup numeric value must be finite');
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  return `'${String(value).replaceAll("'", "''")}'`;
}
function insertSql(table, inputRows) {
  if (!inputRows.length) return '';
  assert.ok(/^[a-z0-9_]+$/i.test(table));
  const columns = Object.keys(inputRows[0]);
  for (const row of inputRows) assert.deepEqual(Object.keys(row), columns);
  const values = inputRows.map((row) => `(${columns.map((column) => sqlLiteral(row[column])).join(',')})`).join(',');
  return `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES ${values};`;
}
function getLocalR2Json(sourceStateDir, key, artifactsDir) {
  const output = join(artifactsDir, `${crypto.randomUUID()}.json`);
  runWrangler(['r2', 'object', 'get', `transmission-project-manager-local/${key}`, '--local', '--persist-to', sourceStateDir, '--file', output]);
  return JSON.parse(readFileSync(output, 'utf8'));
}

function seedFinanceFacts() {
  const now = '2026-01-01T00:00:00.000Z';
  executeLocalD1(stateDir, {
    command: `
      INSERT INTO frameworks (id,code,name,total_amount_fen,annual_target_fen,start_date,end_date,version,created_by,created_at,updated_at)
      VALUES
        ('p6-fw','FW-P6','P6分析框架',1200000,1200000,'2026-01-01','2026-12-31',1,'${adminId}','${now}','${now}'),
        ('p6-zero','FW-ZERO','零目标框架',0,0,'2026-01-01','2026-12-31',1,'${adminId}','${now}','${now}');
      INSERT INTO framework_versions (id,framework_id,version,code,name,total_amount_fen,annual_target_fen,start_date,end_date,reason,created_by,created_at)
      VALUES
        ('p6-fwv','p6-fw',1,'FW-P6','P6分析框架',1200000,1200000,'2026-01-01','2026-12-31',NULL,'${adminId}','${now}'),
        ('p6-zerov','p6-zero',1,'FW-ZERO','零目标框架',0,0,'2026-01-01','2026-12-31',NULL,'${adminId}','${now}');
      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES
        ('p6-p1','P6子项目1',2026,NULL,'confirmed',1,'p6-fw',1,'${adminId}','${now}','${now}'),
        ('p6-p2','P6子项目2',2026,NULL,'confirmed',1,'p6-fw',1,'${adminId}','${now}','${now}');
      INSERT INTO financial_entries (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
      VALUES ('p6-entry-base','p6-fw','p6-p1','budget_occurrence','2026-01-15',319999,NULL,NULL,'${adminId}','2026-01-15T00:00:00.000Z');

      INSERT INTO materials (id,code,name,model,unit,enabled,version,created_by,created_at,updated_at)
      VALUES ('p6-material','P6-M','P6储备物资','JX-P6','套',1,1,'${adminId}','${now}','${now}');
      INSERT INTO import_batches
        (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
      VALUES ('p6-batch','P6储备.xlsx','${'8'.repeat(64)}','xlsx','{}','published',1,1,0,0,1,1,'${adminId}','${now}','${now}','${now}');
      INSERT INTO demands
        (id,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
      VALUES ('p6-reserve-demand','p6-reserve-source','p6-batch','${'8'.repeat(64)}','P6储备.xlsx','需求',2,'1',2026,'220kV','220kV','P6储备线','#1','防断线',NULL,'p6-reserve-signature','{}','{}',1,'${adminId}','${now}','${now}');
      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
      VALUES ('p6-reserve-dm','p6-reserve-demand','JX-P6','p6-material',1000000,'套','${now}');
      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES ('p6-reserve','P6剩余储备项目',2026,NULL,'confirmed',1,NULL,2,'${adminId}','${now}','${now}');
      INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
      VALUES ('p6-reserve-da','p6-reserve','p6-reserve-dm',1000000,'${now}');
      INSERT INTO project_cost_lines (id,project_id,kind,demand_allocation_id,label,unit_price_scaled,amount_fen,price_source,price_date,tax_inclusive,created_at,updated_at)
      VALUES ('p6-reserve-cost','p6-reserve','material','p6-reserve-da','P6物资',1000000,100000,'测试','2026-01-01',1,'${now}','${now}');
      INSERT INTO reserve_categories (id,category_key,label,enabled,version,created_by,created_at,updated_at)
      VALUES ('p6-category','p6-cat','P6防断线',1,1,'${adminId}','${now}','${now}');
      INSERT INTO category_cost_allocations (id,project_id,cost_line_id,reserve_category_id,amount_fen,created_at)
      VALUES ('p6-category-alloc','p6-reserve','p6-reserve-cost','p6-category',100000,'${now}');
      INSERT INTO release_batches (id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,created_by,created_at)
      VALUES ('p6-release','p6-reserve','2026-02-01',NULL,1,1,'${adminId}','${now}');
      INSERT INTO release_lines (id,release_batch_id,project_id,demand_material_id,quantity_scaled,snapshot_json,created_at)
      VALUES ('p6-release-line','p6-release','p6-reserve','p6-reserve-dm',400000,'{}','${now}');

      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES
        ('p6-final-reserve','最终口径未出库储备',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p6-final-released','最终口径已出库项目',2026,NULL,'confirmed',1,NULL,2,'${adminId}','${now}','${now}');
      INSERT INTO project_material_requirements
        (id,project_id,material_id,model,unit,required_quantity_scaled,unit_price_scaled,amount_fen,reserve_category_id,active,version,created_by,created_at,updated_at)
      VALUES
        ('p6-pmr-cat','p6-final-reserve','p6-material','JX-P6','套',1000000,1000000,100000,'p6-category',1,1,'${adminId}','${now}','${now}'),
        ('p6-pmr-unclassified','p6-final-reserve',NULL,'OTHER-P6','项',500000,1000000,50000,NULL,1,1,'${adminId}','${now}','${now}'),
        ('p6-pmr-missing','p6-final-reserve',NULL,'UNKNOWN-P6','项',100000,NULL,NULL,'p6-category',1,1,'${adminId}','${now}','${now}'),
        ('p6-pmr-released','p6-final-released','p6-material','JX-P6','套',900000,1000000,999999,'p6-category',1,1,'${adminId}','${now}','${now}');
      INSERT INTO project_releases
        (id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,snapshot_json,created_by,created_at)
      VALUES ('p6-final-project-release','p6-final-released','2026-02-01',NULL,1,1,'{}','${adminId}','${now}');
    `,
  });
}

async function putPlan(projectId, month, targetAmountFen, expectedVersion = null) {
  return jsonRequest(`/api/analysis/plans/${projectId}/2026/${month}`, mutation('PUT', idem('plan'), { expectedVersion, targetAmountFen }));
}

async function putRule(body) {
  return jsonRequest('/api/analysis/rules', mutation('PUT', idem('rule'), body));
}

before(async () => {
  deliveryServer = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      deliveredMessages.push({
        authorization: request.headers.authorization ?? null,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise((resolve, reject) => {
    deliveryServer.once('error', reject);
    deliveryServer.listen(0, '127.0.0.1', resolve);
  });
  const address = deliveryServer.address();
  deliveryUrl = `http://127.0.0.1:${address.port}/deliver`;

  runtime = await startWranglerServer({
    stateDir,
    port: 8807,
    migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:p6-pepper', 'BOOTSTRAP_TOKEN:p6-bootstrap', `NOTIFICATION_DELIVERY_URL:${deliveryUrl}`, 'NOTIFICATION_DELIVERY_TOKEN:p6-delivery-token'],
  });
  const bootstrap = await bootstrapAdmin(runtime, { token: 'p6-bootstrap' });
  assert.equal(bootstrap.response.status, 201);
  adminId = bootstrap.body.data.id;
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));
  seedFinanceFacts();
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  if (deliveryServer) await new Promise((resolve) => deliveryServer.close(resolve));
  cleanupStateDir(stateDir);
});

test('plan attainment lag uses the real 80% boundary and custom monthly plans', async () => {
  for (const projectId of ['p6-p1', 'p6-p2']) {
    assert.equal((await putPlan(projectId, 1, 100000)).response.status, 200);
    assert.equal((await putPlan(projectId, 2, 100000)).response.status, 200);
  }
  const plans = await jsonRequest('/api/analysis/plans?frameworkId=p6-fw&year=2026');
  assert.equal(plans.response.status, 200);
  assert.equal(plans.body.data.items.length, 4);
  assert.deepEqual(plans.body.data.items.map((item) => [item.projectId, item.month, item.version]), [
    ['p6-p1', 1, 1], ['p6-p1', 2, 1], ['p6-p2', 1, 1], ['p6-p2', 2, 1],
  ]);

  let progress = await jsonRequest('/api/analysis/frameworks/p6-fw/progress?asOf=2026-02-28');
  assert.equal(progress.response.status, 200);
  assert.equal(progress.body.data.plannedToDateFen, 400000);
  assert.equal(progress.body.data.actualToDateFen, 319999);
  assert.equal(progress.body.data.lagging, true);
  assert.equal(progress.body.data.rule.mode, 'ratio');
  assert.equal(progress.body.data.rule.thresholdBasisPoints, 8000);

  executeLocalD1(stateDir, {
    command: `INSERT INTO financial_entries (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
      VALUES ('p6-entry-boundary','p6-fw','p6-p2','budget_occurrence','2026-02-20',1,NULL,NULL,'${adminId}','2026-02-20T00:00:00.000Z');`,
  });
  progress = await jsonRequest('/api/analysis/frameworks/p6-fw/progress?asOf=2026-02-28');
  assert.equal(progress.body.data.actualToDateFen, 320000);
  assert.equal(progress.body.data.attainmentBasisPoints, 8000);
  assert.equal(progress.body.data.lagging, false);
});

test('gap rule has an exact percentage-point boundary and zero annual targets are unconfigured', async () => {
  const currentRule = await jsonRequest('/api/analysis/rules');
  assert.equal(currentRule.response.status, 200);
  const changed = await putRule({ expectedVersion: currentRule.body.data.version, mode: 'gap', thresholdBasisPoints: 1000 });
  assert.equal(changed.response.status, 200);

  executeLocalD1(stateDir, { command: "UPDATE financial_entries SET amount_fen=200000 WHERE id='p6-entry-base'; DELETE FROM financial_entries WHERE id='p6-entry-boundary';" });
  let progress = await jsonRequest('/api/analysis/frameworks/p6-fw/progress?asOf=2026-02-28');
  assert.equal(progress.body.data.plannedProgressBasisPoints, 3333);
  assert.equal(progress.body.data.actualProgressBasisPoints, 1667);
  assert.equal(progress.body.data.lagging, true);

  const zero = await jsonRequest('/api/analysis/frameworks/p6-zero/progress?asOf=2026-02-28');
  assert.equal(zero.response.status, 200);
  assert.equal(zero.body.data.annualTargetConfigured, false);
  assert.equal(zero.body.data.actualProgressBasisPoints, null);
  assert.equal(zero.body.data.lagging, false);
});

test('quarter states respect year boundaries instead of leaving past quarters as upcoming', async () => {
  let progress = await jsonRequest('/api/analysis/frameworks/p6-fw/progress?asOf=2026-04-01');
  assert.deepEqual(progress.body.data.quarters.map((item) => item.status), ['ended', 'in_progress', 'upcoming', 'upcoming']);
  progress = await jsonRequest('/api/analysis/frameworks/p6-fw/progress?asOf=2027-01-01');
  assert.deepEqual(progress.body.data.quarters.map((item) => item.status), ['ended', 'ended', 'ended', 'ended']);
});

test('monthly report revisions preserve the original rule version and snapshot', async () => {
  const first = await jsonRequest('/api/reports/monthly', mutation('POST', idem('report-1'), {
    frameworkId: 'p6-fw', businessMonth: '2026-02', dataCutoffDate: '2026-02-28',
  }));
  assert.equal(first.response.status, 201);
  assert.equal(first.body.data.revision, 1);
  const firstRuleVersion = first.body.data.ruleVersion;
  const firstSnapshot = structuredClone(first.body.data.snapshot);

  const rule = await jsonRequest('/api/analysis/rules');
  assert.equal((await putRule({ expectedVersion: rule.body.data.version, mode: 'ratio', thresholdBasisPoints: 8500 })).response.status, 200);
  executeLocalD1(stateDir, {
    command: `INSERT INTO financial_entries (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
      VALUES ('p6-entry-revision','p6-fw','p6-p1','budget_occurrence','2026-02-25',50000,NULL,NULL,'${adminId}','2026-02-25T00:00:00.000Z');`,
  });
  const second = await jsonRequest('/api/reports/monthly', mutation('POST', idem('report-2'), {
    frameworkId: 'p6-fw', businessMonth: '2026-02', dataCutoffDate: '2026-02-28',
  }));
  assert.equal(second.response.status, 201);
  assert.equal(second.body.data.revision, 2);
  assert.notEqual(second.body.data.ruleVersion, firstRuleVersion);

  const history = await jsonRequest('/api/reports/monthly?frameworkId=p6-fw&businessMonth=2026-02');
  assert.equal(history.response.status, 200);
  assert.deepEqual(history.body.data.items.map((item) => item.revision), [2, 1]);
  assert.deepEqual(history.body.data.items[1].snapshot, firstSnapshot);
  assert.equal(history.body.data.items[1].ruleVersion, firstRuleVersion);
});

test('current reserve analysis uses current project materials and excludes project-level released projects and non-material costs', async () => {
  const remaining = await jsonRequest('/api/analysis/reserve-remaining');
  assert.equal(remaining.response.status, 200);
  assert.equal(remaining.body.data.currentMaterialQuantityScaled, 1600000);
  assert.equal(remaining.body.data.knownCurrentMaterialAmountFen, 150000);
  assert.equal(remaining.body.data.missingPriceCount, 1);
  assert.equal(remaining.body.data.unclassifiedCurrentMaterialFen, 50000);
  assert.equal(remaining.body.data.unscopedCommonCostFen, 0, '施工/其他费用不得进入储备类别金额分析');
  const category = remaining.body.data.categories.find((item) => item.reserveCategoryId === 'p6-category');
  assert.equal(category.knownCurrentAmountFen, 100000);
  assert.equal(remaining.body.data.releasedProjectCount, 1);
});

test('milestones preserve month/day/unknown precision without inventing dates', async () => {
  const monthOnly = await jsonRequest('/api/milestones', mutation('POST', idem('milestone-month'), {
    businessYear: 2026, title: '九月专项', owner: '张三', projectId: null,
    datePrecision: 'month', month: 9, specificDate: null, leadDays: [7, 3, 0],
  }));
  const exactDay = await jsonRequest('/api/milestones', mutation('POST', idem('milestone-day'), {
    businessYear: 2026, title: '节点验收', owner: '李四', projectId: null,
    datePrecision: 'day', month: 9, specificDate: '2026-09-10', leadDays: [7, 3, 0],
  }));
  const unknown = await jsonRequest('/api/milestones', mutation('POST', idem('milestone-unknown'), {
    businessYear: 2026, title: '待定事项', owner: null, projectId: null,
    datePrecision: 'unknown', month: null, specificDate: null, leadDays: [7, 3, 0],
  }));
  assert.equal(monthOnly.response.status, 201);
  assert.equal(exactDay.response.status, 201);
  assert.equal(unknown.response.status, 201);

  const due = await jsonRequest('/api/milestones/due?asOf=2026-09-03');
  assert.equal(due.response.status, 200);
  const monthItem = due.body.data.items.find((item) => item.id === monthOnly.body.data.id);
  const dayItem = due.body.data.items.find((item) => item.id === exactDay.body.data.id);
  const unknownItem = due.body.data.items.find((item) => item.id === unknown.body.data.id);
  assert.equal(monthItem.dueDate, null);
  assert.equal(monthItem.dueMonth, '2026-09');
  assert.equal(monthItem.reminderDue, true);
  assert.equal(dayItem.dueDate, '2026-09-10');
  assert.equal(dayItem.reminderDue, true);
  assert.equal(dayItem.reminderLeadDays, 7);
  assert.equal(unknownItem.needsDate, true);
  assert.equal(unknownItem.reminderDue, false);

  const completed = await jsonRequest(`/api/milestones/${exactDay.body.data.id}/status`, mutation('PUT', idem('milestone-complete'), {
    expectedVersion: exactDay.body.data.version, status: 'completed',
  }));
  assert.equal(completed.response.status, 200);
  const afterComplete = await jsonRequest('/api/milestones/due?asOf=2026-09-10');
  const completedItem = afterComplete.body.data.items.find((item) => item.id === exactDay.body.data.id);
  assert.equal(completedItem.status, 'completed');
  assert.equal(completedItem.reminderDue, false);
});

test('alert evaluation is idempotent and outbox lease/backoff/unknown states are recoverable', async () => {
  const contact = await jsonRequest('/api/notification-contacts', mutation('POST', idem('contact'), {
    memberId: adminId, address: 'ops@example.com', verified: true, enabled: true,
  }));
  assert.equal(contact.response.status, 201);

  const rule = await jsonRequest('/api/analysis/rules');
  if (rule.body.data.mode !== 'ratio' || rule.body.data.thresholdBasisPoints !== 8500) {
    assert.equal((await putRule({ expectedVersion: rule.body.data.version, mode: 'ratio', thresholdBasisPoints: 8500 })).response.status, 200);
  }
  const first = await jsonRequest('/api/alerts/evaluate', mutation('POST', idem('evaluate-1'), { asOf: '2026-02-28' }));
  const second = await jsonRequest('/api/alerts/evaluate', mutation('POST', idem('evaluate-2'), { asOf: '2026-02-28' }));
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(first.body.data.createdEvents, 1);
  assert.equal(second.body.data.createdEvents, 0);
  assert.equal(rows("SELECT COUNT(*) AS count FROM alert_events WHERE object_id='p6-fw' AND state='active';")[0].count, 1);
  assert.equal(rows("SELECT COUNT(*) AS count FROM notification_outbox WHERE recipient='ops@example.com';")[0].count, 1);

  const claimTime = '2026-03-01T00:00:00.000Z';
  const claim = await jsonRequest('/api/notification-outbox/claim', mutation('POST', idem('claim'), { now: claimTime, limit: 10, leaseSeconds: 60 }));
  assert.equal(claim.response.status, 200);
  assert.equal(claim.body.data.items.length, 1);
  const leased = claim.body.data.items[0];
  const early = await jsonRequest('/api/notification-outbox/claim', mutation('POST', idem('claim-early'), { now: '2026-03-01T00:00:30.000Z', limit: 10, leaseSeconds: 60 }));
  assert.equal(early.body.data.items.length, 0);
  const reclaimed = await jsonRequest('/api/notification-outbox/claim', mutation('POST', idem('claim-reclaim'), { now: '2026-03-01T00:01:01.000Z', limit: 10, leaseSeconds: 60 }));
  assert.equal(reclaimed.body.data.items.length, 1);
  assert.equal(reclaimed.body.data.items[0].id, leased.id);

  const failed = await jsonRequest(`/api/notification-outbox/${leased.id}/result`, mutation('POST', idem('result-fail'), {
    leaseToken: reclaimed.body.data.items[0].leaseToken, outcome: 'failed', now: '2026-03-01T00:01:10.000Z', error: 'provider timeout',
  }));
  assert.equal(failed.response.status, 200);
  assert.equal(failed.body.data.status, 'failed');
  assert.ok(failed.body.data.nextAttemptAt > '2026-03-01T00:01:10.000Z');

  const beforeRetry = await jsonRequest('/api/notification-outbox/claim', mutation('POST', idem('claim-before-retry'), { now: '2026-03-01T00:02:00.000Z', limit: 10, leaseSeconds: 60 }));
  assert.equal(beforeRetry.body.data.items.length, 0);
  const retry = await jsonRequest('/api/notification-outbox/claim', mutation('POST', idem('claim-retry'), { now: failed.body.data.nextAttemptAt, limit: 10, leaseSeconds: 60 }));
  assert.equal(retry.body.data.items.length, 1);
  const unknownResult = await jsonRequest(`/api/notification-outbox/${leased.id}/result`, mutation('POST', idem('result-unknown'), {
    leaseToken: retry.body.data.items[0].leaseToken, outcome: 'unknown', now: retry.body.data.items[0].leasedAt, error: 'provider result unknown',
  }));
  assert.equal(unknownResult.body.data.status, 'unknown');
  const noInfiniteRetry = await jsonRequest('/api/notification-outbox/claim', mutation('POST', idem('claim-after-unknown'), { now: '2026-03-10T00:00:00.000Z', limit: 10, leaseSeconds: 60 }));
  assert.equal(noInfiniteRetry.body.data.items.length, 0);
});

test('alert lifecycle supports daily summary, recovery, and a new crossing in the same period', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  executeLocalD1(stateDir, {
    command: `
      INSERT INTO frameworks (id,code,name,total_amount_fen,annual_target_fen,start_date,end_date,version,created_by,created_at,updated_at)
      VALUES ('p6-cycle-fw','FW-CYCLE','循环预警框架',100000,100000,'2026-01-01','2026-12-31',1,'${adminId}','${now}','${now}');
      INSERT INTO framework_versions (id,framework_id,version,code,name,total_amount_fen,annual_target_fen,start_date,end_date,reason,created_by,created_at)
      VALUES ('p6-cycle-fwv','p6-cycle-fw',1,'FW-CYCLE','循环预警框架',100000,100000,'2026-01-01','2026-12-31',NULL,'${adminId}','${now}');
      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES ('p6-cycle-project','循环预警项目',2026,NULL,'confirmed',1,'p6-cycle-fw',1,'${adminId}','${now}','${now}');
      INSERT INTO monthly_plans (id,project_id,business_year,month,target_amount_fen,version,created_by,created_at,updated_at)
      VALUES ('p6-cycle-plan','p6-cycle-project',2026,1,100000,1,'${adminId}','${now}','${now}');
      INSERT INTO financial_entries (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
      VALUES ('p6-cycle-entry','p6-cycle-fw','p6-cycle-project','budget_occurrence','2026-01-10',50000,NULL,NULL,'${adminId}','2026-01-10T00:00:00.000Z');
    `,
  });
  const contact = await jsonRequest('/api/notification-contacts', mutation('POST', idem('cycle-contact'), {
    memberId: adminId, address: 'cycle@example.com', verified: true, enabled: true,
  }));
  assert.equal(contact.response.status, 201);

  const first = await jsonRequest('/api/alerts/evaluate', mutation('POST', idem('cycle-eval-1'), { asOf: '2026-01-15' }));
  assert.equal(first.response.status, 200);
  assert.equal(rows("SELECT COUNT(*) AS count FROM alert_events WHERE object_id='p6-cycle-fw' AND rule_key='analysis.lag';")[0].count, 1);

  const sustained = await jsonRequest('/api/alerts/evaluate', mutation('POST', idem('cycle-eval-2'), { asOf: '2026-01-16' }));
  assert.equal(sustained.response.status, 200);
  assert.equal(rows("SELECT COUNT(*) AS count FROM notification_outbox WHERE recipient='cycle@example.com' AND notification_key LIKE 'daily:%';")[0].count, 1);

  executeLocalD1(stateDir, { command: "UPDATE financial_entries SET amount_fen=100000 WHERE id='p6-cycle-entry';" });
  const recovered = await jsonRequest('/api/alerts/evaluate', mutation('POST', idem('cycle-recover'), { asOf: '2026-01-17' }));
  assert.equal(recovered.response.status, 200);
  assert.equal(rows("SELECT COUNT(*) AS count FROM alert_events WHERE object_id='p6-cycle-fw' AND rule_key='analysis.lag.recovered';")[0].count, 1);
  assert.equal(rows("SELECT state FROM alert_events WHERE object_id='p6-cycle-fw' AND rule_key='analysis.lag';")[0].state, 'resolved');

  executeLocalD1(stateDir, { command: "UPDATE financial_entries SET amount_fen=50000 WHERE id='p6-cycle-entry';" });
  const recross = await jsonRequest('/api/alerts/evaluate', mutation('POST', idem('cycle-recross'), { asOf: '2026-01-18' }));
  assert.equal(recross.response.status, 200);
  assert.equal(rows("SELECT COUNT(*) AS count FROM alert_events WHERE object_id='p6-cycle-fw' AND rule_key='analysis.lag';")[0].count, 2);
  assert.equal(rows("SELECT COUNT(*) AS count FROM alert_events WHERE object_id='p6-cycle-fw' AND rule_key='analysis.lag' AND state='active';")[0].count, 1);
});

test('scheduled task delivers a small outbox batch through the configured notification adapter', async () => {
  const eventId = 'p6-delivery-event';
  const outboxId = 'p6-delivery-outbox';
  executeLocalD1(stateDir, {
    command: `
      UPDATE notification_outbox SET status='sent',lease_token=NULL,lease_until=NULL WHERE status IN ('pending','failed','leased');
      INSERT INTO alert_events (id,rule_key,rule_version,object_type,object_id,period_key,severity,state,unique_event_key,message,first_seen_at,last_seen_at,resolved_at)
      VALUES ('${eventId}','delivery.test',1,'framework','p6-fw','2026-03','info','active','delivery.test.unique','P6通知投递测试','2026-03-02T00:00:00.000Z','2026-03-02T00:00:00.000Z',NULL);
      INSERT INTO notification_outbox (id,event_id,recipient,notification_key,status,lease_token,lease_until,attempt_count,next_attempt_at,last_error,created_at,updated_at)
      VALUES ('${outboxId}','${eventId}','deliver@example.com','delivery:test:deliver@example.com','pending',NULL,NULL,0,'2026-03-02T00:00:00.000Z',NULL,'2026-03-02T00:00:00.000Z','2026-03-02T00:00:00.000Z');
    `,
  });
  const before = deliveredMessages.length;
  const run = await jsonRequest('/api/system/tasks/run', mutation('POST', idem('task-delivery'), { now: '2026-03-02T00:05:00.000Z' }));
  assert.equal(run.response.status, 200);
  assert.equal(run.body.data.notificationDelivery.configured, true);
  assert.ok(run.body.data.notificationDelivery.sent >= 1);
  assert.ok(deliveredMessages.length > before);
  const delivered = deliveredMessages.find((item) => item.body.to === 'deliver@example.com');
  assert.ok(delivered);
  assert.equal(delivered.authorization, 'Bearer p6-delivery-token');
  assert.equal(delivered.body.text, 'P6通知投递测试');
  assert.equal(rows(`SELECT status FROM notification_outbox WHERE id='${outboxId}';`)[0].status, 'sent');
});

test('dashboard statistics come from current business facts and active alerts instead of hardcoded samples', async () => {
  const dashboard = await jsonRequest('/api/analysis/dashboard?asOf=2026-02-28');
  assert.equal(dashboard.response.status, 200);
  assert.ok(dashboard.body.data.projectCount >= 3);
  assert.ok(dashboard.body.data.activeAlertCount >= 1);
  assert.equal(typeof dashboard.body.data.pendingSettlementCount, 'number');
  assert.equal(typeof dashboard.body.data.unreleasedProjectCount, 'number');
});

test('logical D1 backup is resumable in R2, integrity verified, and restorable into an independent D1', async () => {
  const factTime = '2026-09-11T00:00:00.000Z';
  executeLocalD1(stateDir, {
    command: `
      INSERT INTO implementation_records (id,project_id,historical,record_date,personnel,note,version,created_by,created_at,updated_at)
      VALUES ('p6-restore-impl','p6-reserve',0,'2026-09-11','恢复演练人员','恢复演练',1,'${adminId}','${factTime}','${factTime}');
      INSERT INTO implementation_lines (id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled,created_at)
      VALUES ('p6-restore-impl-line','p6-restore-impl','p6-reserve','p6-release-line','p6-reserve-dm','恢复演练实施','套',200000,180000,'${factTime}');
      INSERT INTO settlements (id,project_id,settlement_date,amount_fen,final,note,version,voided_at,voided_by,void_reason,created_by,created_at,updated_at)
      VALUES ('p6-restore-settlement','p6-reserve','2026-09-11',12345,0,'恢复演练结算',1,NULL,NULL,NULL,'${adminId}','${factTime}','${factTime}');
      INSERT INTO settlement_coverage (id,settlement_id,project_id,demand_material_id,quantity_scaled,created_at)
      VALUES ('p6-restore-settlement-line','p6-restore-settlement','p6-reserve','p6-reserve-dm',100000,'${factTime}');
    `,
  });
  const sourceFacts = {
    project: rows("SELECT id,name,framework_id,reserve_version FROM projects WHERE id='p6-reserve';")[0],
    finance: rows("SELECT COALESCE(SUM(amount_fen),0) AS total FROM financial_entries WHERE framework_id='p6-fw';")[0],
    release: rows("SELECT project_id,demand_material_id,quantity_scaled FROM release_lines WHERE id='p6-release-line';")[0],
    implementation: rows("SELECT project_id,demand_material_id,completed_quantity_scaled,actual_used_quantity_scaled FROM implementation_lines WHERE id='p6-restore-impl-line';")[0],
    settlement: rows("SELECT project_id,demand_material_id,quantity_scaled FROM settlement_coverage WHERE id='p6-restore-settlement-line';")[0],
    rule: rows("SELECT version,mode,threshold_basis_points FROM analysis_rules ORDER BY version DESC LIMIT 1;")[0],
  };

  const created = await jsonRequest('/api/backups', mutation('POST', idem('backup-create'), { backupDate: '2026-09-12', kind: 'daily' }));
  assert.equal(created.response.status, 201);
  let backup = created.body.data;
  for (let i = 0; i < 100 && backup.status !== 'completed'; i += 1) {
    const step = await jsonRequest(`/api/backups/${backup.id}/step`, mutation('POST', idem(`backup-step-${i}`), {}));
    assert.equal(step.response.status, 200);
    backup = step.body.data;
  }
  assert.equal(backup.status, 'completed');
  assert.ok(backup.chunkCount > 0);
  assert.ok(backup.manifestKey);
  const verified = await jsonRequest(`/api/backups/${backup.id}/verify`, mutation('POST', idem('backup-verify'), {}));
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.data.verified, true);
  assert.equal(verified.body.data.missingObjects.length, 0);

  const restoreState = makeStateDir('tpm-p6-restored-db-');
  const artifactsDir = makeStateDir('tpm-p6-restore-artifacts-');
  try {
    const manifest = getLocalR2Json(stateDir, backup.manifestKey, artifactsDir);
    assert.equal(manifest.backupId, backup.id);
    assert.equal(manifest.chunks.length, backup.chunkCount);
    const chunksByTable = new Map();
    for (const chunk of manifest.chunks) {
      const payload = getLocalR2Json(stateDir, chunk.key, artifactsDir);
      assert.equal(payload.table, chunk.table);
      const current = chunksByTable.get(chunk.table) ?? [];
      current.push({ index: chunk.index, rows: payload.rows });
      chunksByTable.set(chunk.table, current);
    }

    applyLocalMigrations(restoreState);
    executeLocalD1(restoreState, { command: [...restoreTableOrder].reverse().map((table) => `DELETE FROM "${table}";`).join('\n') });
    const restoreStatements = [];
    for (const table of restoreTableOrder) {
      const tableChunks = (chunksByTable.get(table) ?? []).sort((left, right) => left.index - right.index);
      for (const chunk of tableChunks) {
        const sql = insertSql(table, chunk.rows);
        if (sql) restoreStatements.push(sql);
      }
    }
    if (restoreStatements.length) executeLocalD1(restoreState, { command: restoreStatements.join('\n') });

    const restoredRows = (command) => queryLocalD1(restoreState, command).flatMap((entry) => entry.results ?? []);
    assert.deepEqual(restoredRows("SELECT id,name,framework_id,reserve_version FROM projects WHERE id='p6-reserve';")[0], sourceFacts.project);
    assert.deepEqual(restoredRows("SELECT COALESCE(SUM(amount_fen),0) AS total FROM financial_entries WHERE framework_id='p6-fw';")[0], sourceFacts.finance);
    assert.deepEqual(restoredRows("SELECT project_id,demand_material_id,quantity_scaled FROM release_lines WHERE id='p6-release-line';")[0], sourceFacts.release);
    assert.deepEqual(restoredRows("SELECT project_id,demand_material_id,completed_quantity_scaled,actual_used_quantity_scaled FROM implementation_lines WHERE id='p6-restore-impl-line';")[0], sourceFacts.implementation);
    assert.deepEqual(restoredRows("SELECT project_id,demand_material_id,quantity_scaled FROM settlement_coverage WHERE id='p6-restore-settlement-line';")[0], sourceFacts.settlement);
    assert.deepEqual(restoredRows("SELECT version,mode,threshold_basis_points FROM analysis_rules ORDER BY version DESC LIMIT 1;")[0], sourceFacts.rule);
    assert.equal(restoredRows("SELECT COUNT(*) AS count FROM auth_sessions;")[0].count, 0, 'backup restore deliberately does not revive login sessions');
  } finally {
    cleanupStateDir(restoreState);
    cleanupStateDir(artifactsDir);
  }
});

test('server task tick can create the scheduled 03:00 Asia/Shanghai backup without any browser', async () => {
  const run = await jsonRequest('/api/system/tasks/run', mutation('POST', idem('task-run'), { now: '2026-09-12T19:00:00.000Z' }));
  assert.equal(run.response.status, 200);
  assert.equal(run.body.data.businessDate, '2026-09-13');
  assert.equal(run.body.data.backupCreated, true);
  const backups = await jsonRequest('/api/backups');
  assert.ok(backups.body.data.items.some((item) => item.backupDate === '2026-09-13' && item.kind === 'daily'));
});
