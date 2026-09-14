import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, queryLocalD1, executeLocalD1, makeStateDir, startWranglerServer } from './helpers/wrangler.mjs';
import { bootstrapAdmin, cookiePair, createMember, fixedCredential, fixedSalt, loginWithCredential } from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-master-data-');
let runtime;
let adminCookie;
let managerCookie;
let lineA;
let lineB;
let towerA10;
let towerA20;
let towerB10;

function idem(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function jsonRequest(path, init = {}, cookie = adminCookie) {
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('Cookie', cookie);
  const response = await runtime.request(path, { ...init, headers });
  let body = null;
  try { body = await response.json(); } catch { /* non JSON */ }
  return { response, body };
}

function mutation(method, key, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  };
}

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8817,
    migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:master-data-pepper', 'BOOTSTRAP_TOKEN:master-data-bootstrap'],
  });
  const bootstrap = await bootstrapAdmin(runtime, { token: 'master-data-bootstrap' });
  assert.equal(bootstrap.response.status, 201);
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));

  const manager = await createMember(runtime, adminCookie, {
    username: 'master-manager',
    displayName: '台账测试项目经理',
    salt: fixedSalt(71),
    credential: fixedCredential(71),
    role: 'project_manager',
    scopes: [{ type: 'all', id: null }],
  });
  assert.equal(manager.response.status, 201);
  executeLocalD1(stateDir, { command: "UPDATE members SET must_change_password=0 WHERE username='master-manager'" });
  const managerLogin = await loginWithCredential(runtime, 'master-manager', fixedCredential(71));
  assert.equal(managerLogin.response.status, 200);
  managerCookie = cookiePair(managerLogin.response.headers.get('set-cookie'));

  const lineAResult = await jsonRequest('/api/master/lines', mutation('POST', idem('line-a'), {
    voltageLevelId: 'vl-ac-220', lineName: '主数据甲线', lineCode: 'MASTER-A', enabled: true,
  }));
  assert.equal(lineAResult.response.status, 201);
  lineA = lineAResult.body.data;

  const lineBResult = await jsonRequest('/api/master/lines', mutation('POST', idem('line-b'), {
    voltageLevelId: 'vl-ac-220', lineName: '主数据乙线', lineCode: 'MASTER-B', enabled: true,
  }));
  assert.equal(lineBResult.response.status, 201);
  lineB = lineBResult.body.data;

  for (const input of [
    { lineId: lineA.id, towerNo: '10', sortRank: 1000 },
    { lineId: lineA.id, towerNo: '20', sortRank: 2000 },
    { lineId: lineB.id, towerNo: '10', sortRank: 1000 },
  ]) {
    const result = await jsonRequest('/api/master/towers', mutation('POST', idem('tower'), {
      ...input, towerType: '测试塔', enabled: true,
    }));
    assert.equal(result.response.status, 201);
    if (input.lineId === lineA.id && input.sortRank === 1000) towerA10 = result.body.data;
    else if (input.lineId === lineA.id) towerA20 = result.body.data;
    else towerB10 = result.body.data;
  }
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('master data writes are admin-only and idempotent', async () => {
  const forbidden = await jsonRequest('/api/master/voltage-levels', mutation('POST', idem('forbidden-voltage'), {
    displayName: '66kV', code: 'AC_66KV', systemType: 'AC', nominalKv: 66, sortOrder: 15, enabled: true,
  }), managerCookie);
  assert.equal(forbidden.response.status, 403);

  const key = idem('voltage-idem');
  const payload = { displayName: '330kV', code: 'AC_330KV', systemType: 'AC', nominalKv: 330, sortOrder: 35, enabled: true };
  const first = await jsonRequest('/api/master/voltage-levels', mutation('POST', key, payload));
  assert.equal(first.response.status, 201);
  const replay = await jsonRequest('/api/master/voltage-levels', mutation('POST', key, payload));
  assert.equal(replay.response.status, 201);
  assert.deepEqual(replay.body, first.body);

  const conflict = await jsonRequest('/api/master/voltage-levels', mutation('POST', key, { ...payload, displayName: '331kV' }));
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const duplicateName = await jsonRequest('/api/master/voltage-levels', mutation('POST', idem('duplicate-voltage-name'), {
    ...payload, code: 'AC_330KV_OTHER',
  }));
  assert.equal(duplicateName.response.status, 409);

  const duplicateCode = await jsonRequest('/api/master/voltage-levels', mutation('POST', idem('duplicate-voltage-code'), {
    ...payload, displayName: '330千伏',
  }));
  assert.equal(duplicateCode.response.status, 409);
});

