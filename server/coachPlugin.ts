import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { Env } from './llm.js';
import { coachComplete, coachStatus, type ApiResult } from './coachApi.js';
import { proxyChessCom } from './chesscomProxy.js';
import { proxyLichess } from './lichessProxy.js';

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

function send(res: ServerResponse, r: ApiResult) {
  res.statusCode = r.status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(r.body));
}

/** Adds /api/coach/status, /api/coach/complete, /api/chesscom and /api/lichess to the local dev and preview servers. */
export function coachApiPlugin(env: Env): Plugin {
  // Locally there's no open-proxy risk, so an access token is optional.
  const opts = { env, hosted: false };
  const handler = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (req.url?.startsWith('/api/chesscom')) {
      const r = await proxyChessCom(new URL(req.url, 'http://local').searchParams.get('path'), env);
      res.statusCode = r.status;
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      return res.end(r.body);
    }
    if (req.url?.startsWith('/api/lichess')) {
      const r = await proxyLichess(new URL(req.url, 'http://local').searchParams, env, { hosted: false });
      res.statusCode = r.status;
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      return res.end(r.body);
    }
    if (!req.url?.startsWith('/api/coach/')) return next();
    try {
      if (req.url.startsWith('/api/coach/status')) return send(res, coachStatus(opts));
      if (req.url.startsWith('/api/coach/complete') && req.method === 'POST') {
        const token = req.headers['x-coach-token'];
        return send(res, await coachComplete(opts, Array.isArray(token) ? token[0] : token, JSON.parse(await readBody(req))));
      }
      return send(res, { status: 404, body: { error: 'Not found' } });
    } catch (e) {
      return send(res, { status: 400, body: { error: (e as Error).message } });
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
