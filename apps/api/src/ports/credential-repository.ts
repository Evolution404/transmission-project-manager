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

export interface CredentialRepository {
  findByUsername(username: string): Promise<MemberCredentialRecord | null>;
  findByMemberId(memberId: string): Promise<MemberCredentialRecord | null>;
  recordLoginFailure(input: {
    memberId: string;
    failedLoginCount: number;
    lockedUntil: string | null;
    nowIso: string;
    auditEventId: string;
  }): Promise<void>;
  clearLoginFailures(memberId: string, nowIso: string): Promise<void>;
}
