import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlImportValidationRepository } from '../apps/api/src/repositories/sql-import-validation-repository.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE import_batches(id TEXT PRIMARY KEY,status TEXT,uploaded_rows INTEGER,valid_rows INTEGER,error_rows INTEGER,warning_rows INTEGER,version INTEGER,updated_at TEXT);
    CREATE TABLE import_rows(id TEXT PRIMARY KEY,batch_id TEXT,chunk_index INTEGER,sheet_name TEXT,source_row_number INTEGER,source_key TEXT,raw_json TEXT,normalized_json TEXT,errors_json TEXT,warnings_json TEXT,row_status TEXT,published_demand_id TEXT,updated_at TEXT);
    CREATE TABLE idempotency_records(idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE voltage_levels(id TEXT PRIMARY KEY,display_name TEXT,enabled INTEGER);
    CREATE TABLE transmission_lines(id TEXT PRIMARY KEY,voltage_level_id TEXT,line_name TEXT,enabled INTEGER);
    CREATE TABLE line_tower_positions(id TEXT PRIMARY KEY,line_id TEXT,tower_no TEXT,sort_rank INTEGER,enabled INTEGER);
    CREATE TABLE materials(id TEXT PRIMARY KEY,model TEXT,unit TEXT,enabled INTEGER);
    CREATE TABLE demands(id TEXT PRIMARY KEY,business_signature TEXT);
    INSERT INTO import_batches VALUES('b','draft',1,0,0,0,1,'t');
    INSERT INTO import_rows VALUES('r','b',0,'S',2,'k','{}',NULL,'[]','[]','uploaded',NULL,'t');
    INSERT INTO voltage_levels VALUES('v','110kV',1);
    INSERT INTO transmission_lines VALUES('l','v','Line A',1);
    INSERT INTO line_tower_positions VALUES('t1','l','#001',1000,1),('t2','l','#002',2000,1);
    INSERT INTO materials VALUES('m','Model','piece',1);
    INSERT INTO demands VALUES('d','sig');
  `);
  return { db, repo: new SqlImportValidationRepository(new SqliteDatabaseAdapter(db)) };
}

test('validation lookups work through DatabasePort', async () => {
  const { db, repo } = setup();
  try {
    assert.deepEqual(await repo.findVoltageByName('110kV'), { id: 'v', displayName: '110kV' });
    assert.deepEqual(await repo.findLinesByName('v', 'Line A'), [{ id: 'l', lineName: 'Line A' }]);
    assert.equal((await repo.findTowersByNumbers('l', ['#001','#002'])).length, 2);
    assert.deepEqual(await repo.findMaterials([{ model: 'Model', unit: 'piece' }]), [{ id: 'm', model: 'Model', unit: 'piece' }]);
    assert.deepEqual(await repo.findExistingBusinessSignatures(['sig','other']), ['sig']);
    assert.equal((await repo.listUploadedRows('b', 20)).length, 1);
  } finally { db.close(); }
});

test('validation commit is atomic and stale version rolls back', async () => {
  const { db, repo } = setup();
  try {
    await repo.commitValidation({ batchId:'b',expectedVersion:1,actorId:'a',now:'n',idempotencyKey:'i1',operation:'op',requestHash:'h',responseJson:'{}',nextStatus:'ready',validRows:1,errorRows:0,warningRows:0,rows:[{id:'r',normalizedJson:'{}',errorsJson:'[]',warningsJson:'[]',status:'valid'}] });
    assert.equal(db.prepare("SELECT version FROM import_batches WHERE id='b'").get().version, 2);
    assert.equal(db.prepare("SELECT row_status FROM import_rows WHERE id='r'").get().row_status, 'valid');
    await assert.rejects(repo.commitValidation({ batchId:'b',expectedVersion:1,actorId:'a',now:'n2',idempotencyKey:'i2',operation:'op',requestHash:'h2',responseJson:'{}',nextStatus:'ready',validRows:1,errorRows:0,warningRows:0,rows:[{id:'r',normalizedJson:'{"x":1}',errorsJson:'[]',warningsJson:'[]',status:'valid'}] }));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='i2'").get().count, 0);
  } finally { db.close(); }
});
