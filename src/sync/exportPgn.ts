// Export games as one PGN file: your most recent games straight from Chess.com (no need to
// import or analyse them first), or the games already in the app.
import type { StoredGame } from '../domain/types';
import { asGames, get, isStandard, normalizeUsername, SyncError, validUsername, type ChessComFetch, type ChessComGame } from './chesscom';
import { gamePlayedAt } from '../analysis/pipeline';

/** The newest `count` standard games of `username`, newest first, walking monthly archives back as far as needed. */
export async function recentChessComPgns(
  username: string,
  count: number,
  fetcher: ChessComFetch,
  timeClasses?: string[],
): Promise<{ pgns: string[]; games: ChessComGame[] }> {
  const user = normalizeUsername(username);
  if (!validUsername(user)) throw new SyncError('invalid_username', 'Set your Chess.com username first (Chess.com sync, above).');
  const list = (await get(fetcher, `player/${encodeURIComponent(user)}/games/archives`)) as { archives?: string[] };
  const archives = Array.isArray(list?.archives) ? [...list.archives].reverse() : [];
  const found: ChessComGame[] = [];
  for (const url of archives) {
    const path = url.replace(/^https?:\/\/api\.chess\.com\/pub\//, '');
    const games = asGames(await get(fetcher, path)).filter(
      (g) => g.pgn && isStandard(g) && (!timeClasses?.length || timeClasses.includes(g.time_class ?? '')),
    );
    found.push(...games);
    if (found.length >= count) break;
  }
  const games = found.sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0)).slice(0, count);
  return { pgns: games.map((g) => g.pgn!.trim()), games };
}

/** The newest `count` games already in the app, newest first. */
export function storedPgns(games: StoredGame[], count: number): string[] {
  return [...games]
    .sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a))
    .slice(0, count)
    .map((g) => g.pgn.trim());
}

export const joinPgns = (pgns: string[]) => `${pgns.join('\n\n')}\n`;
