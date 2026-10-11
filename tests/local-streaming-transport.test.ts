import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStreamingTransport } from '../src/infrastructure/local-streaming-transport';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:http', () => ({ request: mocks.request }));

function fakeRequest() {
  const emitter = new EventEmitter();
  const request = Object.assign(emitter, {
    end: vi.fn(), setTimeout: vi.fn(),
    destroy(error?: Error) { if (error) emitter.emit('error', error); emitter.emit('close'); },
  });
  return request;
}
beforeEach(() => { mocks.request.mockReset(); });

describe('cancellable local model transport', () => {
  it('uses GET without a body and parses model metadata', async () => {
    const request = fakeRequest();
    mocks.request.mockImplementation((_url: URL, options: { method: string; headers: unknown }, callback: (response: EventEmitter) => void) => {
      expect(options.method).toBe('GET');
      const response = Object.assign(new EventEmitter(), { statusCode: 200, setEncoding: vi.fn() });
      request.end.mockImplementation(() => {
        callback(response);
        response.emit('data', '{"models":[]}');
        response.emit('end');
        request.emit('close');
      });
      return request;
    });
    await expect(new LocalStreamingTransport().request({ url: 'http://127.0.0.1:11434/api/tags' })).resolves.toMatchObject({ data: { models: [] } });
    expect(request.end).toHaveBeenCalledWith(undefined);
  });
  it('cancels an active HTTP request and blocks requests after unload', async () => {
    const request = fakeRequest();
    mocks.request.mockReturnValue(request);
    const transport = new LocalStreamingTransport();
    const pending = transport.request({ url: 'http://127.0.0.1:11434/api/chat', method: 'POST', body: {} });
    transport.dispose();
    await expect(pending).rejects.toThrow(/отменён/);
    await expect(transport.request({ url: 'http://127.0.0.1:11434/api/tags' })).rejects.toThrow(/отменён/);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('blocks arbitrary endpoints before opening a socket', async () => {
    await expect(new LocalStreamingTransport().request({ url: 'https://example.com/api/chat' })).rejects.toThrow(/локальной/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
