// Which tactical pattern decided a move? Deterministic, from the board and Stockfish's lines:
// the refutation (the move played followed by the opponent's best reply line) and the better
// line. Each tag comes with the evidence it was found on, so it can be shown and checked.
// Saved on every mistake/blunder so patterns can be counted across games.
import { Chess, type Move, type Square } from 'chess.js';
import type { Color, PieceType } from '../domain/types';
import { COLOR_NAME, PIECE_NAME, PIECE_VALUE, attackedEnemyPieces, attackersOf, exchangeGain, isLoose, kingSquare, materialBalance, other, pieceAt, underThreat } from '../chess/board';
import { hangingPieces, pinsBy } from './boardFacts';

export type PatternTag = 'in_between_move' | 'knight_fork' | 'fork' | 'hanging_piece' | 'pin' | 'discovered_attack' | 'trapped_piece' | 'opened_line' | 'back_rank' | 'removed_defender' | 'unblocked_queen' | 'pawn_fork' | 'bigger_capture' | 'skewer' | 'greedy_queen' | 'stuck_deep' | 'blocked_with_tempo' | 'incomplete_exchange';

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
  skewer: 'Skewer',
  greedy_queen: 'Queen raid',
  stuck_deep: 'Piece stuck deep',
  blocked_with_tempo: 'Check blocked with tempo',
  incomplete_exchange: 'Unfinished trade',
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
  skewer: 'Keep your king off the line your queen or rook stands on: a check along it wins the piece behind the king.',
  greedy_queen: 'Before grabbing material with your queen, look at your king without it: which checks does your opponent get?',
  stuck_deep: 'When your queen or a piece is deep in their camp, count its escape squares every move — bring it back before they close.',
  blocked_with_tempo: 'Before giving a check, look at how it can be blocked: a block that also attacks your checking piece wins time.',
  incomplete_exchange: 'Finish a trade before starting a new idea: after captures and checks, recount the material and take back.',
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
  skewer: { refutation: 'walked into a skewer', better: 'missed a skewer' },
  greedy_queen: { refutation: 'sent your queen away to grab material', better: 'missed a queen raid' },
  stuck_deep: { refutation: 'left a piece deep in their camp', better: 'missed a chance to trap a piece' },
  blocked_with_tempo: { refutation: 'gave a check that was blocked with tempo', better: 'missed a block with tempo' },
  incomplete_exchange: { refutation: 'left a trade unfinished', better: 'left a trade unfinished' },
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
  /** The piece the tactic is about (a trapped piece's square). */
  square?: string;
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
      // Lost where it stands, or where it runs to (its only flight square is covered too).
      let at = t.square;
      let lost = false;
      for (const f of fs.slice(i + 1)) {
        if (f.move.color === opp && f.move.from === at) at = f.move.to;
        else if (f.move.color === me && f.move.to === at) {
          lost = true;
          break;
        }
      }
      if (!escapes.length && lost) return { tag: 'trapped_piece', side: 'refutation', at: i, square: t.square, evidence: `the ${sq(t.type, t.square)} has no safe square left after ${move.san}` };
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

/** Squares strictly between two squares on one line (empty if they don't share one). */
function between(a: string, b: string): string[] {
  const fd = b.charCodeAt(0) - a.charCodeAt(0);
  const rd = Number(b[1]) - Number(a[1]);
  if (fd !== 0 && rd !== 0 && Math.abs(fd) !== Math.abs(rd)) return [];
  const out: string[] = [];
  for (let f = a.charCodeAt(0) + Math.sign(fd), r = Number(a[1]) + Math.sign(rd); `${String.fromCharCode(f)}${r}` !== b; f += Math.sign(fd), r += Math.sign(rd)) out.push(`${String.fromCharCode(f)}${r}`);
  return out;
}

/** Your check, answered by a block that also attacks the checking piece. */
function blockedWithTempo(fs: Frame[], mover: Color): PatternHit | undefined {
  const check = fs[0]?.move;
  const block = fs[1]?.move;
  if (!check || !block || check.color !== mover || !/\+/.test(check.san) || !['b', 'r', 'q'].includes(check.piece)) return;
  const k = kingSquare(fs[0].after, other(mover));
  if (block.piece === 'k' || !between(check.to, k).includes(block.to)) return;
  if (!attackersOf(fs[1].after, check.to, other(mover)).includes(block.to as never)) return;
  return {
    tag: 'blocked_with_tempo',
    side: 'refutation',
    at: 1,
    evidence: `${block.san} blocks the check and attacks your ${PIECE_NAME[check.piece as PieceType]} on ${check.to}, so it has to move again`,
  };
}

const relativeRank = (square: string, color: Color) => (color === 'w' ? Number(square[1]) : 9 - Number(square[1]));
const distance = (a: string, b: string) => Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])));

/**
 * A piece left deep in the opponent's camp (not the one just moved): their reply attacks it, it has
 * three safe squares or fewer, and the line wins it wherever it runs.
 */
