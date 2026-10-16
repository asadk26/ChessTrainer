// Post-game assessment of an Adaptive Coach game, from the normal analysis of that game.
// First question: did the game actually produce the situation the lesson needs? If not, the
// result is "not meaningfully tested" and nothing is concluded. When the evidence is thin or
// mixed, the verdict is "partly" rather than a confident pass or fail. Every verdict carries the
// rule trace that produced it (`evidence`).
import { Chess } from 'chess.js';
import type { AdaptiveAssessment, AdaptiveMoment, AdaptivePlan, AdaptiveVerdict, CategoryId, MoveEval, StoredGame } from '../domain/types';
import { hasCastled, nonPawnMaterial, undevelopedMinors } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { formatCp, pd } from '../analysis/evaluation';
import { SKILL_LABEL } from './skills';
import { notQuietBecause, pawnBreaks } from './features';

/** Thresholds behind every verdict, in one place. */
export const ASSESS = {
  /** Quiet, level middlegame decisions needed before patience counts as tested. */
  minQuiet: 4,
  /** …and before a clean game (no breaks at all) counts as demonstrated rather than "partly". */
  quietForCleanPass: 6,
  /** Average win% given away per quiet decision that still counts as keeping the balance. */
  quietDropOk: 3,
  /** Moves from the start position before conversion counts as tested (unless decided sooner). */
  minConversionMoves: 8,
  /** …and before holding the advantage can count as demonstrated. */
  conversionMovesForPass: 12,
  /** Opening cost (sum of win% given away in moves 1–10) that makes slow development a real problem. */
  openingCostReal: 8,
};
/** Back-compat names. */
export const MIN_QUIET = ASSESS.minQuiet;
export const MIN_CONVERSION_MOVES = ASSESS.minConversionMoves;

export function assessGame(game: StoredGame, plan: AdaptivePlan): AdaptiveAssessment {
  if (!game.analysis) throw new Error('The game has not been analysed yet.');
  const out =
    plan.skill === 'positional_patience' ? patience(game) : plan.skill === 'development_discipline' ? development(game) : conversion(game);
  const history = plan.basis === 'history' && plan.evidence.length ? `For comparison, in your real games: ${plan.evidence[0].text}` : '';
  return {
    skill: plan.skill,
    ...out,
    explanation: [out.explanation, out.valid && history ? history : ''].filter(Boolean).join(' '),
    retestSoon: out.verdict !== 'demonstrated',
  };
}

type Part = Omit<AdaptiveAssessment, 'skill' | 'retestSoon'>;

const VERDICT_TEXT: Record<AdaptiveVerdict, string> = {
  demonstrated: 'Demonstrated',
  partial: 'Partly demonstrated',
  failed: 'Not yet',
  not_tested: 'Not meaningfully tested',
};

const head = (skill: AdaptivePlan['skill'], v: AdaptiveVerdict) => `${SKILL_LABEL[skill]}: ${VERDICT_TEXT[v]}`;

function notTested(skill: AdaptivePlan['skill'], why: string, stats: Record<string, number>, evidence: string[], testMoments = 0): Part {
  return { valid: false, verdict: 'not_tested', headline: head(skill, 'not_tested'), explanation: why, moments: [], stats, evidence, testMoments };
}

/** Lost material straight away (a tactical slip — a different skill from the one being tested). */
const tacticalSlip = (m: MoveEval) => m.materialAfterReply - m.materialBefore <= -2 && pd(m) >= 12;

// ------------------------------------------------------------ positional patience

