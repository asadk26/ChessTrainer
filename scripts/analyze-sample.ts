// CLI: run the full pipeline in Node (real Stockfish) and print the coaching.
//   npm run analyze-sample                 -> built-in sample game as White
//   npm run analyze-sample -- game.pgn b   -> your PGN, playing Black
import { readFileSync } from 'node:fs';
import { createNodeEngine } from '../server/nodeEngine.ts';
import { analyzeGame } from '../src/analysis/pipeline.ts';
import { parsePgn } from '../src/chess/pgn.ts';
import { SAMPLE_PGN } from '../src/fixtures/sampleGame.ts';
import type { StoredGame } from '../src/domain/types.ts';

const [file, color = 'w'] = process.argv.slice(2);
const parsed = parsePgn(file ? readFileSync(file, 'utf8') : SAMPLE_PGN);
const userColor = color === 'b' ? 'b' : 'w';
const game: StoredGame = {
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

const engine = createNodeEngine();
const { game: out, drills } = await analyzeGame(game, engine, {
  depth: 12,
  prior: [],
  onProgress: (d, t) => process.stderr.write(`\ranalyzing ${d}/${t}`),
});
engine.dispose();
process.stderr.write('\n');

const r = out.report!;
console.log(`\n${r.headline}\n`);
console.log('What you did well:');
r.didWell.forEach((i) => console.log(`  • ${i.text}`));
console.log('What hurt you:');
r.hurt.forEach((i) => console.log(`  • ${i.text}`));
console.log(`Recurring pattern:\n  ${r.recurring}`);
console.log(`Focus for next game:\n  ${r.focus.title}`);
if (r.minorNotes.length) r.minorNotes.forEach((i) => console.log(`  (note) ${i.text}`));
console.log('\nTeaching moments:');
out.moments.forEach((m) => console.log(`  - ${m.text.title}  [${m.steps.join(' → ')}]`));
console.log('\nDrills:');
drills.forEach((d) => console.log(`  - ${d.type}: ${d.prompt}`));
console.log('\nFindings:');
out.findings.forEach((f) => console.log(`  ${f.kind === 'strength' ? '+' : '-'} [${f.category}] ${f.evidence}`));