test('line and tower parent relations reject disabled parents while names/numbers may repeat', async () => {
  const disabledVoltage = await jsonRequest('/api/master/voltage-levels', mutation('POST', idem('disabled-voltage'), {
    displayName: '750kV', code: 'AC_750KV', systemType: 'AC', nominalKv: 750, sortOrder: 45, enabled: true,
  }));
  assert.equal(disabledVoltage.response.status, 201);
  const disabledVoltagePatch = await jsonRequest(`/api/master/voltage-levels/${disabledVoltage.body.data.id}`, mutation('PATCH', idem('disable-voltage'), {
    ...disabledVoltage.body.data,
    expectedVersion: disabledVoltage.body.data.version,
    enabled: false,
  }));
  assert.equal(disabledVoltagePatch.response.status, 200);

  const lineOnDisabled = await jsonRequest('/api/master/lines', mutation('POST', idem('line-disabled-voltage'), {
    voltageLevelId: disabledVoltage.body.data.id, lineName: '不可用线路', lineCode: null, enabled: true,
  }));
  assert.equal(lineOnDisabled.response.status, 422);
  assert.equal(lineOnDisabled.body.error.code, 'VOLTAGE_LEVEL_NOT_FOUND');

  const duplicateLine = await jsonRequest('/api/master/lines', mutation('POST', idem('duplicate-line'), {
    voltageLevelId: 'vl-ac-220', lineName: '主数据甲线', lineCode: 'MASTER-A-DUP', enabled: true,
  }));
  assert.equal(duplicateLine.response.status, 201);
  assert.notEqual(duplicateLine.body.data.id, lineA.id);

  const invalidLineMove = await jsonRequest(`/api/master/lines/${lineB.id}`, mutation('PATCH', idem('line-disabled-parent'), {
    voltageLevelId: disabledVoltage.body.data.id,
    lineName: lineB.lineName,
    lineCode: lineB.lineCode,
    enabled: true,
    expectedVersion: lineB.version,
  }));
  assert.equal(invalidLineMove.response.status, 422);

  const disabledLine = await jsonRequest('/api/master/lines', mutation('POST', idem('disabled-line'), {
    voltageLevelId: 'vl-ac-220', lineName: '停用线路', lineCode: 'DISABLED-LINE', enabled: true,
  }));
  assert.equal(disabledLine.response.status, 201);
  const disabledLinePatch = await jsonRequest(`/api/master/lines/${disabledLine.body.data.id}`, mutation('PATCH', idem('disable-line'), {
    voltageLevelId: disabledLine.body.data.voltageLevelId,
    lineName: disabledLine.body.data.lineName,
    lineCode: disabledLine.body.data.lineCode,
    enabled: false,
    expectedVersion: disabledLine.body.data.version,
  }));
  assert.equal(disabledLinePatch.response.status, 200);

  const towerOnDisabledLine = await jsonRequest('/api/master/towers', mutation('POST', idem('tower-disabled-line'), {
    lineId: disabledLine.body.data.id, towerNo: '1', sortRank: 1000, towerType: null, enabled: true,
  }));
  assert.equal(towerOnDisabledLine.response.status, 422);
  assert.equal(towerOnDisabledLine.body.error.code, 'LINE_NOT_FOUND');

  const duplicateTowerNo = await jsonRequest('/api/master/towers', mutation('POST', idem('duplicate-tower-no'), {
    lineId: lineA.id, towerNo: '10', sortRank: 1500, towerType: null, enabled: true,
  }));
  assert.equal(duplicateTowerNo.response.status, 201);
  assert.equal(duplicateTowerNo.body.data.towerNo, '#010');

  const ignoredManualOrder = await jsonRequest('/api/master/towers', mutation('POST', idem('duplicate-tower-order'), {
    lineId: lineA.id, towerNo: '11', sortRank: 1000, towerType: null, enabled: true,
  }));
  assert.equal(ignoredManualOrder.response.status, 201);
  assert.equal(ignoredManualOrder.body.data.towerNo, '#011');
});

