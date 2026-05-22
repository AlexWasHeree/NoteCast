import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OpenAIClient } from '../clients/openai.client';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

function mockFetch(body: unknown, status = 200) {
  global.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('OpenAIClient', () => {
  test('sends correct request and returns text', async () => {
    mockFetch({ choices: [{ message: { content: 'hello from openai' } }] });
    const client = new OpenAIClient('test-key');
    const result = await client.chat('say hello', { instructions: 'be brief' });
    expect(result).toBe('hello from openai');
  });

  test('uses default model gpt-5.4', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    };
    const client = new OpenAIClient('test-key');
    await client.chat('test');
    expect(capturedBody.model).toBe('gpt-5.4');
  });

  test('throws on 401', async () => {
    mockFetch({ error: 'unauthorized' }, 401);
    const client = new OpenAIClient('bad-key');
    await expect(client.chat('test')).rejects.toThrow('invalid or expired');
  });

  test('sends response_format json_object when responseFormat is json', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
      });
    };
    const client = new OpenAIClient('test-key');
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
    const client = new OpenAIClient('test-key');
    await client.chat('test');
    expect(capturedBody.response_format).toBeUndefined();
  });
});
