// AI walkthrough (pass 2): one lesson plan drives both the AI Coach review and the
// paced Guided Review. Stockfish grades every answer and supplies every line.
// Regression game: the student's draw as Black (19...e4 decision, 21.Nxe4 consequence).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coachFromPositions } from '../src/analysis/pipeline';
import { buildBetaContext, parseBetaReview } from '../src/coach/betaCoach';
import { buildWalkContext, gradeEvaluation, gradeOf, knownQuality, parseWalkthrough, planPlies, walkGrounding, walkPrompt, walkSteps, WALK_LIMITS } from '../src/coach/walkthrough';
import { GUIDED_REVIEW_SYSTEM_PROMPT } from '../src/coach/systemPrompt';
import { coachComplete } from '../server/coachApi';
import type { StoredGame } from '../src/domain/types';
import { fixtureGame } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

const { game: g0, positions } = fixtureGame('draw-game');
const game: StoredGame = { ...coachFromPositions(g0, positions, []).game, status: 'analyzed', aiCoachEval: JSON.parse(fixture('draw-game-beta-eval.json')) };
const plan = parseBetaReview(fixture('draw-game-mock-plan.json'), buildBetaContext(game, [game], 900)!, game, 'mock');
const ctx = buildWalkContext(game, [game], 900, plan)!;
const walk = parseWalkthrough(fixture('draw-game-mock-walk.json'), ctx, game, plan, 'mock');
const at = (ply: number, timing: 'before' | 'after') => walk.events.find((e) => e.ply === ply && e.timing === timing);

describe('the Game Lesson Plan (pass 1)', () => {
  it('carries the shared plan: sequences, strengths, mistakes, interactive moments, practice', () => {
    expect(plan.version).toBe(4);
    expect(plan.sequences).toEqual([expect.objectContaining({ id: 'break', decisionPly: 38, consequencePly: 41 })]);
    expect(plan.strengths.length).toBeGreaterThan(0);
    expect(plan.mistakes[0]).toMatch(/19\.\.\.e4/);
    expect(plan.interactive.map((m) => [m.ply, m.kind])).toEqual([
      [38, 'choose_plan'],
      [50, 'find_move'],
      [76, 'find_move'],
    ]);
    expect(planPlies(plan)).toEqual(expect.arrayContaining([38, 41, 50, 76]));
  });
});

describe('the walkthrough evidence (pass 2 input)', () => {
  const f = ctx.facts as any;
  it('gives the writer the plan, the timeline and Stockfish’s candidates at the plan’s moments, not the whole review prompt', () => {
    expect(f.plan.sequences[0].decisionPly).toBe(38);
    expect(f.evaluationTimeline).toHaveLength(game.plies.length);
    const plies = f.candidatePositions.map((p: any) => p.ply);
    for (const p of [38, 41, 50, 76, 90]) expect(plies).toContain(p);
    expect(f.ruleBasedDetections).toBeUndefined();
    expect(walkPrompt(ctx).length).toBeLessThan(70_000);
  });
});