test('structured demand supports whole-line, tower and tower-range locations and exposes object ids', async () => {
  const whole = await jsonRequest('/api/demands', mutation('POST', idem('demand-whole'), {
    sequenceNo: 'MD-WHOLE', voltageLevelId: 'vl-ac-220', lineId: lineA.id,
    locationType: 'whole_line', materials: [], year: 2026,
  }), managerCookie);
  assert.equal(whole.response.status, 201);
  assert.equal(whole.body.data.voltageLevelId, 'vl-ac-220');
  assert.equal(whole.body.data.lineId, lineA.id);
  assert.equal(whole.body.data.locationType, 'whole_line');
  assert.equal(whole.body.data.startTowerId, null);
  assert.equal(whole.body.data.endTowerId, null);

  const tower = await jsonRequest('/api/demands', mutation('POST', idem('demand-tower'), {
    sequenceNo: 'MD-TOWER', voltageLevelId: 'vl-ac-220', lineId: lineA.id,
    locationType: 'tower', startTowerId: towerA10.id, materials: [], year: 2026,
  }), managerCookie);
  assert.equal(tower.response.status, 201);
  assert.equal(tower.body.data.locationType, 'tower');
  assert.equal(tower.body.data.startTowerId, towerA10.id);
  assert.equal(tower.body.data.endTowerId, towerA10.id);

  const rangeKey = idem('demand-range');
  const rangePayload = {
    sequenceNo: 'MD-RANGE', voltageLevelId: 'vl-ac-220', lineId: lineA.id,
    locationType: 'tower_range', startTowerId: towerA10.id, endTowerId: towerA20.id,
    materials: [], year: 2026,
  };
  const range = await jsonRequest('/api/demands', mutation('POST', rangeKey, rangePayload), managerCookie);
  assert.equal(range.response.status, 201);
  assert.equal(range.body.data.startTowerId, towerA10.id);
  assert.equal(range.body.data.endTowerId, towerA20.id);

  const replay = await jsonRequest('/api/demands', mutation('POST', rangeKey, rangePayload), managerCookie);
  assert.equal(replay.response.status, 201);
  assert.deepEqual(replay.body, range.body);

  const conflict = await jsonRequest('/api/demands', mutation('POST', rangeKey, { ...rangePayload, sequenceNo: 'MD-RANGE-OTHER' }), managerCookie);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const detail = await jsonRequest(`/api/demands/${range.body.data.id}`, {}, managerCookie);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.voltageLevelId, 'vl-ac-220');
  assert.equal(detail.body.data.lineId, lineA.id);
  assert.equal(detail.body.data.locationType, 'tower_range');
  assert.equal(detail.body.data.startTowerId, towerA10.id);
  assert.equal(detail.body.data.endTowerId, towerA20.id);
});

test('structured demand rejects cross-line, reversed and disabled tower locations', async () => {
  const crossLine = await jsonRequest('/api/demands', mutation('POST', idem('cross-line'), {
    sequenceNo: 'MD-CROSS', voltageLevelId: 'vl-ac-220', lineId: lineA.id,
    locationType: 'tower_range', startTowerId: towerA10.id, endTowerId: towerB10.id, materials: [],
  }), managerCookie);
  assert.equal(crossLine.response.status, 422);
  assert.equal(crossLine.body.error.code, 'INVALID_TOWER_RELATION');

  const reversed = await jsonRequest('/api/demands', mutation('POST', idem('reversed'), {
    sequenceNo: 'MD-REVERSED', voltageLevelId: 'vl-ac-220', lineId: lineA.id,
    locationType: 'tower_range', startTowerId: towerA20.id, endTowerId: towerA10.id, materials: [],
  }), managerCookie);
  assert.equal(reversed.response.status, 422);
  assert.equal(reversed.body.error.code, 'INVALID_TOWER_RANGE');

  const disabled = await jsonRequest(`/api/master/towers/${towerB10.id}`, mutation('PATCH', idem('disable-tower'), {
    lineId: lineB.id,
    towerNo: towerB10.towerNo,
    sortRank: towerB10.sortRank,
    towerType: towerB10.towerType,
    enabled: false,
    expectedVersion: towerB10.version,
  }));
  assert.equal(disabled.response.status, 200);
  towerB10 = disabled.body.data;

  const disabledTower = await jsonRequest('/api/demands', mutation('POST', idem('disabled-tower-demand'), {
    sequenceNo: 'MD-DISABLED', voltageLevelId: 'vl-ac-220', lineId: lineB.id,
    locationType: 'tower', startTowerId: towerB10.id, materials: [],
  }), managerCookie);
  assert.equal(disabledTower.response.status, 422);
  assert.equal(disabledTower.body.error.code, 'INVALID_TOWER_RELATION');
});

