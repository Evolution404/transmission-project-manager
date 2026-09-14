import type { BootstrapAdminRecord, MemberAdminRepository } from '../ports/member-admin-repository.ts';
import type { DatabasePort } from '../ports/database.ts';

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
}
