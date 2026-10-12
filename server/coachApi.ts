// Framework-agnostic handlers for the LLM coaching proxy, shared by the Vite
// dev/preview middleware (server/coachPlugin.ts) and the Vercel functions
// (api/coach/*.ts). API keys only ever live here, on the server side.
import { timingSafeEqual } from 'node:crypto';
import { COACH_SYSTEM_PROMPT } from '../src/coach/systemPrompt';
import { providerFromEnv, type Env, type LlmProvider } from './llm';

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
  const body = (rawBody ?? {}) as { prompt?: unknown; maxTokens?: unknown };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return { status: 400, body: { error: 'Bad request' } };
  if (body.prompt.length > MAX_PROMPT_CHARS) return { status: 413, body: { error: 'Prompt too large' } };
  const maxTokens = Math.min(16000, Math.max(256, Number(body.maxTokens) || 16000));
  try {
    // The system prompt is fixed server-side; the browser only supplies game facts.
    const text = await provider.complete({ system: COACH_SYSTEM_PROMPT, prompt: body.prompt, maxTokens });
    return { status: 200, body: { text } };
  } catch (e) {
    return { status: 502, body: { error: (e as Error).message } };
  }
}
