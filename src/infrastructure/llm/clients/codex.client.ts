import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatOptions, ILLMClient } from '../../../domain/llm/llm.types';
import { logger } from '../../logger';
import { JSON_DIRECTIVE } from './llm.shared';

const log = logger.child('Codex');

let authCache: { token: string; path: string; mtime: number } | null = null;
let _statOverride: ((path: string) => { mtimeMs: number }) | null = null;

/** Only for tests — resets the module-level auth cache. */
export function _clearAuthCacheForTest(): void {
  authCache = null;
  _statOverride = null;
}

/** Only for tests — override statSync to control mtime returned. */
export function _setStatOverrideForTest(fn: ((path: string) => { mtimeMs: number }) | null): void {
  _statOverride = fn;
}

const CODEX_API = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_MODEL = 'gpt-5.4-mini';

type AuthJson = Record<string, unknown>;

function findAuth(): { path: string; data: AuthJson } | null {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const paths = [join(home, '.codex', 'auth.json'), join(home, '.codex-auth', 'auth.json')];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8');
        return { path: p, data: JSON.parse(raw) as AuthJson };
      } catch {}
    }
  }
  return null;
}

function extractAccessToken(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const token = (o.access_token as string) ?? (o.accessToken as string);
  if (typeof token === 'string') return token;
  const tokens = o.tokens as Record<string, unknown> | undefined;
  if (tokens) {
    const t =
      (tokens.access_token as string) ??
      (tokens.accessToken as string) ??
      extractAccessToken((tokens as Record<string, unknown>).openai);
    if (t) return t;
  }
  for (const key of ['provider', 'openai', 'session', 'credentials']) {
    const nested = o[key];
    if (nested) {
      const t = extractAccessToken(nested);
      if (t) return t;
    }
  }
  return null;
}

export class CodexClient implements ILLMClient {
  private getAccessToken(): string {
    if (authCache) {
      try {
        const mtime = (_statOverride ?? statSync)(authCache.path).mtimeMs;
        if (mtime === authCache.mtime) return authCache.token;
      } catch {
        // file disappeared — fall through to re-read
      }
      authCache = null;
    }
    const found = findAuth();
    if (!found) {
      throw new Error('Codex auth not found. Run `codex login` and try again.');
    }
    const token = extractAccessToken(found.data);
    if (!token) {
      throw new Error(`auth.json at ${found.path} does not contain access_token. Run codex login.`);
    }
    authCache = { token, path: found.path, mtime: (_statOverride ?? statSync)(found.path).mtimeMs };
    return token;
  }

  async chat(question: string, options?: ChatOptions): Promise<string> {
    const done = log.time('llm.chat');
    const token = this.getAccessToken();
    const model = options?.model ?? DEFAULT_MODEL;
    const instructionParts: string[] = [];
    if (options?.responseFormat === 'json') instructionParts.push(JSON_DIRECTIVE);
    if (options?.instructions) {
      instructionParts.push(options.instructions);
    } else if (instructionParts.length === 0) {
      instructionParts.push('You are a helpful assistant.');
    }
    const instructions = instructionParts.join('\n\n');
    try {
      const res = await fetch(CODEX_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          instructions,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: question }],
            },
          ],
          store: false,
          stream: true,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          throw new Error('Token Codex expirado. Execute `codex login` novamente.');
        }
        throw new Error(`Codex API ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      let currentEvent = '';

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              if (
                currentEvent === 'response.output_text.delta' &&
                typeof parsed.delta === 'string'
              ) {
                fullText += parsed.delta;
                continue;
              }
              if (typeof parsed.output_text === 'string') {
                fullText += parsed.output_text;
                continue;
              }
              const output = parsed.output as
                | Array<{ content?: Array<{ text?: string }> }>
                | undefined;
              const first = output?.[0];
              for (const c of first?.content ?? []) {
                if (typeof (c as { text?: string }).text === 'string') {
                  fullText += (c as { text: string }).text;
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }

      return fullText.trim() || '(no text response)';
    } finally {
      done({ model, promptLen: question.length });
    }
  }
}