function stuckDeep(fenBefore: string, fs: Frame[], mover: Color): PatternHit | undefined {
  const played = fs[0]?.move;
  const hit = fs[1];
  if (!played || !hit || played.color !== mover) return;
  const opp = other(mover);
  for (const t of attackedEnemyPieces(hit.after, hit.move.to)) {
    if (t.type === 'k' || PIECE_VALUE[t.type] < 3 || t.square === played.to || relativeRank(t.square, mover) < 6) continue;
    const c = new Chess(hit.after);
    if (c.turn() !== mover) continue;
    const safe = c.moves({ square: t.square as Square, verbose: true }).filter((m) => attackersOf(m.after, m.to, opp).length === 0);
    if (safe.length > 3) continue;
    let at = t.square;
    let lost = -1;
    for (let k = 2; k < fs.length; k++) {
      const f = fs[k];
      if (f.move.color === mover && f.move.from === at) at = f.move.to;
      else if (f.move.color === opp && f.move.to === at) {
        lost = k;
        break;
      }
    }
    const net = materialBalance(fs[fs.length - 1].after, mover) - materialBalance(fenBefore, mover);
    if (lost < 0 || net > -2) continue;
    const squares = safe.length === 0 ? 'no safe squares' : safe.length === 1 ? 'one safe square' : `only ${safe.length} safe squares`;
    const how = safe.length === 0 ? "it couldn't get out" : `the best line still wins it (${fs.slice(2, lost + 1).map((f) => f.move.san).join(' ')})`;
    return { tag: 'stuck_deep', side: 'refutation', at: 1, square: t.square, evidence: `your ${PIECE_NAME[t.type]} on ${t.square} was deep in their camp with ${squares}; after ${hit.move.san}, ${how}` };
  }
}

/**
 * The queen went far from its own king to grab material, and the opponent's line starts with checks
 * against that king within two moves.
 */
