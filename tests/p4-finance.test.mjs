import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, executeLocalD1, makeStateDir, queryLocalD1, startWranglerServer } from './helpers/wrangler.mjs';
import {
  bootstrapAdmin,
  cookiePair,
  createMember,
  fixedCredential,
  fixedSalt,
  loginWithCredential,
} from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-p4-finance-');
let runtime;
let adminCookie;
let financeCookie;
let adminId;

function idem(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function jsonRequest(path, init = {}, cookie = adminCookie) {
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('Cookie', cookie);
  const response = await runtime.request(path, { ...init, headers });
  let body = null;
  try { body = await response.json(); } catch { /* no JSON body */ }
  return { response, body };
}

function mutation(method, key, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  };
}

function dbRows(command) {
  return queryLocalD1(stateDir, command).flatMap((entry) => entry.results ?? []);
}

function seedProjects() {
  const now = '2026-09-12T00:00:00.000Z';
  executeLocalD1(stateDir, {
    command: `
      INSERT INTO projects
        (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES
        ('p4-project-a','P4子项目A',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p4-project-b','P4子项目B',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p4-project-c','P4子项目C',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p4-project-d','P4子项目D',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p4-project-e','P4子项目E',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p4-project-f','P4子项目F',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p4-project-g','P4子项目G',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p4-project-h','P4子项目H',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}'),
        ('p4-project-i','P4子项目I',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}');
    `,
  });
}

async function createFramework({ code, name, totalAmountFen, annualTargetFen = null, startDate = '2026-01-01', endDate = '2026-12-31' }) {
  return jsonRequest('/api/frameworks', mutation('POST', idem('framework'), {
    code, name, totalAmountFen, annualTargetFen, startDate, endDate,
  }));
}

async function createAgreement({ frameworkId, code, name, amountFen, validFrom = '2026-01-01', validTo = '2026-12-31', status = 'active' }) {
  return jsonRequest('/api/agreements', mutation('POST', idem('agreement'), {
    frameworkId, code, name, amountFen, validFrom, validTo, status,
  }));
}

async function bindProject(projectId, frameworkId, expectedVersion = 1) {
  return jsonRequest(`/api/projects/${projectId}/framework`, mutation('PUT', idem('bind'), {
    expectedVersion, frameworkId,
  }));
}

async function createBudget(projectId, totalAmountFen, allocations = []) {
  return jsonRequest('/api/budgets', mutation('POST', idem('budget'), {
    projectId, totalAmountFen, allocations, note: null,
  }));
}

async function updateBudget(budget, totalAmountFen, allocations) {
  const result = await jsonRequest(`/api/budgets/${budget.id}`, mutation('PUT', idem('budget-update'), {
    expectedVersion: budget.version, totalAmountFen, allocations, note: null,
  }));
  if (result.response.ok) budget.version = result.body.data.version;
  return result;
}

async function confirmBudget(budget) {
  const result = await jsonRequest(`/api/budgets/${budget.id}/confirm`, mutation('POST', idem('budget-confirm'), {
    expectedVersion: budget.version,
  }));
  if (result.response.ok) budget.version = result.body.data.version;
  return result;
}

