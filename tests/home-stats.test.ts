import { describe, expect, it } from 'vitest';
import { storedFromPgn } from './helpers';
import { blundersPerGame, gamesThisWeek, ratingTrend, timeClassOf } from '../src/analysis/homeStats';

const me = 'chunkmonkey420';
const g = (id: string, date: string, myElo: number, tc: string, white = true) =>
  storedFromPgn(
    `[White "${white ? me : 'x'}"]\n[Black "${white ? 'x' : me}"]\n[Result "1-0"]\n[Date "${date}"]\n[WhiteElo "${white ? myElo : 1000}"]\n[BlackElo "${white ? 1000 : myElo}"]\n[TimeControl "${tc}"]\n\n1. e4 e5 1-0`,
    white ? 'w' : 'b',
    id,
  );
const now = Date.UTC(2026, 9, 28, 12);

describe('Home stats', () => {
  it('classifies time controls like Chess.com', () => {
    expect(timeClassOf(g('a', '2026.10.01', 900, '900+10'))).toBe('rapid');
    expect(timeClassOf(g('a', '2026.10.01', 900, '180+2'))).toBe('blitz');
    expect(timeClassOf(g('a', '2026.10.01', 900, '60'))).toBe('bullet');
    expect(timeClassOf(g('a', '2026.10.01', 900, '1/86400'))).toBe('daily');
  });
  it('rating trend follows the time control of your latest game, over 30 days', () => {
    const games = [
      g('1', '2026.09.10', 850, '900+10'),
      g('2', '2026.10.05', 880, '900+10', false),
      g('3', '2026.10.20', 700, '180+2'),
      g('4', '2026.10.27', 912, '900+10'),
    ];
    expect(ratingTrend(games, now)).toEqual({ timeClass: 'rapid', current: 912, change: 32, points: [850, 880, 912] });
  });
  it('counts games this week and needs analyzed games for blunders', () => {
    const games = [g('1', '2026.10.27', 900, '900+10'), g('2', '2026.10.25', 900, '900+10'), g('3', '2026.10.10', 900, '900+10')];
    expect(gamesThisWeek(games, now)).toBe(2);
    expect(blundersPerGame(games)).toBeUndefined();
  });
});
