// CLI for the Beta AI Coach experiment: run the whole chain on one PGN in Node.
//
//   npm run beta-review -- game.pgn b [--rating 900] [--out beta-out] [--positions recorded-positions.json]
//                         [--plan-answer recorded.json --walk-answer recorded.json]   (no key needed)
//
// 1. Stockfish analyses every position (depth 12, MultiPV 3) and re-checks the
//    built-in coach's critical positions at depth 18, exactly as the app does.
// 2. The Beta pass evaluates every position again at one depth (16), so move effects compare like with like.
// 3. Writes the exact evidence sent to the model: <out>/context.json and <out>/prompt.txt.
// 4. If GEMINI_API_KEY is set (in the environment or .env.local), calls Gemini with the
//    fixed server-side prompt, referees the answer, and writes <out>/review.json and
//    <out>/review.md (including every statement the referee removed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeEngine } from '../server/nodeEngine.ts';
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from '../server/llm.ts';
import { analyzeGame, coachFromPositions } from '../src/analysis/pipeline.ts';
import { parsePgn, moveLabel } from '../src/chess/pgn.ts';
import { BETA_DEPTH, betaPrompt, buildBetaContext, evaluateForBeta, parseBetaReview } from '../src/coach/betaCoach.ts';
import { BETA_COACH_SYSTEM_PROMPT, GUIDED_REVIEW_SYSTEM_PROMPT } from '../src/coach/systemPrompt.ts';
import { buildWalkContext, parseWalkthrough, walkPrompt, walkSteps } from '../src/coach/walkthrough.ts';
import type { BetaCoachReview, PositionEval, StoredGame } from '../src/domain/types.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const [file, color = 'w'] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('usage: npm run beta-review -- game.pgn [w|b] [--rating 900] [--out beta-out]');
  process.exit(1);
}
const rating = Number(opt('rating', '900'));
const out = opt('out', 'beta-out');
mkdirSync(out, { recursive: true });

// Read GEMINI_* from .env.local / .env without a dependency.
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*(GEMINI_API_KEY|GEMINI_MODEL)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const parsed = parsePgn(readFileSync(file, 'utf8'));
const userColor = color === 'b' ? 'b' : 'w';
let game: StoredGame = {
  id: 'cli',
  importedAt: Date.now(),
  pgn: parsed.pgn,
  headers: parsed.headers,
  userColor,
  userName: userColor === 'w' ? parsed.headers.white : parsed.headers.black,
  opponentName: userColor === 'w' ? parsed.headers.black : parsed.headers.white,
  plies: parsed.plies,
  status: 'imported',
  findings: [],
  moments: [],
  drillIds: [],
  completedMomentIds: [],
};

const recorded = opt('positions', '');
let own: { depth: number; positions: PositionEval[] };
if (recorded) {
  // Reuse recorded Stockfish output (e.g. the test fixtures) instead of running the engine.
  game = { ...coachFromPositions(game, JSON.parse(readFileSync(recorded, 'utf8')), []).game, status: 'analyzed' };
  own = JSON.parse(readFileSync(opt('beta-eval', recorded.replace('-positions.json', '-beta-eval.json')), 'utf8'));
} else {
  const engine = createNodeEngine();
  const progress = (label: string) => (done: number, total: number) => process.stderr.write(`\r${label} ${done}/${total}   `);
  game = (await analyzeGame(game, engine, { depth: 12, prior: [], onProgress: progress('Stockfish') })).game;
  game.status = 'analyzed';
  own = await evaluateForBeta(game, (fen) => engine.analyse(fen, { depth: BETA_DEPTH, multiPv: 3 }), progress(`Beta pass at depth ${BETA_DEPTH}`));
  engine.dispose();
  process.stderr.write('\n');
}
game = { ...game, aiCoachEval: own };
writeFileSync(join(out, 'positions.json'), JSON.stringify(game.analysis!.positions));
writeFileSync(join(out, 'beta-eval.json'), JSON.stringify(own));

const ctx = buildBetaContext(game, [game], rating)!;
writeFileSync(join(out, 'context.json'), JSON.stringify(ctx.facts, null, 1));
writeFileSync(join(out, 'prompt.txt'), `=== SYSTEM (fixed, server-side) ===\n${BETA_COACH_SYSTEM_PROMPT}\n\n=== USER ===\n${betaPrompt(ctx)}\n`);
console.log(`Wrote ${out}/context.json and ${out}/prompt.txt (${betaPrompt(ctx).length} characters of evidence).`);

// The two model calls: real Gemini with a key, or recorded answers (--plan-answer / --walk-answer)
// so the whole pipeline can be inspected without one.
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const provider = key ? new GeminiProvider(key, model) : undefined;
const ask = async (system: string, prompt: string, recorded: string, label: string) => {
  if (recorded) return { text: readFileSync(recorded, 'utf8'), usage: undefined, source: `recorded answer ${recorded}` };
  if (!provider) return undefined;
  console.log(`Asking ${model} for the ${label}…`);
  const text = await provider.complete({ system, prompt, maxTokens: 32000 });
  return { text, usage: provider.lastUsage, source: model };
};
const estimate = (chars: number) => `~${Math.round(chars / 4).toLocaleString()} tokens`;

const planAnswer = await ask(BETA_COACH_SYSTEM_PROMPT, betaPrompt(ctx), opt('plan-answer', ''), 'lesson plan');
if (!planAnswer) {
  console.log(`No GEMINI_API_KEY set: stopping before the model call. Plan prompt is ${estimate(betaPrompt(ctx).length + BETA_COACH_SYSTEM_PROMPT.length)}.`);
  process.exit(0);
}
writeFileSync(join(out, 'raw-plan.json'), planAnswer.text);
const review = { ...parseBetaReview(planAnswer.text, ctx, game, planAnswer.source), usage: planAnswer.usage };
writeFileSync(join(out, 'review.json'), JSON.stringify(review, null, 1));
writeFileSync(join(out, 'review.md'), toMarkdown(review, game));
console.log(`Wrote ${out}/review.md (${review.chapters.length} chapters, ${review.removed.length} statements removed by the referee).`);