async function createEntry({ type = 'budget_occurrence', projectId, amountFen, businessDate = '2026-09-12', allocations = [], note = null }, cookie = adminCookie) {
  return jsonRequest('/api/financial-entries', mutation('POST', idem('entry'), {
    type, projectId, amountFen, businessDate, allocations, note,
  }), cookie);
}

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8805,
    migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:p4-pepper', 'BOOTSTRAP_TOKEN:p4-bootstrap'],
  });
  const bootstrap = await bootstrapAdmin(runtime, { token: 'p4-bootstrap' });
  assert.equal(bootstrap.response.status, 201);
  adminId = bootstrap.body.data.id;
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));
  seedProjects();

  const finance = await createMember(runtime, adminCookie, {
    username: 'p4-finance',
    displayName: 'P4财务成员',
    role: 'finance',
    salt: fixedSalt(41),
    credential: fixedCredential(41),
    scopes: [{ type: 'all', id: null }],
  });
  assert.equal(finance.response.status, 201);
  executeLocalD1(stateDir, { command: "UPDATE members SET must_change_password=0 WHERE username='p4-finance'" });
  const login = await loginWithCredential(runtime, 'p4-finance', fixedCredential(41));
  assert.equal(login.response.status, 200);
  financeCookie = cookiePair(login.response.headers.get('set-cookie'));
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('frameworks and agreements are versioned without rewriting history', async () => {
  const framework = await createFramework({ code: 'FW-P4-V', name: '版本框架', totalAmountFen: 1_000_000, annualTargetFen: 800_000 });
  assert.equal(framework.response.status, 201);
  assert.equal(framework.body.data.version, 1);

  const changed = await jsonRequest(`/api/frameworks/${framework.body.data.id}`, mutation('PUT', idem('framework-update'), {
    expectedVersion: 1,
    name: '版本框架调整', totalAmountFen: 1_200_000, annualTargetFen: 900_000,
    startDate: '2026-01-01', endDate: '2026-12-31', reason: '额度调整',
  }));
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.data.version, 2);

  const history = await jsonRequest(`/api/frameworks/${framework.body.data.id}/history`);
  assert.equal(history.response.status, 200);
  assert.deepEqual(history.body.data.items.map((item) => item.version), [2, 1]);
  assert.deepEqual(history.body.data.items.map((item) => item.totalAmountFen), [1_200_000, 1_000_000]);

  const agreement = await createAgreement({
    frameworkId: framework.body.data.id, code: 'AG-P4-V', name: '版本协议', amountFen: 600_000,
  });
  assert.equal(agreement.response.status, 201);
  const paused = await jsonRequest(`/api/agreements/${agreement.body.data.id}`, mutation('PUT', idem('agreement-update'), {
    expectedVersion: 1,
    name: '版本协议', amountFen: 600_000, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'paused', reason: '暂停',
  }));
  assert.equal(paused.response.status, 200);
  assert.equal(paused.body.data.version, 2);
  const agreementHistory = await jsonRequest(`/api/agreements/${agreement.body.data.id}/history`);
  assert.deepEqual(agreementHistory.body.data.items.map((item) => item.status), ['paused', 'active']);
});

test('budget draft may be incomplete, but confirmation requires exact same-framework agreement allocation and creates no occurrence', async () => {
  const fwA = await createFramework({ code: 'FW-P4-A', name: '框架A', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000 });
  const fwB = await createFramework({ code: 'FW-P4-B', name: '框架B', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000 });
  const agA1 = await createAgreement({ frameworkId: fwA.body.data.id, code: 'AG-P4-A1', name: '协议A1', amountFen: 600_000 });
  const agA2 = await createAgreement({ frameworkId: fwA.body.data.id, code: 'AG-P4-A2', name: '协议A2', amountFen: 500_000 });
  const agB = await createAgreement({ frameworkId: fwB.body.data.id, code: 'AG-P4-B', name: '协议B', amountFen: 500_000 });
  assert.equal((await bindProject('p4-project-a', fwA.body.data.id)).response.status, 200);

  const draft = await createBudget('p4-project-a', 700_000, []);
  assert.equal(draft.response.status, 201);
  const budget = { ...draft.body.data };

  const noAgreement = await confirmBudget(budget);
  assert.equal(noAgreement.response.status, 422);
  assert.equal(noAgreement.body.error.code, 'BUDGET_ALLOCATION_MISMATCH');

  const cross = await updateBudget(budget, 700_000, [{ agreementId: agB.body.data.id, amountFen: 700_000 }]);
  assert.equal(cross.response.status, 422);
  assert.equal(cross.body.error.code, 'AGREEMENT_FRAMEWORK_MISMATCH');

  const allocated = await updateBudget(budget, 700_000, [
    { agreementId: agA1.body.data.id, amountFen: 400_000 },
    { agreementId: agA2.body.data.id, amountFen: 300_000 },
  ]);
  assert.equal(allocated.response.status, 200);
  const confirmed = await confirmBudget(budget);
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.data.budgetVersion, 1);
  assert.equal(dbRows("SELECT COUNT(*) AS count FROM financial_entries WHERE project_id='p4-project-a';")[0].count, 0);
});

