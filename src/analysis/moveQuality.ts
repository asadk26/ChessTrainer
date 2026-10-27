// How good is a move compared with the engine's best, in practical bands —
// so a move that's as good as Stockfish's #1 is never called wrong.
import type { MoveEval, PositionEval } from '../domain/types';
import { pd, scoreToCp, winPercent } from './evaluation';

export type Quality = 'best' | 'equal' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export const QUALITY_LABEL: Record<Quality, string> = {
  best: 'Best move',
  equal: 'Equally good',
  good: 'Good, but less precise',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

/** Below this win% gap, two moves are "equally good" (engine noise at these depths is about this big). */
export const EQUAL_BAND = 2.5;

/**
 * Practical gap between the best move and another (both in centipawns from the
 * mover's view). Win% in balanced positions; when clearly ahead, win% flattens,
 * so centipawn loss counts too (20cp ≈ 1 win% point), as elsewhere in the coach.
 */
export function gapBetween(bestCp: number, cp: number): number {
  const winGap = Math.max(0, winPercent(bestCp) - winPercent(cp));
  if (bestCp < 300) return winGap;
  const clamp = (x: number) => Math.max(-1000, Math.min(1000, x));
  return Math.max(winGap, Math.min(40, Math.max(0, clamp(bestCp) - clamp(cp)) / 20));
}

export function qualityOfGap(gap: number, isTop = false): Quality {
  if (isTop) return 'best';
  if (gap < EQUAL_BAND) return 'equal';
  if (gap < 6) return 'good';
  if (gap < 12) return 'inaccuracy';
  if (gap < 22) return 'mistake';
  return 'blunder';
}

export interface RankedMove {
  uci: string;
  cp: number;
  quality: Quality;
}

/** The engine's candidate moves (MultiPV lines) with their quality bands. */
export function rankCandidates(pos: PositionEval | undefined): RankedMove[] {
  const lines = pos?.lines ?? [];
  if (!lines.length) return [];
  const bestCp = scoreToCp(lines[0].score);
  return lines
    .filter((l) => l.pv.length)
    .map((l, i) => {
      const cp = scoreToCp(l.score);
      return { uci: l.pv[0], cp, quality: qualityOfGap(gapBetween(bestCp, cp), i === 0) };
    });
}

/** Other moves Stockfish rates about as highly as its first choice. */
export function equalAlternatives(pos: PositionEval | undefined): string[] {
  return rankCandidates(pos)
    .filter((r) => r.quality === 'equal')
    .map((r) => r.uci);
}

/** Quality of a specific move: from the MultiPV lines if it's there, else from its own evaluation. */
export function qualityOf(pos: PositionEval | undefined, uci: string, cpAfterForMover?: number): Quality | undefined {
  const ranked = rankCandidates(pos);
  const hit = ranked.find((r) => r.uci === uci);
  if (hit) return hit.quality;
  if (cpAfterForMover === undefined || !ranked.length) return undefined;
  return qualityOfGap(gapBetween(ranked[0].cp, cpAfterForMover), false);
}

// ------------------------------------------------------------ display classes (badges)

/** The quality bands plus two rare praise classes, for badges in the review. */
export type MoveClass = Quality | 'great' | 'brilliant';

export const CLASS_LABEL: Record<MoveClass, string> = { ...QUALITY_LABEL, great: 'Great move', brilliant: 'Brilliant' };
export const CLASS_ICON: Record<MoveClass, string> = {
  brilliant: '!!',
  great: '!',
  best: '★',
  equal: '=',
  good: '✓',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

/**
 * Badge for one move: its quality band (same as everywhere else), upgraded to
 * - Brilliant: a best/equal move that gives up at least two pawns' worth of material in
 *   Stockfish's line and still keeps the position, while the game wasn't already won;
 * - Great: Stockfish's best when every alternative was clearly worse (an only move), in a
 *   position that wasn't already decided.
 * Both are deliberately rare: a wrong "brilliant" is worse than none.
 */
export function classifyMove(e: MoveEval, before?: PositionEval): MoveClass {
  const q = qualityOfGap(pd(e), e.isBest);
  if (q !== 'best' && q !== 'equal') return q;
  const sacrifice = e.materialAfterReply <= e.materialBefore - 2 && e.winAfter >= 50 && e.winBefore < 90;
  if (sacrifice) return 'brilliant';
  const lines = before?.lines.filter((l) => l.pv.length) ?? [];
  if (q === 'best' && lines.length >= 2 && e.winBefore >= 15 && e.winBefore <= 90) {
    const gap = gapBetween(scoreToCp(lines[0].score), scoreToCp(lines[1].score));
    if (gap >= 10) return 'great';
  }
  return q;
}
