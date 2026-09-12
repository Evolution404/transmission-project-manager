import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, executeLocalD1, makeStateDir, queryLocalD1, startWranglerServer } from './helpers/wrangler.mjs';
import {
  bootstrapAdmin,
  cookiePair,
  createMember,
  fixedCredential,
  fixedSalt,
  jsonRequest as authJsonRequest,
  loginWithCredential,
} from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-p3-reserves-');
let runtime;
let adminCookie;
let readonlyCookie;

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

function seedP2Demands(adminId) {
  const now = '2026-09-12T00:00:00.000Z';
  executeLocalD1(stateDir, {
    command: `
      INSERT INTO materials (id,code,name,model,unit,enabled,version,created_by,created_at,updated_at) VALUES
        ('p3-m-set','P3-SET','测试线夹','JX-01','套',1,1,'${adminId}','${now}','${now}'),
        ('p3-m-each','P3-EACH','测试线夹','JX-01','只',1,1,'${adminId}','${now}','${now}');

      INSERT INTO import_batches
        (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
      VALUES
        ('p3-batch','P3合成需求.xlsx','${'3'.repeat(64)}','xlsx','{}','published',4,4,0,0,4,1,'${adminId}','${now}','${now}','${now}');

      INSERT INTO demands
        (id,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
      VALUES
        ('p3-d-split','p3-source-split','p3-batch','${'3'.repeat(64)}','P3合成需求.xlsx','需求',2,'1',2026,'220kV','220kV','龙城线','#1-#2','防断线',NULL,'p3-sig-split','{"序号":1}','{}',1,'${adminId}','${now}','${now}'),
        ('p3-d-set','p3-source-set','p3-batch','${'3'.repeat(64)}','P3合成需求.xlsx','需求',3,'2',2026,'220kV','220kV','龙城线','#3','防断线',NULL,'p3-sig-set','{"序号":2}','{}',1,'${adminId}','${now}','${now}'),
        ('p3-d-each','p3-source-each','p3-batch','${'3'.repeat(64)}','P3合成需求.xlsx','需求',4,'3',2026,'220kV','220kV','龙城线','#4','防鸟',NULL,'p3-sig-each','{"序号":3}','{}',1,'${adminId}','${now}','${now}'),
        ('p3-d-other','p3-source-other','p3-batch','${'3'.repeat(64)}','P3合成需求.xlsx','需求',5,'4',2026,'110kV','110kV','江北线','#8','防鸟',NULL,'p3-sig-other','{"序号":4}','{}',1,'${adminId}','${now}','${now}');

      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at) VALUES
        ('p3-dm-split','p3-d-split','JX-01','p3-m-set',1000000,'套','${now}'),
        ('p3-dm-set','p3-d-set','JX-01','p3-m-set',10000,'套','${now}'),
        ('p3-dm-each','p3-d-each','JX-01','p3-m-each',10000,'只','${now}'),
        ('p3-dm-other','p3-d-other','JX-01','p3-m-set',20000,'套','${now}'),
        ('p3-dm-cost','p3-d-other','JX-01','p3-m-set',20000,'套','${now}'),
        ('p3-dm-version','p3-d-set','JX-01','p3-m-set',10000,'套','${now}'),
        ('p3-dm-revise','p3-d-split','JX-01','p3-m-set',100000,'套','${now}'),
        ('p3-dm-mapping','p3-d-set','JX-01','p3-m-set',10000,'套','${now}'),
        ('p3-dm-round','p3-d-set','JX-01','p3-m-set',12500,'套','${now}'),
        ('p3-dm-overflow','p3-d-set','JX-01','p3-m-set',10000,'套','${now}');
    `,
  });
}

async function createProject({ name, allocations, year = 2026, owner = null } = {}) {
  return jsonRequest('/api/projects', mutation('POST', idem('project'), {
    name,
    year,
    owner,
    allocations,
  }));
}

