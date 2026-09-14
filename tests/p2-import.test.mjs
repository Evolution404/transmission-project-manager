import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, executeLocalD1, makeStateDir, startWranglerServer } from './helpers/wrangler.mjs';
import {
  bootstrapAdmin,
  cookiePair,
  createMember,
  fixedCredential,
  fixedSalt,
  loginWithCredential,
} from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-p2-import-');
let runtime;
let adminCookie;
let readonlyCookie;
let manualLineId;
let manualTower1;
let manualTower2;
let manualTower3;

const mapping = {
  sequenceNo: '序号',
  voltage: '电压等级',
  lineName: '线路名称',
  section: '杆段',
  materialModel: '物资型号',
  materialQuantity: '物资数量',
  unit: '单位',
  year: '年度',
  category: '类别',
};

function idem(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function jsonRequest(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (adminCookie && !headers.has('Cookie')) headers.set('Cookie', adminCookie);
  const response = await runtime.request(path, { ...init, headers });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function mutation(method, key, body, headers = {}) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
    body: JSON.stringify(body),
  };
}

async function createBatch({ fileName = '需求.xlsx', fileSha256 = 'a'.repeat(64), fileType = 'xlsx' } = {}) {
  const result = await jsonRequest('/api/imports', mutation('POST', idem('batch'), { fileName, fileSha256, fileType, mapping }));
  result.currentVersion = result.body?.data?.version ?? null;
  return result;
}

async function uploadChunk(batch, rows, chunkIndex = 0, expectedVersion = batch.currentVersion) {
  const result = await jsonRequest(`/api/imports/${batch.body.data.id}/chunks`, mutation('POST', idem('chunk'), {
    expectedVersion,
    chunkIndex,
    rows,
  }));
  if (result.response.ok && result.body?.data?.version) batch.currentVersion = result.body.data.version;
  return result;
}

async function validateBatch(batch, expectedVersion = batch.currentVersion) {
  const result = await jsonRequest(`/api/imports/${batch.body.data.id}/validate`, mutation('POST', idem('validate'), { expectedVersion }));
  if (result.response.ok && result.body?.data?.version) batch.currentVersion = result.body.data.version;
  return result;
}

