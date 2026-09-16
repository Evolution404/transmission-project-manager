export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface SchemaReadinessSummary {
  ready: boolean;
  currentMigration: string | null;
  requiredMigration: string;
}

export type HealthResponse = ApiSuccess<{
  service: 'transmission-project-manager';
  schema: SchemaReadinessSummary;
}>;
