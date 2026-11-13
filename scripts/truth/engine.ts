// npm run truth:engine — cache the app's own engine pass for every ground-truth game: depth 12 for
// every move, then depth 18 around the critical moments (deepenCritical), exactly as an import does.
// Games that already have a cache are skipped unless --force.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNodeEngine } from '../../server/nodeEngine.ts';
import { addLuftChecks, analyzeGame, coachFromPositions } from '../../src/analysis/pipeline.ts';
import { cachedPositions, loadTruth, positionsPath, storedGame } from './data.ts';

const force = process.argv.includes('--force');
const jobs = Number(process.argv.find((a) => a.startsWith('--jobs='))?.slice(7) ?? 4);
const todo = loadTruth().games.filter((g) => force || !cachedPositions(g.game));
console.log(`${todo.length} game(s) to analyse, ${jobs} at a time`);

// A fresh engine per game: a reused one carries its hash table over from whichever game it analysed
// before, so results would depend on scheduling order (and change from run to run).
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, todo.length) }, async () => {
    while (next < todo.length) {
      const g = todo[next++];
      const t = Date.now();
      const engine = createNodeEngine();
      try {
        const { game } = await analyzeGame(storedGame(g), engine, { depth: 12, prior: [] });
        const out = positionsPath(g.game);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(game.analysis!.positions));
        console.log(`  ${g.game}: ${game.plies.length} plies, ${Math.round((Date.now() - t) / 1000)}s`);
      } finally {
        engine.dispose();
      }
    }
  }),
);

// The luft counterfactual for caches made before it existed: games whose coaching teaches a
// back-rank attack get the luft eval added (a fresh engine per game, so the result is repeatable).
let luft = 0;
for (const g of loadTruth().games) {
  const positions = cachedPositions(g.game);
  if (!positions) continue;
  const coached = coachFromPositions(storedGame(g), positions, []).game;
  if (!Object.values(coached.patterns ?? {}).some((h) => h.tag === 'back_rank' && h.side === 'refutation')) continue;
  const engine = createNodeEngine();
  try {
    if (await addLuftChecks(coached, positions, engine)) {
      writeFileSync(positionsPath(g.game), JSON.stringify(positions));
      luft++;
      console.log(`  ${g.game}: luft check added`);
    }
  } finally {
    engine.dispose();
  }
}
console.log(`${luft} game(s) got a luft check`);
