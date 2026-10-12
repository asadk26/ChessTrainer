// The optional Gemini instructor: provider wiring, grounding checks, and the app without it.
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiProvider, providerFromEnv, DEFAULT_GEMINI_MODEL } from '../server/llm';
import { coachComplete, coachStatus } from '../server/coachApi';
import { MOMENT_SYSTEM_PROMPT } from '../src/coach/systemPrompt';
import { buildMomentContext, momentPrompt, parseMomentExplanation, UngroundedError } from '../src/coach/momentContext';
import { coachFromPositions } from '../src/analysis/pipeline';
import { fixtureGame } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Gemini provider', () => {
  it('sends the key in a header (never the URL), the fixed system prompt, and asks for JSON', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"whyBetter":"x"}' }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new GeminiProvider('test-key', 'gemini-test', fake);
    expect(await p.complete({ system: 'SYS', prompt: 'FACTS', maxTokens: 500 })).toBe('{"whyBetter":"x"}');
    expect(seen[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(seen[0].url).not.toMatch(/test-key/);
    expect(new Headers(seen[0].init.headers).get('x-goog-api-key')).toBe('test-key');
    const body = JSON.parse(String(seen[0].init.body));
    expect(body.systemInstruction.parts[0].text).toBe('SYS');
    expect(body.contents[0].parts[0].text).toBe('FACTS');
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', maxOutputTokens: 500 });
  });

  it('explains free-tier rate limits and empty answers instead of failing silently', async () => {
    const limited = new GeminiProvider('k', 'm', (async () => new Response('quota', { status: 429 })) as unknown as typeof fetch);
    await expect(limited.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/rate limit/);
    const empty = new GeminiProvider('k', 'm', (async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }))) as unknown as typeof fetch);
    await expect(empty.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/no text \(SAFETY\)/);
  });

  it('is picked from GEMINI_API_KEY, with a configurable model', () => {
    expect(providerFromEnv({ GEMINI_API_KEY: 'k' })).toMatchObject({ name: 'gemini', model: DEFAULT_GEMINI_MODEL });
    expect(providerFromEnv({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-x' })?.model).toBe('gemini-x');
    expect(providerFromEnv({ GEMINI_API_KEY: 'k', COACH_LLM_PROVIDER: 'none' })).toBeNull();
    expect(providerFromEnv({})).toBeNull();
  });

  it('still requires the personal access code when hosted, so the key is not an open proxy', () => {
    expect(coachStatus({ env: { GEMINI_API_KEY: 'k' }, hosted: true }).body.provider).toBeNull();
    expect(coachStatus({ env: { GEMINI_API_KEY: 'k', COACH_ACCESS_TOKEN: 't' }, hosted: true }).body).toMatchObject({ provider: 'gemini', requiresToken: true });
  });

  it('uses the fixed, server-side moment prompt for task "moment"', async () => {
    let system = '';
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        system = JSON.parse(b).messages[0].content;
        res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const env = { OPENAI_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
    await coachComplete({ env, hosted: false }, null, { prompt: 'facts', task: 'moment' });
    server.close();
    expect(system).toBe(MOMENT_SYSTEM_PROMPT);
  });
});

describe('grounded moment context', () => {
  const { game: g, positions } = fixtureGame('queen-blunder-game');
  const game = coachFromPositions(g, positions, []).game;
  const ctx = buildMomentContext(game, 22, { rating: 900, prior: [] })!; // 11...Qd7

  it('gives the model the position, the move, Stockfish candidates, the reply and the comparison', () => {
    const f = ctx.facts as Record<string, any>;
    expect(f.fen).toBe(game.plies[21].fenBefore);
    expect(f.student).toMatchObject({ color: 'Black', rating: 900, isStudentsMove: true });
    expect(f.movePlayed).toMatchObject({ move: 'Qd7', quality: 'Blunder', evaluationAfter: 'losing' });
    expect(f.stockfishCandidates.length).toBeGreaterThanOrEqual(2);
    expect(f.stockfishCandidates[0].quality).toBe('Best move');
    expect(f.opponentStrongestReply).toMatchObject({ move: 'Nxd7', whatHappens: 'White wins your queen for a knight' });
    expect(f.comparison.clearDifference).toBe(true);
    expect(JSON.stringify(f)).not.toMatch(/cp|centipawn/i);
    expect(momentPrompt(ctx)).toContain('"move": "Qd7"');
  });

  it('accepts a grounded answer and rejects one that mentions moves Stockfish never gave', () => {
    const ok = parseMomentExplanation(
      JSON.stringify({ tryingTo: 'You wanted to connect pieces.', missed: 'Nxd7 simply takes the queen.', whyBetter: 'Qe7 keeps the queen safe.', opponentReply: 'Nxd7.', difference: 'You keep your queen.', takeaway: 'Check what can be captured.', pattern: '', confidence: 'clear' }),
      ctx,
      22,
      'gemini-test',
    );
    expect(ok).toMatchObject({ ply: 22, whyBetter: 'Qe7 keeps the queen safe.', confidence: 'clear', grounding: ctx.grounding });
    expect(() => parseMomentExplanation(JSON.stringify({ whyBetter: 'Nf7 would win the game.', takeaway: 'x' }), ctx, 22)).toThrow(UngroundedError);
    expect(() => parseMomentExplanation(JSON.stringify({ tryingTo: 'x' }), ctx, 22)).toThrow(/empty/);
    expect(parseMomentExplanation('```json\n{"whyBetter":"Small.","takeaway":"t","confidence":"small_difference"}\n```', ctx, 22).confidence).toBe('small_difference');
  });
});

describe('the app without Gemini', () => {
  it('coaches fully from Stockfish alone (no AI fields needed)', () => {
    const { game: g, positions } = fixtureGame('queen-blunder-game');
    const { game } = coachFromPositions(g, positions, []);
    expect(game.report?.headline).toBeTruthy();
    expect(game.moments.some((m) => m.tier === 'lesson')).toBe(true);
    expect(game.aiExplanations).toBeUndefined();
  });

  it('keeps the key and the Google endpoint out of the browser bundle', () => {
    const dist = join(root, 'dist', 'assets');
    if (!existsSync(dist)) return; // checked after `npm run build`
    for (const f of readdirSync(dist).filter((x) => x.endsWith('.js'))) {
      const js = readFileSync(join(dist, f), 'utf8');
      expect(js, f).not.toMatch(/GEMINI_API_KEY|x-goog-api-key|generativelanguage\.googleapis|ANTHROPIC_API_KEY|COACH_ACCESS_TOKEN=/);
    }
  });
});
