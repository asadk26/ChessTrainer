// Which tactical pattern decided a move? Deterministic, from the board and Stockfish's lines:
// the refutation (the move played followed by the opponent's best reply line) and the better
// line. Each tag comes with the evidence it was found on, so it can be shown and checked.
// Saved on every mistake/blunder so patterns can be counted across games.
import { Chess, type Move, type Square } from 'chess.js';
import type { Color, PieceType } from '../domain/types';
import { PIECE_NAME, PIECE_VALUE, attackedEnemyPieces, attackersOf, isLoose, kingSquare, materialBalance, other, pieceAt, underThreat } from '../chess/board';
import { hangingPieces, pinsBy } from './boardFacts';

export type PatternTag = 'in_between_move' | 'knight_fork' | 'fork' | 'hanging_piece' | 'pin' | 'discovered_attack' | 'trapped_piece' | 'opened_line' | 'back_rank' | 'removed_defender' | 'unblocked_queen' | 'pawn_fork' | 'bigger_capture';

export const PATTERN_LABEL: Record<PatternTag, string> = {
  in_between_move: 'In-between move',
  knight_fork: 'Knight fork',
  fork: 'Fork',
  hanging_piece: 'Hanging piece',
  pin: 'Pin',
  discovered_attack: 'Discovered attack',
  trapped_piece: 'Trapped piece',
  opened_line: 'Line opened toward your king',
  back_rank: 'Back-rank attack',
  removed_defender: 'Removed defender',
  unblocked_queen: 'Line opened to your queen',
  pawn_fork: 'Pawn fork',
  bigger_capture: 'Bigger capture',
};

/** One reusable rule per pattern. */
export const PATTERN_RULE: Record<PatternTag, string> = {
  in_between_move: 'Before recapturing automatically, check for a stronger in-between move — a check or a bigger threat first.',
  knight_fork: 'Look at every square a knight can jump to: one that hits two valuable pieces (or king and piece) wins material.',
  fork: 'Look at every check and attack your opponent has next: one move that hits two things — often a check plus a loose piece — wins one of them.',
  hanging_piece: 'Before every move, ask: which pieces — mine and theirs — are undefended right now?',
  pin: "A pinned piece can't really move: pile up on it, and never line your own pieces up in front of your king or queen.",
  discovered_attack: 'When a piece moves off a line, check what the piece behind it suddenly attacks.',
  trapped_piece: 'Before a piece goes deep, make sure it has a safe square to come back to.',
  opened_line: 'Opening a file or diagonal toward a king helps whoever has more pieces aimed down it.',
  back_rank: 'Give your king an escape square (a "luft") before your back rank can be hit.',
  removed_defender: 'Before you move a piece or pawn, ask what it was guarding — and whether that is still safe once it leaves.',
  unblocked_queen: 'If your queen sits on a line with an enemy bishop, rook or queen, check what blocks that line before you move the blocker.',
  pawn_fork: 'Before moving a piece, check whether an enemy pawn push could attack it and another piece at once.',
  bigger_capture: 'Before you capture, list every capture you have and take the one that wins the most.',
};

/** What happened, said from the player's side: what the opponent's reply did, or what the better move had. */
export const PATTERN_PHRASE: Record<PatternTag, { refutation: string; better: string }> = {
  in_between_move: { refutation: 'walked into an in-between move', better: 'missed an in-between move' },
  knight_fork: { refutation: 'walked into a knight fork', better: 'missed a knight fork' },
  fork: { refutation: 'walked into a fork', better: 'missed a fork' },
  hanging_piece: { refutation: 'left a piece hanging', better: 'missed a free piece' },
  pin: { refutation: 'walked into a pin', better: 'missed a pin' },
  discovered_attack: { refutation: 'walked into a discovered attack', better: 'missed a discovered attack' },
  trapped_piece: { refutation: 'let a piece get trapped', better: 'missed a chance to trap a piece' },
  opened_line: { refutation: 'opened a line toward your king', better: 'missed a chance to open their king' },
  back_rank: { refutation: 'walked into a back-rank attack', better: 'missed a back-rank attack' },
  removed_defender: { refutation: 'took the guard away from one of your pieces', better: 'missed a chance to remove a defender' },
  unblocked_queen: { refutation: 'opened the line to your queen', better: 'missed a line opening onto their queen' },
  pawn_fork: { refutation: 'walked into a pawn fork', better: 'missed a pawn fork' },
  bigger_capture: { refutation: 'took the smaller prize', better: 'took the smaller prize' },
};

