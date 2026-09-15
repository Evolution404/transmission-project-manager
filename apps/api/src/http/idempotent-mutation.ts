import type { Context } from 'hono';
import type { AppEnv } from '../auth.ts';
import { SqlIdempotencyRepository } from '../repositories/sql-idempotency-repository.ts';
import { resolvePersistence } from '../runtime/persistence.ts';
import { apiError, hashValue } from './request-values.ts';

export type IdempotentMutation = { key: string; operation: string; hash: string };

export async function replayIdempotentMutation(c: Context<AppEnv>, mutation: IdempotentMutation): Promise<Response | null> {
  const { database } = resolvePersistence(c.env);
  const row = await new SqlIdempotencyRepository(database).findByKey(mutation.key);
  if (!row) return null;
  if (row.actorMemberId !== c.get('currentUser').id || row.operation !== mutation.operation || row.requestHash !== mutation.hash) {
    return c.json(apiError('IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同请求'), 409);
  }
  return new Response(row.responseJson, {
    status: row.statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function beginIdempotentMutation(c: Context<AppEnv>, body: unknown): Promise<IdempotentMutation | Response> {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  const mutation = { key, operation: `${c.req.method}:${c.req.path}`, hash: await hashValue(body) };
  return (await replayIdempotentMutation(c, mutation)) ?? mutation;
}
