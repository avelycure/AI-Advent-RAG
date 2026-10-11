import type { HttpTransport } from '../infrastructure/http';
import { joinUrl } from '../infrastructure/http';
import type { LlmClient, LlmConfig, LlmMessage } from '../types';

export const GLM_API_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
export const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';

interface OllamaChatResponse {
  message?: { content?: string };
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface OpenAiResponsesResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

interface ModelsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

export class ConfigurableLlmClient implements LlmClient {
  constructor(private readonly transport: HttpTransport) {}

  async generate(messages: LlmMessage[], config: LlmConfig, onText?: (text: string) => void): Promise<string> {
    validateConfig(config);
    if (config.provider === 'ollama') {
      const modelInfo = await this.transport.request<{ remote_model?: string; remote_host?: string }>({
        signal: config.signal,
        url: joinUrl(config.baseUrl, '/api/show'),
        method: 'POST',
        body: { model: config.model },
      });
      if (modelInfo.data.remote_model || modelInfo.data.remote_host) {
        throw new Error('Облачные модели Ollama запрещены. Выберите установленную локальную модель.');
      }
      if (onText && this.transport.requestStream) {
        let pending = '';
        let answer = '';
        let done = false;
        const readLine = (line: string): void => {
          if (!line.trim()) return;
          const data = JSON.parse(line) as OllamaChatResponse & { error?: string; done?: boolean };
          if (data.error) throw new Error(data.error);
          const delta = data.message?.content ?? '';
          answer += delta;
          if (delta) onText(delta);
          done ||= data.done === true;
        };
        await this.transport.requestStream({
          signal: config.signal,
        url: joinUrl(config.baseUrl, '/api/chat'), method: 'POST',
          body: { model: config.model, messages, stream: true, think: false,
            options: { num_predict: 4096, num_ctx: 32768, temperature: 0.2 } },
        }, (chunk) => {
          pending += chunk;
          let newline = pending.indexOf('\n');
          while (newline >= 0) {
            readLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            newline = pending.indexOf('\n');
          }
        });
        readLine(pending);
        if (!done) throw new Error('Поток ответа модели прерван. Повторите запрос.');
        if (!answer.trim()) throw new Error('Локальная модель вернула пустой ответ.');
        return answer.trim();
      }
      const response = await this.transport.request<OllamaChatResponse>({
        signal: config.signal,
        url: joinUrl(config.baseUrl, '/api/chat'),
        method: 'POST',
        body: { model: config.model, messages, stream: false, think: false, options: { num_predict: 4096, num_ctx: 32768, temperature: 0.2 } },
      });
      const content = response.data.message?.content?.trim();
      if (!content) throw new Error('The selected Ollama model returned an empty answer.');
      return content;
    }

    if (config.provider === 'openai') {
      const response = await this.transport.request<OpenAiResponsesResponse>({
        url: joinUrl(config.baseUrl, '/responses'),
        method: 'POST',
        headers: authorizationHeaders(config.apiKey),
        body: {
          model: config.model,
          input: messages.map((message) => ({
            ...message,
            role: message.role === 'system' ? 'developer' : message.role,
          })),
          max_output_tokens: 1200,
          reasoning: { effort: 'none' },
          text: { verbosity: 'low' },
        },
      });
      const content = extractOpenAiResponseText(response.data);
      if (!content) throw new Error('The selected OpenAI model returned an empty answer.');
      return content;
    }

    const response = await this.transport.request<ChatCompletionResponse>({
      url: joinUrl(config.baseUrl, '/chat/completions'),
      method: 'POST',
      headers: authorizationHeaders(config.apiKey),
      body: {
        model: config.model,
        messages,
        stream: false,
        max_tokens: 1200,
        temperature: config.provider === 'glm' || config.provider === 'deepseek' ? 0.2 : undefined,
        thinking: config.provider === 'deepseek' ? { type: 'disabled' } : undefined,
      },
    });
    const content = response.data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('The selected model returned an empty answer.');
    return content;
  }

  async testConnection(config: LlmConfig): Promise<void> {
    validateConfig(config);
    if (
      config.provider === 'custom' ||
      config.provider === 'glm' ||
      config.provider === 'openai' ||
      config.provider === 'deepseek'
    ) {
      await this.generate([{ role: 'user', content: 'Ответь одним словом: ОК' }], config);
      return;
    }
    const url = joinUrl(config.baseUrl, '/api/tags');
    const response = await this.transport.request<ModelsResponse>({
      url,
      headers: authorizationHeaders(config.apiKey),
    });
    const modelIds = (response.data.models ?? []).map((model) => model.model ?? model.name ?? '');
    if (modelIds.length === 0) {
      throw new Error('The provider returned no models. Check the endpoint and API key.');
    }
    if (!modelIds.some((id) => id === config.model || id.startsWith(`${config.model}:`))) {
      throw new Error(`Connection works, but model "${config.model}" was not found.`);
    }
    await this.generate([{ role: 'user', content: 'Ответь одним словом: ОК' }], config);
  }
}

function extractOpenAiResponseText(response: OpenAiResponsesResponse): string {
  if (response.output_text?.trim()) return response.output_text.trim();
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && item.text)
    .map((item) => item.text ?? '')
    .join('')
    .trim();
}

function authorizationHeaders(apiKey?: string): Record<string, string> | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

function validateConfig(config: LlmConfig): void {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error('Enter a valid HTTP(S) model URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter a valid HTTP(S) model URL.');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Адрес модели не должен содержать логин, пароль, параметры или fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (config.provider === 'ollama' && !loopback) {
    throw new Error('Для локальной Ollama разрешён только адрес localhost или 127.0.0.1.');
  }
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('Remote model endpoints must use HTTPS to protect API keys and note fragments.');
  }
  if (config.provider === 'glm' && normalizeUrl(config.baseUrl) !== GLM_API_BASE_URL) {
    throw new Error('Для GLM разрешён только официальный стандартный API Z.AI.');
  }
  if (config.provider === 'openai' && normalizeUrl(config.baseUrl) !== OPENAI_API_BASE_URL) {
    throw new Error('Для OpenAI разрешён только официальный API endpoint.');
  }
  if (config.provider === 'deepseek' && normalizeUrl(config.baseUrl) !== DEEPSEEK_API_BASE_URL) {
    throw new Error('Для DeepSeek разрешён только официальный API endpoint.');
  }
  if (config.provider === 'ollama' && /(?:[:-]cloud)(?:$|[:-])/i.test(config.model)) {
    throw new Error('Облачные модели Ollama запрещены. Выберите установленную локальную модель.');
  }
  if (!config.model.trim()) throw new Error('Choose or enter an LLM model.');
  if (!['ollama', 'custom'].includes(config.provider) && !config.apiKey) {
    throw new Error('Select an API key in the plugin settings.');
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
