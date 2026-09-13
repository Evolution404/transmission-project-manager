import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, makeStateDir, queryLocalD1, startWranglerServer } from './helpers/wrangler.mjs';
import { bootstrapAdmin, cookiePair } from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-final-business-flow-');
let runtime;
let adminCookie;

function idem(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function jsonRequest(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (adminCookie) headers.set('Cookie', adminCookie);
  const response = await runtime.request(path, { ...init, headers });
  let body = null;
  try { body = await response.json(); } catch { /* non JSON */ }
  return { response, body };
}

function mutation(method, prefix, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idem(prefix) },
    body: JSON.stringify(body),
  };
}

function dbRows(command) {
  return queryLocalD1(stateDir, command).flatMap((entry) => entry.results ?? []);
}

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8810,
    migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:final-flow-pepper', 'BOOTSTRAP_TOKEN:final-flow-bootstrap'],
  });
  const bootstrap = await bootstrapAdmin(runtime, { token: 'final-flow-bootstrap' });
  assert.equal(bootstrap.response.status, 201);
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));

  const line = await jsonRequest('/api/master/lines', mutation('POST', 'master-line', {
    voltageLevelId: 'vl-ac-220', lineName: '220kV测试线', lineCode: 'TEST-220', enabled: true,
  }));
  assert.equal(line.response.status, 201);
  globalThis.__finalLineId = line.body.data.id;
  for (const [towerNo, sortIndex] of [['#10', 10], ['#20', 20]]) {
    const tower = await jsonRequest('/api/master/towers', mutation('POST', `master-tower-${sortIndex}`, {
      lineId: line.body.data.id, towerNo, sortIndex, towerType: '测试塔', enabled: true,
    }));
    assert.equal(tower.response.status, 201);
    globalThis[`__finalTower${sortIndex}`] = tower.body.data.id;
  }
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('abstract demand can exist without materials and later receive multiple child material lines', async () => {
  const created = await jsonRequest('/api/demands', mutation('POST', 'demand-empty-materials', {
    sequenceNo: 'D001',
    year: 2026,
    voltageLevelId: 'vl-ac-220',
    lineId: globalThis.__finalLineId,
    locationType: 'tower_range',
    startTowerId: globalThis.__finalTower10,
    endTowerId: globalThis.__finalTower20,
    category: '防鸟治理',
    owner: '测试负责人',
    materials: [],
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.source.type, 'manual');
  assert.deepEqual(created.body.data.materials, []);
  assert.equal(created.body.data.version, 1);
  globalThis.__finalDemandId = created.body.data.id;

  const added = await jsonRequest(`/api/demands/${created.body.data.id}/materials`, mutation('POST', 'demand-add-materials', {
    expectedVersion: 1,
    materials: [
      { rawModel: 'A', materialId: null, quantityScaled: 1000000, unit: '套' },
      { rawModel: '辅材-X', materialId: null, quantityScaled: 50000, unit: '个' },
    ],
  }));
  assert.equal(added.response.status, 200);
  assert.equal(added.body.data.version, 2);
  assert.equal(added.body.data.materials.length, 2);

  const demand = await jsonRequest(`/api/demands/${created.body.data.id}`);
  assert.equal(demand.response.status, 200);
  assert.equal(demand.body.data.materials.length, 2);
  assert.equal(demand.body.data.source.type, 'manual');
  assert.equal(demand.body.data.source.fileName, undefined);
});

test('reserve project keeps demand links separate from mutable project material requirements and revision history', async () => {
  const demandId = globalThis.__finalDemandId;
  assert.ok(demandId);

  const project = await jsonRequest('/api/reserve-projects', mutation('POST', 'reserve-project-create', {
    name: 'P001 防鸟治理项目',
    year: 2026,
    owner: '项目负责人',
    demandIds: [demandId],
    materials: [
      { materialId: null, model: 'A', unit: '套', requiredQuantityScaled: 1000000, unitPriceScaled: 1000000, reserveCategoryId: null },
    ],
  }));
  assert.equal(project.response.status, 201);
  assert.equal(project.body.data.demandLinks.length, 1);
  assert.equal(project.body.data.materialRequirements.length, 1);
  assert.equal(project.body.data.materialRequirements[0].model, 'A');
  assert.equal(project.body.data.materialRequirements[0].requiredQuantityScaled, 1000000);
  globalThis.__finalProjectId = project.body.data.id;
  globalThis.__finalProjectVersion = project.body.data.version;
  globalThis.__materialAId = project.body.data.materialRequirements[0].id;

  const revised = await jsonRequest(`/api/reserve-projects/${project.body.data.id}/materials`, mutation('PUT', 'reserve-material-revise', {
    expectedVersion: project.body.data.version,
    reason: '现场复勘调整物资',
    materials: [
      { id: project.body.data.materialRequirements[0].id, materialId: null, model: 'A', unit: '套', requiredQuantityScaled: 800000, unitPriceScaled: 1000000, reserveCategoryId: null },
      { materialId: null, model: 'B', unit: '只', requiredQuantityScaled: 200000, unitPriceScaled: 2000000, reserveCategoryId: null },
    ],
  }));
  assert.equal(revised.response.status, 200);
  assert.equal(revised.body.data.materialRequirements.length, 2);
  assert.equal(revised.body.data.materialRequirements.find((item) => item.model === 'A').requiredQuantityScaled, 800000);
  assert.equal(revised.body.data.materialRequirements.find((item) => item.model === 'B').requiredQuantityScaled, 200000);
  globalThis.__finalProjectVersion = revised.body.data.version;
  globalThis.__materialAId = revised.body.data.materialRequirements.find((item) => item.model === 'A').id;
  globalThis.__materialBId = revised.body.data.materialRequirements.find((item) => item.model === 'B').id;

  const history = await jsonRequest(`/api/reserve-projects/${project.body.data.id}/material-revisions`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.data.items.length, 1);
  assert.equal(history.body.data.items[0].reason, '现场复勘调整物资');
  assert.equal(history.body.data.items[0].before[0].requiredQuantityScaled, 1000000);
  assert.equal(history.body.data.items[0].after.find((item) => item.model === 'A').requiredQuantityScaled, 800000);

  const taskBeforeRelease = await jsonRequest('/api/project-tasks', mutation('POST', 'task-before-release', {
    projectId: project.body.data.id,
    expectedProjectVersion: revised.body.data.version,
    name: '不得提前建立的任务',
    description: null,
    scopeText: '#10-#15',
    owner: null,
    plannedDate: null,
    plannedQuantityScaled: 100000,
    unit: '项',
    demandScopes: [{ demandId, quantityScaled: 100000 }],
    materials: [],
  }));
  assert.equal(taskBeforeRelease.response.status, 422);
  assert.equal(taskBeforeRelease.body.error.code, 'PROJECT_NOT_RELEASED');

  const confirmed = await jsonRequest(`/api/reserve-projects/${project.body.data.id}/confirm`, mutation('POST', 'reserve-confirm', {
    expectedVersion: revised.body.data.version,
    reason: '储备确认',
  }));
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.data.reserveVersion, 1);
  globalThis.__finalProjectVersion = confirmed.body.data.version;
});

test('project release is one project-level immutable snapshot and enables multiple execution tasks', async () => {
  const projectId = globalThis.__finalProjectId;
  const demandId = globalThis.__finalDemandId;
  const released = await jsonRequest('/api/project-releases', mutation('POST', 'project-release', {
    projectId,
    expectedProjectVersion: globalThis.__finalProjectVersion,
    releaseDate: '2026-09-13',
    note: '正式进入执行阶段',
  }));
  assert.equal(released.response.status, 201);
  assert.equal(released.body.data.projectId, projectId);
  assert.equal(released.body.data.snapshot.materialRequirements.length, 2);
  assert.equal(released.body.data.snapshot.demandLinks.length, 1);
  assert.equal('lines' in released.body.data, false);
  assert.equal(dbRows(`SELECT COUNT(*) AS count FROM release_lines WHERE project_id='${projectId}'`)[0].count, 0);
  globalThis.__projectReleaseId = released.body.data.id;
  globalThis.__finalProjectVersion = released.body.data.projectVersion;

  const t1 = await jsonRequest('/api/project-tasks', mutation('POST', 'task-t1', {
    projectId,
    expectedProjectVersion: globalThis.__finalProjectVersion,
    name: 'T1 第一执行任务',
    description: null,
    scopeText: '#10-#15',
    owner: '执行人甲',
    plannedDate: '2026-09-20',
    plannedQuantityScaled: 600000,
    unit: '项',
    demandScopes: [{ demandId, quantityScaled: 600000 }],
    materials: [{ projectMaterialRequirementId: globalThis.__materialAId, quantityScaled: 600000 }],
  }));
  assert.equal(t1.response.status, 201);
  globalThis.__t1 = t1.body.data;
  globalThis.__finalProjectVersion = t1.body.data.projectVersion;

  const t2 = await jsonRequest('/api/project-tasks', mutation('POST', 'task-t2', {
    projectId,
    expectedProjectVersion: globalThis.__finalProjectVersion,
    name: 'T2 第二执行任务',
    description: null,
    scopeText: '#16-#20',
    owner: '执行人乙',
    plannedDate: null,
    plannedQuantityScaled: 400000,
    unit: '项',
    demandScopes: [{ demandId, quantityScaled: 400000 }],
    materials: [
      { projectMaterialRequirementId: globalThis.__materialAId, quantityScaled: 200000 },
      { projectMaterialRequirementId: globalThis.__materialBId, quantityScaled: 200000 },
    ],
  }));
  assert.equal(t2.response.status, 201);
  globalThis.__t2 = t2.body.data;
  globalThis.__finalProjectVersion = t2.body.data.projectVersion;

  const tasks = await jsonRequest(`/api/project-tasks?projectId=${projectId}`);
  assert.equal(tasks.response.status, 200);
  assert.equal(tasks.body.data.items.length, 2);
  assert.equal(new Set(tasks.body.data.items.map((item) => item.projectReleaseId)).size, 1);
  assert.equal(tasks.body.data.items[0].projectReleaseId, globalThis.__projectReleaseId);
});

test('task supply, implementation and settlement advance independently and enforce supply quantity ordering', async () => {
  const t1 = globalThis.__t1;
  const taskMaterial = t1.materials[0];

  const reported = await jsonRequest('/api/task-material-supply-events', mutation('POST', 'supply-reported', {
    taskMaterialRequirementId: taskMaterial.id,
    expectedSupplyVersion: 1,
    stage: 'reported',
    quantityScaled: 600000,
    eventDate: '2026-09-14',
    note: null,
  }));
  assert.equal(reported.response.status, 201);
  assert.deepEqual(reported.body.data.totals, { reportedQuantityScaled: 600000, shippedQuantityScaled: 0, arrivedQuantityScaled: 0 });

  const implementation = await jsonRequest('/api/task-implementations', mutation('POST', 'task-implementation', {
    taskId: t1.id,
    expectedImplementationVersion: 1,
    recordDate: '2026-09-15',
    scopeLines: [{ taskDemandScopeId: t1.demandScopes[0].id, completedQuantityScaled: 150000 }],
    materialUsages: [{ taskMaterialRequirementId: taskMaterial.id, quantityScaled: 150000 }],
    note: '已完成部分现场工作',
  }));
  assert.equal(implementation.response.status, 201);
  assert.equal(implementation.body.data.implementationVersion, 2);

  const settlement = await jsonRequest('/api/task-settlements', mutation('POST', 'task-settlement', {
    taskId: t1.id,
    expectedSettlementVersion: 1,
    settlementDate: '2026-09-16',
    amountFen: 10000,
    final: false,
    note: '部分结算',
    coverage: [{ taskDemandScopeId: t1.demandScopes[0].id, quantityScaled: 100000 }],
    agreementAllocations: [],
  }));
  assert.equal(settlement.response.status, 201);
  assert.equal(settlement.body.data.settlementVersion, 2);

  const shipped = await jsonRequest('/api/task-material-supply-events', mutation('POST', 'supply-shipped', {
    taskMaterialRequirementId: taskMaterial.id,
    expectedSupplyVersion: 2,
    stage: 'shipped',
    quantityScaled: 400000,
    eventDate: '2026-09-17',
    note: null,
  }));
  assert.equal(shipped.response.status, 201);

  const invalidArrival = await jsonRequest('/api/task-material-supply-events', mutation('POST', 'supply-arrive-too-much', {
    taskMaterialRequirementId: taskMaterial.id,
    expectedSupplyVersion: 3,
    stage: 'arrived',
    quantityScaled: 500000,
    eventDate: '2026-09-18',
    note: null,
  }));
  assert.equal(invalidArrival.response.status, 422);
  assert.equal(invalidArrival.body.error.code, 'SUPPLY_STAGE_ORDER_VIOLATION');

  const arrivedRequest = {
    taskMaterialRequirementId: taskMaterial.id,
    expectedSupplyVersion: 3,
    stage: 'arrived',
    quantityScaled: 200000,
    eventDate: '2026-09-18',
    note: null,
  };
  const idempotencyKey = idem('supply-arrived');
  const arrived = await jsonRequest('/api/task-material-supply-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(arrivedRequest),
  });
  assert.equal(arrived.response.status, 201);
  assert.deepEqual(arrived.body.data.totals, { reportedQuantityScaled: 600000, shippedQuantityScaled: 400000, arrivedQuantityScaled: 200000 });
  const replay = await jsonRequest('/api/task-material-supply-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(arrivedRequest),
  });
  assert.equal(replay.response.status, 201);
  assert.equal(replay.body.data.id, arrived.body.data.id);
  assert.equal(dbRows(`SELECT COUNT(*) AS count FROM material_supply_events WHERE task_material_requirement_id='${taskMaterial.id}' AND stage='arrived'`)[0].count, 1);

  const execution = await jsonRequest(`/api/projects/${globalThis.__finalProjectId}/execution`);
  assert.equal(execution.response.status, 200);
  const task = execution.body.data.tasks.find((item) => item.id === t1.id);
  assert.deepEqual(task.supplyTotals[0].totals, { reportedQuantityScaled: 600000, shippedQuantityScaled: 400000, arrivedQuantityScaled: 200000 });
  assert.equal(task.implementedQuantityScaled, 150000);
  assert.equal(task.settledQuantityScaled, 100000);
  assert.equal(task.settlementReminder.needed, true);
  assert.equal(task.settlementReminder.firstImplementationDate, '2026-09-15');
});

