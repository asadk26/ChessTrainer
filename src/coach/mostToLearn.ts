// "Most to learn": which analyzed, not-yet-reviewed game is worth reviewing next.
// Score = learning value × recency. Learning value counts only what the coach can actually teach
// from (findings weighted by how much they cost and how sure the coach is), so a game full of
// unexplained engine swings ranks below one with two clear, teachable mistakes.
import type { Finding, StoredGame } from '../domain/types';
import { verdictOf } from '../analysis/engineReview';
import { gamePlayedAt, isRealGame } from '../analysis/pipeline';
import { isStateFinding } from '../analysis/moments';
import { PATTERN_LABEL, type PatternTag } from '../analysis/patterns';
import { categoryLabel } from '../domain/categories';
import { userOutcome } from '../chess/outcome';
import type { CategoryId } from '../domain/types';

const DAY = 24 * 60 * 60 * 1000;
export const HALF_LIFE_DAYS = 7;
/** A clean win still shows, but low: there is little to fix in it. */
export const CLEAN_WIN_VALUE = 0.3;
const SEVERITY = { blunder: 3, mistake: 2, inaccuracy: 0.5 } as const;
const MISSED_WIN = 2;
const CONFIDENCE = { high: 1, medium: 0.6, low: 0.2 } as const;
const PATTERN_BONUS = 1.5;
const THREW_WIN_BONUS = 1.25;
const WINNING_CP = 300;

export interface RankedGame {
  game: StoredGame;
  score: number;
  value: number;
  /** At most two short reasons, backed by high- or medium-confidence findings (or the result). */
  chips: string[];
}

/** What makes two findings "the same pattern" across games: the tactic, or else the category. */
export function patternKey(f: Finding): string {
  return f.facts.pattern ? `tactic:${String(f.facts.pattern)}:${String(f.facts.patternSide)}` : `category:${f.category}`;
}

/** Plain name for a pattern key: "Fork allowed", "Free piece missed", "Defended pawn grab". */
export function patternName(key: string): string {
  const [kind, id, side] = key.split(':');
  if (kind !== 'tactic') return categoryLabel(id as CategoryId);
  const label = PATTERN_LABEL[id as PatternTag] ?? id;
  if (side === 'better') return id === 'hanging_piece' ? 'Free piece missed' : `${label} missed`;
  return ['fork', 'knight_fork', 'pawn_fork', 'skewer', 'pin', 'discovered_attack'].includes(id) ? `${label} allowed` : label;
}

const userWeaknesses = (g: StoredGame) =>
  g.findings.filter((f) => f.kind === 'weakness' && f.ply > 0 && g.plies[f.ply - 1]?.color === g.userColor && !isStateFinding(f));
const credible = (f: Finding) => f.confidence === 'high' || f.confidence === 'medium';

/** Your top recurring patterns: in how many analyzed games each credible pattern showed up (2+ games). */
export function topPatterns(games: StoredGame[], n = 3): string[] {
  const count = new Map<string, number>();
  for (const g of games.filter((x) => x.status === 'analyzed' && isRealGame(x))) {
    for (const k of new Set(userWeaknesses(g).filter((f) => credible(f) && f.severity >= 2).map(patternKey))) count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...count].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
}

/** How much the move a finding is about cost: blunder 3, mistake 2, a missed win or mate 2, inaccuracy 0.5. */
function findingWeight(g: StoredGame, f: Finding): number {
  const e = g.analysis?.moves[Number(f.facts.worsePly ?? f.ply) - 1];
  const v = e ? verdictOf(e) : undefined;
  const byVerdict = v === 'blunder' || v === 'mistake' || v === 'inaccuracy' ? SEVERITY[v] : 0;
  const missedWin = f.category === 'tactical_blindness' && (!!f.facts.mateIn || Number(f.facts.gain ?? 0) >= 3);
  return Math.max(byVerdict, missedWin ? MISSED_WIN : 0);
}

/** The highest user-view evaluation reached in the game (centipawns). */
function bestEval(g: StoredGame): number {
  return Math.max(-Infinity, ...(g.analysis?.moves ?? []).filter((e) => e.color === g.userColor).map((e) => e.cpBefore));
}

