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

const stateDir = makeStateDir('tpm-p5-delivery-');
let runtime;
let adminCookie;
let implementationCookie;
let financeCookie;
let scopedReadonlyCookie;
let adminId;

function idem(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function jsonRequest(path, init = {}, cookie = adminCookie) {
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('Cookie', cookie);
  const response = await runtime.request(path, { ...init, headers });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON body */ }
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

function seedP5Projects() {
  const now = '2026-09-12T00:00:00.000Z';
  const projects = [
    ['p5-project-a', 'P5主流程项目', 'p5-demand-a', 'p5-dm-a'],
    ['p5-project-b', 'P5先结算项目', 'p5-demand-b', 'p5-dm-b'],
    ['p5-project-c', 'P5历史实施项目', 'p5-demand-c', 'p5-dm-c'],
    ['p5-project-race', 'P5并发出库项目', 'p5-demand-race', 'p5-dm-race'],
    ['p5-project-attach-a', 'P5附件项目A', 'p5-demand-attach-a', 'p5-dm-attach-a'],
    ['p5-project-attach-b', 'P5附件项目B', 'p5-demand-attach-b', 'p5-dm-attach-b'],
    ['p5-project-empty', 'P5未实施未结算项目', 'p5-demand-empty', 'p5-dm-empty'],
    ['p5-project-nonfinal', 'P5非最终结算项目', 'p5-demand-nonfinal', 'p5-dm-nonfinal'],
  ];
  executeLocalD1(stateDir, {
    command: `
      INSERT INTO materials (id,code,name,model,unit,enabled,version,created_by,created_at,updated_at)
      VALUES ('p5-material','P5-M','P5测试物资','JX-P5','套',1,1,'${adminId}','${now}','${now}');

      INSERT INTO import_batches
        (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
      VALUES ('p5-batch','P5合成需求.xlsx','${'6'.repeat(64)}','xlsx','{}','published',8,8,0,0,8,1,'${adminId}','${now}','${now}','${now}');

      ${projects.map(([projectId, projectName, demandId, demandMaterialId], index) => `
        INSERT INTO demands
          (id,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
        VALUES ('${demandId}','p5-source-${index}','p5-batch','${'6'.repeat(64)}','P5合成需求.xlsx','需求',${index + 2},'${index + 1}',2026,'220kV','220kV','P5线路${index + 1}','#${index + 1}','防断线',NULL,'p5-sig-${index}','{}','{}',1,'${adminId}','${now}','${now}');
        INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
        VALUES ('${demandMaterialId}','${demandId}','JX-P5','p5-material',1000000,'套','${now}');
        INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
        VALUES ('${projectId}','${projectName}',2026,NULL,'confirmed',1,NULL,1,'${adminId}','${now}','${now}');
        INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
        VALUES ('p5-allocation-${index}','${projectId}','${demandMaterialId}',1000000,'${now}');
      `).join('\n')}
    `,
  });
}

async function createRelease(projectId, demandMaterialId, quantityScaled, expectedProjectVersion, releaseDate = '2026-09-10') {
  return jsonRequest('/api/release-batches', mutation('POST', idem('release'), {
    projectId,
    expectedProjectVersion,
    releaseDate,
    note: null,
    lines: [{ demandMaterialId, quantityScaled }],
  }));
}

async function createImplementation({ projectId, expectedProjectVersion, releaseLineId, completedQuantityScaled, recordDate = '2026-09-10' }, cookie = adminCookie) {
  return jsonRequest('/api/implementations', mutation('POST', idem('implementation'), {
    historical: false,
    projectId,
    expectedProjectVersion,
    recordDate,
    personnel: '测试人员',
    note: null,
    lines: [{
      releaseLineId,
      description: null,
      unit: '套',
      completedQuantityScaled,
      actualUsedQuantityScaled: completedQuantityScaled,
    }],
  }), cookie);
}

async function createSettlement({ projectId, expectedProjectVersion, quantityScaled = 1000000, final = true, settlementDate = '2026-09-12', amountFen = 100000 }) {
  const demandMaterialId = projectId.replace('project', 'dm');
  return jsonRequest('/api/settlements', mutation('POST', idem('settlement'), {
    projectId,
    expectedProjectVersion,
    settlementDate,
    amountFen,
    final,
    note: null,
    coverage: [{ demandMaterialId, quantityScaled }],
    agreementAllocations: [],
  }), financeCookie);
}

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8806,
    migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:p5-pepper', 'BOOTSTRAP_TOKEN:p5-bootstrap'],
  });
  const bootstrap = await bootstrapAdmin(runtime, { token: 'p5-bootstrap' });
  assert.equal(bootstrap.response.status, 201);
  adminId = bootstrap.body.data.id;
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));
  seedP5Projects();

  const implementation = await createMember(runtime, adminCookie, {
    username: 'p5-implementation', displayName: 'P5实施成员', role: 'implementation',
    salt: fixedSalt(51), credential: fixedCredential(51), scopes: [{ type: 'all', id: null }],
  });
  assert.equal(implementation.response.status, 201);
  const finance = await createMember(runtime, adminCookie, {
    username: 'p5-finance', displayName: 'P5财务成员', role: 'finance',
    salt: fixedSalt(52), credential: fixedCredential(52), scopes: [{ type: 'all', id: null }],
  });
  assert.equal(finance.response.status, 201);
  const readonly = await createMember(runtime, adminCookie, {
    username: 'p5-readonly-b', displayName: 'P5附件B只读', role: 'readonly',
    salt: fixedSalt(53), credential: fixedCredential(53), scopes: [{ type: 'project', id: 'p5-project-attach-b' }],
  });
  assert.equal(readonly.response.status, 201);
  executeLocalD1(stateDir, {
    command: "UPDATE members SET must_change_password=0 WHERE username IN ('p5-implementation','p5-finance','p5-readonly-b')",
  });
  const implLogin = await loginWithCredential(runtime, 'p5-implementation', fixedCredential(51));
  const financeLogin = await loginWithCredential(runtime, 'p5-finance', fixedCredential(52));
  const readonlyLogin = await loginWithCredential(runtime, 'p5-readonly-b', fixedCredential(53));
  assert.equal(implLogin.response.status, 200);
  assert.equal(financeLogin.response.status, 200);
  assert.equal(readonlyLogin.response.status, 200);
  implementationCookie = cookiePair(implLogin.response.headers.get('set-cookie'));
  financeCookie = cookiePair(financeLogin.response.headers.get('set-cookie'));
  scopedReadonlyCookie = cookiePair(readonlyLogin.response.headers.get('set-cookie'));
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('partial release and implementation do not mark a demand complete; full implementation creates settlement todo, settlement and void switch states independently', async () => {
  const firstRelease = await createRelease('p5-project-a', 'p5-dm-a', 600000, 1, '2026-09-10');
  assert.equal(firstRelease.response.status, 201);
  assert.equal(firstRelease.body.data.projectVersion, 2);
  const releaseLineA = firstRelease.body.data.lines[0];

  const firstImplementation = await createImplementation({
    projectId: 'p5-project-a', expectedProjectVersion: 2, releaseLineId: releaseLineA.id,
    completedQuantityScaled: 600000, recordDate: '2026-09-10',
  }, implementationCookie);
  assert.equal(firstImplementation.response.status, 201);
  assert.equal(firstImplementation.body.data.projectVersion, 3);

  let lifecycle = await jsonRequest('/api/projects/p5-project-a/lifecycle');
  assert.equal(lifecycle.response.status, 200);
  assert.equal(lifecycle.body.data.lines[0].allocatedQuantityScaled, 1000000);
  assert.equal(lifecycle.body.data.lines[0].releasedQuantityScaled, 600000);
  assert.equal(lifecycle.body.data.lines[0].implementedQuantityScaled, 600000);
  assert.equal(lifecycle.body.data.lines[0].state, 'unimplemented_unsettled');
  assert.equal(lifecycle.body.data.projectState, 'unimplemented_unsettled');
  assert.equal(lifecycle.body.data.settlementTodo.needed, false);

  const shrink = await jsonRequest('/api/projects/p5-project-a/allocations', mutation('PUT', idem('shrink-protected'), {
    expectedVersion: 3,
    allocations: [{ demandMaterialId: 'p5-dm-a', quantityScaled: 500000 }],
  }));
  assert.equal(shrink.response.status, 422);
  assert.equal(shrink.body.error.code, 'PROJECT_SCOPE_PROTECTED');
  assert.equal(dbRows("SELECT quantity_scaled FROM demand_allocations WHERE project_id='p5-project-a'")[0].quantity_scaled, 1000000);

  const secondRelease = await createRelease('p5-project-a', 'p5-dm-a', 400000, 3, '2026-09-11');
  assert.equal(secondRelease.response.status, 201);
  const secondImplementation = await createImplementation({
    projectId: 'p5-project-a', expectedProjectVersion: 4, releaseLineId: secondRelease.body.data.lines[0].id,
    completedQuantityScaled: 400000, recordDate: '2026-09-11',
  }, implementationCookie);
  assert.equal(secondImplementation.response.status, 201);

  lifecycle = await jsonRequest('/api/projects/p5-project-a/lifecycle');
  assert.equal(lifecycle.body.data.lines[0].implementationComplete, true);
  assert.equal(lifecycle.body.data.projectState, 'implemented_unsettled');
  assert.deepEqual(lifecycle.body.data.settlementTodo, {
    needed: true,
    implementationCompletedDate: '2026-09-11',
    dueDate: '2026-10-11',
    finalSettlementId: null,
  });

  const settlement = await createSettlement({ projectId: 'p5-project-a', expectedProjectVersion: 5 });
  assert.equal(settlement.response.status, 201);
  assert.equal(dbRows("SELECT COUNT(*) AS count FROM financial_entries WHERE project_id='p5-project-a'")[0].count, 0);
  lifecycle = await jsonRequest('/api/projects/p5-project-a/lifecycle');
  assert.equal(lifecycle.body.data.projectState, 'implemented_settled');
  assert.equal(lifecycle.body.data.settlementTodo.needed, false);

  const voided = await jsonRequest(`/api/settlements/${settlement.body.data.id}/void`, mutation('POST', idem('void-settlement'), {
    expectedVersion: 1,
    expectedProjectVersion: 6,
    reason: '测试撤销',
  }), financeCookie);
  assert.equal(voided.response.status, 200);
  lifecycle = await jsonRequest('/api/projects/p5-project-a/lifecycle');
  assert.equal(lifecycle.body.data.projectState, 'implemented_unsettled');
  assert.equal(lifecycle.body.data.settlementTodo.needed, true);
  assert.equal(lifecycle.body.data.settlementTodo.dueDate, '2026-10-11');
});

