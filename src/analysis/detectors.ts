// Deterministic, explainable detectors that turn engine facts + board geometry
// into coaching findings. Each detector is small and conservative: it is
// better to miss a pattern than to invent one.
import { Chess } from 'chess.js';
import type { Color, Finding, MoveEval, PlyRecord, PositionEval } from '../domain/types';
import {
  PIECE_NAME,
  PIECE_VALUE,
  attackedEnemyPieces,
  attackersOf,
  hasCastled,
  isCheckMove,
  isLegal,
  isLoose,
  kingInCenter,
  kingSquare,
  materialAfterLine,
  materialBalance,
  nonPawnMaterial,
  other,
  pieceAt,
  playLine,
  squareName,
  undevelopedMinors,
} from '../chess/board';
import { COLOR_NAME } from '../chess/board';
import { moveLabel } from '../chess/pgn';

export interface DetectorContext {
  plies: PlyRecord[];
  evals: MoveEval[];
  positions: PositionEval[];
  userColor: Color;
  result: string;
}

const CENTER_FILES = new Set(['c', 'd', 'e', 'f']);

function inCheck(fen: string): boolean {
  return new Chess(fen).inCheck();
}

function sev(winDrop: number): 2 | 3 {
  return winDrop >= 25 ? 3 : 2;
}

function label(p: PlyRecord): string {
  return moveLabel(p);
}

/** Opponent's position in development terms, for "those tempi mattered" context. */
function tempoContext(fen: string, opp: Color) {
  const undeveloped = undevelopedMinors(fen, opp);
  return {
    oppUndeveloped: undeveloped.length,
    oppUndevelopedList: undeveloped,
    oppKingInCenter: kingInCenter(fen, opp),
  };
}

// ------------------------------------------------------------ material loss

function firstOpponentCapture(fenAfter: string, replyUci: string[], user: Color) {
  const frames = playLine(fenAfter, replyUci, 5);
  let fen = fenAfter;
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    const mover = k % 2 === 0 ? other(user) : user;
    const victim = pieceAt(fen, f.to);
    if (mover !== user && victim && victim.color === user) {
      return { index: k, square: f.to, type: victim.type, san: f.san, fenBefore: fen };
    }
    fen = f.fen;
  }
  return undefined;
}

function detectMaterialLoss(ctx: DetectorContext, i: number): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const lost = e.materialBefore - e.materialAfterReply;
  const avoidable = e.materialAfterBest - e.materialAfterReply;
  const allowedMate = !!e.mateThreatAgainst && e.cpBefore > -5000;

  if (allowedMate && e.winDrop >= 20) {
    return [
      {
        kind: 'weakness',
        category: 'blunder',
        ply: p.ply,
        severity: 3,
        evidence: `${label(p)} allowed a forced mate (${e.replyLineSan.slice(0, 3).join(' ')}).`,
        facts: { mate: true, replyLine: e.replyLineSan.slice(0, 5), bestSan: e.bestSan },
      },
    ];
  }

  if (lost < 2 || avoidable < 2 || e.winDrop < 12) return [];
  const cap = firstOpponentCapture(p.fenAfter, e.replyLineUci, ctx.userColor);
  const facts = {
    lost,
    replyLine: e.replyLineSan.slice(0, 5),
    bestSan: e.bestSan,
    victimSquare: cap?.square,
    victimPiece: cap ? PIECE_NAME[cap.type] : undefined,
    captureSan: cap?.san,
  };

  if (cap && cap.square === p.to) {
    return [
      {
        kind: 'weakness',
        category: 'blunder',
        ply: p.ply,
        severity: sev(e.winDrop),
        evidence: `${label(p)} put the ${PIECE_NAME[cap.type]} on ${cap.square} where it could be taken (${cap.san}).`,
        facts: { ...facts, movedPieceHung: true },
      },
    ];
  }
  if (cap && cap.index === 0) {
    // The piece taken wasn't the one that moved. Was it already under attack before the move?
    const alreadyLoose = isLoose(p.fenBefore, cap.square) && pieceAt(p.fenBefore, cap.square)?.color === ctx.userColor;
    if (alreadyLoose) {
      const prev = ctx.plies[i - 1];
      return [
        {
          kind: 'weakness',
          category: 'missed_threat',
          ply: p.ply,
          severity: sev(e.winDrop),
          evidence: `Your ${squareName(cap.type, cap.square)} was already under attack${prev ? ` after ${label(prev)}` : ''}, and ${label(p)} didn't deal with it.`,
          facts: { ...facts, threatMove: prev?.san, threatFrom: prev?.to },
        },
      ];
    }
    return [
      {
        kind: 'weakness',
        category: 'blunder',
        ply: p.ply,
        severity: sev(e.winDrop),
        evidence: `After ${label(p)}, the ${squareName(cap.type, cap.square)} was left unprotected (${cap.san}).`,
        facts: { ...facts, leftLoose: true },
      },
    ];
  }
  // Material is lost through a quieter first move: a fork, pin or double attack.
  return [
    {
      kind: 'weakness',
      category: 'calculation',
      ply: p.ply,
      severity: sev(e.winDrop),
      evidence: `${label(p)} allowed ${e.replyLineSan[0]}, which wins material (${e.replyLineSan.slice(0, 4).join(' ')}).`,
      facts: { ...facts, tacticForOpponent: true },
    },
  ];
}

