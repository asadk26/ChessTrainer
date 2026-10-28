// The three numbers on Home: rating trend, games this week, blunders per game.
import type { StoredGame } from '../domain/types';
import { gameStats } from './engineReview';
import { gamePlayedAt, isRealGame } from './pipeline';

export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily';
const DAY = 86_400_000;

/** Chess.com's time class: from the sync, else from the TimeControl header (base + 40 × increment). */
export function timeClassOf(g: Pick<StoredGame, 'source' | 'headers'>): TimeClass | undefined {
  const known = g.source?.timeClass;
  if (known === 'bullet' || known === 'blitz' || known === 'rapid' || known === 'daily') return known;
  const tc = g.headers.timeControl;
  if (!tc) return undefined;
  if (tc.includes('/')) return 'daily';
  const [base, inc] = tc.split('+').map(Number);
  if (!Number.isFinite(base)) return undefined;
  const total = base + 40 * (Number.isFinite(inc) ? inc : 0);
  return total < 180 ? 'bullet' : total < 600 ? 'blitz' : 'rapid';
}

export const userRating = (g: Pick<StoredGame, 'headers' | 'userColor'>) => (g.userColor === 'w' ? g.headers.whiteElo : g.headers.blackElo);

export interface RatingTrend {
  timeClass?: TimeClass;
  current: number;
  /** Change over the last 30 days (or since the first game shown, when they're all newer). */
  change: number;
  /** Ratings oldest → newest, for a sparkline (up to 20). */
  points: number[];
}

/** Your rating in the time control you play most recently, from the PGN headers. */
export function ratingTrend(games: StoredGame[], now = Date.now()): RatingTrend | undefined {
  const rated = games.filter((g) => isRealGame(g) && userRating(g)).sort((a, b) => gamePlayedAt(a) - gamePlayedAt(b));
  const latest = rated.at(-1);
  if (!latest) return undefined;
  const tc = timeClassOf(latest);
  const same = rated.filter((g) => timeClassOf(g) === tc);
  const current = userRating(latest)!;
  const month = same.filter((g) => gamePlayedAt(g) >= now - 30 * DAY);
  const base = (month.length >= 2 ? month : same)[0];
  return { timeClass: tc, current, change: current - userRating(base)!, points: same.slice(-20).map((g) => userRating(g)!) };
}

/** Real games played in the last 7 days. */
export const gamesThisWeek = (games: StoredGame[], now = Date.now()) => games.filter((g) => isRealGame(g) && gamePlayedAt(g) >= now - 7 * DAY && gamePlayedAt(g) <= now + DAY).length;

/** Blunders per game over your last 10 analyzed games, and over the 10 before (when there are enough). */
export function blundersPerGame(games: StoredGame[]): { recent: number; earlier?: number; n: number } | undefined {
  const per = games
    .filter((g) => isRealGame(g) && g.status === 'analyzed')
    .sort((a, b) => gamePlayedAt(a) - gamePlayedAt(b))
    .flatMap((g) => {
      const s = gameStats(g);
      return s ? [s.you.blunder] : [];
    });
  if (!per.length) return undefined;
  const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  const recent = per.slice(-10);
  const before = per.slice(-20, -10);
  return { recent: avg(recent), earlier: before.length >= 5 ? avg(before) : undefined, n: recent.length };
}
