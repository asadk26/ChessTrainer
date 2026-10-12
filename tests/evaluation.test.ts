import { describe, expect, it } from 'vitest';
import { dropLevel, evalChange, formatCp, scoreToCp, winPercent } from '../src/analysis/evaluation';
import type { PositionEval } from '../src/domain/types';

const pos = (cp: number | { mate: number }): PositionEval => ({
  fen: 'x',
  depth: 10,
  lines: [{ pv: ['e2e4'], depth: 10, score: typeof cp === 'number' ? { type: 'cp', value: cp } : { type: 'mate', value: cp.mate } }],
});

describe('evaluation-change calculations', () => {
  it('maps centipawns to an expected score', () => {
    expect(winPercent(0)).toBeCloseTo(50);
    expect(winPercent(300)).toBeGreaterThan(74);
    expect(winPercent(-300)).toBeLessThan(26);
    expect(winPercent(5000)).toBeGreaterThan(99);
  });

  it('treats mates as large, distance-ordered scores', () => {
    expect(scoreToCp({ type: 'mate', value: 1 })).toBeGreaterThan(scoreToCp({ type: 'mate', value: 5 }));
    expect(scoreToCp({ type: 'mate', value: -2 })).toBeLessThan(-9000);
    expect(formatCp(scoreToCp({ type: 'mate', value: 3 }))).toBe('M3');
    expect(formatCp(152)).toBe('+1.5');
  });

  it('computes loss from the mover\'s point of view (after = negated opponent eval)', () => {
    // Mover was +1.0; after the move the opponent (to move) is +2.0 => mover -2.0.
    const ch = evalChange(pos(100), pos(200));
    expect(ch.cpBefore).toBe(100);
    expect(ch.cpAfter).toBe(-200);
    expect(ch.winDrop).toBeGreaterThan(25);
    // Improving moves never produce a negative drop.
    expect(evalChange(pos(0), pos(-150)).winDrop).toBe(0);
  });

  it('ignores tiny engine preferences for an ~850 player', () => {
    // +0.7 -> +0.3 is noise at this level.
    const small = evalChange(pos(70), pos(-30));
    expect(dropLevel(small.winDrop)).toBe('none');
    // +3 -> +3.5 when already winning hardly matters either.
    expect(dropLevel(evalChange(pos(350), pos(-300)).winDrop)).toBe('none');
    // Dropping a piece does.
    expect(dropLevel(evalChange(pos(50), pos(250)).winDrop)).toBe('blunder');
  });

  it('scores checkmate positions without the engine', () => {
    const mated: PositionEval = { fen: 'x', depth: 0, lines: [], terminal: 'checkmate' };
    expect(evalChange(pos(800), mated).winAfter).toBeGreaterThan(99);
  });
});
