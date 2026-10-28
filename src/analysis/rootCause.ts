// Root causes: the moves that set a loss up, not only the one that lost it.
//
// Four generic detectors (no per-game tuning), and the story that strings them together:
//  - defended pawn grab: a piece takes a defended pawn and is taken back;
//  - king pawns: a pawn move in front of your castled king, after which the opponent's pawns
//    came forward with tempo on that side;
//  - pawn storm: the opponent's pawns advancing on your king's side, chasing your pieces;
//  - piece to the rim: a knight or bishop driven to the edge, where it has few safe squares.
// rootCause() then finds the decisive drop on the eval timeline and looks back for the setup.
import { Chess, type Square } from 'chess.js';
import type { Color, Finding, MoveEval, PieceType, PlyRecord } from '../domain/types';
import { COLOR_NAME, PIECE_NAME, PIECE_VALUE, attackedEnemyPieces, attackersOf, kingSquare, other, passTurn, pieceAt, squareName } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { pd } from './evaluation';

interface Ctx {
  plies: PlyRecord[];
  evals: MoveEval[];
  userColor: Color;
}

const SHELTER: Record<string, string[]> = { king: ['f', 'g', 'h'], queen: ['a', 'b', 'c'] };
const WINDOW = 10; // plies to look ahead for the consequences of a pawn move

/** The files in front of a castled king, or nothing while the king is still in the centre. */
function shelterFiles(fen: string, color: Color): string[] {
  const k = kingSquare(fen, color);
  const home = color === 'w' ? '1' : '8';
  if (!k || (k[1] !== home && k[1] !== (color === 'w' ? '2' : '7'))) return [];
  return /^[fgh]/.test(k) ? SHELTER.king : /^[abc]/.test(k) ? SHELTER.queen : [];
}

/** Opponent pawn advances on these files in plies (from, to], with the pieces each one attacked. */
function stormMoves(ctx: Ctx, from: number, to: number, files: string[]): { ply: PlyRecord; hits: PieceType[] }[] {
  const opp = other(ctx.userColor);
  const out: { ply: PlyRecord; hits: PieceType[] }[] = [];
  for (let k = from + 1; k <= Math.min(to, ctx.plies.length - 1); k++) {
    const q = ctx.plies[k];
    if (q.color !== opp || q.piece !== 'p' || !files.includes(q.to[0])) continue;
    const hits = attackedEnemyPieces(q.fenAfter, q.to).filter((t) => t.type !== 'p' && t.type !== 'k').map((t) => t.type as PieceType);
    out.push({ ply: q, hits });
  }
  return out;
}

const userWin = (e: MoveEval) => e.winBefore;

/** How far your winning chances fell over a stretch (0 when they didn't). */
function slip(ctx: Ctx, from: number, to: number): number {
  const mine = ctx.evals.slice(from, to + 1).filter((e) => e.color === ctx.userColor);
  if (!mine.length) return 0;
  return Math.max(0, userWin(mine[0]) - Math.min(...mine.map((e) => e.winAfter)));
}

// ------------------------------------------------------------ detectors

/** A piece takes a defended pawn (or anything cheaper) and is simply taken back. */
export function detectDefendedGrab(ctx: Ctx, i: number): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (p.color !== ctx.userColor || !p.captured || p.piece === 'p' || p.piece === 'k') return [];
  if (PIECE_VALUE[p.piece] - PIECE_VALUE[p.captured] < 2 || pd(e) < 8) return [];
  const opp = other(ctx.userColor);
  const defenders = attackersOf(p.fenBefore, p.to, opp);
  const reply = e.replyLineUci[0];
  if (!defenders.length || reply?.slice(2, 4) !== p.to || e.materialAfterReply - e.materialBefore > -1) return [];
  const names = defenders.slice(0, 2).map((s) => squareName(pieceAt(p.fenBefore, s)!.type, s));
  const takenBy = e.replyLineSan[0];
  return [
    {
      kind: 'weakness',
      category: 'defended_grab',
      ply: p.ply,
      severity: pd(e) >= 15 ? 3 : 2,
      confidence: 'high',
      evidence: `${moveLabel(p)} took the ${PIECE_NAME[p.captured]} on ${p.to}, but it was defended by the ${names.join(' and the ')} — ${takenBy} won your ${PIECE_NAME[p.piece]}.`,
      facts: { move: moveLabel(p), defenders: names, takenBy, piece: PIECE_NAME[p.piece], captured: PIECE_NAME[p.captured], square: p.to, bestSan: e.bestSan },
    },
  ];
}

/**
 * A pawn move in front of your castled king that gave the opponent targets: their pawns then
 * came forward on that side with tempo (attacking your pieces) within a few moves.
 */
