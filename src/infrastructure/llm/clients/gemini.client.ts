import type {
  ChatOptions,
  EmbedOptions,
  IEmbeddingClient,
  ILLMClient,
} from '../../../domain/llm/llm.types';
import { logger } from '../../logger';
import { getStoredKey } from '../../notes-auth';

const log = logger.child('Gemini');
const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_EMBED_MODEL = 'text-embedding-004';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiEmbeddingClient implements IEmbeddingClient {
  constructor(private apiKey = process.env.GEMINI_API_KEY || getStoredKey('gemini')) {}

  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    const model = options?.model ?? DEFAULT_EMBED_MODEL;
    const done = log.time('llm.embed');
    try {
      const url = `${API_BASE}/${model}:embedContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      });
      if (!res.ok) {
        if (res.status === 403) throw new Error('Gemini API key is invalid.');
        throw new Error(`Gemini embed ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { embedding: { values: number[] } };
      return data.embedding?.values ?? [];
    } catch (err) {
      log.warn('Embed failed', { err: err instanceof Error ? err : new Error(String(err)) });
      return [];
    } finally {
      done({ model, inputLen: text.length });
    }
  }
}

export class GeminiClient implements ILLMClient {
  constructor(private apiKey = process.env.GEMINI_API_KEY || getStoredKey('gemini')) {}

  async chat(question: string, options?: ChatOptions): Promise<string> {
    const done = log.time('llm.chat');
    const model = options?.model ?? DEFAULT_MODEL;
    const url = `${API_BASE}/${model}:generateContent?key=${this.apiKey}`;

    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: question }] }],
    };
    if (options?.instructions) {
      body.systemInstruction = { parts: [{ text: options.instructions }] };
    }
    if (
      options?.temperature !== undefined ||
      options?.maxTokens !== undefined ||
      options?.responseFormat === 'json'
    ) {
      body.generationConfig = {
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.maxTokens !== undefined && { maxOutputTokens: options.maxTokens }),
        ...(options?.responseFormat === 'json' && { responseMimeType: 'application/json' }),
      };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        if (res.status === 403) throw new Error('Gemini API key is invalid.');
        throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      return data.candidates[0]?.content?.parts?.[0]?.text?.trim() ?? '(no response)';
    } finally {
      done({ model, promptLen: question.length });
    }
  }
}
