export type AnalysisLagMode = 'ratio' | 'gap';
export type QuarterStatus = 'upcoming' | 'in_progress' | 'ended';
export type MilestoneDatePrecision = 'month' | 'day' | 'unknown';
export type MilestoneStatus = 'open' | 'completed';
export type NotificationOutboxStatus = 'pending' | 'leased' | 'sent' | 'failed' | 'unknown';
export type BackupKind = 'daily' | 'monthly';
export type BackupStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AnalysisRuleSummary {
  id: string;
  version: number;
  mode: AnalysisLagMode;
  thresholdBasisPoints: number;
  effectiveFrom: string;
  createdAt: string;
}

export interface MonthlyPlanSummary {
  id: string;
  projectId: string;
  businessYear: number;
  month: number;
  targetAmountFen: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuarterProgressSummary {
  quarter: 1 | 2 | 3 | 4;
  cumulativeTargetBasisPoints: number;
  status: QuarterStatus;
}

export interface FrameworkProgressSummary {
  frameworkId: string;
  frameworkCode: string;
  frameworkName: string;
  businessYear: number;
  asOf: string;
  annualTargetFen: number;
  annualTargetConfigured: boolean;
  plannedToDateFen: number;
  actualToDateFen: number;
  plannedProgressBasisPoints: number | null;
  actualProgressBasisPoints: number | null;
  attainmentBasisPoints: number | null;
  lagging: boolean;
  planSource: 'custom' | 'default';
  rule: AnalysisRuleSummary;
  quarters: QuarterProgressSummary[];
}

export interface ProjectGapSummary {
  projectId: string;
  projectName: string;
  plannedToDateFen: number;
  actualToDateFen: number;
  gapFen: number;
}

export interface MonthlyReportSummary {
  id: string;
  frameworkId: string;
  businessMonth: string;
  revision: number;
  dataCutoffDate: string;
  ruleVersion: number;
  rule: AnalysisRuleSummary;
  snapshot: {
    progress: FrameworkProgressSummary;
    projectGaps: ProjectGapSummary[];
  };
  createdAt: string;
}

export interface MilestoneSummary {
  id: string;
  businessYear: number;
  title: string;
  owner: string | null;
  projectId: string | null;
  datePrecision: MilestoneDatePrecision;
  month: number | null;
  specificDate: string | null;
  leadDays: number[];
  status: MilestoneStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneDueSummary extends MilestoneSummary {
  dueMonth: string | null;
  dueDate: string | null;
  needsDate: boolean;
  reminderDue: boolean;
  reminderLeadDays: number | null;
  overdue: boolean;
}

export interface NotificationContactSummary {
  id: string;
  memberId: string;
  address: string;
  verifiedAt: string | null;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AlertEventSummary {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  objectType: string;
  objectId: string;
  periodKey: string;
  severity: 'info' | 'warning' | 'critical';
  state: 'active' | 'resolved';
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface NotificationOutboxSummary {
  id: string;
  eventId: string;
  recipient: string;
  status: NotificationOutboxStatus;
  leaseToken: string | null;
  leasedAt: string | null;
  leaseUntil: string | null;
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupSummary {
  id: string;
  backupDate: string;
  kind: BackupKind;
  status: BackupStatus;
  currentTableIndex: number;
  cursorRowid: number;
  manifestKey: string | null;
  chunkCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupVerificationSummary {
  backupId: string;
  verified: boolean;
  missingObjects: string[];
  mismatchedObjects: string[];
  verifiedAt: string | null;
}

export interface ReserveRemainingCategorySummary {
  reserveCategoryId: string;
  categoryKey: string;
  label: string;
  knownCurrentAmountFen: number;
}

export interface ReserveRemainingSummary {
  currentMaterialQuantityScaled: number;
  knownCurrentMaterialAmountFen: number;
  missingPriceCount: number;
  unclassifiedCurrentMaterialFen: number;
  releasedProjectCount: number;
  unscopedCommonCostFen: number;
  categories: ReserveRemainingCategorySummary[];
}

export interface AnalysisDashboardSummary {
  asOf: string;
  projectCount: number;
  demandCount: number;
  unreleasedProjectCount: number;
  pendingSettlementCount: number;
  activeAlertCount: number;
}
