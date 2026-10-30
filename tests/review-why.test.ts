import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { MoveEval, PositionEval } from '../src/domain/types';
import { classifyMove } from '../src/analysis/moveQuality';
import { hangingPieces, moveBoardFacts, pinsBy } from '../src/analysis/boardFacts';
import { buildMomentContext, evalText, namesConcreteReason, parseMomentExplanation, smallDifferenceExplanation } from '../src/coach/momentContext';
import { MOMENT_SYSTEM_PROMPT } from '../src/coach/systemPrompt';
import { coachFromPositions } from '../src/analysis/pipeline';
import { fixtureGame } from './helpers';

const fen = (moves: string[]) => {
  const c = new Chess();
  moves.forEach((m) => c.move(m));
  return c.fen();
};

const ev = (o: Partial<MoveEval>): MoveEval =>
  ({ ply: 1, color: 'w', san: 'x', uci: 'a2a3', cpBefore: 50, cpAfter: 50, winBefore: 55, winAfter: 55, winDrop: 0, practicalDrop: 0, isBest: true, bestLineSan: [], replyLineSan: [], replyLineUci: [], materialBefore: 0, materialAfterReply: 0, materialAfterBest: 0, mateThreatAgainst: false, ...o }) as MoveEval;
const pos = (...cps: number[]): PositionEval => ({ fen: '', depth: 12, lines: cps.map((cp, i) => ({ pv: [`a${i + 2}a${i + 3}`], score: { type: 'cp', value: cp }, depth: 12 })) });

describe('move badges', () => {
  it('uses the normal quality bands', () => {
    expect(classifyMove(ev({ isBest: false, cpAfter: -300, winDrop: 30, practicalDrop: 30 }))).toBe('blunder');
    expect(classifyMove(ev({ isBest: false, winDrop: 1, practicalDrop: 1 }))).toBe('equal');
    expect(classifyMove(ev({}), pos(50, 30))).toBe('best');
  });
  it('"Equally good" is the same rule the lessons use: within 0.3, or inside the equal band', () => {
    // 25cp worse in a sharp position (3.5 win%): still as good as best, so never "Inaccuracy".
    expect(classifyMove(ev({ isBest: false, cpBefore: 20, cpAfter: -5, winDrop: 3.5, practicalDrop: 3.5 }))).toBe('equal');
    // A missed mate is never "Equally good", however small the win% gap.
    expect(classifyMove(ev({ isBest: false, cpBefore: 9980, cpAfter: 900, winDrop: 1, practicalDrop: 1 }))).toBe('good');
  });
  it('Great: the only move — every alternative was clearly worse', () => {
    expect(classifyMove(ev({}), pos(40, -250))).toBe('great');
    // …but not once the game is already decided.
    expect(classifyMove(ev({ winBefore: 97, winAfter: 97 }), pos(900, 400))).toBe('best');
  });
  it('Brilliant: a sound sacrifice (two pawns or more given up, position kept)', () => {
    expect(classifyMove(ev({ materialBefore: 0, materialAfterReply: -3, winAfter: 62 }), pos(80, 60))).toBe('brilliant');
    expect(classifyMove(ev({ materialBefore: 0, materialAfterReply: -3, winAfter: 40 }), pos(80, 60))).toBe('best'); // not sound
    expect(classifyMove(ev({ materialBefore: 5, materialAfterReply: 2, winBefore: 95, winAfter: 95 }), pos(900, 880))).toBe('best'); // already won
  });
});

