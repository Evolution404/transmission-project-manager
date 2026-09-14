import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlNotificationRepository } from '../apps/api/src/repositories/sql-notification-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE members (id TEXT PRIMARY KEY,role TEXT,enabled INTEGER);
    CREATE TABLE member_scopes (member_id TEXT,scope_type TEXT,scope_id TEXT);
    CREATE TABLE notification_contacts (id TEXT PRIMARY KEY,member_id TEXT,address TEXT UNIQUE,verified_at TEXT,enabled INTEGER,version INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE alert_events (id TEXT PRIMARY KEY,rule_key TEXT,rule_version INTEGER,object_type TEXT,object_id TEXT,period_key TEXT,severity TEXT,state TEXT,unique_event_key TEXT UNIQUE,message TEXT,first_seen_at TEXT,last_seen_at TEXT,resolved_at TEXT);
    CREATE TABLE notification_outbox (id TEXT PRIMARY KEY,event_id TEXT,recipient TEXT,notification_key TEXT UNIQUE,status TEXT,lease_token TEXT,lease_until TEXT,attempt_count INTEGER,next_attempt_at TEXT,last_error TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT,object_type TEXT,object_id TEXT,before_json TEXT,after_json TEXT,created_at TEXT);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT,operation TEXT,request_hash TEXT,response_json TEXT,status_code INTEGER,created_at TEXT);
    INSERT INTO members VALUES ('admin','admin',1),('pm','project_manager',1);
    INSERT INTO member_scopes VALUES ('pm','framework','fw1');
    INSERT INTO notification_contacts VALUES ('c1','admin','admin@example.com','2026-01-01T00:00:00.000Z',1,1,'c','c');
    INSERT INTO notification_contacts VALUES ('c2','pm','pm@example.com','2026-01-01T00:00:00.000Z',1,1,'c','c');
  `);
  return { sqlite, repository: new SqlNotificationRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('notification repository creates alerts and claims outbox in bounded set queries', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.deepEqual(await repository.verifiedRecipients('fw1', null), ['admin@example.com','pm@example.com']);
    const now = '2026-09-14T00:00:00.000Z';
    const event = await repository.ensureAlert({ ruleKey:'analysis.lag',ruleVersion:1,objectType:'framework',objectId:'fw1',periodKey:'2026-09',severity:'warning',message:'lag',now,recipients:['admin@example.com','pm@example.com'] });
    assert.equal(event.created, true);
    const replay = await repository.ensureAlert({ ruleKey:'analysis.lag',ruleVersion:1,objectType:'framework',objectId:'fw1',periodKey:'2026-09',severity:'warning',message:'lag',now,recipients:[] });
    assert.equal(replay.created, false);
    const claimed = await repository.claimOutbox(now, 50, 90);
    assert.equal(claimed.length, 2);
    assert.ok(claimed.every((item) => item.status === 'leased' && item.leaseToken));
  } finally { sqlite.close(); }
});

test('notification result update can atomically include audit and idempotency', async () => {
  const { sqlite, repository } = fixture();
  try {
    const now = '2026-09-14T00:00:00.000Z';
    const event = await repository.ensureAlert({ ruleKey:'r',ruleVersion:1,objectType:'project',objectId:'p1',periodKey:'2026-09',severity:'info',message:'m',now,recipients:['admin@example.com'] });
    const [row] = await repository.claimOutbox(now, 1, 90);
    const updatedAt = '2026-09-14T00:01:00.000Z';
    await repository.completeOutboxLease({ row, leaseToken:row.leaseToken, status:'sent', attempts:1, nextAttemptAt:updatedAt, error:null, updatedAt, journal:{ auditId:'a1',actorId:'admin',action:'notification-outbox.result',objectType:'notification_outbox',objectId:row.id,before:{status:'leased'},after:{status:'sent'},idempotencyKey:'i1',operation:'outbox.result',requestHash:'h',responseJson:'{}',statusCode:200,now:updatedAt } });
    assert.equal((await repository.findOutbox(row.id)).status, 'sent');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='a1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='i1'").get().count, 1);
    assert.ok(event.eventId);
  } finally { sqlite.close(); }
});