// ------------------------------------------------------------ missed tactic

function detectMissedTactic(ctx: DetectorContext, i: number): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const before = ctx.positions[i];
  const best = before.lines[0];
  if (!best || e.isBest || e.winDrop < 10) return [];

  if (best.score.type === 'mate' && best.score.value > 0 && best.score.value <= 3) {
    return [
      {
        kind: 'weakness',
        category: 'tactical_blindness',
        ply: p.ply,
        severity: 3,
        evidence: `There was a mate in ${best.score.value}: ${e.bestLineSan.slice(0, best.score.value * 2 - 1).join(' ')}.`,
        facts: { mateIn: best.score.value, bestSan: e.bestSan, bestLine: e.bestLineSan },
      },
    ];
  }

  // A "simple" tactic: material is won within the first three plies of the best line.
  const quickGain = materialAfterLine(p.fenBefore, best.pv, ctx.userColor, 3, 1) - e.materialBefore;
  const missed = e.materialAfterBest - e.materialAfterReply;
  if (quickGain < 2 || missed < 2) return [];

  const first = playLine(p.fenBefore, best.pv, 1)[0];
  const target = first ? pieceAt(p.fenBefore, first.to) : undefined;
  const capturing = first ? pieceAt(p.fenBefore, first.from) : undefined;
  const targetLoose = first && target ? isLoose(p.fenBefore, first.to) : false;
  return [
    {
      kind: 'weakness',
      category: 'tactical_blindness',
      ply: p.ply,
      severity: sev(e.winDrop),
      evidence: target
        ? `${e.bestSan} would have won the ${squareName(target.type, first!.to)}${capturing && targetLoose ? ` — your ${PIECE_NAME[capturing.type]} on ${first!.from} was attacking it` : ''}.`
        : `${e.bestSan} would have won material (${e.bestLineSan.slice(0, 3).join(' ')}).`,
      facts: {
        bestSan: e.bestSan,
        bestLine: e.bestLineSan.slice(0, 4),
        gain: quickGain,
        targetSquare: first?.to,
        targetPiece: target ? PIECE_NAME[target.type] : undefined,
        attackerPiece: capturing ? PIECE_NAME[capturing.type] : undefined,
        attackerSquare: first?.from,
        targetLoose,
      },
    },
  ];
}

// --------------------------------------------- round trips & tempo wasting

