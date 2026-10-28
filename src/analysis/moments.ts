// The significance layer: decides which moves are worth teaching. Engine
// evaluation loss is one input, not the definition of "important".
import type {
  LessonQuestion,
  MomentPriority,
  MoveExplanation,
  CategoryId,
  Color,
  Finding,
  MomentStepKind,
  MoveEval,
  PlyRecord,
  PositionEval,
  SequenceFrame,
  TeachingMoment,
} from '../domain/types';
import { CATEGORIES } from '../domain/categories';
import type { PatternTag } from './patterns';
import { playLine } from '../chess/board';
import { buildMomentText, goodIdeaText } from '../coach/templates';
import { CP_TOLERANCE, pd, positionCp, scoreToCp, winPercent } from './evaluation';
import { countsAsPattern, isStateFinding } from '../coach/report';

export interface PriorGameFindings {
  gameId: string;
  label: string;
  playedAt: number;
  findings: Finding[];
}

/** Categories with a natural "what will they reply?" question. */
const PREDICT_FIRST: CategoryId[] = [
  'defended_grab',
  'premature_attack',
  'pointless_check',
  'inefficient_moves',
  'blunder',
  'missed_threat',
  'calculation',
  'gave_back_material',
  'allowed_counterplay',
  'unnecessary_complications',
];

/** Categories where the instructive reply is the engine's punishing one, not what the opponent actually played. */
export const ENGINE_REPLY_CATEGORIES: string[] = ['blunder', 'defended_grab', 'missed_threat', 'calculation', 'gave_back_material', 'allowed_counterplay', 'unnecessary_complications'];

/** Whether a moment teaches the engine's punishing reply rather than what the opponent actually played. */
export const usesEngineReply = (m: Pick<TeachingMoment, 'category' | 'tactic'>) => ENGINE_REPLY_CATEGORIES.includes(m.category) || m.tactic?.side === 'refutation';

/** Priority when several findings share a move. */
const PRIMARY_ORDER: CategoryId[] = [
  'blunder',
  'defended_grab',
  'allowed_counterplay',
  'gave_back_material',
  'missed_threat',
  'tactical_blindness',
  'stranded_piece',
  'calculation',
  'piece_to_rim',
  'premature_attack',
  'pointless_check',
  'inefficient_moves',
  'hunting_material',
  'missed_king_attack',
  'early_queen',
  'king_safety',
  'failure_to_simplify',
  'unnecessary_complications',
  'endgame',
  'poor_trade',
  'premature_capture',
  'development',
  'central_tension',
  'time_management',
];

export const MAX_MISTAKE_MOMENTS = 4;
/** Only the highest-value moments become interactive lessons; the rest are short notes. */
export const MAX_LESSONS = 2;

/**
 * Teaching priority, in the order that matters most for improvement:
 * 1 your move had a concrete refutation, 2 a missed winning tactic, 3 a major
 * advantage swing, 4 a recurring personal habit, 5 a positional decision, 6 a
 * small inaccuracy.
 */
export function priorityOf(fs: Finding[], e: MoveEval | undefined, prior: PriorGameFindings[]): MomentPriority {
  const d = e ? pd(e) : 0;
  const lostMaterial = !!e && e.materialBefore - e.materialAfterReply >= 2 && d >= 12;
  if (
    lostMaterial ||
    e?.mateThreatAgainst ||
    fs.some((f) => ['blunder', 'missed_threat', 'stranded_piece', 'gave_back_material'].includes(f.category) || f.facts.perpetual || f.facts.tacticForOpponent || f.facts.forkSan)
  )
    return 1;
  if (fs.some((f) => f.category === 'tactical_blindness')) return 2;
  if (d >= 22) return 3;
  if (fs.some((f) => priorGamesWith(f.category, prior) > 0)) return 4;
  if (d < 12) return 6;
  return 5;
}