test('referenced line cannot change parent and referenced tower cannot move to another line', async () => {
  const moveLine = await jsonRequest(`/api/master/lines/${lineA.id}`, mutation('PATCH', idem('move-referenced-line'), {
    voltageLevelId: 'vl-ac-110',
    lineName: lineA.lineName,
    lineCode: lineA.lineCode,
    enabled: true,
    expectedVersion: lineA.version,
  }));
  assert.equal(moveLine.response.status, 422);
  assert.equal(moveLine.body.error.code, 'LINE_LOCATION_IN_USE');

  const moveTower = await jsonRequest(`/api/master/towers/${towerA20.id}`, mutation('PATCH', idem('move-referenced-tower'), {
    lineId: lineB.id,
    towerNo: towerA20.towerNo,
    sortRank: towerA20.sortRank,
    towerType: towerA20.towerType,
    enabled: true,
    expectedVersion: towerA20.version,
  }));
  assert.equal(moveTower.response.status, 422);
  assert.equal(moveTower.body.error.code, 'TOWER_LINE_CHANGE_UNSUPPORTED');
});

test('structured demand with many material rows stays within the D1 invocation query budget', async () => {
  const material = await jsonRequest('/api/materials', mutation('POST', idem('many-material-master'), {
    code: 'MASTER-MANY-MATERIALS', name: '批量需求物资', model: 'MASTER-MANY-MODEL', unit: '件',
  }));
  assert.equal(material.response.status, 201);
  const demand = await jsonRequest('/api/demands', mutation('POST', idem('many-demand-materials'), {
    sequenceNo: 'MD-MANY-MATERIALS', voltageLevelId: 'vl-ac-220', lineId: lineA.id,
    locationType: 'whole_line', year: 2026,
    materials: Array.from({ length: 60 }, (_, index) => ({
      rawModel: `MASTER-MANY-${index + 1}`,
      materialId: material.body.data.id,
      quantityScaled: 10000,
      unit: '件',
    })),
  }), managerCookie);
  assert.equal(demand.response.status, 201);
  assert.equal(demand.body.data.materials.length, 60);
});

test('location shapes and material references are validated without silently discarding input', async () => {
  const base = { sequenceNo: 'SHAPE', voltageLevelId: 'vl-ac-220', lineId: lineA.id, materials: [] };
  for (const location of [
    { locationType: 'whole_line', startTowerId: towerA10.id },
    { locationType: 'tower', startTowerId: towerA10.id, endTowerId: towerA20.id },
    { locationType: 'tower_range', startTowerId: towerA10.id, endTowerId: towerA10.id },
    { locationType: 'free_text' },
  ]) assert.equal((await jsonRequest('/api/demands', mutation('POST', idem('shape'), { ...base, ...location }))).response.status, 422);
  assert.equal((await jsonRequest('/api/demands', mutation('POST', idem('material'), { ...base, locationType: 'whole_line', materials: [{ rawModel: 'x', materialId: 'missing', quantityScaled: 10000 }] }))).response.status, 422);
});

test('bulk tower maintenance is atomic, versioned, replayable and admin-only', async () => {
  const created = await jsonRequest('/api/master/lines', mutation('POST', idem('bulk-line'), { voltageLevelId: 'vl-ac-110', lineName: '批量维护线' }));
  const path = `/api/master/lines/${created.body.data.id}/towers/batch`;
  const input = { items: [{ towerNo: '20-1', sortRank: 1000 }, { towerNo: '21', sortRank: 2000 }] };
  assert.equal((await jsonRequest(path, mutation('POST', idem('bulk-permission'), input), managerCookie)).response.status, 403);
  const key = idem('bulk');
  const first = await jsonRequest(path, mutation('POST', key, input));
  assert.equal(first.response.status, 201);
  assert.deepEqual((await jsonRequest(path, mutation('POST', key, input))).body, first.body);
  const a = first.body.data.items[0];
  const invalid = { items: [{ ...a, towerType: '修改', expectedVersion: a.version }, { towerNo: '22', sortRank: 2000 }] };
  assert.equal((await jsonRequest(path, mutation('POST', idem('bulk-rollback'), invalid))).response.status, 409);
  const list = await jsonRequest(`/api/master/towers?lineId=${created.body.data.id}`);
  assert.equal(list.body.data.items.length, 2);
  assert.equal(list.body.data.items[0].version, 1);
  const patch = { ...a, expectedVersion: a.version, towerType: '更新' };
  const races = await Promise.all([1, 2].map(() => jsonRequest(path, mutation('POST', idem('bulk-race'), { items: [patch] }))));
  assert.deepEqual(races.map((r) => r.response.status).sort(), [201, 409]);
});

