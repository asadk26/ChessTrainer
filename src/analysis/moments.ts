// The significance layer: decides which moves are worth teaching. Engine
// evaluation loss is one input, not the definition of "important".
import type {
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
import { playLine } from '../chess/board';
import { buildMomentText, goodIdeaText } from '../coach/templates';
import { CP_TOLERANCE, pd, positionCp, scoreToCp, winPercent } from './evaluation';
import { countsAsPattern } from '../coach/report';

export interface PriorGameFindings {
  gameId: string;
  label: string;
  playedAt: number;
  findings: Finding[];
}

/** Categories with a natural "what will they reply?" question. */
const PREDICT_FIRST: CategoryId[] = [
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
export const ENGINE_REPLY_CATEGORIES: string[] = ['blunder', 'missed_threat', 'calculation', 'gave_back_material', 'allowed_counterplay', 'unnecessary_complications'];

/** Priority when several findings share a move. */
const PRIMARY_ORDER: CategoryId[] = [
  'blunder',
  'allowed_counterplay',
  'gave_back_material',
  'missed_threat',
  'tactical_blindness',
  'stranded_piece',
  'calculation',
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

export const MAX_MISTAKE_MOMENTS = 3;
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

export function buildMoments(input: MomentInput): TeachingMoment[] {
  const { plies, evals, positions, findings, userColor, prior } = input;
  const byPly = new Map<number, Finding[]>();
  for (const f of findings) {
    if (f.kind !== 'weakness' || f.ply <= 0) continue;
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
    .slice(0, MAX_MISTAKE_MOMENTS);

  const moments: TeachingMoment[] = scored.map(({ ply, fs, score }) => {
    const primary = [...fs]
      .filter((f) => f.severity >= 2)
      .sort((a, b) => PRIMARY_ORDER.indexOf(a.category as CategoryId) - PRIMARY_ORDER.indexOf(b.category as CategoryId))[0];
    const idx = ply - 1;
    const played = plies[idx];
    const reply = plies[idx + 1];
    const related = Math.max(ply, ...fs.flatMap((f) => f.relatedPlies ?? []));
    const worsePly = Number(primary.facts.worsePly ?? ply);
    const betterPly = plies[worsePly - 1] ?? played;
    const betterPos = positions[worsePly - 1];
    const bestPv = betterPos.lines[0]?.pv ?? [];

    const predict = PREDICT_FIRST.includes(primary.category as CategoryId) && !!positions[ply].lines.length;
    const steps: MomentStepKind[] = predict
      ? ['intro', 'predict', 'reveal', 'find_better', 'lesson']
      : ['intro', 'find_better', 'reveal', 'lesson'];

    // Opponent replies accepted in the predict step: what they played + near-best engine replies.
    const replyPos = positions[ply];
    const acceptableReplyUcis = Array.from(
      new Set([
        ...(reply && !ENGINE_REPLY_CATEGORIES.includes(primary.category) ? [reply.uci] : []),
        ...acceptableMoves(replyPos, undefined, ENGINE_REPLY_CATEGORIES.includes(primary.category) ? 5 : 10),
      ]),
    );

    const sequence =
      ENGINE_REPLY_CATEGORIES.includes(primary.category)
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
    return {
      id: `${input.gameId}:${ply}`,
      ply,
      kind: 'mistake',
      category: primary.category,
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

