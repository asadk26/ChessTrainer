// Beta AI Coach (v2): the whole-game Stockfish evidence the model gets, and the
// referee that keeps its free interpretation from teaching false chess.
// Regression game: the student's draw as Black, where 19...e4 (prepared by 18...f5)
// turned a slightly better position into a worse one, 21.Nxe4 was only the
// consequence, and the later rook-ending defence held the draw.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coachFromPositions } from '../src/analysis/pipeline';
import { betaPrompt, buildBetaContext, checkText, currentReview, evaluationShifts, needsBetaEval, parseBetaReview } from '../src/coach/betaCoach';
import { UngroundedError } from '../src/coach/momentContext';
import { BETA_COACH_SYSTEM_PROMPT } from '../src/coach/systemPrompt';
import { coachComplete } from '../server/coachApi';
import type { StoredGame } from '../src/domain/types';
import { fixtureGame } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));

function drawGame(): StoredGame {
  const { game, positions } = fixtureGame('draw-game');
  const coached = coachFromPositions(game, positions, []).game;
  // The Beta pass the app makes before the review: every position at depth 16 (recorded with Node Stockfish).
  const own = JSON.parse(readFileSync(join(here, 'fixtures', 'draw-game-beta-eval.json'), 'utf8'));
  return { ...coached, status: 'analyzed', aiCoachEval: own };
}

const game = drawGame();
const ctx = buildBetaContext(game, [game], 900)!;
const f = ctx.facts as any;

describe('Beta AI Coach evidence (draw game)', () => {
  it('gives the whole game: PGN, colour, result and every half-move with its evaluation', () => {
    expect(f.student).toMatchObject({ color: 'Black', rating: 900, result: 'draw' });
    expect(f.pgn).toContain('18. Qe2 f5 19. Nc3 e4 20. dxe4 fxe4 21. Nxe4');
    expect(f.evaluationTimeline).toHaveLength(game.plies.length);
    const e4 = f.evaluationTimeline.find((r: string) => r.startsWith('19...e4'));
    expect(e4).toMatch(/19\.\.\.e4 \(you\): -0\.\d \(−1\.\d\) · mistake · Stockfish preferred \w+/);
    expect(f.evaluationTimeline.find((r: string) => r.startsWith('18...f5'))).not.toMatch(/mistake|blunder/);
  });

  it('does not pre-select lessons: no moments, focus or rule-based explanations', () => {
    const json = JSON.stringify(f);
    for (const key of ['moments', 'focus', 'builtInCoach', 'ruleBasedNote', 'lesson']) expect(json).not.toContain(`"${key}"`);
    expect(f.ruleBasedDetections.note).toMatch(/not a list of lessons/);
    expect(f.playerProfile.note).toMatch(/context/i);
  });

  it('finds the evaluation shift through the …f5/…e4 sequence, with the lead-up and each move’s effect', () => {
    const shift = f.evaluationShifts.find((s: any) => s.fromPly <= 38 && s.toPly >= 38);
    expect(shift.direction).toBe('against you');
    expect(shift.moveByMove[0]).toMatch(/^18\.\.\.f5 \(you\)/);
    const effects = shift.moveByMove.map((m: string) => [m.split(' ')[0], Number(m.split(' ').pop()!.replace('−', '-'))]);
    const worst = effects.filter(([mv]: [string]) => mv.includes('...')).sort((a: any, b: any) => a[1] - b[1]);
    // 19...e4 is the student's biggest single drop before 24...b5.
    expect(effects.find(([mv]: [string]) => mv === '19...e4')[1]).toBeLessThan(-1);
    expect(worst.slice(0, 2).map((x: any) => x[0])).toContain('19...e4');
  });

  it('shows Stockfish’s candidates at 19...e4, and that the pawn is lost once the line settles', () => {
    const at = f.candidatePositions.find((p: any) => p.beforeMove === '19...e4');
    expect(at.depth).toBe(16);
    expect(at.stockfishTop.map((t: any) => t.move)).toContain('Rfe8');
    expect(at.played.afterFullLine).toMatch(/you are down a pawn once the line settles/);
  });

  it('includes the opponent’s missed chance after 24...b5 and the endgame defence', () => {
    expect(f.notableMoves.opponentMistakesAndBlunders.some((m: string) => m.startsWith('25.c5'))).toBe(true);
    const c5 = f.candidatePositions.find((p: any) => p.beforeMove === '25.c5');
    expect(c5.stockfishTop[0].move).toBe('Ng5');
    expect(f.notableMoves.yourOnlyMoveFinds.join(' ')).toMatch(/38\.\.\.Rc3|39\.\.\.Rxc7/);
    expect(f.phaseMarkers.endgameFrom).toBe('30...hxg6');
  });

  it('counts a recapture from before the capture (30...hxg6 is not "winning a queen")', () => {
    const at = f.candidatePositions.find((p: any) => p.beforeMove === '30...hxg6');
    expect(at.note).toMatch(/30\.Qxg6 was a capture/);
    expect(at.played.whatHappens).toBeUndefined();
    expect(at.played.afterFullLine).toMatch(/level in material/);
  });

  it('reads castling from the moves, not the king’s square', () => {
    expect(f.positionalCheckpoints[1]).toMatchObject({ afterMove: '20...fxe4', opponent: { castled: true, king: 'g2' } });
  });

  it('evaluates every position once at one depth, so move effects compare like with like', () => {
    expect(needsBetaEval({ ...game, aiCoachEval: undefined })).toBe(true);
    expect(needsBetaEval(game)).toBe(false);
    expect(game.aiCoachEval!.positions.every((p) => p.terminal || p.depth === 16)).toBe(true);
    expect(f.engine).toMatch(/every position at depth 16 in one pass/);
  });

  it('does not invent an endgame comeback: no shift in your favour from your own moves around 36...a5–40...Rc4', () => {
    const shifts = evaluationShifts(game);
    expect(shifts.map((s) => s.direction)).toContain('against you');
    for (const s of shifts.filter((x) => x.direction === 'in your favour')) {
      const yours = s.moves.filter((m) => m.ply >= s.fromPly && game.plies[m.ply - 1].color === 'b' && m.change > 50);
      expect(yours.filter((m) => m.ply >= 72 && m.ply <= 80)).toEqual([]);
    }
    const row = (mv: string) => f.evaluationTimeline.find((r: string) => r.startsWith(mv)) as string;
    // 38...Rc3 is Stockfish's choice and changes little; it is not a "shift".
    expect(row('38...Rc3')).toMatch(/\(−0\.\d\) · best move/);
  });

  it('marks moves where Stockfish is unsure, mostly in the rook ending, and keeps them out of the shifts', () => {
    expect(ctx.unsurePlies.size).toBeGreaterThan(0);
    expect([...ctx.unsurePlies].every((k) => k > 60)).toBe(true);
    expect(f.evaluationTimeline.filter((r: string) => r.includes('engine unsure here')).length).toBe(ctx.unsurePlies.size);
    for (const s of evaluationShifts(game)) expect(ctx.unsurePlies.has(s.fromPly)).toBe(false);
  });

  it('fits comfortably in one request', () => {
    expect(betaPrompt(ctx).length).toBeLessThan(60_000);
  });
});

