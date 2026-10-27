// Tactical patterns across games: how often each one cost you, per month, and whether it is
// becoming rarer. Real games only. Games analysed before tags existed are tagged on the fly.
import type { StoredGame } from '../domain/types';
import { gamePatterns, gamePlayedAt, isRealGame } from './pipeline';
import { PATTERN_LABEL, type PatternTag } from './patterns';

export interface PatternStat {
  tag: PatternTag;
  label: string;
  total: number;
  /** Games it appeared in. */
  games: number;
  /** "2026-10" → count. */
  byMonth: Record<string, number>;
  /** Per game, the newest 5 real games against the 5 before them. */
  trend: 'improving' | 'worsening' | 'stable' | 'insufficient';
  examples: { gameId: string; ply: number; evidence: string }[];
}

export const patternsOf = (g: StoredGame) => g.patterns ?? gamePatterns(g);

export function patternStats(games: StoredGame[]): PatternStat[] {
  const real = games.filter((g) => g.status === 'analyzed' && isRealGame(g)).sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a));
  const tagged = real.map((g) => ({ g, p: patternsOf(g) }));
  const tags = new Set(tagged.flatMap((x) => Object.values(x.p).map((h) => h.tag)));
  return [...tags]
    .map((tag): PatternStat => {
      const byMonth: Record<string, number> = {};
      const examples: PatternStat['examples'] = [];
      let total = 0;
      let games = 0;
      const perGame = tagged.map(({ g, p }) => {
        const hits = Object.entries(p).filter(([, h]) => h.tag === tag);
        if (hits.length) games++;
        total += hits.length;
        const month = new Date(gamePlayedAt(g)).toISOString().slice(0, 7);
        if (hits.length) byMonth[month] = (byMonth[month] ?? 0) + hits.length;
        for (const [ply, h] of hits) if (examples.length < 3) examples.push({ gameId: g.id, ply: Number(ply), evidence: h.evidence });
        return hits.length;
      });
      const recent = perGame.slice(0, 5);
      const before = perGame.slice(5, 10);
      const rate = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const trend = before.length < 3 ? 'insufficient' : rate(recent) <= rate(before) - 0.3 ? 'improving' : rate(recent) >= rate(before) + 0.3 ? 'worsening' : 'stable';
      return { tag, label: PATTERN_LABEL[tag], total, games, byMonth, trend, examples };
    })
    .sort((a, b) => b.total - a.total);
}
