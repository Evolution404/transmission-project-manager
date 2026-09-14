import type { MemberLifecycleStatus, MemberRole, MemberScope, MemberSummary } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { MemberRepository } from '../ports/member-repository.ts';

type MemberRow = {
  id: string;
  username: string;
  display_name: string;
  role: MemberRole;
  enabled: number;
  version: number;
  must_change_password: number;
  invited_at: string | null;
  first_login_at: string | null;
  last_login_at: string | null;
};

type ScopeRow = {
  scope_type: MemberScope['type'];
  scope_id: string | null;
};

type MemberScopeRow = ScopeRow & { member_id: string };

function lifecycleStatus(row: Pick<MemberRow, 'enabled' | 'first_login_at'>): MemberLifecycleStatus {
  if (row.enabled !== 1) return 'disabled';
  return row.first_login_at ? 'active' : 'pending_first_login';
}

function toMemberSummary(member: MemberRow, scopes: MemberScope[]): MemberSummary {
  return {
    id: member.id,
    username: member.username,
    displayName: member.display_name,
    role: member.role,
    enabled: member.enabled === 1,
    version: member.version,
    scopes,
    invitedAt: member.invited_at,
    firstLoginAt: member.first_login_at,
    lastLoginAt: member.last_login_at,
    lifecycleStatus: lifecycleStatus(member),
    mustChangePassword: member.must_change_password === 1,
  };
}

export class SqlMemberRepository implements MemberRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findById(id: string): Promise<MemberSummary | null> {
    const member = await this.database.first<MemberRow>({
      sql: `SELECT id,username,display_name,role,enabled,version,must_change_password,invited_at,first_login_at,last_login_at
            FROM members WHERE id=? LIMIT 1`,
      params: [id],
    });
    if (!member) return null;
    const scopeRows = await this.database.all<ScopeRow>({
      sql: 'SELECT scope_type,scope_id FROM member_scopes WHERE member_id=? ORDER BY scope_type,scope_id',
      params: [id],
    });
    const scopes: MemberScope[] = scopeRows.map((row) => ({ type: row.scope_type, id: row.scope_id }));
    return toMemberSummary(member, scopes);
  }

  async list(): Promise<readonly MemberSummary[]> {
    const memberRows = await this.database.all<MemberRow>({
      sql: `SELECT id,username,display_name,role,enabled,version,must_change_password,invited_at,first_login_at,last_login_at
            FROM members ORDER BY enabled DESC,display_name COLLATE NOCASE,username COLLATE NOCASE`,
    });
    const scopeRows = await this.database.all<MemberScopeRow>({
      sql: 'SELECT member_id,scope_type,scope_id FROM member_scopes ORDER BY member_id,scope_type,scope_id',
    });
    const scopesByMember = new Map<string, MemberScope[]>();
    for (const row of scopeRows) {
      const scopes = scopesByMember.get(row.member_id) ?? [];
      scopes.push({ type: row.scope_type, id: row.scope_id });
      scopesByMember.set(row.member_id, scopes);
    }
    return memberRows.map((member) => toMemberSummary(member, scopesByMember.get(member.id) ?? []));
  }

  async count(): Promise<number> {
    const row = await this.database.first<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM members' });
    return Number(row?.count ?? 0);
  }

  async recordSuccessfulLogin(member: MemberSummary, nowIso: string, staleBefore: string): Promise<MemberSummary> {
    const needsWrite = !member.firstLoginAt || !member.lastLoginAt || member.lastLoginAt < staleBefore;
    if (!needsWrite) return member;
    await this.database.run({
      sql: `UPDATE members
            SET first_login_at=COALESCE(first_login_at,?),last_login_at=?
            WHERE id=? AND (first_login_at IS NULL OR last_login_at IS NULL OR last_login_at<?)`,
      params: [nowIso, nowIso, member.id, staleBefore],
    });
    return {
      ...member,
      firstLoginAt: member.firstLoginAt ?? nowIso,
      lastLoginAt: nowIso,
      lifecycleStatus: member.enabled ? 'active' : 'disabled',
    };
  }
}
