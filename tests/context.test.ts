import { describe, expect, it } from 'vitest';
import { closeToBest, practicalDrop } from '../src/analysis/evaluation';
import { buildMoveEvals } from '../src/analysis/analyzeGame';
import { buildContexts, isPromotionRace, summarizePhases, underKingPressure } from '../src/analysis/context';
import { materialPhrase, passedPawns } from '../src/chess/board';
import { fixtureGame } from './helpers';

describe('practical drop (not just win%)', () => {
  it('uses win% in balanced positions', () => {
    expect(practicalDrop({ cpBefore: 40, cpAfter: -30, winDrop: 6.4, materialBefore: 0, materialAfterReply: 0 })).toBe(6.4);
  });

  it('treats +8 -> +5 as a real mistake even though win% barely moves', () => {
    const d = practicalDrop({ cpBefore: 800, cpAfter: 500, winDrop: 3.1, materialBefore: 6, materialAfterReply: 3 });
    expect(d).toBeGreaterThanOrEqual(12);
  });

  it('ignores missing a faster win when the position stays crushing and no material is lost', () => {
    expect(practicalDrop({ cpBefore: 9960, cpAfter: 668, winDrop: 7.8, materialBefore: 9, materialAfterReply: 10 })).toBe(7.8);
  });

  it('judges tried moves by centipawns when far ahead', () => {
    expect(closeToBest({ win: 97, cp: 450 }, { win: 99, cp: 800 })).toBe(false);
    expect(closeToBest({ win: 98, cp: 720 }, { win: 99, cp: 800 })).toBe(true);
    expect(closeToBest({ win: 55, cp: 40 }, { win: 58, cp: 60 })).toBe(true);
  });
});

describe('position context', () => {
  const { game, positions } = fixtureGame('winning-game');
  const evals = buildMoveEvals(game.plies, positions);
  const ctx = buildContexts(game.plies, evals, 'w');

  it('marks being materially far ahead, using settled material (not mid-exchange swings)', () => {
    expect(ctx.get(23)).toMatchObject({ ahead: true, farAhead: true }); // 12.Qxa7, up a rook
    expect(ctx.get(1)).toMatchObject({ ahead: false, behind: false });
    expect(ctx.get(73)!.behind).toBe(false); // 37.Bxe3 just recaptures the queen
  });

  it('detects king pressure, the endgame and the promotion race', () => {
    expect(ctx.get(55)!.kingPressure).toBe(true); // 28.Kf1 after ...Rg4+
    expect(ctx.get(19)!.kingPressure).toBe(false);
    expect(ctx.get(77)!.endgame).toBe(true);
    expect(ctx.get(85)!.race).toBe(true); // 43.a6
    expect(underKingPressure(game.plies[0].fenBefore, 'w')).toBe(false);
  });

  it('summarises the shape of the game', () => {
    const phases = summarizePhases(ctx);
    expect(phases.aheadShare).toBeGreaterThan(0.5);
    expect(phases.kingPressurePlies[0]).toBe(55);
    expect(phases.raceFrom).toBe(85);
  });

  it('has helpers for passed pawns and material language', () => {
    expect(passedPawns(game.plies[84].fenAfter, 'w')).toContain('a6');
    expect(isPromotionRace(game.plies[84].fenAfter)).toBe(true);
    expect(materialPhrase(6)).toBe('a rook and a pawn');
    expect(materialPhrase(3)).toBe('a piece');
  });
});
