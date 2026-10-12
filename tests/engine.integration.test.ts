// Runs the real Stockfish WASM build in Node over the sample game.
import { describe, expect, it } from 'vitest';
import { createNodeEngine, findStockfishScript } from '../server/nodeEngine';
import { analyzeGame } from '../src/analysis/pipeline';
import { sampleStored } from './helpers';

describe.skipIf(!findStockfishScript())('Stockfish integration', () => {
  it('analyzes the sample game end-to-end and reaches the expected coaching conclusions', async () => {
    const engine = createNodeEngine();
    try {
      const { game, drills } = await analyzeGame(sampleStored(), engine, { depth: 10, prior: [] });
      expect(game.analysis!.positions).toHaveLength(34);
      const cats = game.findings.map((f) => `${f.ply}:${f.category}`);
      expect(cats).toEqual(expect.arrayContaining(['21:inefficient_moves', '25:pointless_check', '29:opened_vs_king', '15:central_tension']));
      expect(game.report!.focus.theme).toBe('active_without_followup');
      expect(drills.length).toBeGreaterThanOrEqual(2);
    } finally {
      engine.dispose();
    }
  });
});
