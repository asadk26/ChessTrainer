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

/** Plain words for how good a position is for one side, from that side's (positive) number. */
function band(cp: number): string {
  return cp >= 300 ? 'winning' : cp >= 120 ? 'clearly better' : 'slightly better';
}

/**
 * An evaluation that names the side, with your number: "Black slightly better (you −0.5)".
 * For lines about the opponent's moves, where "you're slightly worse" would be ambiguous.
 */
export function sideEvalText(cpForYou: number, you: 'w' | 'b'): string {
  const mine = `you ${formatCp(cpForYou)}`;
  if (Math.abs(cpForYou) < 40) return `about equal (${mine})`;
  const better = cpForYou > 0 ? you : you === 'w' ? 'b' : 'w';
  return `${better === 'w' ? 'White' : 'Black'} ${band(Math.abs(cpForYou))} (${mine})`;
}
