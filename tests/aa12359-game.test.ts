// chunkmonkey420 vs aa12359 (truth v10, tune): a near-clean win; "What hurt you" must name the real slips.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { cachedPositions, loadTruth, storedGame } from '../scripts/truth/data';

const g = loadTruth().games.find((x) => x.game === 'chunkmonkey420 vs aa12359')!;
const { game } = coachFromPositions(storedGame(g), cachedPositions(g.game)!, []);
const r = game.report!;
const hurt = r.hurt.map((h) => h.text);

describe('aa12359', () => {
  it('has no f1-rook item and no 8.Nxd4 trap credit', () => {
    expect(game.findings.some((f) => f.category === 'passive_piece')).toBe(false);
    expect(r.didWell.some((d) => d.text.startsWith('8.Nxd4'))).toBe(false);
  });
  it('explains 20.Bxa7 as a grab while b2 was attacked, not an isolated pawn', () => {
    const f = game.findings.find((x) => x.ply === 39 && x.kind === 'weakness')!;
    expect(f.category).toBe('missed_threat');
    expect(f.evidence).toMatch(/^Your pawn on b2 was already attacked by the rook on b8; 20\.Bxa7 grabbed the pawn on a7 instead, and 20\.\.\.Rxb2 won it back\./);
    expect(hurt.join(' ')).not.toMatch(/isolated/);
    expect(game.moments.find((m) => m.ply === 39)?.text.lesson).toBe('Before grabbing a pawn, check what of yours is already attacked.');
  });
  it('names 10.dxc3 as unexplained, with Stockfish’s choice', () => {
    expect(hurt.some((t) => /^10\.dxc3 cost about [\d.]+ pawns: Stockfish preferred 10\.Qxc3/.test(t))).toBe(true);
  });
  it('keeps the headline consistent with "What hurt you"', () => {
    expect(hurt.length).toBe(2);
    expect(r.headline).not.toMatch(/no serious mistakes/);
    expect(r.headline).toMatch(/a few mistakes are worth reviewing/);
  });
});
