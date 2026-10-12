import type { PositionEval, Score } from '../domain/types';

export const MATE_CP = 10000;

/** Convert a score to centipawns; mates become large values that still sort by distance. */
export function scoreToCp(score: Score): number {
  if (score.type === 'cp') return score.value;
  if (score.value === 0) return -MATE_CP; // side to move is mated
  return score.value > 0 ? MATE_CP - score.value * 10 : -MATE_CP - score.value * 10;
}

/**
 * Expected score (0..100) for the side with `cp`. Same logistic curve Lichess
 * uses for its accuracy metric: ±100cp ≈ 59/41, ±300cp ≈ 75/25.
 */
export function winPercent(cp: number): number {
  const clamped = Math.max(-2000, Math.min(2000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/** Centipawn evaluation of a position for the side to move. */
export function positionCp(pos: PositionEval): number {
  if (pos.terminal === 'checkmate') return -MATE_CP;
  if (pos.terminal) return 0;
  const best = pos.lines[0];
  return best ? scoreToCp(best.score) : 0;
}

export interface EvalChange {
  cpBefore: number;
  cpAfter: number;
  winBefore: number;
  winAfter: number;
  winDrop: number;
}

/**
 * Evaluation change for the player who moved, given the analysis of the
 * position before the move (mover to play) and after it (opponent to play).
 */
export function evalChange(before: PositionEval, after: PositionEval): EvalChange {
  const cpBefore = positionCp(before);
  const cpAfter = -positionCp(after);
  const winBefore = winPercent(cpBefore);
  const winAfter = winPercent(cpAfter);
  return { cpBefore, cpAfter, winBefore, winAfter, winDrop: Math.max(0, winBefore - winAfter) };
}

/**
 * How a ~850 player should perceive an evaluation drop. Tiny engine
 * preferences are deliberately ignored.
 */
export function dropLevel(winDrop: number): 'none' | 'small' | 'mistake' | 'blunder' {
  if (winDrop < 6) return 'none';
  if (winDrop < 12) return 'small';
  if (winDrop < 22) return 'mistake';
  return 'blunder';
}

export function formatCp(cp: number): string {
  if (Math.abs(cp) >= MATE_CP - 1000) {
    const n = Math.max(1, Math.round((MATE_CP - Math.abs(cp)) / 10));
    return cp > 0 ? `M${n}` : `-M${n}`;
  }
  const v = cp / 100;
  if (Math.abs(v) < 0.05) return '0.0';
  return (v > 0 ? '+' : '') + v.toFixed(1);
}

const clampCp = (cp: number) => Math.max(-1000, Math.min(1000, cp));

/**
 * Practical cost of a move. Win% is the right lens in balanced positions, but
 * once someone is clearly ahead it flattens out: +8 -> +5 barely changes the
 * win%, yet giving back three pawns' worth is a real practical mistake. When
 * the mover is ahead we therefore also measure the centipawn loss (20cp ≈ 1
 * "win% point"), unless the position stays crushing without losing material
 * (e.g. missing a mate-in-4 while a queen up — not instructive at this level).
 */
export function practicalDrop(m: {
  cpBefore: number;
  cpAfter: number;
  winDrop: number;
  materialBefore: number;
  materialAfterReply: number;
}): number {
  const ahead = m.cpBefore >= 300 || m.materialBefore >= 3;
  if (!ahead) return m.winDrop;
  if (m.cpAfter >= 600 && m.materialAfterReply >= m.materialBefore - 1) return m.winDrop;
  const cpLoss = Math.max(0, clampCp(m.cpBefore) - clampCp(m.cpAfter));
  return Math.max(m.winDrop, Math.min(40, cpLoss / 20));
}

/** practicalDrop with a fallback for evaluations stored before it existed. */
export const pd = (e: { practicalDrop?: number; winDrop: number }) => e.practicalDrop ?? e.winDrop;

/**
 * Is a tried move "good enough"? Within 7 win% of the best — and, when the
 * best move keeps a clear advantage, within 120cp, because win% flattens out
 * when you're far ahead.
 */
export function closeToBest(tried: { win: number; cp: number }, best: { win: number; cp: number }): boolean {
  return tried.win >= best.win - 7 && (best.cp < 300 || tried.cp >= best.cp - CP_TOLERANCE);
}

export const CP_TOLERANCE = 120;
