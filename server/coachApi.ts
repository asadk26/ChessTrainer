// Framework-agnostic handlers for the LLM coaching proxy, shared by the Vite
// dev/preview middleware (server/coachPlugin.ts) and the Vercel functions
// (api/coach/*.ts). API keys only ever live here, on the server side.
import { timingSafeEqual } from 'node:crypto';
import { BETA_COACH_SYSTEM_PROMPT, COACH_SYSTEM_PROMPT, GUIDED_REVIEW_SYSTEM_PROMPT, MOMENT_SYSTEM_PROMPT } from '../src/coach/systemPrompt.js';
import { providerFromEnv, type Env, type LlmProvider } from './llm.js';

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ApiOptions {
  env: Env;
  /**
   * Hosted deployments must not expose an open proxy to your API key: they
   * require COACH_ACCESS_TOKEN to be set, and every request to present it.
   */
  hosted: boolean;
}

const MAX_PROMPT_CHARS = 200_000;

function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function resolve(opts: ApiOptions): { provider: LlmProvider | null; token?: string; reason?: string } {
  const provider = providerFromEnv(opts.env);
  const token = opts.env.COACH_ACCESS_TOKEN || undefined;
  if (provider && opts.hosted && !token) {
    return { provider: null, reason: 'An LLM key is configured, but COACH_ACCESS_TOKEN is not set, so the AI coach is disabled on this deployment.' };
  }
  return { provider, token };
}

export function coachStatus(opts: ApiOptions): ApiResult {
  const { provider, token, reason } = resolve(opts);
  if (!provider) return { status: 200, body: { provider: null, reason } };
  return { status: 200, body: { provider: provider.name, model: provider.model, requiresToken: !!token } };
}

export async function coachComplete(opts: ApiOptions, givenToken: string | null | undefined, rawBody: unknown): Promise<ApiResult> {
  const { provider, token, reason } = resolve(opts);
  if (!provider) return { status: 503, body: { error: reason ?? 'No LLM configured' } };
  if (token && !tokenMatches(token, givenToken)) return { status: 401, body: { error: 'Missing or incorrect AI coach access code.' } };
  const body = (rawBody ?? {}) as { prompt?: unknown; maxTokens?: unknown; task?: unknown };
  if (body.task === 'ping') {
    // Connection test from Settings: a fixed, tiny request, so it costs next to nothing
    // and proves the access code, the key and the model all work end to end.
    try {
      const text = await provider.complete({ system: 'This is a connection test. Reply with exactly {"ok":true}', prompt: 'Connection test.', maxTokens: 1024 });
      return { status: 200, body: { text, provider: provider.name, model: provider.model } };
    } catch (e) {
      return { status: 502, body: { error: (e as Error).message } };
    }
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return { status: 400, body: { error: 'Bad request' } };
  if (body.prompt.length > MAX_PROMPT_CHARS) return { status: 413, body: { error: 'Prompt too large' } };
  // Whole-game tasks get more room: thinking models count their reasoning as output.
  const maxTokens = Math.min(32000, Math.max(256, Number(body.maxTokens) || 16000));
  try {
    // The system prompt is fixed server-side; the browser only supplies game facts.
    // Which fixed prompt: the whole-game summary, one teaching moment, or the Beta AI Coach.
    const system =
      body.task === 'moment' ? MOMENT_SYSTEM_PROMPT : body.task === 'beta' ? BETA_COACH_SYSTEM_PROMPT : body.task === 'guided' ? GUIDED_REVIEW_SYSTEM_PROMPT : COACH_SYSTEM_PROMPT;
    const text = await provider.complete({ system, prompt: body.prompt, maxTokens });
    return { status: 200, body: provider.lastUsage ? { text, usage: provider.lastUsage } : { text } };
  } catch (e) {
    return { status: 502, body: { error: (e as Error).message } };
  }
}
