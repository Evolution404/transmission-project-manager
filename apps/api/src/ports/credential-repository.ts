export interface MemberCredentialRecord {
  memberId: string;
  username: string;
  enabled: boolean;
  credentialSalt: string;
  credentialVerifier: string;
  credentialAlgorithm: 'argon2id-v1';
  credentialParamsJson: string;
  mustChangePassword: boolean;
  sessionVersion: number;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastFailedLoginAt: string | null;
  credentialChangedAt: string;
}

export interface CredentialMutationInput {
  memberId: string;
  salt: string;
  verifier: string;
  paramsJson: string;
  nextSessionVersion: number;
  nowIso: string;
  auditEventId: string;
}

export interface ResetCredentialInput extends CredentialMutationInput {
  actorId: string;
  idempotency: {
    key: string;
    operation: string;
    requestHash: string;
    responseJson: string;
    statusCode: number;
  };
}

export interface CredentialRepository {
  findByUsername(username: string): Promise<MemberCredentialRecord | null>;
  findByMemberId(memberId: string): Promise<MemberCredentialRecord | null>;
  changeOwnCredential(input: CredentialMutationInput): Promise<void>;
  resetCredential(input: ResetCredentialInput): Promise<void>;
  recordLoginFailure(input: {
    memberId: string;
    failedLoginCount: number;
    lockedUntil: string | null;
    nowIso: string;
    auditEventId: string;
  }): Promise<void>;
  clearLoginFailures(memberId: string, nowIso: string): Promise<void>;
}
