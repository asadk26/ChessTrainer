// The training plan for one game: the diagnosis (deterministic), its lessons and drills,
// the opening lesson when the weakness is in the opening, and the texts — written by the
// AI coach when available (it may choose among the formats each position supports and
// drop drills), otherwise by templates. Every AI sentence goes through the Stockfish referee.
import type { DrillFormat, OpeningLesson, StoredGame, TokenUsage, TrainingDrill, TrainingLesson, TrainingPlan } from '../domain/types';
import { COLOR_NAME, other } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { betaGrounding, buildBetaContext, checkText, type BetaContext } from '../coach/betaCoach';
import { extractJson } from '../coach/llmCoach';
import { CATEGORY_LABEL, type Diagnosis, type DrillDraft, type LessonDraft } from './diagnosis';
import { templateOpening } from './opening';

export const TRAINING_VERSION = 1;
type Line = Omit<OpeningLesson, 'title' | 'summary' | 'principles' | 'middlegamePlan' | 'traps'>;

const PRIORITY_TITLE: Record<Diagnosis['priority'], (d: Diagnosis) => string> = {
  opening_development: (d) => `This game exposed an opening-development weakness in the ${d.openingName}. Let's train the opening structure that led to it.`,
  blunder_check: () => 'This game was decided by moves that left something undefended. Let’s train the check before you let go of a piece.',
  missed_tactic: () => 'This game had winning tactics you didn’t see. Let’s train spotting them.',
  strategic_decision: () => 'This game turned on a decision in a quiet position. Let’s train choosing the plan before forcing play.',
  conversion: () => 'You were winning but kept giving it back. Let’s train converting an advantage cleanly.',
  endgame_technique: () => 'Your endgame defence decided this game. Let’s reinforce what worked.',
};

const label = (g: StoredGame, ply: number) => moveLabel(g.plies[ply - 1]);

/** Template texts for a drill, so training works without the AI coach. */
function templateDrill(d: DrillDraft, lesson: LessonDraft, gameOf: (id: string) => StoredGame | undefined): Pick<TrainingDrill, 'prompt' | 'hint' | 'feedback' | 'explanation'> {
  const g = gameOf(d.gameId);
  const at = g ? label(g, d.ply) : `ply ${d.ply}`;
  const opp = COLOR_NAME[d.toMove];
  const other_ = d.source === 'other_game' ? `From another of your games (${d.gameLabel}). ` : '';
  const feedback = {
    correct: 'Yes — Stockfish rates that as good as its first choice.',
    reasonable: 'Playable, but Stockfish sees something better here.',
    misses: `That misses the point: ${lesson.skill.charAt(0).toLowerCase()}${lesson.skill.slice(1)}`,
  };
  const explanation = [...d.facts, lesson.skill].join(' ');
  const prompts: Record<DrillFormat, string> = {
    opening_lesson: `Train the opening: a simple, sound way to play the ${d.about.replace(/^the /, '')}.`,
    strategic_choice:
      lesson.category === 'opening_development'
        ? `${other_}Before ${at}: which move keeps your development safe?`
        : lesson.category === 'conversion'
          ? `${other_}You're winning. Which move keeps it simple?`
          : `${other_}Which plan would you choose here?`,
    compare_plans: `${other_}Compare the moves: which is better here, and why?`,
    tactical_puzzle: lesson.category === 'missed_tactic' ? `${other_}There's a winning tactic here. Find it.` : `${other_}Find a safe, sound move — check what each move leaves undefended.`,
    predict_threat: `${at} has just been played. What is ${opp}'s strongest reply?`,
    replay_sequence: 'Play through to the decision, then choose your plan.',
    why_good: `You found this in the game (${at}). Find it again — what made it the right move?`,
    endgame_technique: `${other_}Find the move that holds this ending.`,
  };
  return { prompt: prompts[d.format], feedback, explanation };
}

// -------------------------------------------------------------- AI writer ---