describe('board facts for "Why?"', () => {
  it('finds real pins and ignores fake ones', () => {
    // After 1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5: the d6 pawn can't take back without losing the queen.
    expect(pinsBy(fen(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5']), 'w')).toContain('the queen on d1 pins the pawn on d6 to the queen on d8');
    expect(pinsBy(fen(['e4', 'e5', 'Nf3', 'd6', 'Bb5+']), 'w')).toEqual([]); // check, not a pin
    expect(pinsBy(fen(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'd6']), 'w')).toContain('the bishop on b5 pins the knight on c6 to the king');
    // The "pinned" pawn could just take the bishop: not a pin.
    expect(pinsBy(fen(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6']), 'w')).toEqual([]);
  });
  it('reports hanging pieces, but not the capturing piece in an even trade', () => {
    const f = fen(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    expect(moveBoardFacts(f, 'b5c6')!.leavesHanging).toEqual([]);
    expect(hangingPieces(fen(['e4', 'e5', 'Qh5', 'Nf6']), 'w').map((h) => h.square)).toEqual(['h5', 'e4']); // both attacked by the knight, neither defended
    expect(moveBoardFacts(fen(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4']), 'h2h3')!.does).toContain('h3 attacks the loose bishop on g4');
  });
});

describe('"Why?" explanations', () => {
  const { game: g, positions } = fixtureGame('queen-blunder-game');
  const game = coachFromPositions(g, positions, []).game;
  const ctx = buildMomentContext(game, 22, { rating: 900, prior: [] })!; // 11...Qd7, a blunder

  it('gives the model numbers before/after both moves, four moves of each line and board facts', () => {
    const f = ctx.facts as Record<string, any>;
    expect(f.engineFacts.afterPlayedMove.move).toBe('Qd7');
    expect(f.engineFacts.afterPlayedMove.first4Moves).toHaveLength(4);
    expect(f.engineFacts.afterBestMove.first4Moves[0]).toBe(f.stockfishCandidates[0].move);
    expect(f.engineFacts.evaluationBefore).toMatch(/^[+-]?\d|^-?M\d/);
    expect(f.engineFacts.smallDifference).toBe(false);
    expect(Array.isArray(f.boardFacts.bestMove)).toBe(true);
    expect(MOMENT_SYSTEM_PROMPT).toContain('MUST name at least one concrete reason');
  });

  it('leads with a concrete board reason when the AI only waves its hands', () => {
    const vague = parseMomentExplanation(JSON.stringify({ whyBetter: 'It is simply more useful.', takeaway: 'Be careful.' }), ctx, 22);
    if (ctx.fallbackReason) expect(vague.whyBetter.startsWith(ctx.fallbackReason)).toBe(true);
    // SAN keeps its case: a pawn move stays "f4", a piece move stays "Nf3".
    expect(ctx.fallbackReason ?? '').not.toMatch(/^[A-H]\d|^[nbrqk][a-h]/);
    const concrete = parseMomentExplanation(JSON.stringify({ whyBetter: 'Qe7 keeps the queen safe from the knight on c5.', takeaway: 'x' }), ctx, 22);
    expect(concrete.whyBetter).toBe('Qe7 keeps the queen safe from the knight on c5.');
    expect(namesConcreteReason('it attacks the bishop on c5')).toBe(true);
    expect(namesConcreteReason('O-O gets the king safe')).toBe(true);
    expect(namesConcreteReason('it is just better')).toBe(false);
  });

  it('says a small difference plainly, in one line, without the AI', () => {
    const small = { ...ctx, smallDifference: true, summary: { playedSan: 'O-O', bestSan: 'h3', evalPlayed: '+0.4', evalBest: '+0.7' }, fallbackReason: 'h3 attacks the loose bishop on g4.' };
    const e = smallDifferenceExplanation(small, 7);
    expect(e.whyBetter).toBe('Small difference — O-O is fine. Stockfish slightly prefers h3 (+0.7 instead of +0.4): h3 attacks the loose bishop on g4.');
    expect(e).toMatchObject({ confidence: 'small_difference', model: 'none', missed: '', difference: '' });
  });

  it('formats evaluations like the eval bar', () => {
    expect(evalText(60)).toBe('+0.6');
    expect(evalText(-120)).toBe('-1.2');
    expect(evalText(10000 - 30)).toBe('M3');
    expect(evalText(-(10000 - 20))).toBe('-M2');
  });
});

import { EVALUATE_PROMPT, evaluationFeedback, gradeEvaluation } from '../src/coach/walkthrough';
import { materialSummary } from '../src/analysis/linePoint';
import { GUIDED_REVIEW_SYSTEM_PROMPT } from '../src/coach/systemPrompt';

describe('"Who is better?" questions in the AI guided review', () => {
  // The reported position: before 22.Qc3, after Black's 21...f6 (Stockfish: White −0.8, it was −2.7).
  const fen = 'rr4k1/p1bn2p1/2Qq1p1p/3Pn3/5B2/P5PP/1P3PB1/R3R1K1 w - - 0 22';
  it('grades from Stockfish for the student: still worse after the opponent’s mistake', () => {
    expect(gradeEvaluation(-82, 'worse')).toBe('correct');
    expect(gradeEvaluation(-82, 'better')).toBe('misses');
    expect(gradeEvaluation(-82, 'equal')).toBe('reasonable');
  });
  it('explains it from Stockfish: number, what the last move changed, and material', () => {
    expect(materialSummary(fen, 'w')).toBe("you're down a knight for 2 pawns");
    const t = evaluationFeedback({ cp: -82, prevCp: -268, lastMove: { label: '21...f6', byOpponent: true }, material: materialSummary(fen, 'w'), opponent: 'Black' });
    expect(t).toBe("Stockfish: -0.8 — slightly worse for you. Black's 21...f6 helped you (it was -2.7 before), but you are still worse. Material: you're down a knight for 2 pawns.");
  });
  it('asks in neutral words and tells the AI never to hint at the answer', () => {
    expect(EVALUATE_PROMPT('White')).not.toMatch(/improv|better|worse|pressure/i);
    expect(GUIDED_REVIEW_SYSTEM_PROMPT).toContain('NEVER give the answer away');
  });
});
