// Cheap, deterministic position features for the Adaptive Coach. No engine calls: these only
// decide between moves Stockfish has already judged sound, and grade games already analysed.
import { Chess } from 'chess.js';
import type { Color, MoveEval, PlyRecord } from '../domain/types';
import { attackedEnemyPieces, hasQueen, nonPawnMaterial, other } from '../chess/board';
import { EQUAL_BAND } from '../analysis/moveQuality';
import { pd } from '../analysis/evaluation';

const CENTRAL = new Set(['c', 'd', 'e', 'f']);

function pawns(fen: string, color: Color): string[] {
  const out: string[] = [];
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else {
        if (ch === (color === 'w' ? 'P' : 'p')) out.push(`${'abcdefgh'[f]}${8 - r}`);
        f++;
      }
    }
  });
  return out;
}

/** Pawns (either side) that attack an enemy pawn: the tension a player can release or keep. */
export function pawnTension(fen: string): number {
  let n = 0;
  for (const color of ['w', 'b'] as const) {
    const enemy = new Set(pawns(fen, other(color)));
    const dir = color === 'w' ? 1 : -1;
    for (const sq of pawns(fen, color)) {
      const f = sq.charCodeAt(0);
      const r = Number(sq[1]) + dir;
      if ([f - 1, f + 1].some((x) => x >= 97 && x <= 104 && enemy.has(`${String.fromCharCode(x)}${r}`))) n++;
    }
  }
  return n;
}

/** Central pawns blocked head-on by an enemy pawn (a closed centre). */
export function lockedCentre(fen: string): number {
  const black = new Set(pawns(fen, 'b'));
  return pawns(fen, 'w').filter((sq) => CENTRAL.has(sq[0]) && black.has(`${sq[0]}${Number(sq[1]) + 1}`)).length;
}

export interface MoveFacts {
  san: string;
  piece: string;
  capture?: string;
  /** Captures back on the square the opponent just captured on. */
  recapture: boolean;
  check: boolean;
  fenAfter: string;
}

export function moveFacts(fen: string, uci: string, lastMoveTo?: string): MoveFacts | undefined {
  const c = new Chess(fen);
  try {
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
    return { san: m.san, piece: m.piece, capture: m.captured, recapture: !!m.captured && m.to === lastMoveTo, check: c.inCheck(), fenAfter: c.fen() };
  } catch {
    return undefined;
  }
}

/** The move hits an enemy pawn: it captures one, or the pawn now attacks one. */
export function isPawnBreak(p: Pick<PlyRecord, 'piece' | 'captured' | 'to' | 'fenAfter'>): boolean {
  if (p.piece !== 'p') return false;
  if (p.captured === 'p') return true;
  return attackedEnemyPieces(p.fenAfter, p.to).some((t) => t.type === 'p');
}

/**
 * A quiet, balanced middlegame decision for the mover: nothing is hanging or forced, the
 * evaluation is level, and Stockfish's own choice is a quiet move. This is where patience
 * (or the lack of it) shows.
 */
export function quietBalanced(p: PlyRecord, m: MoveEval, prev?: PlyRecord): boolean {
  return notQuietBecause(p, m, prev) === undefined;
}

export type NotQuiet = 'opening' | 'not_level' | 'simplified' | 'queens_off' | 'in_check' | 'recapture' | 'tactical';

/** Why a decision is NOT a quiet, level middlegame decision (undefined when it is). For evidence and tuning. */
export function notQuietBecause(p: PlyRecord, m: MoveEval, prev?: PlyRecord): NotQuiet | undefined {
  if (p.moveNumber < 9) return 'opening';
  if (Math.abs(m.cpBefore) > 150) return 'not_level';
  if (!hasQueen(p.fenBefore, 'w') || !hasQueen(p.fenBefore, 'b')) return 'queens_off';
  if (nonPawnMaterial(p.fenBefore) < 30) return 'simplified';
  if (new Chess(p.fenBefore).inCheck()) return 'in_check';
  if (prev?.captured) return 'recapture'; // a recapture may be pending
  if (!m.bestSan || /[x+#]/.test(m.bestSan)) return 'tactical';
  return undefined;
}

export type BreakKind = 'premature' | 'questionable' | 'sound' | 'fine';

export interface PawnBreak {
  ply: number;
  san: string;
  kind: BreakKind;
  drop: number;
  bestSan?: string;
}

/**
 * Pawn breaks the player made in quiet, balanced positions. Deliberately conservative: a break
 * only counts as premature when it cost a mistake's worth (≥ 8 win%) AND Stockfish wanted a piece
 * move instead (prepare first). Smaller costs are "questionable" and never count as a failure.
 */
export function pawnBreaks(plies: PlyRecord[], moves: MoveEval[], user: Color): PawnBreak[] {
  const out: PawnBreak[] = [];
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i];
    const m = moves[i];
    if (!m || p.color !== user || !isPawnBreak(p)) continue;
    const prev = plies[i - 1];
    if (prev?.captured && prev.to === p.to) continue; // just recapturing
    if (!quietBalanced(p, m, prev)) continue;
    const drop = pd(m);
    const enginePieceMove = !!m.bestSan && /^[NBRQK]|^O-O/.test(m.bestSan);
    const kind: BreakKind = drop >= 8 && enginePieceMove ? 'premature' : drop >= 4 ? 'questionable' : drop < EQUAL_BAND ? 'sound' : 'fine';
    out.push({ ply: p.ply, san: p.san, kind, drop, bestSan: m.bestSan });
  }
  return out;
}
