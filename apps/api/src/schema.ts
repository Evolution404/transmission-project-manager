import type { SchemaReadinessSummary } from '@tpm/shared';

export const REQUIRED_MIGRATION = '0012_master_data_write_guards.sql';

let readyCache: SchemaReadinessSummary | null = null;

export async function schemaReadiness(db: D1Database): Promise<SchemaReadinessSummary> {
  if (readyCache?.ready) return readyCache;
  try {
    const row = await db.prepare(
      `SELECT
         (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS current_migration,
         EXISTS(SELECT 1 FROM d1_migrations WHERE name=?) AS ready`,
    ).bind(REQUIRED_MIGRATION).first<{ current_migration: string | null; ready: number }>();
    const result: SchemaReadinessSummary = {
      ready: Number(row?.ready ?? 0) === 1,
      currentMigration: row?.current_migration ?? null,
      requiredMigration: REQUIRED_MIGRATION,
    };
    if (result.ready) readyCache = result;
    return result;
  } catch {
    return {
      ready: false,
      currentMigration: null,
      requiredMigration: REQUIRED_MIGRATION,
    };
  }
}
