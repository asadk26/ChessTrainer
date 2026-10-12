import { describe, expect, it } from 'vitest';
import { aggregateProfile, describeFrequency } from '../src/profile/profile';
import type { Finding } from '../src/domain/types';

const f = (category: Finding['category'], severity: 1 | 2 | 3 = 2, kind: Finding['kind'] = 'weakness'): Finding => ({
  kind,
  category,
  ply: 10,
  severity,
  evidence: `${category} example`,
  facts: {},
});
const game = (id: string, day: number, findings: Finding[]) => ({ gameId: id, playedAt: Date.UTC(2026, 0, day), findings });

describe('recurring-pattern aggregation', () => {
  it('counts occurrences and games, and never calls one example established', () => {
    const p = aggregateProfile([game('a', 1, [f('inefficient_moves'), f('inefficient_moves')])]);
    const c = p.categories.find((x) => x.category === 'inefficient_moves')!;
    expect(c.occurrences).toBe(2);
    expect(c.gamesWithCategory).toBe(1);
    expect(c.confidence).toBe('possible');
    expect(describeFrequency(c)).toMatch(/Possible tendency/);
  });

  it('describes frequency over the recent window', () => {
    const p = aggregateProfile([
      game('a', 1, [f('missed_threat')]),
      game('b', 2, []),
      game('c', 3, [f('missed_threat')]),
      game('d', 4, []),
      game('e', 5, [f('missed_threat')]),
    ]);
    const c = p.categories.find((x) => x.category === 'missed_threat')!;
    expect(c.recentGames).toBe(3);
    expect(c.recentWindow).toBe(5);
    expect(c.confidence).toBe('established');
    expect(describeFrequency(c)).toBe('Has now appeared in 3 of your last 5 games');
    expect(c.lastOccurrence?.gameId).toBe('e');
  });

  it('detects improving and worsening trends', () => {
    const improving = aggregateProfile([
      game('a', 1, [f('blunder')]),
      game('b', 2, [f('blunder')]),
      game('c', 3, [f('blunder')]),
      game('d', 4, []),
      game('e', 5, []),
      game('f', 6, []),
    ]);
    expect(improving.categories.find((c) => c.category === 'blunder')!.trend).toBe('improving');
    expect(improving.improving.map((c) => c.category)).toContain('blunder');

    const worsening = aggregateProfile([
      game('a', 1, []),
      game('b', 2, []),
      game('c', 3, [f('early_queen')]),
      game('d', 4, [f('early_queen')]),
      game('e', 5, [f('early_queen')]),
      game('f', 6, [f('early_queen')]),
    ]);
    expect(worsening.categories.find((c) => c.category === 'early_queen')!.trend).toBe('worsening');
  });

  it('ignores soft (severity 1) observations for pattern counts and tracks strengths', () => {
    const p = aggregateProfile([game('a', 1, [f('central_tension', 1), f('castled_early', 2, 'strength')])]);
    expect(p.categories.find((c) => c.category === 'central_tension')).toBeUndefined();
    expect(p.strengths[0]).toMatchObject({ id: 'castled_early', recentGames: 1 });
  });
});
