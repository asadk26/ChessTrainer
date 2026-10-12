// The user's mating-attack win as Black, plus a synthetic knight fork for the fork detector.
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { coachFromPositions } from '../src/analysis/pipeline';
import { detectMissedFork } from '../src/analysis/detectors';
import type { MoveEval, PlyRecord } from '../src/domain/types';
import { fixtureGame } from './helpers';

describe('a convincing win with a mating finish', () => {
  const { game: g, positions } = fixtureGame('queen-hunt-game');
  const game = coachFromPositions(g, positions, []).game;
  const r = game.report!;

  it("doesn't headline a king-safety problem that never really cost anything", () => {
    expect(r.headline).toMatch(/^A strong win/);
    expect(game.findings.find((f) => f.category === 'king_safety')?.confidence).toBe('medium');
  });

  it('tells the story of the finish, without calling it a pawn race', () => {
    expect(r.story).toMatch(/You finished it with checkmate: 38\.\.\.Qa1#\./);
    expect(r.story).not.toMatch(/race/);
    expect(r.story).toMatch(/more than a queen \(17 points\)/);
  });

  it('credits the queen-winning tactic', () => {
    expect(r.didWell.some((d) => /23\.\.\.d3 wins the queen on c2/.test(d.text))).toBe(true);
  });

  it("doesn't call Nxc7+ a fork when the queen could take the knight", () => {
    expect(game.findings.some((f) => f.facts.forkSan)).toBe(false);
  });
});

describe('missed knight fork', () => {
  // Black's queen leaves d8 (to g5), so Nxc7+ forks king e8 and rook a8.
  const before = 'r2qk3/2p5/8/1N6/8/8/8/4K3 b - - 0 1';
  const c = new Chess(before);
  const m = c.move('Qg5');
  const ply = (o: Partial<PlyRecord>): PlyRecord => ({ ply: 2, moveNumber: 1, color: 'b', san: m.san, uci: 'd8g5', from: 'd8', to: 'g5', piece: 'q', fenBefore: before, fenAfter: c.fen(), ...o });
  const prev = ply({ ply: 1, color: 'w', san: 'Nb5', uci: 'c3b5', from: 'c3', to: 'b5', piece: 'n', fenBefore: before, fenAfter: before });
  const e = { replyLineUci: ['b5c7', 'e8e7'], replyLineSan: ['Nxc7+', 'Ke7'], bestUci: 'd8d7', bestSan: 'Qd7', isBest: false, practicalDrop: 30, winDrop: 30 } as unknown as MoveEval;

  it('names the fork, the targets and the move that prevented it', () => {
    const [f] = detectMissedFork({ plies: [prev, ply({})], evals: [e, e], positions: [], userColor: 'b', result: '*' }, 1);
    expect(f).toMatchObject({ category: 'missed_threat', confidence: 'high', facts: { forkSan: 'Nxc7+', forkTarget: 'rook', forkSquare: 'a8' } });
    expect(f.evidence).toMatch(/1\.Nb5 brought the knight to b5, aiming at c7\. 1\.\.\.Qg5 allowed Nxc7\+ — a fork of your king and your rook on a8\. Qd7 kept that square covered\./);
  });

  it('ignores it when the better move also allows the same check', () => {
    expect(detectMissedFork({ plies: [prev, ply({})], evals: [e, { ...e, isBest: true }], positions: [], userColor: 'b', result: '*' }, 1)).toEqual([]);
  });
});
