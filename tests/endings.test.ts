// Two short games as Black: a win by resignation right after a blunder, and a resignation after losing the queen.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { fixtureGame } from './helpers';

const coach = (name: 'black-win-game' | 'queen-blunder-game') => {
  const { game, positions } = fixtureGame(name);
  return coachFromPositions(game, positions, []).game;
};

describe('how the game ended', () => {
  const win = coach('black-win-game');
  const loss = coach('queen-blunder-game');

  it('says when you won by resignation from a worse position', () => {
    expect(win.report!.story).toMatch(/^You won because White resigned \(or ran out of time\) right after 15\.\.\.Bxf2\+ — but that move actually left White better/);
    expect(win.findings.find((f) => f.ply === 30)).toMatchObject({ category: 'blunder', confidence: 'high' });
  });

  it("doesn't call an even knight trade free material (10...Nxc3 11.bxc3)", () => {
    expect(win.findings.some((f) => f.category === 'won_free_material')).toBe(false);
  });

  it('suggests playing on after resigning a lost-but-not-mated position', () => {
    expect(loss.report!.story).toMatch(/If you resigned after 12\.Nxd7: you were down 6 points of material\. .*playing on is usually worth it/);
    expect(loss.findings.find((f) => f.ply === 22)).toMatchObject({ category: 'blunder', evidence: expect.stringMatching(/queen on d7 where it could be taken \(Nxd7\)/) });
  });

  it('blames the retreat, not the developing move, when a bishop gets chased', () => {
    const f = loss.findings.find((x) => x.facts.chased)!;
    expect(f.ply).toBe(14); // 7...Ba5, not 6...Bb4
    expect(f.evidence).toMatch(/On 7\.\.\.Ba5, Bxc3\+ — trading the bishop off — was better than retreating again/);
  });

  it('adds nothing when the game ended on the board', () => {
    const { game, positions } = fixtureGame('winning-game');
    expect(coachFromPositions(game, positions, []).game.report!.story).not.toMatch(/resigned/);
  });
});
