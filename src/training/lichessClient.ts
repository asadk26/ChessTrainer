// Browser side of the Lichess opening explorer: calls this app's /api/lichess proxy (the
// token stays server-side), maps the answer to move shares, and caches each position
// locally for a month. Unavailable (no token, offline) → undefined, and the trainer
// carries on with Stockfish alone.
import type { Explorer, ExplorerMove } from './opening';

const PREFIX = 'chesscoach:v1:lichess:';
const MONTH = 30 * 24 * 3600 * 1000;
let unavailable = false;

/** Lichess rating groups near a Chess.com rapid rating (Lichess ratings run roughly 300–400 higher at club level). */
export function lichessGroups(chesscomRating: number): string {
  const target = chesscomRating + 350;
  const groups = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
  const i = Math.max(0, groups.findIndex((g, k) => target >= g && (k === groups.length - 1 || target < groups[k + 1])));
  return groups.slice(Math.max(0, i - 1), i + 2).join(',');
}

interface Raw {
  moves?: { uci: string; san: string; white: number; draws: number; black: number }[];
  opening?: { name?: string } | null;
}

export function toExplorer(raw: Raw): { moves: ExplorerMove[]; opening?: string } {
  const moves = (raw.moves ?? []).map((m) => ({ uci: m.uci, san: m.san, games: m.white + m.draws + m.black }));
  const total = moves.reduce((a, m) => a + m.games, 0) || 1;
  return { moves: moves.map((m) => ({ ...m, share: m.games / total })), opening: raw.opening?.name };
}

export function lichessExplorer(rating: number, accessCode?: string): Explorer {
  const ratings = lichessGroups(rating);
  return async (fen) => {
    if (unavailable) return undefined;
    const key = `${PREFIX}${fen}|${ratings}`;
    try {
      const hit = localStorage.getItem(key);
      if (hit) {
        const { at, data } = JSON.parse(hit);
        if (Date.now() - at < MONTH) return data;
      }
    } catch {
      /* storage unavailable */
    }
    const res = await fetch(`/api/lichess?${new URLSearchParams({ fen, ratings })}`, { headers: accessCode ? { 'x-coach-token': accessCode } : {} }).catch(() => undefined);
    if (!res || !res.ok) {
      if (!res || res.status === 503 || res.status === 401) unavailable = true;
      return undefined;
    }
    const data = toExplorer((await res.json()) as Raw);
    try {
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
    } catch {
      /* storage full or unavailable */
    }
    return data;
  };
}
