// Three-part explanations for a teaching moment, built from board facts:
//   1. what your move was going for,
//   2. what practical problem it caused (a mistake) — or that nothing went
//      wrong but something better was available (a missed opportunity),
//   3. why the better move is better, in human terms.
// Anything that can't be inferred reliably is left out.
import type { Finding, MoveEval, MoveExplanation, PlyContext, PlyRecord, PositionEval } from '../domain/types';
import { COLOR_NAME, PIECE_NAME, attackersOf, kingZoneAttacks, lineToSan, other, passTurn, pawnShield, pieceAt, playLine, structureScore } from '../chess/board';
import { underKingPressure } from './context';
import { describeMove, joinList, type Purpose, type PurposeId } from './movePurpose';
import { pd, scoreToCp } from './evaluation';

export type { MoveExplanation };

/** Purposes strong enough to show the short engine line as evidence. */
const CONCRETE: PurposeId[] = ['mate', 'win_material', 'double_attack', 'stop_threat', 'trade_queens', 'promote'];

export interface ExplainInput {
  plies: PlyRecord[];
  evals: MoveEval[];
  positions: PositionEval[];
  contexts: Map<number, PlyContext>;
  ply: number;
  /** Position where the better move should be explained (e.g. the retreat in a round trip). */
  betterPly?: number;
  findings: Finding[];
}

function firstCaptureOfOurs(fenAfter: string, replyUci: string[], us: 'w' | 'b') {
  const frames = playLine(fenAfter, replyUci, 4);
  let fen = fenAfter;
  for (let k = 0; k < frames.length; k += 1) {
    const victim = pieceAt(fen, frames[k].to);
    if (k % 2 === 0 && victim && victim.color === us && victim.type !== 'p') return { san: frames[k].san, type: victim.type, square: frames[k].to };
    fen = frames[k].fen;
  }
  return undefined;
}

