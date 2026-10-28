// npm run truth:engine — cache the app's own engine pass for every ground-truth game: depth 12 for
// every move, then depth 18 around the critical moments (deepenCritical), exactly as an import does.
// Games that already have a cache are skipped unless --force.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNodeEngine } from '../../server/nodeEngine.ts';
import { analyzeGame } from '../../src/analysis/pipeline.ts';
import { cachedPositions, loadTruth, positionsPath, storedGame } from './data.ts';

const force = process.argv.includes('--force');
const jobs = Number(process.argv.find((a) => a.startsWith('--jobs='))?.slice(7) ?? 4);
const todo = loadTruth().games.filter((g) => force || !cachedPositions(g.game));
console.log(`${todo.length} game(s) to analyse, ${jobs} at a time`);

let next = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, todo.length) }, async () => {
    const engine = createNodeEngine();
    try {
      while (next < todo.length) {
        const g = todo[next++];
        const t = Date.now();
        const { game } = await analyzeGame(storedGame(g), engine, { depth: 12, prior: [] });
        const out = positionsPath(g.game);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(game.analysis!.positions));
        console.log(`  ${g.game}: ${game.plies.length} plies, ${Math.round((Date.now() - t) / 1000)}s`);
      }
    } finally {
      engine.dispose();
    }
  }),
);
