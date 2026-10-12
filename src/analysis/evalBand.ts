// Evaluation in words, not numbers. Stockfish gives centipawns (or a mate); the
// win% mapping on top is the Lichess model fitted to real games. Coarse bands are
// what that can honestly support — no draw percentages, no fake decimals.
import { MATE_CP, winPercent } from './evaluation';

export type Band = 'winning' | 'clearly_better' | 'slightly_better' | 'equal' | 'slightly_worse' | 'clearly_worse' | 'losing';

const ORDER: Band[] = ['losing', 'clearly_worse', 'slightly_worse', 'equal', 'slightly_better', 'clearly_better', 'winning'];

export const BAND_LABEL: Record<Band, string> = {
  winning: 'Winning',
  clearly_better: 'Clearly better',
  slightly_better: 'Slightly better',
  equal: 'Equal',
  slightly_worse: 'Slightly worse',
  clearly_worse: 'Clearly worse',
  losing: 'Losing',
};

/** Band for a centipawn score from one side's point of view. */
export function bandOf(cp: number): Band {
  const w = winPercent(cp);
  if (w >= 85) return 'winning';
  if (w >= 66) return 'clearly_better';
  if (w >= 55) return 'slightly_better';
  if (w > 45) return 'equal';
  if (w > 34) return 'slightly_worse';
  if (w > 15) return 'clearly_worse';
  return 'losing';
}

/** -3 (losing) … +3 (winning). */
export const bandLevel = (b: Band) => ORDER.indexOf(b) - 3;

/** Bar fill 0..100 (your side), from win% — a visual, not a number to quote. */
export const barFill = (cp: number) => Math.round(winPercent(cp));

/** "Clearly better → Equal: this gave back most of your advantage." */
export function bandChange(before: number, after: number): { from: Band; to: Band; text: string; size: number } {
  const from = bandOf(before);
  const to = bandOf(after);
  const size = bandLevel(from) - bandLevel(to);
  const lf = bandLevel(from);
  const lt = bandLevel(to);
  let text: string;
  if (Math.abs(after) >= MATE_CP - 1000 && after < 0) text = 'this allowed a forced mate';
  else if (lt <= -3 && lf >= -1) text = 'this turned the game into a losing position';
  else if (size <= 0) text = size === 0 ? 'the balance barely changed' : 'this improved your position';
  else if (lf > 0 && lt < 0) text = 'this turned a better position into a worse one';
  else if (lf > 0 && lt === 0) text = size >= 2 ? 'this gave back most of your advantage' : 'this let your opponent equalise';
  else if (lf > 0) text = 'this gave back part of your advantage';
  else if (lf === 0) text = size >= 2 ? 'this handed your opponent the advantage' : 'this gave your opponent a small edge';
  else text = 'this made a difficult position worse';
  return { from, to, text, size };
}
