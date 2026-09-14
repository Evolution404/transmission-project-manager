import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlProjectReleaseRepository } from '../apps/api/src/repositories/sql-project-release-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,business_year INTEGER,owner TEXT,status TEXT NOT NULL,reserve_version INTEGER NOT NULL,
      framework_id TEXT,version INTEGER NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE demands (
      id TEXT PRIMARY KEY,sequence_no TEXT NOT NULL,business_year INTEGER,voltage_raw TEXT NOT NULL,voltage_verified TEXT,line_name TEXT NOT NULL,
      section_text TEXT NOT NULL,category_key TEXT,owner TEXT
    );
    CREATE TABLE project_demand_links (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,demand_id TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(project_id,demand_id)
    );
    CREATE TABLE reserve_categories (id TEXT PRIMARY KEY,category_key TEXT NOT NULL,label TEXT NOT NULL);
    CREATE TABLE project_material_requirements (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,material_id TEXT,model TEXT NOT NULL,unit TEXT NOT NULL,required_quantity_scaled INTEGER NOT NULL,
      unit_price_scaled INTEGER,amount_fen INTEGER,reserve_category_id TEXT,active INTEGER NOT NULL,version INTEGER NOT NULL,
      created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE project_releases (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE,release_date TEXT NOT NULL,note TEXT,project_version_snapshot INTEGER NOT NULL,
      reserve_version_snapshot INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('p1','Project',2026,'owner','confirmed',2,'fw1',7,'admin','2026-01-01','2026-02-01');
    INSERT INTO demands VALUES ('d1','D-1',2026,'220kV',NULL,'Line A','#1-#2','repair','owner');
    INSERT INTO project_demand_links VALUES ('link1','p1','d1','admin','2026-01-10');
    INSERT INTO reserve_categories VALUES ('rc1','material','Material');
    INSERT INTO project_material_requirements VALUES ('pm1','p1','m1','Model A','件',30000,1500000,45000,'rc1',1,1,'admin','2026-01-11','2026-01-11');
  `);
  const repository = new SqlProjectReleaseRepository(new SqliteDatabaseAdapter(sqlite));
  return { sqlite, repository };
}

test('project release repository reads project and immutable snapshot facts portably', async () => {
  const { sqlite, repository } = fixture();
  try {
    const project = await repository.findProject('p1');
    assert.deepEqual(project, {
      id: 'p1', name: 'Project', year: 2026, owner: 'owner', status: 'confirmed', reserveVersion: 2,
      frameworkId: 'fw1', version: 7, createdAt: '2026-01-01', updatedAt: '2026-02-01',
    });
    assert.equal(await repository.findProjectReleaseId('p1'), null);
    const snapshot = await repository.loadSnapshot('p1', 7, 2);
    assert.deepEqual(snapshot.demandLinks.map((item) => item.demandId), ['d1']);
    assert.deepEqual(snapshot.materialRequirements.map((item) => item.id), ['pm1']);
    assert.equal(snapshot.projectVersion, 7);
    assert.equal(snapshot.reserveVersion, 2);
    assert.equal(snapshot.materialRequirements[0].reserveCategory.key, 'material');
  } finally { sqlite.close(); }
});

test('project release write keeps version guard, release, audit, and idempotency atomic', async () => {
  const { sqlite, repository } = fixture();
  try {
    const snapshot = await repository.loadSnapshot('p1', 7, 2);
    const release = {
      id: 'rel1', projectId: 'p1', releaseDate: '2026-03-01', note: 'go', projectVersionSnapshot: 7,
      reserveVersionSnapshot: 2, projectVersion: 8, snapshot, createdAt: '2026-03-01T00:00:00.000Z',
    };
    await assert.rejects(repository.createRelease({
      release, expectedProjectVersion: 6, actorId: 'admin', auditId: 'audit-stale', idempotencyKey: 'idem-stale',
      operation: 'project-releases.create', requestHash: 'stale', responseJson: '{}',
    }));
    assert.equal(sqlite.prepare("SELECT version FROM projects WHERE id='p1'").get().version, 7);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM project_releases').get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-stale'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-stale'").get().count, 0);

    await repository.createRelease({
      release, expectedProjectVersion: 7, actorId: 'admin', auditId: 'audit1', idempotencyKey: 'idem1',
      operation: 'project-releases.create', requestHash: 'h1', responseJson: JSON.stringify({ ok: true, data: release }),
    });
    assert.equal(sqlite.prepare("SELECT version FROM projects WHERE id='p1'").get().version, 8);
    assert.equal(sqlite.prepare("SELECT project_id FROM project_releases WHERE id='rel1'").get().project_id, 'p1');
    const listed = await repository.listReleases('p1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].projectVersion, 8);
    assert.equal(listed[0].snapshot.materialRequirements[0].id, 'pm1');
  } finally { sqlite.close(); }
});
