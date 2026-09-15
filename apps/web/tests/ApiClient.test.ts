import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, jsonRequestInit } from '../src/api/client';

afterEach(() => vi.unstubAllGlobals());

describe('shared API client', () => {
  it('returns response data for a successful API response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { value: 7 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(apiRequest<{ value: number }>('/api/example')).resolves.toEqual({ value: 7 });
  });

  it('throws the business error message returned by the API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: '数据已变化，请刷新后重试' },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(apiRequest('/api/example')).rejects.toThrow('数据已变化，请刷新后重试');
  });

  it('builds JSON mutation requests with a stable supplied idempotency key', () => {
    const init = jsonRequestInit('POST', { value: 1 }, 'idem-fixed');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('idem-fixed');
    expect(init.body).toBe(JSON.stringify({ value: 1 }));
  });

  it('generates an idempotency key when the caller omits one', () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-idem') });
    const init = jsonRequestInit('PATCH', { value: 2 });
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('generated-idem');
  });
});
