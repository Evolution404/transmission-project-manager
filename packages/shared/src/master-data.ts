export interface MaterialSummary {
  id: string;
  code: string | null;
  name: string;
  model: string;
  unit: string;
  enabled: boolean;
  version: number;
}

export type VoltageSystemType = 'AC' | 'DC';
export type DemandLocationType = 'whole_line' | 'tower' | 'tower_range';

/**
 * 将用户输入的杆塔编号转换为数据库标准形式。
 *
 * 允许明显的全角输入法差异，但不猜测业务语义。主号 1..999 补足三位，
 * 主号 >=1000 保持自然位数；可选支号使用 `-正整数`，不补零。
 */
export function normalizeTowerNo(input: string): string | null {
  const normalized = input
    .trim()
    .normalize('NFKC')
    .replace(/^#/, '');
  const match = /^(\d+)(?:-(\d+))?$/.exec(normalized);
  if (!match) return null;

  const main = Number(match[1]);
  const branch = match[2] === undefined ? null : Number(match[2]);
  if (!Number.isSafeInteger(main) || main <= 0) return null;
  if (branch !== null && (!Number.isSafeInteger(branch) || branch <= 0)) return null;

  const mainText = main <= 999 ? String(main).padStart(3, '0') : String(main);
  return branch === null ? `#${mainText}` : `#${mainText}-${branch}`;
}

/**
 * 比较两个可识别的杆塔编号的自然业务顺序。
 * 主号按数值升序；同主号时无支号在前，随后支号按数值升序。
 * 无法识别的值排在可识别值之后，仅作为防御性兜底；正式写入仍应先通过 normalizeTowerNo。
 */
export function compareTowerNo(left: string, right: string): number {
  const parse = (value: string): { main: number; branch: number | null; normalized: string } | null => {
    const normalized = normalizeTowerNo(value);
    if (!normalized) return null;
    const match = /^#(\d+)(?:-(\d+))?$/.exec(normalized);
    if (!match) return null;
    return {
      main: Number(match[1]),
      branch: match[2] === undefined ? null : Number(match[2]),
      normalized,
    };
  };
  const a = parse(left), b = parse(right);
  if (a && b) {
    if (a.main !== b.main) return a.main - b.main;
    if (a.branch === null && b.branch !== null) return -1;
    if (a.branch !== null && b.branch === null) return 1;
    if (a.branch !== null && b.branch !== null && a.branch !== b.branch) return a.branch - b.branch;
    return 0;
  }
  if (a) return -1;
  if (b) return 1;
  return left.localeCompare(right, 'zh-CN', { numeric: true });
}

export interface VoltageLevelSummary {
  id: string;
  code: string;
  displayName: string;
  systemType: VoltageSystemType;
  nominalKv: number;
  sortOrder: number;
  enabled: boolean;
  version: number;
}

export interface TransmissionLineSummary {
  id: string;
  voltageLevelId: string;
  voltageLevelName: string;
  lineCode: string | null;
  lineName: string;
  enabled: boolean;
  version: number;
  towerOrderVersion: number;
  towerCount?: number;
  matchedHistoricalName?: string | null;
}

export interface TeamSummary {
  id: string;
  code: string | null;
  name: string;
  enabled: boolean;
  version: number;
}

export interface TowerTypeSummary {
  id: string;
  code: string | null;
  label: string;
  sortOrder: number;
  enabled: boolean;
  version: number;
}

export type CustomFieldDataType = 'text' | 'integer' | 'quantity' | 'year' | 'boolean' | 'date' | 'single_select' | 'multi_select';
export const CUSTOM_FIELD_ENTITY_TYPES = ['physical_tower', 'transmission_line', 'line_tower_position', 'demand', 'project', 'project_task'] as const;
export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[number];

export interface CustomFieldDefinitionSummary {
  id: string;
  entityType: CustomFieldEntityType;
  fieldKey: string;
  label: string;
  dataType: CustomFieldDataType;
  required: boolean;
  filterable: boolean;
  options: unknown;
  validation: Record<string, unknown>;
  sortOrder: number;
  enabled: boolean;
  version: number;
}

export interface PhysicalTowerSummary {
  id: string;
  assetCode: string | null;
  towerTypeId: string | null;
  towerTypeLabel: string | null;
  maintenanceTeamId: string | null;
  maintenanceTeamName: string | null;
  enabled: boolean;
  version: number;
  customValues: Record<string, unknown>;
  customFieldsVersion: number | null;
  linePositionCount?: number;
}

export interface CustomFieldValueSetSummary {
  entityType: CustomFieldEntityType;
  entityId: string;
  version: number | null;
  values: Record<string, unknown>;
}

export interface LineTowerPositionSummary {
  id: string;
  lineId: string;
  lineName: string;
  physicalTowerId: string;
  physicalAssetCode: string | null;
  towerNo: string;
  sortRank: number;
  positionLabel: string | null;
  towerTypeId: string | null;
  towerTypeLabel: string | null;
  maintenanceTeamId: string | null;
  maintenanceTeamName: string | null;
  enabled: boolean;
  version: number;
  matchedHistoricalNo?: string | null;
}

export interface TransmissionLineNameHistoryEntry {
  id: string;
  lineId: string;
  lineName: string;
  validFrom: string;
  validTo: string;
  changedBy: string;
  reason: string | null;
}

export interface LineTowerPositionNoHistoryEntry {
  id: string;
  lineTowerPositionId: string;
  lineId: string;
  towerNo: string;
  validFrom: string;
  validTo: string;
  changedBy: string;
  reason: string | null;
}

export interface StructuredDemandLocationInput {
  voltageLevelId: string;
  lineId: string;
  locationType: DemandLocationType;
  startTowerPositionId?: string | null;
  endTowerPositionId?: string | null;
}

export interface CreateStructuredDemandRequest extends StructuredDemandLocationInput {
  sequenceNo: string;
  materials?: DemandMaterialInput[];
  year?: number | null;
  category?: string | null;
  owner?: string | null;
}

export interface DemandSummary {
  voltageLevelId: string | null;
  lineId: string | null;
  locationType: DemandLocationType | null;
  startTowerPositionId: string | null;
  endTowerPositionId: string | null;
  id: string;
  sequenceNo: string;
  year: number | null;
  voltageRaw: string;
  voltageVerified: string | null;
  lineName: string;
  section: string;
  category: string | null;
  owner: string | null;
  version: number;
  createdAt: string;
}

export interface DemandMaterialInput {
  rawModel: string;
  materialId?: string | null;
  quantityScaled: number;
  unit?: string | null;
}

export type CreateDemandRequest = CreateStructuredDemandRequest;

export type DemandSourceSummary =
  | {
      type: 'import';
      batchId: string;
      fileName: string;
      fileSha256: string;
      sheetName: string;
      rowNumber: number;
      raw: Record<string, unknown>;
      rows?: Array<{
        fileName: string;
        fileSha256: string;
        sheetName: string;
        rowNumber: number;
        raw: Record<string, unknown>;
      }>;
    }
  | {
      type: 'manual';
      raw: Record<string, unknown>;
    };

export interface DemandMaterialSummary {
  id: string;
  rawModel: string;
  quantityScaled: number;
  unit: string | null;
  material: MaterialSummary | null;
  version?: number;
}

export interface DemandDetail extends DemandSummary {
  source: DemandSourceSummary;
  materials: DemandMaterialSummary[];
}
