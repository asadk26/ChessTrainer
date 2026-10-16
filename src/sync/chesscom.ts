// Chess.com game syncing via the public Published-Data API (no login needed):
//   GET /pub/player/{username}/games/archives  → { archives: [".../games/2026/10", ...] }
//   GET /pub/player/{username}/games/{YYYY}/{MM} → { games: [{ url, pgn, time_class, rules, end_time, white, black }] }
// Requests are serial (Chess.com allows unlimited serial access but may answer
// parallel bursts with 429), finished months are never fetched twice for the
// same filters, and a sync within a minute of the last one makes no requests.
import type { ChessComTimeClass, Color, ParsedGame, StoredGame } from '../domain/types';
import { parsePgn } from '../chess/pgn';
import { findDuplicate, sourceKeyFromUrl } from '../chess/fingerprint';

export interface ChessComPlayer {
  username: string;
  rating?: number;
  result?: string;
}

export interface ChessComGame {
  url: string;
  pgn?: string;
  time_class?: string;
  rules?: string;
  end_time?: number;
  rated?: boolean;
  initial_setup?: string;
  white: ChessComPlayer;
  black: ChessComPlayer;
}

/** What a fetch through the proxy (or directly) returns: an HTTP status and parsed JSON, if any. */
export type ChessComFetch = (path: string) => Promise<{ status: number; json?: unknown; retryAfter?: number }>;

export type SyncErrorKind = 'invalid_username' | 'not_found' | 'rate_limited' | 'network' | 'bad_response';

