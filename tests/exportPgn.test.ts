import { describe, expect, it } from 'vitest';
import { joinPgns, recentChessComPgns } from '../src/sync/exportPgn';
import type { ChessComFetch } from '../src/sync/chesscom';

const game = (t: number, extra: Record<string, unknown> = {}) => ({ pgn: `[Event "g${t}"]\n\n1. e4 *\n`, url: `https://www.chess.com/game/live/${t}`, white: { username: 'tester' }, black: { username: 'opp' }, end_time: t, rules: 'chess', time_class: 'rapid', initial_setup: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ...extra });
const months: Record<string, unknown> = {
  'player/tester/games/archives': { archives: ['https://api.chess.com/pub/player/tester/games/2026/08', 'https://api.chess.com/pub/player/tester/games/2026/09', 'https://api.chess.com/pub/player/tester/games/2026/10'] },
  'player/tester/games/2026/10': { games: [game(30), game(31, { time_class: 'blitz' }), game(32, { rules: 'chess960' }), game(33, { initial_setup: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' })] },
  'player/tester/games/2026/09': { games: [game(20), game(22), game(21)] },
  'player/tester/games/2026/08': { games: [game(10)] },
};

function fetcher(): ChessComFetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (path: string) => {
    calls.push(path);
    return path in months ? { status: 200, json: months[path] } : { status: 404 };
  }) as ChessComFetch & { calls: string[] };
  f.calls = calls;
  return f;
}

describe('recentChessComPgns', () => {
  it('returns the newest standard games across months, stopping once it has enough', async () => {
    const f = fetcher();
    const { games } = await recentChessComPgns('Tester', 3, f);
    expect(games.map((g) => g.end_time)).toEqual([31, 30, 22]);
    expect(f.calls).not.toContain('player/tester/games/2026/08');
  });

  it('filters by time class', async () => {
    const { games } = await recentChessComPgns('tester', 10, fetcher(), ['rapid']);
    expect(games.map((g) => g.end_time)).toEqual([30, 22, 21, 20, 10]);
  });

  it('joins into one file', async () => {
    const { pgns } = await recentChessComPgns('tester', 2, fetcher());
    const text = joinPgns(pgns);
    expect(text.match(/\[Event/g)).toHaveLength(2);
    expect(text.endsWith('*\n')).toBe(true);
  });
});