export function explainMove(inp: ExplainInput): MoveExplanation {
  const { plies, evals, positions, contexts, ply } = inp;
  const p = plies[ply - 1];
  const e = evals[ply - 1];
  const us = p.color;
  const opp = COLOR_NAME[other(us)];
  const ctx = contexts.get(ply);
  const here = inp.findings.filter((f) => f.ply === ply || f.relatedPlies?.includes(ply));
  const has = (cat: string) => here.some((f) => f.category === cat);

  // 1. What the move was going for (board-visible only).
  const own = describeMove({ fen: p.fenBefore, uci: p.uci, context: ctx, forIntent: true });
  const ownPurposes = own?.purposes ?? [];
  const intent = ownPurposes.length ? joinList(ownPurposes.slice(0, 2).map((x) => x.text)) : undefined;

  // 2. What went wrong.
  const problems: string[] = [];
  // The piece was chased by pawns: that *is* the problem, whatever side-lines the engine prefers.
  const chased = here.find((f) => f.facts.chased && f.ply === ply);
  if (chased) problems.push(`${opp}'s pawns chased it (${(chased.facts.pushes as string[]).join(', ')}), gaining space${chased.facts.towardKing ? ' toward your king' : ''} with every push`);
  const lost = problems.length ? 0 : e.materialBefore - e.materialAfterReply;
  const cap = lost >= 2 ? firstCaptureOfOurs(p.fenAfter, e.replyLineUci, us) : undefined;
  if (cap && p.captured && cap.square === p.to)
    problems.push(`after ${cap.san} you've given your ${PIECE_NAME[p.piece]} for a ${PIECE_NAME[p.captured]}`);
  else if (cap) problems.push(`it lets ${opp} win your ${PIECE_NAME[cap.type]} (${cap.san})`);
  else if (lost >= 2) problems.push(`it lets ${opp} win material (${e.replyLineSan.slice(0, 2).join(' ')})`);
  const replySan = e.replyLineSan[0];
  const perpetual = here.find((f) => f.facts.perpetual && f.ply === ply);
  if (perpetual && !problems.length)
    problems.push(`it lets ${opp} force a draw by checking your king again and again (${(perpetual.facts.replyLine as string[]).slice(0, 4).join(' ')})`);
  if (!problems.length && replySan?.includes('+') && pd(e) >= 8) problems.push(`it lets ${opp} start checking your king with ${replySan}`);
  const trip = here.find((f) => f.category === 'inefficient_moves' && f.ply === ply && f.confidence !== 'low');
  if (trip?.facts.secondSan && !problems.length)
    problems.push(`the ${trip.facts.piece} had to move again with ${trip.facts.secondSan}, so the move gained nothing`);
  // The opponent's natural answer gains time by attacking the piece that just moved.
  const actualReply = plies[ply];
  if (!trip && actualReply && pd(e) >= 5 && attackersOf(actualReply.fenAfter, p.to, actualReply.color).includes(actualReply.to as never) && p.piece !== 'p')
    problems.push(`${opp} can answer ${actualReply.san} and gain time by attacking your ${PIECE_NAME[p.piece]}`);
  // Lines open toward our king after the opponent's best reply (e.g. ...Nxf4 Nxc5 ...Qxh4).
  // These two only apply when the move actually left you worse off (not when you're still clearly better).
  const nowWorse = e.winAfter < 55;
  if (!problems.length && nowWorse && pd(e) >= 8 && !ctx?.kingPressure) {
    const frames = playLine(p.fenAfter, e.replyLineUci, 3);
    const end = frames.at(-1)?.fen;
    if (end && underKingPressure(end, us)) problems.push(`it opens the way for ${opp}'s pieces to reach your king (${frames.map((f) => f.san).join(' ')})`);
  }
  // A threat that was already there and the move did nothing about (e.g. ...g3 breaking open the king).
  if (!problems.length && nowWorse && pd(e) >= 15 && e.replyLineUci[0]) {
    // Only call it an existing threat if it was already a concrete check or capture before the move.
    const pre = passTurn(p.fenBefore);
    const preSan = pre ? lineToSan(pre, [e.replyLineUci[0]], 1)[0] : undefined;
    const concreteBefore = !!preSan && (preSan.includes('+') || preSan.includes('x'));
    const replyEnd = playLine(p.fenAfter, e.replyLineUci, 1)[0]?.fen;
    const hitsKing = !!replyEnd && kingZoneAttacks(replyEnd, us) > kingZoneAttacks(p.fenAfter, us) + 1;
    problems.push(
      concreteBefore
        ? `it doesn't deal with ${opp}'s threat ${replySan}`
        : hitsKing
          ? `it allows ${replySan}, and ${opp}'s attack on your king breaks through`
          : `it allows ${replySan}, and ${opp}'s position becomes much better`,
    );
  }
  if (has('hunting_material')) problems.push('it spends a move grabbing a pawn while your pieces are still undeveloped and your king is not safe');
  if (has('king_safety') && pawnShield(p.fenAfter, us) < pawnShield(p.fenBefore, us)) problems.push('it loosens the pawns in front of your king');
  if (pd(e) >= 3 && structureScore(p.fenAfter, us) > structureScore(p.fenBefore, us) && p.piece === 'p')
    problems.push('it leaves you with a doubled or isolated pawn');
  // A mistake made the position concretely worse; a missed chance left it roughly fine but passed up something better.
  const turnedBad = e.winBefore >= 40 && e.winAfter < 35;
  const mistake = problems.length > 0 || turnedBad;
  if (turnedBad && !problems.length) problems.push(`it lets ${opp} take over (${e.replyLineSan.slice(0, 2).join(' ')})`);

  // 3. Why the better move is better — only what it does that the played move didn't.
  const bp = inp.betterPly ?? ply;
  const bPly = plies[bp - 1];
  const bEval = evals[bp - 1];
  const best = positions[bp - 1]?.lines[0];
  let better: string | undefined;
  let support: string[] | undefined;
  let purposes: Purpose[] = [];
  if (best && best.pv[0] && best.pv[0] !== bPly.uci) {
    const d = describeMove({
      fen: bPly.fenBefore,
      uci: best.pv[0],
      pv: best.pv,
      mateIn: best.score.type === 'mate' && best.score.value > 0 ? best.score.value : undefined,
      lineCp: scoreToCp(best.score),
      context: contexts.get(bp),
      threatUci: positions[bp]?.lines[0]?.pv[0],
      playedFenAfter: bPly.fenAfter,
    });
    const playedIds = new Set(
      (bp === ply ? ownPurposes : describeMove({ fen: bPly.fenBefore, uci: bPly.uci, context: contexts.get(bp), forIntent: true })?.purposes ?? []).map((x) => x.id),
    );
    // Shared reasons (both moves "escape") explain nothing; keep the difference.
    purposes = (d?.purposes ?? []).filter((x) => !playedIds.has(x.id) && !(x.id === 'threat' && playedIds.has('double_attack')));
    const top = purposes.slice(0, 2);
    if (top.length && d) {
      better = `${d.san} ${joinList(top.map((x) => x.text))}`;
      // Show a few moves only when they make the point (e.g. the fork that wins the piece two moves later).
      const win = top.find((x) => x.id === 'win_material');
      if (win) support = win.plies && win.plies > 1 ? lineToSan(bPly.fenBefore, best.pv, win.plies) : undefined;
      else if (top.some((x) => CONCRETE.includes(x.id))) support = lineToSan(bPly.fenBefore, best.pv, 3);
    }
  }

  return {
    ply,
    kind: mistake ? 'mistake' : 'missed_opportunity',
    intent,
    problem: mistake ? problems[0] : undefined,
    better,
    betterSan: bEval?.bestSan,
    betterPly: bp,
    support,
    purposes: purposes.map((x) => x.id),
  };
}

/** Human sentence for the "why" part, with the short line when it helps. */
export function betterSentence(x: MoveExplanation): string | undefined {
  if (!x.better) return undefined;
  const line = x.support && x.support.length > 1 ? ` (${x.support.join(' ')})` : '';
  return `${x.better}${line}.`;
}
