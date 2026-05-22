export type LLMProvider = 'ollama' | 'codex' | 'openai' | 'anthropic' | 'gemini' | 'deepseek';

/**
 * Interface for LLM clients (Codex OAuth, etc.)
 */
export interface ILLMClient {
  /** Sends a prompt and returns the AI response. */
  chat(question: string, options?: ChatOptions): Promise<string>;
}

export interface ChatOptions {
  /** System instructions (optional). */
  instructions?: string;
  /** Model (default: gpt-5.1-codex-mini). */
  model?: string;
  /** Sampling temperature (0.0–1.0). Lower = more deterministic. */
  temperature?: number;
  /** Max tokens to generate. */
  maxTokens?: number;
  /** When 'json', activates native JSON mode per provider. Response will be parseable JSON. */
  responseFormat?: 'json';
}

export interface EmbedOptions {
  model?: string;
}

export interface IEmbeddingClient {
  /** Generates a vector embedding for the provided text. */
  embed(text: string, options?: EmbedOptions): Promise<number[]>;
}
