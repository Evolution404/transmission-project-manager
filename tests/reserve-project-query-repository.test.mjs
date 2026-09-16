import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlReserveProjectQueryRepository } from '../apps/api/src/repositories/sql-reserve-project-query-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,business_year INTEGER,owner TEXT,status TEXT,reserve_version INTEGER,framework_id TEXT,version INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE demands (id TEXT PRIMARY KEY,sequence_no TEXT,business_year INTEGER,voltage_raw TEXT,voltage_verified TEXT,line_name TEXT,section_text TEXT,category_key TEXT,owner TEXT);
    CREATE TABLE project_demand_links (id TEXT PRIMARY KEY,project_id TEXT,demand_id TEXT,created_at TEXT);
    CREATE TABLE reserve_categories (id TEXT PRIMARY KEY,category_key TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE materials (id TEXT PRIMARY KEY,model TEXT,unit TEXT,enabled INTEGER);
    CREATE TABLE project_material_requirements (id TEXT PRIMARY KEY,project_id TEXT,material_id TEXT,model TEXT,unit TEXT,required_quantity_scaled INTEGER,unit_price_scaled INTEGER,amount_fen INTEGER,reserve_category_id TEXT,active INTEGER,version INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE project_material_revisions (id TEXT PRIMARY KEY,project_id TEXT,project_version INTEGER,reason TEXT,before_json TEXT,after_json TEXT,created_at TEXT);
    CREATE TABLE project_tasks (id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE project_releases (id TEXT PRIMARY KEY,project_id TEXT,created_at TEXT);
    CREATE TABLE task_demand_scopes (id TEXT PRIMARY KEY,task_id TEXT,demand_id TEXT);
    CREATE TABLE task_material_requirements (id TEXT PRIMARY KEY,task_id TEXT,project_material_requirement_id TEXT,required_quantity_scaled INTEGER);
    INSERT INTO projects VALUES ('p1','Project',2026,'A','draft',0,'fw1',2,'c','u');
    INSERT INTO demands VALUES ('d1','001',2026,'110kV',NULL,'Line','S1',NULL,NULL);
    INSERT INTO project_demand_links VALUES ('l1','p1','d1','c');
    INSERT INTO reserve_categories VALUES ('rc1','bird','防鸟',1);
    INSERT INTO materials VALUES ('m1','M1','件',1);
    INSERT INTO project_material_requirements VALUES ('pm1','p1','m1','M1','件',10000,2000000,20000,'rc1',1,1,'c','u');
    INSERT INTO project_material_revisions VALUES ('rev1','p1',2,'调整','[]','[]','c');
    INSERT INTO project_tasks VALUES ('t1','p1');
    INSERT INTO task_demand_scopes VALUES ('s1','t1','d1');
    INSERT INTO task_material_requirements VALUES ('tm1','t1','pm1',4000);
  `);
  return { sqlite, repository: new SqlReserveProjectQueryRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('reserve project query repository hydrates projects and protection facts portably', async () => {
  const { sqlite, repository } = fixture();
  try {
    const project = await repository.find('p1');
    assert.equal(project?.demandLinks[0].demandId, 'd1');
    assert.equal(project?.materialRequirements[0].reserveCategory?.label, '防鸟');
    assert.equal(project?.knownMaterialAmountFen, 20000);
    assert.equal((await repository.list({ limit: 10, stage: 'all', cursor: null, access: null })).length, 1);
    assert.deepEqual(await repository.findState('p1'), { id: 'p1', frameworkId: 'fw1', status: 'draft', reserveVersion: 0, version: 2 });
    assert.equal(await repository.validateDemandIds(['d1']), true);
    assert.equal(await repository.validateDemandIds(['missing']), false);
    assert.deepEqual(await repository.listUsedDemandIds('p1'), ['d1']);
    assert.equal((await repository.getAssignedMaterialQuantities('p1')).get('pm1'), 4000);
    assert.equal((await repository.listMaterialRevisions('p1'))[0].reason, '调整');
    const resolved = await repository.resolveMaterials([{ id: 'pm1', materialId: 'm1', model: '', unit: '', requiredQuantityScaled: 10000, unitPriceScaled: 2000000, reserveCategoryId: 'rc1' }]);
    assert.equal(resolved?.[0].model, 'M1');
    assert.equal(resolved?.[0].amountFen, 20000);
  } finally { sqlite.close(); }
});

test('reserve project list filters unreleased projects in SQL and keyset-pages without gaps', async () => {
  const { sqlite, repository } = fixture();
  try {
    sqlite.exec(`
      UPDATE projects SET created_at='2026-09-03T00:00:00.000Z' WHERE id='p1';
      INSERT INTO projects VALUES ('p2','Second',2026,'B','confirmed',1,'fw1',1,'2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z');
      INSERT INTO projects VALUES ('p4','Same timestamp',2026,'D','draft',0,'fw1',1,'2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z');
      INSERT INTO projects VALUES ('p3','Released',2026,'C','confirmed',1,'fw1',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO project_releases VALUES ('r3','p3','2026-09-04T00:00:00.000Z');
    `);

    const reserve = await repository.list({ limit: 10, stage: 'reserve', cursor: null, access: null });
    assert.deepEqual(reserve.map((item) => item.id), ['p1', 'p4', 'p2']);

    const first = await repository.list({ limit: 1, stage: 'all', cursor: null, access: null });
    assert.deepEqual(first.map((item) => item.id), ['p1']);
    const second = await repository.list({
      limit: 1,
      stage: 'all',
      cursor: { createdAt: first[0].createdAt, id: first[0].id },
      access: null,
    });
    const third = await repository.list({
      limit: 1,
      stage: 'all',
      cursor: { createdAt: second[0].createdAt, id: second[0].id },
      access: null,
    });
    const fourth = await repository.list({
      limit: 1,
      stage: 'all',
      cursor: { createdAt: third[0].createdAt, id: third[0].id },
      access: null,
    });
    assert.deepEqual([...first, ...second, ...third, ...fourth].map((item) => item.id), ['p1', 'p4', 'p2', 'p3']);

    // p2 is behind newer out-of-scope rows. A post-LIMIT permission filter would return an empty page here.
    const scoped = await repository.list({ limit: 1, stage: 'all', cursor: null, access: { projectIds: ['p2'], frameworkIds: [] } });
    assert.deepEqual(scoped.map((item) => item.id), ['p2']);
  } finally { sqlite.close(); }
});
