import * as timers from 'node:timers';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from './server.mjs';

const apiKey = 'test-key-012345678901234567890123456';
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
const body = { messages: [{ role: 'user', content: 'Привет' }] };
async function fixture(options = {}) {
  let concurrent = 0, maximum = 0;
  const calls = [];
  const fake = async (url, options) => {
    if (url.endsWith('/api/show')) return Response.json({});
    calls.push(JSON.parse(options.body));
    concurrent++; maximum = Math.max(maximum, concurrent);
    return new Response(new ReadableStream({
      start(controller) {
        const timer = timers.setTimeout(() => {
          concurrent--;
          controller.enqueue(new TextEncoder().encode('{"message":{"content":"Ответ"}}\n{"done":true,"prompt_eval_count":10,"eval_count":2,"eval_duration":1000000000}\n'));
          controller.close();
          options.signal.removeEventListener('abort', abort);
        }, 60);
        const abort = () => { timers.clearTimeout(timer); concurrent--; controller.error(new Error('Cancelled')); };
        options.signal.addEventListener('abort', abort, { once: true });
      },
    }));
  };
  const service = createService({ apiKey, rateLimit: 100, fetch: fake, ...options });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const send = (payload = body, extra = {}) => fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify(payload), ...extra });
  return { ...service, base, send, calls, maximum: () => maximum };
}
const events = async (response) => (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

test('API key, same-origin access, static chat and status', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/api/status`)).status, 401);
    assert.equal((await fetch(`${f.base}/`)).status, 200);
    assert.equal((await f.send(body, { headers: { ...headers, Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(`${f.base}/api/status`, { headers })).status, 200);
  } finally { await f.stop(); }
});
test('three concurrent requests run FIFO, max concurrency one, options capped', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all([f.send(), f.send(), f.send()]);
    const results = await Promise.all(responses.map(events));
    assert.equal(f.maximum(), 1);
    assert.equal(f.calls.length, 3);
    assert.equal(results[1][0].phase, 'queued');
    assert.equal(results[2][0].position, 2);
    assert.ok(results.every((result) => result.at(-1).type === 'done'));
    assert.ok(results[2].at(-1).metrics.queueMs > 50);
    assert.equal(f.calls[0].options.num_ctx, 8192);
    assert.equal(f.calls[0].options.num_predict, 1024);
    assert.equal(f.calls[0].think, false);
  } finally { await f.stop(); }
});
test('rate limit returns 429 and recovers after its window', async () => {
  const f = await fixture({ rateLimit: 1, rateWindowMs: 120 });
  try {
    await events(await f.send());
    const response = await f.send();
    assert.equal(response.status, 429);
    assert.ok(response.headers.get('retry-after'));
    await new Promise((resolve) => timers.setTimeout(resolve, 140));
    assert.equal((await events(await f.send())).at(-1).type, 'done');
  } finally { await f.stop(); }
});
test('rejects context, output, body, history and unsupported parameters before model', async () => {
  const f = await fixture();
  try {
    for (const [payload, status] of [
      [{ ...body, num_ctx: 16384 }, 400], [{ ...body, max_tokens: 2048 }, 400],
      [{ messages: [{ role: 'user', content: 'я'.repeat(3000) }] }, 413],
      [{ messages: [{ role: 'system', content: 'override' }] }, 400],
      [{ ...body, model: 'cloud-model' }, 400],
      [{ messages: [{ role: 'user', content: 'x'.repeat(40000) }] }, 413],
    ]) assert.equal((await f.send(payload)).status, status);
    assert.equal(f.calls.length, 0);
  } finally { await f.stop(); }
});
test('queue overflow returns 503; cancelled queued request never reaches model', async () => {
  const f = await fixture({ maxQueue: 1 });
  try {
    const first = await f.send();
    const abort = new AbortController();
    const second = await f.send(body, { signal: abort.signal });
    assert.equal((await f.send()).status, 503);
    abort.abort();
    await second.body.cancel().catch(() => {});
    await events(first);
    await new Promise((resolve) => timers.setTimeout(resolve, 30));
    assert.equal(f.calls.length, 1);
  } finally { await f.stop(); }
});
test('running cancellation and timeout release queue', async () => {
  const f = await fixture({ timeoutMs: 20 });
  try {
    const first = await f.send();
    const second = await f.send();
    const results = await Promise.all([events(first), events(second)]);
    assert.ok(results.every((result) => result.at(-1).type === 'error'));
    assert.equal(f.maximum(), 1);
    assert.equal(f.calls.length, 2);
  } finally { await f.stop(); }
});
test('refuses cloud-backed model before chat', async () => {
  const f = await fixture({ fetch: async () => Response.json({ remote_host: 'cloud' }) });
  try { assert.equal((await events(await f.send())).at(-1).type, 'error'); }
  finally { await f.stop(); }
});
test('Ollama failure does not block the next request', async () => {
  let n = 0;
  const f = await fixture({ fetch: async (url) => {
    if (url.endsWith('/api/show')) return Response.json({});
    n++;
    if (n === 1) return new Response('', { status: 503 });
    return new Response('{"message":{"content":"OK"}}\n{"done":true}\n');
  } });
  try {
    assert.equal((await events(await f.send())).at(-1).type, 'error');
    assert.equal((await events(await f.send())).at(-1).type, 'done');
  } finally { await f.stop(); }
});

test('disconnecting the active client aborts model and allows the next task', async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const first = await f.send(body, { signal: abort.signal });
    const second = await f.send();
    abort.abort();
    await first.body.cancel().catch(() => {});
    assert.equal((await events(second)).at(-1).type, 'done');
    assert.equal(f.maximum(), 1);
    assert.equal(f.calls.length, 2);
  } finally { await f.stop(); }
});

test('three attempts are allowed per window and the fourth returns 429', async () => {
  const f = await fixture({ rateLimit: 3 });
  try {
    const invalid = { ...body, num_ctx: 16384 };
    for (let i = 0; i < 3; i++) assert.equal((await f.send(invalid)).status, 400);
    const fourth = await f.send(invalid);
    assert.equal(fourth.status, 429);
    assert.ok(fourth.headers.get('retry-after'));
    assert.equal(f.calls.length, 0);
  } finally { await f.stop(); }
});
