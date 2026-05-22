import type { ChatOptions, ILLMClient } from '../../../domain/llm/llm.types';
import { logger } from '../../logger';
import { getStoredKey } from '../../notes-auth';
import { JSON_DIRECTIVE } from './llm.shared';

const log = logger.child('Anthropic');
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

export class AnthropicClient implements ILLMClient {
  constructor(private apiKey = process.env.ANTHROPIC_API_KEY || getStoredKey('anthropic')) {}

  async chat(question: string, options?: ChatOptions): Promise<string> {
    const done = log.time('llm.chat');
    const model = options?.model ?? DEFAULT_MODEL;
    const systemParts: string[] = [];
    if (options?.responseFormat === 'json') systemParts.push(JSON_DIRECTIVE);
    if (options?.instructions) systemParts.push(options.instructions);

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: question }],
      max_tokens: options?.maxTokens ?? 4096,
    };
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        if (res.status === 401) throw new Error('Anthropic API key is invalid.');
        throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
      return data.content.find((c) => c.type === 'text')?.text?.trim() ?? '(no response)';
    } finally {
      done({ model, promptLen: question.length });
    }
  }
}
