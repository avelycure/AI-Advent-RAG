import type { HttpTransport } from '../infrastructure/http';
import { joinUrl } from '../infrastructure/http';
import type { LlmClient, LlmConfig, LlmMessage } from '../types';

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
  data?: Array<{ id?: string }>;
  models?: Array<{ name?: string; model?: string }>;
}

export class ConfigurableLlmClient implements LlmClient {
  constructor(private readonly transport: HttpTransport) {}

  async generate(messages: LlmMessage[], config: LlmConfig): Promise<string> {
    validateConfig(config);
    if (config.provider === 'ollama') {
      const response = await this.transport.request<OllamaChatResponse>({
        url: joinUrl(config.baseUrl, '/api/chat'),
        method: 'POST',
        body: { model: config.model, messages, stream: false, options: { num_predict: 1200 } },
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
        body: { model: config.model, input: messages, max_output_tokens: 1200 },
      });
      const content = extractOpenAiResponseText(response.data);
      if (!content) throw new Error('The selected OpenAI model returned an empty answer.');
      return content;
    }

    const response = await this.transport.request<ChatCompletionResponse>({
      url: joinUrl(config.baseUrl, '/chat/completions'),
      method: 'POST',
      headers: authorizationHeaders(config.apiKey),
      body: { model: config.model, messages, stream: false, max_tokens: 1200 },
    });
    const content = response.data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('The selected model returned an empty answer.');
    return content;
  }

  async testConnection(config: LlmConfig): Promise<void> {
    validateConfig(config);
    if (config.provider === 'custom') {
      await this.generate([{ role: 'user', content: 'Reply with OK.' }], config);
      return;
    }
    const url =
      config.provider === 'ollama'
        ? joinUrl(config.baseUrl, '/api/tags')
        : joinUrl(config.baseUrl, '/models');
    const response = await this.transport.request<ModelsResponse>({
      url,
      headers: authorizationHeaders(config.apiKey),
    });
    const modelIds =
      config.provider === 'ollama'
        ? (response.data.models ?? []).map((model) => model.model ?? model.name ?? '')
        : (response.data.data ?? []).map((model) => model.id ?? '');
    if (modelIds.length === 0) {
      throw new Error('The provider returned no models. Check the endpoint and API key.');
    }
    if (!modelIds.some((id) => id === config.model || id.startsWith(`${config.model}:`))) {
      throw new Error(`Connection works, but model "${config.model}" was not found.`);
    }
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
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('Remote model endpoints must use HTTPS to protect API keys and note fragments.');
  }
  if (!config.model.trim()) throw new Error('Choose or enter an LLM model.');
  if (!['ollama', 'custom'].includes(config.provider) && !config.apiKey) {
    throw new Error('Select an API key in the plugin settings.');
  }
}
