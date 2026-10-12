// What does a move actually *do*? Deterministic, board-based purposes for a
// move (e.g. "puts your rook on the open d-file", "wins the bishop on d6",
// "takes away ...Qg4+"), each with a confidence. The coach uses these to say
// why the better move is better, and what the played move was going for.
//
// Rules of thumb: every purpose must be visible on the board after the move
// (or within the first few plies of the engine line); anything vague is left
// out rather than guessed.
import { Chess, type Square } from 'chess.js';
import type { Color, PieceType, PlyContext } from '../domain/types';
import {
  COLOR_NAME,
  PIECE_NAME,
  PIECE_VALUE,
  attackedEnemyPieces,
  attackersOf,
  checksAvailable,
  fileStatus,
  isLoose,
  kingSquare,
  kingZoneAttacks,
  loosePieces,
  materialAfterLine,
  materialBalance,
  mobility,
  other,
  passedPawns,
  pieceAt,
  playLine,
  relativeRank,
  passTurn,
} from '../chess/board';

export type PurposeId =
  | 'mate'
  | 'promote'
  | 'win_material'
  | 'double_attack'
  | 'threat'
  | 'escape'
  | 'defend'
  | 'stop_threat'
  | 'remove_attacker'
  | 'remove_defender'
  | 'castle'
  | 'develop'
  | 'open_file'
  | 'half_open_file'
  | 'opens_file'
  | 'open_diagonal'
  | 'improve_bad_piece'
  | 'activate'
  | 'king_safety'
  | 'simplify'
  | 'trade_queens'
  | 'trade_active'
  | 'restrict_checks'
  | 'push_passed'
  | 'create_passed'
  | 'support_passed'
  | 'blockade'
  | 'king_escape'
  | 'capture'
  | 'check'
  | 'pawn_threat';

export interface Purpose {
  id: PurposeId;
  /** Present tense, third person: "puts your rook on the open d-file". */
  text: string;
  weight: number;
  confidence: 'high' | 'medium';
  squares: string[];
  /** For material wins: how many plies of the line it takes (1 = the move itself). */
  plies?: number;
}

export interface DescribeInput {
  /** Position before the move (the mover is to play). */
  fen: string;
  uci: string;
  /** Engine line starting with this move, if known. */
  pv?: string[];
  /** Forced mate length for this line, if the engine found one. */
  mateIn?: number;
  /** Engine score of this line in centipawns (mover's view), to sanity-check material claims. */
  lineCp?: number;
  context?: PlyContext;
  /** The opponent's strongest reply to the move that was actually played (e.g. ...Qg4+). */
  threatUci?: string;
  /** Position after the move that was actually played, for "does it stop that?" comparisons. */
  playedFenAfter?: string;
  /**
   * Describing the player's own move ("what were you going for?"): use only what
   * is visible on the board, never the engine line, and allow weaker motives.
   */
  forIntent?: boolean;
}

const HOME: Record<Color, Record<string, PieceType>> = {
  w: { b1: 'n', g1: 'n', c1: 'b', f1: 'b' },
  b: { b8: 'n', g8: 'n', c8: 'b', f8: 'b' },
};

const name = (t: PieceType) => PIECE_NAME[t];
const sq = (t: PieceType, s: string) => (t === 'p' ? `pawn on ${s}` : `${PIECE_NAME[t]} on ${s}`);

function threatInfo(fen: string, uci: string): { legal: boolean; san?: string; check: boolean; captureValue: number } {
  try {
    const c = new Chess(fen);
    const victim = c.get(uci.slice(2, 4) as Square);
    const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
    return { legal: true, san: mv.san, check: c.inCheck(), captureValue: victim ? PIECE_VALUE[victim.type as PieceType] : 0 };
  } catch {
    return { legal: false, check: false, captureValue: 0 };
  }
}

/** Squares in front of a pawn, toward promotion. */
function pathAhead(square: string, color: Color): string[] {
  const out: string[] = [];
  const dir = color === 'w' ? 1 : -1;
  for (let r = Number(square[1]) + dir; r >= 1 && r <= 8; r += dir) out.push(`${square[0]}${r}`);
  return out;
}

