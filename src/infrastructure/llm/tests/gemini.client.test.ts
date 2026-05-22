import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GeminiClient } from '../clients/gemini.client';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.GEMINI_API_KEY;
});

const okResponse = {
  candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }],
};

function mockFetch(body: unknown, status = 200) {
  global.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('GeminiClient', () => {
  test('returns text from candidates', async () => {
    mockFetch(okResponse);
    const client = new GeminiClient('test-key');
    const result = await client.chat('say hello');
    expect(result).toBe('hello from gemini');
  });

  test('sends systemInstruction when instructions provided', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(okResponse), { status: 200 });
    };
    const client = new GeminiClient('test-key');
    await client.chat('test', { instructions: 'be brief' });
    expect((capturedBody.systemInstruction as { parts: { text: string }[] }).parts[0].text).toBe(
      'be brief',
    );
  });

  test('includes model in URL', async () => {
    let capturedUrl = '';
    global.fetch = async (url, _init) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify(okResponse), { status: 200 });
    };
    const client = new GeminiClient('test-key');
    await client.chat('test', { model: 'gemini-2.5-pro' });
    expect(capturedUrl).toContain('gemini-2.5-pro');
    expect(capturedUrl).toContain('key=test-key');
  });

  test('uses default model gemini-2.5-pro in URL', async () => {
    let capturedUrl = '';
    global.fetch = async (url, _init) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify(okResponse), { status: 200 });
    };
    const client = new GeminiClient('test-key');
    await client.chat('test');
    expect(capturedUrl).toContain('gemini-2.5-pro');
  });

  test('throws on 403', async () => {
    mockFetch({ error: { message: 'invalid key' } }, 403);
    const client = new GeminiClient('bad-key');
    await expect(client.chat('test')).rejects.toThrow('is invalid');
  });

  test('sets responseMimeType application/json when responseFormat is json', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(okResponse), { status: 200 });
    };
    const client = new GeminiClient('test-key');
    await client.chat('return json', { responseFormat: 'json' });
    expect((capturedBody.generationConfig as Record<string, unknown>)?.responseMimeType).toBe(
      'application/json',
    );
  });

  test('does not set responseMimeType when responseFormat is not set', async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(okResponse), { status: 200 });
    };
    const client = new GeminiClient('test-key');
    await client.chat('test');
    expect(
      (capturedBody.generationConfig as Record<string, unknown> | undefined)?.responseMimeType,
    ).toBeUndefined();
  });
});
