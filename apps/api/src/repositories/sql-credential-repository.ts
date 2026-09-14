import type { CredentialRepository, MemberCredentialRecord } from '../ports/credential-repository.ts';
import type { DatabasePort } from '../ports/database.ts';

type CredentialRow = {
  id: string;
  username: string;
  enabled: number;
  credential_salt: string;
  credential_verifier: string;
  credential_algorithm: 'argon2id-v1';
  credential_params_json: string;
  must_change_password: number;
  session_version: number;
  failed_login_count: number;
  locked_until: string | null;
  last_failed_login_at: string | null;
  credential_changed_at: string;
};

const credentialColumns = `id,username,enabled,credential_salt,credential_verifier,credential_algorithm,
  credential_params_json,must_change_password,session_version,failed_login_count,locked_until,last_failed_login_at,credential_changed_at`;

function toRecord(row: CredentialRow): MemberCredentialRecord {
  return {
    memberId: row.id,
    username: row.username,
    enabled: row.enabled === 1,
    credentialSalt: row.credential_salt,
    credentialVerifier: row.credential_verifier,
    credentialAlgorithm: row.credential_algorithm,
    credentialParamsJson: row.credential_params_json,
    mustChangePassword: row.must_change_password === 1,
    sessionVersion: row.session_version,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    lastFailedLoginAt: row.last_failed_login_at,
    credentialChangedAt: row.credential_changed_at,
  };
}

export class SqlCredentialRepository implements CredentialRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findByUsername(username: string): Promise<MemberCredentialRecord | null> {
    const row = await this.database.first<CredentialRow>({
      sql: `SELECT ${credentialColumns} FROM members WHERE username=? COLLATE NOCASE LIMIT 1`,
      params: [username],
    });
    return row ? toRecord(row) : null;
  }

  async findByMemberId(memberId: string): Promise<MemberCredentialRecord | null> {
    const row = await this.database.first<CredentialRow>({
      sql: `SELECT ${credentialColumns} FROM members WHERE id=? LIMIT 1`,
      params: [memberId],
    });
    return row ? toRecord(row) : null;
  }

  async recordLoginFailure(input: {
    memberId: string;
    failedLoginCount: number;
    lockedUntil: string | null;
    nowIso: string;
    auditEventId: string;
  }): Promise<void> {
    await this.database.batch([
      {
        sql: 'UPDATE members SET failed_login_count=?,locked_until=?,last_failed_login_at=?,updated_at=? WHERE id=?',
        params: [input.failedLoginCount, input.lockedUntil, input.nowIso, input.nowIso, input.memberId],
      },
      {
        sql: `INSERT INTO audit_events
              (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              VALUES (?,NULL,'auth.login_failed','member',?,NULL,?,?)`,
        params: [
          input.auditEventId,
          input.memberId,
          JSON.stringify({ failedLoginCount: input.failedLoginCount, locked: Boolean(input.lockedUntil) }),
          input.nowIso,
        ],
      },
    ]);
  }

  async clearLoginFailures(memberId: string, nowIso: string): Promise<void> {
    await this.database.run({
      sql: 'UPDATE members SET failed_login_count=0,locked_until=NULL,last_failed_login_at=NULL,updated_at=? WHERE id=?',
      params: [nowIso, memberId],
    });
  }
}