/** What the training writer gets: the diagnosis, the drill positions with Stockfish's grades, and the opening line. */
export function trainingFacts(game: StoredGame, diag: Diagnosis, lessons: LessonDraft[], line: Line | undefined, gameOf: (id: string) => StoredGame | undefined, rating: number, story?: string) {
  return {
    student: { color: COLOR_NAME[game.userColor], rating, result: game.outcome ?? game.headers.result },
    gameStory: story,
    diagnosis: {
      priority: diag.priority,
      considered: diag.scores.map((s) => ({ category: s.category, label: CATEGORY_LABEL[s.category], score: Math.round(s.score * 10) / 10, reason: s.reason })),
      opening: diag.openingName,
    },
    lessons: lessons.map((l) => ({
      id: l.id,
      category: l.category,
      skill: l.skill,
      why: l.why,
      evidence: l.signals.map((x) => x.text),
      drills: l.drafts.map((d) => ({
        id: d.id,
        allowedFormats: d.formats,
        source: d.source,
        game: d.gameLabel,
        position: d.format === 'predict_threat' ? `after ${label(gameOf(d.gameId)!, d.ply)}` : d.format === 'opening_lesson' ? 'the opening' : `before ${label(gameOf(d.gameId)!, d.ply)}`,
        toMove: COLOR_NAME[d.toMove],
        stockfishGrades: (d.options ?? d.graded).slice(0, 5).map((m) => `${m.san}: ${m.quality}`),
        facts: d.facts,
        sequence: d.sequence && `${label(gameOf(d.gameId)!, d.sequence.fromPly)} … ${label(gameOf(d.gameId)!, d.sequence.toPly)}, decision at ${label(gameOf(d.gameId)!, d.sequence.decisionPly)}`,
      })),
    })),
    opening: line && {
      name: line.name,
      deviation: line.deviation && `In the game you played ${line.deviation.played} at ply ${line.deviation.ply}; the line uses ${line.deviation.recommended}.`,
      endReason: line.endReason,
      lichessData: line.lichess,
      steps: line.steps.map((s) => ({
        ply: s.ply,
        side: s.side,
        move: s.move.san,
        acceptable: s.acceptable?.map((a) => `${a.san} (${a.quality})`),
        players: s.candidates?.filter((c) => c.share !== undefined).map((c) => `${c.san} ${Math.round((c.share ?? 0) * 100)}%`) ?? s.popular?.map((p) => `${p.san} ${Math.round(p.share * 100)}%`),
        inYourGame: s.inGame && `${s.inGame.san} (${s.inGame.quality})`,
        stillAtHome: s.side === 'yours' ? s.undeveloped : undefined,
        castled: s.side === 'yours' ? s.castled : undefined,
        guardDuties: s.duties.length ? s.duties : undefined,
        whatTheMoveDoes: s.idea,
      })),
    },
  };
}

interface Written {
  priority?: { title?: string; why?: string };
  lessons?: { id?: string; title?: string; skill?: string; why?: string; drills?: { id?: string; keep?: boolean; format?: string; prompt?: string; hint?: string; feedback?: { correct?: string; reasonable?: string; misses?: string }; explanation?: string }[] }[];
  opening?: { title?: string; summary?: string; principles?: string[]; middlegamePlan?: string; traps?: string[]; steps?: { ply?: number; idea?: string }[] };
}