test('latest confirmed budget version alone counts toward framework budget totals', async () => {
  const framework = await createFramework({ code: 'FW-P4-BUD', name: '预算版本框架', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000 });
  const agreement = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-BUD', name: '预算协议', amountFen: 1_200_000 });
  assert.equal((await bindProject('p4-project-b', framework.body.data.id)).response.status, 200);
  const draft = await createBudget('p4-project-b', 600_000, [{ agreementId: agreement.body.data.id, amountFen: 600_000 }]);
  const budget = { ...draft.body.data };
  assert.equal((await confirmBudget(budget)).response.status, 200);

  assert.equal((await updateBudget(budget, 700_000, [{ agreementId: agreement.body.data.id, amountFen: 700_000 }])).response.status, 200);
  const second = await confirmBudget(budget);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.data.budgetVersion, 2);

  const summary = await jsonRequest(`/api/finance/summary?frameworkId=${framework.body.data.id}&asOf=2026-09-12`);
  assert.equal(summary.response.status, 200);
  assert.equal(summary.body.data.confirmedBudgetFen, 700_000);
  assert.equal(dbRows(`SELECT COUNT(*) AS count FROM budget_versions WHERE budget_id='${budget.id}';`)[0].count, 2);
});

test('financial occurrence requires an active same-framework agreement and finance role may post it', async () => {
  const fwA = await createFramework({ code: 'FW-P4-ENT-A', name: '流水框架A', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000 });
  const fwB = await createFramework({ code: 'FW-P4-ENT-B', name: '流水框架B', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000 });
  const active = await createAgreement({ frameworkId: fwA.body.data.id, code: 'AG-P4-ENT-A', name: '有效协议', amountFen: 500_000 });
  const cross = await createAgreement({ frameworkId: fwB.body.data.id, code: 'AG-P4-ENT-B', name: '跨框架协议', amountFen: 500_000 });
  const expired = await createAgreement({ frameworkId: fwA.body.data.id, code: 'AG-P4-ENT-X', name: '到期协议', amountFen: 500_000, validFrom: '2026-01-01', validTo: '2026-06-30' });
  assert.equal((await bindProject('p4-project-c', fwA.body.data.id)).response.status, 200);

  const noAgreement = await createEntry({ projectId: 'p4-project-c', amountFen: 100_000, allocations: [] }, financeCookie);
  assert.equal(noAgreement.response.status, 422);
  assert.equal(noAgreement.body.error.code, 'ENTRY_ALLOCATION_MISMATCH');

  const crossResult = await createEntry({ projectId: 'p4-project-c', amountFen: 100_000, allocations: [{ agreementId: cross.body.data.id, amountFen: 100_000 }] }, financeCookie);
  assert.equal(crossResult.response.status, 422);
  assert.equal(crossResult.body.error.code, 'AGREEMENT_FRAMEWORK_MISMATCH');

  const expiredResult = await createEntry({ projectId: 'p4-project-c', amountFen: 100_000, allocations: [{ agreementId: expired.body.data.id, amountFen: 100_000 }] }, financeCookie);
  assert.equal(expiredResult.response.status, 422);
  assert.equal(expiredResult.body.error.code, 'AGREEMENT_NOT_EFFECTIVE');

  const valid = await createEntry({ projectId: 'p4-project-c', amountFen: 100_000, allocations: [{ agreementId: active.body.data.id, amountFen: 100_000 }] }, financeCookie);
  assert.equal(valid.response.status, 201);
  assert.equal(valid.body.data.type, 'budget_occurrence');
});

