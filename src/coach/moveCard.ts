// The one-line card for a move of yours that Stockfish rates below its choice.
import { formatCp } from '../analysis/evaluation';

/** Evaluations everywhere in the review are from your side; this is said once, in a legend. */
export const EVAL_LEGEND = 'Numbers are from your side: + means you’re better, − worse (1.0 ≈ a pawn).';

/** "5.Qb3 — Inaccuracy. Bxb7 was stronger: it leaves you a pawn better off. (+2.5 vs +1.2)" */
export function moveCardLine(c: { move: string; label: string; bestSan: string; why?: string; bestCp: number; playedCp: number }): string {
  return `${c.move} — ${c.label}. ${betterLine(c.bestSan, c.why)} (${formatCp(c.bestCp)} vs ${formatCp(c.playedCp)})`;
}

/** "Bxb7 was stronger: it leaves you a pawn better off." */
export function betterLine(bestSan: string, why?: string): string {
  return `${bestSan} was stronger${why ? `: ${why}` : ''}.`;
}