/** The rule for a tactic you missed (your own chance), where it differs from the defensive one. */
export const PATTERN_RULE_MISSED: Partial<Record<PatternTag, string>> = {
  pawn_fork: 'Look at every pawn push you have: one that attacks two pieces at once wins one of them.',
  hanging_piece: 'After every move, trace your queen’s, rooks’ and bishops’ lines to the end: a piece sitting undefended at the far end is free.',
  knight_fork: 'Look at every square your knights can jump to: one that hits two valuable pieces (or king and piece) wins material.',
  fork: 'Look at every check and attack you have: one move that hits two things — often a check plus a loose piece — wins one of them.',
  pin: 'When an enemy piece stands in front of their king or queen, pin it — then pile up on it.',
  discovered_attack: 'When one of your pieces stands in front of your bishop, rook or queen, ask what moving it with a threat would uncover.',
  trapped_piece: 'When an enemy piece has gone deep, count its escape squares — if you can cover them all, it’s yours.',
  opened_line: 'Open files and diagonals toward their king when your pieces are ready to use them.',
  back_rank: 'When their king has no escape square, look for a rook or queen check on the back rank.',
};

/** Said after the pawn-fork rule when the forked piece had just gone to the edge. */
export const RIM_NOTE = 'A piece on the rim has few escape squares, so it can’t easily step out of a fork.';

/** The rule for a tactic, with the rim note for a pawn fork on a piece that went to the edge. */
export function patternLesson(tag: PatternTag, side: 'refutation' | 'better', rimPiece = false): string {
  const rule = (side === 'better' && PATTERN_RULE_MISSED[tag]) || PATTERN_RULE[tag];
  return tag === 'pawn_fork' && side === 'refutation' && rimPiece ? `${rule} ${RIM_NOTE}` : rule;
}

/** The move put a knight or bishop on the edge, and the tactic's evidence names that square. */
export const forkedOnRim = (played: { piece: string; to: string }, evidence: string) => ['n', 'b'].includes(played.piece) && /^[ah]/.test(played.to) && evidence.includes(played.to);

