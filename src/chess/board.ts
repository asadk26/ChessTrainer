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

const FILES = 'abcdefgh';

/** The king's square plus its neighbours. */
export function kingZone(fen: string, color: Color): string[] {
  const k = kingSquare(fen, color);
  if (!k) return [];
  const f = FILES.indexOf(k[0]);
  const r = Number(k[1]);
  const out: string[] = [];
  for (let df = -1; df <= 1; df++)
    for (let dr = -1; dr <= 1; dr++) {
      const nf = f + df;
      const nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 1 && nr <= 8) out.push(`${FILES[nf]}${nr}`);
    }
  return out;
}

/** Number of (enemy piece, king-zone square) attack pairs — a rough "heat" around the king. */
export function kingZoneAttacks(fen: string, color: Color): number {
  const c = new Chess(fen);
  const enemy = other(color);
  return kingZone(fen, color).reduce((n, sq) => n + c.attackers(sq as Square, enemy).length, 0);
}

/** Own pawns directly in front of / diagonal to the king (max 3). */
export function pawnShield(fen: string, color: Color): number {
  const k = kingSquare(fen, color);
  if (!k) return 0;
  const c = new Chess(fen);
  const f = FILES.indexOf(k[0]);
  const r = Number(k[1]) + (color === 'w' ? 1 : -1);
  let n = 0;
  for (let df = -1; df <= 1; df++) {
    const nf = f + df;
    if (nf < 0 || nf > 7 || r < 1 || r > 8) continue;
    const p = c.get(`${FILES[nf]}${r}` as Square);
    if (p && p.type === 'p' && p.color === color) n++;
  }
  return n;
}

export function hasQueen(fen: string, color: Color): boolean {
  return fen.split(' ')[0].includes(color === 'w' ? 'Q' : 'q');
}

/** Passed pawns of `color`: no enemy pawn ahead on the same or adjacent files. Returns squares. */
export function passedPawns(fen: string, color: Color): string[] {
  const c = new Chess(fen);
  const pawns: { f: number; r: number; color: Color }[] = [];
  for (const row of c.board()) for (const p of row) if (p && p.type === 'p') pawns.push({ f: FILES.indexOf(p.square[0]), r: Number(p.square[1]), color: p.color });
  return pawns
    .filter((p) => p.color === color)
    .filter((p) => !pawns.some((q) => q.color !== color && Math.abs(q.f - p.f) <= 1 && (color === 'w' ? q.r > p.r : q.r < p.r)))
    .map((p) => `${FILES[p.f]}${p.r}`);
}

/** Rank from the pawn owner's point of view (1..8). */
export function relativeRank(square: string, color: Color): number {
  const r = Number(square[1]);
  return color === 'w' ? r : 9 - r;
}

/** "a rook and a pawn" for 6, "a piece" for 3 — how a coach talks about material. */
export function materialPhrase(n: number): string {
  let left = Math.round(n);
  const parts: string[] = [];
  for (const [v, name] of [[9, 'queen'], [5, 'rook'], [3, 'piece']] as const) {
    if (left >= v && parts.length === 0) {
      parts.push(`a ${name}`);
      left -= v;
    }
  }
  if (left > 0) parts.push(left === 1 ? 'a pawn' : `${left} pawns`);
  return parts.join(' and ') || 'nothing';
}

/** Squares a piece can reach or attack that aren't blocked by its own pieces — a simple activity measure. */
export function mobility(fen: string, square: string): number {
  const piece = pieceAt(fen, square);
  if (!piece) return 0;
  const c = new Chess(fen);
  return attackedSquares(fen, square).filter((sq) => {
    const p = c.get(sq as Square);
    return !p || p.color !== piece.color;
  }).length;
}

/** Doubled and isolated pawns of one side. */
export function pawnWeaknesses(fen: string, color: Color): { doubled: string[]; isolated: string[] } {
  const c = new Chess(fen);
  const files = new Map<number, string[]>();
  for (const row of c.board()) for (const p of row) if (p && p.type === 'p' && p.color === color) {
    const f = FILES.indexOf(p.square[0]);
    files.set(f, [...(files.get(f) ?? []), p.square]);
  }
  const doubled: string[] = [];
  const isolated: string[] = [];
  for (const [f, sqs] of files) {
    if (sqs.length > 1) doubled.push(...sqs);
    if (!files.has(f - 1) && !files.has(f + 1)) isolated.push(...sqs);
  }
  return { doubled, isolated };
}

export function structureScore(fen: string, color: Color): number {
  const w = pawnWeaknesses(fen, color);
  return new Set([...w.doubled, ...w.isolated]).size;
}

/** 'open' (no pawns), 'half-open' (no own pawns) or 'closed' for `color` on a file. */
export function fileStatus(fen: string, file: string, color: Color): 'open' | 'half-open' | 'closed' {
  const c = new Chess(fen);
  let own = 0;
  let theirs = 0;
  for (let r = 1; r <= 8; r++) {
    const p = c.get(`${file}${r}` as Square);
    if (p?.type === 'p') p.color === color ? own++ : theirs++;
  }
  return own === 0 && theirs === 0 ? 'open' : own === 0 ? 'half-open' : 'closed';
}

/** Number of checking moves available to the side to move. */
export function checksAvailable(fen: string): number {
  try {
    return new Chess(fen).moves().filter((m) => m.includes('+') || m.includes('#')).length;
  } catch {
    return 0;
  }
}

/** Own pieces (not king) that are loose — attacked and under-defended. */
export function loosePieces(fen: string, color: Color): { square: string; type: PieceType }[] {
  const c = new Chess(fen);
  const out: { square: string; type: PieceType }[] = [];
  for (const row of c.board()) for (const p of row) if (p && p.color === color && p.type !== 'k' && isLoose(fen, p.square)) out.push({ square: p.square, type: p.type as PieceType });
  return out;
}

/** A FEN with the side to move flipped (en-passant cleared) — to ask "what would they threaten?". */
export function passTurn(fen: string): string | undefined {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  const flipped = parts.join(' ');
  try {
    const c = new Chess(flipped);
    return c.inCheck() ? undefined : flipped;
  } catch {
    return undefined;
  }
}
