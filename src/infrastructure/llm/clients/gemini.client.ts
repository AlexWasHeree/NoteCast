import type { ChatOptions, ILLMClient } from '../../../domain/llm/llm.types';
import { logger } from '../../logger';
import { getStoredKey } from '../../notes-auth';

const log = logger.child('Gemini');
const DEFAULT_MODEL = 'gemini-2.5-pro';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
