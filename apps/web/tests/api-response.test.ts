import { describe, expect, it } from 'vitest';
import { parseApiResponse } from '../src/api/response';

describe('API response parsing', () => {
  it('preserves a valid JSON API response', async () => {
    const response = new Response(JSON.stringify({ ok: true, data: { value: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(parseApiResponse<{ value: number }>(response)).resolves.toEqual({ ok: true, data: { value: 1 } });
  });

  it('turns a plaintext proxy 500 into a stable Chinese error instead of leaking JSON syntax errors', async () => {
    const response = new Response('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });

    await expect(parseApiResponse(response)).rejects.toThrow('系统接口暂时不可用，请稍后重试');
  });

  it('turns malformed JSON into a stable Chinese error', async () => {
    const response = new Response('{not-json', {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(parseApiResponse(response)).rejects.toThrow('系统接口返回异常，请稍后重试');
  });
});