export function describeMove(inp: DescribeInput): { san: string; purposes: Purpose[] } | undefined {
  const c = new Chess(inp.fen);
  const mover = c.turn() as Color;
  const opp = other(mover);
  const oppName = COLOR_NAME[opp];
  let mv;
  try {
    mv = c.move({ from: inp.uci.slice(0, 2), to: inp.uci.slice(2, 4), promotion: inp.uci[4] ?? 'q' });
  } catch {
    return undefined;
  }
  const after = c.fen();
  const piece = mv.piece as PieceType;
  const captured = mv.captured as PieceType | undefined;
  const ctx = inp.context;
  const pv = !inp.forIntent && inp.pv && inp.pv[0] === inp.uci ? inp.pv : [inp.uci];
  const frames = playLine(inp.fen, pv, 6);
  const out: Purpose[] = [];
  const add = (p: Purpose) => out.push(p);

  // --- forcing outcomes -----------------------------------------------------
  if (c.isCheckmate()) add({ id: 'mate', text: 'is checkmate', weight: 100, confidence: 'high', squares: [mv.to] });
  else if (inp.mateIn && inp.mateIn <= 4)
    add({ id: 'mate', text: 'starts a forced checkmate', weight: 100, confidence: 'high', squares: [mv.to] });
  if (mv.promotion) add({ id: 'promote', text: `promotes the pawn to a ${name(mv.promotion as PieceType)}`, weight: 95, confidence: 'high', squares: [mv.to] });

  // Material won within the first few plies of the line (net of recaptures).
  const base = materialBalance(inp.fen, mover);
  const gain = materialAfterLine(inp.fen, pv, mover, 5, 2) - base;
  // A material "win" the engine doesn't actually rate as winning is just a pause mid-exchange.
  const engineAgrees = inp.lineCp === undefined || inp.lineCp >= 150;
  if (gain >= 2 && engineAgrees && !mv.promotion && !inp.forIntent) {
    // The first capture in the line that is big enough to explain the gain.
    let target: { type: PieceType; square: string; san: string; k: number } | undefined;
    let fenK = inp.fen;
    for (let k = 0; k < Math.min(3, frames.length); k += 1) {
      const f = frames[k];
      const victim = pieceAt(fenK, f.to);
      if (!target && k % 2 === 0 && victim && victim.color === opp && PIECE_VALUE[victim.type] >= 2) target = { type: victim.type, square: f.to, san: f.san, k };
      fenK = f.fen;
    }
    const exchange = target?.type === 'r' && gain < 4;
    // Something of ours goes in return (e.g. a rook for the queen): say so.
    let given: PieceType | undefined;
    if (target && !exchange) {
      let fenG = inp.fen;
      for (let k = 0; k < Math.min(5, frames.length); k++) {
        const f = frames[k];
        const victim = pieceAt(fenG, f.to);
        if (k % 2 === 1 && victim && victim.color === mover && PIECE_VALUE[victim.type] >= 3 && PIECE_VALUE[victim.type] < PIECE_VALUE[target.type]) {
          given = victim.type;
          break;
        }
        fenG = f.fen;
      }
    }
    add({
      id: 'win_material',
      text: !target
        ? 'wins material'
        : exchange
          ? `wins the exchange (your minor piece for the rook on ${target.square})`
          : `wins the ${sq(target.type, target.square)}${given ? ` for a ${name(given)}` : ''}`,
      weight: 90,
      confidence: target ? 'high' : 'medium',
      squares: target ? [target.square] : [],
      plies: target ? target.k + 1 : undefined,
    });
  }

  // --- what the move visibly does (used for the player's own move) ---------------
  if (inp.forIntent) {
    if (captured) add({ id: 'capture', text: `takes the ${sq(captured, mv.to)}`, weight: 20, confidence: 'medium', squares: [mv.to] });
    const pawnTargets = attackedEnemyPieces(after, mv.to).filter((t) => t.type === 'p' && !new Set(attackedEnemyPieces(inp.fen, mv.from).map((x) => x.square)).has(t.square));
    if (pawnTargets.length && !captured)
      add({ id: 'pawn_threat', text: `attacks the ${pawnTargets.slice(0, 2).map((t) => sq(t.type, t.square)).join(' and the ')}`, weight: 18, confidence: 'medium', squares: pawnTargets.map((t) => t.square) });
  }

  // --- threats ----------------------------------------------------------------
  const before = new Set(attackedEnemyPieces(inp.fen, mv.from).map((t) => t.square));
  const fresh = attackedEnemyPieces(after, mv.to).filter(
    (t) => !before.has(t.square) && PIECE_VALUE[t.type] >= 3 && (isLoose(after, t.square) || PIECE_VALUE[t.type] > PIECE_VALUE[piece]),
  );
  const check = c.inCheck();
  if (!out.some((p) => p.id === 'mate' || p.id === 'win_material')) {
    if ((check && fresh.length >= 1) || fresh.length >= 2) {
      add({
        id: 'double_attack',
        text: check ? `gives check and attacks the ${sq(fresh[0].type, fresh[0].square)} at the same time` : `attacks the ${sq(fresh[0].type, fresh[0].square)} and the ${sq(fresh[1].type, fresh[1].square)} at once`,
        weight: 75,
        confidence: 'high',
        squares: fresh.slice(0, 2).map((t) => t.square),
      });
    } else if (fresh.length === 1) {
      const t = fresh[0];
      add({ id: 'threat', text: `attacks the ${isLoose(after, t.square) ? 'loose ' : ''}${sq(t.type, t.square)}`, weight: 40, confidence: 'medium', squares: [t.square] });
    } else if (check && inp.forIntent) {
      add({ id: 'check', text: 'gives check', weight: 22, confidence: 'medium', squares: [mv.to] });
    }
  }

  // --- safety of your own pieces --------------------------------------------
  const looseBefore = loosePieces(inp.fen, mover).filter((l) => PIECE_VALUE[l.type] >= 3);
  const looseAfter = new Set(loosePieces(after, mover).map((l) => l.square));
  for (const l of looseBefore) {
    if (l.square === mv.from) {
      if (!looseAfter.has(mv.to)) add({ id: 'escape', text: `moves your ${name(l.type)} out of danger`, weight: 80, confidence: 'high', squares: [mv.to] });
    } else if (!looseAfter.has(l.square) && pieceAt(after, l.square)?.color === mover) {
      const tookAttacker = !!captured && attackersOf(inp.fen, l.square, opp).includes(mv.to as Square);
      add({
        id: tookAttacker ? 'remove_attacker' : 'defend',
        text: tookAttacker ? `removes the piece that was attacking your ${name(l.type)}` : `protects your loose ${sq(l.type, l.square)}`,
        weight: 80,
        confidence: 'high',
        squares: [l.square],
      });
    }
  }

  // Does it stop the opponent's best reply to the move actually played?
  if (inp.threatUci && inp.playedFenAfter) {
    const was = threatInfo(inp.playedFenAfter, inp.threatUci);
    // Only a threat that already existed before the move counts — not one the played move created.
    const pre = passTurn(inp.fen);
    const existed = !!pre && (() => {
      const t = threatInfo(pre, inp.threatUci!);
      return t.legal && (t.check || t.captureValue >= 3);
    })();
    if (existed && was.legal && (was.check || was.captureValue >= 3)) {
      const now = threatInfo(after, inp.threatUci);
      const stopped = !now.legal || (was.check && !now.check) || (was.captureValue >= 3 && now.captureValue < was.captureValue);
      if (stopped) add({ id: 'stop_threat', text: `takes away ${oppName}'s ${was.san}`, weight: 78, confidence: 'high', squares: [inp.threatUci.slice(2, 4)] });
    }
  }

  // Capturing a piece that was guarding something else.
  if (captured) {
    const guarded = new Chess(inp.fen)
      .board()
      .flat()
      .filter((p) => p && p.color === opp && p.type !== 'k' && PIECE_VALUE[p.type as PieceType] >= 3)
      .map((p) => p!.square)
      .filter((s) => attackersOf(inp.fen, s, opp).includes(mv.to as Square) && !isLoose(inp.fen, s) && isLoose(after, s) && pieceAt(after, s));
    if (guarded.length) {
      const t = pieceAt(after, guarded[0])!;
      add({ id: 'remove_defender', text: `removes the defender of the ${sq(t.type, guarded[0])}`, weight: 70, confidence: 'medium', squares: [guarded[0]] });
    }
  }

  // --- development & king safety ----------------------------------------------
  if (mv.san.startsWith('O-O')) {
    add({ id: 'castle', text: 'castles, so your king is safe and your rook joins the game', weight: 60, confidence: 'high', squares: [mv.to] });
  } else if (HOME[mover][mv.from] === piece) {
    add({ id: 'develop', text: `develops your ${name(piece)}`, weight: 55, confidence: 'high', squares: [mv.to] });
  }
  const zoneBefore = kingZoneAttacks(inp.fen, mover);
  const zoneAfter = kingZoneAttacks(after, mover);
  if (!mv.san.startsWith('O-O') && zoneBefore >= 3 && zoneAfter <= zoneBefore - 2) {
    add({ id: 'king_safety', text: 'takes pressure off your king', weight: 42, confidence: 'medium', squares: [kingSquare(after, mover)] });
  }

  // --- files and diagonals ------------------------------------------------------
  if ((piece === 'r' || piece === 'q') && mv.from[0] !== mv.to[0]) {
    const st = fileStatus(after, mv.to[0], mover);
    const corner = piece === 'r' && ['a1', 'h1', 'a8', 'h8'].includes(mv.from) && mv.from[1] === (mover === 'w' ? '1' : '8');
    if (st === 'open')
      add({
        id: 'open_file',
        text: corner ? `brings your rook into the game on the open ${mv.to[0]}-file` : `puts your ${name(piece)} on the open ${mv.to[0]}-file`,
        weight: 45,
        confidence: piece === 'r' ? 'high' : 'medium',
        squares: [mv.to],
      });
    else if (st === 'half-open' && piece === 'r')
      add({ id: 'half_open_file', text: `puts your rook on the half-open ${mv.to[0]}-file`, weight: 34, confidence: 'medium', squares: [mv.to] });
  }
  if (piece === 'p') {
    // A pawn move (or the capture that follows it in the line) that opens a file for a rook.
    const end = frames[Math.min(2, frames.length - 1)]?.fen ?? after;
    const rooks = new Chess(end).board().flat().filter((p) => p && p.color === mover && p.type === 'r').map((p) => p!.square);
    for (const r of rooks) {
      if (fileStatus(inp.fen, r[0], mover) === 'closed' && fileStatus(end, r[0], mover) !== 'closed' && r[0] === mv.from[0]) {
        const toward = ctx?.attackingKing && Math.abs(kingSquare(end, opp).charCodeAt(0) - r.charCodeAt(0)) <= 1 ? ` toward ${oppName}'s king` : '';
        add({ id: 'opens_file', text: `opens the ${r[0]}-file for your rook${toward}`, weight: 46, confidence: 'medium', squares: [r] });
        break;
      }
    }
    // Opening a diagonal for a bishop.
    const bishops = new Chess(after).board().flat().filter((p) => p && p.color === mover && p.type === 'b').map((p) => p!.square);
    let bestGain = 0;
    let bestB = '';
    for (const b of bishops) {
      const g = mobility(after, b) - mobility(inp.fen, b);
      if (g > bestGain) [bestGain, bestB] = [g, b];
    }
    if (bestGain >= 3) add({ id: 'open_diagonal', text: `opens the diagonal for your bishop on ${bestB}`, weight: 35, confidence: 'medium', squares: [bestB] });
  }

  // --- activity ------------------------------------------------------------------
  if (!captured && (piece === 'n' || piece === 'b' || piece === 'r' || piece === 'q') && !out.some((p) => p.id === 'develop' || p.id === 'open_file' || p.id === 'half_open_file' || p.id === 'escape')) {
    const m0 = mobility(inp.fen, mv.from);
    const m1 = mobility(after, mv.to);
    if (m0 <= 2 && m1 >= m0 + 3) add({ id: 'improve_bad_piece', text: `brings your passive ${name(piece)} into play`, weight: 38, confidence: 'medium', squares: [mv.to] });
    else if (m1 >= m0 + 4 && piece !== 'q') add({ id: 'activate', text: `puts your ${name(piece)} on a much more active square`, weight: 28, confidence: 'medium', squares: [mv.to] });
  }

  // --- trades ----------------------------------------------------------------------
  const reply = frames[1];
  const recapture = frames[2];
  const tradeNow = !!captured && PIECE_VALUE[captured] >= 3 && !!reply && reply.to === mv.to && Math.abs(PIECE_VALUE[captured] - PIECE_VALUE[piece]) <= 1;
  const replyPiece = reply ? pieceAt(after, reply.from) : undefined;
  const tradeOffered =
    !captured && piece !== 'p' && !!reply && reply.to === mv.to && !!recapture && recapture.to === mv.to && !!replyPiece && replyPiece.type === piece;
  const holdsMaterial = !inp.forIntent && gain >= -0.5 && (!recapture || materialBalance(recapture.fen, mover) >= base - 0.5);
  if ((tradeNow || tradeOffered) && holdsMaterial) {
    const queens = captured === 'q' || (tradeOffered && piece === 'q');
    const enemySquare = tradeNow ? mv.to : reply!.from;
    const enemyMob = mobility(tradeNow ? inp.fen : after, enemySquare);
    const enemyType = pieceAt(tradeNow ? inp.fen : after, enemySquare)?.type;
    if (ctx?.ahead) {
      add({
        id: queens ? 'trade_queens' : 'simplify',
        text: queens
          ? `${tradeOffered ? 'offers' : 'forces'} a queen trade — with a material lead, that takes away ${oppName}'s attacking chances`
          : `trades a pair of pieces — when you're ahead, every trade brings the win closer`,
        weight: 66,
        confidence: 'high',
        squares: [mv.to],
      });
    } else if (queens && ctx?.kingPressure) {
      add({ id: 'trade_queens', text: `trades queens and ends the attack on your king`, weight: 66, confidence: 'high', squares: [mv.to] });
    } else if (enemyType && enemyType !== 'p' && (enemyMob >= 7 || kingZoneAttacks(inp.fen, mover) >= 3)) {
      add({ id: 'trade_active', text: `trades off ${oppName}'s active ${name(enemyType)}`, weight: 40, confidence: 'medium', squares: [enemySquare] });
    }
  }

  // --- counterplay ----------------------------------------------------------------
  if (inp.playedFenAfter && (ctx?.ahead || ctx?.kingPressure)) {
    const checksIfPlayed = checksAvailable(inp.playedFenAfter);
    if (checksIfPlayed >= 1 && checksAvailable(after) === 0 && !out.some((p) => p.id === 'stop_threat'))
      add({ id: 'restrict_checks', text: `leaves ${oppName} without a single check`, weight: 50, confidence: 'medium', squares: [kingSquare(after, mover)] });
  }

  // More room for the king when the opponent has checks: the checks run out.
  const threatIsCheck = !!inp.threatUci && !!inp.playedFenAfter && threatInfo(inp.playedFenAfter, inp.threatUci).check;
  if (inp.playedFenAfter && !inp.forIntent && threatIsCheck && piece !== 'k') {
    const escapes = (fen: string) => {
      const mine = passTurn(fen);
      if (!mine) return [] as string[];
      const k = kingSquare(mine, mover);
      return new Chess(mine).moves({ square: k as Square, verbose: true }).map((m) => m.to);
    };
    const now = escapes(after);
    const then = new Set(escapes(inp.playedFenAfter));
    const gained = now.filter((x) => !then.has(x));
    if (gained.length)
      add({ id: 'king_escape', text: `gives your king an escape square on ${gained[0]}, so ${oppName}'s checks run out`, weight: 72, confidence: 'medium', squares: [gained[0]] });
  }

  // --- passed pawns -------------------------------------------------------------
  if (piece === 'p' && !mv.promotion) {
    const passedNow = passedPawns(after, mover).includes(mv.to);
    const wasPassed = passedPawns(inp.fen, mover).includes(mv.from);
    if (passedNow && wasPassed && relativeRank(mv.to, mover) >= 5)
      add({ id: 'push_passed', text: `pushes your passed pawn closer to promotion`, weight: 55, confidence: 'high', squares: [mv.to] });
    // Only if the new passed pawn survives the reply (exd6 Nxd6 doesn't create anything).
    else if (passedNow && !wasPassed && !frames.slice(1, 5).some((f, k) => k % 2 === 0 && f.to === mv.to))
      add({ id: 'create_passed', text: `creates a passed pawn on ${mv.to}`, weight: 50, confidence: 'medium', squares: [mv.to] });
  } else if (piece !== 'k') {
    // Compared with the move actually played, does this keep more of our passed pawn's path covered?
    const pathCover = (fen: string, pawn: string) => {
      const c2 = new Chess(fen);
      const path = pathAhead(pawn, mover);
      return path.filter((x) => c2.attackers(x as Square, mover).length > 0).length;
    };
    const own = passedPawns(after, mover).filter((s2) => relativeRank(s2, mover) >= 4);
    const compare = inp.playedFenAfter ?? inp.fen;
    const supported = own.find((s2) => pathCover(after, s2) > pathCover(compare, s2));
    if (supported && !inp.forIntent) add({ id: 'support_passed', text: `keeps guarding the path of your passed pawn on ${supported}`, weight: 52, confidence: 'medium', squares: [supported] });
    const theirs = passedPawns(after, opp).find((s) => pathAhead(s, opp)[0] === mv.to);
    if (theirs) add({ id: 'blockade', text: `blockades ${oppName}'s passed pawn`, weight: 50, confidence: 'high', squares: [theirs] });
  }

  // Rank, de-duplicate, keep the strongest few.
  const seen = new Set<PurposeId>();
  const purposes = out
    .sort((a, b) => b.weight - a.weight)
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return { san: mv.san, purposes };
}

