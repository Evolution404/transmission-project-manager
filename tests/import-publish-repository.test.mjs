import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlImportPublishRepository } from '../apps/api/src/repositories/sql-import-publish-repository.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function setup() {
  const db = new DatabaseSync(':memory:');
  const dir = resolve(root, 'apps/api/migrations');
  for (const name of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(resolve(dir, name), 'utf8'));
  db.prepare(`INSERT INTO members(id,username,display_name,role,credential_salt,credential_verifier,credential_algorithm,credential_params_json,credential_changed_at,created_at,updated_at)
              VALUES('admin','admin','Admin','admin','s','v','argon2id-v1','{}','t','t','t')`).run();
  db.prepare(`INSERT INTO transmission_lines(id,voltage_level_id,line_code,line_name,name_valid_from,enabled,version,tower_order_version,created_at,updated_at)
              VALUES('l','vl-ac-110',NULL,'Line A','t',1,1,1,'t','t')`).run();
  db.prepare(`INSERT INTO transmission_towers(id,line_id,tower_no,number_valid_from,sort_rank,tower_type,enabled,version,created_at,updated_at)
              VALUES('t1','l','#001','t',1000,NULL,1,1,'t','t')`).run();
  db.prepare(`INSERT INTO materials(id,code,name,model,unit,enabled,version,created_by,created_at,updated_at)
              VALUES('m','M','Material','Model','piece',1,1,'admin','t','t')`).run();
  db.prepare(`INSERT INTO import_batches(id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
              VALUES('b','f.xlsx',?,'xlsx','{}','ready',1,1,0,0,0,1,'admin','t','t',NULL)`).run('a'.repeat(64));
  const normalized = { sequenceNo:'1',voltageRaw:'110kV',voltageVerified:'110kV',voltageLevelId:'vl-ac-110',lineName:'Line A',lineId:'l',section:'#001',locationType:'tower',startTowerId:'t1',endTowerId:'t1',materialModel:'Model',quantityScaled:10000,unit:'piece',year:2026,category:null,owner:null,materialId:'m',businessSignature:'sig' };
  db.prepare(`INSERT INTO import_rows(id,batch_id,chunk_index,sheet_name,source_row_number,source_key,raw_json,normalized_json,errors_json,warnings_json,row_status,published_demand_id,created_at,updated_at)
              VALUES('r','b',0,'S',2,'src','{}',?,'[]','[]','valid',NULL,'t','t')`).run(JSON.stringify(normalized));
  return { db, repo: new SqlImportPublishRepository(new SqliteDatabaseAdapter(db)), normalized };
}

test('publish repository resolves valid rows and deduplication keys through DatabasePort', async () => {
  const { db, repo } = setup();
  try {
    assert.equal((await repo.listValidRows('b', 10)).length, 1);
    assert.deepEqual(await repo.findDemandIdsBySourceKeys(['src']), []);
    assert.deepEqual(await repo.findImportDemandIdsBySignatures('b', ['sig']), []);
  } finally { db.close(); }
});

test('publish commit creates demand trace/material and advances batch atomically', async () => {
  const { db, repo, normalized } = setup();
  try {
    await repo.commitPublish({
      batchId:'b',expectedVersion:1,actorId:'admin',now:'n',idempotencyKey:'idem',operation:'imports.publish:b',requestHash:'h',responseJson:'{}',
      fileName:'f.xlsx',fileSha256:'a'.repeat(64),nextStatus:'published',publishedRows:1,publishedAt:'n',auditId:'audit',beforePublishedRows:0,
      rows:[{ rowId:'r',demandId:'d',createDemand:true,sourceRowId:'sr',materialRowId:'dm',sourceKey:'src',sheetName:'S',rowNumber:2,rawJson:'{}',normalized }],
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM demands WHERE id='d'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM demand_source_rows WHERE demand_id='d'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM demand_materials WHERE demand_id='d'").get().count, 1);
    assert.equal(db.prepare("SELECT row_status FROM import_rows WHERE id='r'").get().row_status, 'published');
    assert.equal(db.prepare("SELECT version FROM import_batches WHERE id='b'").get().version, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem'").get().count, 1);
  } finally { db.close(); }
});

test('stale publish version leaves no partial business rows', async () => {
  const { db, repo, normalized } = setup();
  try {
    await assert.rejects(repo.commitPublish({
      batchId:'b',expectedVersion:2,actorId:'admin',now:'n',idempotencyKey:'stale',operation:'imports.publish:b',requestHash:'h',responseJson:'{}',
      fileName:'f.xlsx',fileSha256:'a'.repeat(64),nextStatus:'published',publishedRows:1,publishedAt:'n',auditId:'audit',beforePublishedRows:0,
      rows:[{ rowId:'r',demandId:'d',createDemand:true,sourceRowId:'sr',materialRowId:'dm',sourceKey:'src',sheetName:'S',rowNumber:2,rawJson:'{}',normalized }],
    }));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM demands WHERE id='d'").get().count, 0);
    assert.equal(db.prepare("SELECT row_status FROM import_rows WHERE id='r'").get().row_status, 'valid');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='stale'").get().count, 0);
  } finally { db.close(); }
});
