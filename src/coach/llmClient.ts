// Browser side of the LLM provider abstraction. The actual provider
// (Anthropic or OpenAI-compatible) and its API key live server-side: in the
// local Vite server during development, or in a Vercel Function when hosted.

export interface LlmStatus {
  provider: 'anthropic' | 'openai' | null;
  model?: string;
  /** Hosted deployments require an access code (COACH_ACCESS_TOKEN). */
  requiresToken?: boolean;
  /** Why the coach is unavailable, when the server says so. */
  reason?: string;
}

let cached: Promise<LlmStatus> | null = null;

export function getLlmStatus(): Promise<LlmStatus> {
  cached ??= fetch('/api/coach/status')
    .then(async (r) => {
      const isJson = r.headers.get('content-type')?.includes('application/json');
      return r.ok && isJson ? ((await r.json()) as LlmStatus) : { provider: null };
    })
    .catch(() => ({ provider: null }) as LlmStatus);
  return cached;
}

export async function llmComplete(prompt: string, token?: string, maxTokens = 16000): Promise<string> {
  const res = await fetch('/api/coach/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-coach-token': token } : {}) },
    body: JSON.stringify({ prompt, maxTokens }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `LLM request failed (${res.status})`);
  return String(data.text ?? '');
}
