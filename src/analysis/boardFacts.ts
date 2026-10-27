// Concrete board facts about one move, for the "Why?" explanation: what the move attacks,
// defends or threatens (from the move-purpose engine), pins it creates, pieces it leaves hanging,
// and material that was there for the taking. Everything here is visible on the board — the
// explanation must cite at least one of these instead of inventing reasons.
import { Chess, type Square } from 'chess.js';
import type { Color, PieceType } from '../domain/types';
import { PIECE_NAME, PIECE_VALUE, attackersOf, isLoose, other, pieceAt } from '../chess/board';
import { describeMove } from './movePurpose';

const sqName = (t: PieceType, s: string) => (t === 'p' ? `pawn on ${s}` : `${PIECE_NAME[t]} on ${s}`);

/** Pieces of `color` that are attacked and not adequately defended. */
export function hangingPieces(fen: string, color: Color): { square: string; type: PieceType; text: string }[] {
  const c = new Chess(fen);
  const out: { square: string; type: PieceType; text: string }[] = [];
  for (const row of c.board())
    for (const p of row) {
      if (!p || p.color !== color || p.type === 'k' || !isLoose(fen, p.square)) continue;
      const by = attackersOf(fen, p.square, other(color))[0];
      const a = by ? pieceAt(fen, by) : undefined;
      out.push({ square: p.square, type: p.type as PieceType, text: `the ${sqName(p.type as PieceType, p.square)} is hanging${a ? ` (attacked by the ${sqName(a.type, by)})` : ''}` });
    }
  return out;
}

const DIRS: Record<string, [number, number][]> = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

/** Pins by `color`'s bishops, rooks and queens: an enemy piece that can't move without exposing a bigger one behind it. */
export function pinsBy(fen: string, color: Color): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const row of c.board())
    for (const p of row) {
      if (!p || p.color !== color || !DIRS[p.type]) continue;
      const f0 = p.square.charCodeAt(0) - 97;
      const r0 = Number(p.square[1]) - 1;
      for (const [df, dr] of DIRS[p.type]) {
        let first: { sq: string; type: PieceType } | undefined;
        for (let f = f0 + df, r = r0 + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
          const sq = `${String.fromCharCode(97 + f)}${r + 1}`;
          const q = c.get(sq as Square);
          if (!q) continue;
          if (!first) {
            if (q.color === color || q.type === 'k') break;
            first = { sq, type: q.type as PieceType };
            continue;
          }
          // Not a pin if the "pinned" piece can simply take the pinner (always legal along the line).
          const takesPinner = attackersOf(fen, p.square, other(color)).includes(first.sq as never);
          if (!takesPinner && q.color !== color && (q.type === 'k' || PIECE_VALUE[q.type as PieceType] > PIECE_VALUE[first.type]))
            out.push(`the ${sqName(p.type as PieceType, p.square)} pins the ${sqName(first.type, first.sq)} to the ${q.type === 'k' ? 'king' : sqName(q.type as PieceType, sq)}`);
          break;
        }
      }
    }
  return out;
}

export interface MoveBoardFacts {
  move: string;
  /** What the move does, highest weight first (attacks, defends, threatens, wins material…). */
  does: string[];
  /** Pins that exist after the move but not before. */
  newPins: string[];
  /** The mover's pieces hanging after the move that weren't before. */
  leavesHanging: string[];
  /** Opponent pieces that were hanging before the move and still are after it (free material left). */
  ignoresHanging: string[];
}

/** Board facts for `uci` played in `fen` (with the engine line after it, for material claims). */
export function moveBoardFacts(fen: string, uci: string, pv?: string[]): MoveBoardFacts | undefined {
  const c = new Chess(fen);
  const me = c.turn() as Color;
  let san: string;
  try {
    san = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' }).san;
  } catch {
    return undefined;
  }
  const after = c.fen();
  const captured = pieceAt(fen, uci.slice(2, 4));
  const moved = pieceAt(fen, uci.slice(0, 2))!;
  // A capturing piece that can be taken back is an exchange, not a piece left hanging.
  const fairTrade = !!captured && PIECE_VALUE[captured.type] >= PIECE_VALUE[moved.type];
  const d = describeMove({ fen, uci, pv: pv ?? [uci] });
  const pinsBefore = new Set(pinsBy(fen, me));
  const mineBefore = new Set(hangingPieces(fen, me).map((h) => h.square));
  const theirsAfter = new Set(hangingPieces(after, other(me)).map((h) => h.square));
  return {
    move: san,
    does: (d?.purposes ?? []).sort((a, b) => b.weight - a.weight).slice(0, 4).map((p) => `${san} ${p.text}`),
    newPins: pinsBy(after, me).filter((p) => !pinsBefore.has(p)),
    leavesHanging: hangingPieces(after, me)
      .filter((h) => !mineBefore.has(h.square) && !(fairTrade && h.square === uci.slice(2, 4)))
      .map((h) => `after ${san}, ${h.text}`),
    ignoresHanging: hangingPieces(fen, other(me)).filter((h) => theirsAfter.has(h.square)).map((h) => `before ${san}, ${h.text} — and it still is`),
  };
}
