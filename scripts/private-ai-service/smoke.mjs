import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanAddress } from './server.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
const base = `http://${process.env.PRIVATE_AI_HOST ?? lanAddress()}:${process.env.PRIVATE_AI_PORT ?? 8787}`;
const key = (await readFile(join(directory, '.local/api-key.txt'), 'utf8')).trim();
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const report = { timestamp: new Date().toISOString(), networkUrl: base, client: 'тот же Mac, обращение к LAN-адресу', checks: [], responses: [] };
const check = (name, pass, details) => { report.checks.push({ name, pass, details }); if (!pass) process.exitCode = 1; };
const post = (body) => fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
const unauthorized = await fetch(base + '/api/status'); check('API key required', unauthorized.status === 401, unauthorized.status);
const status = await fetch(base + '/api/status', { headers });
const serviceStatus = await status.json();
check('LAN HTTP access', status.status === 200, serviceStatus);
const context = await post({ messages: [{ role: 'user', content: 'Привет' }], num_ctx: 16384 }); check('max context rejected', context.status === 400, await context.json());
const oversized = await post({ messages: [{ role: 'user', content: 'я'.repeat(3000) }] }); check('input budget rejected', oversized.status === 413, await oversized.json());
if (serviceStatus.limits.requestsPerMinute < 5) {
  process.stdout.write('Жду сброса rate limit перед тремя запросами: 61 с\n');
  await delay(61000);
}
const results = await Promise.all(['Ответь одним словом: привет.', 'Сколько будет 2 + 2? Ответь только числом.', 'Назови столицу Франции. Ответь одним словом.'].map(async (content) => {
  const response = await post({ messages: [{ role: 'user', content }], max_tokens: 32 });
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  return { httpStatus: response.status, prompt: content, text: events.filter((event) => event.type === 'delta').map((event) => event.text).join(''),
    statuses: events.filter((event) => event.type === 'status'), final: events.at(-1) };
}));
report.responses = results;
check('three real Qwen responses completed', results.every((result) => result.final.type === 'done'), results.map((r) => r.final.type));
check('real requests waited in queue', results.filter((result) => result.statuses.some((s) => s.position > 0)).length >= 2, results.map((r) => r.final.metrics?.queueMs));
const rateStatuses = [];
for (let i = 0; i < serviceStatus.limits.requestsPerMinute + 1; i++) {
  const rejected = await post({ messages: [{ role: 'user', content: 'test' }], num_ctx: 16384 });
  rateStatuses.push(rejected.status);
  if (rejected.status === 429) {
    check('real server rate limit', Boolean(rejected.headers.get('retry-after')), { statuses: rateStatuses, retryAfter: rejected.headers.get('retry-after') });
    break;
  }
}
if (!rateStatuses.includes(429)) check('real server rate limit', false, rateStatuses);
const after = await fetch(base + '/api/status', { headers }); report.after = await after.json();
await mkdir(join(directory, 'reports'), { recursive: true });
await writeFile(join(directory, 'reports/real-qwen.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
