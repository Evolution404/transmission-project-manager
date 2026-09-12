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
  stage: 'p1.2';
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

export type MemberLifecycleStatus = 'pending_first_login' | 'active' | 'disabled';

export interface MemberSummary {
  id: string;
  username: string;
  displayName: string;
  role: MemberRole;
  enabled: boolean;
  version: number;
  scopes: MemberScope[];
  invitedAt: string | null;
  firstLoginAt: string | null;
  lastLoginAt: string | null;
  lifecycleStatus: MemberLifecycleStatus;
  mustChangePassword: boolean;
}

export interface CurrentUser extends MemberSummary {
  authSource: 'session';
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

export const CREDENTIAL_KDF = {
  algorithm: 'argon2id-v1',
  memoryCostKiB: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
  version: 19,
  saltLength: 16,
} as const;

export interface CredentialKdfDescriptor {
  algorithm: typeof CREDENTIAL_KDF.algorithm;
  salt: string;
  memoryCostKiB: typeof CREDENTIAL_KDF.memoryCostKiB;
  timeCost: typeof CREDENTIAL_KDF.timeCost;
  parallelism: typeof CREDENTIAL_KDF.parallelism;
  hashLength: typeof CREDENTIAL_KDF.hashLength;
  version: typeof CREDENTIAL_KDF.version;
}

export interface DerivedCredentialInput {
  salt: string;
  credential: string;
}

export interface CreateMemberRequest extends DerivedCredentialInput {
  username: string;
  displayName: string;
  role: MemberRole;
  enabled?: boolean;
  scopes: MemberScope[];
}

export interface UpdateMemberRequest {
  expectedVersion: number;
  displayName?: string;
  role?: MemberRole;
  enabled?: boolean;
  scopes?: MemberScope[];
}

export interface BootstrapAdminRequest extends DerivedCredentialInput {
  username: string;
  displayName: string;
}

export interface LoginKdfRequest {
  username: string;
}

export interface LoginRequest {
  username: string;
  credential: string;
}

export interface ChangePasswordRequest {
  currentCredential: string;
  next: DerivedCredentialInput;
}

export type ResetPasswordRequest = DerivedCredentialInput;