/** "Rad1 develops your rook and puts it on the open d-file" style sentence, or undefined if nothing reliable. */
export function purposeSentence(san: string, purposes: Purpose[], max = 2, minWeight = 0): string | undefined {
  const use = purposes.filter((p) => p.weight >= minWeight).slice(0, max);
  if (!use.length) return undefined;
  return `${san} ${joinList(use.map((p) => p.text))}`;
}

const GERUND: Record<string, string> = {
  is: 'being',
  wins: 'winning',
  attacks: 'attacking',
  gives: 'giving',
  moves: 'moving',
  protects: 'protecting',
  removes: 'removing',
  takes: 'taking',
  castles: 'castling',
  develops: 'developing',
  puts: 'putting',
  opens: 'opening',
  brings: 'bringing',
  trades: 'trading',
  forces: 'forcing',
  offers: 'offering',
  leaves: 'leaving',
  pushes: 'pushing',
  creates: 'creating',
  supports: 'supporting',
  blockades: 'blockading',
  starts: 'starting',
  promotes: 'promoting',
};

/** Gerund form of a joined purpose list: "attacks X and moves Y" -> "attacking X and moving Y". */
export function gerundPhrase(text: string): string {
  return text.replace(/(^|, | and )(\w+)/g, (_m, sep: string, w: string) => sep + (GERUND[w] ?? w));
}

/** "attacks the rook" -> "attacking the rook". */
export function toGerund(text: string): string {
  const [first, ...rest] = text.split(' ');
  return [GERUND[first] ?? first, ...rest].join(' ');
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}
