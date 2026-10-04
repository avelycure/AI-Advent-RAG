import { requestUrl } from 'obsidian';
import { httpStatusMessage } from './http';
import type { HttpRequest, HttpResponse, HttpTransport } from './http';

export class ObsidianHttpTransport implements HttpTransport {
  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    let response;
    try {
      response = await requestUrl({
        url: request.url,
        method: request.method ?? 'GET',
        headers: request.headers,
        contentType: request.body === undefined ? undefined : 'application/json',
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        throw: false,
      });
    } catch {
      throw new Error('Не удалось подключиться к сервису модели. Проверьте сеть и адрес API.');
    }

    if (response.status >= 400) {
      throw new Error(httpStatusMessage(response.status));
    }
    return { status: response.status, data: response.json as T, text: response.text };
  }
}