test('unused objects can be deleted; referenced objects and parents with children cannot', async () => {
  for (const [kind, item] of [['voltage-levels', { id: 'vl-ac-220', version: 1 }], ['lines', lineA], ['towers', towerA10]]) {
    const result = await jsonRequest(`/api/master/${kind}/${item.id}`, mutation('DELETE', idem('referenced-delete'), { expectedVersion: item.version }));
    assert.equal(result.response.status, 422);
  }
  const made = await jsonRequest('/api/master/towers', mutation('POST', idem('delete-tower'), { lineId: lineB.id, towerNo: '99', sortRank: 99000 }));
  assert.equal(made.response.status, 201);
  const path = `/api/master/towers/${made.body.data.id}`, body = { expectedVersion: 1 }, key = idem('delete');
  assert.equal((await jsonRequest(path, mutation('DELETE', idem('delete-denied'), body), managerCookie)).response.status, 403);
  assert.equal((await jsonRequest(path, mutation('DELETE', idem('delete-stale'), { expectedVersion: 2 }))).response.status, 409);
  const deleted = await jsonRequest(path, mutation('DELETE', key, body));
  assert.equal(deleted.response.status, 200);
  assert.deepEqual((await jsonRequest(path, mutation('DELETE', key, body))).body, deleted.body);
});

test('referenced-line tower can change current order while deletion remains protected and history stays readable', async () => {
  const made = await jsonRequest('/api/master/towers', mutation('POST', idem('interior'), { lineId: lineA.id, towerNo: '15', sortRank: 15000 }));
  assert.equal(made.response.status, 201);
  const item = made.body.data;
  const lineBeforeMove = (await jsonRequest(`/api/master/lines?query=${encodeURIComponent(lineA.lineName)}`)).body.data.items.find((value) => value.id === lineA.id);
  const reordered = await jsonRequest(`/api/master/lines/${lineA.id}/towers/${item.id}/move`, mutation('POST', idem('interior-move'), {
    expectedTowerOrderVersion: lineBeforeMove.towerOrderVersion,
    afterTowerId: towerA20.id,
  }));
  assert.equal(reordered.response.status, 200);
  assert.equal((await jsonRequest(`/api/master/towers/${item.id}`, mutation('DELETE', idem('interior-delete'), { expectedVersion: item.version }))).response.status, 422);
  const disabled = await jsonRequest(`/api/master/lines/${lineA.id}`, mutation('PATCH', idem('history-disable'), { ...lineA, expectedVersion: 1, enabled: false }));
  assert.equal(disabled.response.status, 200);
  const history = await jsonRequest('/api/demands?query=MD-RANGE');
  assert.equal(history.body.data.items[0].lineId, lineA.id);
  assert.equal(history.body.data.items[0].section, '#010—#020');
  assert.equal((await jsonRequest('/api/demands', mutation('POST', idem('new-disabled'), { sequenceNo: 'NEW', voltageLevelId: 'vl-ac-220', lineId: lineA.id, locationType: 'whole_line' }))).response.status, 422);
  const currentItem = (await jsonRequest(`/api/master/towers?lineId=${lineA.id}`)).body.data.items.find((value) => value.id === item.id);
  const disableChild = await jsonRequest(`/api/master/towers/${item.id}`, mutation('PATCH', idem('child-disable'), { ...currentItem, expectedVersion: currentItem.version, enabled: false }));
  assert.equal(disableChild.response.status, 200, 'must be able to disable children of a disabled parent');
});

