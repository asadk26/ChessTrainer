// The user's game where Black stormed White's castled king with pawns.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { fixtureGame, samplePositions, sampleStored } from './helpers';

const { game: g, positions } = fixtureGame('kingside-storm-game');
const { game } = coachFromPositions(g, positions, []);
const at = (ply: number) => game.findings.filter((f) => f.ply === ply).map((f) => f.category);

describe('pawn storm against a castled king', () => {
  it('flags pushing pawns in front of your own king into the storm', () => {
    expect(at(19)).toContain('king_safety'); // 10.h4
    expect(at(29)).toContain('king_safety'); // 15.g3
    expect(game.report!.hurt[0].text).toMatch(/10\.h4 and 15\.g3 pushed pawns in front of your own king/);
  });

  it('gives the castled-king focus, not "castle before move 10"', () => {
    expect(game.report!.focus.theme).toBe('king_safety');
    expect(game.report!.focus.title).toMatch(/Once you've castled/);
    expect(game.report!.focus.title).not.toMatch(/Castle before move 10/);
  });

  it('notices the bishop being chased by pawns (7.Bg5 f6 8.Bh4 g5 9.Bg3)', () => {
    const f = game.findings.find((x) => x.facts.chased);
    expect(f).toMatchObject({ ply: 17, category: 'inefficient_moves' });
    expect(game.explanations![17].problem).toMatch(/pawns chased it \(f6, g5\)/);
    expect(game.explanations![17].better).toMatch(/Nxg5 removes the piece that was attacking your bishop/);
  });

  it('explains the real problem with 13.Bxf4 and 17.Ne6', () => {
    expect(game.explanations![25]).toMatchObject({ kind: 'mistake', problem: expect.stringMatching(/reach your king \(Nxf4 Nxc5 Qxh4\)/) });
    expect(game.explanations![25].better ?? '').not.toMatch(/wins the knight/); // engine doesn't rate Bxd5 as winning a piece
    expect(game.explanations![33]).toMatchObject({ kind: 'mistake', problem: expect.stringMatching(/allows g3/) });
  });

  it('credits the fork that wins the queen, not a forced king move', () => {
    const t = game.findings.find((f) => f.category === 'found_tactic');
    expect(t?.ply).toBe(47); // 24.Ne4+
    expect(t?.evidence).toMatch(/Ne4\+ wins the queen on f2/);
    expect(game.report!.didWell.some((d) => d.text.includes('24.Ne4+'))).toBe(true);
  });

  it("doesn't link a different king-safety habit from history as the same pattern", () => {
    const earlier = coachFromPositions(fixtureGame('winning-game', 'w', Date.UTC(2026, 9, 13)).game, fixtureGame('winning-game').positions, []).game;
    const sample = coachFromPositions(sampleStored('a', Date.UTC(2026, 9, 12)), samplePositions(), []).game;
    const prior = [sample, earlier].map((x, i) => ({ gameId: x.id, label: `vs ${x.opponentName}`, playedAt: Date.UTC(2026, 9, 12 + i), findings: x.findings }));
    const withHistory = coachFromPositions(g, positions, prior).game;
    // The winning game's king issue was "not castled by move 12" — a different habit.
    expect(withHistory.report!.recurring).toMatch(/Pushing pawns in front of your castled king didn't show up/);
    expect(withHistory.report!.recurring).not.toMatch(/Possible tendency: something similar/);
  });
});
