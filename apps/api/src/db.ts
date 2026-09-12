import type {
  DictionaryItem,
  MemberRole,
  MemberScope,
  MemberSummary,
  SettingVersion,
} from '@tpm/shared';

interface MemberRow {
  id: string;
  email: string;
  display_name: string;
  role: MemberRole;
  enabled: number;
  version: number;
}

interface ScopeRow {
  member_id: string;
  scope_type: MemberScope['type'];
  scope_id: string | null;
}

interface SettingRow {
  id: string;
  setting_key: string;
  version: number;
  value_json: string;
  effective_from: string;
  created_by: string | null;
  created_at: string;
}

interface DictionaryRow {
  id: string;
  dictionary_key: string;
  item_key: string;
  label: string;
  value_json: string | null;
  enabled: number;
  sort_order: number;
  version: number;
}

function mapScopes(rows: ScopeRow[]): Map<string, MemberScope[]> {
  const grouped = new Map<string, MemberScope[]>();
  for (const row of rows) {
    const list = grouped.get(row.member_id) ?? [];
    list.push({ type: row.scope_type, id: row.scope_id });
    grouped.set(row.member_id, list);
  }
  return grouped;
}

function mapMember(row: MemberRow, scopes: MemberScope[]): MemberSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    enabled: row.enabled === 1,
    version: row.version,
    scopes,
  };
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  return JSON.parse(value) as unknown;
}

export async function findMemberByEmail(db: D1Database, email: string): Promise<MemberSummary | null> {
  const member = await db.prepare(
    `SELECT id, email, display_name, role, enabled, version
     FROM members WHERE email = ? COLLATE NOCASE LIMIT 1`,
  ).bind(email).first<MemberRow>();
  if (!member) return null;

  const scopeResult = await db.prepare(
    `SELECT member_id, scope_type, scope_id
     FROM member_scopes WHERE member_id = ? ORDER BY scope_type, scope_id`,
  ).bind(member.id).all<ScopeRow>();

  return mapMember(member, (scopeResult.results ?? []).map((row) => ({ type: row.scope_type, id: row.scope_id })));
}

export async function listMembers(db: D1Database): Promise<MemberSummary[]> {
  const [memberResult, scopeResult] = await db.batch([
    db.prepare(
      `SELECT id, email, display_name, role, enabled, version
       FROM members ORDER BY enabled DESC, display_name COLLATE NOCASE, email COLLATE NOCASE`,
    ),
    db.prepare(
      `SELECT member_id, scope_type, scope_id
       FROM member_scopes ORDER BY member_id, scope_type, scope_id`,
    ),
  ]);

  const members = ((memberResult?.results ?? []) as unknown) as MemberRow[];
  const scopes = mapScopes(((scopeResult?.results ?? []) as unknown) as ScopeRow[]);
  return members.map((member) => mapMember(member, scopes.get(member.id) ?? []));
}

export async function listCurrentSettings(db: D1Database): Promise<SettingVersion[]> {
  const result = await db.prepare(
    `SELECT s.id, s.setting_key, s.version, s.value_json, s.effective_from, s.created_by, s.created_at
     FROM settings_versions s
     INNER JOIN (
       SELECT setting_key, MAX(version) AS version
       FROM settings_versions
       GROUP BY setting_key
     ) latest
       ON latest.setting_key = s.setting_key AND latest.version = s.version
     ORDER BY s.setting_key`,
  ).all<SettingRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    key: row.setting_key,
    version: row.version,
    value: parseJson(row.value_json),
    effectiveFrom: row.effective_from,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function getSettingHistory(db: D1Database, key: string): Promise<SettingVersion[]> {
  const result = await db.prepare(
    `SELECT id, setting_key, version, value_json, effective_from, created_by, created_at
     FROM settings_versions WHERE setting_key = ? ORDER BY version DESC`,
  ).bind(key).all<SettingRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    key: row.setting_key,
    version: row.version,
    value: parseJson(row.value_json),
    effectiveFrom: row.effective_from,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function listDictionary(db: D1Database, key?: string): Promise<DictionaryItem[]> {
  const statement = key
    ? db.prepare(
      `SELECT id, dictionary_key, item_key, label, value_json, enabled, sort_order, version
       FROM dictionary_items WHERE dictionary_key = ?
       ORDER BY sort_order, item_key`,
    ).bind(key)
    : db.prepare(
      `SELECT id, dictionary_key, item_key, label, value_json, enabled, sort_order, version
       FROM dictionary_items ORDER BY dictionary_key, sort_order, item_key`,
    );

  const result = await statement.all<DictionaryRow>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    dictionaryKey: row.dictionary_key,
    itemKey: row.item_key,
    label: row.label,
    value: parseJson(row.value_json),
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    version: row.version,
  }));
}
