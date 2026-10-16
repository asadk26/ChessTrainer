// Post-game assessment of an Adaptive Coach game, from the normal analysis of that game.
// First question: did the game actually produce the situation the lesson needs? If not, the
// result is "not meaningfully tested" and nothing is concluded.
import { Chess } from 'chess.js';
import type { AdaptiveAssessment, AdaptiveMoment, AdaptivePlan, AdaptiveVerdict, CategoryId, StoredGame } from '../domain/types';
import { hasCastled, undevelopedMinors } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { formatCp, pd } from '../analysis/evaluation';
import { SKILL_LABEL } from './skills';
import { pawnBreaks, quietBalanced } from './features';

/** Minimum quiet, level middlegame decisions before patience counts as tested. */
export const MIN_QUIET = 4;
/** Minimum moves from the start position before conversion counts as tested (unless decided sooner). */
export const MIN_CONVERSION_MOVES = 8;

export function assessGame(game: StoredGame, plan: AdaptivePlan): AdaptiveAssessment {
  if (!game.analysis) throw new Error('The game has not been analysed yet.');
  const out =
    plan.skill === 'positional_patience' ? patience(game) : plan.skill === 'development_discipline' ? development(game) : conversion(game);
  const history = plan.basis === 'history' && plan.evidence.length ? historyNote(plan) : '';
  return {
    skill: plan.skill,
    ...out,
    explanation: [out.explanation, out.valid && history ? history : ''].filter(Boolean).join(' '),
    retestSoon: out.verdict !== 'demonstrated',
  };
}

type Partial_ = Omit<AdaptiveAssessment, 'skill' | 'retestSoon'>;

const VERDICT_TEXT: Record<AdaptiveVerdict, string> = {
  demonstrated: 'Demonstrated',
  partial: 'Partly demonstrated',
  failed: 'Not yet',
  not_tested: 'Not meaningfully tested',
};

const head = (skill: AdaptivePlan['skill'], v: AdaptiveVerdict) => `${SKILL_LABEL[skill]}: ${VERDICT_TEXT[v]}`;

function historyNote(plan: AdaptivePlan): string {
  return `For comparison, in your real games: ${plan.evidence[0].text}`;
}

function notTested(skill: AdaptivePlan['skill'], why: string, stats: Record<string, number>): Partial_ {
  return { valid: false, verdict: 'not_tested', headline: head(skill, 'not_tested'), explanation: why, moments: [], stats };
}

// ------------------------------------------------------------ positional patience

function patience(game: StoredGame): Partial_ {
  const { plies } = game;
  const moves = game.analysis!.moves;
  const user = game.userColor;
  const quiet = plies.filter((p, i) => p.color === user && moves[i] && quietBalanced(p, moves[i], plies[i - 1]));
  const breaks = pawnBreaks(plies, moves, user);
  const premature = breaks.filter((b) => b.kind === 'premature');
  const good = breaks.filter((b) => b.kind === 'sound');
  const avgDrop = quiet.length ? quiet.reduce((a, p) => a + pd(moves[p.ply - 1]), 0) / quiet.length : 0;
  const stats = { quietMoves: quiet.length, breaks: breaks.length, premature: premature.length, soundBreaks: good.length, avgQuietDrop: Math.round(avgDrop * 10) / 10 };
  if (quiet.length < MIN_QUIET)
    return notTested(
      'positional_patience',
      `The game only produced ${quiet.length} quiet, level middlegame decision${quiet.length === 1 ? '' : 's'} for you (${MIN_QUIET} needed) — it was decided or forcing before patience was really tested.`,
      stats,
    );
  const moments: AdaptiveMoment[] = [
    ...premature.slice(0, 2).map((b) => ({
      ply: b.ply,
      label: moveLabel(plies[b.ply - 1]),
      tone: 'bad' as const,
      text: `${moveLabel(plies[b.ply - 1])} broke with a pawn in a quiet, level position and cost about ${Math.round(b.drop)}% of your winning chances. Stockfish preferred ${b.bestSan} — improving a piece first.`,
    })),
    ...good.slice(0, 1).map((b) => ({
      ply: b.ply,
      label: moveLabel(plies[b.ply - 1]),
      tone: 'good' as const,
      text: `${moveLabel(plies[b.ply - 1])} was a pawn break that kept the balance — prepared, not forced.`,
    })),
  ];
  let verdict: AdaptiveVerdict;
  let explanation: string;
  if (premature.length >= 2 || premature.some((b) => b.drop >= 12)) {
    verdict = 'failed';
    explanation = `In ${quiet.length} quiet positions you forced the issue with a pawn before your pieces were ready.`;
  } else if (premature.length === 1) {
    verdict = 'partial';
    explanation = `Mostly patient across ${quiet.length} quiet positions, with one pawn break that came too early.`;
  } else if (avgDrop <= 3) {
    verdict = 'demonstrated';
    explanation = good.length
      ? `Across ${quiet.length} quiet positions you kept the balance, and your pawn break came when it was ready.`
      : `Across ${quiet.length} quiet positions you kept the balance without forcing the position.`;
  } else {
    verdict = 'partial';
    explanation = `No premature pawn breaks, but your quiet moves gave away more than they should (about ${Math.round(avgDrop)}% per move on average) — look for the worst-placed piece.`;
  }
  return { valid: true, verdict, headline: head('positional_patience', verdict), explanation, moments: moments.slice(0, 3), stats };
}

