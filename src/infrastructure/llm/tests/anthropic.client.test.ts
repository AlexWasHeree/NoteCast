import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AnthropicClient } from '../clients/anthropic.client';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.ANTHROPIC_API_KEY;
});

function mockFetch(body: unknown, status = 200) {
  global.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('AnthropicClient', () => {
  test('returns text from content array', async () => {
    mockFetch({ content: [{ type: 'text', text: 'hello from anthropic' }] });
    const client = new AnthropicClient('test-key');
    const result = await client.chat('say hello', { instructions: 'be brief' });
    expect(result).toBe('hello from anthropic');
  });

  test('sends system as top-level field', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
      });
    };
    const client = new AnthropicClient('test-key');
    await client.chat('test', { instructions: 'be terse' });
    expect(capturedBody.system).toBe('be terse');
  });

  test('uses default model claude-sonnet-4-6', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
      });
    };
    const client = new AnthropicClient('test-key');
    await client.chat('test');
    expect(capturedBody.model).toBe('claude-sonnet-4-6');
  });

  test('throws on 401', async () => {
    mockFetch({ error: { message: 'invalid key' } }, 401);
    const client = new AnthropicClient('bad-key');
    await expect(client.chat('test')).rejects.toThrow('is invalid');
  });

  test('prepends JSON directive to system when responseFormat is json', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }), {
        status: 200,
      });
    };
    const client = new AnthropicClient('test-key');
    await client.chat('return json', { instructions: 'be an assistant', responseFormat: 'json' });
    expect(typeof capturedBody.system).toBe('string');
    expect(capturedBody.system as string).toContain('valid JSON only');
    expect(capturedBody.system as string).toContain('be an assistant');
  });

  test('sets JSON directive as system when responseFormat is json and no instructions given', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }), {
        status: 200,
      });
    };
    const client = new AnthropicClient('test-key');
    await client.chat('return json', { responseFormat: 'json' });
    expect(typeof capturedBody.system).toBe('string');
    expect(capturedBody.system as string).toContain('valid JSON only');
  });
});
