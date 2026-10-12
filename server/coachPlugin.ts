import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { providerFromEnv, type Env } from './llm.ts';

type Next = (err?: unknown) => void;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Adds /api/coach/status and /api/coach/complete to the dev and preview servers. */
export function coachApiPlugin(env: Env): Plugin {
  const provider = providerFromEnv(env);
  const handler = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (!req.url?.startsWith('/api/coach/')) return next();
    try {
      if (req.url.startsWith('/api/coach/status')) {
        return json(res, 200, provider ? { provider: provider.name, model: provider.model } : { provider: null });
      }
      if (req.url.startsWith('/api/coach/complete') && req.method === 'POST') {
        if (!provider) return json(res, 503, { error: 'No LLM configured' });
        const body = JSON.parse(await readBody(req));
        if (typeof body.system !== 'string' || typeof body.prompt !== 'string') return json(res, 400, { error: 'Bad request' });
        const text = await provider.complete({ system: body.system, prompt: body.prompt, maxTokens: body.maxTokens });
        return json(res, 200, { text });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      return json(res, 502, { error: (e as Error).message });
    }
  };
  return {
    name: 'chess-coach-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
