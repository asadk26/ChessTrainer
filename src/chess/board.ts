import { Chess, type Square } from 'chess.js';
import type { Color, PieceType, SequenceFrame } from '../domain/types';

export const PIECE_VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAME: Record<PieceType, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};
export const COLOR_NAME: Record<Color, string> = { w: 'White', b: 'Black' };

export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');

export function sideToMove(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** Material balance in pawns from `pov`'s point of view. */
export function materialBalance(fen: string, pov: Color): number {
  const placement = fen.split(' ')[0];
  let w = 0;
  let b = 0;
  for (const ch of placement) {
    const lower = ch.toLowerCase() as PieceType;
    if (!(lower in PIECE_VALUE)) continue;
    if (ch === lower) b += PIECE_VALUE[lower];
    else w += PIECE_VALUE[lower];
  }
  return pov === 'w' ? w - b : b - w;
}

/** Total non-pawn, non-king material on the board (both sides). */
export function nonPawnMaterial(fen: string): number {
  let total = 0;
  for (const ch of fen.split(' ')[0]) {
    const lower = ch.toLowerCase();
    if (lower === 'n' || lower === 'b' || lower === 'r' || lower === 'q') total += PIECE_VALUE[lower as PieceType];
  }
  return total;
}

export function pieceAt(fen: string, square: string): { type: PieceType; color: Color } | undefined {
  const c = new Chess(fen);
  const p = c.get(square as Square);
  return p ? { type: p.type as PieceType, color: p.color } : undefined;
}

/** Squares of `byColor` pieces that attack `square`. */
export function attackersOf(fen: string, square: string, byColor: Color): string[] {
  return new Chess(fen).attackers(square as Square, byColor);
}

/**
 * A piece is "loose" if it's attacked and either undefended, or attacked by
 * something cheaper. This is a deliberately simple, explainable test.
 */
export function isLoose(fen: string, square: string): boolean {
  const piece = pieceAt(fen, square);
  if (!piece || piece.type === 'k') return false;
  const attackers = attackersOf(fen, square, other(piece.color));
  if (attackers.length === 0) return false;
  const defenders = attackersOf(fen, square, piece.color);
  if (defenders.length === 0) return true;
  const cheapest = Math.min(...attackers.map((s) => PIECE_VALUE[pieceAt(fen, s)!.type] || 100));
  return cheapest < PIECE_VALUE[piece.type];
}

/** Squares the piece on `square` attacks (pseudo-legal, ignoring pins), regardless of turn. */
export function attackedSquares(fen: string, square: string): string[] {
  const piece = pieceAt(fen, square);
  if (!piece) return [];
  const out: string[] = [];
  const c = new Chess(fen);
  for (const file of 'abcdefgh') {
    for (let rank = 1; rank <= 8; rank++) {
      const sq = `${file}${rank}`;
      if (sq === square) continue;
      if (c.attackers(sq as Square, piece.color).includes(square as Square)) out.push(sq);
    }
  }
  return out;
}

/** Enemy pieces (excluding king) attacked by the piece on `square`. */
export function attackedEnemyPieces(fen: string, square: string): { square: string; type: PieceType }[] {
  const piece = pieceAt(fen, square);
  if (!piece) return [];
  const c = new Chess(fen);
  return attackedSquares(fen, square)
    .map((sq) => ({ sq, p: c.get(sq as Square) }))
    .filter(({ p }) => p && p.color !== piece.color && p.type !== 'k')
    .map(({ sq, p }) => ({ square: sq, type: p!.type as PieceType }));
}

const HOME_MINORS: Record<Color, { square: string; type: PieceType }[]> = {
  w: [
    { square: 'b1', type: 'n' },
    { square: 'g1', type: 'n' },
    { square: 'c1', type: 'b' },
    { square: 'f1', type: 'b' },
  ],
  b: [
    { square: 'b8', type: 'n' },
    { square: 'g8', type: 'n' },
    { square: 'c8', type: 'b' },
    { square: 'f8', type: 'b' },
  ],
};

/** Minor pieces still sitting on their starting squares. */
export function undevelopedMinors(fen: string, color: Color): string[] {
  const c = new Chess(fen);
  return HOME_MINORS[color]
    .filter(({ square, type }) => {
      const p = c.get(square as Square);
      return p && p.color === color && p.type === type;
    })
    .map(({ square, type }) => `${type.toUpperCase()}${square}`);
}

export function kingSquare(fen: string, color: Color): string {
  const c = new Chess(fen);
  for (const row of c.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return '';
}

/** King is still on its original square (has not castled or walked). */
export function kingInCenter(fen: string, color: Color): boolean {
  const sq = kingSquare(fen, color);
  return sq === (color === 'w' ? 'e1' : 'e8') || sq === (color === 'w' ? 'd1' : 'd8');
}

export function hasCastled(fen: string, color: Color): boolean {
  const sq = kingSquare(fen, color);
  const home = color === 'w' ? '1' : '8';
  return (sq === `g${home}` || sq === `c${home}` || sq === `b${home}` || sq === `h${home}`) && !fen.split(' ')[2].includes(color === 'w' ? 'K' : 'k');
}

export function isLegal(fen: string, uci: string): boolean {
  try {
    const c = new Chess(fen);
    return !!c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
  } catch {
    return false;
  }
}

export function uciToSan(fen: string, uci: string): string | undefined {
  try {
    const c = new Chess(fen);
    return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' }).san;
  } catch {
    return undefined;
  }
}

/** Play a list of UCI moves, returning one frame per move (stops at the first illegal one). */
export function playLine(fen: string, ucis: string[], max = ucis.length): SequenceFrame[] {
  const c = new Chess(fen);
  const out: SequenceFrame[] = [];
  for (const uci of ucis.slice(0, max)) {
    try {
      const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
      out.push({ fen: c.fen(), san: mv.san, from: mv.from, to: mv.to, caption: '' });
    } catch {
      break;
    }
  }
  return out;
}

export function lineToSan(fen: string, ucis: string[], max = ucis.length): string[] {
  return playLine(fen, ucis, max).map((f) => f.san);
}

/**
 * Material balance (pov) after playing a line for up to `maxPlies`, measured at
 * a "settled" point: we stop after a non-capture move once at least
 * `minPlies` have been played, so we don't stop mid-exchange.
 */
export function materialAfterLine(fen: string, ucis: string[], pov: Color, maxPlies = 6, minPlies = 2): number {
  const c = new Chess(fen);
  let value = materialBalance(fen, pov);
  for (let i = 0; i < Math.min(maxPlies, ucis.length); i++) {
    const uci = ucis[i];
    try {
      c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
    } catch {
      break;
    }
    value = materialBalance(c.fen(), pov);
    // Peek: once the next move in the line is not a capture, the exchange has settled.
    if (i + 1 >= minPlies) {
      const next = ucis[i + 1];
      if (!next || !c.get(next.slice(2, 4) as Square)) break;
    }
  }
  return value;
}

export function isCheckMove(san: string): boolean {
  return san.includes('+') || san.includes('#');
}

export function squareName(type: PieceType, square: string): string {
  return type === 'p' ? `pawn on ${square}` : `${PIECE_NAME[type]} on ${square}`;
}

export function pieceLetter(type: PieceType): string {
  return type === 'p' ? '' : type.toUpperCase();
}