test('settlement may precede implementation and produces unimplemented-settled state without creating financial occurrence', async () => {
  const settlement = await createSettlement({ projectId: 'p5-project-b', expectedProjectVersion: 1, settlementDate: '2026-09-09' });
  assert.equal(settlement.response.status, 201);
  const lifecycle = await jsonRequest('/api/projects/p5-project-b/lifecycle');
  assert.equal(lifecycle.response.status, 200);
  assert.equal(lifecycle.body.data.projectState, 'unimplemented_settled');
  assert.equal(lifecycle.body.data.lines[0].implementedQuantityScaled, 0);
  assert.equal(lifecycle.body.data.lines[0].settledQuantityScaled, 1000000);
  assert.equal(dbRows("SELECT COUNT(*) AS count FROM financial_entries WHERE project_id='p5-project-b'")[0].count, 0);
});

test('project with no implementation and no settlement remains unimplemented-unsettled', async () => {
  const lifecycle = await jsonRequest('/api/projects/p5-project-empty/lifecycle');
  assert.equal(lifecycle.response.status, 200);
  assert.equal(lifecycle.body.data.projectState, 'unimplemented_unsettled');
  assert.equal(lifecycle.body.data.implementationComplete, false);
  assert.equal(lifecycle.body.data.settlementComplete, false);
});

