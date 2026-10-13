// Opening trainer: from the opening of one of your games, a short, sound, *simple* line to
// practise — development first, castle, a healthy middlegame — not theory to memorise.
//
// Stockfish judges every move (only moves it rates good or better are ever recommended or
// accepted). Among those, the line prefers moves that develop a piece, castle or claim the
// centre, and — when Lichess data is available — moves players near your rating actually
// play. Your opponent's replies are your game's moves while the line follows it, then the
// most common reply at your level (or Stockfish's choice without Lichess data).
import { Chess } from 'chess.js';
import type { Color, GradedMove, OpeningLesson, OpeningStep, PositionEval, StoredGame } from '../domain/types';
import { PIECE_NAME, attackersOf, other, passTurn, pieceAt, uciToSan, undevelopedMinors } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { positionCp, scoreToCp } from '../analysis/evaluation';
import { gapBetween, qualityOfGap, rankCandidates } from '../analysis/moveQuality';
import { betaPositions, fmtEval } from '../coach/betaCoach';
import { openingName } from './diagnosis';

export interface ExplorerMove {
  uci: string;
  san: string;
  games: number;
  /** Fraction of games at this position (0..1). */
  share: number;
}
export type Explorer = (fen: string) => Promise<{ moves: ExplorerMove[]; opening?: string } | undefined>;

export const OPENING_DEPTH = 14;
const MAX_PLIES = 24;
const HOME: Record<string, string[]> = { w: ['b1', 'g1', 'c1', 'f1'], b: ['b8', 'g8', 'c8', 'f8'] };

/** Why a move helps development, in a few words (empty when it doesn't). */
export function developmentReasons(fen: string, uci: string, moveNumber: number, history: string[]): { score: number; reasons: string[] } {
  const c = new Chess(fen);
  const side = c.turn() as Color;
  const piece = pieceAt(fen, uci.slice(0, 2));
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  if (!piece) return { score: 0, reasons: [] };
  const reasons: string[] = [];
  let score = 0;
  let san = '';
  try {
    san = c.move({ from, to, promotion: 'q' }).san;
  } catch {
    return { score: -5, reasons: [] };
  }
  if (san.startsWith('O-O')) {
    score += 1.5;
    reasons.push('castles: the king is safe and a rook joins the game');
  } else if ((piece.type === 'n' || piece.type === 'b') && HOME[side].includes(from)) {
    score += 1;
    // Natural squares: knights towards the centre (c3/f3, c6/f6), not the edge or e2/d7.
    if (piece.type === 'n' && ['c3', 'f3', 'c6', 'f6'].includes(to)) score += 0.3;
    reasons.push(`develops the ${PIECE_NAME[piece.type]}${piece.type === 'n' && ['c3', 'f3', 'c6', 'f6'].includes(to) ? ' towards the centre' : ''}`);
  } else if (piece.type === 'p' && (from[0] === 'd' || from[0] === 'e') && moveNumber <= 5 && (from[1] === '2' || from[1] === '7')) {
    score += 0.6;
    reasons.push('claims the centre');
  }
  if (piece.type === 'q' && moveNumber <= 8) {
    score -= 1;
    reasons.push('brings the queen out early');
  }
  if (san.includes('x') && !reasons.length) reasons.push('recaptures');
  if ((piece.type === 'n' || piece.type === 'b') && !HOME[side].includes(from) && undevelopedMinors(fen, side).length >= 1 && !san.includes('x')) {
    score -= 0.6;
    reasons.push('moves a piece twice while others are still at home');
  }
  if (piece.type === 'p' && 'abgh'.includes(from[0]) && moveNumber <= 8 && !san.includes('x')) {
    score -= 0.4;
    reasons.push('a flank pawn move, not development');
  }
  if (piece.type === 'p' && !reasons.length) {
    // A pawn move that opens the diagonal of a bishop still at home.
    const before = new Chess(fen);
    const homeBishops = HOME[side].filter((sq) => before.get(sq as never)?.type === 'b' && before.get(sq as never)?.color === side);
    const flipped = passTurn(c.fen());
    const after = flipped ? new Chess(flipped) : undefined;
    const freed = after ? homeBishops.filter((sq) => after.moves({ square: sq as never }).length > before.moves({ square: sq as never }).length) : [];
    if (freed.length) reasons.push(`opens the way for the bishop on ${freed[0]}`);
  }
  if (piece.type === 'r' && ['d', 'e'].includes(to[0])) reasons.push('brings the rook to a central file');
  if (c.inCheck() && piece.type !== 'p') reasons.push('gives check');
  void history;
  return { score, reasons };
}