export function detectKingPawns(ctx: Ctx, i: number): Finding[] {
  const p = ctx.plies[i];
  if (p.color !== ctx.userColor || p.piece !== 'p') return [];
  const files = shelterFiles(p.fenBefore, ctx.userColor);
  if (!files.includes(p.from[0])) return [];
  const storm = stormMoves(ctx, i, i + WINDOW, files);
  const tempo = storm.filter((s) => s.hits.length);
  if (storm.length < 2 || !tempo.length) return [];
  const lost = slip(ctx, i, i + WINDOW);
  const opp = COLOR_NAME[other(ctx.userColor)];
  return [
    {
      kind: 'weakness',
      category: 'king_pawns',
      ply: p.ply,
      relatedPlies: storm.map((s) => s.ply.ply),
      severity: lost >= 15 ? 2 : 1,
      confidence: lost >= 15 ? 'high' : 'medium',
      evidence: `${moveLabel(p)} loosened the pawns in front of your king, and ${opp}'s pawns came forward with tempo (${storm.map((s) => moveLabel(s.ply)).join(', ')}), attacking your ${pieceList(tempo.flatMap((s) => s.hits))}.`,
      facts: { move: moveLabel(p), storm: storm.map((s) => moveLabel(s.ply)), chasedPieces: tempo.flatMap((s) => s.hits.map((h) => PIECE_NAME[h])) },
    },
  ];
}

/** The opponent's pawns storming your castled king's side, chasing your pieces — when you didn't start it. */
export function detectPawnStorm(ctx: Ctx, already: Finding[]): Finding[] {
  const out: Finding[] = [];
  const covered = new Set(already.filter((f) => f.category === 'king_pawns').flatMap((f) => f.relatedPlies ?? []));
  for (let i = 0; i < ctx.plies.length; i++) {
    const q = ctx.plies[i];
    if (q.color === ctx.userColor || q.piece !== 'p' || covered.has(q.ply)) continue;
    const files = shelterFiles(q.fenBefore, ctx.userColor);
    if (!files.includes(q.to[0])) continue;
    const storm = stormMoves(ctx, i - 1, i - 1 + WINDOW, files).filter((s) => !covered.has(s.ply.ply));
    const tempo = storm.filter((s) => s.hits.length);
    if (storm.length < 2 || tempo.length < 1) continue;
    const lost = slip(ctx, i, i + WINDOW);
    if (lost < 15) continue;
    const reply = ctx.plies[storm[1].ply.ply]; // your move right after the second push
    if (!reply || reply.color !== ctx.userColor) continue;
    storm.forEach((s) => covered.add(s.ply.ply));
    out.push({
      kind: 'weakness',
      category: 'pawn_storm',
      ply: reply.ply,
      relatedPlies: storm.map((s) => s.ply.ply),
      severity: 2,
      confidence: 'medium',
      evidence: `${COLOR_NAME[other(ctx.userColor)]}'s pawns stormed your king's side (${storm.map((s) => moveLabel(s.ply)).join(', ')}), attacking your ${pieceList(tempo.flatMap((s) => s.hits))}.`,
      facts: { storm: storm.map((s) => moveLabel(s.ply)) },
    });
  }
  return out;
}