test('full non-final coverage is not settled until an explicit final confirmation closes the project scope', async () => {
  const nonFinal = await createSettlement({
    projectId: 'p5-project-nonfinal', expectedProjectVersion: 1, final: false,
    quantityScaled: 1000000, settlementDate: '2026-09-08', amountFen: 100000,
  });
  assert.equal(nonFinal.response.status, 201);

  let lifecycle = await jsonRequest('/api/projects/p5-project-nonfinal/lifecycle');
  assert.equal(lifecycle.response.status, 200);
  assert.equal(lifecycle.body.data.lines[0].settledQuantityScaled, 1000000);
  assert.equal(lifecycle.body.data.lines[0].settlementComplete, false);
  assert.equal(lifecycle.body.data.settlementComplete, false);
  assert.equal(lifecycle.body.data.projectState, 'unimplemented_unsettled');

  const finalConfirmation = await jsonRequest('/api/settlements', mutation('POST', idem('final-confirmation'), {
    projectId: 'p5-project-nonfinal', expectedProjectVersion: 2, settlementDate: '2026-09-09', amountFen: 0,
    final: true, note: '确认最终结算', coverage: [], agreementAllocations: [],
  }), financeCookie);
  assert.equal(finalConfirmation.response.status, 201);

  lifecycle = await jsonRequest('/api/projects/p5-project-nonfinal/lifecycle');
  assert.equal(lifecycle.body.data.settlementComplete, true);
  assert.equal(lifecycle.body.data.lines[0].settlementComplete, true);
  assert.equal(lifecycle.body.data.projectState, 'unimplemented_settled');
  assert.equal(lifecycle.body.data.settlementTodo.finalSettlementId, finalConfirmation.body.data.id);
});

