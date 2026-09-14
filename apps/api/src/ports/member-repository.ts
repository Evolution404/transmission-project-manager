import type { MemberSummary } from '@tpm/shared';

export interface MemberRepository {
  findById(id: string): Promise<MemberSummary | null>;
}
