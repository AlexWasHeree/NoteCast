import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DeepSeekClient } from '../clients/deepseek.client';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.DEEPSEEK_API_KEY;
});

function mockFetch(body: unknown, status = 200) {
  global.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('DeepSeekClient', () => {
  test('returns text from choices', async () => {
    mockFetch({ choices: [{ message: { content: 'hello from deepseek' } }] });
    const client = new DeepSeekClient('test-key');
    const result = await client.chat('say hello', { instructions: 'be brief' });
    expect(result).toBe('hello from deepseek');
  });

  test('uses default model deepseek-chat', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    };
    const client = new DeepSeekClient('test-key');
    await client.chat('test');
    expect(capturedBody.model).toBe('deepseek-chat');
  });

  test('throws on 401', async () => {
    mockFetch({ error: { message: 'invalid api key' } }, 401);
    const client = new DeepSeekClient('bad-key');
    await expect(client.chat('test')).rejects.toThrow('is invalid');
  });

  test('throws on 402 (insufficient balance)', async () => {
    mockFetch({ error: { message: 'insufficient balance' } }, 402);
    const client = new DeepSeekClient('test-key');
    await expect(client.chat('test')).rejects.toThrow('is invalid');
  });

  test('sends response_format json_object when responseFormat is json', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
      });
    };
    const client = new DeepSeekClient('test-key');
    await client.chat('return json', { responseFormat: 'json' });
    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
  });

  test('omits response_format when responseFormat is not set', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
        status: 200,
      });
    };
    const client = new DeepSeekClient('test-key');
    await client.chat('test');
    expect(capturedBody.response_format).toBeUndefined();
  });
});
