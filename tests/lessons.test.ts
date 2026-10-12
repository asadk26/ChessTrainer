// The lesson engine: which moments become interactive lessons, which question they ask,
// evaluation bands, and lines that stop where they make their point.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { MAX_LESSONS, questionFor } from '../src/analysis/moments';
import { bandChange, bandOf } from '../src/analysis/evalBand';
import { lineToPoint } from '../src/analysis/linePoint';
import { fixtureGame } from './helpers';

const coached = (name: Parameters<typeof fixtureGame>[0]) => {
  const { game, positions } = fixtureGame(name);
  return coachFromPositions(game, positions, []).game;
};

describe('which moments become lessons', () => {
  it('makes at most two interactive lessons per game, the rest short notes', () => {
    for (const n of ['winning-game', 'kingside-storm-game', 'chaotic-game', 'queen-blunder-game'] as const) {
      const g = coached(n);
      expect(g.moments.filter((m) => m.tier === 'lesson').length).toBeLessThanOrEqual(MAX_LESSONS);
      expect(g.moments.every((m) => m.tier === 'lesson' || m.tier === 'note')).toBe(true);
    }
  });

  it('puts refutations first: 11...Qd7 is a "predict the reply" lesson (Nxd7)', () => {
    const qd7 = coached('queen-blunder-game').moments.find((m) => m.ply === 22)!;
    expect(qd7).toMatchObject({ tier: 'lesson', priority: 1, question: 'predict_reply', refutationSan: 'Nxd7' });
  });

  it('ranks giving material back as a refutation, and keeps lower-value moments as notes', () => {
    const g = coached('winning-game');
    expect(g.moments.find((m) => m.ply === 43)).toMatchObject({ tier: 'lesson', priority: 1 }); // 22.Bd4
    expect(g.moments.filter((m) => m.tier === 'note').every((m) => (m.priority ?? 9) >= 1)).toBe(true);
  });

  it('only asks to predict a reply when the reply is a real choice', () => {
    expect(questionFor(1, 'Nxd7', 'Qd7')).toBe('predict_reply');
    expect(questionFor(1, 'Kh7', 'Nc7+')).toBe('find'); // after a check, the reply is forced
    expect(questionFor(2, 'Qf3+', 'Rxh6')).toBe('find');
    expect(questionFor(3, 'g3', 'Ne6')).toBe('find'); // quiet reply to a big swing: find the move
    expect(questionFor(3, 'Nxf4', 'Bxf4')).toBe('predict_reply');
    expect(questionFor(6, 'b4', 'Ba5')).toBe('cleaner');
  });
});

describe('evaluation in words', () => {
  it('uses coarse bands and describes the swing', () => {
    expect(bandOf(0)).toBe('equal');
    expect(bandOf(250)).toBe('clearly_better');
    expect(bandOf(-900)).toBe('losing');
    expect(bandChange(300, 20).text).toBe('this gave back most of your advantage');
    expect(bandChange(30, -900).text).toBe('this turned the game into a losing position');
    expect(bandChange(120, 110).text).toBe('the balance barely changed');
  });
});

describe('line stopping points', () => {
  it("doesn't call it a material win when the line just ends mid-exchange", () => {
    // 1.e4 d5 2.exd5: the line ends with a capture Black can answer.
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    expect(lineToPoint(fen, ['e4d5'], 'w').kind).toBe('quiet');
    expect(lineToPoint(fen, ['e4d5', 'd8d5'], 'w').kind).toBe('quiet'); // pawn for pawn
  });
});
