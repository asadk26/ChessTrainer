// Browser side of the LLM provider abstraction. The actual provider
// (Anthropic or OpenAI-compatible) lives in the local dev server.

export interface LlmStatus {
  provider: 'anthropic' | 'openai' | null;
  model?: string;
}

let cached: Promise<LlmStatus> | null = null;

export function getLlmStatus(): Promise<LlmStatus> {
  cached ??= fetch('/api/coach/status')
    .then((r) => (r.ok ? (r.json() as Promise<LlmStatus>) : { provider: null }))
    .catch(() => ({ provider: null }) as LlmStatus);
  return cached;
}

export async function llmComplete(system: string, prompt: string, maxTokens = 16000): Promise<string> {
  const res = await fetch('/api/coach/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system, prompt, maxTokens }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `LLM request failed (${res.status})`);
  return String(data.text ?? '');
}
