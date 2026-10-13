// The Vercel functions, compiled the way Vercel compiles them (Node ESM, NodeNext)
// and loaded with plain Node — no Vite or tsx resolving imports for us. This catches
// both type errors and imports that only work under a bundler.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Inside the repo so compiled files resolve packages from node_modules like on Vercel.
const out = join(root, 'node_modules', '.tmp', 'api-runtime');

type Handler = (req?: Request) => Promise<Response> | Response;
let status: Handler;
let complete: Handler;
let chesscom: Handler;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  rmSync(out, { recursive: true, force: true });
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.api.json', '--noEmit', 'false', '--outDir', out, '--rootDir', '.'], {
    cwd: root,
    stdio: 'pipe',
  });
  const load = async (p: string) => import(pathToFileURL(join(out, p)).href);
  status = (await load('api/coach/status.js')).GET;
  complete = (await load('api/coach/complete.js')).POST;
  chesscom = (await load('api/chesscom.js')).GET;
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'COACH_ACCESS_TOKEN', 'CHESSCOM_CONTACT']) delete process.env[k];
  rmSync(out, { recursive: true, force: true });
});

describe('Vercel functions compiled as Node ESM', () => {
  it('/api/coach/status responds with no AI configured', async () => {
    const r = await status();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ provider: null });
  });

  it('/api/coach/status reports Gemini once GEMINI_API_KEY and COACH_ACCESS_TOKEN are set', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.COACH_ACCESS_TOKEN = 'my-code';
    const body = await (await status()).json();
    expect(body).toMatchObject({ provider: 'gemini', requiresToken: true });
    expect(JSON.stringify(body)).not.toMatch(/test-gemini-key|my-code/);
  });

  it('/api/coach/complete reaches the Gemini API with the key in a header, and only with the access code', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.COACH_ACCESS_TOKEN = 'my-code';
    const calls: { url: string; key: string | null; body: any }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), key: new Headers(init.headers).get('x-goog-api-key'), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"whyBetter":"ok"}' }] } }] }), { status: 200 });
    }) as typeof fetch;
    const req = (headers: Record<string, string>) =>
      new Request('https://app/api/coach/complete', { method: 'POST', headers, body: JSON.stringify({ prompt: 'facts', task: 'moment', maxTokens: 800 }) });
    expect((await complete(req({}))).status).toBe(401);
    expect(calls).toHaveLength(0);
    const ok = await complete(req({ 'x-coach-token': 'my-code' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: '{"whyBetter":"ok"}' });
    expect(calls[0].url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent$/);
    expect(calls[0].key).toBe('test-gemini-key');
    expect(calls[0].body.systemInstruction.parts[0].text).toMatch(/patient chess instructor/);
    globalThis.fetch = realFetch;
  });

  it('/api/coach/complete answers the Settings connection test with a fixed server-side prompt', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.COACH_ACCESS_TOKEN = 'my-code';
    const calls: any[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
    }) as typeof fetch;
    const req = (headers: Record<string, string>) =>
      new Request('https://app/api/coach/complete', { method: 'POST', headers, body: JSON.stringify({ task: 'ping' }) });
    expect((await complete(req({ 'x-coach-token': 'wrong' }))).status).toBe(401);
    const ok = await complete(req({ 'x-coach-token': 'my-code' }));
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].systemInstruction.parts[0].text).toMatch(/connection test/);
    globalThis.fetch = (async () => new Response('model not found', { status: 404 })) as typeof fetch;
    const bad = await complete(req({ 'x-coach-token': 'my-code' }));
    expect(bad.status).toBe(502);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Gemini returned 404/);
    globalThis.fetch = realFetch;
  });

  it('/api/chesscom proxies the archive list with a User-Agent and rejects other paths', async () => {
    process.env.CHESSCOM_CONTACT = 'me@example.com';
    const seen: { url: string; ua: string | null }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), ua: new Headers(init.headers).get('user-agent') });
      return new Response('{"archives":[]}', { status: 200 });
    }) as typeof fetch;
    const ok = await chesscom(new Request('https://app/api/chesscom?path=player/chunkmonkey420/games/archives'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-chesscom-proxy')).toBe('1');
    expect(await ok.json()).toEqual({ archives: [] });
    expect(seen[0]).toEqual({ url: 'https://api.chess.com/pub/player/chunkmonkey420/games/archives', ua: expect.stringMatching(/ChessCoach.*me@example\.com/) });
    expect((await chesscom(new Request('https://app/api/chesscom?path=player/x/stats'))).status).toBe(400);
    globalThis.fetch = realFetch;
  });
});