test('master writes require keys and same-version concurrent patches leave exactly one audit', async () => {
  assert.equal((await jsonRequest('/api/master/lines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).response.status, 400);
  const before = (await jsonRequest('/api/master/lines')).body.data.items.find((l) => l.id === lineB.id);
  const results = await Promise.all([1, 2].map((n) => jsonRequest(`/api/master/lines/${lineB.id}`, mutation('PATCH', idem('line-race'), { ...before, expectedVersion: before.version, lineCode: `RACE-${n}` }))));
  assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
  const audit = queryLocalD1(stateDir, `SELECT COUNT(*) AS total FROM audit_events WHERE object_id='${lineB.id}' AND action='master.lines.update'`).flatMap((r) => r.results ?? []);
  assert.equal(audit[0].total, 1);
});

test('master lists page within the selected parent without losing or repeating objects', async () => {
  const first = await jsonRequest(`/api/master/towers?lineId=${lineA.id}&limit=1`);
  assert.equal(first.body.data.items.length, 1);
  assert.ok(first.body.data.nextCursor);
  const next = await jsonRequest(`/api/master/towers?lineId=${lineA.id}&limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`);
  assert.equal(next.body.data.items.length, 1);
  assert.notEqual(next.body.data.items[0].id, first.body.data.items[0].id);
  assert.equal(next.body.data.items[0].lineId, lineA.id);
  const lines = await jsonRequest('/api/master/lines?voltageLevelId=vl-ac-220&limit=1');
  assert.equal(lines.body.data.items.length, 1);
  assert.ok(lines.body.data.nextCursor);
  assert.equal((await jsonRequest('/api/master/towers?limit=999')).response.status, 400);
});

test('unreferenced towers can exchange order atomically in a batch', async () => {
  const line = (await jsonRequest('/api/master/lines', mutation('POST', idem('swap-line'), { voltageLevelId: 'vl-ac-110', lineName: '交换顺序线' }))).body.data;
  const path = `/api/master/lines/${line.id}/towers/batch`;
  const made = await jsonRequest(path, mutation('POST', idem('swap-seed'), { items: [{ towerNo: '1', sortRank: 1000 }, { towerNo: '2', sortRank: 2000 }] }));
  const items = made.body.data.items.map((t) => ({ ...t, expectedVersion: t.version, sortRank: t.sortRank === 1000 ? 2000 : 1000 }));
  const result = await jsonRequest(path, mutation('POST', idem('swap'), { items }));
  assert.equal(result.response.status, 201);
  assert.deepEqual((await jsonRequest(`/api/master/towers?lineId=${line.id}`)).body.data.items.map((t) => t.towerNo), ['#002', '#001']);
});

test('line rename is a dedicated atomic action with searchable history and duplicate names remain valid', async () => {
  const created = await jsonRequest('/api/master/lines', mutation('POST', idem('rename-line-create'), {
    voltageLevelId: 'vl-ac-110', lineName: '更名前线路', lineCode: 'RENAME-LINE', enabled: true,
  }));
  assert.equal(created.response.status, 201);

  const bypass = await jsonRequest(`/api/master/lines/${created.body.data.id}`, mutation('PATCH', idem('rename-line-bypass'), {
    ...created.body.data, lineName: '绕过更名', expectedVersion: created.body.data.version,
  }));
  assert.equal(bypass.response.status, 422);
  assert.equal(bypass.body.error.code, 'RENAME_REQUIRED');

  const key = idem('rename-line');
  const renamed = await jsonRequest(`/api/master/lines/${created.body.data.id}/rename`, mutation('POST', key, {
    expectedVersion: created.body.data.version, lineName: '更名后线路', reason: '运行名称调整',
  }));
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.data.id, created.body.data.id);
  assert.equal(renamed.body.data.lineName, '更名后线路');
  assert.equal(renamed.body.data.version, created.body.data.version + 1);
  assert.deepEqual((await jsonRequest(`/api/master/lines/${created.body.data.id}/rename`, mutation('POST', key, {
    expectedVersion: created.body.data.version, lineName: '更名后线路', reason: '运行名称调整',
  }))).body, renamed.body);

  const duplicate = await jsonRequest('/api/master/lines', mutation('POST', idem('rename-line-duplicate'), {
    voltageLevelId: 'vl-ac-110', lineName: '更名后线路', lineCode: 'RENAME-LINE-2', enabled: true,
  }));
  assert.equal(duplicate.response.status, 201);
  assert.notEqual(duplicate.body.data.id, created.body.data.id);

  const history = await jsonRequest(`/api/master/lines/${created.body.data.id}/name-history`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.data.items.length, 1);
  assert.equal(history.body.data.items[0].lineName, '更名前线路');
  assert.equal(history.body.data.items[0].reason, '运行名称调整');

  const oldNameSearch = await jsonRequest(`/api/master/lines?query=${encodeURIComponent('更名前线路')}`);
  assert.ok(oldNameSearch.body.data.items.some((item) => item.id === created.body.data.id && item.matchedHistoricalName === '更名前线路'));
  const currentNameSearch = await jsonRequest(`/api/master/lines?query=${encodeURIComponent('更名后线路')}`);
  assert.ok(currentNameSearch.body.data.items.filter((item) => item.lineName === '更名后线路').length >= 2);

  const stale = await jsonRequest(`/api/master/lines/${created.body.data.id}/rename`, mutation('POST', idem('rename-line-stale'), {
    expectedVersion: created.body.data.version, lineName: '过期更名',
  }));
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
});

test('tower rename canonicalizes the new number, preserves history and never treats a duplicate number as identity', async () => {
  const line = (await jsonRequest('/api/master/lines', mutation('POST', idem('rename-tower-line'), {
    voltageLevelId: 'vl-ac-110', lineName: '杆塔更名线', enabled: true,
  }))).body.data;
  const created = await jsonRequest('/api/master/towers', mutation('POST', idem('rename-tower-create'), {
    lineId: line.id, towerNo: '30', sortRank: 1000, towerType: '角钢塔', enabled: true,
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.towerNo, '#030');

  const bypass = await jsonRequest(`/api/master/towers/${created.body.data.id}`, mutation('PATCH', idem('rename-tower-bypass'), {
    ...created.body.data, towerNo: '31', expectedVersion: created.body.data.version,
  }));
  assert.equal(bypass.response.status, 422);
  assert.equal(bypass.body.error.code, 'RENAME_REQUIRED');

  const renamed = await jsonRequest(`/api/master/towers/${created.body.data.id}/rename`, mutation('POST', idem('rename-tower'), {
    expectedVersion: created.body.data.version, towerNo: '30-01', reason: '杆号调整',
  }));
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.data.id, created.body.data.id);
  assert.equal(renamed.body.data.towerNo, '#030-1');

  const duplicate = await jsonRequest('/api/master/towers', mutation('POST', idem('rename-tower-duplicate'), {
    lineId: line.id, towerNo: '#030-1', sortRank: 2000, towerType: null, enabled: true,
  }));
  assert.equal(duplicate.response.status, 201);
  assert.notEqual(duplicate.body.data.id, created.body.data.id);

  const history = await jsonRequest(`/api/master/towers/${created.body.data.id}/number-history`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.data.items.length, 1);
  assert.equal(history.body.data.items[0].towerNo, '#030');
  assert.equal(history.body.data.items[0].reason, '杆号调整');

  const oldNumberSearch = await jsonRequest(`/api/master/towers?lineId=${line.id}&query=30`);
  assert.ok(oldNumberSearch.body.data.items.some((item) => item.id === created.body.data.id && item.matchedHistoricalNo === '#030'));
  const duplicateSearch = await jsonRequest(`/api/master/towers?lineId=${line.id}&query=30-1`);
  assert.ok(duplicateSearch.body.data.items.filter((item) => item.towerNo === '#030-1').length >= 2);

  const forbidden = await jsonRequest(`/api/master/towers/${created.body.data.id}/rename`, mutation('POST', idem('rename-tower-forbidden'), {
    expectedVersion: renamed.body.data.version, towerNo: '32',
  }), managerCookie);
  assert.equal(forbidden.response.status, 403);
});

test('tower ordering uses line order versions, auto-inserts new towers by normalized number and moves by business position', async () => {
  const createdLine = await jsonRequest('/api/master/lines', mutation('POST', idem('order-line'), {
    voltageLevelId: 'vl-ac-110', lineName: '顺序调整线', enabled: true,
  }));
  assert.equal(createdLine.response.status, 201);
  const line = createdLine.body.data;
  assert.equal(line.towerOrderVersion, 1);

  const a = await jsonRequest('/api/master/towers', mutation('POST', idem('order-a'), {
    lineId: line.id, towerNo: '101', towerType: null, enabled: true,
  }));
  const c = await jsonRequest('/api/master/towers', mutation('POST', idem('order-c'), {
    lineId: line.id, towerNo: '103', towerType: null, enabled: true,
  }));
  const b = await jsonRequest('/api/master/towers', mutation('POST', idem('order-b'), {
    lineId: line.id, towerNo: '102', towerType: null, enabled: true,
  }));
  assert.deepEqual([a.response.status, b.response.status, c.response.status], [201, 201, 201]);
  assert.ok(a.body.data.sortRank < b.body.data.sortRank);
  assert.ok(b.body.data.sortRank < c.body.data.sortRank);
  assert.deepEqual((await jsonRequest(`/api/master/towers?lineId=${line.id}`)).body.data.items.map((item) => item.towerNo), ['#101', '#102', '#103']);

  const branch = await jsonRequest('/api/master/towers', mutation('POST', idem('order-branch'), {
    lineId: line.id, towerNo: '102-1', towerType: null, enabled: true,
  }));
  assert.equal(branch.response.status, 201);
  assert.deepEqual((await jsonRequest(`/api/master/towers?lineId=${line.id}`)).body.data.items.map((item) => item.towerNo), ['#101', '#102', '#102-1', '#103']);

  const afterCreate = (await jsonRequest(`/api/master/lines?query=${encodeURIComponent('顺序调整线')}`)).body.data.items.find((item) => item.id === line.id);
  assert.equal(afterCreate.towerOrderVersion, 5);

  const bypass = await jsonRequest(`/api/master/towers/${a.body.data.id}`, mutation('PATCH', idem('order-bypass'), {
    ...a.body.data, sortRank: 2500, expectedVersion: a.body.data.version,
  }));
  assert.equal(bypass.response.status, 422);
  assert.equal(bypass.body.error.code, 'ORDER_MOVE_REQUIRED');

  const moved = await jsonRequest(`/api/master/lines/${line.id}/towers/${c.body.data.id}/move`, mutation('POST', idem('order-move'), {
    expectedTowerOrderVersion: 5, beforeTowerId: b.body.data.id,
  }));
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.data.towerId, c.body.data.id);
  assert.equal(moved.body.data.towerOrderVersion, 6);
  assert.deepEqual((await jsonRequest(`/api/master/towers?lineId=${line.id}`)).body.data.items.map((item) => item.id), [a.body.data.id, c.body.data.id, b.body.data.id, branch.body.data.id]);

  const stale = await jsonRequest(`/api/master/lines/${line.id}/towers/${b.body.data.id}/move`, mutation('POST', idem('order-stale'), {
    expectedTowerOrderVersion: 5, beforeTowerId: c.body.data.id,
  }));
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'ORDER_VERSION_CONFLICT');

  const same = await jsonRequest(`/api/master/lines/${line.id}/towers/${c.body.data.id}/move`, mutation('POST', idem('order-noop'), {
    expectedTowerOrderVersion: 6, afterTowerId: a.body.data.id,
  }));
  assert.equal(same.response.status, 422);
  assert.equal(same.body.error.code, 'ORDER_NO_CHANGE');
});

test('new tower auto placement handles head, branch numbers, tail and duplicate numbers without identity guessing', async () => {
  const line = (await jsonRequest('/api/master/lines', mutation('POST', idem('auto-place-line'), {
    voltageLevelId: 'vl-ac-110', lineName: '自动插入线', enabled: true,
  }))).body.data;
  for (const no of ['10', '20', '10-1', '5', '30', '10']) {
    const made = await jsonRequest('/api/master/towers', mutation('POST', idem(`auto-place-${no}`), {
      lineId: line.id, towerNo: no, enabled: true,
    }));
    assert.equal(made.response.status, 201);
  }
  const list = await jsonRequest(`/api/master/towers?lineId=${line.id}`);
  assert.deepEqual(list.body.data.items.map((item) => item.towerNo), [
    '#005', '#010', '#010', '#010-1', '#020', '#030',
  ]);
  const ranks = list.body.data.items.map((item) => item.sortRank);
  assert.ok(ranks.every((rank, index) => index === 0 || rank > ranks[index - 1]));
});

test('tower sparse ordering automatically rebalances when repeated numeric auto-inserts exhaust a rank gap', async () => {
  const line = (await jsonRequest('/api/master/lines', mutation('POST', idem('rebalance-line'), {
    voltageLevelId: 'vl-ac-110', lineName: '稀疏排序线', enabled: true,
  }))).body.data;
  for (const no of ['201', '202']) {
    const made = await jsonRequest('/api/master/towers', mutation('POST', idem(`rebalance-${no}`), {
      lineId: line.id, towerNo: no, enabled: true,
    }));
    assert.equal(made.response.status, 201);
  }
  for (let branch = 1; branch <= 12; branch += 1) {
    const result = await jsonRequest('/api/master/towers', mutation('POST', idem(`rebalance-branch-${branch}`), {
      lineId: line.id, towerNo: `201-${branch}`, enabled: true,
    }));
    assert.equal(result.response.status, 201, `branch ${branch}: ${JSON.stringify(result.body)}`);
  }
  const list = await jsonRequest(`/api/master/towers?lineId=${line.id}`);
  assert.deepEqual(list.body.data.items.map((item) => item.towerNo), [
    '#201', ...Array.from({ length: 12 }, (_, index) => `#201-${index + 1}`), '#202',
  ]);
  const ranks = list.body.data.items.map((item) => item.sortRank);
  assert.ok(ranks.every((rank) => Number.isSafeInteger(rank) && rank > 0));
  assert.equal(new Set(ranks).size, ranks.length);
  assert.equal((await jsonRequest(`/api/master/lines?query=${encodeURIComponent('稀疏排序线')}`)).body.data.items.find((item) => item.id === line.id).towerOrderVersion, 15);
});
