export interface AuthSessionRecord {
  memberId: string;
  sessionVersion: number;
  memberSessionVersion: number;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CreateSessionRecord {
  id: string;
  memberId: string;
  tokenHash: string;
  sessionVersion: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface SessionRepository {
  findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  create(record: CreateSessionRecord): Promise<void>;
  touchLastSeen(tokenHash: string, nowIso: string, staleBefore: string): Promise<void>;
  revokeByTokenHash(tokenHash: string, revokedAt: string): Promise<void>;
  revokeAllForMember(memberId: string, revokedAt: string): Promise<void>;
}
