// chunkmonkey420 vs Rajib557 (truth v9, tune): a tactic 8 half-moves deep, material counted once
// trades settle, the passed pawn credited to the move that made it passed.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { cachedPositions, loadTruth, storedGame } from '../scripts/truth/data';

const g = loadTruth().games.find((x) => x.game === 'chunkmonkey420 vs Rajib557')!;
const { game } = coachFromPositions(storedGame(g), cachedPositions(g.game)!, []);
const r = game.report!;
const all = [r.headline, r.story ?? '', r.focus.title, r.focus.detail, ...r.hurt.map((h) => h.text), ...r.didWell.map((d) => d.text), ...r.minorNotes.map((n) => n.text), ...game.moments.flatMap((m) => [m.text.title, m.text.lesson])].join('\n');

describe('Rajib557', () => {
  it('finds 22.Qd2 as a discovered attack (material falls 8 half-moves deep), and that Black missed it', () => {
    const f = game.findings.find((x) => x.ply === 43 && x.kind === 'weakness')!;
    expect(f.facts.pattern).toBe('discovered_attack');
    expect(f.evidence).toMatch(/Nfe4 attacks the queen on d2 and uncovers the bishop on g7/);
    expect(game.moments.find((m) => m.ply === 43)?.text.missed).toBe('Black missed it: 23...Qxc4 instead of 23...Nfe4.');
  });
  it('makes no king-safety claim about 20.f3, and no "king under pressure" while far ahead', () => {
    expect(game.findings.find((x) => x.ply === 39 && x.category === 'king_safety')?.confidence).toBe('low');
    expect(all).not.toMatch(/20\.f3|king came under pressure/);
  });
  it('counts the queen blunder as a piece won once the trades settle', () => {
    expect(game.findings.find((x) => x.category === 'punished_mistake')?.evidence).toBe(
      '24...Nce4 dropped a piece, and you collected it: 25.Nxe4 Nxe4 26.Rxc4 Nxd2 27.Bxd2 — a piece up once the trades settled.',
    );
  });
  it('says 33.Bd5+ came with check', () => {
    expect(game.findings.find((x) => x.category === 'found_tactic' && x.ply === 65)?.evidence).toMatch(/It came with check, so the rook couldn't get away/);
  });
  it('credits the passed pawn to 39.Rxc7, not 42.c7', () => {
    expect(game.findings.find((x) => x.category === 'passed_pawn')?.evidence).toBe('39.Rxc7 made your c-pawn a passed pawn, and you pushed it all the way to promotion (44.c8=Q).');
  });
  it('has a headline that fits the result', () => {
    expect(r.headline).toMatch(/^You won, but not cleanly: you slipped with 22\.Qd2 \(discovered attack\) and got away with it, picked up a piece after 24\.\.\.Nce4, then finished with mate\./);
  });
  it('never leaves an empty slot in a sentence (47.Qxb6)', () => {
    expect(game.findings.find((x) => x.ply === 93)?.evidence ?? '').not.toMatch(/with \./);
  });
});