test('concurrent supply events with the same supply version serialize and cannot over-report a stage', async () => {
  const taskMaterial = globalThis.__t1.materials[0];
  const body = {
    taskMaterialRequirementId: taskMaterial.id,
    expectedSupplyVersion: 4,
    stage: 'shipped',
    quantityScaled: 150000,
    eventDate: '2026-09-19',
    note: '并发供应竞争',
  };
  const [first, second] = await Promise.all([
    jsonRequest('/api/task-material-supply-events', mutation('POST', 'supply-race-a', body)),
    jsonRequest('/api/task-material-supply-events', mutation('POST', 'supply-race-b', body)),
  ]);
  assert.deepEqual([first.response.status, second.response.status].sort((a, b) => a - b), [201, 409]);
  const conflict = first.response.status === 409 ? first : second;
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
  assert.equal(dbRows(`SELECT supply_version FROM task_material_requirements WHERE id='${taskMaterial.id}'`)[0].supply_version, 5);
  assert.equal(dbRows(`SELECT SUM(quantity_scaled) AS total FROM material_supply_events WHERE task_material_requirement_id='${taskMaterial.id}' AND stage='shipped'`)[0].total, 550000);
});

test('four-state feedback is projected back to the original demand from task facts, while partial progress remains explicit', async () => {
  const demandId = globalThis.__finalDemandId;
  const partial = await jsonRequest(`/api/demands/${demandId}/execution`);
  assert.equal(partial.response.status, 200);
  assert.equal(partial.body.data.state, 'unimplemented_unsettled');
  assert.equal(partial.body.data.plannedQuantityScaled, 1000000);
  assert.equal(partial.body.data.implementedQuantityScaled, 150000);
  assert.equal(partial.body.data.settledQuantityScaled, 100000);

  const t1 = globalThis.__t1;
  const finishT1Implementation = await jsonRequest('/api/task-implementations', mutation('POST', 'finish-t1-impl', {
    taskId: t1.id,
    expectedImplementationVersion: 2,
    recordDate: '2026-09-20',
    scopeLines: [{ taskDemandScopeId: t1.demandScopes[0].id, completedQuantityScaled: 450000 }],
    materialUsages: [],
    note: null,
  }));
  assert.equal(finishT1Implementation.response.status, 201);
  const finishT1Settlement = await jsonRequest('/api/task-settlements', mutation('POST', 'finish-t1-settlement', {
    taskId: t1.id,
    expectedSettlementVersion: 2,
    settlementDate: '2026-09-21',
    amountFen: 50000,
    final: true,
    note: 'T1最终结算',
    coverage: [{ taskDemandScopeId: t1.demandScopes[0].id, quantityScaled: 500000 }],
    agreementAllocations: [],
  }));
  assert.equal(finishT1Settlement.response.status, 201);

  const afterT1 = await jsonRequest(`/api/demands/${demandId}/execution`);
  assert.equal(afterT1.body.data.state, 'unimplemented_unsettled');
  assert.equal(afterT1.body.data.implementedQuantityScaled, 600000);
  assert.equal(afterT1.body.data.settledQuantityScaled, 600000);

  const t2 = globalThis.__t2;
  const settleT2First = await jsonRequest('/api/task-settlements', mutation('POST', 'settle-t2-before-implementation', {
    taskId: t2.id,
    expectedSettlementVersion: 1,
    settlementDate: '2026-09-22',
    amountFen: 40000,
    final: true,
    note: '允许先结算后实施',
    coverage: [{ taskDemandScopeId: t2.demandScopes[0].id, quantityScaled: 400000 }],
    agreementAllocations: [],
  }));
  assert.equal(settleT2First.response.status, 201);

  const unimplementedSettled = await jsonRequest(`/api/demands/${demandId}/execution`);
  assert.equal(unimplementedSettled.body.data.state, 'unimplemented_settled');
  assert.equal(unimplementedSettled.body.data.settlementComplete, true);
  assert.equal(unimplementedSettled.body.data.implementationComplete, false);

  const implementT2 = await jsonRequest('/api/task-implementations', mutation('POST', 'implement-t2', {
    taskId: t2.id,
    expectedImplementationVersion: 1,
    recordDate: '2026-09-23',
    scopeLines: [{ taskDemandScopeId: t2.demandScopes[0].id, completedQuantityScaled: 400000 }],
    materialUsages: [],
    note: null,
  }));
  assert.equal(implementT2.response.status, 201);

  const complete = await jsonRequest(`/api/demands/${demandId}/execution`);
  assert.equal(complete.body.data.state, 'implemented_settled');
  assert.equal(complete.body.data.implementedQuantityScaled, 1000000);
  assert.equal(complete.body.data.settledQuantityScaled, 1000000);
  assert.equal(complete.body.data.implementationComplete, true);
  assert.equal(complete.body.data.settlementComplete, true);
});

test('project material cannot be shrunk below task assignments after execution facts exist', async () => {
  const projectId = globalThis.__finalProjectId;
  const detail = await jsonRequest(`/api/reserve-projects/${projectId}`);
  assert.equal(detail.response.status, 200);
  const a = detail.body.data.materialRequirements.find((item) => item.model === 'A');
  const b = detail.body.data.materialRequirements.find((item) => item.model === 'B');
  const shrink = await jsonRequest(`/api/reserve-projects/${projectId}/materials`, mutation('PUT', 'shrink-after-tasks', {
    expectedVersion: detail.body.data.version,
    reason: '错误缩减',
    materials: [
      { ...a, requiredQuantityScaled: 700000 },
      { ...b, requiredQuantityScaled: 200000 },
    ],
  }));
  assert.equal(shrink.response.status, 422);
  assert.equal(shrink.body.error.code, 'PROJECT_MATERIAL_PROTECTED');
});
