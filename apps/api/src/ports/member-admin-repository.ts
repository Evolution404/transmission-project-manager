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

export interface MemberAdminRepository {
  bootstrapAdmin(record: BootstrapAdminRecord): Promise<boolean>;
}
