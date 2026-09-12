import type { ApiResponse } from '@tpm/shared';

const NON_JSON_ERROR = '系统接口暂时不可用，请稍后重试';
const MALFORMED_JSON_ERROR = '系统接口返回异常，请稍后重试';

export async function parseApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(NON_JSON_ERROR);
  }

  try {
    const result = await response.json() as ApiResponse<T>;
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new Error(MALFORMED_JSON_ERROR);
    }
    return result;
  } catch (cause) {
    if (cause instanceof Error && cause.message === MALFORMED_JSON_ERROR) throw cause;
    throw new Error(MALFORMED_JSON_ERROR);
  }
}
