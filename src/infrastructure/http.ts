export interface HttpRequest {
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