/** Which question a lesson opens with. Predicting the opponent's reply is the default whenever there is a concrete one. */
export function questionFor(priority: MomentPriority, replySan: string | undefined, playedSan = ''): LessonQuestion {
  const forcing = !!replySan && /[x+#]/.test(replySan);
  // After a check the reply is mostly forced, so predicting it teaches little.
  const replyIsAChoice = !/[+#]/.test(playedSan);
  if (replySan && replyIsAChoice && (priority === 1 || (priority === 3 && forcing))) return 'predict_reply';
  if (priority === 6) return 'cleaner';
  return 'find';
}
export const MIN_SIGNIFICANCE = 18;

export function priorGamesWith(category: string, prior: PriorGameFindings[]): number {
  return prior.filter((g) => g.findings.some((f) => f.category === category && countsAsPattern(f))).length;
}

/**
 * Score how worth teaching a move is. Pattern findings carry most of the
 * weight; evaluation loss adds to it; recurring categories get a boost.
 */
export function significance(findings: Finding[], evals: MoveEval[], prior: PriorGameFindings[]): number {
  // Only credible findings can make a teaching moment; speculative ones never do.
  const teachable = findings.filter(countsAsPattern);
  if (teachable.length === 0) return 0;
  const patternScore = teachable.reduce(
    (acc, f) => acc + CATEGORIES[f.category as CategoryId].weight * f.severity * 10 * (f.confidence === 'high' ? 1 : 0.75),
    0,
  );
  const plies = new Set(teachable.flatMap((f) => [f.ply, ...(f.relatedPlies ?? [])]));
  const maxDrop = Math.max(0, ...evals.filter((e) => plies.has(e.ply)).map((e) => pd(e)));
  const evalScore = maxDrop < 6 ? 0 : maxDrop * 0.8;
  const recurring = Math.max(...teachable.map((f) => Math.min(3, priorGamesWith(f.category, prior))));
  return Math.round(patternScore + evalScore + recurring * 5);
}

/**
 * Engine candidates close enough to the best move to count as "good". When the
 * mover is clearly ahead, win% hides real differences, so a centipawn bound
 * applies too.
 */
export function acceptableMoves(pos: PositionEval, exclude: string | undefined, tolerance: number): string[] {
  if (!pos.lines.length) return [];
  const bestCp = scoreToCp(pos.lines[0].score);
  const bestWin = winPercent(bestCp);
  return pos.lines
    .filter((l) => bestWin - winPercent(scoreToCp(l.score)) <= tolerance && (bestCp < 300 || bestCp - scoreToCp(l.score) <= CP_TOLERANCE))
    .map((l) => l.pv[0])
    .filter((u) => u && u !== exclude);
}

function framesFromGame(plies: PlyRecord[], fromPly: number, toPly: number): SequenceFrame[] {
  return plies
    .filter((p) => p.ply >= fromPly && p.ply <= toPly)
    .map((p) => ({ fen: p.fenAfter, san: p.san, from: p.from, to: p.to, caption: '' }));
}

export interface MomentInput {
  gameId: string;
  plies: PlyRecord[];
  evals: MoveEval[];
  positions: PositionEval[];
  findings: Finding[];
  userColor: Color;
  prior: PriorGameFindings[];
  explanations?: Record<number, MoveExplanation>;
}

export { isStateFinding };

export function buildMoments(input: MomentInput): TeachingMoment[] {
  const { plies, evals, positions, findings, userColor, prior } = input;
  const byPly = new Map<number, Finding[]>();
  for (const f of findings) {
    if (f.kind !== 'weakness' || f.ply <= 0) continue;
    // About the game as a whole (castled late, slow development, a passive piece, the clock),
    // not about the move it happens to be attached to: summary only, never a "find a better move" lesson.
    if (isStateFinding(f)) continue;
    byPly.set(f.ply, [...(byPly.get(f.ply) ?? []), f]);
  }

  const scored = [...byPly.entries()]
    .map(([ply, fs]) => ({ ply, fs, score: significance(fs, evals, prior) }))
    .filter((x) => x.score >= MIN_SIGNIFICANCE)
    .sort((a, b) => b.score - a.score)
    // The same lesson twice (e.g. the same missed mate on two moves) only needs one moment.
    .filter((x, k, all) => {
      const key = (fs: Finding[]) => fs.map((f) => (f.facts.mateIn ? `mate:${f.facts.bestSan}` : '')).find(Boolean);
      const mine = key(x.fs);
      return !mine || all.findIndex((y) => key(y.fs) === mine) === k;
    })
    // Highest learning value first: refutations, missed tactics, swings, habits, positional, small slips.
    .map((x) => ({ ...x, priority: priorityOf(x.fs, evals[x.ply - 1], prior) }))
    .sort((a, b) => a.priority - b.priority || b.score - a.score)
    .slice(0, MAX_MISTAKE_MOMENTS);

  const moments: TeachingMoment[] = scored.map(({ ply, fs, score, priority }, rank) => {
    // The tactic that decided the move (a fork, a discovered attack…) is the lesson, whatever category carries it.
    const tactic = (f: Finding) => (f.facts.pattern ? (f.facts.patternSide === 'better' ? 1 : 0) : 2);
    const primary = [...fs]
      .filter((f) => f.severity >= 2)
      .sort((a, b) => tactic(a) - tactic(b) || PRIMARY_ORDER.indexOf(a.category as CategoryId) - PRIMARY_ORDER.indexOf(b.category as CategoryId))[0];
    const idx = ply - 1;
    const played = plies[idx];
    const reply = plies[idx + 1];
    const related = Math.max(ply, ...fs.flatMap((f) => f.relatedPlies ?? []));
    const worsePly = Number(primary.facts.worsePly ?? ply);
    const betterPly = plies[worsePly - 1] ?? played;
    const betterPos = positions[worsePly - 1];
    const bestPv = betterPos.lines[0]?.pv ?? [];

    // A tactic the opponent's reply carried out is taught from the engine's punishing line.
    const engineReply = ENGINE_REPLY_CATEGORIES.includes(primary.category) || (!!primary.facts.pattern && primary.facts.patternSide !== 'better');
    const predict = (PREDICT_FIRST.includes(primary.category as CategoryId) || engineReply) && !!positions[ply].lines.length;
    const steps: MomentStepKind[] = predict
      ? ['intro', 'predict', 'reveal', 'find_better', 'lesson']
      : ['intro', 'find_better', 'reveal', 'lesson'];

    // Opponent replies accepted in the predict step: what they played + near-best engine replies.
    const replyPos = positions[ply];
    const acceptableReplyUcis = Array.from(
      new Set([
        ...(reply && !engineReply ? [reply.uci] : []),
        ...acceptableMoves(replyPos, undefined, engineReply ? 5 : 10),
      ]),
    );

    const sequence =
      engineReply
        ? [{ fen: played.fenAfter, san: played.san, from: played.from, to: played.to, caption: '' }, ...playLine(played.fenAfter, replyPos.lines[0]?.pv ?? [], 4)]
        : framesFromGame(plies, ply, related);

    const text = buildMomentText({
      primary,
      all: fs,
      played,
      reply,
      mover: userColor,
      bestSan: evals[worsePly - 1]?.bestSan,
      betterPly,
      explain: input.explanations?.[ply],
    });

    const targetSquares = (primary.facts.targetSquares as string[] | undefined) ?? [];
    const victim = primary.facts.victimSquare as string | undefined;
    const refutationUci = positions[ply]?.lines[0]?.pv[0];
    const refutationSan = refutationUci ? playLine(played.fenAfter, [refutationUci])[0]?.san : undefined;
    const tier = rank < MAX_LESSONS ? ('lesson' as const) : ('note' as const);
    return {
      id: `${input.gameId}:${ply}`,
      ply,
      kind: 'mistake',
      tier,
      priority,
      question: tier === 'lesson' ? questionFor(priority, refutationSan, played.san) : undefined,
      refutationUci,
      refutationSan,
      category: primary.category,
      tactic: primary.facts.pattern ? { tag: primary.facts.pattern as PatternTag, side: primary.facts.patternSide === 'better' ? 'better' : 'refutation' } : undefined,
      categories: Array.from(new Set(fs.map((f) => f.category))),
      significance: score,
      steps,
      moverColor: userColor,
      fenBefore: played.fenBefore,
      fenAfter: played.fenAfter,
      playedSan: played.san,
      playedUci: played.uci,
      bestSan: evals[worsePly - 1]?.bestSan,
      bestUci: bestPv[0],
      bestLineSan: evals[worsePly - 1]?.bestLineSan ?? [],
      acceptableUcis: acceptableMoves(betterPos, betterPly.uci, 7),
      opponentReplySan: reply?.san,
      opponentReplyUci: reply?.uci,
      acceptableReplyUcis,
      sequence,
      betterSequence: playLine(betterPly.fenBefore, bestPv, 4),
      betterFen: betterPly.fenBefore,
      betterPly: betterPly.ply,
      introMarkup: {
        arrows: [{ from: played.from, to: played.to, color: 'played' }],
        highlights: [
          ...targetSquares.map((sq) => ({ square: sq, tone: 'focus' as const })),
          ...(victim ? [{ square: victim, tone: 'danger' as const }] : []),
        ],
      },
      text,
      explanation: input.explanations?.[ply],
      numbers: {
        winBefore: evals[idx].winBefore,
        winAfter: evals[idx].winAfter,
        cpBefore: evals[idx].cpBefore,
        cpAfter: evals[idx].cpAfter,
        betterBestWin: bestWin(betterPos),
        betterPlayedWin: evals[worsePly - 1]?.winAfter ?? evals[idx].winAfter,
        betterBestCp: positionCp(betterPos),
      },
    } satisfies TeachingMoment;
  });

  // One positive moment: reinforce a good idea, not just mistakes.
  const good = findings.find((f) => f.kind === 'strength' && f.ply > 0 && (f.category === 'opened_vs_king'));
  if (good) {
    const played = plies[good.ply - 1];
    const { text, choice } = goodIdeaText(good, played, userColor);
    const e = evals[good.ply - 1];
    const seq = framesFromGame(plies, good.ply, Math.min(plies.length, good.ply + 2));
    text.reveal = `Here's how it went: ${seq.map((f) => f.san).join(', ')}. Lines toward the king on ${good.facts.oppKing} start to open while your own king is safe.`;
    moments.push({
      id: `${input.gameId}:${good.ply}:good`,
      ply: good.ply,
      kind: 'good_idea',
      tier: 'note',
      category: good.category,
      categories: [good.category],
      significance: 0,
      steps: ['intro', 'why_good', 'reveal', 'lesson'],
      moverColor: userColor,
      fenBefore: played.fenBefore,
      fenAfter: played.fenAfter,
      playedSan: played.san,
      playedUci: played.uci,
      bestSan: e.bestSan,
      bestUci: e.bestUci,
      bestLineSan: e.bestLineSan,
      acceptableUcis: [],
      acceptableReplyUcis: [],
      sequence: seq,
      betterSequence: [],
      betterFen: played.fenBefore,
      betterPly: played.ply,
      introMarkup: {
        arrows: [{ from: played.from, to: played.to, color: 'best' }],
        highlights: [{ square: String(good.facts.oppKing), tone: 'danger' }],
      },
      text,
      choice,
      numbers: { winBefore: e.winBefore, winAfter: e.winAfter, cpBefore: e.cpBefore, cpAfter: e.cpAfter, betterBestWin: e.winBefore, betterPlayedWin: e.winAfter, betterBestCp: e.cpBefore },
    });
  }

  return moments.sort((a, b) => a.ply - b.ply);
}

/** Win% for the mover after playing `uci` from a position, using stored MultiPV lines if possible. */
export function storedMoveWin(pos: PositionEval, uci: string): number | undefined {
  const line = pos.lines.find((l) => l.pv[0] === uci);
  return line ? winPercent(scoreToCp(line.score)) : undefined;
}

export function bestWin(pos: PositionEval): number {
  return winPercent(positionCp(pos));
}

