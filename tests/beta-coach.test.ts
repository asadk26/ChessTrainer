// Beta AI Coach: the whole-game facts the model gets, and the checks that keep its
// broader judgements from turning into invented tactics.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { betaPrompt, buildBetaContext, checkText, parseBetaReview } from '../src/coach/betaCoach';
import { UngroundedError } from '../src/coach/momentContext';
import { BETA_COACH_SYSTEM_PROMPT } from '../src/coach/systemPrompt';
import { coachComplete } from '../server/coachApi';
import { fixtureGame } from './helpers';

const coached = (n: Parameters<typeof fixtureGame>[0]) => {
  const { game, positions } = fixtureGame(n);
  return coachFromPositions(game, positions, []).game;
};

describe('Beta AI Coach context', () => {
  const game = coached('queen-blunder-game');
  const ctx = buildBetaContext(game, [game], 900)!;
  const f = ctx.facts as any;

  it('carries the whole game and the engine evidence', () => {
    expect(f.pgn).toMatch(/1\. \w+/);
    expect(f.pgn).not.toMatch(/%clk/);
    expect(f.student).toMatchObject({ color: 'Black', rating: 900, result: 'loss' });
    expect(f.evaluationTimeline.length).toBeGreaterThan(5);
    expect(f.materialSwings).toEqual([expect.objectContaining({ afterMove: '12.Nxd7', change: 'you lost a queen' })]);
    const blunder = f.criticalPositions.find((c: any) => c.move === '11...Qd7');
    expect(blunder.verdict).toBe('Blunder');
    expect(blunder.stockfishTopMoves[0]).toMatchObject({ move: 'Nd7', quality: 'Best move' });
    expect(blunder.playedMoveLine.whatHappens).toBe('White wins your queen for a knight');
    expect(f.positionalCheckpoints[0].you).toHaveProperty('castled', false);
    expect(f.detectedFeatures.length).toBeGreaterThan(0);
    expect(betaPrompt(ctx)).toContain('11...Qd7');
  });

  it('works for a clean win too: there is still something to learn from good decisions', () => {
    const win = coached('resign-win-game');
    const w = buildBetaContext(win, [win], 900)!.facts as any;
    expect(w.student.result).toBe('win');
    expect(w.engineStats.yourBlunders).toBe(0);
    expect(w.criticalPositions.some((c: any) => c.whyCritical.some((x: string) => /only clearly good move|good answer/.test(x)))).toBe(true);
  });
});

describe('Beta AI Coach checks', () => {
  const game = coached('queen-blunder-game');
  const ctx = buildBetaContext(game, [game], 900)!;

  it('keeps broad coaching judgements', () => {
    const t = 'This was a quiet, balanced game until one moment decided it. You developed well and kept the position level for ten moves.';
    expect(checkText(t, ctx, game)).toEqual({ text: t, removed: [] });
  });

  it('keeps concrete claims the engine supports', () => {
    const t = 'After 11...Qd7, Nxd7 simply won your queen for a knight.';
    expect(checkText(t, ctx, game).removed).toEqual([]);
  });

  it('removes invented tactics, unknown moves and mates that are not there', () => {
    const r = checkText('You played well. Earlier, 7...Ba5 hung a bishop. Qh4 would have won material. White had a forced mate after 12.Nxd7.', ctx, game);
    expect(r.text).toBe('You played well.');
    expect(r.removed.map((x) => x.reason)).toEqual([
      expect.stringMatching(/doesn't show that material change/),
      expect.stringMatching(/Qh4 is not a move/),
      expect.stringMatching(/no such mate/),
    ]);
  });

  it('parses the three outputs, dropping bad references', () => {
    const raw = JSON.stringify({
      summary: ['A calm opening, then one blunder decided it.', 'Qh4 wins a rook.'],
      insights: { strengths: ['Good development by move 10.'], weaknesses: ['Checking what your move leaves undefended.'], trend: 'Not enough history yet.', observations: ['You let your bishop get chased.'] },
      instructor: {
        priority: 'Blunder-check every queen move',
        whyItMatters: 'One unchecked move undid ten good ones.',
        moments: [{ ply: 22, note: '11...Qd7 walked into Nxd7.' }, { ply: 999, note: 'bad ply' }],
        thinkDifferently: 'Before moving the queen, ask what can capture on that square.',
        practice: [{ ply: 22, why: 'Find a safe developing move.' }, { ply: 21, why: "the opponent's move" }],
      },
    });
    const r = parseBetaReview(raw, ctx, game, 'gemini-test');
    expect(r.summary).toEqual(['A calm opening, then one blunder decided it.']);
    expect(r.removed).toHaveLength(1);
    expect(r.instructor.moments).toEqual([{ ply: 22, note: '11...Qd7 walked into Nxd7.' }]);
    expect(r.instructor.practice).toEqual([{ ply: 22, why: 'Find a safe developing move.' }]);
    expect(r.insights.observations).toHaveLength(1);
    expect(r.grounding).toBe(ctx.grounding);
  });

  it('rejects an answer with no usable summary', () => {
    expect(() => parseBetaReview(JSON.stringify({ summary: ['Qh4 wins a rook.'] }), ctx, game)).toThrow(UngroundedError);
  });
});

describe('Beta AI Coach prompt', () => {
  it('is fixed server-side and tells the model to interpret, not repeat', async () => {
    expect(BETA_COACH_SYSTEM_PROMPT).toContain('Use Stockfish as evidence, but form your own instructional interpretation of what this player should learn from the game. Do not merely repeat engine labels.');
    let system = '';
    const fake = (async (_u: string, init: RequestInit) => {
      system = JSON.parse(String(init.body)).systemInstruction.parts[0].text;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
    }) as unknown as typeof fetch;
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      await coachComplete({ env: { GEMINI_API_KEY: 'k' }, hosted: false }, null, { prompt: 'facts', task: 'beta', maxTokens: 12000 });
    } finally {
      globalThis.fetch = real;
    }
    expect(system).toBe(BETA_COACH_SYSTEM_PROMPT);
  });
});
