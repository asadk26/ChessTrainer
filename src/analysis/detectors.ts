// Deterministic, explainable detectors that turn engine facts + board geometry
// into coaching findings. Each detector is small and conservative: it is
// better to miss a pattern than to invent one.
import { Chess } from 'chess.js';
import type { Color, Confidence, Finding, MoveEval, PlyContext, PlyRecord, PositionEval } from '../domain/types';
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
  hasQueen,
  passedPawns,
  relativeRank,
  attackedSquares,
  materialPhrase,
  fileStatus,
  mobility,
  pawnWeaknesses,
  structureScore,
} from '../chess/board';
import { COLOR_NAME } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { pd, scoreToCp, winPercent } from './evaluation';
import { buildContexts, underKingPressure } from './context';
import { describeMove } from './movePurpose';

export interface DetectorContext {
  plies: PlyRecord[];
  evals: MoveEval[];
  positions: PositionEval[];
  userColor: Color;
  result: string;
  /** Practical context per user ply; computed on demand if missing. */
  contexts?: Map<number, PlyContext>;
}

function cx(ctx: DetectorContext, p: PlyRecord): PlyContext | undefined {
  return ctx.contexts?.get(p.ply);
}

/** Context tags stored on findings so templates, the report and the LLM can use them. */
function tags(c?: PlyContext): string[] {
  if (!c) return [];
  const t: string[] = [];
  if (c.farAhead) t.push('far_ahead');
  else if (c.ahead) t.push('ahead');
  if (c.behind) t.push('behind');
  if (c.kingPressure) t.push('king_pressure');
  if (c.attackingKing) t.push('attacking_king');
  if (c.race) t.push('promotion_race');
  else if (c.endgame) t.push('endgame');
  return t;
}

