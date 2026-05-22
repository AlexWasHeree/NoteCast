import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OllamaClient } from '../clients/ollama.client';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('OllamaClient', () => {
  test('returns text from message content', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ message: { content: 'hello from ollama' } }), { status: 200 });
    const client = new OllamaClient();
    const result = await client.chat('say hello');
    expect(result).toBe('hello from ollama');
  });

  test('sends format json when responseFormat is json', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ message: { content: '{"ok":true}' } }), { status: 200 });
    };
    const client = new OllamaClient();
    await client.chat('return json', { responseFormat: 'json' });
    expect(capturedBody.format).toBe('json');
  });

  test('omits format when responseFormat is not set', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ message: { content: 'hello' } }), { status: 200 });
    };
    const client = new OllamaClient();
    await client.chat('test');
    expect(capturedBody.format).toBeUndefined();
  });

  test('sends system message when instructions provided', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
    };
    const client = new OllamaClient();
    await client.chat('test', { instructions: 'be brief' });
    const messages = capturedBody.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'be brief' });
  });
});
