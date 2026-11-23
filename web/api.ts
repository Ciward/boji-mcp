export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(message: string, status = 0, code = 'NETWORK_ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function request<T>(path: string, csrfToken: string | null, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const mutation = init.method && !['GET', 'HEAD'].includes(init.method.toUpperCase());
  if (mutation && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('暂时无法连接 Boji。请检查网络后重试；当前草稿仍保留。');
  }
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch {
    throw new ApiError(response.status === 401 ? '登录已过期，请重新登录。' : '服务器返回了无法识别的响应，请稍后重试。', response.status, 'INVALID_RESPONSE');
  }
  if (!response.ok) {
    const detail = body as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(detail?.error?.message || (response.status === 401 ? '登录已过期，请重新登录。' : `请求未完成（${response.status}），请重试。`), response.status, detail?.error?.code || 'REQUEST_FAILED', detail?.error?.details);
  }
  return body as T;
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '操作未完成，请稍后重试。';