test('historical implementation can exist without outbound scope, link later without fabricating release, and idempotent relink does not double count', async () => {
  const historical = await jsonRequest('/api/implementations', mutation('POST', idem('historical'), {
    historical: true,
    projectId: null,
    expectedProjectVersion: null,
    recordDate: '2026-08-01',
    personnel: '历史班组',
    note: '上线前记录',
    lines: [{ releaseLineId: null, description: '历史实施30套', unit: '套', completedQuantityScaled: 300000, actualUsedQuantityScaled: 300000 }],
  }), implementationCookie);
  assert.equal(historical.response.status, 201);
  assert.equal(historical.body.data.projectId, null);
  const lineId = historical.body.data.lines[0].id;
  assert.equal(dbRows("SELECT COUNT(*) AS count FROM release_batches WHERE project_id='p5-project-c'")[0].count, 0);

  const key = idem('historical-link');
  const linkBody = {
    expectedVersion: 1,
    projectId: 'p5-project-c',
    expectedProjectVersion: 1,
    links: [{ implementationLineId: lineId, demandMaterialId: 'p5-dm-c' }],
  };
  const linked = await jsonRequest(`/api/implementations/${historical.body.data.id}/link`, mutation('PUT', key, linkBody), implementationCookie);
  assert.equal(linked.response.status, 200);
  const replay = await jsonRequest(`/api/implementations/${historical.body.data.id}/link`, mutation('PUT', key, linkBody), implementationCookie);
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, linked.body);
  assert.equal(dbRows("SELECT COUNT(*) AS count FROM release_batches WHERE project_id='p5-project-c'")[0].count, 0);

  const lifecycle = await jsonRequest('/api/projects/p5-project-c/lifecycle');
  assert.equal(lifecycle.body.data.lines[0].releasedQuantityScaled, 0);
  assert.equal(lifecycle.body.data.lines[0].implementedQuantityScaled, 300000);
  assert.equal(lifecycle.body.data.lines[0].state, 'unimplemented_unsettled');
});