const SAN = /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?/g;
/** Opening texts: every move named must be in the line, its candidates, or what players chose. */
function checkOpeningText(text: string, allowed: Set<string>, removed: TrainingPlan['removed']): string {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  return sentences
    .filter((s) => {
      const bad = (s.match(SAN) ?? []).map((m) => m.replace(/[+#]$/, '')).find((m) => !allowed.has(m));
      if (bad) removed.push({ text: s, reason: `${bad} is not in the opening line or Stockfish's candidates there` });
      return !bad;
    })
    .join(' ')
    .trim();
}

/**
 * Assemble the plan: deterministic positions and grades, with the AI coach's texts and
 * format choices where given (refereed), templates elsewhere.
 */
export function assemblePlan(args: {
  game: StoredGame;
  all: StoredGame[];
  rating: number;
  diag: Diagnosis;
  lessons: LessonDraft[];
  line?: Line;
  written?: string;
  model?: string;
  usage?: TokenUsage;
  planCreatedAt?: number;
}): TrainingPlan {
  const { game, all, diag, lessons, line } = args;
  const gameOf = (id: string) => all.find((g) => g.id === id) ?? (id === game.id ? game : undefined);
  const removed: TrainingPlan['removed'] = [];
  let w: Written = {};
  if (args.written) {
    try {
      w = extractJson(args.written) as Written;
    } catch {
      w = {};
    }
  }
  const ctxs = new Map<string, BetaContext | undefined>();
  const ctxOf = (id: string) => {
    if (!ctxs.has(id)) {
      const g = gameOf(id);
      ctxs.set(id, g ? buildBetaContext(g, all, args.rating) : undefined);
    }
    return ctxs.get(id);
  };
  const check = (id: string, v: unknown, max: number) => {
    const g = gameOf(id);
    const ctx = ctxOf(id);
    const t = typeof v === 'string' ? v.trim().slice(0, max) : '';
    if (!t || !g || !ctx) return '';
    const c = checkText(t, ctx, g);
    removed.push(...c.removed);
    return c.text;
  };

  const outLessons: TrainingLesson[] = lessons.map((l) => {
    const wl = w.lessons?.find((x) => x.id === l.id);
    const drills: TrainingDrill[] = [];
    for (const d of l.drafts) {
      const wd = wl?.drills?.find((x) => x.id === d.id);
      if (wd?.keep === false && d.format !== 'opening_lesson') continue; // the coach may drop a drill, never add one
      const format = (wd?.format && d.formats.includes(wd.format as DrillFormat) ? wd.format : d.format) as DrillFormat;
      const tpl = templateDrill({ ...d, format }, l, gameOf);
      const prompt = check(d.gameId, wd?.prompt, 300) || tpl.prompt;
      const options = (format === 'strategic_choice' || format === 'compare_plans' || format === 'replay_sequence') && !d.options ? d.graded.slice(0, 3) : d.options;
      drills.push({
        ...d,
        format,
        options,
        prompt,
        hint: check(d.gameId, wd?.hint, 200) || undefined,
        feedback: {
          correct: check(d.gameId, wd?.feedback?.correct, 400) || tpl.feedback.correct,
          reasonable: check(d.gameId, wd?.feedback?.reasonable, 400) || tpl.feedback.reasonable,
          misses: check(d.gameId, wd?.feedback?.misses, 400) || tpl.feedback.misses,
        },
        explanation: check(d.gameId, wd?.explanation, 900) || tpl.explanation,
      });
    }
    return {
      id: l.id,
      category: l.category,
      title: check(game.id, wl?.title, 90) || l.title,
      skill: check(game.id, wl?.skill, 200) || l.skill,
      why: check(game.id, wl?.why, 600) || l.why,
      signals: l.signals,
      drills,
    };
  });

  let opening: OpeningLesson | undefined;
  if (line) {
    const t = templateOpening(line);
    const allowed = new Set<string>();
    line.steps.forEach((s) => {
      allowed.add(s.move.san.replace(/[+#]$/, ''));
      s.acceptable?.forEach((a) => allowed.add(a.san.replace(/[+#]$/, '')));
      s.candidates?.forEach((a) => allowed.add(a.san.replace(/[+#]$/, '')));
      s.popular?.forEach((a) => allowed.add(a.san.replace(/[+#]$/, '')));
      if (s.inGame) allowed.add(s.inGame.san.replace(/[+#]$/, ''));
    });
    game.plies.slice(0, 30).forEach((p) => allowed.add(p.san.replace(/[+#]$/, '')));
    const o = w.opening ?? {};
    const oc = (v: unknown, max: number) => (typeof v === 'string' ? checkOpeningText(v.slice(0, max), allowed, removed) : '');
    opening = {
      ...t,
      title: oc(o.title, 100) || t.title,
      summary: oc(o.summary, 900) || t.summary,
      principles: (o.principles ?? []).slice(0, 5).map((x) => oc(x, 200)).filter(Boolean),
      middlegamePlan: oc(o.middlegamePlan, 600) || t.middlegamePlan,
      traps: (o.traps ?? []).slice(0, 3).map((x) => oc(x, 300)).filter(Boolean),
      steps: t.steps.map((s) => {
        const idea = oc(o.steps?.find((x) => x.ply === s.ply)?.idea, 400);
        return idea ? { ...s, idea } : s;
      }),
    };
    if (!opening.principles.length) opening.principles = t.principles;
  }

  const top = diag.scores[0];
  return {
    version: 1,
    priority: {
      category: diag.priority,
      title: check(game.id, w.priority?.title, 200) || PRIORITY_TITLE[diag.priority](diag),
      why: check(game.id, w.priority?.why, 700) || `${CATEGORY_LABEL[diag.priority]}: ${top?.reason ?? ''}.`,
      signals: lessons.find((l) => l.category === diag.priority)?.signals ?? [],
    },
    considered: diag.scores.map((s) => ({ category: s.category, score: Math.round(s.score * 10) / 10, reason: s.reason })),
    lessons: outLessons.filter((l) => l.drills.length),
    opening,
    writtenBy: w.priority || w.lessons?.length || w.opening ? (args.model ?? 'AI') : 'template',
    usage: args.usage,
    removed,
    createdAt: Date.now(),
    grounding: trainingGrounding(game, all, args.planCreatedAt),
  };
}

export function trainingGrounding(game: StoredGame, all: StoredGame[], planCreatedAt?: number): string {
  return `t${TRAINING_VERSION}|${betaGrounding(game)}|${planCreatedAt ?? 0}|${all.filter((g) => g.status === 'analyzed').length}`;
}

export function trainingPrompt(facts: unknown): string {
  return `Build this student's training from the diagnosis below. Stockfish's grades and the positions are fixed; you choose formats among those allowed, may drop drills that don't help, and write the coaching.\n\n${JSON.stringify(facts, null, 1)}`;
}

export const opponentOf = other;
