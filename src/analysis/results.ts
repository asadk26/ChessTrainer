// Results broken down for the Progress tab: by colour, opening and time of day. Results need no
// analysis, so every real game counts.
import type { StoredGame } from '../domain/types';
import { userOutcome } from '../chess/outcome';
import { gameOpening } from './gameList';
import { isRealGame } from './pipeline';

export interface ResultRow {
  key: string;
  label: string;
  w: number;
  d: number;
  l: number;
  n: number;
  /** Points per game, 0–100 (a draw is half a point). */
  score: number;
}

/** W/D/L per group, biggest group first. Games without a known result are skipped. */
export function resultsBy(games: StoredGame[], group: (g: StoredGame) => { key: string; label: string } | undefined): ResultRow[] {
  const rows = new Map<string, ResultRow>();
  for (const g of games) {
    if (!isRealGame(g)) continue;
    const o = userOutcome(g);
    const k = o && group(g);
    if (!k) continue;
    const r = rows.get(k.key) ?? { ...k, w: 0, d: 0, l: 0, n: 0, score: 0 };
    r[o === 'win' ? 'w' : o === 'loss' ? 'l' : 'd']++;
    r.n++;
    rows.set(k.key, r);
  }
  return [...rows.values()].map((r) => ({ ...r, score: Math.round(((r.w + r.d / 2) / r.n) * 100) })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

export const byColor = (g: StoredGame) => (g.userColor === 'w' ? { key: 'w', label: 'White' } : { key: 'b', label: 'Black' });
export const byOpening = (g: StoredGame) => {
  const f = gameOpening(g).family;
  return { key: f, label: f };
};

const header = (pgn: string, tag: string) => new RegExp(`^\\s*\\[${tag}\\s+"([^"]*)"\\s*\\]`, 'm').exec(pgn)?.[1];

/** When the game started, if the PGN says (Chess.com: UTCDate + UTCTime). */
export function startedAt(g: Pick<StoredGame, 'pgn'>): Date | undefined {
  const date = header(g.pgn, 'UTCDate');
  const time = header(g.pgn, 'UTCTime');
  if (!date || !time) return undefined;
  const t = Date.parse(`${date.replace(/\./g, '-')}T${time}Z`);
  return Number.isFinite(t) ? new Date(t) : undefined;
}

export const TIME_OF_DAY = [
  { key: 'morning', label: 'Morning (5–12)' },
  { key: 'afternoon', label: 'Afternoon (12–17)' },
  { key: 'evening', label: 'Evening (17–22)' },
  { key: 'night', label: 'Night (22–5)' },
] as const;

/** Morning / afternoon / evening / night in the viewer's local time (`hourOf` is overridable for tests). */
export function byTimeOfDay(hourOf: (d: Date) => number = (d) => d.getHours()) {
  return (g: StoredGame) => {
    const d = startedAt(g);
    if (!d) return undefined;
    const h = hourOf(d);
    const k = h >= 5 && h < 12 ? 0 : h >= 12 && h < 17 ? 1 : h >= 17 && h < 22 ? 2 : 3;
    return { key: TIME_OF_DAY[k].key, label: TIME_OF_DAY[k].label };
  };
}