async function publishBatch(batch, limit = 20, expectedVersion = batch.currentVersion) {
  const result = await jsonRequest(`/api/imports/${batch.body.data.id}/publish`, mutation('POST', idem('publish'), { expectedVersion, limit }));
  if (result.response.ok && result.body?.data?.version) batch.currentVersion = result.body.data.version;
  return result;
}

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8803,
    seed: false,
    migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:p2-test-pepper', 'BOOTSTRAP_TOKEN:p2-test-bootstrap'],
  });
  const bootstrap = await bootstrapAdmin(runtime, {
    token: 'p2-test-bootstrap',
    username: 'p2-admin',
    displayName: 'P2 测试管理员',
    salt: fixedSalt(21),
    credential: fixedCredential(21),
  });
  assert.equal(bootstrap.response.status, 201);
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));

  const line = await jsonRequest('/api/master/lines', mutation('POST', idem('master-line'), {
    voltageLevelId: 'vl-ac-220', lineName: '手工需求线', lineCode: 'MANUAL-220', enabled: true,
  }));
  assert.equal(line.response.status, 201);
  manualLineId = line.body.data.id;
  const createdTowers = [];
  for (const [towerNo, sortRank] of [['1', 1000], ['2', 2000], ['3', 3000]]) {
    const tower = await jsonRequest('/api/master/towers', mutation('POST', idem(`master-tower-${sortRank}`), {
      lineId: manualLineId, towerNo, sortRank, towerType: '测试塔', enabled: true,
    }));
    assert.equal(tower.response.status, 201);
    createdTowers.push(tower.body.data.id);
  }
  [manualTower1, manualTower2, manualTower3] = createdTowers;

  async function createGridLine(voltageLevelId, lineName, towerNos) {
    const lineResult = await jsonRequest('/api/master/lines', mutation('POST', idem('grid-line'), {
      voltageLevelId, lineName, lineCode: null, enabled: true,
    }));
    assert.equal(lineResult.response.status, 201);
    for (const [index, towerNo] of towerNos.entries()) {
      const tower = await jsonRequest('/api/master/towers', mutation('POST', idem(`grid-tower-${index}`), {
        lineId: lineResult.body.data.id, towerNo, sortRank: (index + 1) * 1000, towerType: '测试塔', enabled: true,
      }));
      assert.equal(tower.response.status, 201);
    }
  }
  await createGridLine('vl-ac-220', '导入测试线', ['#1', '#2', '#3', '#4', '#10', '#11', '#20']);
  await createGridLine('vl-ac-110', '江北线', ['#1', '#2', '#3', '#20']);

  const readonly = await createMember(runtime, adminCookie, {
    username: 'p2-readonly',
    displayName: 'P2 只读成员',
    salt: fixedSalt(22),
    credential: fixedCredential(22),
    role: 'readonly',
    scopes: [{ type: 'all', id: null }],
  });
  assert.equal(readonly.response.status, 201);
  executeLocalD1(stateDir, { command: "UPDATE members SET must_change_password=0 WHERE username='p2-readonly'" });
  const login = await loginWithCredential(runtime, 'p2-readonly', fixedCredential(22));
  assert.equal(login.response.status, 200);
  readonlyCookie = cookiePair(login.response.headers.get('set-cookie'));
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('mapping templates can be saved and reused without trusting client-only state', async () => {
  const key = idem('mapping');
  const created = await jsonRequest('/api/import-mappings', mutation('POST', key, {
    name: '标准需求表',
    mapping,
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.name, '标准需求表');
  assert.deepEqual(created.body.data.mapping, mapping);
  assert.equal(created.body.data.version, 1);

  const replay = await jsonRequest('/api/import-mappings', mutation('POST', key, {
    name: '标准需求表',
    mapping,
  }));
  assert.equal(replay.response.status, 201);
  assert.deepEqual(replay.body, created.body);

  const duplicate = await jsonRequest('/api/import-mappings', mutation('POST', idem('mapping'), {
    name: '标准需求表', mapping,
  }));
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'MAPPING_TEMPLATE_EXISTS');

  const list = await jsonRequest('/api/import-mappings');
  assert.equal(list.response.status, 200);
  assert.ok(list.body.data.items.some((item) => item.name === '标准需求表' && item.mapping.lineName === '线路名称'));
});

test('material dictionary distinguishes same model with different units and rejects exact duplicates', async () => {
  const first = await jsonRequest('/api/materials', mutation('POST', idem('material'), {
    code: 'M-JX01-SET', name: '测试物资', model: 'JX-01', unit: '套',
  }));
  assert.equal(first.response.status, 201);

  const otherUnit = await jsonRequest('/api/materials', mutation('POST', idem('material'), {
    code: 'M-JX01-EACH', name: '测试物资', model: 'JX-01', unit: '只',
  }));
  assert.equal(otherUnit.response.status, 201);
  assert.notEqual(first.body.data.id, otherUnit.body.data.id);

  const duplicate = await jsonRequest('/api/materials', mutation('POST', idem('material'), {
    name: '重复', model: 'JX-01', unit: '套',
  }));
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'MATERIAL_EXISTS');
});