test('one agreement can serve multiple projects and one project can split an entry across agreements without double counting', async () => {
  const framework = await createFramework({ code: 'FW-P4-MULTI', name: '多分配框架', totalAmountFen: 2_000_000, annualTargetFen: 2_000_000 });
  const a1 = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-M1', name: '协议M1', amountFen: 1_000_000 });
  const a2 = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-M2', name: '协议M2', amountFen: 1_000_000 });
  const p1 = await bindProject('p4-project-d', framework.body.data.id);
  const p2 = await bindProject('p4-project-e', framework.body.data.id);
  assert.equal(p1.response.status, 200);
  assert.equal(p2.response.status, 200);

  assert.equal((await createEntry({ projectId: 'p4-project-d', amountFen: 300_000, allocations: [{ agreementId: a1.body.data.id, amountFen: 300_000 }] })).response.status, 201);
  assert.equal((await createEntry({ projectId: 'p4-project-e', amountFen: 400_000, allocations: [
    { agreementId: a1.body.data.id, amountFen: 100_000 },
    { agreementId: a2.body.data.id, amountFen: 300_000 },
  ] })).response.status, 201);

  const summary = await jsonRequest(`/api/finance/summary?frameworkId=${framework.body.data.id}&asOf=2026-09-12`);
  assert.equal(summary.body.data.budgetOccurrenceFen, 700_000);
  const agreement1 = summary.body.data.agreements.find((item) => item.id === a1.body.data.id);
  const agreement2 = summary.body.data.agreements.find((item) => item.id === a2.body.data.id);
  assert.equal(agreement1.budgetOccurrenceFen, 400_000);
  assert.equal(agreement2.budgetOccurrenceFen, 300_000);
});

test('90% agreement and 80% framework warnings trigger exactly at the boundary, while budget overrun starts at one fen', async () => {
  const framework = await createFramework({ code: 'FW-P4-LIMIT', name: '阈值框架', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000 });
  const a1 = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-L1', name: '阈值协议1', amountFen: 600_000 });
  const a2 = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-L2', name: '阈值协议2', amountFen: 500_000 });
  const projectA = await bindProject('p4-project-f', framework.body.data.id);
  const projectB = await bindProject('p4-project-g', framework.body.data.id);
  assert.equal(projectA.response.status, 200);
  assert.equal(projectB.response.status, 200);

  const budgetAResult = await createBudget('p4-project-f', 500_000, [{ agreementId: a1.body.data.id, amountFen: 500_000 }]);
  const budgetA = { ...budgetAResult.body.data };
  assert.equal((await confirmBudget(budgetA)).response.status, 200);
  const budgetBResult = await createBudget('p4-project-g', 500_000, [{ agreementId: a2.body.data.id, amountFen: 500_000 }]);
  const budgetB = { ...budgetBResult.body.data };
  assert.equal((await confirmBudget(budgetB)).response.status, 200);

  assert.equal((await createEntry({ projectId: 'p4-project-f', amountFen: 539_999, allocations: [{ agreementId: a1.body.data.id, amountFen: 539_999 }] })).response.status, 201);
  assert.equal((await createEntry({ projectId: 'p4-project-g', amountFen: 260_000, allocations: [{ agreementId: a2.body.data.id, amountFen: 260_000 }] })).response.status, 201);

  let summary = await jsonRequest(`/api/finance/summary?frameworkId=${framework.body.data.id}&asOf=2026-09-12`);
  assert.equal(summary.body.data.frameworkUsageWarning, false);
  assert.equal(summary.body.data.agreements.find((item) => item.id === a1.body.data.id).usageWarning, false);

  assert.equal((await createEntry({ projectId: 'p4-project-f', amountFen: 1, allocations: [{ agreementId: a1.body.data.id, amountFen: 1 }] })).response.status, 201);
  summary = await jsonRequest(`/api/finance/summary?frameworkId=${framework.body.data.id}&asOf=2026-09-12`);
  assert.equal(summary.body.data.frameworkUsageBasisPoints, 8000);
  assert.equal(summary.body.data.frameworkUsageWarning, true);
  assert.equal(summary.body.data.budgetOverFrameworkWarning, false);
  assert.equal(summary.body.data.agreements.find((item) => item.id === a1.body.data.id).usageBasisPoints, 9000);
  assert.equal(summary.body.data.agreements.find((item) => item.id === a1.body.data.id).usageWarning, true);

  assert.equal((await updateBudget(budgetB, 500_001, [{ agreementId: a2.body.data.id, amountFen: 500_001 }])).response.status, 200);
  assert.equal((await confirmBudget(budgetB)).response.status, 200);
  summary = await jsonRequest(`/api/finance/summary?frameworkId=${framework.body.data.id}&asOf=2026-09-12`);
  assert.equal(summary.body.data.confirmedBudgetFen, 1_000_001);
  assert.equal(summary.body.data.budgetOverFrameworkWarning, true);
});

