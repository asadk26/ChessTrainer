// What the Games list shows and filters on, from the stored game alone (no engine needed).
import type { StoredGame } from '../domain/types';
import { userOutcome } from '../chess/outcome';
import { openingName } from '../training/diagnosis';
import { gamePlayedAt } from './pipeline';

const header = (pgn: string, tag: string) => new RegExp(`^\\s*\\[${tag}\\s+"([^"]*)"\\s*\\]`, 'm').exec(pgn)?.[1];
const FAMILY_END = /\b(Defen[cs]e|Opening|Game|Gambit|Attack|System|Variation)\b/;

/**
 * The opening: its family (for filtering, from the first moves — same name for every game of it)
 * and, when the PGN names it (Chess.com's ECOUrl, Lichess's Opening tag), the fuller name.
 */
export function gameOpening(g: Pick<StoredGame, 'pgn' | 'plies'>): { family: string; name: string } {
  const family = openingName(g as StoredGame).name;
  const lichess = header(g.pgn, 'Opening');
  if (lichess) return { family, name: lichess };
  const url = header(g.pgn, 'ECOUrl');
  const slug = url ? decodeURIComponent(url.split('/openings/')[1] ?? '') : '';
  if (!slug) return { family, name: family };
  // "Caro-Kann-Defense-Advance-Variation-3...Bf5" → "Caro-Kann Defense: Advance Variation"
  let words = slug.replace(/-\d+\..*$/, '').replace(/-/g, ' ').trim();
  words = words.replace(/\bCaro Kann\b/, 'Caro-Kann').replace(/\bKings\b/, "King's").replace(/\bQueens\b/, "Queen's").replace(/\bBishops\b/, "Bishop's");
  const m = FAMILY_END.exec(words);
  const name = m && m.index + m[0].length < words.length ? `${words.slice(0, m.index + m[0].length)}: ${words.slice(m.index + m[0].length).trim()}` : words;
  return { family, name: name || family };
}

/** "Oct 27" (with the year when it isn't this year). */
export function shortDate(g: Pick<StoredGame, 'headers' | 'importedAt'>, now = new Date()): string {
  const d = new Date(gamePlayedAt(g));
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(d.getUTCFullYear() !== now.getUTCFullYear() ? { year: 'numeric' } : {}), timeZone: 'UTC' };
  return d.toLocaleDateString('en-US', opts);
}

export const opponentRating = (g: Pick<StoredGame, 'headers' | 'userColor'>) => (g.userColor === 'w' ? g.headers.blackElo : g.headers.whiteElo);

export type GameFilter = 'wins' | 'losses' | 'white' | 'black' | 'unanalyzed';

/**
 * Games newest first, narrowed by the chips: within a group (result, colour) chips widen it,
 * across groups they narrow it. `opening` matches the family.
 */
export function filterGames(games: StoredGame[], on: Set<GameFilter>, opening?: string): StoredGame[] {
  const result = (g: StoredGame) => {
    if (!on.has('wins') && !on.has('losses')) return true;
    const o = userOutcome(g);
    return (on.has('wins') && o === 'win') || (on.has('losses') && o === 'loss');
  };
  const color = (g: StoredGame) => (!on.has('white') && !on.has('black')) || (on.has('white') && g.userColor === 'w') || (on.has('black') && g.userColor === 'b');
  return games
    .filter((g) => result(g) && color(g) && (!on.has('unanalyzed') || g.status !== 'analyzed') && (!opening || gameOpening(g).family === opening))
    .sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a));
}

/** Opening families among the games, most played first. */
export function openingCounts(games: StoredGame[]): { family: string; count: number }[] {
  const m = new Map<string, number>();
  for (const g of games) {
    const f = gameOpening(g).family;
    m.set(f, (m.get(f) ?? 0) + 1);
  }
  return [...m].map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
}
