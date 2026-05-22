import type {
  ChatOptions,
  EmbedOptions,
  IEmbeddingClient,
  ILLMClient,
} from '../../../domain/llm/llm.types';
import { logger } from '../../logger';

const log = logger.child('Ollama');

const DEFAULT_MODEL = 'llama3.2:3b';

export class OllamaClient implements ILLMClient {
  constructor(
    private baseUrl = 'http://localhost:11434',
    private defaultModel = DEFAULT_MODEL,
  ) {}

  async chat(question: string, options?: ChatOptions): Promise<string> {
    const done = log.time('llm.chat');
    const messages: { role: string; content: string }[] = [];
    if (options?.instructions) {
      messages.push({ role: 'system', content: options.instructions });
    }
    messages.push({ role: 'user', content: question });
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options?.model ?? this.defaultModel,
          messages,
          stream: false,
          ...(options?.responseFormat === 'json' && { format: 'json' }),
          options: {
            ...(options?.temperature !== undefined && { temperature: options.temperature }),
            ...(options?.maxTokens !== undefined && { num_predict: options.maxTokens }),
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as { message?: { content?: string } };
      return (data.message?.content ?? '').trim();
    } finally {
      done({ model: options?.model ?? this.defaultModel, promptLen: question.length });
    }
  }
}

export class OllamaEmbeddingClient implements IEmbeddingClient {
  constructor(
    private baseUrl = 'http://localhost:11434',
    private model = 'nomic-embed-text',
  ) {}

  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    const model = options?.model ?? this.model;
    const done = log.time('llm.embed');
    let result: number[] = [];
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      });

      if (!res.ok) {
        throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as { embeddings: number[][] };
      result = data.embeddings[0] ?? [];
      return result;
    } catch (err) {
      log.warn('Embed failed, returning empty vector', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return [];
    } finally {
      done({ model, inputLen: text.length, dims: result.length });
    }
  }
}