// ------------------------------------------------------------ development discipline

const DEV_CATEGORIES: CategoryId[] = ['development', 'early_queen', 'inefficient_moves'];

function development(game: StoredGame): Partial_ {
  const { plies } = game;
  const moves = game.analysis!.moves;
  const user = game.userColor;
  const mine = plies.filter((p) => p.color === user);
  const at8 = mine.find((p) => p.moveNumber === 8);
  const at10 = mine.find((p) => p.moveNumber === 10);
  const stats: Record<string, number> = { userMoves: mine.length };
  if (!at10) return notTested('development_discipline', `The game ended before your 10th move, so there was no real test of development.`, stats);
  if (at8 && Math.abs(moves[at8.ply - 1].cpBefore) > 300)
    return notTested('development_discipline', `The game was already decided by move 8 (${formatCp(moves[at8.ply - 1].cpBefore)}), so development discipline wasn't the question.`, stats);
  const undeveloped = undevelopedMinors(at10.fenAfter, user);
  const castled = hasCastled(at10.fenAfter, user);
  const findings = game.findings.filter(
    (f) => f.kind === 'weakness' && DEV_CATEGORIES.includes(f.category as CategoryId) && f.confidence !== 'low' && f.severity >= 2 && (plies[f.ply - 1]?.moveNumber ?? 99) <= 12,
  );
  Object.assign(stats, { undevelopedAt10: undeveloped.length, castled: castled ? 1 : 0, openingFindings: findings.length });
  const moments: AdaptiveMoment[] = findings.slice(0, 2).map((f) => ({ ply: f.ply, label: moveLabel(plies[f.ply - 1]), tone: 'bad', text: f.evidence }));
  const castle = mine.find((p) => p.san.startsWith('O-O') && p.moveNumber <= 12);
  if (castle && moments.length < 3) moments.push({ ply: castle.ply, label: moveLabel(castle), tone: 'good', text: `${moveLabel(castle)}: king safe and a rook joins the game.` });
  let verdict: AdaptiveVerdict;
  let explanation: string;
  const state = `At move 10: ${undeveloped.length ? `${undeveloped.length} minor piece${undeveloped.length > 1 ? 's' : ''} still at home (${undeveloped.join(', ')})` : 'all minor pieces out'}, king ${castled ? 'castled' : 'not castled'}.`;
  if (undeveloped.length >= 2 || findings.length >= 2 || (undeveloped.length >= 1 && !castled && findings.length >= 1)) {
    verdict = 'failed';
    explanation = `${state} The opening drifted from development.`;
  } else if (undeveloped.length <= 1 && castled && findings.length === 0) {
    verdict = 'demonstrated';
    explanation = `${state} A disciplined opening.`;
  } else {
    verdict = 'partial';
    explanation = `${state} Mostly on track${findings.length ? ', with one opening slip' : ''}.`;
  }
  return { valid: true, verdict, headline: head('development_discipline', verdict), explanation, moments, stats };
}

// ------------------------------------------------------------ conversion

const CONVERSION_CATEGORIES: CategoryId[] = ['gave_back_material', 'failure_to_simplify', 'unnecessary_complications', 'hunting_material', 'allowed_counterplay'];

function conversion(game: StoredGame): Partial_ {
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
  const finalCp = mated ? (userMated ? -10000 : 10000) : (lastPly.color === user ? moves[lastPly.ply - 1].cpAfter : -moves[lastPly.ply - 1].cpAfter);
  const gaveBack = lowest < 100;
  const stats = { userMoves: mine.length, startCp, finalCp, lowestCp: lowest };
  if (!gaveBack && !mated && mine.length < MIN_CONVERSION_MOVES)
    return notTested('conversion', `Only ${mine.length} move${mine.length === 1 ? '' : 's'} were played from the start position (${MIN_CONVERSION_MOVES} needed) — not enough to judge the conversion.`, stats);
  const slips = game.findings.filter((f) => f.kind === 'weakness' && CONVERSION_CATEGORIES.includes(f.category as CategoryId) && f.confidence !== 'low' && f.severity >= 2);
  const worst = mine.map((p) => ({ p, d: pd(moves[p.ply - 1]) })).sort((a, b) => b.d - a.d)[0];
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
  let verdict: AdaptiveVerdict;
  let explanation: string;
  if (userMated || finalCp < 100) {
    verdict = 'failed';
    explanation = `You started at ${formatCp(startCp)} and the advantage ${userMated ? 'was lost' : `was gone by the end (${formatCp(finalCp)})`}.`;
  } else if ((mated && !userMated) || (finalCp >= Math.max(200, startCp * 0.8) && !gaveBack && (worst?.d ?? 0) < 8 && slips.length === 0)) {
    verdict = 'demonstrated';
    explanation = mated ? `From ${formatCp(startCp)} you finished the job with mate.` : `You started at ${formatCp(startCp)} and kept a firm grip (${formatCp(finalCp)} at the end) without giving material back.`;
  } else {
    verdict = 'partial';
    explanation = `You started at ${formatCp(startCp)} and finished at ${formatCp(finalCp)} — still better, but ${gaveBack ? 'the advantage dipped on the way' : 'some of it slipped'}.`;
  }
  return { valid: true, verdict, headline: head('conversion', verdict), explanation, moments: moments.slice(0, 3), stats };
}
