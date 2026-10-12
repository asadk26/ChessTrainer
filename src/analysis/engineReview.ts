// Plain engine facts, separate from the coach's teaching: a verdict for every
// move (both sides), Lichess-style accuracy, and short notes for what the
// coach didn't explain — so silence never reads as "you played best".
import type { MoveEval, PlyRecord, StoredGame } from '../domain/types';
import { COLOR_NAME, other } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { formatCp, MATE_CP, pd } from './evaluation';
import { QUALITY_LABEL, qualityOfGap, type Quality } from './moveQuality';

export type Verdict = Quality;
export const VERDICT_LABEL = QUALITY_LABEL;

/** Same bands as everywhere else: "equally good" moves are never marked down. */
export function verdictOf(e: MoveEval): Verdict {
  return qualityOfGap(pd(e), e.isBest);
}

/** Lichess's per-move accuracy from the win% drop. */
export function moveAccuracy(winDrop: number): number {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, winDrop)) - 3.1669));
}

export interface SideStats {
  accuracy: number;
  moves: number;
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

export interface GameStats {
  you: SideStats;
  opponent: SideStats;
  /** Why the numbers say less than usual about this game, if they do. */
  caveat?: string;
}

function sideStats(moves: MoveEval[]): SideStats {
  const accs = moves.map((e) => moveAccuracy(e.winDrop));
  const mean = accs.reduce((a, b) => a + b, 0) / Math.max(1, accs.length);
  // Like Lichess: blend the average with the harmonic mean, so one disaster counts.
  const harmonic = accs.length / accs.reduce((a, b) => a + 1 / Math.max(1, b), 0);
  const count = (v: Verdict) => moves.filter((e) => verdictOf(e) === v).length;
  return { accuracy: Math.round((mean + harmonic) / 2), moves: moves.length, inaccuracy: count('inaccuracy'), mistake: count('mistake'), blunder: count('blunder') };
}

export function gameStats(game: StoredGame): GameStats | undefined {
  const moves = game.analysis?.moves;
  if (!moves?.length) return undefined;
  const you = sideStats(moves.filter((e) => e.color === game.userColor));
  const opponent = sideStats(moves.filter((e) => e.color !== game.userColor));
  const mine = moves.filter((e) => e.color === game.userColor);
  const decided = mine.filter((e) => Math.abs(e.cpBefore) >= 500).length / Math.max(1, mine.length);
  const caveat =
    you.moves < 15
      ? `Short game (${you.moves} moves): one move decides these numbers.`
      : decided > 0.5
        ? 'Most of this game was already decided, which makes accuracy look better than it was.'
        : undefined;
  return { you, opponent, caveat };
}

export interface EngineNote {
  ply: number;
  kind: 'trap' | 'uncovered' | 'opponent_missed';
  text: string;
}

/** Evaluation for the side named after it: "+1.4", "mate in 3", "getting mated in 2". */
const fmt = (cp: number) => {
  if (Math.abs(cp) < MATE_CP - 1000) return formatCp(cp);
  const n = Math.max(1, Math.round((MATE_CP - Math.abs(cp)) / 10));
  return cp > 0 ? `mate in ${n}` : `getting mated in ${n}`;
};

/**
 * A move that was objectively weaker, but the opponent's natural reply lost:
 * it "worked" — say so, and say what was better.
 */
function trapAt(plies: PlyRecord[], evals: MoveEval[], i: number, user: string): EngineNote | undefined {
  const e = evals[i];
  const r = evals[i + 1];
  if (!r || e.color !== user || pd(e) < 8 || pd(r) < 15) return undefined;
  // A trap is bait: their losing reply takes what your move put there.
  if (!plies[i + 1].captured || plies[i + 1].to !== plies[i].to) return undefined;
  // After their reply, you're better off than before your move.
  if (100 - r.winAfter < e.winBefore + 5) return undefined;
  const opp = COLOR_NAME[other(e.color)];
  const punish = plies[i + 2] && evals[i + 2]?.isBest ? ` ${plies[i + 2].san}` : '';
  return {
    ply: plies[i].ply,
    kind: 'trap',
    text: `${moveLabel(plies[i])} set a trap and ${opp} fell for it: ${moveLabel(plies[i + 1])}?${punish}. It worked — but Stockfish preferred ${e.bestSan} (${fmt(e.cpBefore)} instead of ${fmt(e.cpAfter)} for you), and ${r.bestSan} would have ${r.cpBefore >= 100 ? `kept ${opp} on top` : `held for ${opp}`}.`,
  };
}

/** Engine notes the coach's own lessons don't already cover. */
export function engineNotes(game: StoredGame): EngineNote[] {
  const evals = game.analysis?.moves;
  if (!evals?.length) return [];
  const user = game.userColor;
  const opp = COLOR_NAME[other(user)];
  const covered = new Set<number>([
    ...game.moments.map((m) => m.ply),
    ...game.findings.filter((f) => f.kind === 'weakness' && f.confidence !== 'low').flatMap((f) => [f.ply, ...(f.relatedPlies ?? [])]),
    ...Object.keys(game.explanations ?? {}).map(Number),
  ]);
  const traps: EngineNote[] = [];
  const uncovered: { note: EngineNote; d: number }[] = [];
  const missed: { note: EngineNote; d: number }[] = [];
  game.plies.forEach((p, i) => {
    const e = evals[i];
    if (!e) return;
    const trap = trapAt(game.plies, evals, i, user);
    if (trap) return void traps.push(trap);
    const v = verdictOf(e);
    if (p.color === user && (v === 'mistake' || v === 'blunder') && !covered.has(p.ply)) {
      uncovered.push({
        d: pd(e),
        note: {
          ply: p.ply,
          kind: 'uncovered',
          text: `${moveLabel(p)} — ${v}. Stockfish preferred ${e.bestSan} (${fmt(e.cpBefore)} instead of ${fmt(e.cpAfter)} for you${e.bestLineSan.length > 1 ? `; ${e.bestLineSan.slice(0, 4).join(' ')}` : ''}). I don't have a clear explanation for this one yet.`,
        },
      });
    }
    if (p.color !== user && (v === 'mistake' || v === 'blunder') && e.bestSan) {
      missed.push({
        d: pd(e),
        note: { ply: p.ply, kind: 'opponent_missed', text: `${moveLabel(p)} was a ${v} by ${opp}: ${e.bestSan} was better (${fmt(e.cpBefore)} for ${opp} instead of ${fmt(e.cpAfter)}).` },
      });
    }
  });
  const top = <T extends { d: number; note: EngineNote }>(xs: T[], n: number) =>
    xs.sort((a, b) => b.d - a.d).slice(0, n).map((x) => x.note).sort((a, b) => a.ply - b.ply);
  const trapReplies = new Set(traps.map((t) => t.ply + 1)); // already told as part of the trap
  return [...traps, ...top(uncovered, 4), ...top(missed.filter((m) => !trapReplies.has(m.note.ply)), 3)];
}

/** Recent games vs earlier ones, once there are enough to compare. */
export function trend(stats: { at: number; s: GameStats }[]): { recent: number; earlier: number; recentBlunders: number; earlierBlunders: number; n: number } | undefined {
  const usable = stats.filter((x) => x.s.you.moves >= 10).sort((a, b) => a.at - b.at);
  if (usable.length < 6) return undefined;
  const n = Math.min(5, Math.floor(usable.length / 2));
  const avg = (xs: typeof usable, f: (s: GameStats) => number) => xs.reduce((a, x) => a + f(x.s), 0) / xs.length;
  const earlier = usable.slice(-2 * n, -n);
  const recent = usable.slice(-n);
  return {
    n,
    recent: Math.round(avg(recent, (s) => s.you.accuracy)),
    earlier: Math.round(avg(earlier, (s) => s.you.accuracy)),
    recentBlunders: Math.round(avg(recent, (s) => s.you.blunder) * 10) / 10,
    earlierBlunders: Math.round(avg(earlier, (s) => s.you.blunder) * 10) / 10,
  };
}
