const element = (id) => document.getElementById(id);
const messages = [];
let apiKey = '', cancellation;
function activity(text, error = false) { element('activity').textContent = text; element('activity').classList.toggle('error', error); }
function bubble(role, text) {
  element('welcome')?.remove();
  const wrapper = document.createElement('article'); wrapper.className = `message ${role}`;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? 'ВЫ' : 'QWEN · ЛОКАЛЬНО';
  const body = document.createElement('div'); body.className = 'message-body'; body.textContent = text;
  wrapper.append(label, body); element('messages').append(wrapper);
  element('messages').scrollTop = element('messages').scrollHeight;
  return { wrapper, body };
}
function controls(busy) {
  element('send').disabled = busy || !apiKey;
  element('question').disabled = busy || !apiKey;
  element('connect').disabled = busy;
  element('clear').disabled = busy;
  element('stop').hidden = !busy;
}
element('connect').addEventListener('click', async () => {
  const candidate = element('key').value.trim();
  try {
    const response = await window.fetch('/api/status', { headers: { Authorization: `Bearer ${candidate}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    apiKey = candidate; element('key').value = '';
    element('connection').textContent = `Подключено · ${data.model} · вход до ${data.limits.maxInputBytes} байт · очередь до ${data.limits.maxQueue} запросов`;
    controls(false); element('question').focus(); activity('Готов к запросам');
  } catch (error) { apiKey = ''; controls(false); element('connection').textContent = error.message; }
});
element('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = element('question').value.trim();
  if (!question || !apiKey || cancellation) return;
  cancellation = new AbortController(); controls(true);
  const user = bubble('user', question), answer = bubble('assistant', '');
  const history = [...messages, { role: 'user', content: question }];
  let complete = false, content = '';
  activity('Отправляю запрос…');
  try {
    const response = await window.fetch('/api/chat', { method: 'POST', signal: cancellation.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history }) });
    if (!response.ok) { const data = await response.json(); const retry = response.headers.get('Retry-After'); throw new Error(data.error + (response.status === 429 && retry ? ` · повторите через ${retry} с` : '')); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    const process = (line) => {
      if (!line.trim()) return;
      const data = JSON.parse(line);
      if (data.type === 'error') throw new Error(data.message);
      if (data.type === 'status') activity(data.phase === 'queued' ? `В очереди · позиция ${data.position}` : 'Qwen отвечает…');
      if (data.type === 'delta') { content += data.text; answer.body.textContent = content; element('messages').scrollTop = element('messages').scrollHeight; }
      if (data.type === 'done') {
        complete = true;
        messages.push({ role: 'user', content: question }, { role: 'assistant', content });
        element('question').value = '';
        const info = document.createElement('div'); info.className = 'metrics';
        const m = data.metrics;
        info.textContent = `${(m.elapsedMs / 1000).toFixed(1)} с · ${m.outputTokens ?? '—'} токенов · ${m.tokensPerSecond?.toFixed(1) ?? '—'} ток/с · очередь ${(m.queueMs / 1000).toFixed(1)} с`;
        answer.wrapper.append(info); activity(data.truncated ? 'Ответ достиг лимита длины' : 'Ответ получен');
      }
    };
    while (true) {
      const result = await reader.read(); if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let end; while ((end = buffer.indexOf('\n')) >= 0) { process(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    }
    process(buffer + decoder.decode());
    if (!complete) throw new Error('Ответ прерван');
  } catch (error) {
    cancellation?.abort();
    activity(error.name === 'AbortError' ? 'Запрос отменён' : error.message, true);
    if (!content) { user.wrapper.remove(); answer.wrapper.remove(); }
    else { const warning = document.createElement('div'); warning.className = 'metrics'; warning.textContent = 'Неполный ответ · в историю не добавлен'; answer.wrapper.append(warning); }
  } finally { cancellation = undefined; controls(false); element('question').focus(); }
});
element('question').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); element('composer').requestSubmit(); }
});
element('stop').addEventListener('click', () => cancellation?.abort());
element('clear').addEventListener('click', () => { messages.length = 0; element('messages').replaceChildren(); activity('Новый разговор'); element('question').focus(); });