test('concurrent release batches serialize on project version and cannot over-release', async () => {
  const [left, right] = await Promise.all([
    createRelease('p5-project-race', 'p5-dm-race', 600000, 1),
    createRelease('p5-project-race', 'p5-dm-race', 600000, 1),
  ]);
  assert.deepEqual([left.response.status, right.response.status].sort(), [201, 409]);
  assert.equal(dbRows("SELECT COALESCE(SUM(quantity_scaled),0) AS total FROM release_lines WHERE project_id='p5-project-race'")[0].total, 600000);
  assert.equal(dbRows("SELECT version FROM projects WHERE id='p5-project-race'")[0].version, 2);
});

test('normal implementation cannot exceed its released quantity', async () => {
  const release = await createRelease('p5-project-attach-a', 'p5-dm-attach-a', 600000, 1);
  assert.equal(release.response.status, 201);
  const overflow = await createImplementation({
    projectId: 'p5-project-attach-a', expectedProjectVersion: 2, releaseLineId: release.body.data.lines[0].id,
    completedQuantityScaled: 700000,
  }, implementationCookie);
  assert.equal(overflow.response.status, 422);
  assert.equal(overflow.body.error.code, 'IMPLEMENTATION_EXCEEDS_RELEASE');
});

test('attachments are private to the owning project scope and round-trip through R2', async () => {
  const releaseRows = await jsonRequest('/api/release-batches?projectId=p5-project-attach-a');
  const releaseLineId = releaseRows.body.data.items[0].lines[0].id;
  const implementation = await createImplementation({
    projectId: 'p5-project-attach-a', expectedProjectVersion: 2, releaseLineId,
    completedQuantityScaled: 100000, recordDate: '2026-09-12',
  }, implementationCookie);
  assert.equal(implementation.response.status, 201);

  const upload = await runtime.request(`/api/attachments?objectType=implementation&objectId=${implementation.body.data.id}&fileName=proof.txt`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'text/plain', 'Idempotency-Key': idem('attachment') },
    body: 'private-proof',
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.data.projectId, 'p5-project-attach-a');
  assert.equal(uploaded.data.fileName, 'proof.txt');

  const adminDownload = await runtime.request(`/api/attachments/${uploaded.data.id}/content`, { headers: { Cookie: adminCookie } });
  assert.equal(adminDownload.status, 200);
  assert.equal(await adminDownload.text(), 'private-proof');

  const denied = await runtime.request(`/api/attachments/${uploaded.data.id}/content`, { headers: { Cookie: scopedReadonlyCookie } });
  assert.equal(denied.status, 403);
});

test('role boundaries keep implementation and settlement writes separate', async () => {
  const financeRelease = await createRelease('p5-project-attach-b', 'p5-dm-attach-b', 100000, 1);
  assert.equal(financeRelease.response.status, 201);
  const releaseId = financeRelease.body.data.lines[0].id;

  const financeImpl = await createImplementation({
    projectId: 'p5-project-attach-b', expectedProjectVersion: 2, releaseLineId: releaseId, completedQuantityScaled: 100000,
  }, financeCookie);
  assert.equal(financeImpl.response.status, 403);

  const implementationSettlement = await jsonRequest('/api/settlements', mutation('POST', idem('impl-settlement'), {
    projectId: 'p5-project-attach-b', expectedProjectVersion: 2, settlementDate: '2026-09-12', amountFen: 1000,
    final: false, note: null, coverage: [{ demandMaterialId: 'p5-dm-attach-b', quantityScaled: 100000 }], agreementAllocations: [],
  }), implementationCookie);
  assert.equal(implementationSettlement.response.status, 403);
});
