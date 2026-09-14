import type {
  BootstrapAdminRecord,
  CreateManagedMemberRecord,
  MemberAdminRepository,
  UpdateManagedMemberRecord,
  UpdateManagedMemberResult,
} from '../ports/member-admin-repository.ts';
import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';

export class SqlMemberAdminRepository implements MemberAdminRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async bootstrapAdmin(record: BootstrapAdminRecord): Promise<boolean> {
    const results = await this.database.batch([
      {
        sql: `INSERT INTO members
              (id,username,display_name,role,enabled,version,
               credential_salt,credential_verifier,credential_algorithm,credential_params_json,
               must_change_password,session_version,failed_login_count,locked_until,last_failed_login_at,
               credential_changed_at,invited_at,first_login_at,last_login_at,created_at,updated_at)
              SELECT ?,?,?,'admin',1,1,?,?,'argon2id-v1',?,0,1,0,NULL,NULL,?,?,?,?,?,?
              WHERE NOT EXISTS (SELECT 1 FROM members)`,
        params: [
          record.memberId,
          record.username,
          record.displayName,
          record.salt,
          record.verifier,
          record.credentialParamsJson,
          record.nowIso,
          record.nowIso,
          record.nowIso,
          record.nowIso,
          record.nowIso,
          record.nowIso,
        ],
      },
      {
        sql: `INSERT INTO member_scopes (id,member_id,scope_type,scope_id,created_at)
              SELECT ?,?,'all',NULL,? WHERE EXISTS (SELECT 1 FROM members WHERE id=?)`,
        params: [record.scopeId, record.memberId, record.nowIso, record.memberId],
      },
      {
        sql: `INSERT INTO audit_events
              (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              SELECT ?,NULL,'auth.bootstrap','member',?,NULL,?,?
              WHERE EXISTS (SELECT 1 FROM members WHERE id=?)`,
        params: [record.auditEventId, record.memberId, record.auditAfterJson, record.nowIso, record.memberId],
      },
    ]);
    return results[0]?.changes === 1;
  }

  async createMember(record: CreateManagedMemberRecord): Promise<void> {
    const statements = [
      {
        sql: `INSERT INTO members
              (id,username,display_name,role,enabled,version,
               credential_salt,credential_verifier,credential_algorithm,credential_params_json,
               must_change_password,session_version,failed_login_count,locked_until,last_failed_login_at,
               credential_changed_at,invited_at,first_login_at,last_login_at,created_at,updated_at)
              VALUES (?,?,?,?,?,1,?,?,'argon2id-v1',?,1,1,0,NULL,NULL,?,?,NULL,NULL,?,?)`,
        params: [
          record.memberId,
          record.username,
          record.displayName,
          record.role,
          record.enabled ? 1 : 0,
          record.salt,
          record.verifier,
          record.credentialParamsJson,
          record.nowIso,
          record.nowIso,
          record.nowIso,
          record.nowIso,
        ],
      },
      ...record.scopes.map((scope) => ({
        sql: 'INSERT INTO member_scopes (id,member_id,scope_type,scope_id,created_at) VALUES (?,?,?,?,?)',
        params: [scope.id, record.memberId, scope.type, scope.scopeId, record.nowIso],
      })),
      {
        sql: `INSERT INTO audit_events
              (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              VALUES (?,?,'member.create','member',?,NULL,?,?)`,
        params: [record.auditEventId, record.actorId, record.memberId, record.auditAfterJson, record.nowIso],
      },
      {
        sql: `INSERT INTO idempotency_records
              (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
              VALUES (?,?,?,?,?,?,?)`,
        params: [
          record.idempotency.key,
          record.actorId,
          record.idempotency.operation,
          record.idempotency.requestHash,
          record.idempotency.responseJson,
          record.idempotency.statusCode,
          record.nowIso,
        ],
      },
    ];
    await this.database.batch(statements);
  }

  async updateMember(record: UpdateManagedMemberRecord): Promise<UpdateManagedMemberResult> {
    if (record.protectsLastAdmin && await this.countEnabledAdmins() <= 1) return 'last_admin';

    const nextVersion = record.expectedVersion + 1;
    const condition = 'EXISTS (SELECT 1 FROM members WHERE id=? AND version=? AND updated_at=?)';
    const statements: DatabaseStatement[] = [
      {
        sql: `UPDATE members
              SET display_name=?,role=?,enabled=?,version=version+1,session_version=session_version+?,updated_at=?
              WHERE id=? AND version=?
              ${record.protectsLastAdmin ? "AND (SELECT COUNT(*) FROM members WHERE enabled=1 AND role='admin') > 1" : ''}`,
        params: [
          record.displayName,
          record.role,
          record.enabled ? 1 : 0,
          record.invalidateSessions ? 1 : 0,
          record.nowIso,
          record.memberId,
          record.expectedVersion,
        ],
      },
      {
        sql: `DELETE FROM member_scopes WHERE member_id=? AND ${condition}`,
        params: [record.memberId, record.memberId, nextVersion, record.nowIso],
      },
      ...record.scopes.map((scope) => ({
        sql: `INSERT INTO member_scopes (id,member_id,scope_type,scope_id,created_at)
              SELECT ?,?,?,?,? WHERE ${condition}`,
        params: [scope.id, record.memberId, scope.type, scope.scopeId, record.nowIso, record.memberId, nextVersion, record.nowIso],
      })),
      {
        sql: `INSERT INTO audit_events
              (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              SELECT ?,?,'member.update','member',?,?,?,? WHERE ${condition}`,
        params: [
          record.auditEventId,
          record.actorId,
          record.memberId,
          record.beforeJson,
          record.afterJson,
          record.nowIso,
          record.memberId,
          nextVersion,
          record.nowIso,
        ],
      },
      {
        sql: `INSERT INTO idempotency_records
              (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
              SELECT ?,?,?,?,?,?,? WHERE ${condition}`,
        params: [
          record.idempotency.key,
          record.actorId,
          record.idempotency.operation,
          record.idempotency.requestHash,
          record.idempotency.responseJson,
          record.idempotency.statusCode,
          record.nowIso,
          record.memberId,
          nextVersion,
          record.nowIso,
        ],
      },
    ];
    if (record.invalidateSessions) {
      statements.push({
        sql: `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?)
              WHERE member_id=? AND revoked_at IS NULL AND ${condition}`,
        params: [record.nowIso, record.memberId, record.memberId, nextVersion, record.nowIso],
      });
    }

    const results = await this.database.batch(statements);
    if (results[0]?.changes === 1) return 'updated';
    if (record.protectsLastAdmin && await this.countEnabledAdmins() <= 1) return 'last_admin';
    return 'version_conflict';
  }

  async usernameExists(username: string): Promise<boolean> {
    const row = await this.database.first<{ id: string }>({
      sql: 'SELECT id FROM members WHERE username=? COLLATE NOCASE LIMIT 1',
      params: [username],
    });
    return Boolean(row);
  }

  private async countEnabledAdmins(): Promise<number> {
    const row = await this.database.first<{ count: number }>({
      sql: "SELECT COUNT(*) AS count FROM members WHERE enabled=1 AND role='admin'",
    });
    return Number(row?.count ?? 0);
  }
}