export interface PatternHit {
  tag: PatternTag;
  /** Where it was found: what went wrong after the move played, or what the better line had. */
  side: 'refutation' | 'better';
  evidence: string;
  /** Ply index within the line (0 = first move of the line). */
  at: number;
  /**
   * For a hanging piece lost after your move: the piece you moved landed where it could be taken,
   * your move left another piece unprotected, or it was already under attack and stayed there.
   */
  hanging?: 'moved' | 'left' | 'already';
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

/** Any other piece hitting two things at once — a queen check that also hits a loose piece, a pawn fork. */
function fork(fs: Frame[]): PatternHit | undefined {
  for (let i = 0; i < Math.min(fs.length, 4); i++) {
    const { move, after } = fs[i];
    if (move.piece === 'n') continue;
    const me = move.color as Color;
    // Only targets it can really win: the king (check), or a piece that is loose or worth more than the attacker.
    const targets = [
      ...(move.san.includes('+') ? [{ type: 'k' as PieceType, square: kingSquare(after, other(me)) }] : []),
      ...attackedEnemyPieces(after, move.to).filter((t) => t.type !== 'k' && PIECE_VALUE[t.type] >= 3 && (isLoose(after, t.square) || PIECE_VALUE[t.type] > PIECE_VALUE[move.piece as PieceType])),
    ];
    if (targets.length < 2) continue;
    // The forking piece must survive long enough to collect: one of the targets is taken later in the line.
    const collected = fs.slice(i + 1).some((f) => f.move.color === me && targets.some((t) => t.type !== 'k' && t.square === f.move.to));
    const hit = `${move.san} attacks the ${targets.slice(0, 2).map((t) => (t.type === 'k' ? 'king' : sq(t.type, t.square))).join(' and the ')} at once`;
    // A pawn hitting two pieces worth more than itself wins one of them, even when the other gets a
    // desperado capture in first and the material count evens out inside the line.
    if (move.piece === 'p' && collected) return { tag: 'pawn_fork', side: 'refutation', at: i, evidence: hit };
    if (collected && gainAfter(fs, i, me) >= 2) return { tag: 'fork', side: 'refutation', at: i, evidence: hit };
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
        if (fresh.length && (move.san.includes('+') || gainAfter(fs, i, me) >= 2)) {
          // Usually the moving piece makes its own threat at the same time: that's what makes it work.
          const own = attackedEnemyPieces(after, move.to).filter((t) => t.type === 'q' || t.type === 'r' || PIECE_VALUE[t.type] > PIECE_VALUE[move.piece as PieceType]);
          const hits = own.length ? `attacks the ${sq(own[0].type, own[0].square)} and ` : '';
          return { tag: 'discovered_attack', side: 'refutation', at: i, evidence: `${move.san} ${hits}uncovers the ${PIECE_NAME[p.type as PieceType]} on ${p.square}, which now attacks the ${fresh[0].type === 'k' ? 'king' : sq(fresh[0].type, fresh[0].square)}` };
        }
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
    const fd = k.charCodeAt(0) - move.to.charCodeAt(0);
    const rd = Number(k[1]) - Number(move.to[1]);
    // A discovered check comes from another piece: the one that moved isn't on a line with the king.
    if (fd !== 0 && rd !== 0 && Math.abs(fd) !== Math.abs(rd)) continue;
    const df = Math.sign(fd);
    const dr = Math.sign(rd);
    for (let f = move.to.charCodeAt(0) + df, r = Number(move.to[1]) + dr; `${String.fromCharCode(f)}${r}` !== k; f += df, r += dr) {
      const s = `${String.fromCharCode(f)}${r}`;
      if (pieceAt(start, s)?.type === 'p') return { tag: 'opened_line', side: 'refutation', at: i, evidence: `the pawn that stood on ${s} is gone, so ${move.san} reaches the king` };
    }
  }
}

/**
 * The move uncovered a line to your own queen: an enemy bishop, rook or queen attacks it now and
 * didn't before (the square you left was the only change, so that unit was the blocker), and the
 * opponent's line takes the queen.
 */
function unblockedQueen(fenBefore: string, fs: Frame[], mover: Color): PatternHit | undefined {
  const played = fs[0]?.move;
  if (!played || played.color !== mover || played.piece === 'q' || fs.length < 2) return;
  const opp = other(mover);
  const after = fs[0].after;
  for (const row of new Chess(after).board())
    for (const u of row) {
      if (!u || u.color !== mover || u.type !== 'q') continue;
      const was = attackersOf(fenBefore, u.square, opp);
      const fresh = attackersOf(after, u.square, opp).filter((s) => !was.includes(s) && ['b', 'r', 'q'].includes(pieceAt(after, s)!.type));
      if (!fresh.length) continue;
      const taken = fs.slice(1).some((f) => f.move.color === opp && f.move.to === u.square);
      const net = materialBalance(fs[fs.length - 1].after, mover) - materialBalance(fenBefore, mover);
      if (!taken || net > -2) continue;
      const slider = pieceAt(after, fresh[0])!;
      const what = played.piece === 'p' ? 'pawn' : PIECE_NAME[played.piece as PieceType];
      return {
        tag: 'unblocked_queen',
        side: 'refutation',
        at: 1,
        evidence: `the ${what} on ${played.from} was blocking the ${PIECE_NAME[slider.type as PieceType]} on ${fresh[0]} from your queen on ${u.square}, and ${played.san} moved it`,
      };
    }
}

/**
 * The move took away the guard of another unit: the piece or pawn that moved defended it, no longer
 * does, and without it the unit can be taken for free — which the reply does, at a real cost.
 */
function removedDefender(fenBefore: string, fs: Frame[], mover: Color): PatternHit | undefined {
  const played = fs[0]?.move;
  const reply = fs[1]?.move;
  // A capture that abandons a guard is a grab (greedy queen raids…): that's the lesson, not the guard.
  if (!played || played.captured || !reply?.captured || reply.to === played.to || fs[0].move.color !== mover) return;
  const x = reply.to;
  const unit = pieceAt(fenBefore, x);
  if (!unit || unit.color !== mover || unit.type === 'k') return;
  const opp = other(mover);
  const guards = attackersOf(fenBefore, x, mover);
  if (!guards.includes(played.from as never) || attackersOf(fs[0].after, x, mover).includes(played.to as never)) return;
  const free = (fen: string) => isLoose(fen, x) || attackersOf(fen, x, opp).length > attackersOf(fen, x, mover).length;
  if (free(fenBefore) || !free(fs[0].after)) return;
  const net = materialBalance(fs[fs.length - 1].after, mover) - materialBalance(fenBefore, mover);
  if (net > -(unit.type === 'p' ? 1 : 2)) return;
  const what = played.piece === 'p' ? 'pawn' : PIECE_NAME[played.piece as PieceType];
  return {
    tag: 'removed_defender',
    side: 'refutation',
    at: 1,
    evidence: `the ${what} on ${played.from} was ${guards.length === 1 ? 'the only guard of' : 'needed to guard'} the ${sq(unit.type as PieceType, x)}; after ${played.san}, ${reply.san} took it`,
  };
}

const DETECTORS = [backRank, knightFork, discovered, fork, pin, inBetween, trapped, openedLine];

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
  const unblocked = unblockedQueen(fenBefore, refutation, mover);
  if (unblocked) return unblocked;
  const guard = removedDefender(fenBefore, refutation, mover);
  if (guard) return guard;
  if (categories.includes('stranded_piece')) return { tag: 'trapped_piece', side: 'refutation', at: 0, evidence: 'the piece that went in had no way back' };
  // Hanging: the reply simply takes something, and it costs real material (not a trade).
  const reply = refutation[1]?.move;
  const afterPlayed = refutation[0]?.after;
  const net = (fs: Frame[], pov: Color) => (fs.length ? materialBalance(fs[fs.length - 1].after, pov) - materialBalance(fenBefore, pov) : 0);
  const lostEnough = (t: PieceType, n: number) => n <= -(t === 'p' ? 1 : 2);
  if (reply?.captured && afterPlayed && lostEnough(reply.captured as PieceType, net(refutation, mover))) {
    const victim = sq(reply.captured as PieceType, reply.to);
    const loose = isLoose(afterPlayed, reply.to);
    const how = attackersOf(afterPlayed, reply.to, mover).length === 0 ? 'undefended' : loose ? 'attacked by something cheaper' : 'short of defenders';
    // "Hanging" means it could be taken for free: undefended, attacked by something cheaper, or (a piece)
    // simply outnumbered. A pawn pushed into an outnumbered square is a break that failed, not a loose
    // pawn; and a piece lost to a longer line isn't hanging, whatever the category says.
    const outnumbered = reply.captured !== 'p' && attackersOf(afterPlayed, reply.to, opp).length > attackersOf(afterPlayed, reply.to, mover).length;
    if (!loose && !outnumbered) {
      // falls through to the missed-capture check below
    } else if (reply.to === refutation[0].move.to) {
      return { tag: 'hanging_piece', side: 'refutation', at: 1, hanging: 'moved', evidence: `the ${victim} was ${how} after your move, and ${reply.san} took it` };
    } else if (pieceAt(fenBefore, reply.to)?.color === mover && underThreat(fenBefore, reply.to)) {
      return { tag: 'hanging_piece', side: 'refutation', at: 1, hanging: 'already', evidence: `the ${victim} was already under attack, your move didn't save it, and ${reply.san} took it` };
    } else {
      return { tag: 'hanging_piece', side: 'refutation', at: 1, hanging: 'left', evidence: `your move left the ${victim} ${how}, and ${reply.san} took it` };
    }
  }
  const best = better[0]?.move;
  if (best?.captured && hangingPieces(fenBefore, other(mover)).some((h) => h.square === best.to) && net(better, mover) >= (best.captured === 'p' ? 1 : 2)) {
    // You did capture — just the smaller prize.
    const took = refutation[0]?.move.captured as PieceType | undefined;
    if (took && PIECE_VALUE[best.captured as PieceType] > PIECE_VALUE[took])
      return { tag: 'bigger_capture', side: 'better', at: 0, evidence: `you took the ${sq(took, refutation[0].move.to)}, but ${best.san} won the ${sq(best.captured as PieceType, best.to)}, which was undefended` };
    const line = lineName(best.from, best.to, best.piece as PieceType);
    const how = line ? `your ${PIECE_NAME[best.piece as PieceType]} on ${best.from} could take it ${line} (${best.san})` : `${best.san} takes it for free`;
    return { tag: 'hanging_piece', side: 'better', at: 0, evidence: `the ${sq(best.captured as PieceType, best.to)} was undefended — ${how}` };
  }
  return undefined;
}

