// A clean win (92% accuracy): the coach should say so, credit the tactics, and keep cost-free notes small.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { fixtureGame } from './helpers';

const { game: g, positions } = fixtureGame('resign-win-game');
const { game } = coachFromPositions(g, positions, []);
const r = game.report!;

describe('a clean win', () => {
  it('leads with the win, not a cost-free development note', () => {
    expect(r.headline).toMatch(/^A strong win/);
    expect(r.hurt).toHaveLength(0);
    expect(r.focus.title).not.toMatch(/Develop a new piece/);
    expect(r.minorNotes.some((n) => /Nb8 and Bc8 were still at home.*didn't cost anything/.test(n.text))).toBe(true);
  });

  it('credits both tactics, including the pin that won the queen for a rook', () => {
    expect(r.didWell[0].text).toMatch(/^8\.\.\.Re8 wins the queen on e5 for a rook/);
    expect(r.didWell.some((d) => /29\.\.\.Qc5\+ wins the rook on e1/.test(d.text))).toBe(true);
  });

  it('never praises the same move twice', () => {
    const plies = r.didWell.flatMap((d) => d.plies ?? []);
    expect(new Set(plies).size).toBe(plies.length);
  });
});
