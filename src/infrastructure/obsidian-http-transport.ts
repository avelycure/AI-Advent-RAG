import { requestUrl } from 'obsidian';
import { extractHttpError, type HttpRequest, type HttpResponse, type HttpTransport } from './http';

export class ObsidianHttpTransport implements HttpTransport {
  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    let response;
    try {
      const responsePromise = requestUrl({
        url: request.url,
        method: request.method ?? 'GET',
        headers: request.headers,
        contentType: request.body === undefined ? undefined : 'application/json',
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        throw: false,
      });
      response = await withTimeout(responsePromise, request.timeoutMs ?? 120_000);
    } catch (error) {
      console.error('AI Advent RAG model request failed.', error);
      throw new Error(
        'Не удалось подключиться к локальной Ollama. Убедитесь, что приложение запущено.',
      );
    }

    if (response.status >= 400) {
      console.error('AI Advent RAG model HTTP error.', extractHttpError(response.status, response.text));
      throw new Error(`Ollama вернула ошибку HTTP ${response.status}.`);
    }
    return { status: response.status, data: response.json as T, text: response.text };
  }
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error(`Модель не ответила за ${Math.round(timeoutMs / 1000)} секунд.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}
