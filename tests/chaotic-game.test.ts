// The user's see-saw game as White: missed mates, a near-perpetual, and some false notes to avoid.
import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import { fixtureGame } from './helpers';

const { game: g, positions } = fixtureGame('chaotic-game');
const { game, drills } = coachFromPositions(g, positions, []);
const r = game.report!;
const at = (ply: number) => game.findings.filter((f) => f.ply === ply);

describe('a chaotic game that swung back and forth', () => {
  it('calls out the perpetual check that 42.Kf1 allowed from a winning position', () => {
    expect(at(83)[0]).toMatchObject({ category: 'allowed_counterplay', severity: 3, confidence: 'high', facts: { perpetual: true } });
    expect(game.explanations![83].problem).toMatch(/force a draw by checking your king again and again \(Qd3\+ Kg2/);
    expect(r.hurt.some((h) => /42\.Kf1 let Black force a draw by perpetual check/.test(h.text))).toBe(true);
    expect(game.moments.find((m) => m.ply === 83)?.text.title).toMatch(/winning game turned into a draw/);
  });

  it('names the missed mates as checkmates, in the summary, moments and drills', () => {
    expect(r.headline).toMatch(/missed checkmates/);
    expect(r.hurt[0].text).toMatch(/You missed a checkmate twice: move 41 \(Qg3# instead of Rxh6\) and move 46 \(Qg3# instead of Qxc8\)/);
    for (const ply of [81, 91]) expect(game.moments.find((m) => m.ply === ply)?.text.title).toMatch(/there was checkmate/);
    const mateDrills = drills.filter((d) => d.solutionSan === 'Qg3#');
    expect(mateDrills.length).toBeGreaterThan(0);
    for (const d of mateDrills) expect(d.prompt).toMatch(/checkmate in one/);
  });

  it('explains 29.g4 as a loose pawn, not as pawn structure', () => {
    expect(at(57).map((f) => f.category)).toEqual(['blunder']);
    expect(at(57)[0].evidence).toMatch(/fxg4/);
    expect(game.findings.some((f) => f.category === 'pawn_structure')).toBe(false); // c2 was already isolated; Kf1 isn't a pawn move
  });

  it("doesn't credit a rook that was traded off at once or a winning move as 'defence'", () => {
    expect(game.findings.some((f) => f.category === 'rook_open_file')).toBe(false); // 44.Rxg4+ fxg4
    const def = game.findings.find((f) => f.category === 'defensive_resource');
    expect(def?.evidence ?? '').not.toMatch(/Qxg7/);
  });

  it('tells the story of the swings', () => {
    expect(r.story).toMatch(/swung back and forth: you were worse around move 20, winning by move 26, worse by move 30 and winning by move 40/);
  });
});
