// Which tactical pattern decided a move? Deterministic, from the board and Stockfish's lines:
// the refutation (the move played followed by the opponent's best reply line) and the better
// line. Each tag comes with the evidence it was found on, so it can be shown and checked.
// Saved on every mistake/blunder so patterns can be counted across games.
import { Chess, type Move, type Square } from 'chess.js';
import type { Color, PieceType } from '../domain/types';
import { PIECE_NAME, PIECE_VALUE, attackedEnemyPieces, attackersOf, kingSquare, materialBalance, other, pieceAt } from '../chess/board';
import { hangingPieces, pinsBy } from './boardFacts';

export type PatternTag = 'in_between_move' | 'knight_fork' | 'hanging_piece' | 'pin' | 'discovered_attack' | 'trapped_piece' | 'opened_line' | 'back_rank';

export const PATTERN_LABEL: Record<PatternTag, string> = {
  in_between_move: 'In-between move',
  knight_fork: 'Knight fork',
  hanging_piece: 'Hanging piece',
  pin: 'Pin',
  discovered_attack: 'Discovered attack',
  trapped_piece: 'Trapped piece',
  opened_line: 'Opened line',
  back_rank: 'Back rank',
};

/** One reusable rule per pattern. */
export const PATTERN_RULE: Record<PatternTag, string> = {
  in_between_move: 'Before recapturing automatically, check for a stronger in-between move — a check or a bigger threat first.',
  knight_fork: 'Look at every square a knight can jump to: one that hits two valuable pieces (or king and piece) wins material.',
  hanging_piece: 'Before every move, ask: which pieces — mine and theirs — are undefended right now?',
  pin: "A pinned piece can't really move: pile up on it, and never line your own pieces up in front of your king or queen.",
  discovered_attack: 'When a piece moves off a line, check what the piece behind it suddenly attacks.',
  trapped_piece: 'Before a piece goes deep, make sure it has a safe square to come back to.',
  opened_line: 'Opening a file or diagonal toward a king helps whoever has more pieces aimed down it.',
  back_rank: 'Give your king an escape square (a "luft") before your back rank can be hit.',
};

export interface PatternHit {
  tag: PatternTag;
  /** Where it was found: what went wrong after the move played, or what the better line had. */
  side: 'refutation' | 'better';
  evidence: string;
  /** Ply index within the line (0 = first move of the line). */
  at: number;
}

interface Frame {
  before: string;
  move: Move;
  after: string;
}

const sq = (t: PieceType, s: string) => (t === 'p' ? `pawn on ${s}` : `${PIECE_NAME[t]} on ${s}`);

function frames(fen: string, ucis: string[], max = 6): Frame[] {
  const c = new Chess(fen);
  const out: Frame[] = [];
  for (const uci of ucis.slice(0, max)) {
    const before = c.fen();
    try {
      const move = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
      out.push({ before, move, after: c.fen() });
    } catch {
      break;
    }
  }
  return out;
}

/** Material swing for `pov` from frame `from` to the end of the line (pawns). */
const gainAfter = (fs: Frame[], from: number, pov: Color) => (fs.length ? materialBalance(fs[fs.length - 1].after, pov) - materialBalance(fs[from].before, pov) : 0);

function backRank(fs: Frame[]): PatternHit | undefined {
  for (let i = 0; i < Math.min(fs.length, 5); i++) {
    const { move, after } = fs[i];
    if (!move.san.includes('+') && !move.san.includes('#')) continue;
    if (!['r', 'q'].includes(move.piece)) continue;
    const victim = other(move.color as Color);
    const k = kingSquare(after, victim);
    const home = victim === 'w' ? '1' : '8';
    if (k[1] !== home || move.to[1] !== home) continue;
    // The king's squares in front are blocked by its own pieces.
    const ahead = victim === 'w' ? '2' : '7';
    const files = [-1, 0, 1].map((d) => String.fromCharCode(k.charCodeAt(0) + d)).filter((f) => f >= 'a' && f <= 'h');
    const boxed = files.every((f) => pieceAt(after, `${f}${ahead}`)?.color === victim);
    if (boxed) return { tag: 'back_rank', side: 'refutation', at: i, evidence: `${move.san} hits the king on its back rank, boxed in by its own pawns` };
  }
}

