import type {
  FrameworkProgressSummary,
  MilestoneDueSummary,
  MilestoneSummary,
  ProjectGapSummary,
  QuarterProgressSummary,
} from '@tpm/shared';
import type { AnalysisRepository } from './ports/analysis-repository.ts';

const DEFAULT_RULE_MODE = 'ratio' as const;
const DEFAULT_RULE_THRESHOLD_BP = 8000;

export async function currentAnalysisRule(repository: AnalysisRepository) {
  return repository.currentRule();
}

function ratioBasisPoints(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const value = (BigInt(numerator) * 10000n + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function elapsedMonths(businessYear: number, asOf: string) {
  const year = Number(asOf.slice(0, 4));
  if (year < businessYear) return 0;
  if (year > businessYear) return 12;
  return Number(asOf.slice(5, 7));
}

function quarterStatus(businessYear: number, quarter: 1 | 2 | 3 | 4, asOf: string): QuarterProgressSummary['status'] {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const start = `${businessYear}-${String(startMonth).padStart(2, '0')}-01`;
  const end = analysisMonthEnd(`${businessYear}-${String(endMonth).padStart(2, '0')}`);
  if (asOf < start) return 'upcoming';
  if (asOf > end) return 'ended';
  return 'in_progress';
}

export function analysisMonthEnd(month: string) {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

function dayDifference(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

export async function calculateFrameworkProgress(repository: AnalysisRepository, frameworkId: string, asOf: string): Promise<FrameworkProgressSummary | null> {
  const framework = await repository.findFramework(frameworkId);
  if (!framework) return null;
  const storedRule = await currentAnalysisRule(repository);
  const rule = storedRule ?? { id: 'default', version: 1, mode: DEFAULT_RULE_MODE, thresholdBasisPoints: DEFAULT_RULE_THRESHOLD_BP, effectiveFrom: '1970-01-01T00:00:00.000Z', createdAt: '1970-01-01T00:00:00.000Z' };
  const businessYear = Number(framework.startDate.slice(0, 4));
  const months = elapsedMonths(businessYear, asOf);
  const annualTargetFen = framework.annualTargetFen ?? framework.totalAmountFen;
  const planMeta = await repository.planMeta(frameworkId, businessYear, months);
  const hasCustom = planMeta.countAll > 0;
  let plannedToDateFen = planMeta.cumulativeFen;
  if (!hasCustom && annualTargetFen > 0) plannedToDateFen = Number((BigInt(annualTargetFen) * BigInt(months)) / 12n);
  const actualToDateFen = await repository.actualFrameworkOccurrence(frameworkId, businessYear, asOf);
  const annualTargetConfigured = annualTargetFen > 0;
  const plannedProgressBasisPoints = annualTargetConfigured ? ratioBasisPoints(plannedToDateFen, annualTargetFen) : null;
  const actualProgressBasisPoints = annualTargetConfigured ? ratioBasisPoints(actualToDateFen, annualTargetFen) : null;
  const attainmentBasisPoints = plannedToDateFen > 0 ? ratioBasisPoints(actualToDateFen, plannedToDateFen) : null;
  let lagging = false;
  if (annualTargetConfigured && plannedToDateFen > 0) {
    if (rule.mode === 'ratio') lagging = BigInt(actualToDateFen) * 10000n < BigInt(plannedToDateFen) * BigInt(rule.thresholdBasisPoints);
    else if (plannedToDateFen > actualToDateFen) lagging = BigInt(plannedToDateFen - actualToDateFen) * 10000n >= BigInt(annualTargetFen) * BigInt(rule.thresholdBasisPoints);
  }
  const quarters: QuarterProgressSummary[] = ([1, 2, 3, 4] as const).map((quarter) => ({ quarter, cumulativeTargetBasisPoints: quarter * 2500, status: quarterStatus(businessYear, quarter, asOf) }));
  return { frameworkId, frameworkCode: framework.code, frameworkName: framework.name, businessYear, asOf, annualTargetFen, annualTargetConfigured, plannedToDateFen, actualToDateFen, plannedProgressBasisPoints, actualProgressBasisPoints, attainmentBasisPoints, lagging, planSource: hasCustom ? 'custom' : 'default', rule, quarters };
}

export async function calculateProjectGaps(repository: AnalysisRepository, frameworkId: string, asOf: string): Promise<ProjectGapSummary[]> {
  const businessYear = Number(asOf.slice(0, 4));
  const months = elapsedMonths(businessYear, asOf);
  const rows = await repository.projectGapFacts(frameworkId, businessYear, months, asOf);
  return rows.map((row) => ({ ...row, gapFen: Math.max(0, row.plannedToDateFen - row.actualToDateFen) })).sort((a, b) => b.gapFen - a.gapFen || a.projectName.localeCompare(b.projectName));
}

export function calculateMilestoneDue(base: MilestoneSummary, asOf: string): MilestoneDueSummary {
  if (base.status === 'completed') return { ...base, dueMonth: base.month ? `${base.businessYear}-${String(base.month).padStart(2, '0')}` : null, dueDate: base.specificDate, needsDate: base.datePrecision === 'unknown', reminderDue: false, reminderLeadDays: null, overdue: false };
  if (base.datePrecision === 'unknown') return { ...base, dueMonth: null, dueDate: null, needsDate: true, reminderDue: false, reminderLeadDays: null, overdue: false };
  const dueMonth = `${base.businessYear}-${String(base.month).padStart(2, '0')}`;
  if (base.datePrecision === 'month') {
    const first = `${dueMonth}-01`, end = analysisMonthEnd(dueMonth);
    return { ...base, dueMonth, dueDate: null, needsDate: false, reminderDue: asOf >= first, reminderLeadDays: null, overdue: asOf > end };
  }
  const dueDate = base.specificDate!;
  const diff = dayDifference(asOf, dueDate);
  const leadDays = base.leadDays.find((item) => item === diff) ?? null;
  return { ...base, dueMonth, dueDate, needsDate: false, reminderDue: diff < 0 || leadDays !== null, reminderLeadDays: leadDays, overdue: diff < 0 };
}

export function bigintToSafeNumber(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : null;
}