/** "The bishop on c1 is the only guard of the pawn on b2 (attacked by the bishop on f6)." */
export function duties(fen: string, side: Color): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const row of c.board())
    for (const p of row) {
      if (!p || p.color !== side || p.type === 'k') continue;
      const defenders = attackersOf(fen, p.square, side);
      const attackers = attackersOf(fen, p.square, other(side));
      if (defenders.length !== 1 || !attackers.length) continue;
      const d = pieceAt(fen, defenders[0])!;
      const a = pieceAt(fen, attackers[0])!;
      out.push(`the ${PIECE_NAME[d.type]} on ${defenders[0]} is the only guard of the ${PIECE_NAME[p.type as keyof typeof PIECE_NAME]} on ${p.square} (attacked by the ${PIECE_NAME[a.type]} on ${attackers[0]})`);
    }
  return out.slice(0, 3);
}

const QSCORE: Record<GradedMove['quality'], number> = { best: 3, equal: 3, good: 1.5, inaccuracy: -2, mistake: -5, blunder: -9 };
const SOUND = new Set<GradedMove['quality']>(['best', 'equal', 'good']);

/**
 * Build the line. `analyse` is any Stockfish (browser or Node) at OPENING_DEPTH with
 * several candidates; positions still on your game reuse the stored Beta evaluations.
 */