function patience(game: StoredGame): Part {
  const { plies } = game;
  const moves = game.analysis!.moves;
  const user = game.userColor;
  const why: Record<string, number> = {};
  const quiet = plies.filter((p, i) => {
    if (p.color !== user || !moves[i]) return false;
    const w = notQuietBecause(p, moves[i], plies[i - 1]);
    if (w) why[w] = (why[w] ?? 0) + 1;
    return !w;
  });
  const breaks = pawnBreaks(plies, moves, user);
  const premature = breaks.filter((b) => b.kind === 'premature');
  const questionable = breaks.filter((b) => b.kind === 'questionable');
  const good = breaks.filter((b) => b.kind === 'sound');
  // Tactical slips in quiet positions are real mistakes, but not patience ones: kept out of the average.
  const slips = quiet.filter((p) => tacticalSlip(moves[p.ply - 1]));
  const judged = quiet.filter((p) => !slips.includes(p));
  const avgDrop = judged.length ? judged.reduce((a, p) => a + pd(moves[p.ply - 1]), 0) / judged.length : 0;
  const stats = { quietMoves: quiet.length, breaks: breaks.length, premature: premature.length, questionable: questionable.length, soundBreaks: good.length, tacticalSlips: slips.length, avgQuietDrop: Math.round(avgDrop * 10) / 10 };
  const label = (ply: number) => moveLabel(plies[ply - 1]);
  const evidence = [
    `Quiet, level middlegame decisions: ${quiet.length}${quiet.length ? ` (${quiet.map((p) => moveLabel(p)).join(', ')})` : ''}.`,
    `Your other moves didn't count because: ${Object.entries(why).map(([k, v]) => `${k.replace('_', ' ')} ×${v}`).join(', ') || '—'}.`,
    `Pawn breaks in those positions: ${breaks.map((b) => `${label(b.ply)} ${b.kind} (−${Math.round(b.drop)}%, Stockfish: ${b.bestSan})`).join('; ') || 'none'}.`,
    `Average cost per quiet decision (tactical slips excluded): ${stats.avgQuietDrop}% (≤ ${ASSESS.quietDropOk}% counts as keeping the balance).`,
  ];
  if (slips.length) evidence.push(`Tactical slips in quiet positions (not counted against patience): ${slips.map((p) => moveLabel(p)).join(', ')}.`);
  if (quiet.length < ASSESS.minQuiet)
    return notTested(
      'positional_patience',
      `The game only produced ${quiet.length} quiet, level middlegame decision${quiet.length === 1 ? '' : 's'} for you (${ASSESS.minQuiet} needed)${topReason(why)}, so patience wasn't really tested.`,
      stats,
      evidence,
      quiet.length,
    );
  const moments: AdaptiveMoment[] = [
    ...premature.slice(0, 2).map((b) => ({
      ply: b.ply,
      label: label(b.ply),
      tone: 'bad' as const,
      text: `${label(b.ply)} broke with a pawn in a quiet, level position and cost about ${Math.round(b.drop)}% of your winning chances. Stockfish preferred ${b.bestSan} — improving a piece first.`,
    })),
    ...good.slice(0, 1).map((b) => ({ ply: b.ply, label: label(b.ply), tone: 'good' as const, text: `${label(b.ply)} was a pawn break that kept the balance — prepared, not forced.` })),
    ...slips.slice(0, 1).map((p) => ({ ply: p.ply, label: moveLabel(p), tone: 'neutral' as const, text: `${moveLabel(p)} lost material to a tactic — worth reviewing, but that's a different skill from patience.` })),
  ];
  let verdict: AdaptiveVerdict;
  let explanation: string;
  if (premature.length >= 2 || premature.some((b) => b.drop >= 12)) {
    verdict = 'failed';
    explanation = `In ${quiet.length} quiet positions you forced the issue with a pawn before your pieces were ready.`;
    evidence.push('Rule: two premature breaks, or one costing ≥ 12% → not yet.');
  } else if (premature.length === 1) {
    verdict = 'partial';
    explanation = `Mostly patient across ${quiet.length} quiet positions, with one pawn break that came too early.`;
    evidence.push('Rule: exactly one premature break costing < 12% → partly.');
  } else if (avgDrop <= ASSESS.quietDropOk && (good.length > 0 || quiet.length >= ASSESS.quietForCleanPass)) {
    verdict = 'demonstrated';
    explanation = good.length
      ? `Across ${quiet.length} quiet positions you kept the balance, and your pawn break came when it was ready.`
      : `Across ${quiet.length} quiet positions you kept the balance without forcing the position.`;
    evidence.push(`Rule: no premature breaks, quiet moves cost ≤ ${ASSESS.quietDropOk}% on average, and either a sound break or ≥ ${ASSESS.quietForCleanPass} quiet decisions → demonstrated.`);
  } else if (avgDrop <= ASSESS.quietDropOk) {
    verdict = 'partial';
    explanation = `No premature breaks in ${quiet.length} quiet positions — a good sign, but too few to call it demonstrated.`;
    evidence.push(`Rule: clean but fewer than ${ASSESS.quietForCleanPass} quiet decisions and no sound break → partly (not enough evidence).`);
  } else {
    verdict = 'partial';
    explanation = `No premature pawn breaks, but your quiet moves gave away more than they should (about ${Math.round(avgDrop)}% per move on average) — look for the worst-placed piece.`;
    evidence.push(`Rule: no premature breaks but quiet moves cost > ${ASSESS.quietDropOk}% on average → partly.`);
  }
  return { valid: true, verdict, headline: head('positional_patience', verdict), explanation, moments: moments.slice(0, 3), stats, evidence, testMoments: quiet.length };
}