const wctx = buildWalkContext(game, [game], rating, review)!;
writeFileSync(join(out, 'walk-prompt.txt'), `=== SYSTEM (fixed, server-side) ===\n${GUIDED_REVIEW_SYSTEM_PROMPT}\n\n=== USER ===\n${walkPrompt(wctx)}\n`);
const walkAnswer = await ask(GUIDED_REVIEW_SYSTEM_PROMPT, walkPrompt(wctx), opt('walk-answer', ''), 'walkthrough');
if (!walkAnswer) process.exit(0);
writeFileSync(join(out, 'raw-walk.json'), walkAnswer.text);
const walk = { ...parseWalkthrough(walkAnswer.text, wctx, game, review, walkAnswer.source), usage: walkAnswer.usage };
const steps = walkSteps(game, walk);
writeFileSync(join(out, 'walkthrough.json'), JSON.stringify(steps, null, 1));
writeFileSync(join(out, 'walkthrough.md'), walkMarkdown(steps, walk.removed));
const tokens = [
  `Plan prompt: ${estimate(betaPrompt(ctx).length + BETA_COACH_SYSTEM_PROMPT.length)} in${review.usage ? ` (Gemini reported ${review.usage.input} in / ${review.usage.output} out / ${review.usage.thinking ?? 0} thinking)` : ''}, answer ${estimate(planAnswer.text.length)}`,
  `Walkthrough prompt: ${estimate(walkPrompt(wctx).length + GUIDED_REVIEW_SYSTEM_PROMPT.length)} in${walk.usage ? ` (Gemini reported ${walk.usage.input} in / ${walk.usage.output} out / ${walk.usage.thinking ?? 0} thinking)` : ''}, answer ${estimate(walkAnswer.text.length)}`,
];
writeFileSync(join(out, 'tokens.txt'), tokens.join('\n') + '\n');
console.log(`Wrote ${out}/walkthrough.md (${walk.events.length} stops). ${tokens.join(' · ')}`);

function walkMarkdown(steps: ReturnType<typeof walkSteps>, removed: { text: string; reason: string }[]): string {
  const lines = ['# AI walkthrough', '', '| ply | move | type | timing | board | Stockfish (for you) |', '|---|---|---|---|---|---|'];
  for (const s of steps) {
    if (s.type === 'skip') continue;
    lines.push(`| ${s.ply} | ${s.move} | ${s.type}${s.interaction ? ` (${s.interaction.kind})` : ''} | ${s.timing} | ${s.timing === 'before' ? 'before the move' : 'after the move'} | ${s.engineEvidence.evalBefore} → ${s.engineEvidence.evalAfter}; best ${s.engineEvidence.bestMove} |`);
  }
  const skipped = steps.filter((s) => s.type === 'skip').map((s) => s.move);
  lines.push('', `**Skipped (${skipped.length} moves):** ${skipped.join(' ')}`, '');
  for (const s of steps) {
    if (s.type === 'skip') continue;
    lines.push(`## ${s.timing === 'before' ? 'Before ' : ''}${s.move} — ${s.type}${s.title ? `: ${s.title}` : ''}`, '', s.narration ?? '', '');
    if (s.interaction) {
      const i = s.interaction;
      lines.push(`**${i.kind}:** ${i.prompt}`, '');
      if (i.options) lines.push(...i.options.map((o) => `- option ${o.san}: ${o.label}`), '');
      lines.push(`- correct: ${i.feedback.correct}`, `- reasonable: ${i.feedback.reasonable}`, `- misses: ${i.feedback.misses}`, `- reveal: ${i.reveal}`, '');
    }
    if (s.explore) lines.push(...s.explore.map((x) => `- explore ${x.san}: ${x.label}`), '');
    if (s.takeaway) lines.push(`**Takeaway:** ${s.takeaway}`, '');
  }
  lines.push('## Removed by the Stockfish referee', ...(removed.length ? removed.map((x) => `- "${x.text}" — ${x.reason}`) : ['- nothing']));
  return lines.join('\n');
}

function toMarkdown(r: BetaCoachReview, g: StoredGame): string {
  const l = (ply?: number) => (ply && g.plies[ply - 1] ? moveLabel(g.plies[ply - 1]) : '?');
  const lines = [`# Beta AI review (${r.model})`, '', r.story, ''];
  for (const c of r.chapters) {
    lines.push(`## ${c.title}`, `*${l(c.fromPly)} – ${l(c.toPly)} · ${c.kind} · ${c.assessment} · board before ${l(c.anchorPly)}${c.explore ? ' · explore' : ''}*`, '');
    if (c.decisionPly && c.consequencePly) lines.push(`Decision ${l(c.decisionPly)} → consequence ${l(c.consequencePly)}`, '');
    lines.push(c.narrative, '');
    if (c.lesson) lines.push(`**Lesson:** ${c.lesson}`, '');
    c.evidence.forEach((e) => lines.push(`- ${e}`));
    lines.push('');
  }
  lines.push('## What this game teaches you', ...r.lessons.map((x) => `- ${x}`), '', '## Practise these positions', ...r.practice.map((p) => `- before ${l(p.ply)}: ${p.why}`), '');
  lines.push('## Removed by the Stockfish referee', ...(r.removed.length ? r.removed.map((x) => `- "${x.text}" — ${x.reason}`) : ['- nothing']));
  return lines.join('\n');
}