/** "along the 4th rank" — for a long-range piece taking from two or more squares away. */
function lineName(from: string, to: string, piece: PieceType): string | undefined {
  if (!['q', 'r', 'b'].includes(piece)) return;
  const df = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
  const dr = Math.abs(Number(from[1]) - Number(to[1]));
  if (Math.max(df, dr) < 2) return;
  const nth = (n: string) => `${n}${n === '1' ? 'st' : n === '2' ? 'nd' : n === '3' ? 'rd' : 'th'}`;
  return dr === 0 ? `along the ${nth(to[1])} rank` : df === 0 ? `down the ${to[0]}-file` : 'along the diagonal';
}

/** Next-game focus for each pattern, when a pattern decided the game. */
export const PATTERN_FOCUS: Record<PatternTag, { title: string; detail: string }> = {
  discovered_attack: {
    title: "Before you capture, ask what your opponent's reply can uncover.",
    detail:
      "A discovered attack is two threats in one move: a piece steps off a line with its own threat, and the piece behind it suddenly attacks something too. Before grabbing material, look for enemy pieces lined up behind one of their own pieces — and ask what happens if the front one moves with a threat.",
  },
  fork: { title: 'Before every move, look at the checks your opponent will have next.', detail: 'Most forks at this level are a queen (or bishop, rook or pawn) attacking two things at once — very often a check that also hits a loose piece. Before you move, list your opponent’s checks and ask whether any of them also attacks something undefended.' },
  knight_fork: { title: 'Check the squares their knights can jump to before you move.', detail: 'A knight on the right square attacks two pieces at once — often king and queen, or king and rook. Before every move, look at each enemy knight and the squares it can reach next.' },
  pin: { title: "Don't line your pieces up in front of your king or queen.", detail: 'A pinned piece can be attacked again and again because it can’t move away. Before putting a piece on a line with your king or queen behind it, check whether a bishop, rook or queen can pin it.' },
  in_between_move: { title: 'Before you recapture, look for a stronger in-between move.', detail: 'An in-between move — a check or a bigger threat played before the expected recapture — can change the whole exchange. Check for one, for both sides, whenever pieces are being traded.' },
  trapped_piece: { title: 'Before a piece goes deep, make sure it can get back.', detail: 'A piece that grabs material near the edge or in the enemy camp can run out of squares. Count its escape squares after the capture before you play it.' },
  opened_line: { title: 'Think twice before opening lines toward your own king.', detail: 'A pawn move or exchange that opens a file or diagonal toward your king lets enemy rooks, bishops and queens straight in. Open lines toward the king only when your pieces are ready to use them first.' },
  back_rank: { title: 'Give your king an escape square before the back rank gets busy.', detail: 'When your king sits behind its own pawns with no way out, any rook or queen check on the back rank can be mate. A quiet pawn move (h3 or g3) early on removes the danger.' },
  bigger_capture: { title: 'Before you capture, compare all your captures.', detail: 'When you can take something, there is often more than one capture on the board. List them all and take the one that wins the most — the first one you see is not always the best.' },
  pawn_fork: { title: 'Watch the pawn pushes that could hit two of your pieces.', detail: 'A pawn is the cheapest attacker on the board: when it attacks two pieces at once, one of them is lost. Before you put a piece on a square an enemy pawn could attack next to another one — and before a retreat to the edge — check every push and capture their pawns have.' },
  unblocked_queen: { title: 'Before you move a blocker, check the line it was blocking.', detail: 'When your queen sits on the same file, rank or diagonal as an enemy bishop, rook or queen, the piece or pawn in between is all that keeps it safe. Before you move that blocker — even to capture something — check what it uncovers.' },
  removed_defender: { title: 'Before you move a piece, ask what it was guarding.', detail: 'Every piece and pawn may be the only thing protecting something else. Before you move one, look at what it defends right now — if that piece or pawn would be left loose, keep the guard or protect it another way first.' },
  hanging_piece: { title: 'Before you let go of a piece, check whether it can simply be taken.', detail: 'Do a two-second blunder check on every move: for the square you are moving to, and for the piece you are moving away from — what can now be captured for free?' },
};
