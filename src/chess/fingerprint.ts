// One duplicate check for every way a game gets in (pasted PGN or Chess.com sync):
// the site's own game id when we have it, otherwise the moves themselves.
import type { GameHeaders, PlyRecord, StoredGame } from '../domain/types';

/** "https://www.chess.com/game/live/123456" → "chesscom:live:123456". */
export function sourceKeyFromUrl(url: string | undefined): string | undefined {
  const m = url && /chess\.com\/(?:analysis\/)?game\/(live|daily)\/(\d+)/i.exec(url);
  return m ? `chesscom:${m[1].toLowerCase()}:${m[2]}` : undefined;
}

export function sourceKeyOf(g: { headers: Pick<GameHeaders, 'link' | 'site'>; source?: StoredGame['source'] }): string | undefined {
  return g.source?.id ?? sourceKeyFromUrl(g.headers.link) ?? sourceKeyFromUrl(g.headers.site);
}

const movesKey = (plies: Pick<PlyRecord, 'san'>[]) => plies.map((p) => p.san).join(' ');

/**
 * The existing game this one duplicates, if any. Same site id → duplicate.
 * Otherwise identical move lists count, but very short games (which can repeat
 * by chance) also need the same date when both have one.
 */
export function findDuplicate(
  existing: StoredGame[],
  candidate: { headers: GameHeaders; plies: Pick<PlyRecord, 'san'>[]; source?: StoredGame['source'] },
): StoredGame | undefined {
  const key = sourceKeyOf(candidate);
  if (key) {
    const byKey = existing.find((g) => sourceKeyOf(g) === key);
    if (byKey) return byKey;
  }
  const moves = movesKey(candidate.plies);
  return existing.find((g) => {
    if (g.plies.length !== candidate.plies.length || movesKey(g.plies) !== moves) return false;
    // Two different site ids can't be the same game.
    const other = sourceKeyOf(g);
    if (key && other && key !== other) return false;
    if (candidate.plies.length >= 16) return true;
    const a = candidate.headers.date;
    const b = g.headers.date;
    return !a || !b || a === b;
  });
}
