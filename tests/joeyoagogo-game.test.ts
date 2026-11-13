// JoeYoaGoGo vs chunkmonkey420 (truth v8, tune): the summary of a win with a blunder that went unpunished.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { PATTERN_RULE } from '../src/analysis/patterns';
import { cachedPositions, loadTruth, storedGame } from '../scripts/truth/data';

const g = loadTruth().games.find((x) => x.game === 'JoeYoaGoGo vs chunkmonkey420')!;
const { game } = coachFromPositions(storedGame(g), cachedPositions(g.game)!, []);
const r = game.report!;
const all = [r.headline, r.story ?? '', r.focus.title, r.focus.detail, ...r.hurt.map((h) => h.text), ...r.didWell.map((d) => d.text), ...r.minorNotes.map((n) => n.text)].join('\n');

describe('JoeYoaGoGo: 26...Red8 and the back-rank mate that was yours', () => {
  it('teaches 26...Red8 as a counter-threat captured with check, never a back-rank lesson', () => {
    expect(game.patterns?.[52]?.tag).toBe('capture_with_check');
    const m = game.moments.find((x) => x.ply === 52)!;
    expect(m.text.lesson).toBe(PATTERN_RULE.capture_with_check);
    expect(all).not.toMatch(/luft|escape square|back-rank attack|allowed (a )?(check)?mate/i);
  });
  it('says White missed it, in the moment and the story', () => {
    const m = game.moments.find((x) => x.ply === 52)!;
    expect(m.text.missed).toBe('White missed it: 27.Qe4 instead of 27.Qxd8+.');
    expect(m.text.reveal).toMatch(/In the game, White missed it: 27\.Qe4 instead of 27\.Qxd8\+\.$/);
    expect(r.story).toMatch(/26\.\.\.Red8 should have cost you dearly, but White missed it — 27\.Qe4 instead of 27\.Qxd8\+/);
  });
  it('calls 28...Rd1 a mate threat, not winning a rook', () => {
    const f = game.findings.find((x) => x.category === 'found_tactic' && x.ply === 56)!;
    expect(f.evidence).toBe("28...Rd1 threatened mate on the back rank (Rxf1#). 29.Qxc6 didn't stop it, and 29...Rxf1# was checkmate — a real tactic, and you found it.");
  });
  it("doesn't praise 24...d4 as a passed pawn (25.Qxd4 took it at once)", () => {
    expect(game.findings.some((x) => x.category === 'passed_pawn')).toBe(false);
  });
  it('credits the pawn won from 18.Nc5', () => {
    expect(game.findings.find((x) => x.category === 'punished_mistake')?.evidence).toBe('18.Nc5 dropped a pawn, and you collected it: 18...Nxc5 19.dxc5 Bxc5.');
  });
  it('notes 23...Qa2 let the edge slip — honestly: you stayed a pawn up', () => {
    expect(r.minorNotes.map((n) => n.text)).toEqual(['23...Qa2 let your edge slip (+1.1 → 0.0): you stayed a pawn up, but after 24.Rf2 d4 25.Qxd4 Qxa3 the position was level. Qb5 kept it.']);
  });
  it('has a headline that fits the result', () => {
    expect(r.headline).toMatch(/^You won, but not cleanly: you went a pawn up, let the edge slip, blundered with 26\.\.\.Red8 \(counter-threat captured with check\) and got away with it, then finished with mate\./);
  });
});
