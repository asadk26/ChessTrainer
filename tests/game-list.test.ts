import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storedFromPgn } from './helpers';
import { filterGames, gameOpening, openingCounts, opponentRating, shortDate } from '../src/analysis/gameList';
import type { StoredGame } from '../src/domain/types';

const pgn = (white: string, black: string, result: string, date: string, moves: string, extra = '') =>
  `[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[Date "${date}"]\n[WhiteElo "900"]\n[BlackElo "1010"]\n${extra}\n${moves} ${result}`;
const me = 'chunkmonkey420';
const mk = (id: string, p: string, status: StoredGame['status'] = 'imported') => {
  const color = p.includes(`[White "${me}"]`) ? 'w' : 'b';
  return { ...storedFromPgn(p, color, id), status };
};

const games = [
  mk('a', pgn(me, 'x', '1-0', '2026.10.20', '1. e4 c6 2. d4 d5 3. e5 Bf5', '[ECOUrl "https://www.chess.com/openings/Caro-Kann-Defense-Advance-Variation-3...Bf5"]'), 'analyzed'),
  mk('b', pgn('y', me, '1-0', '2026.10.25', '1. e4 c6 2. Nc3 d5')),
  mk('c', pgn(me, 'z', '0-1', '2026.10.27', '1. c4 e5 2. g3 Nf6')),
  mk('d', pgn('w', me, '0-1', '2026.10.22', '1. d4 Nf6 2. Bf4 d5', '[Opening "London System"]'), 'analyzed'),
];

describe('Games list', () => {
  it('names the opening from the PGN when it can, with a family for filtering', () => {
    expect(gameOpening(games[0])).toEqual({ family: 'Caro-Kann Defence', name: 'Caro-Kann Defense: Advance Variation' });
    expect(gameOpening(games[1])).toEqual({ family: 'Caro-Kann Defence', name: 'Caro-Kann Defence' });
    expect(gameOpening(games[3]).name).toBe('London System');
    expect(openingCounts(games)[0]).toEqual({ family: 'Caro-Kann Defence', count: 2 });
  });
  it('lists newest first; chips widen within a group and narrow across groups', () => {
    const ids = (f: string[], o?: string) => filterGames(games, new Set(f as never[]), o).map((g) => g.id);
    expect(ids([])).toEqual(['c', 'b', 'd', 'a']);
    expect(ids(['wins'])).toEqual(['d', 'a']);
    expect(ids(['wins', 'losses'])).toEqual(['c', 'b', 'd', 'a']);
    expect(ids(['losses', 'black'])).toEqual(['b']);
    expect(ids(['unanalyzed'])).toEqual(['c', 'b']);
    expect(ids([], 'Caro-Kann Defence')).toEqual(['b', 'a']);
  });
  it("shows the opponent's rating and a short date", () => {
    expect(opponentRating(games[0])).toBe(1010);
    expect(opponentRating(games[1])).toBe(900);
    expect(shortDate(games[2], new Date(Date.UTC(2026, 9, 28)))).toBe('Oct 27');
    expect(shortDate(games[2], new Date(Date.UTC(2027, 0, 2)))).toBe('Oct 27, 2026');
  });
  it('falls back to the move-based name when a pasted PGN has no opening header', () => {
    const g = storedFromPgn(readFileSync(join(__dirname, 'fixtures', 'atayan-game.pgn'), 'utf8'), 'w');
    expect(gameOpening(g)).toEqual({ family: 'English Opening', name: 'English Opening' });
  });
});
