import type {
  AlertEventSummary,
  NotificationContactSummary,
  NotificationOutboxSummary,
} from '@tpm/shared';
import type { DatabasePort, DatabaseStatement } from '../ports/database';
import type {
  AlertEnsureInput,
  AlertEnsureResult,
  NotificationDeliveryEvent,
  NotificationRepository,
  NotificationResultWrite,
} from '../ports/notification-repository';
import type { OperationJournalRecord } from '../ports/operation-journal-repository';

function journalStatements(input: OperationJournalRecord): DatabaseStatement[] {
  return [
    {
      sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      params: [input.auditId, input.actorId, input.action, input.objectType, input.objectId, input.before === null ? null : JSON.stringify(input.before), input.after === null ? null : JSON.stringify(input.after), input.now],
    },
    {
      sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at) VALUES (?,?,?,?,?,?,?)`,
      params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.statusCode, input.now],
    },
  ];
}

function contact(row: { id: string; member_id: string; address: string; verified_at: string | null; enabled: number; version: number; created_at: string; updated_at: string }): NotificationContactSummary {
  return { id: row.id, memberId: row.member_id, address: row.address, verifiedAt: row.verified_at, enabled: row.enabled === 1, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}

function alert(row: { id: string; rule_key: string; rule_version: number; object_type: string; object_id: string; period_key: string; severity: 'info' | 'warning' | 'critical'; state: 'active' | 'resolved'; message: string; first_seen_at: string; last_seen_at: string; resolved_at: string | null }): AlertEventSummary {
  return { id: row.id, ruleKey: row.rule_key, ruleVersion: row.rule_version, objectType: row.object_type, objectId: row.object_id, periodKey: row.period_key, severity: row.severity, state: row.state, message: row.message, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, resolvedAt: row.resolved_at };
}

function outbox(row: { id: string; event_id: string; recipient: string; status: NotificationOutboxSummary['status']; lease_token: string | null; lease_until: string | null; attempt_count: number; next_attempt_at: string; last_error: string | null; created_at: string; updated_at: string }, leasedAt: string | null = null): NotificationOutboxSummary {
  return { id: row.id, eventId: row.event_id, recipient: row.recipient, status: row.status, leaseToken: row.lease_token, leasedAt, leaseUntil: row.lease_until, attemptCount: row.attempt_count, nextAttemptAt: row.next_attempt_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at };
}

const outboxSelect = `id,event_id,recipient,status,lease_token,lease_until,attempt_count,next_attempt_at,last_error,created_at,updated_at`;

export class SqlNotificationRepository implements NotificationRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) { this.database = database; }

  async memberExists(memberId: string): Promise<boolean> {
    return Boolean(await this.database.first({ sql: `SELECT id FROM members WHERE id=? LIMIT 1`, params: [memberId] }));
  }

  async createContact(input: { contact: NotificationContactSummary; journal: OperationJournalRecord }): Promise<void> {
    const c = input.contact;
    await this.database.batch([
      { sql: `INSERT INTO notification_contacts (id,member_id,address,verified_at,enabled,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`, params: [c.id, c.memberId, c.address, c.verifiedAt, c.enabled ? 1 : 0, c.createdAt, c.updatedAt] },
      ...journalStatements(input.journal),
    ]);
  }

  async listContacts(): Promise<readonly NotificationContactSummary[]> {
    const rows = await this.database.all<{ id: string; member_id: string; address: string; verified_at: string | null; enabled: number; version: number; created_at: string; updated_at: string }>({ sql: `SELECT id,member_id,address,verified_at,enabled,version,created_at,updated_at FROM notification_contacts ORDER BY address COLLATE NOCASE` });
    return rows.map(contact);
  }

  async verifiedRecipients(frameworkId: string | null = null, projectId: string | null = null): Promise<readonly string[]> {
    const rows = await this.database.all<{ address: string }>({
      sql: `SELECT DISTINCT nc.address FROM notification_contacts nc
            INNER JOIN members m ON m.id=nc.member_id
            WHERE nc.enabled=1 AND nc.verified_at IS NOT NULL AND m.enabled=1
              AND (m.role='admin' OR EXISTS (
                SELECT 1 FROM member_scopes ms WHERE ms.member_id=m.id AND (
                  ms.scope_type='all' OR (? IS NOT NULL AND ms.scope_type='framework' AND ms.scope_id=?) OR (? IS NOT NULL AND ms.scope_type='project' AND ms.scope_id=?)
                )
              ))
            ORDER BY nc.address COLLATE NOCASE`,
      params: [frameworkId, frameworkId, projectId, projectId],
    });
    return rows.map((row) => row.address);
  }

  async ensureAlert(input: AlertEnsureInput): Promise<AlertEnsureResult> {
    const active = await this.database.first<{ id: string; first_seen_at: string }>({
      sql: `SELECT id,first_seen_at FROM alert_events WHERE rule_key=? AND rule_version=? AND object_type=? AND object_id=? AND period_key=? AND state='active' ORDER BY first_seen_at DESC,id DESC LIMIT 1`,
      params: [input.ruleKey, input.ruleVersion, input.objectType, input.objectId, input.periodKey],
    });
    if (active) {
      await this.database.run({ sql: `UPDATE alert_events SET last_seen_at=? WHERE id=? AND state='active'`, params: [input.now, active.id] });
      return { created: false, eventId: active.id, firstSeenAt: active.first_seen_at };
    }
    const count = await this.database.first<{ count: number | string }>({ sql: `SELECT COUNT(*) AS count FROM alert_events WHERE rule_key=? AND rule_version=? AND object_type=? AND object_id=? AND period_key=?`, params: [input.ruleKey, input.ruleVersion, input.objectType, input.objectId, input.periodKey] });
    const crossing = Number(count?.count ?? 0) + 1;
    const uniqueKey = `${input.ruleKey}:${input.ruleVersion}:${input.objectType}:${input.objectId}:${input.periodKey}:crossing:${crossing}`;
    const eventId = crypto.randomUUID();
    const statements: DatabaseStatement[] = [
      { sql: `INSERT INTO alert_events (id,rule_key,rule_version,object_type,object_id,period_key,severity,state,unique_event_key,message,first_seen_at,last_seen_at,resolved_at) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,NULL)`, params: [eventId, input.ruleKey, input.ruleVersion, input.objectType, input.objectId, input.periodKey, input.severity, uniqueKey, input.message, input.now, input.now] },
      ...input.recipients.map((recipient) => ({ sql: `INSERT INTO notification_outbox (id,event_id,recipient,notification_key,status,lease_token,lease_until,attempt_count,next_attempt_at,last_error,created_at,updated_at) VALUES (?,?,?,?,'pending',NULL,NULL,0,?,NULL,?,?)`, params: [crypto.randomUUID(), eventId, recipient, `${uniqueKey}:${recipient.toLowerCase()}`, input.now, input.now, input.now] } as DatabaseStatement)),
    ];
    try {
      await this.database.batch(statements);
      return { created: true, eventId, firstSeenAt: input.now };
    } catch {
      const winner = await this.database.first<{ id: string; first_seen_at: string }>({ sql: `SELECT id,first_seen_at FROM alert_events WHERE rule_key=? AND rule_version=? AND object_type=? AND object_id=? AND period_key=? AND state='active' ORDER BY first_seen_at DESC,id DESC LIMIT 1`, params: [input.ruleKey, input.ruleVersion, input.objectType, input.objectId, input.periodKey] });
      if (winner) return { created: false, eventId: winner.id, firstSeenAt: winner.first_seen_at };
      throw new Error('alert creation conflict');
    }
  }

  async ensureDailySummary(eventId: string, asOf: string, now: string, recipients: readonly string[]): Promise<void> {
    if (!recipients.length) return;
    await this.database.batch(recipients.map((recipient) => ({
      sql: `INSERT OR IGNORE INTO notification_outbox (id,event_id,recipient,notification_key,status,lease_token,lease_until,attempt_count,next_attempt_at,last_error,created_at,updated_at) VALUES (?,?,?,?,'pending',NULL,NULL,0,?,NULL,?,?)`,
      params: [crypto.randomUUID(), eventId, recipient, `daily:${asOf}:${eventId}:${recipient.toLowerCase()}`, now, now, now],
    })));
  }

  async resolveActiveAlerts(input: { ruleKey: string; objectId: string; now: string; recipients: readonly string[] }): Promise<number> {
    const active = await this.database.all<{ id: string; rule_version: number; object_type: string; object_id: string; message: string }>({ sql: `SELECT id,rule_version,object_type,object_id,message FROM alert_events WHERE rule_key=? AND object_id=? AND state='active' ORDER BY first_seen_at,id`, params: [input.ruleKey, input.objectId] });
    let recovered = 0;
    for (const event of active) {
      const recoveryId = crypto.randomUUID();
      const recoveryKey = `${input.ruleKey}.recovered:${event.id}`;
      const statements: DatabaseStatement[] = [
        { sql: `UPDATE alert_events SET state='resolved',resolved_at=?,last_seen_at=? WHERE id=? AND state='active'`, params: [input.now, input.now, event.id] },
        { sql: `INSERT OR IGNORE INTO alert_events (id,rule_key,rule_version,object_type,object_id,period_key,severity,state,unique_event_key,message,first_seen_at,last_seen_at,resolved_at) VALUES (?,?,?,?,?,?,'info','resolved',?,?,?,?,?)`, params: [recoveryId, `${input.ruleKey}.recovered`, event.rule_version, event.object_type, event.object_id, input.now.slice(0, 10), recoveryKey, `已恢复：${event.message}`, input.now, input.now, input.now] },
        ...input.recipients.map((recipient) => ({ sql: `INSERT OR IGNORE INTO notification_outbox (id,event_id,recipient,notification_key,status,lease_token,lease_until,attempt_count,next_attempt_at,last_error,created_at,updated_at) VALUES (?,(SELECT id FROM alert_events WHERE unique_event_key=?),?,?,'pending',NULL,NULL,0,?,NULL,?,?)`, params: [crypto.randomUUID(), recoveryKey, recipient, `${recoveryKey}:${recipient.toLowerCase()}`, input.now, input.now, input.now] } as DatabaseStatement)),
      ];
      await this.database.batch(statements);
      recovered += 1;
    }
    return recovered;
  }

  async listAlerts(limit: number): Promise<readonly AlertEventSummary[]> {
    const rows = await this.database.all<{ id: string; rule_key: string; rule_version: number; object_type: string; object_id: string; period_key: string; severity: 'info' | 'warning' | 'critical'; state: 'active' | 'resolved'; message: string; first_seen_at: string; last_seen_at: string; resolved_at: string | null }>({ sql: `SELECT id,rule_key,rule_version,object_type,object_id,period_key,severity,state,message,first_seen_at,last_seen_at,resolved_at FROM alert_events ORDER BY last_seen_at DESC,id DESC LIMIT ?`, params: [limit] });
    return rows.map(alert);
  }

  async claimOutbox(now: string, limit: number, leaseSeconds: number): Promise<readonly NotificationOutboxSummary[]> {
    const candidates = await this.database.all<{ id: string }>({ sql: `SELECT id FROM notification_outbox WHERE ((status IN ('pending','failed') AND next_attempt_at<=?) OR (status='leased' AND lease_until<=?)) ORDER BY next_attempt_at,created_at,id LIMIT ?`, params: [now, now, limit] });
    if (!candidates.length) return [];
    const leaseUntil = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
    const tokens = new Map<string, string>();
    const updates: DatabaseStatement[] = [];
    for (const row of candidates) {
      const token = crypto.randomUUID();
      tokens.set(row.id, token);
      updates.push({ sql: `UPDATE notification_outbox SET status='leased',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND ((status IN ('pending','failed') AND next_attempt_at<=?) OR (status='leased' AND lease_until<=?))`, params: [token, leaseUntil, now, row.id, now, now] });
    }
    await this.database.batch(updates);
    const ids = [...tokens.keys()];
    const rows = await this.database.all<{ id: string; event_id: string; recipient: string; status: NotificationOutboxSummary['status']; lease_token: string | null; lease_until: string | null; attempt_count: number; next_attempt_at: string; last_error: string | null; created_at: string; updated_at: string }>({ sql: `SELECT ${outboxSelect} FROM notification_outbox WHERE id IN (${ids.map(() => '?').join(',')}) AND status='leased'`, params: ids });
    return rows.filter((row) => row.lease_token === tokens.get(row.id)).map((row) => outbox(row, now));
  }

  async listOutbox(limit: number): Promise<readonly NotificationOutboxSummary[]> {
    const rows = await this.database.all<{ id: string; event_id: string; recipient: string; status: NotificationOutboxSummary['status']; lease_token: string | null; lease_until: string | null; attempt_count: number; next_attempt_at: string; last_error: string | null; created_at: string; updated_at: string }>({ sql: `SELECT ${outboxSelect} FROM notification_outbox ORDER BY created_at DESC,id DESC LIMIT ?`, params: [limit] });
    return rows.map((row) => outbox(row));
  }

  async findOutbox(id: string): Promise<NotificationOutboxSummary | null> {
    const row = await this.database.first<{ id: string; event_id: string; recipient: string; status: NotificationOutboxSummary['status']; lease_token: string | null; lease_until: string | null; attempt_count: number; next_attempt_at: string; last_error: string | null; created_at: string; updated_at: string }>({ sql: `SELECT ${outboxSelect} FROM notification_outbox WHERE id=? LIMIT 1`, params: [id] });
    return row ? outbox(row) : null;
  }

  async findDeliveryEvent(eventId: string): Promise<NotificationDeliveryEvent | null> {
    const row = await this.database.first<{ message: string; rule_key: string; severity: 'info' | 'warning' | 'critical' }>({ sql: `SELECT message,rule_key,severity FROM alert_events WHERE id=? LIMIT 1`, params: [eventId] });
    return row ? { message: row.message, ruleKey: row.rule_key, severity: row.severity } : null;
  }

  async completeOutboxLease(input: NotificationResultWrite): Promise<{ changed: boolean }> {
    const update: DatabaseStatement = { sql: `UPDATE notification_outbox SET status=?,lease_token=NULL,lease_until=NULL,attempt_count=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=? AND status='leased' AND lease_token=?`, params: [input.status, input.attempts, input.nextAttemptAt, input.error, input.updatedAt, input.row.id, input.leaseToken] };
    if (!input.journal) {
      const result = await this.database.run(update);
      return { changed: result.changes === 1 };
    }
    await this.database.batch([update, ...journalStatements(input.journal)]);
    return { changed: true };
  }
}
