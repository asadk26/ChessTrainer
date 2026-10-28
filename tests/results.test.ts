import { describe, expect, it } from 'vitest';
import { fixtureGame, storedFromPgn } from './helpers';
import { byColor, byOpening, byTimeOfDay, resultsBy, startedAt } from '../src/analysis/results';
import { patternStats } from '../src/analysis/patternStats';
import { coachFromPositions } from '../src/analysis/pipeline';

const me = 'chunkmonkey420';
const g = (id: string, white: boolean, result: string, moves: string, time?: string) =>
  storedFromPgn(
    `[White "${white ? me : 'x'}"]\n[Black "${white ? 'x' : me}"]\n[Result "${result}"]\n${time ? `[UTCDate "2026.10.27"]\n[UTCTime "${time}"]\n` : ''}\n${moves} ${result}`,
    white ? 'w' : 'b',
    id,
  );
const games = [
  g('1', true, '1-0', '1. e4 c6', '08:30:00'),
  g('2', true, '0-1', '1. e4 c6', '19:10:00'),
  g('3', false, '1/2-1/2', '1. d4 d5 2. c4', '23:40:00'),
  g('4', false, '1-0', '1. e4 c5'),
];

describe('Progress results', () => {
  it('scores by colour, with draws as half a point', () => {
    expect(resultsBy(games, byColor)).toEqual([
      { key: 'b', label: 'Black', w: 0, d: 1, l: 1, n: 2, score: 25 },
      { key: 'w', label: 'White', w: 1, d: 0, l: 1, n: 2, score: 50 },
    ]);
  });
  it('groups by opening family, biggest first', () => {
    expect(resultsBy(games, byOpening).map((r) => [r.label, r.n])).toEqual([
      ['Caro-Kann Defence', 2],
      ["Queen's Gambit", 1],
      ['Sicilian Defence', 1],
    ]);
  });
  it('buckets by time of day from the UTC start time, skipping games without one', () => {
    expect(startedAt(games[3])).toBeUndefined();
    const rows = resultsBy(games, byTimeOfDay((d) => d.getUTCHours()));
    expect(rows.map((r) => r.key).sort()).toEqual(['evening', 'morning', 'night']);
  });
  it('counts tactics that cost you separately from tactics you missed', () => {
    const f = fixtureGame('atayan-game');
    const a = coachFromPositions(f.game, f.positions, []).game;
    const against = patternStats([a], 'refutation');
    expect(against.find((s) => s.tag === 'discovered_attack')?.total).toBeGreaterThan(0);
    expect(patternStats([a], 'better').every((s) => s.tag !== 'discovered_attack' || s.total === 0)).toBe(true);
  });
});
