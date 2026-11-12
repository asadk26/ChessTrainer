// Pure helpers behind the board's pointer input (kept apart so they're easy to test).
import type { Chess, Square } from 'chess.js';
import type { Color } from '../../domain/types';

/** How far a pointer must travel before a press on a piece becomes a drag (smaller is a tap). */
export const DRAG_THRESHOLD_PX = 5;

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

/** The square under a point, given the board's on-screen box; null outside the board. */
export function squareAt(x: number, y: number, rect: { left: number; top: number; width: number }, orientation: Color): Square | null {
  const w = rect.width / 8;
  if (!(w > 0)) return null;
  const col = Math.floor((x - rect.left) / w);
  const row = Math.floor((y - rect.top) / w);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  const file = orientation === 'w' ? col : 7 - col;
  const rank = orientation === 'w' ? 7 - row : row;
  return `${'abcdefgh'[file]}${rank + 1}` as Square;
}

/** Legal destination squares for the piece on `from`; the value is true for captures. */
export function legalTargets(chess: Chess, from: Square): Map<Square, boolean> {
  const out = new Map<Square, boolean>();
  for (const m of chess.moves({ square: from, verbose: true })) out.set(m.to as Square, out.get(m.to as Square) || !!m.captured);
  return out;
}

/** True when moving from → to is a pawn promotion (so the user picks the piece). */
export function needsPromotion(chess: Chess, from: Square, to: Square): boolean {
  return chess.moves({ square: from, verbose: true }).some((m) => m.to === to && !!m.promotion);
}