test('zero denominators are reported as unconfigured instead of infinity or fake 100%', async () => {
  const framework = await createFramework({ code: 'FW-P4-ZERO', name: '零额度框架', totalAmountFen: 0, annualTargetFen: 0 });
  const summary = await jsonRequest(`/api/finance/summary?frameworkId=${framework.body.data.id}&asOf=2026-09-12`);
  assert.equal(summary.response.status, 200);
  assert.equal(summary.body.data.frameworkUsageBasisPoints, null);
  assert.equal(summary.body.data.frameworkUsageConfigured, false);
  assert.equal(summary.body.data.annualProgressBasisPoints, null);
  assert.equal(summary.body.data.annualProgressConfigured, false);
});

test('reversal preserves the original entry, subtracts from totals, and cannot be applied twice', async () => {
  const framework = await createFramework({ code: 'FW-P4-REV', name: '冲销框架', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000 });
  const agreement = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-REV', name: '冲销协议', amountFen: 1_000_000 });
  const bound = await bindProject('p4-project-h', framework.body.data.id);
  assert.equal(bound.response.status, 200);
  const entry = await createEntry({ projectId: 'p4-project-h', amountFen: 200_000, allocations: [{ agreementId: agreement.body.data.id, amountFen: 200_000 }] });
  assert.equal(entry.response.status, 201);

  const reverseKey = idem('reverse');
  const reverseBody = { businessDate: '2026-09-13', reason: '录入错误' };
  const reversed = await jsonRequest(`/api/financial-entries/${entry.body.data.id}/reverse`, mutation('POST', reverseKey, reverseBody));
  assert.equal(reversed.response.status, 201);
  assert.equal(reversed.body.data.amountFen, -200_000);
  assert.equal(dbRows(`SELECT COUNT(*) AS count FROM financial_entries WHERE id IN ('${entry.body.data.id}','${reversed.body.data.id}');`)[0].count, 2);

  const replay = await jsonRequest(`/api/financial-entries/${entry.body.data.id}/reverse`, mutation('POST', reverseKey, reverseBody));
  assert.equal(replay.response.status, 201);
  assert.deepEqual(replay.body, reversed.body);
  assert.equal(dbRows(`SELECT COUNT(*) AS count FROM financial_entries WHERE reverses_entry_id='${entry.body.data.id}';`)[0].count, 1);

  const second = await jsonRequest(`/api/financial-entries/${entry.body.data.id}/reverse`, mutation('POST', idem('reverse-again'), {
    businessDate: '2026-09-14', reason: '重复冲销',
  }));
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error.code, 'ENTRY_ALREADY_REVERSED');

  const summary = await jsonRequest(`/api/finance/summary?frameworkId=${framework.body.data.id}&asOf=2026-09-14`);
  assert.equal(summary.body.data.budgetOccurrenceFen, 0);
});

test('budget confirmation idempotency replays after the object version advances', async () => {
  const framework = await createFramework({ code: 'FW-P4-IDEM', name: '幂等框架', totalAmountFen: 500_000, annualTargetFen: 500_000 });
  const agreement = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-IDEM', name: '幂等协议', amountFen: 500_000 });
  const projectId = 'p4-project-j';
  executeLocalD1(stateDir, {
    command: `INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES ('${projectId}','P4子项目J',2026,NULL,'confirmed',1,'${framework.body.data.id}',1,'${adminId}','2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z');`,
  });
  const created = await createBudget(projectId, 200_000, [{ agreementId: agreement.body.data.id, amountFen: 200_000 }]);
  assert.equal(created.response.status, 201);
  const key = idem('confirm-replay');
  const body = { expectedVersion: created.body.data.version };
  const first = await jsonRequest(`/api/budgets/${created.body.data.id}/confirm`, mutation('POST', key, body));
  assert.equal(first.response.status, 200);
  const replay = await jsonRequest(`/api/budgets/${created.body.data.id}/confirm`, mutation('POST', key, body));
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal(dbRows(`SELECT COUNT(*) AS count FROM budget_versions WHERE budget_id='${created.body.data.id}';`)[0].count, 1);
});