function topReason(why: Record<string, number>): string {
  const top = Object.entries(why).filter(([k]) => k !== 'opening').sort((a, b) => b[1] - a[1])[0];
  if (!top) return '';
  const text: Record<string, string> = {
    not_level: 'the evaluation was already clearly one-sided',
    queens_off: 'the queens came off early',
    simplified: 'too many pieces were traded',
    tactical: 'the positions were tactical',
    recapture: 'most moves were recaptures',
    in_check: 'you were often in check',
  };
  return ` — mostly because ${text[top[0]] ?? top[0]}`;
}

// ------------------------------------------------------------ development discipline

const DEV_CATEGORIES: CategoryId[] = ['development', 'early_queen', 'inefficient_moves'];

function development(game: StoredGame): Part {
  const { plies } = game;
  const moves = game.analysis!.moves;
  const user = game.userColor;
  const mine = plies.filter((p) => p.color === user);
  const at8 = mine.find((p) => p.moveNumber === 8);
  const at10 = mine.find((p) => p.moveNumber === 10);
  const stats: Record<string, number> = { userMoves: mine.length };
  if (!at10) return notTested('development_discipline', `The game ended before your 10th move, so there was no real test of development.`, stats, [`Your moves: ${mine.length} (move 10 needed).`]);
  if (at8 && Math.abs(moves[at8.ply - 1].cpBefore) > 300)
    return notTested(
      'development_discipline',
      `The game was already decided by move 8 (${formatCp(moves[at8.ply - 1].cpBefore)}), so development discipline wasn't the question.`,
      stats,
      [`Evaluation at your move 8: ${formatCp(moves[at8.ply - 1].cpBefore)} (beyond ±3 counts as decided).`],
    );
  const opening = mine.filter((p) => p.moveNumber <= 10);
  const undeveloped = undevelopedMinors(at10.fenAfter, user);
  const castled = hasCastled(at10.fenAfter, user);
  const cost = opening.reduce((a, p) => a + (pd(moves[p.ply - 1]) >= 2 ? pd(moves[p.ply - 1]) : 0), 0);
  const findings = game.findings.filter(
    (f) => f.kind === 'weakness' && DEV_CATEGORIES.includes(f.category as CategoryId) && f.confidence !== 'low' && f.severity >= 2 && (plies[f.ply - 1]?.moveNumber ?? 99) <= 12,
  );
  Object.assign(stats, { undevelopedAt10: undeveloped.length, castled: castled ? 1 : 0, openingFindings: findings.length, openingCost: Math.round(cost) });
  const evidence = [
    `After your move 10: ${undeveloped.length ? `still at home: ${undeveloped.join(', ')}` : 'all minor pieces developed'}; king ${castled ? 'castled' : 'not castled'}.`,
    `Opening findings (development, early queen, repeated piece moves, by move 12): ${findings.map((f) => `${moveLabel(plies[f.ply - 1])} ${f.category}`).join('; ') || 'none'}.`,
    `Win% given away in moves 1–10: ${Math.round(cost)}% (≥ ${ASSESS.openingCostReal}% means the slow start actually cost something).`,
  ];
  const moments: AdaptiveMoment[] = findings.slice(0, 2).map((f) => ({ ply: f.ply, label: moveLabel(plies[f.ply - 1]), tone: 'bad', text: f.evidence }));
  const castle = mine.find((p) => p.san.startsWith('O-O') && p.moveNumber <= 12);
  if (castle && moments.length < 3) moments.push({ ply: castle.ply, label: moveLabel(castle), tone: 'good', text: `${moveLabel(castle)}: king safe and a rook joins the game.` });
  const state = `At move 10: ${undeveloped.length ? `${undeveloped.length} minor piece${undeveloped.length > 1 ? 's' : ''} still at home (${undeveloped.join(', ')})` : 'all minor pieces out'}, king ${castled ? 'castled' : 'not castled'}.`;
  const costly = cost >= ASSESS.openingCostReal || findings.length > 0;
  let verdict: AdaptiveVerdict;
  let explanation: string;
  if (findings.length >= 2 || (undeveloped.length >= 2 && costly) || (undeveloped.length >= 1 && !castled && findings.length >= 1)) {
    verdict = 'failed';
    explanation = `${state} The opening drifted from development, and it cost you.`;
    evidence.push('Rule: two opening findings, or two pieces at home with a real cost, or a piece at home + uncastled + a finding → not yet.');
  } else if (undeveloped.length <= 1 && castled && findings.length === 0 && cost < ASSESS.openingCostReal) {
    verdict = 'demonstrated';
    explanation = `${state} A disciplined opening.`;
    evidence.push(`Rule: ≤ 1 piece at home, castled, no findings, cost < ${ASSESS.openingCostReal}% → demonstrated.`);
  } else {
    verdict = 'partial';
    explanation =
      undeveloped.length >= 2 && !costly ? `${state} Slow, though Stockfish didn't punish it this time.` : `${state} Mostly on track${findings.length ? ', with one opening slip' : ''}.`;
    evidence.push('Rule: anything between → partly.');
  }
  return { valid: true, verdict, headline: head('development_discipline', verdict), explanation, moments, stats, evidence, testMoments: opening.length };
}