export async function buildOpeningLine(
  game: StoredGame,
  opts: { analyse: (fen: string) => Promise<PositionEval>; explorer?: Explorer; onProgress?: (ply: number) => void },
): Promise<Omit<OpeningLesson, 'title' | 'summary' | 'principles' | 'middlegamePlan' | 'traps'>> {
  const user = game.userColor;
  const stored = betaPositions(game);
  const steps: OpeningStep[] = [];
  const history: string[] = [];
  let fen = game.plies[0].fenBefore;
  let onGame = true;
  let lichess = false;
  let name = openingName(game).name;
  let deviation: OpeningLesson['deviation'];
  let endReason = `We stop after move ${MAX_PLIES / 2}: from here it's a middlegame.`;

  for (let ply = 1; ply <= MAX_PLIES; ply++) {
    opts.onProgress?.(ply);
    const side = new Chess(fen).turn() as Color;
    const gameMove = onGame ? game.plies[ply - 1] : undefined;
    const pos = onGame && stored[ply - 1]?.lines.length ? stored[ply - 1] : await opts.analyse(fen);
    const lx = opts.explorer ? await opts.explorer(fen).catch(() => undefined) : undefined;
    if (lx?.moves.length) lichess = true;
    if (lx?.opening) name = lx.opening;
    const share = (uci: string) => lx?.moves.find((m) => m.uci === uci)?.share;
    const moveNumber = Math.ceil(ply / 2);
    const forSide = (cp: number) => (side === user ? cp : -cp);
    const ranked = rankCandidates(pos);
    const graded: GradedMove[] = ranked.map((r) => ({ uci: r.uci, san: uciToSan(fen, r.uci) ?? r.uci, quality: r.quality }));
    const c = new Chess(fen);
    const castled = history.some((san, i) => i % 2 === (user === 'w' ? 0 : 1) && san.startsWith('O-O'));
    let move: { uci: string; san: string };
    let step: OpeningStep;

    if (side === user) {
      // Castling and first developing moves are checked even when they're outside Stockfish's top lines:
      // a simple plan shouldn't depend on the engine happening to list them.
      if (pos.lines[0]) {
        const bestCp = scoreToCp(pos.lines[0].score);
        const natural = c
          .moves({ verbose: true })
          .filter((m) => m.san.startsWith('O-O') || ((m.piece === 'n' || m.piece === 'b') && HOME[side].includes(m.from) && !m.captured))
          .filter((m) => !graded.some((g) => g.uci === m.from + m.to))
          .slice(0, 3);
        for (const m of natural) {
          const after = new Chess(fen);
          after.move(m.san);
          const cpAfter = -positionCp(await opts.analyse(after.fen()));
          graded.push({ uci: m.from + m.to, san: m.san, quality: qualityOfGap(gapBetween(bestCp, cpAfter), false) });
        }
      }
      const gm = gameMove && graded.find((g) => g.uci === gameMove.uci);
      const options = graded.filter((g) => SOUND.has(g.quality));
      const scored = options
        .map((g) => {
          const dev = developmentReasons(fen, g.uci, moveNumber, history);
          return { g, score: QSCORE[g.quality] + dev.score + 2 * (share(g.uci) ?? 0) + (gm?.uci === g.uci ? 0.5 : 0) };
        })
        .sort((a, b) => b.score - a.score);
      // Your own opening stays: while the line follows your game, your move is kept whenever it's sound.
      const pick = gm && SOUND.has(gm.quality) ? gm : (scored[0]?.g ?? graded[0]);
      move = { uci: pick.uci, san: pick.san };
      if (gameMove && gameMove.uci !== pick.uci && !deviation) deviation = { ply, played: gameMove.san, recommended: pick.san };
      const dev = developmentReasons(fen, pick.uci, moveNumber, history);
      step = {
        ply,
        color: side,
        fen,
        side: 'yours',
        move,
        acceptable: options,
        candidates: ranked.slice(0, 4).map((r) => ({ uci: r.uci, san: uciToSan(fen, r.uci) ?? r.uci, quality: r.quality, evalForYou: fmtEval(forSide(r.cp)), share: share(r.uci) })),
        inGame: gameMove ? { san: gameMove.san, quality: graded.find((g) => g.uci === gameMove.uci)?.quality ?? 'inaccuracy' } : undefined,
        undeveloped: undevelopedMinors(fen, user),
        castled,
        duties: duties(fen, user),
        idea: dev.reasons.length ? `${pick.san} ${dev.reasons.join(' and ')}.` : `${pick.san} is a sound move here.`,
      };
    } else {
      // Their reply: the game's move while on it, else what your level plays (if sound enough to meet), else Stockfish.
      const popular = lx?.moves[0];
      const reply = gameMove ? { uci: gameMove.uci, san: gameMove.san } : popular ? { uci: popular.uci, san: popular.san } : graded[0];
      move = { uci: reply.uci, san: reply.san };
      step = {
        ply,
        color: side,
        fen,
        side: 'theirs',
        move,
        popular: lx?.moves.slice(0, 3).map((m) => ({ san: m.san, share: m.share })),
        undeveloped: undevelopedMinors(fen, user),
        castled,
        duties: [],
        idea: gameMove ? `${moveLabel(gameMove)} — as in your game.` : popular ? `${reply.san} is the most common reply at your level (${Math.round(popular.share * 100)}%).` : `${reply.san} is Stockfish's choice.`,
      };
    }
    steps.push(step);
    if (gameMove && gameMove.uci !== move.uci) onGame = false;
    try {
      c.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] ?? 'q' });
    } catch {
      break;
    }
    history.push(move.san);
    fen = c.fen();
    // A healthy middlegame: castled, at most one minor at home, after your move.
    const castledNow = history.some((san, i) => i % 2 === (user === 'w' ? 0 : 1) && san.startsWith('O-O'));
    if (side === user && ply >= 14 && castledNow && undevelopedMinors(fen, user).length <= 1) {
      endReason = `You're castled and your pieces are out: a healthy middlegame (Stockfish: ${fmtEval(user === (new Chess(fen).turn() as Color) ? positionCp(await opts.analyse(fen)) : -positionCp(await opts.analyse(fen)))} for you).`;
      break;
    }
  }
  return { name, userColor: user, steps, endReason, deviation, lichess };
}

/** Template texts when no AI coach writes them. */
export function templateOpening(line: Omit<OpeningLesson, 'title' | 'summary' | 'principles' | 'middlegamePlan' | 'traps'>): OpeningLesson {
  const mine = line.steps.filter((s) => s.side === 'yours');
  return {
    ...line,
    title: `A simple plan in the ${line.name}`,
    summary: `Develop your knights and bishops, castle, and only then start operations. ${line.deviation ? `In your game you played ${line.deviation.played} at move ${Math.ceil(line.deviation.ply / 2)}; ${line.deviation.recommended} keeps developing instead.` : ''}`.trim(),
    principles: ['Develop a new piece with each move until all are out.', 'Castle early.', 'Before moving a piece, check what it is guarding.'],
    middlegamePlan: line.endReason,
    traps: [],
    steps: line.steps.map((s) => ({ ...s, idea: s.idea })),
    lichess: line.lichess,
    ...(mine.length ? {} : {}),
  };
}
