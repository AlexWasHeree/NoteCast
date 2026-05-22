import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'; // utimesSync still used in touchMtime
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = join(tmpdir(), `codex-auth-cache-test-${process.pid}`);
const authDir = join(tmpHome, '.codex');
const authPath = join(authDir, 'auth.json');

function writeAuth(token: string) {
  mkdirSync(authDir, { recursive: true });
  writeFileSync(authPath, JSON.stringify({ access_token: token }));
}

function touchMtime() {
  // bump mtime by setting it 1 second into the future
  const future = new Date(Date.now() + 1000);
  utimesSync(authPath, future, future);
}

let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // reset module-level cache between tests
  const mod = require('../clients/codex.client');
  mod._clearAuthCacheForTest?.();
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
  const mod = require('../clients/codex.client');
  mod._clearAuthCacheForTest?.();
});

describe('CodexClient auth cache (#11)', () => {
  test('reads token from auth.json', () => {
    writeAuth('tok-abc');
    const { CodexClient } = require('../clients/codex.client');
    const token = (new CodexClient() as any).getAccessToken();
    expect(token).toBe('tok-abc');
  });

  test('returns cached token on second call (no mtime change)', () => {
    writeAuth('tok-first');
    const mod = require('../clients/codex.client');
    const client = new mod.CodexClient() as any;
    // prime cache; lock mtime to a fixed value so it never changes
    const fixedMtime = 1_000_000;
    mod._setStatOverrideForTest(() => ({ mtimeMs: fixedMtime }));
    client.getAccessToken();

    // overwrite file content — real mtime changes, but our override returns fixedMtime
    writeFileSync(authPath, JSON.stringify({ access_token: 'tok-second' }));

    const token = client.getAccessToken();
    expect(token).toBe('tok-first'); // still cached
  });

  test('re-reads token when auth.json mtime changes', () => {
    writeAuth('tok-old');
    const { CodexClient } = require('../clients/codex.client');
    const client = new CodexClient() as any;
    client.getAccessToken(); // prime cache

    // write new token AND advance mtime
    writeAuth('tok-new');
    touchMtime();

    const token = client.getAccessToken();
    expect(token).toBe('tok-new');
  });

  test('throws if auth.json is missing', () => {
    // tmpHome has no auth.json
    const { CodexClient } = require('../clients/codex.client');
    expect(() => (new CodexClient() as any).getAccessToken()).toThrow('codex login');
  });
});

describe('CodexClient JSON mode', () => {
  test('prepends JSON directive to instructions when responseFormat is json', async () => {
    writeAuth('tok-test');
    let capturedBody: Record<string, unknown> = {};
    const originalFetch = global.fetch;
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      const sseData = 'event: response.output_text.delta\ndata: {"delta":"{\\"ok\\":true}"}\n\n';
      return new Response(sseData, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
    try {
      const { CodexClient } = require('../clients/codex.client');
      const client = new CodexClient();
      await client.chat('return json', { instructions: 'be an assistant', responseFormat: 'json' });
      expect(typeof capturedBody.instructions).toBe('string');
      expect(capturedBody.instructions as string).toContain('valid JSON only');
      expect(capturedBody.instructions as string).toContain('be an assistant');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