const ofSeverity = (d: number): Confidence => (d >= 12 ? 'high' : 'medium');

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
  const c = cx(ctx, p);
  const d = pd(e);
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
        confidence: 'high',
        evidence: `${label(p)} allowed a forced mate (${e.replyLineSan.slice(0, 3).join(' ')}).`,
        facts: { mate: true, replyLine: e.replyLineSan.slice(0, 5), bestSan: e.bestSan, context: tags(c) },
      },
    ];
  }

  // When already well ahead, even a smaller practical loss of material matters:
  // giving material back is how won games get away.
  const threshold = c?.ahead ? 4 : 12;
  if (lost < 2 || avoidable < 2 || d < threshold) return [];
  const cap = firstOpponentCapture(p.fenAfter, e.replyLineUci, ctx.userColor);
  const facts = {
    lost,
    replyLine: e.replyLineSan.slice(0, 5),
    bestSan: e.bestSan,
    victimSquare: cap?.square,
    victimPiece: cap ? PIECE_NAME[cap.type] : undefined,
    captureSan: cap?.san,
    materialBefore: c?.material ?? e.materialBefore,
    context: tags(c),
  };

  if (c?.ahead) {
    // A capture that hands back more than it takes (e.g. an exchange sacrifice) is a voluntary complication.
    const voluntary = !!p.captured && !!cap && cap.square === p.to && PIECE_VALUE[p.piece] > PIECE_VALUE[p.captured];
    // Losing a whole piece is serious even if the engine still calls the position winning.
    const serious = d >= 8 || lost >= 3;
    return [
      {
        kind: 'weakness',
        category: voluntary ? 'unnecessary_complications' : 'gave_back_material',
        ply: p.ply,
        severity: serious ? sev(d) : 1,
        confidence: serious ? 'high' : 'medium',
        evidence: voluntary
          ? `You were already up ${materialPhrase(facts.materialBefore)}; ${label(p)} gave back material for complications (${e.replyLineSan.slice(0, 3).join(' ')}), when ${e.bestSan} kept things simple.`
          : `You were already up ${materialPhrase(facts.materialBefore)}; after ${label(p)}, ${cap ? `${cap.san} wins your ${PIECE_NAME[cap.type]}` : `${e.replyLineSan[0]} wins material`} and gives part of that lead back.`,
        facts: { ...facts, voluntary },
      },
    ];
  }

  if (cap && cap.square === p.to) {
    return [
      {
        kind: 'weakness',
        category: 'blunder',
        ply: p.ply,
        severity: sev(d),
        confidence: 'high',
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
          severity: sev(d),
          confidence: 'high',
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
        severity: sev(d),
        confidence: 'high',
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
      severity: sev(d),
      confidence: 'high',
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
  if (!best || e.isBest || pd(e) < 10) return [];

  if (best.score.type === 'mate' && best.score.value > 0 && best.score.value <= 3) {
    return [
      {
        kind: 'weakness',
        category: 'tactical_blindness',
        ply: p.ply,
        severity: 3,
        confidence: 'high',
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
      severity: sev(pd(e)),
      confidence: 'high',
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
  const worse = pd(ctx.evals[j]) > pd(ctx.evals[i]) ? j : i;
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
  // How sure are we that the lost tempo actually mattered?
  const pc = cx(ctx, p);
  const worstDrop = Math.max(pd(ctx.evals[i]), pd(ctx.evals[j]));
  const tempoMatters = p.ply <= 40 && (facts.oppUndeveloped > 0 || facts.oppKingInCenter);
  const confidence: Confidence =
    pc?.farAhead || pc?.endgame || pc?.race || (worstDrop < 3 && p.ply > 30)
      ? 'low'
      : tempoMatters && worstDrop >= 8
        ? 'high'
        : 'medium';
  Object.assign(facts, { context: tags(pc) });
  const out: Finding[] = [
    {
      kind: 'weakness',
      category: 'inefficient_moves',
      ply: p.ply,
      severity: 2,
      confidence,
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
      confidence,
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
      confidence,
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
  const c = cx(ctx, p);
  if (p.captured || pd(e) < 10 || p.piece === 'k') return [];
  if (already.some((f) => f.kind === 'weakness' && f.severity >= 2)) return [];
  if (e.materialAfterReply > e.materialBefore) return [];
  const beforeTargets = new Set(attackedEnemyPieces(p.fenBefore, p.from).map((t) => t.square));
  const targets = attackedEnemyPieces(p.fenAfter, p.to).filter(
    (t) => !beforeTargets.has(t.square) && PIECE_VALUE[t.type] >= 3,
  );
  const check = isCheckMove(p.san);
  if (!check && targets.length === 0) return [];
  const reply = ctx.plies[i + 1];
  const opp = other(ctx.userColor);
  // Evidence that the attack really fizzled: the reply hit back at the piece or
  // moved the target, and the piece had to move again soon after.
  const replyHitsPiece = !!reply && attackersOf(reply.fenAfter, p.to, opp).length > 0;
  const replyMovedTarget = !!reply && targets.some((t) => t.square === reply.from);
  const movedAgain = ctx.plies.slice(i + 2, i + 5).some((q) => q.color === ctx.userColor && q.from === p.to);
  const fizzled = (replyHitsPiece || replyMovedTarget || check) && movedAgain;
  const confidence: Confidence = fizzled && !c?.farAhead && !c?.endgame ? 'medium' : 'low';
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
    context: tags(c),
    ...tempoContext(p.fenBefore, opp),
  };
  return [
    {
      kind: 'weakness',
      category: check ? 'pointless_check' : 'premature_attack',
      ply: p.ply,
      severity: 2,
      confidence,
      evidence: check
        ? `${label(p)} was a check with no follow-up; ${e.bestSan} was stronger.`
        : `${label(p)} attacked the ${facts.targets.join(' and ')}, but it could simply move away — ${e.bestSan} was stronger.`,
      facts,
    },
  ];
}

// ------------------------------------------------------ when you're ahead

/** Pawn-grabbing with the queen (or a lone piece) while already well ahead and not yet consolidated. */
function detectHuntingMaterial(ctx: DetectorContext, i: number): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const c = cx(ctx, p);
  if (!c?.ahead || !p.captured || PIECE_VALUE[p.captured] > 1 || p.piece === 'p' || p.piece === 'k') return [];
  const undeveloped = undevelopedMinors(p.fenBefore, ctx.userColor);
  const kingStuck = kingInCenter(p.fenBefore, ctx.userColor) && hasQueen(p.fenBefore, other(ctx.userColor)) && p.moveNumber >= 8;
  if (undeveloped.length < 2 && !kingStuck && !c.kingPressure) return [];
  const d = pd(e);
  // Both warning signs at once (pieces at home AND king in the center) are strong evidence by themselves.
  const bothSigns = undeveloped.length >= 2 && kingStuck;
  const confidence: Confidence = d >= 5 && (undeveloped.length >= 2 || kingStuck) ? 'high' : d >= 3 || bothSigns ? 'medium' : 'low';
  const homework = [undeveloped.length ? `${undeveloped.join(' and ')} still at home` : '', kingStuck ? 'your king still in the center' : '']
    .filter(Boolean)
    .join(' and ');
  return [
    {
      kind: 'weakness',
      category: 'hunting_material',
      ply: p.ply,
      severity: d >= 5 || (bothSigns && d >= 2) ? 2 : 1,
      confidence,
      evidence: `${label(p)} grabbed another pawn while you were already up ${materialPhrase(c.material)}, with ${homework}. Consolidating (${e.bestSan}) was the priority.`,
      facts: { bestSan: e.bestSan, undeveloped, kingStuck, material: c.material, context: tags(c) },
    },
  ];
}

/** Ahead, but the move lets the opponent's pieces become active against your king or force a draw. */
function detectAllowedCounterplay(ctx: DetectorContext, i: number, here: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const c = cx(ctx, p);
  const d = pd(e);
  if (!c?.ahead || d < 10 || here.some((f) => f.kind === 'weakness' && f.severity >= 2 && f.confidence !== 'low')) return [];
  const oppChecks = e.replyLineSan.filter((san, k) => k % 2 === 0 && isCheckMove(san)).length;
  const afterTwo = playLine(p.fenAfter, e.replyLineUci, 2).at(-1)?.fen ?? p.fenAfter;
  const pressureNow = underKingPressure(afterTwo, ctx.userColor);
  if (oppChecks === 0 && !(pressureNow && !c.kingPressure)) return [];
  const drawish = Math.abs(e.cpAfter) <= 60 && oppChecks >= 2;
  const opp = COLOR_NAME[other(ctx.userColor)];
  return [
    {
      kind: 'weakness',
      category: 'allowed_counterplay',
      ply: p.ply,
      severity: sev(d),
      confidence: ofSeverity(d),
      evidence: drawish
        ? `You were up ${materialPhrase(c.material)}, but after ${label(p)} ${opp} could start checking your king (${e.replyLineSan.slice(0, 3).join(' ')}) and force a draw. ${e.bestSan} kept everything under control.`
        : `You were up ${materialPhrase(c.material)}, but ${label(p)} let ${opp}'s pieces become active against your king (${e.replyLineSan.slice(0, 3).join(' ')}). ${e.bestSan} kept everything under control.`,
      facts: { bestSan: e.bestSan, replyLine: e.replyLineSan.slice(0, 5), drawish, material: c.material, context: tags(c) },
    },
  ];
}

/** Ahead with queens on, and the engine offered a queen trade (or a simplifying capture) that was skipped. */
function detectMissedSimplification(ctx: DetectorContext, i: number, here: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const c = cx(ctx, p);
  const d = pd(e);
  if (!c?.ahead || p.captured || d < 5 || here.some((f) => f.kind === 'weakness' && f.severity >= 2)) return [];
  const pos = ctx.positions[i];
  const bestCp = pos.lines[0] ? scoreToCp(pos.lines[0].score) : 0;
  const queensOn = hasQueen(p.fenBefore, 'w') && hasQueen(p.fenBefore, 'b');
  // A near-best engine line that trades queens within four plies.
  const tradeLine = queensOn
    ? pos.lines.find((l) => {
        if (bestCp - scoreToCp(l.score) > 60) return false;
        const end = playLine(p.fenBefore, l.pv, 4).at(-1)?.fen;
        return !!end && !hasQueen(end, 'w') && !hasQueen(end, 'b');
      })
    : undefined;
  // Or the best move is simply a capture of a piece that trades down.
  const bestTarget = pos.lines[0] ? pieceAt(p.fenBefore, pos.lines[0].pv[0].slice(2, 4)) : undefined;
  const simplifyingCapture = !!bestTarget && bestTarget.color !== ctx.userColor && bestTarget.type !== 'p' && e.materialAfterBest >= e.materialBefore;
  if (!tradeLine && !(simplifyingCapture && d >= 8)) return [];
  const tradeSans = tradeLine ? playLine(p.fenBefore, tradeLine.pv, 4).map((f) => f.san) : [];
  const tradeSan = tradeSans[0] ?? e.bestSan;
  return [
    {
      kind: 'weakness',
      category: 'failure_to_simplify',
      ply: p.ply,
      severity: d >= 8 ? 2 : 1,
      confidence: d >= 8 ? 'high' : 'medium',
      evidence: tradeLine
        ? `You were up ${materialPhrase(c.material)} with queens still on. ${label(p)} kept them on, while ${tradeSans.join(' ')} trades queens and takes the danger out of the position.`
        : `You were up ${materialPhrase(c.material)}; ${e.bestSan} would have traded down toward an easy win.`,
      facts: { bestSan: tradeSan, tradeLine: tradeSans, queenTrade: !!tradeLine, material: c.material, context: tags(c) },
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
  if (pd(e) < 6 && !chased) return [];
  return [
    {
      kind: 'weakness',
      category: 'early_queen',
      ply: p.ply,
      severity: pd(e) >= 12 ? 2 : 1,
      confidence: pd(e) >= 12 ? 'medium' : chased ? 'medium' : 'low',
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
      severity: pd(e) >= 8 ? 2 : 1,
      confidence: 'medium',
      evidence: `${label(p)} released the central pawn tension; after ${reply.san} the pawns were simply traded.`,
      relatedPlies: [reply.ply],
      facts: { san: p.san, replySan: reply.san, engineFine: pd(e) < 4, bestSan: e.bestSan },
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
  if (pd(e) > 8 || e.winAfter < 55) return [];
  return [
    {
      kind: 'strength',
      category: 'opened_vs_king',
      ply: p.ply,
      severity: 2,
      confidence: 'high',
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
  if (already.some((f) => f.kind === 'weakness') || pd(e) < 10 || p.moveNumber < 8 || !e.bestUci) return [];
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
      confidence: pd(e) >= 15 ? 'medium' : 'low',
      evidence: `${COLOR_NAME[opp]}'s king was still in the center; ${e.bestSan} would have kept prying the position open.`,
      facts: { bestSan: e.bestSan, bestLine: e.bestLineSan.slice(0, 4), oppKing: kingSquare(p.fenBefore, opp) },
    },
  ];
}

function detectKingShelter(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (p.piece !== 'p' || pd(e) < 6 || already.some((f) => f.kind === 'weakness')) return [];
  const king = kingSquare(p.fenBefore, ctx.userColor);
  const kingside = /^[fgh]/.test(king);
  const shelterFiles = kingside ? ['f', 'g', 'h'] : /^[abc]/.test(king) ? ['a', 'b', 'c'] : [];
  if (!shelterFiles.includes(p.from[0])) return [];
  // Enemy pawns already advancing on that wing: a pawn storm, where pushing your own pawns opens lines for them.
  const opp = other(ctx.userColor);
  const storm = new Chess(p.fenBefore)
    .board()
    .flat()
    .filter((x) => x && x.type === 'p' && x.color === opp && shelterFiles.includes(x.square[0]) && relativeRank(x.square, opp) >= 4)
    .map((x) => x!.square);
  if (pd(e) < 10 && storm.length < 2) return [];
  return [
    {
      kind: 'weakness',
      category: 'king_safety',
      ply: p.ply,
      severity: 2,
      confidence: pd(e) >= 15 ? 'high' : 'medium',
      evidence: storm.length >= 2
        ? `${label(p)} pushed a pawn in front of your own king on ${king} while ${COLOR_NAME[opp]}'s pawns (${storm.join(', ')}) were storming toward it — that opens lines for the attack.`
        : `${label(p)} loosened the pawns in front of your king on ${king}.`,
      facts: { king, bestSan: e.bestSan, replyLine: e.replyLineSan.slice(0, 4), storm },
    },
  ];
}

// -------------------------------------------------------- trades & captures

function detectCaptureDecisions(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (already.some((f) => f.kind === 'weakness')) return [];
  const out: Finding[] = [];
  if (p.captured && pd(e) >= 10 && e.materialAfterReply - e.materialBefore <= 0) {
    const sameKind = PIECE_VALUE[p.captured] === PIECE_VALUE[p.piece] && p.piece !== 'p';
    out.push({
      kind: 'weakness',
      category: sameKind ? 'poor_trade' : 'premature_capture',
      ply: p.ply,
      severity: pd(e) >= 15 ? 2 : 1,
      confidence: pd(e) >= 15 ? 'medium' : 'low',
      evidence: sameKind
        ? `${label(p)} traded pieces when ${e.bestSan} kept more pressure.`
        : `${label(p)} captured, but it didn't win anything and ${e.bestSan} was stronger.`,
      facts: { san: p.san, bestSan: e.bestSan, replySan: ctx.plies[i + 1]?.san },
    });
  }
  return out;
}

function detectEndgameSlip(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const c = cx(ctx, p);
  const d = pd(e);
  if (already.some((f) => f.kind === 'weakness' && f.severity >= 2) || d < 12) return [];
  if (!(c?.endgame || c?.race || nonPawnMaterial(p.fenBefore) <= 14)) return [];
  // Does the better move help one of our passed pawns (push it, or cover its path)?
  const passed = passedPawns(p.fenBefore, ctx.userColor);
  const bestFrame = e.bestUci ? playLine(p.fenBefore, [e.bestUci])[0] : undefined;
  let supportsPawn: string | undefined;
  if (bestFrame && passed.length) {
    const covered = new Set(attackedSquares(bestFrame.fen, bestFrame.to));
    for (const sq of passed) {
      const dir = ctx.userColor === 'w' ? 1 : -1;
      const path: string[] = [];
      for (let r = Number(sq[1]) + dir; r >= 1 && r <= 8; r += dir) path.push(`${sq[0]}${r}`);
      if (e.bestUci!.slice(0, 2) === sq || path.some((x) => covered.has(x))) supportsPawn = sq;
    }
  }
  return [
    {
      kind: 'weakness',
      category: 'endgame',
      ply: p.ply,
      severity: 2,
      confidence: d >= 15 ? 'high' : 'medium',
      evidence: supportsPawn
        ? `In this endgame your passed pawn on ${supportsPawn} was the whole story. ${label(p)} didn't help it; ${e.bestSan} would have supported its advance.`
        : `In the endgame, ${label(p)} let the advantage slip; ${e.bestSan} was the key move.`,
      facts: { bestSan: e.bestSan, bestLine: e.bestLineSan.slice(0, 4), passedPawn: supportsPawn, context: tags(c) },
    },
  ];
}

function detectCatchAll(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  if (already.some((f) => f.kind === 'weakness') || pd(e) < 20) return [];
  return [
    {
      kind: 'weakness',
      category: 'calculation',
      ply: p.ply,
      severity: sev(pd(e)),
      confidence: 'medium',
      evidence: `${label(p)} allowed ${e.replyLineSan[0] ?? 'a strong reply'}; ${e.bestSan} was much safer.`,
      facts: { bestSan: e.bestSan, replyLine: e.replyLineSan.slice(0, 4) },
    },
  ];
}

// ------------------------------------------------------ positional (conservative)

/** A pawn move/capture that leaves you with a doubled or isolated pawn the better move avoided. */
function detectPawnStructure(ctx: DetectorContext, i: number, already: Finding[]): Finding[] {
  const p = ctx.plies[i];
  const e = ctx.evals[i];
  const d = pd(e);
  if (d < 3 || already.some((f) => f.kind === 'weakness' && f.severity >= 2)) return [];
  const us = ctx.userColor;
  // Compare after the opponent's best reply, so recaptures settle.
  const settle = (fen: string, pv: string[]) => playLine(fen, pv, 1).at(-1)?.fen ?? fen;
  const playedEnd = settle(p.fenAfter, e.replyLineUci);
  const best = ctx.positions[i].lines[0];
  if (!best) return [];
  const bestFrames = playLine(p.fenBefore, best.pv, 2);
  const bestEnd = bestFrames.at(-1)?.fen ?? p.fenBefore;
  const before = structureScore(p.fenBefore, us);
  const playedScore = structureScore(playedEnd, us);
  if (playedScore <= before || structureScore(bestEnd, us) > before) return [];
  const w = pawnWeaknesses(playedEnd, us);
  const what = w.doubled.length ? `doubled pawns on the ${w.doubled[0][0]}-file` : `an isolated pawn on ${w.isolated[0]}`;
  return [
    {
      kind: 'weakness',
      category: 'pawn_structure',
      ply: p.ply,
      severity: d >= 8 ? 2 : 1,
      confidence: 'medium',
      evidence: `After ${label(p)} you're left with ${what}; ${e.bestSan} kept your pawns healthy.`,
      facts: { bestSan: e.bestSan, weakness: what },
    },
  ];
}

/** A piece with almost no squares for many moves, while the engine kept wanting to activate it. */
function detectPassivePieces(ctx: DetectorContext): Finding[] {
  const us = ctx.userColor;
  const mine = ctx.plies.map((p, i) => ({ p, i })).filter(({ p }) => p.color === us && p.moveNumber >= 8 && p.moveNumber <= 35);
  const out: Finding[] = [];
  const reported = new Set<string>();
  for (let a = 0; a < mine.length; a++) {
    const start = mine[a];
    const pieces = new Chess(start.p.fenBefore)
      .board()
      .flat()
      .filter((x) => x && x.color === us && (x.type === 'b' || x.type === 'r' || x.type === 'n'));
    for (const piece of pieces) {
      const sqr = piece!.square;
      if (reported.has(sqr) || mobility(start.p.fenBefore, sqr) > 2) continue;
      // The same piece stays put and passive for ≥5 of our moves...
      let len = 0;
      let wanted = 0;
      let wantedSan: string | undefined;
      for (let b = a; b < mine.length; b++) {
        const { p, i } = mine[b];
        const here = pieceAt(p.fenBefore, sqr);
        if (!here || here.type !== piece!.type || here.color !== us || mobility(p.fenBefore, sqr) > 2) break;
        len++;
        // ...while the engine's best move would have moved it (or freed it).
        const bestUci = ctx.positions[i].lines[0]?.pv[0];
        if (bestUci?.startsWith(sqr) && p.uci !== bestUci) {
          wanted++;
          wantedSan ??= ctx.evals[i].bestSan;
        }
        if (p.from === sqr) break;
      }
      if (len >= 5 && wanted >= 2) {
        reported.add(sqr);
        const name = PIECE_NAME[piece!.type as keyof typeof PIECE_NAME];
        out.push({
          kind: 'weakness',
          category: 'passive_piece',
          ply: start.p.ply,
          severity: 2,
          confidence: 'medium',
          evidence: `Your ${name} on ${sqr} had almost no squares for ${len} moves (from move ${start.p.moveNumber}); bringing it into play${wantedSan ? ` (e.g. ${wantedSan})` : ''} was overdue.`,
          facts: { square: sqr, piece: name, moves: len, bestSan: wantedSan },
        });
      }
    }
  }
  return out.slice(0, 1);
}

/** The same piece chased by enemy pawns move after move: each push gains space with tempo. */
function detectChasedPiece(ctx: DetectorContext): Finding[] {
  const us = ctx.userColor;
  for (let i = 0; i < ctx.plies.length - 3; i++) {
    const first = ctx.plies[i];
    if (first.color !== us || first.piece === 'p' || first.piece === 'k' || first.captured) continue;
    const chain = [first];
    let sq = first.to;
    let k = i;
    // reply: a pawn move that attacks our piece; then we move that piece again.
    while (k + 2 < ctx.plies.length) {
      const reply = ctx.plies[k + 1];
      const again = ctx.plies[k + 2];
      if (reply.piece !== 'p' || !attackersOf(reply.fenAfter, sq, reply.color).includes(reply.to as never) || again.from !== sq) break;
      chain.push(reply, again);
      sq = again.to;
      k += 2;
    }
    const pushes = chain.filter((p) => p.color !== us);
    if (pushes.length < 2) continue;
    const drop = chain.filter((p) => p.color === us).reduce((a, p) => a + pd(ctx.evals[p.ply - 1]), 0);
    const king = kingSquare(first.fenBefore, us);
    const towardKing = pushes.every((p) => Math.abs(p.to.charCodeAt(0) - king.charCodeAt(0)) <= 2);
    if (drop < 6 && !towardKing) continue;
    const name = PIECE_NAME[first.piece];
    const seq = chain.map((p) => moveLabel(p)).join(' ');
    return [
      {
        kind: 'weakness',
        category: 'inefficient_moves',
        ply: first.ply,
        severity: 2,
        confidence: towardKing && drop >= 6 ? 'high' : 'medium',
        relatedPlies: chain.slice(1).filter((p) => p.color === us).map((p) => p.ply),
        evidence: `Your ${name} was chased by pawns (${seq}). Each pawn move gained space${towardKing ? ` toward your king` : ''} with tempo, and the ${name} ended up no better placed.`,
        facts: { piece: name, chased: true, pushes: pushes.map((p) => p.san), towardKing, secondSan: chain[2]?.san },
      },
    ];
  }
  return [];
}

/** Credit: a move that sets up a clear tactic (fork, winning material), found in the game. */
function detectTacticFound(ctx: DetectorContext): Finding[] {
  let best: { f: Finding; gain: number } | undefined;
  for (let i = 0; i < ctx.plies.length; i++) {
    const p = ctx.plies[i];
    const e = ctx.evals[i];
    // A forced reply to check is not "finding" a tactic.
    if (p.color !== ctx.userColor || pd(e) > 3 || inCheck(p.fenBefore)) continue;
    const pos = ctx.positions[i];
    const line = pos.lines.find((l) => l.pv[0] === p.uci);
    const d = describeMove({ fen: p.fenBefore, uci: p.uci, pv: line?.pv ?? [p.uci, ...e.replyLineUci], context: cx(ctx, p) });
    const hit = d?.purposes.find((x) => (x.id === 'double_attack' || x.id === 'win_material') && x.confidence === 'high');
    // Only quiet set-ups or forks — a plain recapture isn't a "found tactic".
    if (!hit || (p.captured && hit.id === 'win_material' && (hit.plies ?? 1) <= 1)) continue;
    const gain = e.materialAfterReply - e.materialBefore;
    if (gain < 2) continue;
    if (!best || gain > best.gain)
      best = {
        gain,
        f: {
          kind: 'strength',
          category: 'found_tactic',
          ply: p.ply,
          severity: 2,
          confidence: 'high',
          evidence: `${label(p)} ${hit.text} — a real tactic, and you found it.`,
          facts: { san: p.san },
        },
      };
  }
  return best ? [best.f] : [];
}

/** Credit: a rook placed on an open file. */
function detectRookOnOpenFile(ctx: DetectorContext): Finding[] {
  for (let i = 0; i < ctx.plies.length; i++) {
    const p = ctx.plies[i];
    if (p.color !== ctx.userColor || p.piece !== 'r' || p.moveNumber < 10 || p.from[0] === p.to[0]) continue;
    if (pd(ctx.evals[i]) > 3) continue;
    if (fileStatus(p.fenAfter, p.to[0], ctx.userColor) !== 'open') continue;
    return [
      {
        kind: 'strength',
        category: 'rook_open_file',
        ply: p.ply,
        severity: 1,
        confidence: 'high',
        evidence: `${label(p)} put your rook on the open ${p.to[0]}-file.`,
        facts: { file: p.to[0] },
      },
    ];
  }
  return [];
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
    if (p.moveNumber <= 10 && spent >= Math.max(60, base * 0.12) && pd(e) < 4 && (!longThink || spent > longThink.spent)) {
      longThink = { ply: p, spent };
    }
  }
  if (longThink) {
    out.push({
      kind: 'weakness',
      category: 'time_management',
      ply: longThink.ply.ply,
      severity: 1,
      confidence: 'medium',
      evidence: `You spent ${Math.round(longThink.spent)}s on ${label(longThink.ply)}, a routine opening move.`,
      facts: { spent: Math.round(longThink.spent) },
    });
  }
  const lowTime = userPlies.find((p) => p.clockSeconds! < base * 0.1);
  if (lowTime) {
    const mistakesAfter = ctx.evals.filter((e) => e.color === ctx.userColor && e.ply >= lowTime.ply && pd(e) >= 12).length;
    if (mistakesAfter > 0) {
      out.push({
        kind: 'weakness',
        category: 'time_management',
        ply: lowTime.ply,
        severity: 2,
        confidence: 'high',
        evidence: `You were under ${Math.round(lowTime.clockSeconds!)}s by ${label(lowTime)}, and ${mistakesAfter} significant mistake${mistakesAfter > 1 ? 's' : ''} followed.`,
        facts: { clock: Math.round(lowTime.clockSeconds!), mistakesAfter },
      });
    }
  }
  return out;
}

function detectGameLevel(ctx: DetectorContext, moveFindings: Finding[]): Finding[] {
  const user = ctx.userColor;
  const mine = ctx.plies.filter((p) => p.color === user);
  const out: Finding[] = [];
  const aheadAt = (p: PlyRecord) => cx(ctx, p)?.ahead ?? false;

  const castle = mine.find((p) => p.san.startsWith('O-O'));
  if (castle && castle.moveNumber <= 10) {
    out.push({ kind: 'strength', category: 'castled_early', ply: castle.ply, severity: 2, confidence: 'high', evidence: `Castled on move ${castle.moveNumber}.`, facts: { san: castle.san, move: castle.moveNumber } });
  } else if (mine.length >= 14) {
    const at12 = mine.find((p) => p.moveNumber === 12);
    if (at12 && kingInCenter(at12.fenBefore, user) && /[Qq]/.test(at12.fenBefore.split(' ')[0])) {
      const ahead = aheadAt(at12);
      out.push({
        kind: 'weakness',
        category: 'king_safety',
        ply: at12.ply,
        severity: 2,
        confidence: 'high',
        evidence: ahead
          ? 'Your king was still in the center at move 12 with queens on the board — even though you were already ahead, which is exactly when getting safe matters most.'
          : 'Your king was still in the center at move 12 with queens on the board.',
        facts: { notCastled: true, ahead },
      });
    }
  }

  // Development: minors out by move 10?
  const at10 = mine.find((p) => p.moveNumber === 10);
  if (at10) {
    const left = undevelopedMinors(at10.fenAfter, user);
    if (left.length === 0) {
      out.push({ kind: 'strength', category: 'developed_pieces', ply: at10.ply, severity: 2, confidence: 'high', evidence: 'All minor pieces developed by move 10.', facts: {} });
    } else if (left.length >= 2) {
      const ahead = aheadAt(at10);
      out.push({
        kind: 'weakness',
        category: 'development',
        ply: at10.ply,
        severity: 2,
        confidence: 'high',
        evidence: ahead
          ? `By move 10 you were already up ${materialPhrase(cx(ctx, at10)!.material)}, but ${left.join(' and ')} were still at home. With a big lead, finishing development is the fastest way to make it count.`
          : `By move 10, ${left.length} minor pieces (${left.join(', ')}) were still at home.`,
        facts: { undeveloped: left, ahead },
      });
    }
  }

  const firstThree = mine.slice(0, 3).map((p) => p.san);
  const centralPushes = user === 'w' ? ['e4', 'd4'] : ['e5', 'd5', 'c5'];
  const center = firstThree.filter((s) => centralPushes.includes(s));
  if (center.length > 0) {
    out.push({ kind: 'strength', category: 'center_control', ply: mine.find((p) => center.includes(p.san))!.ply, severity: 1, confidence: 'medium', evidence: `Claimed the center early with ${center.join(' and ')}.`, facts: { moves: center } });
  }

  const hangs = moveFindings.filter(
    (f) => (f.category === 'blunder' || f.category === 'missed_threat' || f.category === 'gave_back_material') && f.severity >= 2,
  );
  if (hangs.length === 0 && mine.length >= 12) {
    out.push({ kind: 'strength', category: 'no_hanging', ply: 0, severity: 2, confidence: 'high', evidence: 'No pieces left hanging all game.', facts: {} });
  }

  out.push(...detectPracticalStrengths(ctx));

  const won = (ctx.result === '1-0' && user === 'w') || (ctx.result === '0-1' && user === 'b');
  const last = ctx.plies[ctx.plies.length - 1];
  if (won && last && materialBalance(last.fenAfter, user) >= 3) {
    out.push({ kind: 'strength', category: 'converted_advantage', ply: 0, severity: 1, confidence: 'high', evidence: 'Won the game from a material advantage.', facts: {} });
  }
  return out;
}

/** Credit good practical decisions — not just the absence of mistakes. */
function detectPracticalStrengths(ctx: DetectorContext): Finding[] {
  const user = ctx.userColor;
  const opp = other(user);
  const out: Finding[] = [];
  const free: number[] = [];
  const simplified: number[] = [];
  const defended: number[] = [];
  let passed: { ply: number; square: string } | undefined;
  let neutralized: number | undefined;

  for (let i = 0; i < ctx.plies.length; i++) {
    const p = ctx.plies[i];
    if (p.color !== user) continue;
    const e = ctx.evals[i];
    const c = cx(ctx, p);
    const d = pd(e);

    // Genuinely free material: the capture nets ≥2 compared with before the
    // opponent's last move (so recaptures don't count) and the gain holds.
    if (p.captured && d <= 5) {
      const base = i > 0 ? materialBalance(ctx.plies[i - 1].fenBefore, user) : materialBalance(p.fenBefore, user);
      const now = materialBalance(p.fenAfter, user);
      if (now - base >= 2 && e.materialAfterReply >= now - 1) free.push(p.ply);
    }

    // Simplifying when ahead: pieces come off over the next two plies, the lead stays.
    const after2 = ctx.plies[i + 2];
    if (c?.ahead && after2 && d <= 8 && pd(ctx.evals[i + 2]) <= 8) {
      const piecesOff = nonPawnMaterial(p.fenBefore) - nonPawnMaterial(after2.fenAfter);
      if (piecesOff >= 6 && materialBalance(after2.fenAfter, user) >= c.material - 1) simplified.push(p.ply);
    }

    // A forcing defensive resource: under pressure or behind, the only move that holds.
    const pos = ctx.positions[i];
    if ((c?.kingPressure || c?.behind || e.cpBefore <= -150) && pos.lines.length >= 2 && d <= 2) {
      const gap = winPercent(scoreToCp(pos.lines[0].score)) - winPercent(scoreToCp(pos.lines[1].score));
      const recapture = i > 0 && !!ctx.plies[i - 1].captured && ctx.plies[i - 1].to === p.to;
      const forcing = !recapture && (isCheckMove(p.san) || !!p.captured || p.piece === 'k' || inCheck(p.fenBefore));
      if (gap >= 12 && forcing && e.isBest) defended.push(p.ply);
    }

    // Creating a dangerous passed pawn.
    if (!passed && p.piece === 'p' && p.moveNumber >= 15 && d <= 5 && relativeRank(p.to, user) >= 5 && passedPawns(p.fenAfter, user).includes(p.to)) {
      passed = { ply: p.ply, square: p.to };
    }

    // Neutralising counterplay: under pressure before, safe two plies later, via a trade/check/capture.
    if (neutralized === undefined && c?.kingPressure && after2 && d <= 5) {
      const traded = nonPawnMaterial(p.fenBefore) - nonPawnMaterial(after2.fenAfter) >= 6;
      if ((traded || isCheckMove(p.san) || p.captured) && !underKingPressure(after2.fenAfter, user)) neutralized = p.ply;
    }
  }

  const lbl = (ply: number) => label(ctx.plies[ply - 1]);
  if (free.length) {
    out.push({
      kind: 'strength',
      category: 'won_free_material',
      ply: free[0],
      severity: 2,
      confidence: 'high',
      relatedPlies: free.slice(1, 3),
      evidence: `You spotted and took genuinely free material: ${free.slice(0, 3).map(lbl).join(', ')}.`,
      facts: { moves: free.slice(0, 3).map(lbl) },
    });
  }
  if (simplified.length) {
    out.push({
      kind: 'strength',
      category: 'simplified_when_ahead',
      ply: simplified[0],
      severity: 2,
      confidence: 'high',
      relatedPlies: simplified.slice(1, 2),
      evidence: `While ahead, you traded pieces to simplify: ${simplified.slice(0, 2).map(lbl).join(' and ')}.`,
      facts: { moves: simplified.slice(0, 2).map(lbl) },
    });
  }
  if (defended.length) {
    out.push({
      kind: 'strength',
      category: 'defensive_resource',
      ply: defended[0],
      severity: 2,
      confidence: 'high',
      relatedPlies: defended.slice(1, 2),
      evidence: `Under pressure you found the one move that held: ${defended.slice(0, 2).map(lbl).join(' and ')}.`,
      facts: { moves: defended.slice(0, 2).map(lbl) },
    });
  }
  if (passed) {
    const promo = ctx.plies.find((q) => q.color === user && q.ply > passed!.ply && q.promotion && q.from[0] === passed!.square[0]);
    out.push({
      kind: 'strength',
      category: 'passed_pawn',
      ply: passed.ply,
      severity: 2,
      confidence: 'high',
      relatedPlies: promo ? [promo.ply] : undefined,
      evidence: `${lbl(passed.ply)} created a dangerous passed pawn${promo ? `, and you pushed it all the way to promotion (${lbl(promo.ply)})` : ''}.`,
      facts: { square: passed.square, promoted: !!promo },
    });
  }
  if (neutralized !== undefined) {
    out.push({
      kind: 'strength',
      category: 'neutralized_counterplay',
      ply: neutralized,
      severity: 2,
      confidence: 'high',
      evidence: `${lbl(neutralized)} took the sting out of ${COLOR_NAME[opp]}'s attack on your king.`,
      facts: {},
    });
  }
  return out;
}

// ------------------------------------------------------------------ entry

export function detectFindings(ctx: DetectorContext, timeControl?: string): Finding[] {
  if (!ctx.contexts) ctx = { ...ctx, contexts: buildContexts(ctx.plies, ctx.evals, ctx.userColor) };
  const findings: Finding[] = [];
  let centerBreakFound = false;
  for (let i = 0; i < ctx.plies.length; i++) {
    const p = ctx.plies[i];
    if (p.color !== ctx.userColor) continue;
    // Findings from an earlier move that already explain this one (e.g. the retreat in a round trip).
    // They only suppress the softer pattern detectors — never a real material or counterplay loss.
    const inherited = findings.filter((f) => f.relatedPlies?.includes(p.ply) && f.kind === 'weakness');
    const here: Finding[] = [];
    const seen = () => [...inherited, ...here];
    here.push(...detectMaterialLoss(ctx, i));
    here.push(...detectMissedTactic(ctx, i));
    here.push(...detectAllowedCounterplay(ctx, i, here));
    here.push(...detectHuntingMaterial(ctx, i));
    here.push(...detectMissedSimplification(ctx, i, here));
    here.push(...detectEndgameSlip(ctx, i, here));
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
    here.push(...detectPawnStructure(ctx, i, seen()));
    here.push(...detectCatchAll(ctx, i, here));
    findings.push(...here);
  }
  findings.push(...detectClock(ctx, timeControl));
  findings.push(...detectPassivePieces(ctx));
  findings.push(...detectChasedPiece(ctx));
  findings.push(...detectTacticFound(ctx));
  findings.push(...detectRookOnOpenFile(ctx));
  findings.push(...detectGameLevel(ctx, findings));
  return findings;
}