test('financial entry list paginates beyond 100 rows without gaps, duplicates, or per-row allocation loss', async () => {
  const framework = await createFramework({ code: 'FW-P4-PAGE', name: '流水分页框架', totalAmountFen: 10_000_000, annualTargetFen: 10_000_000 });
  const agreement = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-PAGE', name: '流水分页协议', amountFen: 10_000_000 });
  const projectId = 'p4-project-page';
  const createdAt = '2026-09-12T08:00:00.000Z';
  executeLocalD1(stateDir, {
    command: `
      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES ('${projectId}','P4分页项目',2026,NULL,'confirmed',1,'${framework.body.data.id}',1,'${adminId}','${createdAt}','${createdAt}');
      ${Array.from({ length: 105 }, (_, index) => {
        const suffix = String(index).padStart(3, '0');
        return `INSERT INTO financial_entries (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
          VALUES ('p4-page-${suffix}','${framework.body.data.id}','${projectId}','actual_cost','2026-09-12',${100 + index},NULL,NULL,'${adminId}','${createdAt}');
          INSERT INTO financial_entry_allocations (id,financial_entry_id,agreement_id,amount_fen,created_at)
          VALUES ('p4-page-allocation-${suffix}','p4-page-${suffix}','${agreement.body.data.id}',${100 + index},'${createdAt}');`;
      }).join('\n')}
    `,
  });

  const first = await jsonRequest(`/api/financial-entries?frameworkId=${framework.body.data.id}&limit=100`);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.items.length, 100);
  assert.ok(first.body.data.nextCursor);
  assert.ok(first.body.data.items.every((item) => item.allocations.length === 1));

  const second = await jsonRequest(`/api/financial-entries?frameworkId=${framework.body.data.id}&limit=100&cursor=${encodeURIComponent(first.body.data.nextCursor)}`);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.data.items.length, 5);
  assert.equal(second.body.data.nextCursor, null);
  const ids = [...first.body.data.items, ...second.body.data.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 105);
  assert.equal(ids.length, 105);

  const invalid = await jsonRequest(`/api/financial-entries?frameworkId=${framework.body.data.id}&limit=100&cursor=not-a-valid-cursor`);
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_CURSOR');
});

test('concurrent framework updates serialize by expectedVersion and concurrent append-only entries are both retained', async () => {
  const framework = await createFramework({ code: 'FW-P4-RACE', name: '并发框架', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000 });
  const [left, right] = await Promise.all([
    jsonRequest(`/api/frameworks/${framework.body.data.id}`, mutation('PUT', idem('fw-race-l'), {
      expectedVersion: 1, name: '并发框架L', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000,
      startDate: '2026-01-01', endDate: '2026-12-31', reason: 'L',
    })),
    jsonRequest(`/api/frameworks/${framework.body.data.id}`, mutation('PUT', idem('fw-race-r'), {
      expectedVersion: 1, name: '并发框架R', totalAmountFen: 1_000_000, annualTargetFen: 1_000_000,
      startDate: '2026-01-01', endDate: '2026-12-31', reason: 'R',
    })),
  ]);
  assert.deepEqual([left.response.status, right.response.status].sort(), [200, 409]);

  const agreement = await createAgreement({ frameworkId: framework.body.data.id, code: 'AG-P4-RACE', name: '并发协议', amountFen: 1_000_000 });
  const bound = await bindProject('p4-project-i', framework.body.data.id);
  assert.equal(bound.response.status, 200);
  const [e1, e2] = await Promise.all([
    createEntry({ type: 'actual_cost', projectId: 'p4-project-i', amountFen: 10_000, allocations: [{ agreementId: agreement.body.data.id, amountFen: 10_000 }] }),
    createEntry({ type: 'actual_cost', projectId: 'p4-project-i', amountFen: 20_000, allocations: [{ agreementId: agreement.body.data.id, amountFen: 20_000 }] }),
  ]);
  assert.equal(e1.response.status, 201);
  assert.equal(e2.response.status, 201);
  const summary = await jsonRequest(`/api/finance/summary?frameworkId=${framework.body.data.id}&asOf=2026-09-12`);
  assert.equal(summary.body.data.actualCostFen, 30_000);
});
