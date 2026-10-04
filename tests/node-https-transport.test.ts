import { describe, expect, it } from 'vitest';
import { NodeHttpsTransport } from '../src/infrastructure/node-https-transport';

describe('NodeHttpsTransport', () => {
  it('blocks a different origin before opening a connection', async () => {
    const transport = new NodeHttpsTransport('https://api.deepseek.com');
    await expect(
      transport.request({
        url: 'https://example.com/v1/responses',
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: { model: 'test-model' },
      }),
    ).rejects.toThrow(/официальный API endpoint/);
  });

  it('blocks plaintext even when the hostname matches', async () => {
    const transport = new NodeHttpsTransport('https://api.deepseek.com');
    await expect(
      transport.request({ url: 'http://api.deepseek.com/chat/completions' }),
    ).rejects.toThrow(/официальный API endpoint/);
  });
});