async function replaceCosts(project, { materialPrices = [], fixedCosts = [] }) {
  const result = await jsonRequest(`/api/projects/${project.id}/costs`, mutation('PUT', idem('costs'), {
    expectedVersion: project.version,
    materialPrices,
    fixedCosts,
  }));
  if (result.response.ok) project.version = result.body.data.version;
  return result;
}

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8804,
    migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:p3-pepper', 'BOOTSTRAP_TOKEN:p3-bootstrap'],
  });
  const bootstrap = await bootstrapAdmin(runtime, { token: 'p3-bootstrap' });
  assert.equal(bootstrap.response.status, 201);
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));
  seedP2Demands(bootstrap.body.data.id);

  const created = await createMember(runtime, adminCookie, {
    username: 'p3-readonly',
    displayName: 'P3只读成员',
    role: 'readonly',
    salt: fixedSalt(31),
    credential: fixedCredential(31),
    scopes: [{ type: 'all', id: null }],
  });
  assert.equal(created.response.status, 201);
  executeLocalD1(stateDir, { command: "UPDATE members SET must_change_password=0 WHERE username='p3-readonly'" });
  const login = await loginWithCredential(runtime, 'p3-readonly', fixedCredential(31));
  assert.equal(login.response.status, 200);
  readonlyCookie = cookiePair(login.response.headers.get('set-cookie'));
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('reserve candidates expose remaining quantities, source trace and default grouping suggestions', async () => {
  const candidates = await jsonRequest('/api/projects/candidates?limit=50');
  assert.equal(candidates.response.status, 200);
  const split = candidates.body.data.items.find((item) => item.demandMaterialId === 'p3-dm-split');
  assert.equal(split.remainingQuantityScaled, 1000000);
  assert.deepEqual(split.source, {
    fileName: 'P3合成需求.xlsx', sheetName: '需求', rowNumber: 2,
  });

  const suggestions = await jsonRequest('/api/projects/suggestions?limit=50');
  assert.equal(suggestions.response.status, 200);
  assert.ok(suggestions.body.data.items.some((group) =>
    group.year === 2026 && group.category === '防断线' && group.voltage === '220kV' && group.lineName === '龙城线' && group.itemCount >= 2,
  ));
});

test('one demand quantity can be split 60/40 but never over-allocated', async () => {
  const first = await createProject({
    name: '拆分项目A',
    allocations: [{ demandMaterialId: 'p3-dm-split', quantityScaled: 600000 }],
  });
  assert.equal(first.response.status, 201);

  const second = await createProject({
    name: '拆分项目B',
    allocations: [{ demandMaterialId: 'p3-dm-split', quantityScaled: 400000 }],
  });
  assert.equal(second.response.status, 201);

  const overflow = await createProject({
    name: '超分项目',
    allocations: [{ demandMaterialId: 'p3-dm-split', quantityScaled: 1 }],
  });
  assert.equal(overflow.response.status, 422);
  assert.equal(overflow.body.error.code, 'ALLOCATION_EXCEEDS_REMAINING');

  const total = dbRows("SELECT COALESCE(SUM(quantity_scaled),0) AS total FROM demand_allocations WHERE demand_material_id='p3-dm-split';")[0].total;
  assert.equal(total, 1000000);
});

test('concurrent project creation cannot over-allocate the same demand material', async () => {
  executeLocalD1(stateDir, {
    command: `
      INSERT INTO demands
        (id,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
      SELECT 'p3-d-race','p3-source-race',source_batch_id,source_file_sha256,source_file_name,source_sheet,20,'20',2026,'220kV','220kV','竞态线','#1','防断线',NULL,'p3-sig-race','{}','{}',1,created_by,created_at,updated_at FROM demands WHERE id='p3-d-split';
      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
      VALUES ('p3-dm-race','p3-d-race','JX-01','p3-m-set',1000000,'套','2026-09-12T00:00:00.000Z');
    `,
  });

  const [a, b] = await Promise.all([
    createProject({ name: '并发A', allocations: [{ demandMaterialId: 'p3-dm-race', quantityScaled: 600000 }] }),
    createProject({ name: '并发B', allocations: [{ demandMaterialId: 'p3-dm-race', quantityScaled: 600000 }] }),
  ]);
  const statuses = [a.response.status, b.response.status].sort((x, y) => x - y);
  assert.equal(statuses[0], 201);
  assert.ok([409, 422].includes(statuses[1]));
  const total = dbRows("SELECT COALESCE(SUM(quantity_scaled),0) AS total FROM demand_allocations WHERE demand_material_id='p3-dm-race';")[0].total;
  assert.equal(total, 600000);
});