function detectRoundTrip(ctx: DetectorContext, i: number): Finding[] {
  const p = ctx.plies[i];
  if (p.piece === 'p' || p.piece === 'k' || p.captured || p.ply > 60) return [];
  if (inCheck(p.fenBefore) || isLoose(p.fenBefore, p.from)) return [];

  // The same piece moves again within the next two of our moves.
  let j = -1;
  for (let k = i + 1; k < Math.min(ctx.plies.length, i + 5); k++) {
    const q = ctx.plies[k];
    if (q.color !== ctx.userColor && q.to === p.to) return []; // our piece was captured
    if (q.color === ctx.userColor && q.from === p.to) {
      j = k;
      break;
    }
  }
  if (j < 0) return [];
  const second = ctx.plies[j];
  if (second.captured) return [];
  const a = p.from;
  const c = second.to;
  const direct = c === a || isLegal(p.fenBefore, a + c);
  if (!direct) return [];
  const gained = materialBalance(second.fenAfter, ctx.userColor) - materialBalance(p.fenBefore, ctx.userColor);
  if (gained > 0) return [];

  const opp = other(ctx.userColor);
  const beforeTargets = new Set(attackedEnemyPieces(p.fenBefore, p.from).map((t) => t.square));
  const newTargets = attackedEnemyPieces(p.fenAfter, p.to).filter((t) => !beforeTargets.has(t.square));
  const reply = ctx.plies[i + 1];
  const replyAttacksPiece = reply ? attackersOf(reply.fenAfter, p.to, opp).length > 0 && attackersOf(reply.fenBefore, p.to, opp).length === 0 : false;
  const replyMovedTarget = reply ? newTargets.some((t) => t.square === reply.from) : false;
  const check = isCheckMove(p.san);
  const worse = ctx.evals[j].winDrop > ctx.evals[i].winDrop ? j : i;
  const tempi = c === a ? 2 : 1;

  const facts = {
    piece: PIECE_NAME[p.piece],
    firstSan: p.san,
    firstLabel: label(p),
    secondSan: second.san,
    secondLabel: label(second),
    from: a,
    via: p.to,
    to: c,
    returned: c === a,
    tempiLost: tempi,
    targets: newTargets.map((t) => squareName(t.type, t.square)),
    targetSquares: newTargets.map((t) => t.square),
    replySan: reply?.san,
    replyLabel: reply ? label(reply) : undefined,
    replyAttacksPiece,
    replyMovedTarget,
    check,
    worsePly: ctx.plies[worse].ply,
    betterSan: ctx.evals[worse].bestSan,
    ...tempoContext(p.fenBefore, opp),
  };
  const route = c === a ? `and went back with ${second.san}` : `then ${second.san}; it could have gone to ${c} in one move`;
  const out: Finding[] = [
    {
      kind: 'weakness',
      category: 'inefficient_moves',
      ply: p.ply,
      severity: 2,
      evidence: `${label(p)} ${route} — ${tempi === 2 ? 'two moves' : 'a move'} spent without improving the ${PIECE_NAME[p.piece]}.`,
      relatedPlies: [second.ply],
      facts,
    },
  ];
  if (check) {
    out.push({
      kind: 'weakness',
      category: 'pointless_check',
      ply: p.ply,
      severity: 2,
      evidence: `${label(p)} gave check, but after ${reply?.san ?? 'the reply'} the ${PIECE_NAME[p.piece]} had to move again (${second.san}).`,
      relatedPlies: [second.ply],
      facts,
    });
  } else if (newTargets.length > 0) {
    out.push({
      kind: 'weakness',
      category: 'premature_attack',
      ply: p.ply,
      severity: 2,
      evidence: `${label(p)} attacked the ${facts.targets.join(' and ')}, but ${reply?.san ?? 'a simple reply'} answered it and the ${PIECE_NAME[p.piece]} went back (${second.san}).`,
      relatedPlies: [second.ply],
      facts,
    });
  }
  return out;
}

/** An attack/check that the opponent parries easily while a better move existed. */
function detectAttackWithoutFollowup(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (p.captured || e.winDrop < 10 || p.piece === 'k') return [];
  if (already.some((f) => f.category === 'premature_attack' || f.category === 'pointless_check' || f.category === 'blunder' || f.category === 'missed_threat')) return [];
  if (e.materialAfterReply > e.materialBefore) return [];
  const beforeTargets = new Set(attackedEnemyPieces(p.fenBefore, p.from).map((t) => t.square));
  const targets = attackedEnemyPieces(p.fenAfter, p.to).filter(
    (t) => !beforeTargets.has(t.square) && PIECE_VALUE[t.type] >= 3,
  );
  const check = isCheckMove(p.san);
  if (!check && targets.length === 0) return [];
  const reply = ctx.plies[i + 1];
  const facts = {
    piece: PIECE_NAME[p.piece],
    firstSan: p.san,
    firstLabel: label(p),
    targets: targets.map((t) => squareName(t.type, t.square)),
    targetSquares: targets.map((t) => t.square),
    replySan: reply?.san ?? e.replyLineSan[0],
    engineReplySan: e.replyLineSan[0],
    check,
    betterSan: e.bestSan,
    ...tempoContext(p.fenBefore, other(ctx.userColor)),
  };
  return [
    {
      kind: 'weakness',
      category: check ? 'pointless_check' : 'premature_attack',
      ply: p.ply,
      severity: 2,
      evidence: check
        ? `${label(p)} was a check with no follow-up; ${e.bestSan} was stronger.`
        : `${label(p)} attacked the ${facts.targets.join(' and ')}, but it could simply move away — ${e.bestSan} was stronger.`,
      facts,
    },
  ];
}

