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

  it('teaches the missed mates as checkmates in moments and drills — but, still winning (+5.7) after each, they never lead the summary', () => {
    expect(r.headline).not.toMatch(/missed checkmates/);
    expect(r.headline).toMatch(/giving material and counterplay back/);
    // Same mate (Qg3#) twice: one lesson, not two.
    const mateMoments = game.moments.filter((m) => m.text.title.includes('there was checkmate'));
    expect(mateMoments.map((m) => m.ply)).toEqual([81]);
    const mateDrills = drills.filter((d) => d.solutionSan === 'Qg3#');
    expect(mateDrills.length).toBeGreaterThan(0);
    for (const d of mateDrills) expect(d.prompt).toMatch(/checkmate in one/);
  });

  it('teaches the knight that grabbed the rook on a8 and got stuck there', () => {
    const f = game.findings.find((x) => x.category === 'stranded_piece');
    expect(f).toMatchObject({ ply: 41, severity: 3, confidence: 'high', relatedPlies: [43, 52] });
    expect(f!.evidence).toMatch(/21\.Nc7\+ and 22\.Nxa8 won the rook on a8, but your knight was stuck in the corner with no safe way out \(c7 and b6 were covered\)/);
    expect(f!.evidence).toMatch(/26\.\.\.Qxa8.*gained only a pawn/);
    expect(r.hurt.some((h) => h.text === f!.evidence)).toBe(true);
    const m = game.moments.find((x) => x.ply === 41)!;
    expect(m.text.title).toMatch(/free material, but no way back/);
    expect(m.explanation?.problem).toMatch(/knight is stuck in the corner with no way back/);
    expect(drills.some((d) => d.ply === 41)).toBe(true);
  });

  it('explains 29.g4 as a loose pawn, not as pawn structure', () => {
    expect(at(57).map((f) => f.category)).toEqual(['blunder']);
    expect(at(57)[0].confidence).toBe('medium');
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