describe('the Stockfish referee', () => {
  const keep = (t: string) => expect(checkText(t, ctx, game)).toEqual({ text: t, removed: [] });
  const drop = (t: string, reason: RegExp) => {
    const r = checkText(t, ctx, game);
    expect(r.text).toBe('');
    expect(r.removed[0]?.reason).toMatch(reason);
  };

  it('leaves high-level instructional judgements free', () => {
    keep('You became impatient in a quiet position and forced the play before your pieces were ready.');
    keep('This game shows strong defensive patience: your rook activity saved the ending.');
    keep('Accepting the repetition was a successful defensive result from a worse position.');
  });

  it('accepts the causal reading the evidence supports', () => {
    keep('The important decision came earlier: 18...f5 and 19...e4 looked active, but after the exchanges 21.Nxe4 left White better.');
    keep('Rfe8 was Stockfish’s choice instead of 19...e4.');
    keep('You lost a pawn on 21.Nxe4, but that was the consequence of the pawn break.');
  });

  it('removes praise of a move Stockfish rates as a mistake', () => {
    drop('19...e4 was a strong central break that freed your position.', /19\.\.\.e4 made your position worse \(\+0\.\d → -0\.\d for you\)/);
  });

  it('judges praise on the evaluation, not the label (an "inaccuracy" that cost a pawn is not praised)', () => {
    const relabelled = { ...ctx, verdicts: new Map([...ctx.verdicts].map(([k, v]) => [k, k === 38 ? ('inaccuracy' as const) : v])) };
    expect(checkText('19...e4 was a strong central break.', relabelled, game).text).toBe('');
    keep('18...f5 was a reasonable move.');
  });

  it('removes blame of a move Stockfish rates best', () => {
    drop('25...Be7 was a mistake.', /best move/);
  });

  it('removes recommendations Stockfish never made', () => {
    drop('Instead of 19...e4, 19...Qd7 would have been better.', /Qd7 isn't among Stockfish's candidate moves/);
  });

  it('removes claims about pawns that could not be stopped, mates and material that never happened', () => {
    drop("White's c-pawn could not be stopped.", /no pawn that couldn't be stopped/);
    drop('After 33...Re2+ White was getting mated.', /no such mate/);
    drop('41...Kg8 dropped a rook.', /material change/);
  });

  // Sentences from the first real Gemini review of this game (October 2026).
  it('catches the claims the first real review got wrong', () => {
    drop('38...Rc3 was rated Black\'s best move, shifting the evaluation from -3.4 to -1.7.', /evaluation around 38\.\.\.Rc3 was .* not -1\.7/);
    drop('44.Kg5 was a blunder that let you back into the game.', /unstable around 44\.Kg5/);
    drop('You correctly played 24...b5 to free your queenside.', /24\.\.\.b5 made your position worse/);
  });

  it('does not praise small concessions in the middle of a run going against you', () => {
    expect(ctx.adversePlies.has(44)).toBe(true); // 22...Bd6
    drop('22...Bd6 was a sensible, well-judged move.', /22\.\.\.Bd6 made your position worse/);
  });

  it('checks quoted evaluation figures against the timeline', () => {
    keep('Before 19...e4 the evaluation was +0.8; after it, -0.8.');
    drop('After 19...e4 the evaluation was still +0.5.', /not 0\.5|not \+0\.5/);
  });

  it('does not let a draw be called "forced" when the opponent had better', () => {
    const relabelled = { ...ctx, verdicts: new Map([...ctx.verdicts].map(([k, v]) => [k, k === 97 ? ('mistake' as const) : v])), unsurePlies: new Set<number>() };
    expect(checkText('Your king pressure forces the repetition.', relabelled, game).removed[0]?.reason).toMatch(/49\.Rb5: the draw wasn't forced/);
    keep('White chose to repeat the position, and the draw was a good practical result for you.');
  });

  it('removes moves that are not in the game, the lines, or legal', () => {
    drop('19...Nf3 was possible.', /not legal at that point/);
    drop('52...Kc6 drew.', /not a move number/);
    drop('Qh1xa8 wins.', /not a move/);
  });
});

// A plausible model answer for this game (written for the test, not real Gemini output),
// with mistakes the referee must catch.
const MOCK = {
  story:
    'A balanced Italian-style opening turned when you forced the centre open with 18...f5 and 19...e4. White came out a pawn up with the better position, but you defended the rook ending actively and held the draw.',
  chapters: [
    { title: 'A solid, equal opening', kind: 'opening', fromPly: 1, toPly: 28, anchorPly: 18, assessment: 'well', narrative: 'You developed quickly and castled. The trades on f3 and g2 left an equal position.', evidence: ['the evaluation stayed within half a pawn'], lesson: '', diagram: false, explore: false },
    {
      title: 'You force the position too soon',
      kind: 'strategic_decision',
      fromPly: 36,
      toPly: 41,
      anchorPly: 38,
      decisionPly: 38,
      consequencePly: 41,
      assessment: 'poorly',
      narrative:
        'In a quiet position you chose 18...f5 and then 19...e4 to force action. 19...e4 was a strong central break. After 20.dxe4 fxe4 21.Nxe4 White wins the pawn and the knight lands on a great square. Nxe4 is the consequence; the pawn break was the decision.',
      evidence: ['after 19...e4 the evaluation went from slightly better for you to slightly worse', 'Rfe8 kept the balance'],
      lesson: 'Before a pawn break, check what the opened lines give your opponent.',
      diagram: true,
      explore: true,
    },
    { title: 'White misses Ng5', kind: 'missed_chance', fromPly: 48, toPly: 49, anchorPly: 49, assessment: 'mixed', narrative: '24...b5 was a serious mistake, but White missed Ng5 and played 25.c5.', evidence: ['Ng5 was Stockfish’s choice'], lesson: '', diagram: true, explore: true },
    { title: 'Active rook defence', kind: 'defence', fromPly: 61, toPly: 78, anchorPly: 66, assessment: 'well', narrative: 'Instead of waiting, 33...Re2+ and 34...Ra2 activated your rook. White\'s c-pawn could not be stopped. You stopped it with 38...Rc3 and 39...Rxc7.', evidence: [], lesson: 'In rook endings an active rook is worth a pawn.', diagram: true, explore: false },
    { title: 'Holding the draw', kind: 'result', fromPly: 79, toPly: 98, anchorPly: 90, assessment: 'well', narrative: 'Your king walked to c6 to support the b-pawn and you accepted the repetition.', evidence: [], lesson: '', diagram: true, explore: false },
    { title: 'Broken chapter', fromPly: 500, toPly: 600, narrative: 'nothing' },
  ],
  lessons: ['A pawn break is a commitment: check the evaluation-changing replies first.', 'Active defence saves worse endgames.'],
  practice: [
    { ply: 38, why: 'Find a move that keeps the tension.' },
    { ply: 49, why: "White's move — not yours." },
    { ply: 76, why: 'Stop the c-pawn.' },
  ],
};

describe('parsing a review', () => {
  const r = parseBetaReview(JSON.stringify(MOCK), ctx, game, 'gemini-test');

  it('keeps chapters in order with their causal decision and consequence', () => {
    expect(r.version).toBe(4);
    expect(r.chapters.map((c) => c.title)).toEqual(['A solid, equal opening', 'You force the position too soon', 'White misses Ng5', 'Active rook defence', 'Holding the draw']);
    const c = r.chapters[1];
    expect(c).toMatchObject({ decisionPly: 38, consequencePly: 41, anchorPly: 38, assessment: 'poorly', explore: true, diagram: true });
  });

  it('strips the praise of 19...e4 and the unstoppable c-pawn, keeping the rest', () => {
    expect(r.chapters[1].narrative).not.toMatch(/strong central break/);
    expect(r.chapters[1].narrative).toMatch(/^In a quiet position you chose 18\.\.\.f5 and then 19\.\.\.e4 to force action\./);
    expect(r.chapters[1].narrative).toMatch(/Nxe4 is the consequence; the pawn break was the decision\./);
    expect(r.chapters[3].narrative).not.toMatch(/could not be stopped/);
    expect(r.chapters[3].narrative).toMatch(/38\.\.\.Rc3/);
    expect(r.removed.map((x) => x.text)).toEqual(expect.arrayContaining(['19...e4 was a strong central break.', "White's c-pawn could not be stopped."]));
    expect(r.removed.find((x) => x.text.startsWith('19...e4'))!.reason).toMatch(/made your position worse/);
  });

  it('referees titles too, and gives every chapter after the opening a board', () => {
    const t = parseBetaReview(
      JSON.stringify({ ...MOCK, chapters: [MOCK.chapters[0], { ...MOCK.chapters[4], title: 'Rh7xh8 wins the game', diagram: false }, MOCK.chapters[1]] }),
      ctx,
      game,
    );
    const last = t.chapters.find((c) => c.fromPly === 79)!;
    expect(last.title).toBe('Moves 40.Rxb5 – 49...Kc6');
    expect(last.diagram).toBe(true);
    expect(t.chapters[0].diagram).toBe(false); // the opening chapter keeps the model's choice
  });

  it('keeps only practice positions before the student’s own moves', () => {
    expect(r.practice.map((p) => p.ply)).toEqual([38, 76]);
  });

  it('is the current review once stored; older formats are ignored', () => {
    expect(currentReview({ ...game, aiCoach: r })).toBe(r);
    expect(currentReview({ ...game, aiCoach: { summary: ['old'] } as never })).toBeUndefined();
  });

  it('rejects an answer with too little that agrees with the engine', () => {
    expect(() => parseBetaReview(JSON.stringify({ story: 'x', chapters: [{ fromPly: 38, toPly: 38, narrative: '19...e4 was a brilliant break.' }] }), ctx, game)).toThrow(UngroundedError);
  });
});

describe('the Beta prompt', () => {
  it('is fixed server-side and asks for causal turning points and an evaluation check', async () => {
    for (const phrase of [
      'Use Stockfish as evidence, but form your own instructional interpretation',
      'Do not judge a move by how active or natural it looks',
      'earliest meaningful decision that changed the evaluation trend',
      'Strengths matter as much as mistakes',
      '4–7 chapters',
    ])
      expect(BETA_COACH_SYSTEM_PROMPT).toContain(phrase);
    let system = '';
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      system = JSON.parse(String(init.body)).systemInstruction.parts[0].text;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
    }) as unknown as typeof fetch;
    try {
      await coachComplete({ env: { GEMINI_API_KEY: 'k' }, hosted: false }, null, { prompt: 'facts', task: 'beta', maxTokens: 16000 });
    } finally {
      globalThis.fetch = real;
    }
    expect(system).toBe(BETA_COACH_SYSTEM_PROMPT);
  });
});
