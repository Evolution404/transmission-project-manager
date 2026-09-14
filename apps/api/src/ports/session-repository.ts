export interface AuthSessionRecord {
  memberId: string;
  sessionVersion: number;
  memberSessionVersion: number;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface SessionRepository {
  findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  touchLastSeen(tokenHash: string, nowIso: string, staleBefore: string): Promise<void>;
}