/** A knight or bishop that was attacked and retreated to the edge, where it has almost no safe squares. */
export function detectPieceToRim(ctx: Ctx, i: number): Finding[] {
  const p = ctx.plies[i];
  if (p.color !== ctx.userColor || (p.piece !== 'n' && p.piece !== 'b') || p.captured) return [];
  const rim = (sq: string) => sq[0] === 'a' || sq[0] === 'h';
  // A retreat with check isn't stuck (and passing the turn would let it take the king).
  if (!rim(p.to) || rim(p.from) || /[+#]/.test(p.san)) return [];
  const opp = other(ctx.userColor);
  const chasers = attackersOf(p.fenBefore, p.from, opp).filter((s) => PIECE_VALUE[pieceAt(p.fenBefore, s)!.type] < PIECE_VALUE[p.piece]);
  if (!chasers.length) return [];
  const flipped = passTurn(p.fenAfter);
  const safe = flipped
    ? new Chess(flipped).moves({ square: p.to as Square, verbose: true }).filter((m) => attackersOf(m.after, m.to, opp).length === 0).length
    : 0;
  // A bishop on the edge usually keeps its long diagonal (…Bh5 after h3 is normal): it only counts
  // when the retreat cost something. A knight on the rim is the classic problem.
  if (safe > 2 || (p.piece === 'b' && pd(ctx.evals[i]) < 8)) return [];
  const prev = ctx.plies[i - 1];
  const by = prev && prev.color === opp && chasers.includes(prev.to) ? `${moveLabel(prev)} drove your ${PIECE_NAME[p.piece]} to the rim: ` : `Your ${PIECE_NAME[p.piece]} went to the rim: `;
  return [
    {
      kind: 'weakness',
      category: 'piece_to_rim',
      ply: p.ply,
      severity: pd(ctx.evals[i]) >= 10 ? 2 : 1,
      confidence: 'medium',
      evidence: `${by}${moveLabel(p)}, where it has ${safe === 0 ? 'no safe squares' : safe === 1 ? 'only one safe square' : 'only two safe squares'}.`,
      facts: { move: moveLabel(p), piece: PIECE_NAME[p.piece], square: p.to, safe, chasedBy: prev?.san, bestSan: ctx.evals[i].bestSan },
    },
  ];
}

const pieceList = (ts: PieceType[]) => {
  const names = [...new Set(ts.map((t) => PIECE_NAME[t]))];
  return names.length <= 1 ? names[0] ?? 'pieces' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

// ------------------------------------------------------------ the story

/** Categories that can set a later loss up. */
const SETUP = ['king_pawns', 'pawn_storm', 'piece_to_rim', 'king_safety', 'pawn_structure'];

export interface RootCause {
  decisive: Finding;
  setup: Finding[];
  /** Setup, then the decisive mistake, then the result — in that order. */
  story: string;
}

/**
 * The decisive drop: the biggest drop in your winning chances that you never fully came back from,
 * in a game that wasn't already lost. Then the setup: detectors that fired on your moves in the dozen
 * plies before it.
 */
export function rootCause(ctx: Ctx & { findings: Finding[]; termination?: string; lost: boolean }): RootCause | undefined {
  if (!ctx.lost) return undefined;
  const mine = ctx.evals.filter((e) => e.color === ctx.userColor);
  // The biggest drop you never fully came back from (a later swing that only half-recovers still counts).
  const decisiveEval = mine
    .filter((e, k) => e.winDrop >= 15 && e.winBefore >= 30 && mine.slice(k + 1).every((x) => x.winBefore < e.winBefore - 5))
    .sort((a, b) => b.winDrop - a.winDrop)[0];
  if (!decisiveEval) return undefined;
  const at = decisiveEval.ply;
  const here = ctx.findings.filter((f) => f.kind === 'weakness' && f.ply === at);
  // What explains it: a named tactic, a specific detector, then anything about that move.
  const rank = (f: Finding) => (f.facts.pattern && f.facts.patternSide !== 'better' ? 0 : f.category === 'defended_grab' ? 1 : f.facts.mate ? 2 : f.facts.hanging ? 3 : 4);
  const decisive = [...here].sort((a, b) => rank(a) - rank(b) || b.severity - a.severity)[0];
  if (!decisive) return undefined;
  // Setup: a set-up detector that mattered (king pawns, a piece on the rim…), or a move just before
  // where your chances were already clearly slipping. Two at most, in game order.
  const slipped = (f: Finding) => f.ply >= at - 6 && (ctx.evals[f.ply - 1]?.winDrop ?? 0) >= 10;
  const setup = ctx.findings
    .filter((f) => f.kind === 'weakness' && f.ply < at && f.ply >= at - 14 && f.severity >= 2 && (SETUP.includes(f.category) || slipped(f)))
    .filter((f, k, all) => all.findIndex((x) => x.ply === f.ply) === k) // one per move
    .sort((a, b) => b.severity - a.severity || b.ply - a.ply)
    .slice(0, 2)
    .sort((a, b) => a.ply - b.ply);
  const parts: string[] = [];
  if (setup.length) parts.push(setup.map((f) => f.evidence.replace(/\.$/, '')).join('. ') + '.');
  parts.push(`${setup.length ? 'Then the decisive mistake: ' : 'The decisive mistake: '}${lowerFirstMove(decisive.evidence)}`);
  const result = resultLine(ctx, at, setup);
  if (result) parts.push(result);
  return { decisive, setup, story: parts.join(' ') };
}

// "16.Bxg4 took…" stays as is; a sentence starting with a word gets a lower-case first letter.
const lowerFirstMove = (s: string) => (/^\d/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

function resultLine(ctx: Ctx & { termination?: string }, at: number, setup: Finding[]): string | undefined {
  const last = ctx.plies.at(-1);
  if (!last) return undefined;
  const opp = COLOR_NAME[other(ctx.userColor)];
  const t = (ctx.termination ?? '').toLowerCase();
  const exposed = setup.some((f) => ['king_pawns', 'pawn_storm', 'king_safety'].includes(f.category)) ? ' With your king exposed,' : ' From there';
  const moves = last.moveNumber;
  if (last.san.endsWith('#') || t.includes('checkmate')) return `${exposed} ${opp} eventually broke through for checkmate on move ${moves}.`.replace(/^ /, '');
  if (t.includes('time')) return `You were worse from then on and lost on time on move ${moves}.`;
  if (t.includes('resign') || t.includes('abandon')) return `You were clearly worse from then on, and the game ended on move ${moves}.`;
  return at < last.ply ? `You were clearly worse from then on.` : undefined;
}