// --------------------------------------------------------------- opening

function detectEarlyQueen(ctx: DetectorContext, i: number): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (p.piece !== 'q' || p.captured || p.moveNumber > 10 || inCheck(p.fenBefore)) return [];
  if (isLoose(p.fenBefore, p.from)) return [];
  const undeveloped = undevelopedMinors(p.fenBefore, ctx.userColor);
  if (undeveloped.length < 2) return [];
  const reply = ctx.plies[i + 1];
  const chased =
    !!reply && reply.piece !== 'q' && attackersOf(reply.fenAfter, p.to, other(ctx.userColor)).includes(reply.to as never);
  if (e.winDrop < 6 && !chased) return [];
  return [
    {
      kind: 'weakness',
      category: 'early_queen',
      ply: p.ply,
      severity: e.winDrop >= 12 ? 2 : 1,
      evidence: `${label(p)} moved the queen while ${undeveloped.length} minor pieces were still at home${chased ? `, and ${reply!.san} chased it with tempo` : ''}.`,
      facts: { undeveloped, chasedBy: chased ? reply!.san : undefined, bestSan: e.bestSan },
    },
  ];
}

function detectReleasedTension(ctx: DetectorContext, i: number): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (p.piece !== 'p' || p.captured !== 'p' || p.moveNumber > 15) return [];
  if (!CENTER_FILES.has(p.to[0]) || !['4', '5'].includes(p.to[1])) return [];
  const reply = ctx.plies[i + 1];
  if (!reply || reply.to !== p.to || reply.piece !== 'p') return [];
  // Mutual tension: their pawn on the captured square was also attacking our pawn.
  const theirAttacks = attackedEnemyPieces(p.fenBefore, p.to).map((t) => t.square);
  if (!theirAttacks.includes(p.from)) return [];
  return [
    {
      kind: 'weakness',
      category: 'central_tension',
      ply: p.ply,
      severity: e.winDrop >= 8 ? 2 : 1,
      evidence: `${label(p)} released the central pawn tension; after ${reply.san} the pawns were simply traded.`,
      relatedPlies: [reply.ply],
      facts: { san: p.san, replySan: reply.san, engineFine: e.winDrop < 4, bestSan: e.bestSan },
    },
  ];
}

// ------------------------------------------------------------ king & center

function detectCenterBreak(ctx: DetectorContext, i: number, alreadyFound: boolean): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const opp = other(ctx.userColor);
  if (alreadyFound || p.piece !== 'p' || p.moveNumber < 8 || !CENTER_FILES.has(p.from[0])) return [];
  if (!kingInCenter(p.fenBefore, opp)) return [];
  const myKing = kingSquare(p.fenBefore, ctx.userColor);
  if (!(hasCastled(p.fenBefore, ctx.userColor) || /^[gc]/.test(myKing))) return [];
  // A pawn break: the pawn now attacks an enemy pawn. Plain pawn-for-pawn
  // trades (capture + immediate pawn recapture) don't count.
  const reply = ctx.plies[i + 1];
  const symmetricalTrade = !!p.captured && !!reply && reply.to === p.to && reply.piece === 'p';
  const hitsPawn = attackedEnemyPieces(p.fenAfter, p.to).some((t) => t.type === 'p') || p.captured === 'p';
  if (!hitsPawn || symmetricalTrade) return [];
  if (e.winDrop > 8 || e.winAfter < 55) return [];
  return [
    {
      kind: 'strength',
      category: 'opened_vs_king',
      ply: p.ply,
      severity: 2,
      evidence: `${label(p)} challenged the center while ${COLOR_NAME[opp]}'s king was still on ${kingSquare(p.fenBefore, opp)}.`,
      facts: {
        san: p.san,
        oppKing: kingSquare(p.fenBefore, opp),
        myKing,
        replySan: ctx.plies[i + 1]?.san,
        ...tempoContext(p.fenBefore, opp),
      },
    },
  ];
}

