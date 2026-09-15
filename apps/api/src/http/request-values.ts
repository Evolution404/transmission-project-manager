import type { ApiError } from '@tpm/shared';

export function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function cleanText(value: unknown, max = 200): string {
  return typeof value === 'string' ? (value.trim().length <= max ? value.trim() : '') : '';
}

export function boolValue(value: unknown, fallback = true): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === 'boolean' ? value : null;
}

export function intValue(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function compactJson(value: unknown, maxLength: number): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && serialized.length <= maxLength ? serialized : null;
  } catch {
    return null;
  }
}

export async function hashValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
