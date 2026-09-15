import { parseApiResponse } from './response';

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.ok ? `HTTP ${response.status}` : result.error.message);
  }
  return result.data;
}

export function jsonRequestInit(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  };
}
