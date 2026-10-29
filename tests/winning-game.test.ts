import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coachFromPositions } from '../src/analysis/pipeline';
import { fixtureGame, samplePositions, sampleStored } from './helpers';

describe('coaching a game where you are far ahead', () => {
  const { game: g, positions } = fixtureGame('winning-game');
  const { game, drills } = coachFromPositions(g, positions, []);
  const find = (ply: number, cat: string) => game.findings.find((f) => f.ply === ply && f.category === cat);

  it('flags practical mistakes that win% alone would hide', () => {
    expect(find(23, 'hunting_material')?.confidence).toBe('high'); // 12.Qxa7, development unfinished
    expect(find(43, 'gave_back_material')?.severity).toBeGreaterThanOrEqual(2); // 22.Bd4 drops the bishop
    const ba7 = find(45, 'allowed_counterplay'); // 23.Ba7 allows a perpetual
    expect(ba7?.confidence).toBe('high');
    expect(ba7?.facts.drawish).toBe(true);
    expect(find(81, 'endgame')?.facts.passedPawn).toBe('a4'); // 41.Be1 ignores the a-pawn
  });

  it("doesn't coach development when you were already a rook up and won", () => {
    expect(find(19, 'development')).toBeUndefined();
  });

  it('credits strong practical decisions', () => {
    const strengths = game.findings.filter((f) => f.kind === 'strength').map((f) => f.category);
    expect(strengths).toEqual(expect.arrayContaining(['won_free_material', 'passed_pawn', 'neutralized_counterplay']));
    expect(find(17, 'won_free_material')).toBeTruthy(); // 9.Qxa8, not the 8.gxf3 recapture
    expect(game.report!.didWell.map((d) => d.category)).toEqual(['won_free_material', 'passed_pawn', 'neutralized_counterplay']);
  });

  it('keeps speculative tempo patterns out of the main summary', () => {
    const trip = find(43, 'inefficient_moves');
    expect(trip?.confidence).toBe('low'); // a bishop round trip while a rook up is not the lesson
    expect(game.report!.hurt.some((h) => h.category === 'inefficient_moves' || h.category === 'premature_attack')).toBe(false);
    expect(game.moments.every((m) => m.category !== 'inefficient_moves')).toBe(true);
  });

  it('makes conversion the focus and tells the story of the game', () => {
    expect(game.report!.focus.theme).toBe('conversion');
    expect(game.report!.headline).toMatch(/winning position/);
    expect(game.report!.story).toMatch(/(materially ahead|up a rook.*) from move 9/);
    expect(game.report!.story).toMatch(/race between passed pawns/);
    expect(game.moments.map((m) => m.ply)).toEqual(expect.arrayContaining([45]));
  });

  it('turns 23.Ba7 into a "predict the dangerous reply" moment and drill', () => {
    const m = game.moments.find((x) => x.ply === 45)!;
    expect(m.steps).toContain('predict');
    expect(m.acceptableReplyUcis[0]).toBe('f3g4'); // ...Qg4+
    const d = drills.find((x) => x.ply === 45)!;
    expect(d.type).toBe('predict_response');
    expect(d.prompt).toMatch(/strongest reply/);
    expect(d.explanation.length).toBeGreaterThan(20);
  });
});

describe('conclusions are robust to engine variance', () => {
  // Same game analysed by Stockfish in the browser (slightly different numbers than Node).
  const { game: g } = fixtureGame('winning-game');
  const browserPositions = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'winning-game-positions-browser.json'), 'utf8'));
  const { game } = coachFromPositions(g, browserPositions, []);
  const cats = (ply: number) => game.findings.filter((f) => f.ply === ply && f.severity >= 2 && f.confidence !== 'low').map((f) => f.category);

  it('reaches the same main conclusions', () => {
    expect(cats(23)).toContain('hunting_material');
    expect(cats(43)).toContain('gave_back_material');
    expect(cats(45)).toContain('allowed_counterplay');
    expect(game.report!.focus.theme).toBe('conversion');
    // 12.Qxa7 and 22.Bd4 left you clearly winning (above +3): only 23.Ba7, which let the win slip, leads.
    expect(game.report!.hurt[0].text).toMatch(/23\.Ba7/);
    expect(game.report!.hurt[0].text).not.toMatch(/12\.Qxa7/);
  });
});

describe('recurring patterns are not forced onto new games', () => {
  const first = coachFromPositions(sampleStored('a'), samplePositions(), []).game;
  const prior = [1, 2].map((d) => ({ gameId: `p${d}`, label: `vs x (${d})`, playedAt: Date.UTC(2026, 9, d), findings: first.findings }));

  it('does not claim "active moves without follow-up" recurs when this game only has weak evidence for it', () => {
    const { game: g, positions } = fixtureGame('winning-game');
    const { game } = coachFromPositions(g, positions, prior);
    expect(game.report!.recurring).not.toMatch(/appeared in \d of your last/);
    expect(game.report!.recurring).toMatch(/didn't clearly show up this time/);
    expect(game.report!.focus.theme).toBe('conversion');
  });

  it('does report the recurrence when the new game has strong evidence', () => {
    const { game: g, positions } = fixtureGame('knight-trip-game');
    const { game } = coachFromPositions(g, positions, prior);
    expect(game.report!.recurring).toMatch(/appeared in 3 of your last 3 games/);
    expect(game.report!.recurring).not.toMatch(/again you /);
  });

  it('ignores low-confidence findings in history', () => {
    const lowOnly = first.findings.map((f) => (f.kind === 'weakness' ? { ...f, confidence: 'low' as const } : f));
    const { game: g, positions } = fixtureGame('knight-trip-game');
    const { game } = coachFromPositions(g, positions, [{ gameId: 'x', label: 'vs x', playedAt: 1, findings: lowOnly }]);
    expect(game.report!.recurring).not.toMatch(/Possible tendency: something similar/);
  });
});
