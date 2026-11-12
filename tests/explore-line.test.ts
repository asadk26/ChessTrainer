import { describe, expect, it } from 'vitest';
import { lineLabels, moveLabelAt, playInLine, sanOf, type ExploreMove } from '../src/ui/components/exploreLine';

const mv = (uci: string, san = uci): ExploreMove => ({ uci, san, fen: `fen-${uci}`, from: uci.slice(0, 2), to: uci.slice(2, 4) });

describe('Explore line', () => {
  it('numbers moves from the starting position, "..." for a black first move', () => {
    const black25 = 'r4rk1/pp3ppp/8/8/8/8/PP3PPP/R4RK1 b - - 0 25';
    expect(lineLabels(black25, [{ san: 'Qa5' }, { san: 'Qh4' }, { san: 'Qxa3' }])).toEqual(['25...Qa5', '26.Qh4', 'Qxa3']);
    const white26 = 'r4rk1/pp3ppp/8/8/8/8/PP3PPP/R4RK1 w - - 0 26';
    expect(lineLabels(white26, [{ san: 'Qh4' }, { san: 'Qxa3' }])).toEqual(['26.Qh4', 'Qxa3']);
    expect(moveLabelAt(black25, 'Qa5')).toBe('25...Qa5');
  });

  it('a different move part-way replaces the rest; the same move keeps it (redo)', () => {
    const line = [mv('e2e4'), mv('e7e5'), mv('g1f3')];
    expect(playInLine(line, 1, mv('e7e5'))).toEqual({ line, cursor: 2 });
    const r = playInLine(line, 1, mv('c7c5'));
    expect(r.line.map((m) => m.uci)).toEqual(['e2e4', 'c7c5']);
    expect(r.cursor).toBe(2);
    expect(playInLine(line, 3, mv('b8c6')).line).toHaveLength(4);
  });

  it('SAN from UCI, empty when illegal', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(sanOf(start, 'g1f3')).toBe('Nf3');
    expect(sanOf(start, 'e2e5')).toBe('');
  });
});