function knightFork(fs: Frame[]): PatternHit | undefined {
  for (let i = 0; i < Math.min(fs.length, 4); i++) {
    const { move, after } = fs[i];
    if (move.piece !== 'n') continue;
    // The king doesn't show up as an "attacked piece": a check counts as hitting it.
    const targets = [
      ...(move.san.includes('+') ? [{ type: 'k' as PieceType, square: kingSquare(after, other(move.color as Color)) }] : []),
      ...attackedEnemyPieces(after, move.to).filter((t) => t.type !== 'k' && PIECE_VALUE[t.type] >= 3),
    ];
    const heavy = targets.filter((t) => t.type === 'k' || t.type === 'q' || t.type === 'r');
    if (targets.length >= 2 && heavy.length >= 1 && gainAfter(fs, i, move.color as Color) >= 2)
      return { tag: 'knight_fork', side: 'refutation', at: i, evidence: `${move.san} forks the ${targets.slice(0, 2).map((t) => (t.type === 'k' ? 'king' : sq(t.type, t.square))).join(' and the ')}` };
  }
}

function discovered(fs: Frame[]): PatternHit | undefined {
  for (let i = 0; i < Math.min(fs.length, 4); i++) {
    const { before, move, after } = fs[i];
    const me = move.color as Color;
    const c = new Chess(after);
    for (const row of c.board())
      for (const p of row) {
        if (!p || p.color !== me || !['b', 'r', 'q'].includes(p.type) || p.square === move.to) continue;
        const was = new Set(attackedEnemyPieces(before, p.square).map((t) => t.square));
        const fresh = attackedEnemyPieces(after, p.square).filter((t) => !was.has(t.square) && t.type !== 'k' && PIECE_VALUE[t.type] >= 3);
        // A discovered check: this piece, not the one that moved, now attacks the king.
        const k = kingSquare(after, other(me));
        if (attackersOf(after, k, me).includes(p.square as never) && !attackersOf(before, k, me).includes(p.square as never)) fresh.unshift({ square: k, type: 'k' });
        if (fresh.length && (move.san.includes('+') || gainAfter(fs, i, me) >= 2))
          return { tag: 'discovered_attack', side: 'refutation', at: i, evidence: `${move.san} uncovers the ${PIECE_NAME[p.type as PieceType]} on ${p.square}, which now attacks the ${fresh[0].type === 'k' ? 'king' : sq(fresh[0].type, fresh[0].square)}` };
      }
  }
}

function pin(fs: Frame[]): PatternHit | undefined {
  for (let i = 0; i < Math.min(fs.length, 4); i++) {
    const { before, move, after } = fs[i];
    const me = move.color as Color;
    const old = new Set(pinsBy(before, me));
    // A pin worth naming: on a piece (not a pawn), and the material comes after the pin, not from it.
    const fresh = pinsBy(after, me).filter((x) => !old.has(x) && !/pins the pawn/.test(x));
    if (fresh.length && i + 1 < fs.length && gainAfter(fs, i + 1, me) >= 2) return { tag: 'pin', side: 'refutation', at: i, evidence: `${move.san}: ${fresh[0]}` };
  }
}

function inBetween(fs: Frame[]): PatternHit | undefined {
  for (let i = 0; i + 2 < Math.min(fs.length, 6); i++) {
    const a = fs[i].move;
    const b = fs[i + 1].move;
    if (!a.captured || b.to === a.to) continue;
    const forcing = b.san.includes('+') || (b.captured && PIECE_VALUE[b.captured as PieceType] >= 3);
    const recapLater = fs.slice(i + 2, i + 5).some((f) => f.move.color === b.color && f.move.to === a.to);
    if (forcing && recapLater) return { tag: 'in_between_move', side: 'refutation', at: i + 1, evidence: `instead of taking back on ${a.to} at once, ${b.san} comes first` };
  }
}

