import { request as httpRequest, type ClientRequest } from 'node:http';
import type { HttpRequest, HttpResponse, HttpTransport } from './http';
import { httpStatusMessage } from './http';

/** Cancellable local HTTP for both regular Ollama calls and NDJSON streaming. */
export class LocalStreamingTransport implements HttpTransport {
  private requests = new Set<ClientRequest>();
  private disposed = false;

  dispose(): void {
    this.disposed = true;
    for (const request of this.requests) request.destroy(new Error('Запрос отменён: плагин закрыт.'));
    this.requests.clear();
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    let text = '';
    await this.requestStream(request, (chunk) => { text += chunk; });
    if (this.disposed) throw new Error('Запрос отменён: плагин закрыт.');
    try { return { status: 200, text, data: JSON.parse(text) as T }; }
    catch { throw new Error('Ollama вернула некорректный JSON.'); }
  }

  async requestStream(request: HttpRequest, onChunk: (chunk: string) => void): Promise<void> {
    if (this.disposed) throw new Error('Запрос отменён: плагин закрыт.');
    const url = new URL(request.url);
    if (url.origin !== 'http://127.0.0.1:11434') throw new Error('Запросы разрешены только к локальной Ollama.');
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(url, {
        method: request.method ?? 'GET',
        headers: body === undefined ? undefined : {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        },
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(httpStatusMessage(response.statusCode ?? 0)));
          return;
        }
        response.setEncoding('utf8');
        let size = 0;
        response.on('data', (chunk: string) => {
          try {
            size += Buffer.byteLength(chunk);
            if (size > 10 * 1024 * 1024) throw new Error('Ответ модели слишком большой.');
            if (this.disposed) throw new Error('Запрос отменён: плагин закрыт.');
            onChunk(chunk);
          } catch (error) {
            response.destroy();
            req.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        response.on('end', resolve);
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Поток ответа модели прерван.')));
      });
      this.requests.add(req);
      req.on('close', () => { this.requests.delete(req); });
      req.setTimeout(request.timeoutMs ?? 300_000, () => req.destroy(new Error('Модель слишком долго не отвечает.')));
      req.on('error', reject);
      req.end(body);
    });
  }
}
