import type {
  ChatOptions,
  EmbedOptions,
  IEmbeddingClient,
  ILLMClient,
} from '../../../domain/llm/llm.types';
import { logger } from '../../logger';
import { getStoredKey } from '../../notes-auth';

const log = logger.child('OpenAI');

const DEFAULT_MODEL = 'gpt-5.4';
const API_URL = 'https://api.openai.com/v1/chat/completions';
const EMBED_API_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

export class OpenAIEmbeddingClient implements IEmbeddingClient {
  constructor(private apiKey = process.env.OPENAI_API_KEY || getStoredKey('openai')) {}

  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    const model = options?.model ?? DEFAULT_EMBED_MODEL;
    const done = log.time('llm.embed');
    try {
      const res = await fetch(EMBED_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403)
          throw new Error('OpenAI API key is invalid or expired.');
        throw new Error(`OpenAI embed ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return data.data[0]?.embedding ?? [];
    } catch (err) {
      log.warn('Embed failed', { err: err instanceof Error ? err : new Error(String(err)) });
      return [];
    } finally {
      done({ model, inputLen: text.length });
    }
  }
}

export class OpenAIClient implements ILLMClient {
  constructor(private apiKey = process.env.OPENAI_API_KEY || getStoredKey('openai')) {}

  async chat(question: string, options?: ChatOptions): Promise<string> {
    const done = log.time('llm.chat');
    const messages: { role: string; content: string }[] = [];
    if (options?.instructions) messages.push({ role: 'system', content: options.instructions });
    messages.push({ role: 'user', content: question });

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: options?.model ?? DEFAULT_MODEL,
          messages,
          ...(options?.temperature !== undefined && { temperature: options.temperature }),
          max_completion_tokens: options?.maxTokens ?? 4096,
          ...(options?.responseFormat === 'json' && { response_format: { type: 'json_object' } }),
        }),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403)
          throw new Error('OpenAI API key is invalid or expired.');
        throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? '(no response)';
    } finally {
      done({ model: options?.model ?? DEFAULT_MODEL, promptLen: question.length });
    }
  }
}
