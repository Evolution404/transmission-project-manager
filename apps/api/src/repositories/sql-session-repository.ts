import type { AuthSessionRecord, CreateSessionRecord, SessionRepository } from '../ports/session-repository.ts';
import type { DatabasePort } from '../ports/database.ts';

type SessionRow = {
  member_id: string;
  session_version: number;
  member_session_version: number;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
};

export class SqlSessionRepository implements SessionRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    const row = await this.database.first<SessionRow>({
      sql: `SELECT s.member_id, s.session_version, s.last_seen_at, s.expires_at, s.revoked_at,
                   m.session_version AS member_session_version
            FROM auth_sessions s
            INNER JOIN members m ON m.id = s.member_id
            WHERE s.token_hash = ? LIMIT 1`,
      params: [tokenHash],
    });
    return row ? {
      memberId: row.member_id,
      sessionVersion: row.session_version,
      memberSessionVersion: row.member_session_version,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    } : null;
  }

  async create(record: CreateSessionRecord): Promise<void> {
    await this.database.run({
      sql: `INSERT INTO auth_sessions
            (id,member_id,token_hash,session_version,created_at,last_seen_at,expires_at,revoked_at)
            VALUES (?,?,?,?,?,?,?,NULL)`,
      params: [record.id, record.memberId, record.tokenHash, record.sessionVersion, record.createdAt, record.lastSeenAt, record.expiresAt],
    });
  }

  async touchLastSeen(tokenHash: string, nowIso: string, staleBefore: string): Promise<void> {
    await this.database.run({
      sql: 'UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ? AND revoked_at IS NULL',
      params: [nowIso, tokenHash, staleBefore],
    });
  }

  async revokeByTokenHash(tokenHash: string, revokedAt: string): Promise<void> {
    await this.database.run({
      sql: 'UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash=?',
      params: [revokedAt, tokenHash],
    });
  }

  async revokeAllForMember(memberId: string, revokedAt: string): Promise<void> {
    await this.database.run({
      sql: 'UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE member_id=? AND revoked_at IS NULL',
      params: [revokedAt, memberId],
    });
  }
}