test('manual demand creation is available alongside batch import and keeps a real manual source', async () => {
  const created = await jsonRequest('/api/demands', mutation('POST', idem('manual-demand'), {
    sequenceNo: 'M-001',
    voltageLevelId: 'vl-ac-220',
    lineId: manualLineId,
    locationType: 'tower_range',
    startTowerId: manualTower1,
    endTowerId: manualTower2,
    materials: [{ rawModel: 'JX-01', quantityScaled: 25000, unit: '套' }],
    year: 2026,
    category: '临时补充',
    owner: '张三',
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.sequenceNo, 'M-001');
  assert.equal(created.body.data.source.type, 'manual');
  assert.equal(created.body.data.source.fileName, undefined);
  assert.equal(created.body.data.materials[0].quantityScaled, 25000);

  const detail = await jsonRequest(`/api/demands/${created.body.data.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.source.type, 'manual');
  assert.equal(detail.body.data.source.batchId, undefined);
  assert.equal(detail.body.data.materials[0].rawModel, 'JX-01');

  const invalid = await jsonRequest('/api/demands', mutation('POST', idem('manual-demand-invalid'), {
    sequenceNo: 'M-002', voltageLevelId: 'vl-ac-220', lineId: manualLineId, locationType: 'tower', startTowerId: manualTower3,
    materials: [{ rawModel: 'JX-01', quantityScaled: -10000, unit: '套' }], year: 2026,
  }));
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.body.error.code, 'INVALID_DEMAND');
});

test('import normalizes repeated business rows into one abstract demand with multiple material children, and also accepts a demand with no material', async () => {
  const batch = await createBatch({ fileName: '抽象需求归并.xlsx', fileSha256: '9'.repeat(64) });
  assert.equal(batch.response.status, 201);
  const uploaded = await uploadChunk(batch, [
    {
      sheetName: '需求', rowNumber: 2,
      cells: { 序号: 'G-001', 年度: 2026, 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#1-#2', 类别: '防鸟治理', 物资型号: 'A', 物资数量: 8, 单位: '套' },
    },
    {
      sheetName: '需求', rowNumber: 3,
      cells: { 序号: 'G-001', 年度: 2026, 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#1-#2', 类别: '防鸟治理', 物资型号: 'B', 物资数量: 2, 单位: '只' },
    },
    {
      sheetName: '需求', rowNumber: 4,
      cells: { 序号: 'G-002', 年度: 2026, 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#3-#4', 类别: '通道治理', 物资型号: '', 物资数量: '', 单位: '' },
    },
  ]);
  assert.equal(uploaded.response.status, 200);
  const validated = await validateBatch(batch);
  assert.equal(validated.response.status, 200);
  assert.equal(validated.body.data.errorRows, 0);
  assert.equal(validated.body.data.validRows, 3);
  const published = await publishBatch(batch, 10);
  assert.equal(published.response.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.data.done, true);

  const list = await jsonRequest('/api/demands?query=G-00&limit=20');
  assert.equal(list.response.status, 200);
  const grouped = list.body.data.items.filter((item) => item.sequenceNo === 'G-001');
  const noMaterial = list.body.data.items.filter((item) => item.sequenceNo === 'G-002');
  assert.equal(grouped.length, 1, '同一批次中相同业务需求的多行物资必须归到一个抽象需求');
  assert.equal(noMaterial.length, 1);

  const groupedDetail = await jsonRequest(`/api/demands/${grouped[0].id}`);
  assert.equal(groupedDetail.response.status, 200);
  assert.deepEqual(groupedDetail.body.data.materials.map((item) => item.rawModel).sort(), ['A', 'B']);
  assert.equal(groupedDetail.body.data.source.type, 'import');
  assert.equal(groupedDetail.body.data.source.rows.length, 2, '两条源 Excel 行都必须可追溯');

  const noMaterialDetail = await jsonRequest(`/api/demands/${noMaterial[0].id}`);
  assert.equal(noMaterialDetail.response.status, 200);
  assert.deepEqual(noMaterialDetail.body.data.materials, []);
  assert.equal(noMaterialDetail.body.data.source.rows.length, 1);
});

test('stale import batch versions fail atomically without leaving uploaded rows', async () => {
  const batch = await createBatch({ fileSha256: '6'.repeat(64) });
  assert.equal(batch.response.status, 201);
  const stale = await uploadChunk(batch, [{
    sheetName: '需求', rowNumber: 2,
    cells: { 序号: 1, 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#1', 物资型号: 'JX-01', 物资数量: 1, 单位: '套' },
  }], 0, batch.currentVersion + 1);
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

  const detail = await jsonRequest(`/api/imports/${batch.body.data.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.uploadedRows, 0);
  assert.equal(detail.body.data.rows.length, 0, '版本冲突不能留下半批源行');
});

test('a clean import validates, publishes resumably, and produces traceable paginated demands', async () => {
  const batch = await createBatch();
  assert.equal(batch.response.status, 201);
  assert.equal(batch.body.data.status, 'draft');

  const rows = [
    {
      sheetName: '需求', rowNumber: 2,
      cells: { 序号: 1, 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#10-#11', 物资型号: 'JX-01', 物资数量: 2, 单位: '套', 年度: 2026, 类别: '防断线' },
    },
    {
      sheetName: '需求', rowNumber: 3,
      cells: { 序号: 2, 电压等级: '110kV', 线路名称: '江北线', 杆段: '#20', 物资型号: 'JX-01', 物资数量: 1.25, 单位: '套', 年度: 2026, 类别: '防断线' },
    },
  ];
  const chunkKey = idem('chunk');
  const chunkBody = { expectedVersion: batch.currentVersion, chunkIndex: 0, rows };
  const uploaded = await jsonRequest(`/api/imports/${batch.body.data.id}/chunks`, mutation('POST', chunkKey, chunkBody));
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.body.data.uploadedRows, 2);
  assert.equal(uploaded.body.data.version, batch.currentVersion + 1);
  batch.currentVersion = uploaded.body.data.version;

  const replay = await jsonRequest(`/api/imports/${batch.body.data.id}/chunks`, mutation('POST', chunkKey, chunkBody));
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, uploaded.body);

  const validated = await validateBatch(batch);
  assert.equal(validated.response.status, 200);
  assert.equal(validated.body.data.status, 'ready');
  assert.equal(validated.body.data.errorRows, 0);
  assert.equal(validated.body.data.validRows, 2);

  const firstPublishKey = idem('publish');
  const firstPublishBody = { expectedVersion: batch.currentVersion, limit: 1 };
  const firstPublish = await jsonRequest(`/api/imports/${batch.body.data.id}/publish`, mutation('POST', firstPublishKey, firstPublishBody));
  assert.equal(firstPublish.response.status, 200);
  assert.equal(firstPublish.body.data.processed, 1);
  assert.equal(firstPublish.body.data.done, false);
  batch.currentVersion = firstPublish.body.data.version;

  const publishReplay = await jsonRequest(`/api/imports/${batch.body.data.id}/publish`, mutation('POST', firstPublishKey, firstPublishBody));
  assert.deepEqual(publishReplay.body, firstPublish.body);

  const secondPublish = await publishBatch(batch, 20);
  assert.equal(secondPublish.response.status, 200);
  assert.equal(secondPublish.body.data.done, true);
  assert.equal(secondPublish.body.data.publishedRows, 2);

  const firstPage = await jsonRequest('/api/demands?limit=1');
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.data.items.length, 1);
  assert.ok(firstPage.body.data.nextCursor);

  const secondPage = await jsonRequest(`/api/demands?limit=1&cursor=${encodeURIComponent(firstPage.body.data.nextCursor)}`);
  assert.equal(secondPage.response.status, 200);
  assert.equal(secondPage.body.data.items.length, 1);
  assert.notEqual(secondPage.body.data.items[0].id, firstPage.body.data.items[0].id);

  const detail = await jsonRequest(`/api/demands/${firstPage.body.data.items[0].id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.source.fileSha256, 'a'.repeat(64));
  assert.equal(detail.body.data.source.sheetName, '需求');
  assert.ok([2, 3].includes(detail.body.data.source.rowNumber));
  assert.equal(detail.body.data.materials.length, 1);
  assert.equal(detail.body.data.materials[0].material.model, 'JX-01');
});

test('validation classifies blocking errors separately from warnings and never publishes invalid rows', async () => {
  const batch = await createBatch({ fileSha256: 'b'.repeat(64) });
  assert.equal(batch.response.status, 201);

  const rows = [
    {
      sheetName: '需求', rowNumber: 2,
      cells: { 序号: 1, 电压等级: '220kV', 线路名称: '', 杆段: '#1', 物资型号: 'UNKNOWN', 物资数量: 1, 单位: '套', 年度: 2026 },
    },
    {
      sheetName: '需求', rowNumber: 3,
      cells: { 序号: 2, 电压等级: '无法核实', 线路名称: '线路B', 杆段: '#2', 物资型号: 'UNKNOWN', 物资数量: -1, 单位: '套', 年度: 2026 },
    },
    {
      sheetName: '需求', rowNumber: 4,
      cells: { 序号: 3, 电压等级: '110kV', 线路名称: '江北线', 杆段: '#3', 物资型号: 'UNKNOWN', 物资数量: 1.23456, 单位: '套', 年度: 2026 },
    },
  ];
  const upload = await uploadChunk(batch, rows);
  assert.equal(upload.response.status, 200);

  const validated = await validateBatch(batch);
  assert.equal(validated.response.status, 200);
  assert.equal(validated.body.data.status, 'review');
  assert.equal(validated.body.data.errorRows, 3);
  assert.ok(validated.body.data.warningRows >= 1);

  const detail = await jsonRequest(`/api/imports/${batch.body.data.id}`);
  const codes = detail.body.data.rows.flatMap((row) => [
    ...(row.errors ?? []).map((error) => error.code),
    ...(row.warnings ?? []).map((warning) => warning.code),
  ]);
  assert.ok(codes.includes('REQUIRED_FIELD'));
  assert.ok(codes.includes('QUANTITY_NEGATIVE'));
  assert.ok(codes.includes('QUANTITY_PRECISION'));
  assert.ok(codes.includes('MATERIAL_UNRESOLVED'));
  assert.ok(codes.includes('VOLTAGE_LEVEL_UNKNOWN'));

  const publish = await publishBatch(batch, 20);
  assert.equal(publish.response.status, 422);
  assert.equal(publish.body.error.code, 'IMPORT_NOT_READY');
});

test('unknown material is a warning, not zero-price or silent success, and can still be published', async () => {
  const batch = await createBatch({ fileSha256: 'c'.repeat(64) });
  const rows = [{
    sheetName: '需求', rowNumber: 2,
    cells: { 序号: 1, 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#1', 物资型号: 'NOT-MAPPED', 物资数量: 1, 单位: '套', 年度: 2026 },
  }];
  await uploadChunk(batch, rows);
  const validated = await validateBatch(batch);
  assert.equal(validated.body.data.status, 'ready');
  assert.equal(validated.body.data.errorRows, 0);
  assert.equal(validated.body.data.warningRows, 1);

  const detail = await jsonRequest(`/api/imports/${batch.body.data.id}`);
  assert.equal(detail.body.data.rows[0].warnings[0].code, 'MATERIAL_UNRESOLVED');
  assert.equal(detail.body.data.rows[0].normalized.materialId, null);

  const publish = await publishBatch(batch, 20);
  assert.equal(publish.response.status, 200);
  assert.equal(publish.body.data.done, true);
});

test('same file hash reuses the existing batch, while same business text from a different source is not auto-deduplicated', async () => {
  const first = await createBatch({ fileSha256: 'd'.repeat(64) });
  assert.equal(first.response.status, 201);
  const repeatedFile = await createBatch({ fileName: 'copy.xlsx', fileSha256: 'd'.repeat(64) });
  assert.equal(repeatedFile.response.status, 200);
  assert.equal(repeatedFile.body.data.id, first.body.data.id);
  assert.equal(repeatedFile.body.data.reused, true);

  const sourceOne = await createBatch({ fileSha256: 'e'.repeat(64) });
  const row = {
    sheetName: '需求', rowNumber: 2,
    cells: { 序号: 99, 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#1', 物资型号: 'JX-01', 物资数量: 1, 单位: '套', 年度: 2026 },
  };
  await uploadChunk(sourceOne, [row]);
  await validateBatch(sourceOne);
  await publishBatch(sourceOne, 20);

  const sourceTwo = await createBatch({ fileSha256: 'f'.repeat(64) });
  await uploadChunk(sourceTwo, [row]);
  const validation = await validateBatch(sourceTwo);
  assert.equal(validation.response.status, 200);
  assert.equal(validation.body.data.status, 'ready');
  const secondDetail = await jsonRequest(`/api/imports/${sourceTwo.body.data.id}`);
  assert.ok(secondDetail.body.data.rows[0].warnings.some((warning) => warning.code === 'POSSIBLE_DUPLICATE'));
  const secondPublish = await publishBatch(sourceTwo, 20);
  assert.equal(secondPublish.response.status, 200);

  const search = await jsonRequest('/api/demands?query=99&limit=10');
  assert.equal(search.response.status, 200);
  assert.equal(search.body.data.items.length, 2, '不同来源的合法相同需求不得被字符串自动去重');
});

test('concurrent chunk uploads cannot commit rows from a request that loses the batch version race', async () => {
  const batch = await createBatch({ fileSha256: '8'.repeat(64) });
  assert.equal(batch.response.status, 201);
  const makeRow = (rowNumber, lineName) => ({
    sheetName: '需求', rowNumber,
    cells: { 序号: rowNumber, 电压等级: '220kV', 线路名称: lineName, 杆段: '#1', 物资型号: 'JX-01', 物资数量: 1, 单位: '套' },
  });
  const expectedVersion = batch.currentVersion;
  const [first, second] = await Promise.all([
    jsonRequest(`/api/imports/${batch.body.data.id}/chunks`, mutation('POST', idem('race-chunk'), { expectedVersion, chunkIndex: 0, rows: [makeRow(2, '并发A')] })),
    jsonRequest(`/api/imports/${batch.body.data.id}/chunks`, mutation('POST', idem('race-chunk'), { expectedVersion, chunkIndex: 1, rows: [makeRow(3, '并发B')] })),
  ]);
  const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const detail = await jsonRequest(`/api/imports/${batch.body.data.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.uploadedRows, 1);
  assert.equal(detail.body.data.rows.length, 1, '丢失版本竞争的分片不得留下源行');
});

test('concurrent validation calls serialize on the batch version instead of both reporting success', async () => {
  const batch = await createBatch({ fileSha256: '7'.repeat(64) });
  const rows = Array.from({ length: 20 }, (_, index) => ({
    sheetName: '需求', rowNumber: index + 2,
    cells: { 序号: `VALIDATE-${index + 1}`, 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#1', 物资型号: 'JX-01', 物资数量: 1, 单位: '套' },
  }));
  const upload = await uploadChunk(batch, rows);
  assert.equal(upload.response.status, 200);

  const expectedVersion = batch.currentVersion;
  const [first, second] = await Promise.all([
    jsonRequest(`/api/imports/${batch.body.data.id}/validate`, mutation('POST', idem('race-validate'), { expectedVersion })),
    jsonRequest(`/api/imports/${batch.body.data.id}/validate`, mutation('POST', idem('race-validate'), { expectedVersion })),
  ]);
  const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const detail = await jsonRequest(`/api/imports/${batch.body.data.id}`);
  assert.equal(detail.body.data.validRows, 20);
  assert.equal(detail.body.data.rows.filter((row) => row.status === 'valid').length, 20);
});

test('concurrent publish calls cannot leave duplicate or half-published demand data', async () => {
  const batch = await createBatch({ fileSha256: '5'.repeat(64) });
  const rows = [
    {
      sheetName: '需求', rowNumber: 2,
      cells: { 序号: 'RACE-PUB-1', 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#1', 物资型号: 'JX-01', 物资数量: 1, 单位: '套' },
    },
    {
      sheetName: '需求', rowNumber: 3,
      cells: { 序号: 'RACE-PUB-2', 电压等级: '220kV', 线路名称: '导入测试线', 杆段: '#2', 物资型号: 'JX-01', 物资数量: 1, 单位: '套' },
    },
  ];
  await uploadChunk(batch, rows);
  await validateBatch(batch);
  const expectedVersion = batch.currentVersion;

  const [first, second] = await Promise.all([
    jsonRequest(`/api/imports/${batch.body.data.id}/publish`, mutation('POST', idem('race-publish'), { expectedVersion, limit: 1 })),
    jsonRequest(`/api/imports/${batch.body.data.id}/publish`, mutation('POST', idem('race-publish'), { expectedVersion, limit: 1 })),
  ]);
  const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);

  const detail = await jsonRequest(`/api/imports/${batch.body.data.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.publishedRows, 1);
  assert.equal(detail.body.data.rows.filter((row) => row.status === 'published').length, 1);
  assert.equal(detail.body.data.rows.filter((row) => row.status === 'valid').length, 1);

  const demands = await jsonRequest('/api/demands?query=RACE-PUB-&limit=10');
  assert.equal(demands.response.status, 200);
  assert.equal(demands.body.data.items.length, 1, '失败的并发发布不能留下额外需求');
});

test('chunk size, idempotency payload conflicts, pagination limits and write roles are enforced', async () => {
  const batch = await createBatch({ fileSha256: '9'.repeat(64) });
  const tooManyRows = Array.from({ length: 21 }, (_, index) => ({
    sheetName: '需求', rowNumber: index + 2,
    cells: { 序号: index + 1, 电压等级: '220kV', 线路名称: `线${index}`, 杆段: '#1', 物资型号: 'JX-01', 物资数量: 1, 单位: '套' },
  }));
  const tooLarge = await jsonRequest(`/api/imports/${batch.body.data.id}/chunks`, mutation('POST', idem('chunk'), { expectedVersion: batch.currentVersion, chunkIndex: 0, rows: tooManyRows }));
  assert.equal(tooLarge.response.status, 422);
  assert.equal(tooLarge.body.error.code, 'IMPORT_CHUNK_TOO_LARGE');

  const key = idem('conflict');
  const first = await jsonRequest('/api/imports', mutation('POST', key, {
    fileName: 'one.xlsx', fileSha256: '1'.repeat(64), fileType: 'xlsx', mapping,
  }));
  assert.equal(first.response.status, 201);
  const conflict = await jsonRequest('/api/imports', mutation('POST', key, {
    fileName: 'two.xlsx', fileSha256: '2'.repeat(64), fileType: 'xlsx', mapping,
  }));
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const oversizedPage = await jsonRequest('/api/demands?limit=101');
  assert.equal(oversizedPage.response.status, 400);
  assert.equal(oversizedPage.body.error.code, 'INVALID_PAGE_LIMIT');

  const readonlyCreate = await jsonRequest('/api/imports', mutation('POST', idem('readonly'), {
    fileName: 'readonly.xlsx', fileSha256: '3'.repeat(64), fileType: 'xlsx', mapping,
  }, { Cookie: readonlyCookie }));
  assert.equal(readonlyCreate.response.status, 403);
  assert.equal(readonlyCreate.body.error.code, 'FORBIDDEN');
});

test('unknown grid objects block publication and are never created by import', async () => {
  for (const [voltage, line, section, code] of [
    ['999kV', '未维护线路', '#1', 'VOLTAGE_LEVEL_UNKNOWN'],
    ['220kV', '未维护线路', '#1', 'LINE_UNKNOWN'],
    ['220kV', '手工需求线', '#MISSING', 'TOWER_NUMBER_INVALID'],
  ]) {
    const batch = await createBatch({ fileSha256: crypto.randomUUID().replaceAll('-', '').repeat(2) });
    await uploadChunk(batch, [{ sheetName: '需求', rowNumber: 2, cells: { 序号: 'UNKNOWN', 电压等级: voltage, 线路名称: line, 杆段: section } }]);
    await validateBatch(batch);
    const detail = await jsonRequest(`/api/imports/${batch.body.data.id}`);
    assert.ok(detail.body.data.rows[0].errors.some((e) => e.code === code));
    assert.equal((await publishBatch(batch)).response.status, 422);
  }
  assert.ok(!(await jsonRequest('/api/master/lines')).body.data.items.some((l) => l.lineName === '未维护线路'));
});

test('publication revalidates an already validated location after master data is disabled', async () => {
  const batch = await createBatch({ fileSha256: crypto.randomUUID().replaceAll('-', '').repeat(2) });
  await uploadChunk(batch, [{ sheetName: '需求', rowNumber: 2, cells: { 序号: 'STALE-GRID', 电压等级: '220kV', 线路名称: '手工需求线', 杆段: '#1-#2' } }]);
  const validated = await validateBatch(batch);
  assert.equal(validated.response.status, 200);
  const line = (await jsonRequest('/api/master/lines')).body.data.items.find((l) => l.id === manualLineId);
  assert.equal((await jsonRequest(`/api/master/lines/${line.id}`, mutation('PATCH', idem('disable-before-publish'), { ...line, enabled: false, expectedVersion: line.version }))).response.status, 200);
  const result = await publishBatch(batch);
  assert.equal(result.response.status, 422);
  assert.equal(result.body.error.code, 'IMPORT_GRID_CHANGED');
  assert.ok(result.body.error.details.some((e) => e.rowNumber === 2));
  assert.equal((await jsonRequest('/api/demands?query=STALE-GRID')).body.data.items.length, 0);
});
