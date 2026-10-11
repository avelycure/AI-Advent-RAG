export interface HttpRequest {
  signal?: AbortSignal;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  text: string;
}

export interface HttpTransport {
  requestStream?(request: HttpRequest, onChunk: (chunk: string) => void): Promise<void>;
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
}

export function extractHttpError(status: number, text: string): string {
  let detail = text.trim();
  try {
    const payload = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
    detail =
      typeof payload.error === 'string'
        ? payload.error
        : payload.error?.message ?? payload.message ?? detail;
  } catch {
    // Preserve the plain-text response.
  }
  return `Model request failed (${status})${detail ? `: ${detail.slice(0, 300)}` : ''}`;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function httpStatusMessage(status: number): string {
  if (status === 401 || status === 403) return `Сервис модели отклонил авторизацию (HTTP ${status}).`;
  if (status === 402) return 'Сервис модели отклонил запрос из-за ограничений оплаты (HTTP 402).';
  if (status === 429) return 'Сервис модели временно ограничил частоту запросов (HTTP 429).';
  return `Сервис модели вернул ошибку HTTP ${status}.`;
}
