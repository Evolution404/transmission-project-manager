import { parseApiResponse } from './response';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) {
    if (!result.ok) throw new ApiRequestError(response.status, result.error.code, result.error.message, result.error.details);
    throw new ApiRequestError(response.status, 'HTTP_ERROR', `HTTP ${response.status}`);
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