function trapped(fs: Frame[]): PatternHit | undefined {
  for (let i = 0; i < Math.min(fs.length, 4); i++) {
    const { move, after } = fs[i];
    const me = move.color as Color;
    const opp = other(me);
    // In check, every piece is "stuck" — that's a double attack, not a trapped piece.
    if (move.san.includes('+') || move.san.includes('#')) continue;
    for (const t of attackedEnemyPieces(after, move.to)) {
      if (t.type === 'k' || t.type === 'p' || PIECE_VALUE[t.type] < 3) continue;
      const c = new Chess(after);
      if (c.turn() !== opp) continue;
      const escapes = c.moves({ square: t.square as Square, verbose: true }).filter((m) => attackersOf(m.after, m.to, me).length === 0 || PIECE_VALUE[(m.captured as PieceType) ?? 'p'] >= PIECE_VALUE[t.type]);
      const lost = fs.slice(i + 1).some((f) => f.move.color === me && f.move.to === t.square);
      if (!escapes.length && lost) return { tag: 'trapped_piece', side: 'refutation', at: i, evidence: `the ${sq(t.type, t.square)} has no safe square left after ${move.san}` };
    }
  }
}

function openedLine(fs: Frame[]): PatternHit | undefined {
  const start = fs[0]?.before;
  if (!start) return;
  for (let i = 1; i < Math.min(fs.length, 6); i++) {
    const { move, after } = fs[i];
    if (!move.san.includes('+') || !['b', 'r', 'q'].includes(move.piece)) continue;
    const k = kingSquare(after, other(move.color as Color));
    const df = Math.sign(k.charCodeAt(0) - move.to.charCodeAt(0));
    const dr = Math.sign(Number(k[1]) - Number(move.to[1]));
    for (let f = move.to.charCodeAt(0) + df, r = Number(move.to[1]) + dr; `${String.fromCharCode(f)}${r}` !== k; f += df, r += dr) {
      const s = `${String.fromCharCode(f)}${r}`;
      if (pieceAt(start, s)?.type === 'p') return { tag: 'opened_line', side: 'refutation', at: i, evidence: `the pawn that stood on ${s} is gone, so ${move.san} reaches the king` };
    }
  }
}

const DETECTORS = [backRank, knightFork, discovered, pin, inBetween, trapped, openedLine];

/**
 * The pattern behind a move: first in what punished it (the move played + the opponent's best
 * line), then in what the better line had. Hanging pieces are checked last (the most common and
 * least specific).
 */
export function detectPattern(fenBefore: string, playedUci: string, replyPv: string[], bestPv: string[], categories: string[] = []): PatternHit | undefined {
  const mover = new Chess(fenBefore).turn() as Color;
  const refutation = frames(fenBefore, [playedUci, ...replyPv]);
  const better = frames(fenBefore, bestPv);
  const opp = other(mover);
  for (const d of DETECTORS) {
    // The punishment must be the opponent's move; the missed idea must be yours.
    const r = refutation.length > 1 ? d(refutation.slice(1)) : undefined;
    if (r && refutation[r.at + 1]?.move.color === opp) return { ...r, at: r.at + 1 };
    const b = d(better);
    if (b && better[b.at]?.move.color === mover) return { ...b, side: 'better' };
  }
  if (categories.includes('stranded_piece')) return { tag: 'trapped_piece', side: 'refutation', at: 0, evidence: 'the piece that went in had no way back' };
  // Hanging: the reply takes something the move left undefended, or the better move took something free.
  const reply = refutation[1]?.move;
  const afterPlayed = refutation[0]?.after;
  if (reply?.captured && afterPlayed && hangingPieces(afterPlayed, mover).some((h) => h.square === reply.to))
    return { tag: 'hanging_piece', side: 'refutation', at: 1, evidence: `after your move, the ${sq(reply.captured as PieceType, reply.to)} was undefended and ${reply.san} took it` };
  const best = better[0]?.move;
  if (best?.captured && hangingPieces(fenBefore, other(mover)).some((h) => h.square === best.to))
    return { tag: 'hanging_piece', side: 'better', at: 0, evidence: `the ${sq(best.captured as PieceType, best.to)} was hanging — ${best.san} takes it for free` };
  if (categories.includes('blunder') || categories.includes('missed_threat')) {
    if (reply?.captured) return { tag: 'hanging_piece', side: 'refutation', at: 1, evidence: `${reply.san} wins the ${sq(reply.captured as PieceType, reply.to)}` };
  }
  return undefined;
}
