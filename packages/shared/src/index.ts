export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type HealthResponse = ApiSuccess<{
  service: 'transmission-project-manager';
  stage: 'p1';
}>;

export const MEMBER_ROLES = [
  'admin',
  'project_manager',
  'implementation',
  'finance',
  'readonly',
] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];
export type ScopeType = 'all' | 'framework' | 'project';

export interface MemberScope {
  type: ScopeType;
  id: string | null;
}

export interface MemberSummary {
  id: string;
  email: string;
  displayName: string;
  role: MemberRole;
  enabled: boolean;
  version: number;
  scopes: MemberScope[];
}

export interface CurrentUser extends MemberSummary {
  authSource: 'cloudflare-access' | 'development';
}

export interface SettingVersion<T = unknown> {
  id: string;
  key: string;
  version: number;
  value: T;
  effectiveFrom: string;
  createdBy: string | null;
  createdAt: string;
}

export interface DictionaryItem<T = unknown> {
  id: string;
  dictionaryKey: string;
  itemKey: string;
  label: string;
  value: T | null;
  enabled: boolean;
  sortOrder: number;
  version: number;
}

export interface UpdateSettingRequest {
  expectedVersion: number | null;
  value: unknown;
  effectiveFrom?: string;
}

export interface UpdateMemberRequest {
  expectedVersion: number;
  displayName?: string;
  role?: MemberRole;
  enabled?: boolean;
}
