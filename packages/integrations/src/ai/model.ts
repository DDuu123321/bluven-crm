// The assistant's connection to the language model. Everything else in this folder talks to the
// small interface below, so tests can put a stand-in in its place.
import Anthropic from '@anthropic-ai/sdk';
import { AppError, getConfig } from '@bluven/core';

export type AiEffort = 'low' | 'medium' | 'high';

export type AiImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** One piece of what the model is given to read. */
export type AiInput = { type: 'text'; text: string } | { type: 'image'; mediaType: AiImageType; data: Buffer } | { type: 'pdf'; data: Buffer; title?: string };

export interface AiRequest {
  /** Who the model is and what it is to do. The same for every request of one kind. */
  system: string;
  /** The material for this request. */
  content: AiInput[];
  /** JSON Schema the answer has to follow. */
  schema: Record<string, unknown>;
  effort: AiEffort;
  /** A person is waiting for the answer: give up sooner, retry less. */
  interactive?: boolean;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AiResponse {
  /** The answer, parsed from JSON. Its shape still has to be checked by the caller. */
  output: unknown;
  usage: AiUsage;
  /** The model that answered, which is another one when the first declined and a fallback took over. */
  model: string;
}

export interface AiModel {
  /** The model requests are sent to. */
  readonly name: string;
  run(request: AiRequest): Promise<AiResponse>;
}

export type AiFailure =
  /** The model declined the request. */
  | 'refused'
  /** The service could not be reached or is overloaded: worth another try later. */
  | 'unavailable'
  /** The request itself was not accepted, for example a file the model cannot open. */
  | 'rejected'
  /** An answer came back but it is not what was asked for. */
  | 'unreadable'
  /** The key, the account or the model name is wrong: nothing works until someone fixes it. */
  | 'setup';

const NO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A request to the model that did not produce a usable answer. The message is safe to show to staff. */
export class AiError extends AppError {
  constructor(
    message: string,
    readonly failure: AiFailure,
    /** What the service said, for the administrator's log. */
    readonly detail: string = '',
    readonly usage: AiUsage = NO_USAGE,
    readonly servedBy: string | null = null,
  ) {
    super(message, 'assistant', 502);
  }
  get retryable(): boolean {
    return this.failure === 'unavailable' || this.failure === 'unreadable';
  }
}

export const AI_MESSAGES = {
  off: 'The assistant is not set up on this server yet. An administrator has to add the key for it.',
  refused: 'The assistant declined to work on this. Please write it yourself.',
  unavailable: 'The assistant could not be reached just now. Please try again in a moment.',
  rejected: 'The assistant could not work with this material.',
  unreadable: 'The assistant’s answer could not be used. Please try again.',
  setup: 'The assistant is not working: its key or its settings are wrong. Please tell an administrator.',
} as const;

function translate(e: unknown): AiError {
  if (e instanceof AiError) return e;
  // Most specific first. A connection error is also an APIError in this SDK, so it comes before.
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AiError(AI_MESSAGES.setup, 'setup', e.message);
  if (e instanceof Anthropic.NotFoundError) return new AiError(AI_MESSAGES.setup, 'setup', `The model is not available to this key: ${e.message}`);
  if (e instanceof Anthropic.RateLimitError) return new AiError(AI_MESSAGES.unavailable, 'unavailable', e.message);
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.ContentTooLargeError || e instanceof Anthropic.UnprocessableEntityError) return new AiError(AI_MESSAGES.rejected, 'rejected', e.message);
  if (e instanceof Anthropic.APIConnectionError) return new AiError(AI_MESSAGES.unavailable, 'unavailable', e.message);
  if (e instanceof Anthropic.APIError) {
    // 402: the account has run out of credit. Staff cannot fix that by trying again.
    if (e.status === 402) return new AiError(AI_MESSAGES.setup, 'setup', e.message);
    return typeof e.status === 'number' && e.status < 500 ? new AiError(AI_MESSAGES.rejected, 'rejected', e.message) : new AiError(AI_MESSAGES.unavailable, 'unavailable', e.message);
  }
  return new AiError(AI_MESSAGES.unavailable, 'unavailable', e instanceof Error ? e.message : String(e));
}

function toBlock(input: AiInput): Anthropic.Beta.BetaContentBlockParam {
  switch (input.type) {
    case 'text':
      return { type: 'text', text: input.text };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.data.toString('base64') } };
    case 'pdf':
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.data.toString('base64') }, ...(input.title ? { title: input.title } : {}) };
  }
}

export interface AnthropicSettings {
  apiKey: string;
  model: string;
  /** Only for tests and for a gateway in front of the API. */
  baseUrl?: string;
}

/** Room for the model's own reasoning as well as the answer; the answers here are short. */
const MAX_TOKENS = 16_000;

export class AnthropicModel implements AiModel {
  private readonly client: Anthropic;

  constructor(
    private readonly settings: AnthropicSettings,
    fetchImpl?: typeof fetch,
  ) {
    this.client = new Anthropic({ apiKey: settings.apiKey, ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  get name(): string {
    return this.settings.model;
  }

  async run(request: AiRequest): Promise<AiResponse> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client.beta.messages.create(
        {
          model: this.settings.model,
          max_tokens: MAX_TOKENS,
          // When the model declines for a policy reason the service tries the request once more
          // on the model it recommends instead, within the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: request.system,
          // Files first, the instructions for them after: that is the order the model reads best.
          messages: [{ role: 'user', content: [...request.content.filter((c) => c.type !== 'text'), ...request.content.filter((c) => c.type === 'text')].map(toBlock) }],
          output_config: { effort: request.effort, format: { type: 'json_schema', schema: request.schema } },
        },
        // One more try on a hiccup, then the caller hears about it: a person is waiting, or the next round will come back to it.
        { timeout: request.interactive ? 90_000 : 120_000, maxRetries: 1 },
      );
    } catch (e) {
      throw translate(e);
    }
    const usage: AiUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    if (message.stop_reason === 'refusal') throw new AiError(AI_MESSAGES.refused, 'refused', `Declined (${message.stop_details?.category ?? 'no category given'})`, usage, message.model);
    if (message.stop_reason === 'max_tokens') throw new AiError(AI_MESSAGES.unreadable, 'unreadable', 'The answer was cut off at the length limit.', usage, message.model);
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new AiError(AI_MESSAGES.unreadable, 'unreadable', `The answer is not JSON: ${text.slice(0, 200)}`, usage, message.model);
    }
    return { output, usage, model: message.model };
  }
}

let cached: { key: string; model: AiModel } | null = null;

/** The model this server is set up to use, or null while the assistant is switched off. */
export function assistantModel(): AiModel | null {
  const { ai } = getConfig();
  if (!ai.apiKey) return null;
  const key = `${ai.model}|${ai.baseUrl}|${ai.apiKey}`;
  if (cached?.key !== key) cached = { key, model: new AnthropicModel({ apiKey: ai.apiKey, model: ai.model, baseUrl: ai.baseUrl || undefined }) };
  return cached.model;
}

/** Whether the assistant is set up at all. */
export function assistantConfigured(): boolean {
  return !!getConfig().ai.apiKey;
}