function detectMissedKingAttack(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const opp = other(ctx.userColor);
  if (already.some((f) => f.kind === 'weakness') || e.winDrop < 10 || p.moveNumber < 8 || !e.bestUci) return [];
  if (inCheck(p.fenBefore) || !kingInCenter(p.fenBefore, opp)) return [];
  const bestPiece = pieceAt(p.fenBefore, e.bestUci.slice(0, 2));
  const opening =
    bestPiece?.type === 'p' &&
    CENTER_FILES.has(e.bestUci[0]) &&
    (!!pieceAt(p.fenBefore, e.bestUci.slice(2, 4)) || attackedEnemyPieces(playLine(p.fenBefore, [e.bestUci])[0]?.fen ?? p.fenBefore, e.bestUci.slice(2, 4)).some((t) => t.type === 'p'));
  const forcing = !!e.bestSan && isCheckMove(e.bestSan);
  if (!opening && !forcing) return [];
  return [
    {
      kind: 'weakness',
      category: 'missed_king_attack',
      ply: p.ply,
      severity: 2,
      evidence: `${COLOR_NAME[opp]}'s king was still in the center; ${e.bestSan} would have kept prying the position open.`,
      facts: { bestSan: e.bestSan, bestLine: e.bestLineSan.slice(0, 4), oppKing: kingSquare(p.fenBefore, opp) },
    },
  ];
}

function detectKingShelter(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (p.piece !== 'p' || e.winDrop < 10 || already.some((f) => f.kind === 'weakness')) return [];
  const king = kingSquare(p.fenBefore, ctx.userColor);
  const kingside = /^[fgh]/.test(king);
  const shelterFiles = kingside ? ['f', 'g', 'h'] : /^[abc]/.test(king) ? ['a', 'b', 'c'] : [];
  if (!shelterFiles.includes(p.from[0])) return [];
  return [
    {
      kind: 'weakness',
      category: 'king_safety',
      ply: p.ply,
      severity: 2,
      evidence: `${label(p)} loosened the pawns in front of your king on ${king}.`,
      facts: { king, bestSan: e.bestSan, replyLine: e.replyLineSan.slice(0, 4) },
    },
  ];
}

// -------------------------------------------------------- trades & captures

function detectCaptureDecisions(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (already.some((f) => f.kind === 'weakness')) return [];
  const out: Finding[] = [];
  if (p.captured && e.winDrop >= 10 && e.materialAfterReply - e.materialBefore <= 0) {
    const sameKind = PIECE_VALUE[p.captured] === PIECE_VALUE[p.piece] && p.piece !== 'p';
    out.push({
      kind: 'weakness',
      category: sameKind ? 'poor_trade' : 'premature_capture',
      ply: p.ply,
      severity: e.winDrop >= 15 ? 2 : 1,
      evidence: sameKind
        ? `${label(p)} traded pieces when ${e.bestSan} kept more pressure.`
        : `${label(p)} captured, but it didn't win anything and ${e.bestSan} was stronger.`,
      facts: { san: p.san, bestSan: e.bestSan, replySan: ctx.plies[i + 1]?.san },
    });
  }
  // Ahead in material but avoided a simplifying capture.
  const bestPv = ctx.positions[i].lines[0]?.pv ?? [];
  if (!p.captured && e.materialBefore >= 3 && e.winDrop >= 8 && bestPv[0]) {
    const target = pieceAt(p.fenBefore, bestPv[0].slice(2, 4));
    if (target && target.color !== ctx.userColor && target.type !== 'p') {
      out.push({
        kind: 'weakness',
        category: 'failure_to_simplify',
        ply: p.ply,
        severity: 2,
        evidence: `You were ahead in material; ${e.bestSan} would have traded down toward an easy win.`,
        facts: { bestSan: e.bestSan, materialBefore: e.materialBefore },
      });
    }
  }
  return out;
}

