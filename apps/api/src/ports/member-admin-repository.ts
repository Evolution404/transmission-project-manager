export interface BootstrapAdminRecord {
  memberId: string;
  username: string;
  displayName: string;
  salt: string;
  verifier: string;
  credentialParamsJson: string;
  nowIso: string;
  scopeId: string;
  auditEventId: string;
  auditAfterJson: string;
}

import type { MemberRole, MemberScope } from '@tpm/shared';

export interface ManagedMemberScopeRecord {
  id: string;
  type: MemberScope['type'];
  scopeId: string | null;
}

export interface CreateManagedMemberRecord {
  memberId: string;
  username: string;
  displayName: string;
  role: MemberRole;
  enabled: boolean;
  salt: string;
  verifier: string;
  credentialParamsJson: string;
  nowIso: string;
  actorId: string;
  scopes: readonly ManagedMemberScopeRecord[];
  auditEventId: string;
  auditAfterJson: string;
  idempotency: {
    key: string;
    operation: string;
    requestHash: string;
    responseJson: string;
    statusCode: number;
  };
}

export interface MemberAdminRepository {
  bootstrapAdmin(record: BootstrapAdminRecord): Promise<boolean>;
  createMember(record: CreateManagedMemberRecord): Promise<void>;
  usernameExists(username: string): Promise<boolean>;
}