function greedyQueen(fenBefore: string, fs: Frame[], mover: Color): PatternHit | undefined {
  const played = fs[0]?.move;
  if (!played || played.color !== mover || played.piece !== 'q' || !played.captured) return;
  const k = kingSquare(fenBefore, mover);
  if (distance(played.to, k) < 4 || distance(played.to, k) <= distance(played.from, k)) return;
  const check = fs.slice(1, 4).find((f) => f.move.color !== mover && /[+#]/.test(f.move.san));
  if (!check) return;
  return {
    tag: 'greedy_queen',
    side: 'refutation',
    at: 1,
    evidence: `${played.san} took the ${sq(played.captured as PieceType, played.to)} far from your king, and ${check.move.san} started on it`,
  };
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
  // Free = the exchange on that square wins material for them (cheapest attacker first, either side may stop).
  const free = (fen: string) => exchangeGain(fen, x, opp) > 0;
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

/** A check along a line with a valuable piece behind the king: the king steps away and the piece behind it falls. */
function skewer(fs: Frame[]): PatternHit | undefined {
  for (let i = 0; i < Math.min(fs.length, 5); i++) {
    const { move, after } = fs[i];
    if (!move.san.includes('+') || !['b', 'r', 'q'].includes(move.piece)) continue;
    const me = move.color as Color;
    const victim = other(me);
    const k = kingSquare(after, victim);
    const df = Math.sign(k.charCodeAt(0) - move.to.charCodeAt(0));
    const dr = Math.sign(Number(k[1]) - Number(move.to[1]));
    const fd = Math.abs(k.charCodeAt(0) - move.to.charCodeAt(0));
    const rd = Math.abs(Number(k[1]) - Number(move.to[1]));
    // A discovered check comes from another piece: the one that moved isn't on the king's line.
    if (fd !== 0 && rd !== 0 && fd !== rd) continue;
    let behind: { type: PieceType; square: string } | undefined;
    for (let f = k.charCodeAt(0) + df, r = Number(k[1]) + dr; f >= 97 && f <= 104 && r >= 1 && r <= 8; f += df, r += dr) {
      const s = `${String.fromCharCode(f)}${r}`;
      const u = pieceAt(after, s);
      if (!u) continue;
      if (u.color === victim && PIECE_VALUE[u.type] >= 3) behind = { type: u.type, square: s };
      break;
    }
    if (!behind) continue;
    const taken = fs.slice(i + 1).some((f) => f.move.color === me && f.move.to === behind!.square);
    if (taken && gainAfter(fs, i, me) >= 2) return { tag: 'skewer', side: 'refutation', at: i, evidence: `${move.san} checks the king, and the ${sq(behind.type, behind.square)} stands behind it on the same line` };
  }
}

const DETECTORS = [backRank, knightFork, discovered, skewer, fork, pin, inBetween, trapped, openedLine];

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
  const block = blockedWithTempo(refutation, mover);
  if (block) return block;
  for (const d of DETECTORS) {
    // The punishment must be the opponent's move; the missed idea must be yours.
    const r = refutation.length > 1 ? d(refutation.slice(1)) : undefined;
    if (r && refutation[r.at + 1]?.move.color === opp) {
      // A piece already deep in their camp (not the one you just moved) that you left there: short of squares, not walked into a trap.
      if (r.tag === 'trapped_piece' && r.square && r.square !== playedUci.slice(2, 4) && relativeRank(r.square, mover) >= 6)
        return { ...r, tag: 'stuck_deep', at: r.at + 1, evidence: `${r.evidence} — it had been left deep in their camp` };
      return { ...r, at: r.at + 1 };
    }
    const b = d(better);
    if (b && better[b.at]?.move.color === mover) return { ...b, side: 'better' };
  }
  const raid = greedyQueen(fenBefore, refutation, mover);
  if (raid) return raid;
  const deep = stuckDeep(fenBefore, refutation, mover);
  if (deep) return deep;
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
    const outnumbered = reply.captured !== 'p' && exchangeGain(afterPlayed, reply.to, opp) > 0;
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
  // Free: undefended — or defended on paper, but the best line never takes back and keeps the material.
  const undefended = !!best && hangingPieces(fenBefore, other(mover)).some((h) => h.square === best.to);
  const notRetaken = !!best?.captured && better[1]?.move.to !== best.to && net(better, mover) >= PIECE_VALUE[best.captured as PieceType] - 1;
  if (best?.captured && (undefended || notRetaken) && net(better, mover) >= (best.captured === 'p' ? 1 : 2)) {
    // You did capture — just the smaller prize.
    const took = refutation[0]?.move.captured as PieceType | undefined;
    if (took && PIECE_VALUE[best.captured as PieceType] > PIECE_VALUE[took])
      return { tag: 'bigger_capture', side: 'better', at: 0, evidence: `you took the ${sq(took, refutation[0].move.to)}, but ${best.san} won the ${sq(best.captured as PieceType, best.to)}, which was ${undefended ? 'undefended' : 'free'}` };
    const line = lineName(best.from, best.to, best.piece as PieceType);
    const how = line ? `your ${PIECE_NAME[best.piece as PieceType]} on ${best.from} could take it ${line} (${best.san})` : `${best.san} takes it for free`;
    const state = undefended ? 'undefended' : `free (${COLOR_NAME[other(mover)]} can't afford to take back)`;
    return { tag: 'hanging_piece', side: 'better', at: 0, evidence: `the ${sq(best.captured as PieceType, best.to)} was ${state} — ${how}` };
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
  incomplete_exchange: { title: 'Finish the trade before anything else.', detail: 'When pieces are being traded, a check or a threat in the middle can make you forget to take back. After every capture and check, recount the material: if you are a piece down, taking back comes first.' },
  blocked_with_tempo: { title: 'Before giving a check, look at how it can be blocked.', detail: 'A check is only good if the answer helps you. When the opponent can block it with a piece that also attacks your checking piece, your piece has to move again and they gain a tempo — often with more threats. Check the blocks before you check.' },
  greedy_queen: { title: 'Before grabbing material with your queen, check your king.', detail: 'A pawn far from your king costs your queen several moves — and while it is away, your king has one defender fewer. Before a queen capture, ask what checks and threats your opponent gets with your queen out of play.' },
  stuck_deep: { title: 'Count your raiding piece’s escape squares every move.', detail: 'A queen or piece deep in the opponent’s camp can be cut off: one rook or pawn move takes away its last squares. Every move it stays there, count its ways back — and bring it home while you still can.' },
  skewer: { title: 'Keep your king off the lines your other pieces stand on.', detail: 'A skewer is a check along a line with another of your pieces behind the king: the king has to step away, and the piece behind it is lost. Before every move — especially in the endgame — look at the ranks, files and diagonals your king shares with your queen and rooks, and at which enemy piece could check along them.' },
  bigger_capture: { title: 'Before you capture, compare all your captures.', detail: 'When you can take something, there is often more than one capture on the board. List them all and take the one that wins the most — the first one you see is not always the best.' },
  pawn_fork: { title: 'Watch the pawn pushes that could hit two of your pieces.', detail: 'A pawn is the cheapest attacker on the board: when it attacks two pieces at once, one of them is lost. Before you put a piece on a square an enemy pawn could attack next to another one — and before a retreat to the edge — check every push and capture their pawns have.' },
  unblocked_queen: { title: 'Before you move a blocker, check the line it was blocking.', detail: 'When your queen sits on the same file, rank or diagonal as an enemy bishop, rook or queen, the piece or pawn in between is all that keeps it safe. Before you move that blocker — even to capture something — check what it uncovers.' },
  removed_defender: { title: 'Before you move a piece, ask what it was guarding.', detail: 'Every piece and pawn may be the only thing protecting something else. Before you move one, look at what it defends right now — if that piece or pawn would be left loose, keep the guard or protect it another way first.' },
  hanging_piece: { title: 'Before you let go of a piece, check whether it can simply be taken.', detail: 'Do a two-second blunder check on every move: for the square you are moving to, and for the piece you are moving away from — what can now be captured for free?' },
};
