// Where a line makes its point. Instead of showing N engine moves, walk the line
// and stop at the first thing that actually settles: mate, a promotion, material
// changing hands (after any recapture), queens coming off, or a passed pawn
// getting dangerous. If nothing like that happens, it's a quiet line: show a few
// moves and say the difference is positional.
import type { Color, PieceType, SequenceFrame } from '../domain/types';
import { COLOR_NAME, PIECE_NAME, attackersOf, hasQueen, materialBalance, other, passedPawns, playLine, relativeRank } from '../chess/board';
import { Chess } from 'chess.js';

export type PointKind = 'mate' | 'promotion' | 'material' | 'queens' | 'passed' | 'quiet';

export interface LinePoint {
  frames: SequenceFrame[];
  kind: PointKind;
  /** Plain-English "what changed", from `pov`'s side ("you" / their colour). */
  text: string;
}

type Counts = Record<PieceType, number>;

function counts(fen: string, color: Color): Counts {
  const c: Counts = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
  for (const row of new Chess(fen).board()) for (const p of row) if (p && p.color === color) c[p.type as PieceType]++;
  return c;
}

const ORDER: PieceType[] = ['q', 'r', 'b', 'n', 'p'];

/** What each side lost between two positions, with like-for-like trades cancelled. */
export function netLoss(startFen: string, endFen: string, pov: Color): { ours: string[]; theirs: string[] } {
  const s0 = counts(startFen, pov);
  const s1 = counts(endFen, pov);
  const t0 = counts(startFen, other(pov));
  const t1 = counts(endFen, other(pov));
  const lo = {} as Counts;
  const lt = {} as Counts;
  for (const t of ORDER) {
    const a = Math.max(0, s0[t] - s1[t]);
    const b = Math.max(0, t0[t] - t1[t]);
    const m = Math.min(a, b);
    lo[t] = a - m;
    lt[t] = b - m;
  }
  for (const [x, y] of [['b', 'n'], ['n', 'b']] as [PieceType, PieceType][]) {
    const m = Math.min(lo[x], lt[y]);
    lo[x] -= m;
    lt[y] -= m;
  }
  const words = (c: Counts) => ORDER.flatMap((t) => (t === 'p' ? (c.p ? [c.p === 1 ? 'a pawn' : `${c.p} pawns`] : []) : Array.from({ length: c[t] }, () => `a ${PIECE_NAME[t]}`)));
  return { ours: words(lo), theirs: words(lt) };
}

const join = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const your = (s: string) => s.replace(/^a /, 'your ').replace(/^(\d+) pawns$/, '$1 of your pawns');

/** "you win a knight", "White wins your queen for a knight", "you give up a bishop for a pawn". */
export function materialText(startFen: string, endFen: string, pov: Color, youName = 'you'): string | undefined {
  const { ours, theirs } = netLoss(startFen, endFen, pov);
  const opp = COLOR_NAME[other(pov)];
  const mat = materialBalance(endFen, pov) - materialBalance(startFen, pov);
  if (!ours.length && !theirs.length) return undefined;
  if (mat > 0) return `${youName} win${youName === 'you' ? '' : 's'} ${join(theirs)}${ours.length ? ` for ${join(ours)}` : ''}`;
  if (mat < 0) return `${opp} wins ${join(ours.map(your))}${theirs.length ? ` for ${join(theirs)}` : ''}`;
  return `material stays level (${join(ours)} for ${join(theirs)})`;
}

const isCapture = (f?: SequenceFrame) => !!f && f.san.includes('x');
const isCheck = (f?: SequenceFrame) => !!f && /[+#]/.test(f.san);

/**
 * Walk `ucis` from `fen` and stop where the line's point is visible.
 * `pov` is the side we explain for ("you").
 */
export function lineToPoint(fen: string, ucis: string[], pov: Color, max = 10): LinePoint {
  const frames = playLine(fen, ucis, max);
  const startQueens = hasQueen(fen, 'w') && hasQueen(fen, 'b');
  const startPassed = new Set([...passedPawns(fen, 'w'), ...passedPawns(fen, 'b')]);
  const startMat = materialBalance(fen, pov);
  for (let k = 1; k <= frames.length; k++) {
    const f = frames[k - 1];
    const cut = frames.slice(0, k);
    const mover = f.fen.split(' ')[1] === 'w' ? 'b' : 'w'; // side that just moved
    if (f.san.includes('#')) return { frames: cut, kind: 'mate', text: mover === pov ? `${f.san} is checkmate` : `${COLOR_NAME[mover]} mates with ${f.san}` };
    if (f.san.includes('=')) return { frames: cut, kind: 'promotion', text: `${mover === pov ? 'you promote' : `${COLOR_NAME[mover]} promotes`} a pawn on ${f.to}` };
    // Material has changed hands once the exchange is over: the next move is neither a capture nor a check.
    const next = frames[k];
    // If the line just ends after a capture that can be answered, the exchange isn't over: nothing is settled.
    const toMove = f.fen.split(' ')[1] as Color;
    const unanswered = !next && isCapture(f) && attackersOf(f.fen, f.to, toMove).length > 0;
    const settled = next ? !isCapture(next) && !isCheck(next) : !unanswered;
    if (settled && Math.abs(materialBalance(f.fen, pov) - startMat) >= 1) {
      const text = materialText(fen, f.fen, pov);
      if (text) return { frames: cut, kind: 'material', text };
    }
    if (settled && startQueens && !hasQueen(f.fen, 'w') && !hasQueen(f.fen, 'b')) return { frames: cut, kind: 'queens', text: 'the queens come off' };
    for (const c of ['w', 'b'] as Color[]) {
      const sq = passedPawns(f.fen, c).find((s) => !startPassed.has(s) && relativeRank(s, c) >= 6);
      if (sq && settled) return { frames: cut, kind: 'passed', text: `${c === pov ? 'you get' : `${COLOR_NAME[c]} gets`} a dangerous passed pawn on ${sq}` };
    }
  }
  const n = Math.min(4, frames.length);
  return { frames: frames.slice(0, n), kind: 'quiet', text: 'no material changes hands — the difference is in the position' };
}
