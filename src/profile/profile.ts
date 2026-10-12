// Aggregates findings across games into a player profile. The profile is
// derived data: it can always be recomputed from stored games.
import type { CategoryId, CategoryStats, Finding, ProfileSummary, StrengthId, StrengthStats, Trend } from '../domain/types';
import { CATEGORIES, STRENGTHS } from '../domain/categories';

export interface ProfileGame {
  gameId: string;
  playedAt: number;
  findings: Finding[];
  fenByPly?: Record<number, string>;
  sanByPly?: Record<number, string>;
}

export const RECENT_WINDOW = 5;

function trendFor(gamesNewestFirst: ProfileGame[], cat: string): Trend {
  const hit = (g: ProfileGame) => g.findings.some((f) => f.kind === 'weakness' && f.category === cat && f.severity >= 2);
  const total = gamesNewestFirst.filter(hit).length;
  if (gamesNewestFirst.length < 4) return total > 0 && hit(gamesNewestFirst[0]) && total === 1 ? 'new' : 'insufficient';
  const recent = gamesNewestFirst.slice(0, 3);
  const older = gamesNewestFirst.slice(3, 6);
  const r = recent.filter(hit).length / recent.length;
  const o = older.filter(hit).length / older.length;
  if (o === 0 && r > 0) return total === recent.filter(hit).length && total === 1 ? 'new' : 'worsening';
  if (r <= o - 0.3) return 'improving';
  if (r >= o + 0.3) return 'worsening';
  return 'stable';
}

export function aggregateProfile(games: ProfileGame[]): ProfileSummary {
  const newestFirst = [...games].sort((a, b) => b.playedAt - a.playedAt);
  const recent = newestFirst.slice(0, RECENT_WINDOW);
  const categories: CategoryStats[] = [];

  for (const cat of Object.keys(CATEGORIES) as CategoryId[]) {
    // Severity-1 findings are soft observations; they're tracked but don't make a pattern on their own.
    const occ = newestFirst.flatMap((g) => g.findings.filter((f) => f.kind === 'weakness' && f.category === cat).map((f) => ({ g, f })));
    if (occ.length === 0) continue;
    const gamesWith = new Set(occ.filter((o) => o.f.severity >= 2).map((o) => o.g.gameId));
    const recentGames = recent.filter((g) => gamesWith.has(g.gameId)).length;
    const last = occ[0];
    const n = gamesWith.size;
    categories.push({
      category: cat,
      label: CATEGORIES[cat].label,
      occurrences: occ.filter((o) => o.f.severity >= 2).length,
      recentGames,
      recentWindow: recent.length,
      gamesWithCategory: n,
      avgSeverity: occ.reduce((a, o) => a + o.f.severity, 0) / occ.length,
      trend: trendFor(newestFirst, cat),
      confidence: n >= 3 ? 'established' : n === 2 ? 'emerging' : 'possible',
      lastOccurrence: { gameId: last.g.gameId, ply: last.f.ply, san: last.g.sanByPly?.[last.f.ply], at: last.g.playedAt },
      examples: occ.slice(0, 4).map((o) => ({
        gameId: o.g.gameId,
        ply: o.f.ply,
        san: o.g.sanByPly?.[o.f.ply],
        fen: o.g.fenByPly?.[o.f.ply],
        evidence: o.f.evidence,
      })),
    });
  }
  categories.sort((a, b) => b.recentGames - a.recentGames || b.occurrences * CATEGORIES[b.category].weight - a.occurrences * CATEGORIES[a.category].weight);

  const strengths: StrengthStats[] = (Object.keys(STRENGTHS) as StrengthId[])
    .map((id) => ({
      id,
      label: STRENGTHS[id].label,
      recentGames: recent.filter((g) => g.findings.some((f) => f.kind === 'strength' && f.category === id)).length,
      recentWindow: recent.length,
    }))
    .filter((s) => s.recentGames > 0)
    .sort((a, b) => b.recentGames - a.recentGames);

  return {
    gamesAnalyzed: games.length,
    categories: categories.filter((c) => c.occurrences > 0),
    strengths,
    improving: categories.filter((c) => c.trend === 'improving'),
  };
}

/** Honest frequency language: never call one example a pattern. */
export function describeFrequency(c: CategoryStats): string {
  if (c.gamesWithCategory <= 1) return c.recentWindow <= 1 ? 'Possible tendency — seen in 1 game so far' : `Possible tendency — 1 of your last ${c.recentWindow} games`;
  if (c.trend === 'improving') return `Appears to be improving — ${c.recentGames} of your last ${c.recentWindow} games`;
  return `Has now appeared in ${c.recentGames} of your last ${c.recentWindow} games`;
}
