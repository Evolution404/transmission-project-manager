import type { MemberSummary } from '@tpm/shared';

export interface MemberRepository {
  findById(id: string): Promise<MemberSummary | null>;
  list(): Promise<readonly MemberSummary[]>;
  count(): Promise<number>;
  recordSuccessfulLogin(member: MemberSummary, nowIso: string, staleBefore: string): Promise<MemberSummary>;
}
