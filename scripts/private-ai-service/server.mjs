import * as timers from 'node:timers';
import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const defaults = { model: 'qwen3.8:27b', port: 8787, maxQueue: 8, rateLimit: 3,
  rateWindowMs: 60000, timeoutMs: 180000, maxContext: 8192, maxOutput: 1024, maxInputBytes: 4096 };
const privateAddress = (host) => host === '127.0.0.1' || /^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
export function lanAddress() {
  return Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === 'IPv4' && privateAddress(item.address))?.address ?? '127.0.0.1';
}
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function createService(options) {
  const config = { ...defaults, ...options };
  if (!config.apiKey || config.apiKey.length < 24) throw new Error('API key must contain at least 24 characters');
  const backend = config.fetch ?? fetch;
  const upstream = 'http://127.0.0.1:11434';
  const queue = [];
  let active;
  let closing = false;
  let requests = [];
  const stats = { completed: 0, failed: 0, cancelled: 0 };
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const event = (job, data) => { if (!job.res.destroyed) job.res.write(`${JSON.stringify(data)}\n`); };
  const positions = () => queue.forEach((job, i) => event(job, { type: 'status', phase: 'queued', position: i + 1 }));
  const pump = () => {
    if (active || closing) return;
    const job = queue.shift();
    if (!job) return;
    active = job;
    positions();
    event(job, { type: 'status', phase: 'running', position: 0 });
    void run(job).finally(() => { active = undefined; pump(); });
  };
  async function run(job) {
    const started = performance.now();
    const timeout = timers.setTimeout(() => job.abort.abort(new Error('Превышено время запроса')), config.timeoutMs);
    let reader;
    try {
      const info = await backend(`${upstream}/api/show`, { method: 'POST', body: JSON.stringify({ model: config.model }),
        headers: { 'Content-Type': 'application/json' }, signal: job.abort.signal });
      if (!info.ok) throw new Error('Локальная модель не найдена');
      const metadata = await info.json();
      if (metadata.remote_model || metadata.remote_host || /(?:[:-]cloud)(?:$|[:-])/i.test(config.model)) throw new Error('Облачные модели запрещены');
      const response = await backend(`${upstream}/api/chat`, { method: 'POST', signal: job.abort.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model,
          messages: [{ role: 'system', content: 'Отвечай по-русски. Выполняй просьбу пользователя. Не утверждай, что изменил файлы или выполнил внешние действия.' }, ...job.messages],
          stream: true, think: false, keep_alive: '2m', options: { num_ctx: job.context, num_predict: job.output, temperature: job.temperature, repeat_penalty: 1 } }) });
      if (!response.ok || !response.body) throw new Error(`Ollama недоступна (HTTP ${response.status})`);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', text = '', done = false, bytes = 0, firstTokenMs;
      const line = (value) => {
        if (!value.trim()) return;
        const data = JSON.parse(value);
        if (data.error) throw new Error('Ошибка генерации Ollama');
        const delta = data.message?.content ?? '';
        if (delta) { firstTokenMs ??= performance.now() - started; text += delta; event(job, { type: 'delta', text: delta }); }
        if (data.done) {
          if (!text.trim()) throw new Error('Модель вернула пустой ответ');
          done = true;
          event(job, { type: 'done', model: config.model, truncated: data.done_reason === 'length',
            metrics: { queueMs: job.started - job.queued, elapsedMs: performance.now() - started, firstTokenMs,
              inputTokens: data.prompt_eval_count, outputTokens: data.eval_count,
              generationMs: data.eval_duration === undefined ? undefined : data.eval_duration / 1e6,
              tokensPerSecond: data.eval_duration > 0 ? data.eval_count * 1e9 / data.eval_duration : undefined } });
        }
      };
      job.started = started;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error('Ответ превышает лимит');
        buffer += decoder.decode(result.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      }
      line(buffer + decoder.decode());
      if (!done) throw new Error('Поток модели прерван');
      stats.completed++;
    } catch (error) {
      if (job.res.destroyed) stats.cancelled++;
      else { stats.failed++; event(job, { type: 'error', message: job.abort.signal.aborted ? 'Запрос отменён или истёк таймаут' : error.message }); }
    } finally {
      timers.clearTimeout(timeout);
      await reader?.cancel().catch(() => {});
      if (!job.res.destroyed) job.res.end();
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, mime] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        res.end(await readFile(join(directory, 'web', name))); return;
      }
      const key = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const supplied = Buffer.from(key), expected = Buffer.from(config.apiKey);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ApiError(401, 'Нужен API-ключ');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new ApiError(403, 'Запрос с другого сайта запрещён');
      if (req.method === 'GET' && url.pathname === '/api/status') {
        json(res, 200, { model: config.model, running: Boolean(active), waiting: queue.length, stats,
          limits: { maxContext: config.maxContext, maxOutput: config.maxOutput, maxInputBytes: config.maxInputBytes,
            maxQueue: config.maxQueue, requestsPerMinute: config.rateLimit } }); return;
      }
      if (req.method !== 'POST' || url.pathname !== '/api/chat') throw new ApiError(404, 'Маршрут не найден');
      if (closing) throw new ApiError(503, 'Сервис останавливается');
      const now = Date.now();
      requests = requests.filter((time) => time > now - config.rateWindowMs);
      if (requests.length >= config.rateLimit) {
        res.setHeader('Retry-After', String(Math.ceil((requests[0] + config.rateWindowMs - now) / 1000)));
        throw new ApiError(429, 'Лимит частоты запросов. Попробуйте позже');
      }
      requests.push(now);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'Нужен application/json');
      const chunks = []; let size = 0;
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > 32768) { reject(new ApiError(413, 'Тело запроса больше 32 КиБ')); return; }
          chunks.push(chunk);
        });
        req.on('end', resolve);
        req.on('error', reject);
        req.on('aborted', () => reject(new ApiError(400, 'Загрузка запроса прервана')));
      });
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'Некорректный JSON'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError(400, 'Нужен объект запроса');
      const allowed = ['messages', 'num_ctx', 'max_tokens', 'temperature'];
      if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new ApiError(400, 'Неизвестный параметр запроса');
      const messages = payload.messages;
      if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20 || messages.at(-1)?.role !== 'user' ||
        messages.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim())) throw new ApiError(400, 'Нужно 1–20 сообщений user/assistant, последнее — user');
      const context = payload.num_ctx ?? config.maxContext, output = payload.max_tokens ?? config.maxOutput, temperature = payload.temperature ?? 0.2;
      if (!Number.isInteger(context) || context < 4096 || context > config.maxContext) throw new ApiError(400, `num_ctx: 4096–${config.maxContext}`);
      if (!Number.isInteger(output) || output < 1 || output > config.maxOutput) throw new ApiError(400, `max_tokens: 1–${config.maxOutput}`);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw new ApiError(400, 'temperature: 0–1');
      const inputBytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0);
      if (inputBytes > Math.min(config.maxInputBytes, context - output - 1024)) throw new ApiError(413, 'Контекст слишком большой: сократите историю или текст');
      if (active && queue.length >= config.maxQueue) throw new ApiError(503, 'Очередь заполнена');
      const job = { res, messages: messages.map(({ role, content }) => ({ role, content })), context, output, temperature,
        abort: new AbortController(), queued: performance.now() };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      res.flushHeaders();
      res.on('close', () => {
        if (res.writableEnded) return;
        job.abort.abort();
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); stats.cancelled++; positions(); }
      });
      queue.push(job); positions(); pump();
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status ?? 500, { error: error.status ? error.message : 'Ошибка сервиса' });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return { server, config, async stop() {
    closing = true;
    active?.abort.abort();
    for (const job of queue.splice(0)) { event(job, { type: 'error', message: 'Сервис остановлен' }); job.res.end(); }
    await new Promise((resolve) => server.close(resolve));
  } };
}

async function main() {
  const local = join(directory, '.local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  const keyPath = join(local, 'api-key.txt');
  let apiKey;
  try { apiKey = (await readFile(keyPath, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; apiKey = randomBytes(32).toString('hex'); await writeFile(keyPath, apiKey + '\n', { mode: 0o600, flag: 'wx' }); }
  const host = process.env.PRIVATE_AI_HOST ?? lanAddress();
  if (!privateAddress(host)) throw new Error('Укажите частный IPv4-адрес домашней сети или 127.0.0.1');
  const port = Number(process.env.PRIVATE_AI_PORT ?? defaults.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Некорректный порт');
  const service = createService({ apiKey, port });
  service.server.listen(port, host, () => {
    process.stdout.write(`Private AI: http://${host}:${port}\nAPI key file: ${keyPath}\nStop: Ctrl+C\n`);
  });
  service.server.on('error', (error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.stop(); });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
