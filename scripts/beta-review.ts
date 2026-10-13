// CLI for the Beta AI Coach experiment: run the whole chain on one PGN in Node.
//
//   npm run beta-review -- game.pgn b [--rating 900] [--out beta-out] [--positions recorded-positions.json]
//
// 1. Stockfish analyses every position (depth 12, MultiPV 3) and re-checks the
//    built-in coach's critical positions at depth 18, exactly as the app does.
// 2. The Beta deep pass re-checks the positions around the evaluation shifts at depth 18.
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
import { BETA_DEEP_DEPTH, betaPrompt, buildBetaContext, deepenForBeta, parseBetaReview } from '../src/coach/betaCoach.ts';
import { BETA_COACH_SYSTEM_PROMPT } from '../src/coach/systemPrompt.ts';
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
let deep: Record<number, PositionEval>;
if (recorded) {
  // Reuse recorded Stockfish output (e.g. the test fixtures) instead of running the engine.
  game = { ...coachFromPositions(game, JSON.parse(readFileSync(recorded, 'utf8')), []).game, status: 'analyzed' };
  deep = JSON.parse(readFileSync(opt('deep', recorded.replace('-positions.json', '-beta-deep.json')), 'utf8'));
} else {
  const engine = createNodeEngine();
  const progress = (label: string) => (done: number, total: number) => process.stderr.write(`\r${label} ${done}/${total}   `);
  game = (await analyzeGame(game, engine, { depth: 12, prior: [], onProgress: progress('Stockfish') })).game;
  game.status = 'analyzed';
  deep = await deepenForBeta(game, (fen) => engine.analyse(fen, { depth: BETA_DEEP_DEPTH, multiPv: 3 }), progress(`Beta re-check at depth ${BETA_DEEP_DEPTH}`));
  engine.dispose();
  process.stderr.write('\n');
}
game = { ...game, aiCoachDeep: deep };
writeFileSync(join(out, 'positions.json'), JSON.stringify(game.analysis!.positions));
writeFileSync(join(out, 'beta-deep.json'), JSON.stringify(deep));

const ctx = buildBetaContext(game, [game], rating)!;
writeFileSync(join(out, 'context.json'), JSON.stringify(ctx.facts, null, 1));
writeFileSync(join(out, 'prompt.txt'), `=== SYSTEM (fixed, server-side) ===\n${BETA_COACH_SYSTEM_PROMPT}\n\n=== USER ===\n${betaPrompt(ctx)}\n`);
console.log(`Wrote ${out}/context.json and ${out}/prompt.txt (${betaPrompt(ctx).length} characters of evidence).`);

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.log('No GEMINI_API_KEY set: stopping before the model call.');
  process.exit(0);
}
const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const provider = new GeminiProvider(key, model);
console.log(`Asking ${model}…`);
const text = await provider.complete({ system: BETA_COACH_SYSTEM_PROMPT, prompt: betaPrompt(ctx), maxTokens: 16000 });
writeFileSync(join(out, 'raw-answer.json'), text);
const review = parseBetaReview(text, ctx, game, model);
writeFileSync(join(out, 'review.json'), JSON.stringify(review, null, 1));
writeFileSync(join(out, 'review.md'), toMarkdown(review, game));
console.log(`Wrote ${out}/review.md (${review.chapters.length} chapters, ${review.removed.length} statements removed by the referee).`);

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
