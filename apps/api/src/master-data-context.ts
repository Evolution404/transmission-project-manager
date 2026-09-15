import type { Context } from 'hono';
import { CUSTOM_FIELD_ENTITY_TYPES, type CustomFieldEntityType } from '@tpm/shared';
import type { AppEnv } from './auth.ts';
import { SqlMasterDataRepository } from './repositories/sql-master-data-repository.ts';
import { SqlMasterDataWriteRepository } from './repositories/sql-master-data-write-repository.ts';
import { resolvePersistence } from './runtime/persistence.ts';

export function masterDataRepository(c: Context<AppEnv>) {
  const { database } = resolvePersistence(c.env);
  return new SqlMasterDataRepository(database);
}

export function masterDataWriteRepository(c: Context<AppEnv>) {
  const { database } = resolvePersistence(c.env);
  return new SqlMasterDataWriteRepository(database);
}

export function customFieldEntityType(value: unknown): CustomFieldEntityType | null {
  return typeof value === 'string' && CUSTOM_FIELD_ENTITY_TYPES.includes(value as CustomFieldEntityType)
    ? value as CustomFieldEntityType
    : null;
}
