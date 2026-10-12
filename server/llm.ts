// LLM provider abstraction. Runs inside the local Vite dev/preview server so
// API keys never reach the browser bundle. The browser calls /api/coach/*.
import Anthropic from '@anthropic-ai/sdk';

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'gemini';
  readonly model: string;
  complete(req: LlmRequest): Promise<string>;
}

export type Env = Record<string, string | undefined>;

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private client: Anthropic;
  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }
  async complete(req: LlmRequest): Promise<string> {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('The model declined this request.');
    return msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = 'openai' as const;
  constructor(
    private baseUrl: string,
    private apiKey: string | undefined,
    readonly model: string,
  ) {}
  async complete(req: LlmRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        max_tokens: req.maxTokens ?? 4000,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

/**
 * Google Gemini through its REST API (generateContent). The key is sent in a
 * header from the server only; replies are requested as JSON.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  constructor(
    private apiKey: string,
    readonly model: string,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}
  async complete(req: LlmRequest): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: req.maxTokens ?? 4096, responseMimeType: 'application/json' },
      }),
    });
    if (res.status === 429) throw new Error('Gemini rate limit reached (free tier). Try again in a minute.');
    if (!res.ok) throw new Error(`Gemini returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    if (data.promptFeedback?.blockReason) throw new Error(`Gemini declined this request (${data.promptFeedback.blockReason}).`);
    const c = data.candidates?.[0];
    const text = c?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error(`Gemini returned no text${c?.finishReason ? ` (${c.finishReason})` : ''}.`);
    return text;
  }
}

/** Default model: Google's alias for its current Flash model (free tier). Override with GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

/** Pick a provider from environment variables, or null when none is configured. */
export function providerFromEnv(env: Env): LlmProvider | null {
  const forced = env.COACH_LLM_PROVIDER?.toLowerCase();
  if (forced === 'none') return null;
  const anthropic = env.ANTHROPIC_API_KEY ? new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || 'claude-opus-5-5') : null;
  const openai = env.OPENAI_BASE_URL || env.OPENAI_API_KEY
    ? new OpenAICompatibleProvider(env.OPENAI_BASE_URL || 'https://api.openai.com/v1', env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-4o-mini')
    : null;
  const gemini = env.GEMINI_API_KEY ? new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL) : null;
  if (forced === 'openai') return openai;
  if (forced === 'anthropic') return anthropic;
  if (forced === 'gemini') return gemini;
  return gemini ?? anthropic ?? openai;
}
