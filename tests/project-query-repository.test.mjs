import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlProjectQueryRepository } from '../apps/api/src/repositories/sql-project-query-repository.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE demands (
      id TEXT PRIMARY KEY, sequence_no TEXT NOT NULL, business_year INTEGER, category_key TEXT,
      voltage_raw TEXT NOT NULL, voltage_verified TEXT, line_name TEXT NOT NULL, section_text TEXT NOT NULL,
      source_type TEXT NOT NULL, source_file_name TEXT, source_sheet TEXT, source_row_number INTEGER
    );
    CREATE TABLE materials (
      id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, model TEXT NOT NULL, unit TEXT NOT NULL,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE demand_materials (
      id TEXT PRIMARY KEY, demand_id TEXT NOT NULL, raw_model TEXT NOT NULL, material_id TEXT,
      quantity_scaled INTEGER NOT NULL, unit TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,business_year INTEGER,owner TEXT,status TEXT NOT NULL,
      reserve_version INTEGER NOT NULL,framework_id TEXT,version INTEGER NOT NULL,created_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE demand_allocations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, demand_material_id TEXT NOT NULL,
      quantity_scaled INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE project_cost_lines (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,demand_allocation_id TEXT,label TEXT NOT NULL,
      unit_price_scaled INTEGER,amount_fen INTEGER,price_source TEXT,price_date TEXT,tax_inclusive INTEGER
    );
    CREATE TABLE reserve_categories (id TEXT PRIMARY KEY,category_key TEXT,label TEXT,enabled INTEGER,version INTEGER);
    CREATE TABLE category_mappings (id TEXT PRIMARY KEY,demand_category_key TEXT,reserve_category_id TEXT,version INTEGER);
    CREATE TABLE category_cost_allocations (id TEXT PRIMARY KEY,project_id TEXT,cost_line_id TEXT,reserve_category_id TEXT,amount_fen INTEGER);
    CREATE TABLE project_versions (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,reserve_version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
      known_amount_fen INTEGER NOT NULL,missing_price_count INTEGER NOT NULL,completeness_basis_points INTEGER NOT NULL,
      reason TEXT,confirmed_by TEXT,confirmed_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES
      ('p1','Project 1',2026,'Alice','draft',0,NULL,2,'admin','2026-09-14T02:00:00.000Z','2026-09-14T02:10:00.000Z'),
      ('p2','Project 2',2025,'Bob','confirmed',1,NULL,3,'admin','2026-09-14T01:00:00.000Z','2026-09-14T01:10:00.000Z');
    INSERT INTO demands VALUES
      ('d1','001',2026,'防断线','220kV','220kV','龙城线','#1—#2','import','a.xlsx','S',2),
      ('d2','002',2026,'防断线','220kV','220kV','龙城线','#3','manual',NULL,NULL,NULL),
      ('d3','003',2025,'防鸟','110kV','110kV','江北线','#5','manual',NULL,NULL,NULL);
    INSERT INTO materials VALUES
      ('m1','M1','金具','Model-A','套',1,2),
      ('m2','M2','线夹','Model-B','只',1,1);
    INSERT INTO demand_materials VALUES
      ('dm1','d1','Model-A','m1',100000,'套'),
      ('dm2','d2','Model-A','m1',50000,'套'),
      ('dm3','d3','Model-B','m2',30000,'只');
    INSERT INTO demand_allocations VALUES
      ('a1','p1','dm1',40000,'t'),
      ('a2','p2','dm3',30000,'t');
    INSERT INTO project_cost_lines VALUES
      ('c1','p1','material','a1','Model-A',250000,10000,'quote','2026-09-01',1),
      ('c2','p1','construction',NULL,'施工费',NULL,5000,NULL,NULL,NULL);
    INSERT INTO reserve_categories VALUES ('rc1','material','材料费',1,1);
    INSERT INTO category_mappings VALUES ('map1','防断线','rc1',1);
    INSERT INTO category_cost_allocations VALUES ('cca1','p1','c1','rc1',10000);
    INSERT INTO project_versions VALUES
      ('pv2','p1',2,'{}',15000,0,10000,'second','admin','2026-09-14T03:00:00.000Z'),
      ('pv1','p1',1,'{}',10000,1,5000,NULL,'admin','2026-09-14T02:30:00.000Z');
  `);
  return { db, repo: new SqlProjectQueryRepository(new SqliteDatabaseAdapter(db)) };
}

test('project query repository pages only remaining reserve candidates', async () => {
  const { db, repo } = setup();
  try {
    const first = await repo.listCandidates({ limit: 1, cursor: null });
    assert.deepEqual(first.items.map((item) => item.demandMaterialId), ['dm1']);
    assert.equal(first.items[0].allocatedQuantityScaled, 40000);
    assert.equal(first.items[0].remainingQuantityScaled, 60000);
    assert.equal(first.items[0].material?.id, 'm1');
    assert.deepEqual(first.items[0].source, { type: 'import', fileName: 'a.xlsx', sheetName: 'S', rowNumber: 2 });
    assert.equal(first.nextCursor, 'dm1');

    const second = await repo.listCandidates({ limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.items.map((item) => item.demandMaterialId), ['dm2']);
    assert.deepEqual(second.items[0].source, { type: 'manual' });
    assert.equal(second.nextCursor, null);
  } finally { db.close(); }
});

test('project suggestions aggregate the complete remaining pool rather than a candidate page', async () => {
  const { db, repo } = setup();
  try {
    const groups = await repo.listSuggestions(50);
    assert.deepEqual(groups, [
      { year: 2026, category: '防断线', voltage: '220kV', lineName: '龙城线', itemCount: 2 },
    ]);
  } finally { db.close(); }
});

test('project list applies project scope and cursor while keeping cost completeness', async () => {
  const { db, repo } = setup();
  try {
    const scoped = await repo.listProjects({ allowedProjectIds: ['p1'], cursor: null, limit: 50 });
    assert.deepEqual(scoped.items.map((item) => item.id), ['p1']);
    assert.equal(scoped.items[0].knownAmountFen, 15000);
    assert.equal(scoped.items[0].missingPriceCount, 0);
    assert.equal(scoped.items[0].completenessBasisPoints, 10000);

    const first = await repo.listProjects({ allowedProjectIds: null, cursor: null, limit: 1 });
    assert.deepEqual(first.items.map((item) => item.id), ['p1']);
    assert.deepEqual(first.nextCursor, { createdAt: '2026-09-14T02:00:00.000Z', id: 'p1' });
    const second = await repo.listProjects({ allowedProjectIds: null, cursor: first.nextCursor, limit: 1 });
    assert.deepEqual(second.items.map((item) => item.id), ['p2']);
  } finally { db.close(); }
});

test('project detail hydrates allocations, material summary, costs and category totals', async () => {
  const { db, repo } = setup();
  try {
    const detail = await repo.getProjectDetail('p1');
    assert.equal(detail?.id, 'p1');
    assert.equal(detail?.allocations.length, 1);
    assert.equal(detail?.allocations[0].demandMaterialId, 'dm1');
    assert.equal(detail?.materialSummary[0].quantityScaled, 40000);
    assert.equal(detail?.costLines.length, 2);
    assert.equal(detail?.costLines.find((line) => line.id === 'c1')?.suggestedReserveCategoryId, 'rc1');
    assert.deepEqual(detail?.categories, [{ reserveCategoryId: 'rc1', key: 'material', label: '材料费', amountFen: 10000 }]);
    assert.equal(detail?.classifiedAmountFen, 10000);
    assert.equal(detail?.unclassifiedAmountFen, 5000);
    assert.equal(await repo.getProjectDetail('missing'), null);
  } finally { db.close(); }
});

test('project query repository reads reserve categories, mappings and immutable history', async () => {
  const { db, repo } = setup();
  try {
    assert.deepEqual(await repo.listReserveCategories(), [
      { id: 'rc1', key: 'material', label: '材料费', enabled: true, version: 1 },
    ]);
    assert.deepEqual(await repo.listCategoryMappings(), [
      { id: 'map1', demandCategory: '防断线', reserveCategoryId: 'rc1', version: 1 },
    ]);
    assert.deepEqual((await repo.getProjectHistory('p1')).map((item) => item.reserveVersion), [2, 1]);
    assert.equal(await repo.getProjectHistory('missing'), null);
  } finally { db.close(); }
});
