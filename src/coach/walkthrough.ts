// AI walkthrough (pass 2 of the Beta AI Coach): the Game Lesson Plan turned into a paced,
// move-by-move Guided Review. Written once by the model from the plan plus Stockfish's
// evidence; replayed with no AI calls. Stockfish grades every answer and supplies every
// line; the model writes the questions, the feedback for each grade, and the narration.
import { Chess } from 'chess.js';
import type { AiWalkthrough, BetaCoachReview, PositionEval, StoredGame, WalkEvent, WalkInteraction, WalkInteractionKind } from '../domain/types';
import { moveLabel } from '../chess/pgn';
import { positionCp, scoreToCp } from '../analysis/evaluation';
import { gapBetween, qualityOfGap, rankCandidates, type Quality } from '../analysis/moveQuality';
import { lineToSan, sideToMove } from '../chess/board';
import { betaPositions, buildBetaContext, checkText, fmtEval, type BetaContext } from './betaCoach';
import { extractJson } from './llmCoach';
import { UngroundedError } from './momentContext';

export const WALK_VERSION = 1;
/** Pacing limits for a normal game (the prompt asks for fewer). */
export const WALK_LIMITS = { brief: 12, explain: 7, interactive: 4 } as const;

const strip = (san: string) => san.replace(/[+#?!]+$/, '');

/** The plies the plan cares about: they get Stockfish's candidates in the walkthrough evidence. */
export function planPlies(plan: BetaCoachReview): number[] {
  const out = new Set<number>();
  for (const c of plan.chapters) [c.anchorPly, c.decisionPly, c.consequencePly].forEach((p) => p && out.add(p));
  for (const q of plan.sequences) [q.decisionPly, q.consequencePly].forEach((p) => p && out.add(p));
  plan.interactive.forEach((m) => out.add(m.ply));
  plan.practice.forEach((m) => out.add(m.ply));
  return [...out].sort((a, b) => a - b);
}

export function walkGrounding(plan: BetaCoachReview): string {
  return `w${WALK_VERSION}|${plan.createdAt}|${plan.grounding}`;
}

/** Evidence for the walkthrough writer: the plan, the timeline, and Stockfish's candidates at the plan's moments. */
export function buildWalkContext(game: StoredGame, all: StoredGame[], rating: number, plan: BetaCoachReview): BetaContext | undefined {
  const ctx = buildBetaContext(game, all, rating, { extraPlies: planPlies(plan) });
  if (!ctx) return undefined;
  const f = ctx.facts as Record<string, unknown>;
  ctx.facts = {
    student: f.student,
    evaluationScale: f.evaluationScale,
    engine: f.engine,
    plan: {
      story: plan.story,
      chapters: plan.chapters.map((c) => ({
        title: c.title,
        fromPly: c.fromPly,
        toPly: c.toPly,
        anchorPly: c.anchorPly,
        decisionPly: c.decisionPly,
        consequencePly: c.consequencePly,
        assessment: c.assessment,
        narrative: c.narrative,
        lesson: c.lesson || undefined,
      })),
      sequences: plan.sequences,
      strengths: plan.strengths,
      mistakes: plan.mistakes,
      lessons: plan.lessons,
      interactiveMoments: plan.interactive,
      practice: plan.practice,
    },
    evaluationTimeline: f.evaluationTimeline,
    materialTimeline: f.materialTimeline,
    phaseMarkers: f.phaseMarkers,
    candidatePositions: f.candidatePositions,
  };
  return ctx;
}

export function walkPrompt(ctx: BetaContext): string {
  return `Turn this game lesson plan into a paced walkthrough on the board. The plan and Stockfish's evidence follow.\n\n${JSON.stringify(ctx.facts, null, 1)}`;
}

// ------------------------------------------------------------- parsing ---

const TYPES = ['brief', 'explain', 'interactive'] as const;
const KINDS: WalkInteractionKind[] = ['find_move', 'predict_reply', 'choose_plan', 'evaluate_position', 'compare_moves'];
const RANK = { brief: 0, explain: 1, interactive: 2 } as const;

/** A SAN the coach named at the position before `ply`, if it is a Stockfish candidate there or the move played. */
function resolveOption(game: StoredGame, ctx: BetaContext, ply: number, san: unknown): { uci: string; san: string } | undefined {
  if (typeof san !== 'string') return undefined;
  const p = game.plies[ply - 1];
  const want = strip(san.trim().replace(/^\d+\.+\s*/, ''));
  const allowed = new Set([...(ctx.candidatesAt.get(ply - 1) ?? []), strip(p.san)]);
  if (!allowed.has(want)) return undefined;
  try {
    const m = new Chess(p.fenBefore).move(want);
    return { uci: m.from + m.to + (m.promotion ?? ''), san: m.san };
  } catch {
    return undefined;
  }
}

/** Parse and referee the walkthrough; enforce pacing and consistency with the plan. */
export function parseWalkthrough(text: string, ctx: BetaContext, game: StoredGame, plan: BetaCoachReview, model?: string): AiWalkthrough {
  const raw = extractJson(text) as { events?: unknown };
  const removed: AiWalkthrough['removed'] = [];
  const check = (v: unknown, max: number) => {
    const c = checkText(typeof v === 'string' ? v.trim().slice(0, max) : '', ctx, game);
    removed.push(...c.removed);
    return c.text;
  };
  const user = game.userColor;
  const n = game.plies.length;
  const isUserPly = (k: number) => game.plies[k - 1]?.color === user;

  const events: WalkEvent[] = [];
  for (const e of Array.isArray(raw.events) ? (raw.events as any[]) : []) {
    const ply = Number(e?.ply);
    if (!Number.isInteger(ply) || ply < 1 || ply > n) continue;
    let type = TYPES.includes(e?.type) ? (e.type as WalkEvent['type']) : 'brief';
    let timing: WalkEvent['timing'] = e?.timing === 'before' ? 'before' : 'after';
    const narration = check(e?.narration, type === 'brief' ? 220 : 1100);
    let interaction: WalkInteraction | undefined;
    if (type === 'interactive') {
      interaction = parseInteraction(e?.interaction, ply);
      if (!interaction) type = 'explain';
      else timing = interaction.kind === 'predict_reply' ? 'after' : 'before';
    }
    if (!narration && !interaction) continue;
    const explore = (Array.isArray(e?.explore) ? e.explore : [])
      .slice(0, 3)
      .map((x: any) => {
        const o = resolveOption(game, ctx, ply, x?.move);
        const label = check(x?.label, 160);
        return o && label ? { ...o, label } : undefined;
      })
      .filter(Boolean) as WalkEvent['explore'];
    events.push({
      ply,
      timing,
      type,
      title: check(e?.title, 80) || undefined,
      narration,
      sequenceId: typeof e?.sequenceId === 'string' && plan.sequences.some((q) => q.id === e.sequenceId) ? e.sequenceId : undefined,
      interaction,
      explore: explore?.length ? explore : undefined,
      takeaway: check(e?.takeaway, 200) || undefined,
    });
  }

  function parseInteraction(x: any, ply: number): WalkInteraction | undefined {
    const kind = KINDS.includes(x?.kind) ? (x.kind as WalkInteractionKind) : undefined;
    if (!kind) return undefined;
    // Questions about "your move" must be at the student's own moves.
    if ((kind === 'find_move' || kind === 'predict_reply' || kind === 'choose_plan') && !isUserPly(ply)) return undefined;
    if (kind === 'predict_reply' && ply >= n) return undefined;
    const prompt = check(x?.prompt, 300);
    const feedback = { correct: check(x?.feedback?.correct, 500), reasonable: check(x?.feedback?.reasonable, 500), misses: check(x?.feedback?.misses, 500) };
    const reveal = check(x?.reveal, 900);
    if (!prompt) return undefined;
    let options: WalkInteraction['options'];
    if (kind === 'choose_plan' || kind === 'compare_moves') {
      const seen = new Set<string>();
      options = (Array.isArray(x?.options) ? x.options : [])
        .slice(0, 4)
        .map((o: any) => {
          const m = resolveOption(game, ctx, ply, o?.move);
          const label = check(o?.label, 160) || m?.san;
          if (!m || seen.has(m.uci)) return undefined;
          seen.add(m.uci);
          return { ...m, label };
        })
        .filter(Boolean) as WalkInteraction['options'];
      if (!options || options.length < 2) return isUserPly(ply) ? { kind: 'find_move', prompt, hint: check(x?.hint, 200) || undefined, feedback, reveal } : undefined;
    }
    return { kind, prompt, hint: check(x?.hint, 200) || undefined, options, feedback, reveal };
  }

  // One event per stop: keep the most substantial.
  const byStop = new Map<string, WalkEvent>();
  for (const e of events) {
    const key = `${e.ply}:${e.timing}`;
    const had = byStop.get(key);
    if (!had || RANK[e.type] > RANK[had.type]) byStop.set(key, e);
  }
  let out = [...byStop.values()];

  // Consistency with the plan: every causal sequence stops before its decision.
  for (const q of plan.sequences) {
    if (!out.some((e) => e.ply === q.decisionPly && e.timing === 'before' && e.type !== 'brief')) {
      out = out.filter((e) => !(e.ply === q.decisionPly && e.timing === 'before'));
      out.push({ ply: q.decisionPly, timing: 'before', type: 'explain', title: q.title, narration: q.explanation, sequenceId: q.id });
    }
  }

  // Pacing: keep the plan's moments first, then the earliest.
  const key = new Set(planPlies(plan));
  const keep = (type: WalkEvent['type']) => {
    const of = out.filter((e) => e.type === type).sort((a, b) => Number(key.has(b.ply)) - Number(key.has(a.ply)) || a.ply - b.ply);
    const extra = new Set(of.slice(WALK_LIMITS[type]));
    out = out.filter((e) => !extra.has(e));
  };
  TYPES.forEach(keep);
  out.sort((a, b) => a.ply - b.ply || (a.timing === 'before' ? -1 : 1));
  if (out.length < 3) throw new UngroundedError('The AI walkthrough had too few stops that agreed with the engine analysis.');
  return { version: 1, events: out, removed, model, createdAt: Date.now(), grounding: walkGrounding(plan) };
}

// ------------------------------------------------------------- grading ---

export type Grade = 'correct' | 'reasonable' | 'misses';

/** Stockfish's bands, as a teacher would grade: several moves can be right. */
export function gradeOf(q: Quality): Grade {
  return q === 'best' || q === 'equal' ? 'correct' : q === 'good' ? 'reasonable' : 'misses';
}

/** The quality of `uci` at `pos` when it is one of the stored candidate lines (mover's point of view). */
export function knownQuality(pos: PositionEval, uci: string): { quality: Quality; cp: number } | undefined {
  const r = rankCandidates(pos).find((c) => c.uci === uci);
  return r ? { quality: r.quality, cp: r.cp } : undefined;
}

/** Quality of a move whose resulting position was analysed live (cp from the side that moved). */
export function qualityFromAfter(pos: PositionEval, uci: string, after: PositionEval): { quality: Quality; cp: number } {
  const bestCp = scoreToCp(pos.lines[0].score);
  const cp = -positionCp(after);
  return { quality: qualityOfGap(gapBetween(bestCp, cp), pos.lines[0].pv[0] === uci), cp };
}

/** "Who is better here?": Stockfish's evaluation for the student, in three bands (borderline answers are reasonable). */
export function gradeEvaluation(cpForStudent: number, answer: 'better' | 'equal' | 'worse'): Grade {
  const band = cpForStudent >= 60 ? 'better' : cpForStudent <= -60 ? 'worse' : 'equal';
  if (band === answer) return 'correct';
  const borderline = Math.abs(Math.abs(cpForStudent) - 60) <= 30;
  return borderline && (answer === 'equal' || band === 'equal') ? 'reasonable' : 'misses';
}

// ------------------------------------------------------- full sequence ---

export interface WalkStep {
  ply: number;
  move: string;
  type: 'skip' | WalkEvent['type'];
  timing?: WalkEvent['timing'];
  title?: string;
  narration?: string;
  boardAnchorFen: string;
  sequenceId?: string;
  engineEvidence: { evalBefore: string; evalAfter: string; bestMove?: string; playedMove: string; pv?: string[] };
  interaction?: WalkInteraction;
  explore?: WalkEvent['explore'];
  takeaway?: string;
}

/**
 * Every ply of the game as the walkthrough treats it: skipped, or the event(s) there,
 * with the board position and Stockfish's evidence attached (from the engine, not the model).
 */
export function walkSteps(game: StoredGame, w: AiWalkthrough): WalkStep[] {
  const positions = betaPositions(game);
  const user = game.userColor;
  const cpUser = (i: number) => {
    const p = positions[i];
    if (!p) return 0;
    const v = positionCp(p);
    return sideToMove(p.fen) === user ? v : -v;
  };
  const out: WalkStep[] = [];
  game.plies.forEach((p, i) => {
    const k = i + 1;
    const before = positions[k - 1];
    const evidence = {
      evalBefore: fmtEval(cpUser(k - 1)),
      evalAfter: fmtEval(cpUser(k)),
      bestMove: before?.lines[0] ? lineToSan(p.fenBefore, before.lines[0].pv, 1)[0] : undefined,
      playedMove: p.san,
      pv: before?.lines[0] ? lineToSan(p.fenBefore, before.lines[0].pv, 6) : undefined,
    };
    const here = w.events.filter((e) => e.ply === k);
    if (!here.length) out.push({ ply: k, move: moveLabel(p), type: 'skip', boardAnchorFen: p.fenAfter, engineEvidence: evidence });
    for (const e of here)
      out.push({
        ply: k,
        move: moveLabel(p),
        type: e.type,
        timing: e.timing,
        title: e.title,
        narration: e.narration,
        boardAnchorFen: e.timing === 'before' ? p.fenBefore : p.fenAfter,
        sequenceId: e.sequenceId,
        engineEvidence: evidence,
        interaction: e.interaction,
        explore: e.explore,
        takeaway: e.takeaway,
      });
  });
  return out;
}

export function currentWalkthrough(game: StoredGame, plan: BetaCoachReview | undefined): AiWalkthrough | undefined {
  const w = game.aiWalkthrough;
  return w && plan && w.version === WALK_VERSION ? w : undefined;
}