export function learningValue(g: StoredGame, top: string[]): { value: number; chips: string[] } {
  // Per move, the most it can teach: severity × confidence (an unexplained mistake counts at 0.2).
  const perPly = new Map<number, { w: number; f?: Finding }>();
  for (const f of userWeaknesses(g)) {
    const w = findingWeight(g, f) * CONFIDENCE[f.confidence ?? 'low'];
    if (w > (perPly.get(f.ply)?.w ?? 0)) perPly.set(f.ply, { w, f });
  }
  (g.analysis?.moves ?? []).forEach((e, i) => {
    const v = verdictOf(e);
    if (e.color !== g.userColor || perPly.has(i + 1) || (v !== 'mistake' && v !== 'blunder')) return;
    perPly.set(i + 1, { w: SEVERITY[v] * CONFIDENCE.low });
  });
  let value = [...perPly.values()].reduce((s, x) => s + x.w, 0);

  const outcome = userOutcome(g);
  const strong = userWeaknesses(g).filter(credible);
  const matched = top.findIndex((k) => strong.some((f) => patternKey(f) === k));
  if (matched >= 0) value *= PATTERN_BONUS;
  const threwWin = (outcome === 'loss' || outcome === 'draw') && bestEval(g) >= WINNING_CP;
  if (threwWin) value *= THREW_WIN_BONUS;
  if (outcome === 'win' && strong.length === 0) value = Math.max(value, CLEAN_WIN_VALUE);

  // Reasons: the biggest credible finding first, then your pattern or how the result came about.
  const chips: string[] = [];
  const biggest = [...perPly.values()].filter((x) => x.f && credible(x.f)).sort((a, b) => b.w - a.w)[0]?.f;
  const mate = strong.find((f) => f.facts.mateIn);
  if (mate) chips.push(`Missed mate in ${String(mate.facts.mateIn)}`);
  else if (biggest) chips.push(patternName(patternKey(biggest)));
  if (matched >= 0) chips.push(`Your #${matched + 1} pattern`);
  else if (threwWin) chips.push(outcome === 'loss' ? 'Lost from +3' : 'Drew from +3');
  else if (mate && biggest && patternName(patternKey(biggest)) !== chips[0]) chips.push(patternName(patternKey(biggest)));
  return { value, chips: chips.slice(0, 2) };
}

/** Exponential decay: a game played `HALF_LIFE_DAYS` ago counts half. */
export function recency(playedAt: number, now: number): number {
  return Math.pow(0.5, Math.max(0, now - playedAt) / DAY / HALF_LIFE_DAYS);
}

/** Analyzed, real, not-yet-reviewed games, most to learn first. */
export function rankGames(games: StoredGame[], now = Date.now()): RankedGame[] {
  const top = topPatterns(games);
  return games
    .filter((g) => g.status === 'analyzed' && isRealGame(g) && !g.reviewedAt)
    .map((game) => {
      const { value, chips } = learningValue(game, top);
      return { game, value, chips, score: value * recency(gamePlayedAt(game), now) };
    })
    .sort((a, b) => b.score - a.score || gamePlayedAt(b.game) - gamePlayedAt(a.game));
}

/** Reviewed today (local date): the home card says one game is plenty. */
export function reviewedToday(games: StoredGame[], now = Date.now()): boolean {
  const today = new Date(now).toDateString();
  return games.some((g) => g.reviewedAt && new Date(g.reviewedAt).toDateString() === today);
}

/** When fewer than 3 games are ready to review: up to 5 of the most recent unanalyzed games, losses first. */
export function gamesToAnalyzeNext(games: StoredGame[]): StoredGame[] {
  const ready = games.filter((g) => g.status === 'analyzed' && isRealGame(g) && !g.reviewedAt).length;
  if (ready >= 3) return [];
  const waiting = games.filter((g) => isRealGame(g) && g.status !== 'analyzed' && g.status !== 'error');
  const recent = [...waiting].sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a)).slice(0, 5);
  return recent.sort((a, b) => Number(userOutcome(b) === 'loss') - Number(userOutcome(a) === 'loss') || gamePlayedAt(b) - gamePlayedAt(a));
}