// ------------------------------------------------------------ conversion

const CONVERSION_CATEGORIES: CategoryId[] = ['gave_back_material', 'failure_to_simplify', 'unnecessary_complications', 'hunting_material', 'allowed_counterplay'];

function conversion(game: StoredGame): Part {
  const { plies } = game;
  const moves = game.analysis!.moves;
  const user = game.userColor;
  const mine = plies.filter((p) => p.color === user);
  const first = mine[0] ? moves[mine[0].ply - 1] : undefined;
  const startCp = first?.cpBefore ?? 0;
  const afterMine = mine.map((p) => moves[p.ply - 1].cpAfter);
  const lowest = Math.min(...afterMine, startCp);
  const lastPly = plies[plies.length - 1];
  const final = new Chess(lastPly.fenAfter);
  const mated = final.isCheckmate();
  const userMated = mated && final.turn() === user;
  const finalCp = mated ? (userMated ? -10000 : 10000) : lastPly.color === user ? moves[lastPly.ply - 1].cpAfter : -moves[lastPly.ply - 1].cpAfter;
  const gaveBack = lowest < 100;
  const simplified = nonPawnMaterial(plies[0].fenBefore) - nonPawnMaterial(lastPly.fenAfter);
  const whileAhead = mine.filter((p) => moves[p.ply - 1].cpBefore >= 150).length;
  const stats = { userMoves: mine.length, startCp, finalCp, lowestCp: lowest, simplified };
  const evidence = [
    `Start ${formatCp(startCp)} → lowest ${formatCp(lowest)} → end ${mated ? (userMated ? 'you were mated' : 'you mated') : formatCp(finalCp)} over ${mine.length} of your moves.`,
    `Material traded off (pieces, both sides): ${simplified} points.`,
  ];
  if (!gaveBack && !mated && mine.length < ASSESS.minConversionMoves)
    return notTested('conversion', `Only ${mine.length} move${mine.length === 1 ? '' : 's'} were played from the start position (${ASSESS.minConversionMoves} needed) — not enough to judge the conversion.`, stats, evidence, whileAhead);
  const slips = game.findings.filter((f) => f.kind === 'weakness' && CONVERSION_CATEGORIES.includes(f.category as CategoryId) && f.confidence !== 'low' && f.severity >= 2);
  const worst = mine.map((p) => ({ p, d: pd(moves[p.ply - 1]) })).sort((a, b) => b.d - a.d)[0];
  evidence.push(`Biggest single give-back: ${worst ? `${moveLabel(worst.p)} (−${Math.round(worst.d)}%)` : '—'}. Conversion findings: ${slips.map((f) => `${moveLabel(plies[f.ply - 1])} ${f.category}`).join('; ') || 'none'}.`);
  const moments: AdaptiveMoment[] = [];
  if (worst && worst.d >= 8)
    moments.push({
      ply: worst.p.ply,
      label: moveLabel(worst.p),
      tone: 'bad',
      text: `${moveLabel(worst.p)} gave back the most (${formatCp(moves[worst.p.ply - 1].cpBefore)} → ${formatCp(moves[worst.p.ply - 1].cpAfter)}).${moves[worst.p.ply - 1].bestSan ? ` ${moves[worst.p.ply - 1].bestSan} kept the grip.` : ''}`,
    });
  for (const f of slips) if (moments.length < 2 && !moments.some((m) => m.ply === f.ply)) moments.push({ ply: f.ply, label: moveLabel(plies[f.ply - 1]), tone: 'bad', text: f.evidence });
  const credit = game.findings.find((f) => f.kind === 'strength' && ['simplified_when_ahead', 'converted_advantage', 'neutralized_counterplay'].includes(f.category));
  if (credit && moments.length < 3) moments.push({ ply: credit.ply, label: plies[credit.ply - 1] ? moveLabel(plies[credit.ply - 1]) : 'Game', tone: 'good', text: credit.evidence });
  const held = finalCp >= Math.max(200, startCp * 0.8) && !gaveBack && (worst?.d ?? 0) < 8 && slips.length === 0;
  const progress = simplified >= 6 || finalCp >= startCp + 100;
  let verdict: AdaptiveVerdict;
  let explanation: string;
  if (userMated || finalCp < 100) {
    verdict = 'failed';
    explanation = `You started at ${formatCp(startCp)} and the advantage ${userMated ? 'was lost' : `was gone by the end (${formatCp(finalCp)})`}.`;
    evidence.push('Rule: mated, or finished below +1 → not yet.');
  } else if (mated || (held && progress && mine.length >= ASSESS.conversionMovesForPass)) {
    verdict = 'demonstrated';
    explanation = mated ? `From ${formatCp(startCp)} you finished the job with mate.` : `You started at ${formatCp(startCp)}, kept a firm grip (${formatCp(finalCp)} at the end) and made progress without giving anything back.`;
    evidence.push(`Rule: mate, or ≥ ${ASSESS.conversionMovesForPass} moves holding the edge with progress (trades or a bigger lead) → demonstrated.`);
  } else if (held) {
    verdict = 'partial';
    explanation = `You kept the advantage (${formatCp(startCp)} → ${formatCp(finalCp)}) without giving anything back, but ${mine.length < ASSESS.conversionMovesForPass ? 'the game was stopped before it was converted' : 'you didn’t make much progress towards winning yet'}.`;
    evidence.push('Rule: held the edge but no conversion progress, or stopped early → partly.');
  } else {
    verdict = 'partial';
    explanation = `You started at ${formatCp(startCp)} and finished at ${formatCp(finalCp)} — still better, but ${gaveBack ? 'the advantage dipped on the way' : 'some of it slipped'}.`;
    evidence.push('Rule: still better at the end but with a dip or a slip → partly.');
  }
  return { valid: true, verdict, headline: head('conversion', verdict), explanation, moments: moments.slice(0, 3), stats, evidence, testMoments: whileAhead };
}
