// Move-quality bands, line comparison and the deeper pass for critical moments.
import { describe, expect, it } from 'vitest';
import { compareLines } from '../src/analysis/compareLines';
import { equalAlternatives, gapBetween, qualityOf, qualityOfGap, rankCandidates } from '../src/analysis/moveQuality';
import { deepenCritical, DEEP_DEPTH } from '../src/analysis/pipeline';
import { scoreToCp } from '../src/analysis/evaluation';
import type { PositionEval } from '../src/domain/types';
import type { Engine } from '../src/engine/types';
import { fixtureGame } from './helpers';

const line = (uci: string, cp: number) => ({ multipv: 1, depth: 12, score: { type: 'cp' as const, value: cp }, pv: [uci] });
const pos = (...ls: [string, number][]): PositionEval => ({ fen: 'x', depth: 12, lines: ls.map(([u, cp]) => line(u, cp)) });

/** Compare the game move at `ply` with Stockfish's choice, from a fixture's stored analysis. */
function compareAt(name: Parameters<typeof fixtureGame>[0], ply: number) {
  const { game, positions } = fixtureGame(name);
  const p = game.plies[ply - 1];
  const before = positions[ply - 1];
  const after = positions[ply];
  return compareLines({
    fen: p.fenBefore,
    mover: p.color,
    preferred: { ucis: before.lines[0].pv, cp: scoreToCp(before.lines[0].score) },
    other: { ucis: [p.uci, ...after.lines[0].pv], cp: -scoreToCp(after.lines[0].score) },
  })!;
}

describe('move quality bands', () => {
  it('treats moves within the band as equally good, not wrong', () => {
    expect(qualityOfGap(0, true)).toBe('best');
    expect(qualityOfGap(1.5)).toBe('equal');
    expect(qualityOfGap(4)).toBe('good');
    expect(qualityOfGap(9)).toBe('inaccuracy');
    expect(qualityOfGap(15)).toBe('mistake');
    expect(qualityOfGap(30)).toBe('blunder');
    const p = pos(['f5g6', 40], ['c8d7', 32], ['e8g8', 28], ['h7h6', -60]);
    expect(rankCandidates(p).map((r) => r.quality)).toEqual(['best', 'equal', 'equal', 'inaccuracy']);
    expect(equalAlternatives(p)).toEqual(['c8d7', 'e8g8']);
    expect(qualityOf(p, 'e8g8')).toBe('equal');
    expect(qualityOf(p, 'a7a6', -200)).toBe('mistake');
    expect(qualityOf(p, 'a7a6', -500)).toBe('blunder');
  });

  it('measures centipawn loss when far ahead, where win% flattens', () => {
    expect(gapBetween(900, 500)).toBeGreaterThanOrEqual(20);
    expect(gapBetween(30, 10)).toBeLessThan(2.5);
  });
});

describe('comparing where two lines lead', () => {
  it('names the concrete material difference: the queen for a knight (11...Qd7)', () => {
    const c = compareAt('queen-blunder-game', 22);
    expect(c.clear).toBe(true);
    expect(c.summary).toBe("After Nd7 the position stays balanced; after Qd7 you're losing: after Qd7 White wins your queen for a knight.");
    expect(c.points.other).toMatchObject({ kind: 'material', text: 'White wins your queen for a knight' });
    expect(c.card.other.map((r) => r.text)).toEqual(['Losing', 'White wins your queen for a knight']);
    expect(c.otherFrames.map((f) => f.san)).toEqual(['Qd7', 'Nxd7', 'Nxd7']); // stops once the exchange is over
  });

  it('describes a mate as a mate, not a positional plus (41.Rxh6 vs Qg3#)', () => {
    const c = compareAt('chaotic-game', 81);
    expect(c.summary).toMatch(/^Qg3# is checkmate on the spot; after Rxh6 the game goes on\./);
    expect(c.preferredFrames.map((f) => f.san)).toEqual(['Qg3#']);
  });

  it('uses the shortest stretch that shows the difference', () => {
    const c = compareAt('black-win-game', 30); // 15...Bxf2+
    expect(c.otherFrames.map((f) => f.san)).toEqual(['Bxf2+', 'Kxf2']);
    expect(c.summary).toMatch(/after Bxf2\+ White wins your bishop for a pawn/);
  });

  it("doesn't call a sacrifice in Stockfish's line a material loss (7.Bg5)", () => {
    const c = compareAt('kingside-storm-game', 13);
    expect(c.summary).not.toMatch(/better off|give up/);
  });

  it("says so honestly when nothing concrete explains the difference", () => {
    const c = compareAt('queen-blunder-game', 14); // 7...Ba5
    expect(c.clear).toBe(false);
    expect(c.summary).toMatch(/isn't visible in simple features/);
  });
});

describe('deeper analysis of critical moments', () => {
  it('re-analyses only the positions around teaching moments, at depth 18, then re-coaches', async () => {
    const { game, positions } = fixtureGame('queen-blunder-game');
    const asked: { fen: string; depth: number; multiPv: number }[] = [];
    const engine: Engine = {
      name: 'stub',
      analyse: async (fen, o) => {
        asked.push({ fen, ...o });
        const original = positions.find((p) => p.fen === fen)!;
        return { ...original, depth: o.depth };
      },
      dispose: () => undefined,
    };
    const { game: out } = await deepenCritical(game, positions, engine, []);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThanOrEqual(8);
    expect(asked.every((a) => a.depth === DEEP_DEPTH && a.multiPv === 3)).toBe(true);
    expect(out.analysis!.deepPositions).toEqual(expect.arrayContaining([21, 22])); // around 11...Qd7
    expect(out.moments.some((m) => m.ply === 22)).toBe(true);
  });
});

describe('equally good moves are described as equally good', () => {
  it("doesn't invent a difference inside the equal band", () => {
    const { game } = fixtureGame('queen-blunder-game');
    const p = game.plies[21]; // before 11...Qd7: compare Qe7 with h6 at the same evaluation
    const c = compareLines({ fen: p.fenBefore, mover: 'b', preferred: { ucis: ['d8e7'], cp: -40 }, other: { ucis: ['h7h6'], cp: -55 } })!;
    expect(c.summary).toMatch(/^h6 is as good as Qe7 — both keep the position balanced\. Pick the one whose plan you understand\.$/);
  });
});

describe('lines stop where they make their point', () => {
  it("18...Bc2 vs d4: Stockfish's line stops when the passed pawn appears", async () => {
    const { lineToPoint } = await import('../src/analysis/linePoint');
    const { game, positions } = fixtureGame('queen-hunt-game');
    const p = game.plies[35];
    const pt = lineToPoint(p.fenBefore, positions[35].lines[0].pv, 'b');
    expect(pt.kind).toBe('passed');
    expect(pt.text).toBe('you get a dangerous passed pawn on d3');
    expect(pt.frames.map((f) => f.san)).toEqual(['d4', 'cxd4', 'cxd4', 'Kf2', 'd3']);
  });

  it("doesn't stop in the middle of an exchange, and calls a quiet line quiet", async () => {
    const { lineToPoint } = await import('../src/analysis/linePoint');
    const { game, positions } = fixtureGame('queen-blunder-game');
    const p = game.plies[21];
    expect(lineToPoint(p.fenBefore, [p.uci, ...positions[22].lines[0].pv], 'b').frames.map((f) => f.san)).toEqual(['Qd7', 'Nxd7', 'Nxd7']);
    const quiet = lineToPoint(p.fenBefore, positions[21].lines[0].pv, 'b');
    expect(quiet.kind).toBe('quiet');
  });
});
