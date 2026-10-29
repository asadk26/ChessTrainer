// "You've seen this before": the same mistake as a teaching moment in an earlier game.
import { gamePlayedAt } from '../analysis/pipeline';
import type { Finding, StoredGame, TeachingMoment } from '../domain/types';
import { REPORT_VERSION } from './report';

export interface SeenBefore {
  game: StoredGame;
  moment: TeachingMoment;
  finding: Finding;
  /** Earlier games (not counting this one) with the same mistake. */
  count: number;
}

/** What makes two mistakes "the same": the tactic that decided them, or else the category. */
function signature(m: TeachingMoment): string {
  return m.tactic ? `tactic:${m.tactic.tag}:${m.tactic.side}` : `category:${m.category}`;
}

/**
 * Only earlier games coached by the current version count (older findings used older rules), and
 * only their teaching moments (what you were actually shown), matched exactly: no "related" themes.
 */
export function seenBefore(game: StoredGame, m: TeachingMoment | undefined, games: StoredGame[], version = REPORT_VERSION): SeenBefore | undefined {
  if (!m || m.kind !== 'mistake') return undefined;
  const sig = signature(m);
  const at = gamePlayedAt(game);
  const hits: { game: StoredGame; moment: TeachingMoment; finding: Finding }[] = [];
  for (const g of games) {
    if (g.id === game.id || g.status !== 'analyzed' || (g.report?.version ?? 0) < version || gamePlayedAt(g) >= at) continue;
    const moment = g.moments.find((x) => x.kind === 'mistake' && signature(x) === sig);
    const finding = moment && g.findings.find((f) => f.ply === moment.ply && f.category === moment.category);
    if (moment && finding) hits.push({ game: g, moment, finding });
  }
  if (!hits.length) return undefined;
  hits.sort((a, b) => gamePlayedAt(b.game) - gamePlayedAt(a.game));
  return { ...hits[0], count: hits.length };
}
