import { request as httpsRequest } from 'node:https';
import { httpStatusMessage } from './http';
import type { HttpRequest, HttpResponse, HttpTransport } from './http';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class NodeHttpsTransport implements HttpTransport {
  constructor(private readonly allowedOrigin: string) {}

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.origin !== this.allowedOrigin) {
      throw new Error('Запрос к модели заблокирован: разрешён только официальный API endpoint.');
    }

    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    return new Promise<HttpResponse<T>>((resolve, reject) => {
      const clientRequest = httpsRequest(
        url,
        {
          method: request.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            ...(body === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(body).toString(),
                }),
            ...request.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let receivedBytes = 0;
          response.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            receivedBytes += buffer.length;
            if (receivedBytes > MAX_RESPONSE_BYTES) {
              response.destroy(new Error('Response exceeds the safe size limit.'));
              return;
            }
            chunks.push(buffer);
          });
          response.on('error', () => {
            reject(new Error('Не удалось получить ответ от сервиса модели.'));
          });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 0;
            if (status >= 400) {
              reject(new Error(httpStatusMessage(status)));
              return;
            }
            try {
              resolve({ status, data: JSON.parse(text) as T, text });
            } catch {
              reject(new Error('Сервис модели вернул некорректный JSON-ответ.'));
            }
          });
        },
      );

      clientRequest.setTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
        clientRequest.destroy(new Error('Request timed out.'));
      });
      clientRequest.on('error', () => {
        reject(new Error('Не удалось подключиться к сервису модели. Проверьте сеть и адрес API.'));
      });
      if (body !== undefined) clientRequest.write(body);
      clientRequest.end();
    });
  }
}