function detectEndgameSlip(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (already.some((f) => f.kind === 'weakness') || e.winDrop < 15) return [];
  if (nonPawnMaterial(p.fenBefore) > 14) return [];
  return [
    {
      kind: 'weakness',
      category: 'endgame',
      ply: p.ply,
      severity: 2,
      evidence: `In the endgame, ${label(p)} let the advantage slip; ${e.bestSan} was the key move.`,
      facts: { bestSan: e.bestSan, bestLine: e.bestLineSan.slice(0, 4) },
    },
  ];
}

function detectCatchAll(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (already.some((f) => f.kind === 'weakness') || e.winDrop < 20) return [];
  return [
    {
      kind: 'weakness',
      category: 'calculation',
      ply: p.ply,
      severity: sev(e.winDrop),
      evidence: `${label(p)} allowed ${e.replyLineSan[0] ?? 'a strong reply'}; ${e.bestSan} was much safer.`,
      facts: { bestSan: e.bestSan, replyLine: e.replyLineSan.slice(0, 4) },
    },
  ];
}

// ------------------------------------------------------------- game-level

function parseTimeControl(tc?: string): { base: number; inc: number } | undefined {
  const m = tc ? /^(\d+)(?:\+(\d+))?$/.exec(tc) : null;
  return m ? { base: Number(m[1]), inc: Number(m[2] ?? 0) } : undefined;
}

function detectClock(ctx: DetectorContext, timeControl?: string): Finding[] {
  const userPlies = ctx.plies.filter((p) => p.color === ctx.userColor && p.clockSeconds !== undefined);
  if (userPlies.length < 5) return [];
  const tc = parseTimeControl(timeControl);
  const base = tc?.base ?? userPlies[0].clockSeconds!;
  const inc = tc?.inc ?? 0;
  const out: Finding[] = [];
  let prev = base;
  let longThink: { ply: PlyRecord; spent: number } | undefined;
  for (const p of userPlies) {
    const spent = prev + inc - p.clockSeconds!;
    prev = p.clockSeconds!;
    const e = ctx.evals[p.ply - 1];
    if (p.moveNumber <= 10 && spent >= Math.max(60, base * 0.12) && e.winDrop < 4 && (!longThink || spent > longThink.spent)) {
      longThink = { ply: p, spent };
    }
  }
  if (longThink) {
    out.push({
      kind: 'weakness',
      category: 'time_management',
      ply: longThink.ply.ply,
      severity: 1,
      evidence: `You spent ${Math.round(longThink.spent)}s on ${label(longThink.ply)}, a routine opening move.`,
      facts: { spent: Math.round(longThink.spent) },
    });
  }
  const lowTime = userPlies.find((p) => p.clockSeconds! < base * 0.1);
  if (lowTime) {
    const mistakesAfter = ctx.evals.filter((e) => e.color === ctx.userColor && e.ply >= lowTime.ply && e.winDrop >= 12).length;
    if (mistakesAfter > 0) {
      out.push({
        kind: 'weakness',
        category: 'time_management',
        ply: lowTime.ply,
        severity: 2,
        evidence: `You were under ${Math.round(lowTime.clockSeconds!)}s by ${label(lowTime)}, and ${mistakesAfter} significant mistake${mistakesAfter > 1 ? 's' : ''} followed.`,
        facts: { clock: Math.round(lowTime.clockSeconds!), mistakesAfter },
      });
    }
  }
  return out;
}

