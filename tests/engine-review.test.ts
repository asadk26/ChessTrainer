import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { engineNotes, gameStats, moveAccuracy, trend, verdictOf } from '../src/analysis/engineReview';
import type { MoveEval } from '../src/domain/types';
import { fixtureGame } from './helpers';

const coached = (name: Parameters<typeof fixtureGame>[0]) => {
  const { game, positions } = fixtureGame(name);
  return coachFromPositions(game, positions, []).game;
};

describe('engine review', () => {
  it('uses the same thresholds as the coach for verdicts', () => {
    const e = (practicalDrop: number, isBest = false) => ({ practicalDrop, winDrop: practicalDrop, isBest }) as MoveEval;
    expect([verdictOf(e(0, true)), verdictOf(e(3)), verdictOf(e(8)), verdictOf(e(15)), verdictOf(e(40))]).toEqual(['best', 'good', 'inaccuracy', 'mistake', 'blunder']);
    expect(moveAccuracy(0)).toBeCloseTo(100, 0);
    expect(moveAccuracy(50)).toBeLessThan(15);
  });

  it('says when your move worked only because the opponent took the bait (18...Bc2)', () => {
    const notes = engineNotes(coached('queen-hunt-game'));
    const trap = notes.find((n) => n.kind === 'trap')!;
    expect(trap.ply).toBe(36);
    expect(trap.text).toMatch(/18\.\.\.Bc2 set a trap and White fell for it: 19\.Qxc2\? Qxe3\+\. It worked — but Stockfish preferred d4 \(\+2\.9 instead of \+1\.2 for you\), and Kf2 would have held for White\./);
    // The opponent's blunder is part of the trap story, not repeated on its own.
    expect(notes.some((n) => n.kind === 'opponent_missed' && n.ply === 37)).toBe(false);
    expect(notes.find((n) => n.ply === 23)?.text).toMatch(/12\.c3 was a mistake by White: Nxc7\+ was better/);
  });

  it("lists your mistakes the coach couldn't explain, instead of staying silent", () => {
    const notes = engineNotes(coached('chaotic-game'));
    const mine = notes.filter((n) => n.kind === 'uncovered');
    expect(mine.map((n) => n.ply)).toContain(37); // 19.Qh4
    expect(mine.find((n) => n.ply === 37)!.text).toMatch(/19\.Qh4 — mistake\. Stockfish preferred Qd6 \(-0\.6 instead of -2\.5 for you/);
    expect(mine.length).toBeLessThanOrEqual(4);
  });

  it('gives accuracy for both sides, with caveats for short games', () => {
    const hunt = gameStats(coached('queen-hunt-game'))!;
    expect(hunt.you.accuracy).toBeGreaterThan(hunt.opponent.accuracy);
    expect(hunt.caveat).toBeUndefined();
    expect(gameStats(coached('queen-blunder-game'))!.caveat).toMatch(/Short game/);
  });

  it('compares recent games with earlier ones only once there are enough', () => {
    const s = (at: number, accuracy: number, blunder: number) => ({ at, s: { you: { accuracy, blunder, moves: 30, inaccuracy: 0, mistake: 0 }, opponent: { accuracy: 0, blunder: 0, moves: 30, inaccuracy: 0, mistake: 0 } } });
    expect(trend([1, 2, 3, 4, 5].map((i) => s(i, 70, 1)))).toBeUndefined();
    expect(trend([s(1, 60, 3), s(2, 62, 2), s(3, 64, 2), s(4, 75, 1), s(5, 77, 0), s(6, 79, 1)])).toMatchObject({ n: 3, earlier: 62, recent: 77, earlierBlunders: 2.3, recentBlunders: 0.7 });
  });
});
