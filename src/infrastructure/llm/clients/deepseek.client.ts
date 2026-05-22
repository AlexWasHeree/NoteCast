import type { ChatOptions, ILLMClient } from '../../../domain/llm/llm.types';
import { logger } from '../../logger';
import { getStoredKey } from '../../notes-auth';

const log = logger.child('DeepSeek');
const DEFAULT_MODEL = 'deepseek-chat';
const API_URL = 'https://api.deepseek.com/v1/chat/completions';

export class DeepSeekClient implements ILLMClient {
  constructor(private apiKey = process.env.DEEPSEEK_API_KEY || getStoredKey('deepseek')) {}

  async chat(question: string, options?: ChatOptions): Promise<string> {
    const done = log.time('llm.chat');
    const model = options?.model ?? DEFAULT_MODEL;
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
          model,
          messages,
          ...(options?.temperature !== undefined && { temperature: options.temperature }),
          max_tokens: options?.maxTokens ?? 4096,
          ...(options?.responseFormat === 'json' && { response_format: { type: 'json_object' } }),
        }),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 402)
          throw new Error('DeepSeek API key is invalid or balance is insufficient.');
        throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? '(no response)';
    } finally {
      done({ model, promptLen: question.length });
    }
  }
}
