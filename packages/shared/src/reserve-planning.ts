import type { MaterialSummary } from './master-data';

export type ProjectStatus = 'draft' | 'confirmed';
export type ProjectCostKind = 'material' | 'construction' | 'other';

export interface ProjectAllocationInput {
  demandMaterialId: string;
  quantityScaled: number;
}

export interface CreateProjectRequest {
  name: string;
  year: number | null;
  owner: string | null;
  allocations: ProjectAllocationInput[];
}

export interface ReplaceProjectAllocationsRequest {
  expectedVersion: number;
  allocations: ProjectAllocationInput[];
}

export interface MaterialPriceInput {
  demandAllocationId: string;
  unitPriceScaled: number | null;
  source: string | null;
  priceDate: string | null;
  taxInclusive: boolean | null;
}

export interface FixedCostInput {
  kind: Exclude<ProjectCostKind, 'material'>;
  label: string;
  amountFen: number;
  source: string | null;
  priceDate: string | null;
  taxInclusive: boolean | null;
}

export interface ReplaceProjectCostsRequest {
  expectedVersion: number;
  materialPrices: MaterialPriceInput[];
  fixedCosts: FixedCostInput[];
}

export interface ProjectCostSummary {
  knownAmountFen: number;
  missingPriceCount: number;
  completenessBasisPoints: number;
}

export interface ProjectSummary extends ProjectCostSummary {
  id: string;
  name: string;
  year: number | null;
  owner: string | null;
  status: ProjectStatus;
  reserveVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveCandidate {
  demandMaterialId: string;
  demandId: string;
  sequenceNo: string;
  year: number | null;
  category: string | null;
  voltage: string;
  lineName: string;
  section: string;
  rawModel: string;
  unit: string | null;
  material: MaterialSummary | null;
  originalQuantityScaled: number;
  allocatedQuantityScaled: number;
  remainingQuantityScaled: number;
  source: { type: 'import'; fileName: string; sheetName: string; rowNumber: number } | { type: 'manual' };
}

export interface ProjectAllocationDetail {
  id: string;
  demandMaterialId: string;
  quantityScaled: number;
  rawModel: string;
  unit: string | null;
  material: MaterialSummary | null;
  demand: {
    id: string;
    sequenceNo: string;
    year: number | null;
    category: string | null;
    voltage: string;
    lineName: string;
    section: string;
  };
  source: { type: 'import'; fileName: string; sheetName: string; rowNumber: number } | { type: 'manual' };
}

export interface ProjectMaterialSummary {
  materialId: string | null;
  rawModel: string;
  model: string;
  name: string | null;
  unit: string | null;
  quantityScaled: number;
}

export interface ProjectCostLine {
  id: string;
  kind: ProjectCostKind;
  demandAllocationId: string | null;
  label: string;
  unitPriceScaled: number | null;
  amountFen: number | null;
  source: string | null;
  priceDate: string | null;
  taxInclusive: boolean | null;
  suggestedReserveCategoryId: string | null;
}

export interface ReserveCategorySummary {
  id: string;
  key: string;
  label: string;
  enabled: boolean;
  version: number;
}

export interface ProjectCategorySummary {
  reserveCategoryId: string;
  key: string;
  label: string;
  amountFen: number;
}

export interface ProjectCategoryAllocationDetail {
  id: string;
  costLineId: string;
  reserveCategoryId: string;
  amountFen: number;
}

export interface ProjectDetail extends ProjectSummary {
  allocations: ProjectAllocationDetail[];
  materialSummary: ProjectMaterialSummary[];
  costLines: ProjectCostLine[];
  categoryAllocations: ProjectCategoryAllocationDetail[];
  categories: ProjectCategorySummary[];
  classifiedAmountFen: number;
  unclassifiedAmountFen: number;
}

export interface CategoryCostAllocationInput {
  costLineId: string;
  reserveCategoryId: string;
  amountFen: number;
}

export interface ReplaceCategoryAllocationsRequest {
  expectedVersion: number;
  allocations: CategoryCostAllocationInput[];
}

export interface ConfirmProjectRequest {
  expectedVersion: number;
  reason: string | null;
}

export interface ProjectVersionSummary extends ProjectCostSummary {
  id: string;
  projectId: string;
  reserveVersion: number;
  reason: string | null;
  confirmedAt: string;
}

export interface CategoryMappingSummary {
  id: string;
  demandCategory: string;
  reserveCategoryId: string;
  version: number;
}
