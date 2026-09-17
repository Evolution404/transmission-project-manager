import type { Context } from 'hono';
import type { LifecycleState } from '@tpm/shared';
import { hasScope, type AppEnv } from './auth.ts';
import { positiveIntegerValue } from './http/request-values.ts';

export const MAX_EXECUTION_ITEMS = 100;

export function cleanExecutionText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function nullableExecutionText(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const text = cleanExecutionText(value);
  return text && text.length <= max ? text : undefined;
}

export const positiveExecutionInteger = positiveIntegerValue;

export function nonNegativeExecutionInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export const expectedExecutionVersion = positiveIntegerValue;

export function validExecutionYear(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : undefined;
}

export function validExecutionDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const date = cleanExecutionText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
}

export function parseExecutionQuantityScaled(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  const raw = cleanExecutionText(value);
  const match = raw.match(/^(\d+)(?:\.(\d{1,4}))?$/);
  if (!match) return null;
  const scaled = Number(match[1]) * 10000 + Number((match[2] ?? '').padEnd(4, '0'));
  return Number.isSafeInteger(scaled) && scaled > 0 ? scaled : null;
}

export function addExecutionDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function executionLifecycleState(implemented: boolean, settled: boolean): LifecycleState {
  if (implemented && settled) return 'implemented_settled';
  if (implemented) return 'implemented_unsettled';
  if (settled) return 'unimplemented_settled';
  return 'unimplemented_unsettled';
}

export function hasExecutionProjectAccess(c: Context<AppEnv>, projectId: string, frameworkId: string | null) {
  const user = c.get('currentUser');
  return user.role === 'admin'
    || hasScope(user.scopes, 'project', projectId)
    || user.scopes.some((scope) => scope.type === 'all')
    || Boolean(frameworkId && hasScope(user.scopes, 'framework', frameworkId));
}