export class SyncError extends Error {
  constructor(
    public kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Remembered between syncs so finished months aren't fetched again. */
export interface SyncState {
  username: string;
  lastSyncAt?: number;
  /** `${archiveUrl}|${filters}` for months that were complete when processed. */
  completed: string[];
}

export interface SyncOptions {
  username: string;
  days: number;
  timeClasses: ChessComTimeClass[];
  now: number;
  /** At most this many new games per sync (Rapid first, then newest). */
  maxGames: number;
}

export interface SyncCandidate {
  parsed: ParsedGame;
  color: Color;
  source: NonNullable<StoredGame['source']>;
  endTime: number;
}

export interface SyncPlan {
  /** New games to import, oldest first (so history builds up in order). */
  toImport: SyncCandidate[];
  duplicates: number;
  /** Matching games left for the next sync because of the per-sync cap. */
  deferred: number;
  archivesChecked: number;
  state: SyncState;
  /** True when the previous sync was too recent and nothing was fetched. */
  cooledDown?: boolean;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const COOLDOWN_MS = 60_000;

export function normalizeUsername(u: string): string {
  return u.trim().toLowerCase();
}

export function validUsername(u: string): boolean {
  return /^[a-z0-9_-]{3,25}$/i.test(u.trim());
}

/** Which side the user played, matching the username case-insensitively. */
export function sideOf(game: Pick<ChessComGame, 'white' | 'black'>, username: string): Color | undefined {
  const u = normalizeUsername(username);
  if (normalizeUsername(game.white?.username ?? '') === u) return 'w';
  if (normalizeUsername(game.black?.username ?? '') === u) return 'b';
  return undefined;
}

/** Archive URLs (".../games/2026/10") for months that overlap the last `days` days. */
export function archivesInWindow(archives: string[], now: number, days: number): string[] {
  const since = now - days * 86_400_000;
  return archives.filter((url) => {
    const m = /\/games\/(\d{4})\/(\d{2})$/.exec(url);
    if (!m) return false;
    const monthEnd = Date.UTC(Number(m[1]), Number(m[2]), 1); // first moment of the next month
    return monthEnd > since;
  });
}

function monthIsOver(url: string, now: number): boolean {
  const m = /\/games\/(\d{4})\/(\d{2})$/.exec(url);
  // A day of slack for games that finish right at midnight.
  return !!m && now > Date.UTC(Number(m[1]), Number(m[2]), 1) + 86_400_000;
}

export function isStandard(g: ChessComGame): boolean {
  if (g.rules && g.rules !== 'chess') return false;
  return !g.initial_setup || g.initial_setup === START_FEN;
}

export function asGames(json: unknown): ChessComGame[] {
  const games = (json as { games?: unknown })?.games;
  if (!Array.isArray(games)) throw new SyncError('bad_response', 'Chess.com sent an unexpected response.');
  return games.filter((g): g is ChessComGame => !!g && typeof g === 'object' && typeof (g as ChessComGame).url === 'string' && !!(g as ChessComGame).white && !!(g as ChessComGame).black);
}

export async function get(fetcher: ChessComFetch, path: string): Promise<unknown> {
  let r: Awaited<ReturnType<ChessComFetch>>;
  try {
    r = await fetcher(path);
  } catch {
    throw new SyncError('network', "Couldn't reach Chess.com. Check your connection and try again.");
  }
  if (r.status === 404) throw new SyncError('not_found', 'not found');
  if (r.status === 429)
    throw new SyncError('rate_limited', `Chess.com asked us to slow down. Try again in ${r.retryAfter && r.retryAfter > 60 ? `${Math.ceil(r.retryAfter / 60)} minutes` : 'a minute'}.`);
  if (r.status < 200 || r.status >= 300) throw new SyncError('network', `Chess.com returned an error (${r.status}). Try again later.`);
  if (r.json === undefined) throw new SyncError('bad_response', 'Chess.com sent an unexpected response.');
  return r.json;
}

/**
 * Work out which games to import. Pure apart from `fetcher`; the caller does the
 * importing, so synced games go through exactly the same path as pasted ones.
 */
export async function planSync(opts: SyncOptions, fetcher: ChessComFetch, existing: StoredGame[], prev?: SyncState): Promise<SyncPlan> {
  const username = normalizeUsername(opts.username);
  if (!validUsername(username)) throw new SyncError('invalid_username', 'That doesn\'t look like a Chess.com username (3–25 letters, numbers, "_" or "-").');
  const state: SyncState = prev && prev.username === username ? { ...prev, completed: [...prev.completed] } : { username, completed: [] };
  if (state.lastSyncAt && opts.now - state.lastSyncAt < COOLDOWN_MS) {
    return { toImport: [], duplicates: 0, deferred: 0, archivesChecked: 0, state, cooledDown: true };
  }

  let list: unknown;
  try {
    list = await get(fetcher, `player/${encodeURIComponent(username)}/games/archives`);
  } catch (e) {
    if (e instanceof SyncError && e.kind === 'not_found') throw new SyncError('not_found', `Chess.com has no player called "${opts.username.trim()}".`);
    throw e;
  }
  const archives = (list as { archives?: unknown })?.archives;
  if (!Array.isArray(archives) || !archives.every((a) => typeof a === 'string')) throw new SyncError('bad_response', 'Chess.com sent an unexpected response.');

  const filters = [...opts.timeClasses].sort().join(',');
  const since = opts.now - opts.days * 86_400_000;
  const months = archivesInWindow(archives as string[], opts.now, opts.days).filter((url) => !state.completed.includes(`${url}|${filters}`));

  const found: SyncCandidate[] = [];
  let duplicates = 0;
  const seen = new Set<string>();
  for (const url of months) {
    const path = url.replace(/^https?:\/\/api\.chess\.com\/pub\//, '');
    let games: ChessComGame[];
    try {
      games = asGames(await get(fetcher, path));
    } catch (e) {
      if (e instanceof SyncError && e.kind === 'not_found') continue; // an empty month can 404
      throw e;
    }
    for (const g of games) {
      const color = sideOf(g, username);
      const endTime = (g.end_time ?? 0) * 1000;
      if (!color || !g.pgn || !isStandard(g) || endTime < since) continue;
      if (!opts.timeClasses.includes((g.time_class ?? '') as ChessComTimeClass)) continue;
      const id = sourceKeyFromUrl(g.url) ?? `chesscom:${g.url}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let parsed: ParsedGame;
      try {
        parsed = parsePgn(g.pgn);
      } catch {
        continue; // a PGN we can't read is skipped, not fatal
      }
      if (!parsed.plies.length) continue;
      const source = { site: 'chesscom' as const, id, url: g.url, timeClass: g.time_class };
      if (findDuplicate(existing, { headers: parsed.headers, plies: parsed.plies, source })) {
        duplicates++;
        continue;
      }
      found.push({ parsed, color, source, endTime });
    }
    if (monthIsOver(url, opts.now)) state.completed.push(`${url}|${filters}`);
  }

  // Rapid first, then newest; then import oldest first.
  const rank = (c: SyncCandidate) => (c.source.timeClass === 'rapid' ? 0 : 1);
  const chosen = [...found].sort((a, b) => rank(a) - rank(b) || b.endTime - a.endTime).slice(0, opts.maxGames);
  const deferred = found.length - chosen.length;
  // Months with games left over must be visited again next time.
  if (deferred) {
    const left = new Set(found.filter((c) => !chosen.includes(c)).map((c) => c.endTime));
    state.completed = state.completed.filter((k) => {
      const m = /\/games\/(\d{4})\/(\d{2})\|/.exec(k);
      if (!m) return true;
      const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
      const end = Date.UTC(Number(m[1]), Number(m[2]), 1);
      return ![...left].some((t) => t >= start && t < end);
    });
  }
  state.lastSyncAt = opts.now;
  return { toImport: chosen.sort((a, b) => a.endTime - b.endTime), duplicates, deferred, archivesChecked: months.length + 1, state };
}

/** One short sentence for the UI. */
export function syncSummary(p: Pick<SyncPlan, 'toImport' | 'duplicates' | 'deferred' | 'cooledDown'>, days: number): string {
  if (p.cooledDown) return 'Already synced a moment ago — try again in a minute.';
  const n = p.toImport.length;
  const more = p.deferred ? ` ${p.deferred} more will come in on the next sync.` : '';
  if (!n) return `No new games from the last ${days} days.`;
  return `${n} new game${n === 1 ? '' : 's'} imported.${more}`;
}