function detectGameLevel(ctx: DetectorContext, moveFindings: Finding[]): Finding[] {
  const user = ctx.userColor;
  const opp = other(user);
  const mine = ctx.plies.filter((p) => p.color === user);
  const out: Finding[] = [];

  const castle = mine.find((p) => p.san.startsWith('O-O'));
  if (castle && castle.moveNumber <= 10) {
    out.push({ kind: 'strength', category: 'castled_early', ply: castle.ply, severity: 2, evidence: `Castled on move ${castle.moveNumber}.`, facts: { san: castle.san, move: castle.moveNumber } });
  } else if (!castle && mine.length >= 14) {
    const at12 = mine.find((p) => p.moveNumber === 12);
    if (at12 && kingInCenter(at12.fenBefore, user) && /[Qq]/.test(at12.fenBefore.split(' ')[0])) {
      out.push({ kind: 'weakness', category: 'king_safety', ply: at12.ply, severity: 2, evidence: 'Your king was still in the center at move 12 with queens on the board.', facts: { notCastled: true } });
    }
  }

  // Development: minors out by move 10?
  const at10 = mine.find((p) => p.moveNumber === 10);
  if (at10) {
    const left = undevelopedMinors(at10.fenAfter, user);
    if (left.length === 0) {
      out.push({ kind: 'strength', category: 'developed_pieces', ply: at10.ply, severity: 2, evidence: 'All minor pieces developed by move 10.', facts: {} });
    } else if (left.length >= 2) {
      out.push({ kind: 'weakness', category: 'development', ply: at10.ply, severity: 2, evidence: `By move 10, ${left.length} minor pieces (${left.join(', ')}) were still at home.`, facts: { undeveloped: left } });
    }
  }

  const firstThree = mine.slice(0, 3).map((p) => p.san);
  const centralPushes = user === 'w' ? ['e4', 'd4'] : ['e5', 'd5', 'c5'];
  const center = firstThree.filter((s) => centralPushes.includes(s));
  if (center.length > 0) {
    out.push({ kind: 'strength', category: 'center_control', ply: mine.find((p) => center.includes(p.san))!.ply, severity: 1, evidence: `Claimed the center early with ${center.join(' and ')}.`, facts: { moves: center } });
  }

  const hangs = moveFindings.filter((f) => (f.category === 'blunder' || f.category === 'missed_threat') && f.severity >= 2);
  if (hangs.length === 0 && mine.length >= 12) {
    out.push({ kind: 'strength', category: 'no_hanging', ply: 0, severity: 2, evidence: 'No pieces left hanging all game.', facts: {} });
  }

  // Punished an opponent mistake: they dropped material, we took it.
  for (let i = 1; i < ctx.plies.length; i++) {
    const p = ctx.plies[i];
    const prevEval = ctx.evals[i - 1];
    const e = ctx.evals[i];
    if (p.color !== user || prevEval.color !== opp) continue;
    if (prevEval.winDrop >= 15 && e.winDrop <= 4 && p.captured && e.materialAfterReply - e.materialBefore >= 2) {
      out.push({ kind: 'strength', category: 'punished_mistake', ply: p.ply, severity: 2, evidence: `${label(p)} took advantage of ${moveLabel(ctx.plies[i - 1])}.`, facts: { san: p.san } });
      break;
    }
  }

  const won = (ctx.result === '1-0' && user === 'w') || (ctx.result === '0-1' && user === 'b');
  const last = ctx.plies[ctx.plies.length - 1];
  if (won && last && materialBalance(last.fenAfter, user) >= 3) {
    out.push({ kind: 'strength', category: 'converted_advantage', ply: 0, severity: 1, evidence: 'Won the game from a material advantage.', facts: {} });
  }
  return out;
}

// ------------------------------------------------------------------ entry

export function detectFindings(ctx: DetectorContext, timeControl?: string): Finding[] {
  const findings: Finding[] = [];
  let centerBreakFound = false;
  for (let i = 0; i < ctx.plies.length; i++) {
    const p = ctx.plies[i];
    if (p.color !== ctx.userColor) continue;
    // Findings from an earlier move that already explain this one (e.g. the retreat in a round trip).
    const inherited = findings.filter((f) => f.relatedPlies?.includes(p.ply));
    const here: Finding[] = [];
    const seen = () => [...inherited, ...here];
    here.push(...detectMaterialLoss(ctx, i));
    here.push(...detectMissedTactic(ctx, i));
    here.push(...detectRoundTrip(ctx, i));
    here.push(...detectAttackWithoutFollowup(ctx, i, seen()));
    here.push(...detectEarlyQueen(ctx, i));
    here.push(...detectReleasedTension(ctx, i));
    const brk = detectCenterBreak(ctx, i, centerBreakFound);
    if (brk.length) centerBreakFound = true;
    here.push(...brk);
    here.push(...detectMissedKingAttack(ctx, i, seen()));
    here.push(...detectKingShelter(ctx, i, seen()));
    here.push(...detectCaptureDecisions(ctx, i, seen()));
    here.push(...detectEndgameSlip(ctx, i, seen()));
    here.push(...detectCatchAll(ctx, i, seen()));
    findings.push(...here);
  }
  findings.push(...detectClock(ctx, timeControl));
  findings.push(...detectGameLevel(ctx, findings));
  return findings;
}