test('same material model with different units remains separate in project material summary', async () => {
  const created = await createProject({
    name: '单位不可合并',
    allocations: [
      { demandMaterialId: 'p3-dm-set', quantityScaled: 10000 },
      { demandMaterialId: 'p3-dm-each', quantityScaled: 10000 },
    ],
  });
  assert.equal(created.response.status, 201);
  const detail = await jsonRequest(`/api/projects/${created.body.data.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.materialSummary.length, 2);
  assert.deepEqual(detail.body.data.materialSummary.map((item) => item.unit).sort(), ['只', '套']);
  assert.ok(detail.body.data.allocations.every((allocation) => allocation.source.fileName === 'P3合成需求.xlsx'));
});

test('unknown material price is distinct from an explicit zero price', async () => {
  const created = await createProject({
    name: '缺价与零价',
    allocations: [{ demandMaterialId: 'p3-dm-other', quantityScaled: 20000 }],
  });
  assert.equal(created.response.status, 201);
  const project = { id: created.body.data.id, version: created.body.data.version };
  const detail = await jsonRequest(`/api/projects/${project.id}`);
  const allocationId = detail.body.data.allocations[0].id;

  const unknown = await replaceCosts(project, {
    materialPrices: [{ demandAllocationId: allocationId, unitPriceScaled: null, source: null, priceDate: null, taxInclusive: null }],
  });
  assert.equal(unknown.response.status, 200);
  assert.equal(unknown.body.data.knownAmountFen, 0);
  assert.equal(unknown.body.data.missingPriceCount, 1);
  assert.equal(unknown.body.data.completenessBasisPoints, 0);

  const zero = await replaceCosts(project, {
    materialPrices: [{ demandAllocationId: allocationId, unitPriceScaled: 0, source: '明确零价', priceDate: '2026-09-12', taxInclusive: true }],
  });
  assert.equal(zero.response.status, 200);
  assert.equal(zero.body.data.knownAmountFen, 0);
  assert.equal(zero.body.data.missingPriceCount, 0);
  assert.equal(zero.body.data.completenessBasisPoints, 10000);
});

test('estimate uses integer arithmetic and category allocations must conserve every known cost line', async () => {
  const created = await createProject({
    name: '分类金额守恒',
    allocations: [{ demandMaterialId: 'p3-dm-cost', quantityScaled: 20000 }],
  });
  const project = { id: created.body.data.id, version: created.body.data.version };
  let detail = await jsonRequest(`/api/projects/${project.id}`);
  const allocationId = detail.body.data.allocations[0].id;

  const priced = await replaceCosts(project, {
    materialPrices: [{ demandAllocationId: allocationId, unitPriceScaled: 1000000, source: '合成单价', priceDate: '2026-09-12', taxInclusive: true }],
    fixedCosts: [{ kind: 'other', label: '其他费', amountFen: 5000, source: '合成估算', priceDate: '2026-09-12', taxInclusive: true }],
  });
  assert.equal(priced.response.status, 200);
  assert.equal(priced.body.data.knownAmountFen, 25000, '2 units * 100 yuan + 50 yuan = 250 yuan');
  assert.equal(priced.body.data.missingPriceCount, 0);

  const catA = await jsonRequest('/api/reserve-categories', mutation('POST', idem('category'), { key: 'line', label: '防断线' }));
  const catB = await jsonRequest('/api/reserve-categories', mutation('POST', idem('category'), { key: 'bird', label: '防鸟' }));
  assert.equal(catA.response.status, 201);
  assert.equal(catB.response.status, 201);

  detail = await jsonRequest(`/api/projects/${project.id}`);
  const materialLine = detail.body.data.costLines.find((line) => line.kind === 'material');
  const otherLine = detail.body.data.costLines.find((line) => line.kind === 'other');

  const invalid = await jsonRequest(`/api/projects/${project.id}/category-allocations`, mutation('PUT', idem('category-allocation'), {
    expectedVersion: project.version,
    allocations: [
      { costLineId: materialLine.id, reserveCategoryId: catA.body.data.id, amountFen: 19000 },
      { costLineId: otherLine.id, reserveCategoryId: catB.body.data.id, amountFen: 5000 },
    ],
  }));
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.body.error.code, 'CATEGORY_AMOUNT_MISMATCH');
  assert.equal(dbRows(`SELECT COUNT(*) AS count FROM category_cost_allocations WHERE project_id='${project.id}';`)[0].count, 0);

  const classified = await jsonRequest(`/api/projects/${project.id}/category-allocations`, mutation('PUT', idem('category-allocation'), {
    expectedVersion: project.version,
    allocations: [
      { costLineId: materialLine.id, reserveCategoryId: catA.body.data.id, amountFen: 20000 },
      { costLineId: otherLine.id, reserveCategoryId: catA.body.data.id, amountFen: 2000 },
      { costLineId: otherLine.id, reserveCategoryId: catB.body.data.id, amountFen: 3000 },
    ],
  }));
  assert.equal(classified.response.status, 200);
  project.version = classified.body.data.version;
  assert.equal(classified.body.data.classifiedAmountFen, 25000);
  assert.equal(classified.body.data.knownAmountFen, 25000);
  assert.equal(classified.body.data.unclassifiedAmountFen, 0);
  assert.equal(classified.body.data.categories.reduce((sum, item) => sum + item.amountFen, 0), 25000);

  const classifiedDetail = await jsonRequest(`/api/projects/${project.id}`);
  assert.equal(classifiedDetail.body.data.categoryAllocations.length, 3);
  assert.equal(classifiedDetail.body.data.categoryAllocations.reduce((sum, item) => sum + item.amountFen, 0), 25000);
});

test('category mappings are versioned and project detail exposes mapping suggestions', async () => {
  const createdCategory = await jsonRequest('/api/reserve-categories', mutation('POST', idem('category'), { key: 'mapping-line', label: '映射测试类' }));
  assert.equal(createdCategory.response.status, 201);
  const lineCategory = createdCategory.body.data;
  const mapped = await jsonRequest('/api/category-mappings/%E9%98%B2%E6%96%AD%E7%BA%BF', mutation('PUT', idem('mapping'), {
    expectedVersion: null,
    reserveCategoryId: lineCategory.id,
  }));
  assert.equal(mapped.response.status, 200);
  assert.equal(mapped.body.data.version, 1);

  const stale = await jsonRequest('/api/category-mappings/%E9%98%B2%E6%96%AD%E7%BA%BF', mutation('PUT', idem('mapping'), {
    expectedVersion: null,
    reserveCategoryId: lineCategory.id,
  }));
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
});

test('confirming a reserve preserves immutable history and later revisions create a new reserve version', async () => {
  const created = await createProject({
    name: '版本化储备',
    allocations: [{ demandMaterialId: 'p3-dm-version', quantityScaled: 10000 }],
  });
  const project = { id: created.body.data.id, version: created.body.data.version };
  const firstConfirm = await jsonRequest(`/api/projects/${project.id}/confirm`, mutation('POST', idem('confirm'), {
    expectedVersion: project.version,
    reason: '首次确认',
  }));
  assert.equal(firstConfirm.response.status, 200);
  assert.equal(firstConfirm.body.data.reserveVersion, 1);
  project.version = firstConfirm.body.data.version;

  const revisedCosts = await replaceCosts(project, {
    fixedCosts: [{ kind: 'construction', label: '施工费', amountFen: 12345, source: '合成', priceDate: '2026-09-12', taxInclusive: true }],
  });
  assert.equal(revisedCosts.response.status, 200);
  const secondConfirm = await jsonRequest(`/api/projects/${project.id}/confirm`, mutation('POST', idem('confirm'), {
    expectedVersion: project.version,
    reason: '补充施工费',
  }));
  assert.equal(secondConfirm.response.status, 200);
  assert.equal(secondConfirm.body.data.reserveVersion, 2);

  const history = await jsonRequest(`/api/projects/${project.id}/history`);
  assert.equal(history.response.status, 200);
  assert.deepEqual(history.body.data.items.map((item) => item.reserveVersion), [2, 1]);
  assert.equal(history.body.data.items[0].reason, '补充施工费');
  assert.equal(history.body.data.items[1].reason, '首次确认');
});

test('replacing project allocations releases quantity, advances version, and rejects stale writes atomically', async () => {
  const created = await createProject({
    name: '调整分配',
    allocations: [{ demandMaterialId: 'p3-dm-revise', quantityScaled: 60000 }],
  });
  assert.equal(created.response.status, 201);
  const project = { id: created.body.data.id, version: created.body.data.version };

  const key = idem('replace-allocations');
  const body = { expectedVersion: project.version, allocations: [{ demandMaterialId: 'p3-dm-revise', quantityScaled: 40000 }] };
  const replaced = await jsonRequest(`/api/projects/${project.id}/allocations`, mutation('PUT', key, body));
  assert.equal(replaced.response.status, 200);
  assert.equal(replaced.body.data.version, 2);

  const replay = await jsonRequest(`/api/projects/${project.id}/allocations`, mutation('PUT', key, body));
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, replaced.body);

  const stale = await jsonRequest(`/api/projects/${project.id}/allocations`, mutation('PUT', idem('stale-allocation'), {
    expectedVersion: 1,
    allocations: [{ demandMaterialId: 'p3-dm-revise', quantityScaled: 90000 }],
  }));
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal(dbRows(`SELECT quantity_scaled FROM demand_allocations WHERE project_id='${project.id}';`)[0].quantity_scaled, 40000);

  const candidates = await jsonRequest('/api/projects/candidates?limit=100');
  const candidate = candidates.body.data.items.find((item) => item.demandMaterialId === 'p3-dm-revise');
  assert.equal(candidate.remainingQuantityScaled, 60000);
});

test('category mapping becomes the suggested category on mapped material cost lines', async () => {
  const category = await jsonRequest('/api/reserve-categories', mutation('POST', idem('category'), { key: 'suggested-line', label: '建议防断线' }));
  assert.equal(category.response.status, 201);
  const mapping = await jsonRequest('/api/category-mappings/%E9%98%B2%E6%96%AD%E7%BA%BF', mutation('PUT', idem('mapping'), {
    expectedVersion: 1,
    reserveCategoryId: category.body.data.id,
  }));
  assert.equal(mapping.response.status, 200);

  const created = await createProject({
    name: '分类建议',
    allocations: [{ demandMaterialId: 'p3-dm-mapping', quantityScaled: 10000 }],
  });
  assert.equal(created.response.status, 201);
  const project = { id: created.body.data.id, version: created.body.data.version };
  const detail = await jsonRequest(`/api/projects/${project.id}`);
  const allocationId = detail.body.data.allocations[0].id;
  const costs = await replaceCosts(project, {
    materialPrices: [{ demandAllocationId: allocationId, unitPriceScaled: 100000, source: null, priceDate: null, taxInclusive: null }],
  });
  assert.equal(costs.response.status, 200);
  const after = await jsonRequest(`/api/projects/${project.id}`);
  assert.equal(after.body.data.costLines[0].suggestedReserveCategoryId, category.body.data.id);
});

test('material estimate rounds exact scaled arithmetic to the nearest fen without floating accumulation', async () => {
  const created = await createProject({
    name: '精确舍入',
    allocations: [{ demandMaterialId: 'p3-dm-round', quantityScaled: 12500 }],
  });
  assert.equal(created.response.status, 201);
  const project = { id: created.body.data.id, version: created.body.data.version };
  const detail = await jsonRequest(`/api/projects/${project.id}`);
  const allocationId = detail.body.data.allocations[0].id;
  const costs = await replaceCosts(project, {
    materialPrices: [{ demandAllocationId: allocationId, unitPriceScaled: 33333, source: null, priceDate: null, taxInclusive: null }],
  });
  assert.equal(costs.response.status, 200);
  assert.equal(costs.body.data.knownAmountFen, 417);
});

test('project estimate rejects fixed-cost totals outside the JavaScript safe-integer range', async () => {
  const created = await createProject({
    name: '金额边界',
    allocations: [{ demandMaterialId: 'p3-dm-overflow', quantityScaled: 10000 }],
  });
  assert.equal(created.response.status, 201);
  const project = { id: created.body.data.id, version: created.body.data.version };
  const overflow = await replaceCosts(project, {
    fixedCosts: [
      { kind: 'construction', label: '施工费', amountFen: Number.MAX_SAFE_INTEGER, source: null, priceDate: null, taxInclusive: null },
      { kind: 'other', label: '其他费', amountFen: Number.MAX_SAFE_INTEGER, source: null, priceDate: null, taxInclusive: null },
    ],
  });
  assert.equal(overflow.response.status, 422);
  assert.equal(overflow.body.error.code, 'AMOUNT_OVERFLOW');
});

test('candidate pool paginates beyond 100 rows without gaps and grouping counts the full remaining pool', async () => {
  executeLocalD1(stateDir, {
    command: `
      WITH RECURSIVE seq(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM seq WHERE n < 105
      )
      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
      SELECT printf('p3-page-%03d', n),'p3-d-other','PAGE-MODEL',NULL,10000,'套','2026-09-12T00:00:00.000Z'
      FROM seq;
    `,
  });

  const collected = [];
  let cursor = null;
  for (let page = 0; page < 4; page += 1) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const result = await jsonRequest(`/api/projects/candidates?limit=100${suffix}`);
    assert.equal(result.response.status, 200);
    assert.ok(result.body.data.items.length <= 100);
    collected.push(...result.body.data.items.filter((item) => item.demandMaterialId.startsWith('p3-page-')).map((item) => item.demandMaterialId));
    cursor = result.body.data.nextCursor;
    if (!cursor) break;
  }
  assert.equal(collected.length, 105);
  assert.equal(new Set(collected).size, 105, '游标分页不得重复或遗漏待分配需求物资');
  assert.equal(cursor, null);

  const invalid = await jsonRequest('/api/projects/candidates?limit=100&cursor=not-a-valid-cursor');
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_CURSOR');

  const suggestions = await jsonRequest('/api/projects/suggestions?limit=100');
  assert.equal(suggestions.response.status, 200);
  const group = suggestions.body.data.items.find((item) =>
    item.year === 2026 && item.category === '防鸟' && item.voltage === '110kV' && item.lineName === '江北线',
  );
  assert.ok(group);
  assert.ok(group.itemCount >= 105, '归并建议必须统计完整剩余池，而不是只统计候选第一页');
});

test('readonly members may inspect reserves but cannot mutate them', async () => {
  const list = await jsonRequest('/api/projects?limit=10', {}, readonlyCookie);
  assert.equal(list.response.status, 200);

  const denied = await jsonRequest('/api/projects', mutation('POST', idem('readonly-project'), {
    name: '只读越权', year: 2026, owner: null,
    allocations: [{ demandMaterialId: 'p3-dm-set', quantityScaled: 1 }],
  }), readonlyCookie);
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN');
});