describe('parsing the walkthrough', () => {
  it('stops before the decision with a graded plan question, using only Stockfish’s moves', () => {
    const e = at(38, 'before')!;
    expect(e.type).toBe('interactive');
    expect(e.sequenceId).toBe('break');
    expect(e.interaction!.kind).toBe('choose_plan');
    // Qd7 isn't a Stockfish candidate there: dropped. The move played (e4) may be an option.
    expect(e.interaction!.options!.map((o) => o.san)).toEqual(['Rfe8', 'e4', 'Bd6']);
    expect(e.explore!.map((x) => x.san)).toEqual(['Rfe8', 'Bf6']);
  });

  it('comments on the consequence afterwards, with the false praise of 19...e4 removed', () => {
    const e = at(41, 'after')!;
    expect(e.narration).toBe('21.Nxe4 collects the pawn.');
    expect(walk.removed.map((r) => r.text)).toContain('19...e4 was a strong central break.');
  });

  it('keeps questions about "your move" on the student’s own moves', () => {
    // 11.c3 is White's move: a find_move there becomes a plain explanation.
    expect(at(21, 'after')!.type).toBe('explain');
    expect(at(48, 'after')!.interaction!.kind).toBe('predict_reply');
    expect(at(50, 'before')!.interaction!.kind).toBe('find_move');
  });

  it('paces like a coach: most moves skipped, a few stops', () => {
    const steps = walkSteps(game, walk);
    const kinds = steps.map((s) => s.type);
    expect(kinds.filter((k) => k === 'skip').length).toBeGreaterThan(80);
    expect(kinds.filter((k) => k === 'interactive').length).toBeLessThanOrEqual(WALK_LIMITS.interactive);
    const before = steps.find((s) => s.ply === 38 && s.timing === 'before')!;
    expect(before.boardAnchorFen).toBe(game.plies[37].fenBefore);
    expect(before.engineEvidence).toMatchObject({ playedMove: 'e4', bestMove: 'Rfe8' });
  });

  it('caps the number of comments, keeping the plan’s moments', () => {
    const many = JSON.parse(fixture('draw-game-mock-walk.json'));
    for (let k = 1; k <= 30; k++) many.events.push({ ply: 2 * k + 1, timing: 'after', type: 'brief', narration: 'A quiet move.' });
    const w = parseWalkthrough(JSON.stringify(many), ctx, game, plan);
    expect(w.events.filter((e) => e.type === 'brief').length).toBe(WALK_LIMITS.brief);
    expect(w.events.some((e) => e.ply === 38 && e.timing === 'before')).toBe(true);
  });

  it('always stops before a plan sequence’s decision, even if the writer forgot', () => {
    const missing = JSON.parse(fixture('draw-game-mock-walk.json'));
    missing.events = missing.events.filter((e: any) => e.ply !== 38);
    const w = parseWalkthrough(JSON.stringify(missing), ctx, game, plan);
    expect(w.events.find((e) => e.ply === 38 && e.timing === 'before')).toMatchObject({ type: 'explain', sequenceId: 'break', title: 'The central break' });
  });

  it('is tied to the plan it was written from', () => {
    expect(walk.grounding).toBe(walkGrounding(plan));
    expect(walkGrounding({ ...plan, createdAt: plan.createdAt + 1 })).not.toBe(walk.grounding);
  });
});

describe('grading (Stockfish decides, the coach words it)', () => {
  const before38 = game.aiCoachEval!.positions[37];
  it('accepts several good moves, not just the engine’s first choice', () => {
    expect(knownQuality(before38, before38.lines[0].pv[0])!.quality).toBe('best');
    expect(gradeOf(knownQuality(before38, before38.lines[1].pv[0])!.quality)).toBe('correct');
    expect(gradeOf('good')).toBe('reasonable');
    expect(gradeOf('mistake')).toBe('misses');
  });

  it('grades "who is better" by Stockfish’s evaluation, with slack at the borders', () => {
    expect(gradeEvaluation(80, 'better')).toBe('correct');
    expect(gradeEvaluation(70, 'equal')).toBe('reasonable');
    expect(gradeEvaluation(-250, 'better')).toBe('misses');
  });
});

describe('the walkthrough prompt and token reporting', () => {
  it('uses the fixed server-side writer prompt and reports Gemini’s token counts', async () => {
    expect(GUIDED_REVIEW_SYSTEM_PROMPT).toMatch(/Most moves get NO event/);
    let system = '';
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      system = JSON.parse(String(init.body)).systemInstruction.parts[0].text;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 9000, candidatesTokenCount: 3000, thoughtsTokenCount: 1500 } }));
    }) as unknown as typeof fetch;
    try {
      const r = await coachComplete({ env: { GEMINI_API_KEY: 'k' }, hosted: false }, null, { prompt: 'facts', task: 'guided', maxTokens: 32000 });
      expect(r.body).toEqual({ text: '{}', usage: { input: 9000, output: 3000, thinking: 1500 } });
    } finally {
      globalThis.fetch = real;
    }
    expect(system).toBe(GUIDED_REVIEW_SYSTEM_PROMPT);
  });
});
