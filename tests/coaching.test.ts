import { describe, expect, it } from 'vitest';
import { coachFromPositions } from '../src/analysis/pipeline';
import type { PositionEval } from '../src/domain/types';
import { samplePositions, sampleStored, storedFromPgn } from './helpers';

const coachSample = (prior = [] as Parameters<typeof coachFromPositions>[2]) => coachFromPositions(sampleStored(), samplePositions(), prior);

describe('sample game coaching (from recorded Stockfish output)', () => {
  const { game, drills } = coachSample();
  const at = (ply: number) => game.findings.filter((f) => f.ply === ply).map((f) => f.category);

  it('credits decent opening fundamentals', () => {
    const strengths = game.findings.filter((f) => f.kind === 'strength').map((f) => f.category);
    expect(strengths).toEqual(expect.arrayContaining(['castled_early', 'developed_pieces', 'center_control', 'no_hanging']));
    expect(game.report!.didWell[0].text).toMatch(/opening fundamentals/i);
  });

  it('flags 11.Nb5 -> 12.Nc3 as moving a developed piece twice without payoff', () => {
    expect(at(21)).toEqual(expect.arrayContaining(['inefficient_moves', 'premature_attack']));
    const f = game.findings.find((x) => x.ply === 21 && x.category === 'inefficient_moves')!;
    expect(f.relatedPlies).toEqual([23]);
    expect(f.facts.returned).toBe(true);
  });

  it('links 13.Bb5+ -> 14.Be2 to the same tendency (a forcing move without a follow-up)', () => {
    expect(at(25)).toEqual(expect.arrayContaining(['pointless_check', 'inefficient_moves']));
  });

  it('treats 8.dxe5 as a soft note about central tension, not a major mistake', () => {
    const f = game.findings.find((x) => x.ply === 15)!;
    expect(f.category).toBe('central_tension');
    expect(f.severity).toBe(1);
    expect(game.moments.some((m) => m.ply === 15)).toBe(false);
    expect(game.report!.hurt.some((h) => h.plies?.includes(15))).toBe(false);
    expect(game.report!.minorNotes.some((n) => n.plies?.includes(15))).toBe(true);
  });

  it('recognises 15.f4 as a good idea against the uncastled king', () => {
    expect(at(29)).toContain('opened_vs_king');
    const good = game.moments.find((m) => m.kind === 'good_idea');
    expect(good?.ply).toBe(29);
    expect(game.report!.didWell.some((d) => d.text.includes('15.f4'))).toBe(true);
  });

  it('picks teaching moments from patterns, not just evaluation loss', () => {
    const plies = game.moments.filter((m) => m.kind === 'mistake').map((m) => m.ply);
    // 11.Nb5 itself barely changes the evaluation, yet it is a teaching moment.
    expect(game.analysis!.moves[20].winDrop).toBeLessThan(5);
    expect(plies).toEqual(expect.arrayContaining([21, 25]));
    // No moment for moves with tiny engine differences only.
    for (const m of game.moments) expect(m.ply).not.toBe(19);
  });

  it('builds an interactive Nb5 moment: predict the reply, then find something better', () => {
    const m = game.moments.find((x) => x.ply === 21)!;
    expect(m.steps).toEqual(['intro', 'predict', 'reveal', 'find_better', 'lesson']);
    expect(m.acceptableReplyUcis).toContain('a7b7'); // ...Rb7, what Black actually played
    expect(m.sequence.map((f) => f.san)).toEqual(['Nb5', 'Rb7', 'Nc3']);
    expect(m.betterPly).toBe(23); // the retreat was the costly part
    expect(m.acceptableUcis.length).toBeGreaterThan(0);
    expect(m.text.question).toMatch(/simplest response/);
  });

  it('chooses one behavioural focus about checking the opponent\'s reply', () => {
    expect(game.report!.focus.theme).toBe('active_without_followup');
    expect(game.report!.focus.title).toMatch(/opponent's most obvious reply/);
    expect(game.report!.headline).toMatch(/opening fundamentals were mostly solid/);
    expect(game.report!.didWell.length).toBeLessThanOrEqual(3);
    expect(game.report!.hurt.length).toBeLessThanOrEqual(3);
  });

  it('does not claim a pattern from a single game', () => {
    expect(game.report!.recurring).toMatch(/first analyzed game/);
    expect(game.report!.recurring).not.toMatch(/appeared in \d+ of/);
  });

  it('generates 2-3 varied drills', () => {
    expect(drills.length).toBeGreaterThanOrEqual(2);
    expect(drills.length).toBeLessThanOrEqual(3);
    expect(new Set(drills.map((d) => d.type)).size).toBe(drills.length);
    const predict = drills.find((d) => d.type === 'predict_response');
    expect(predict?.acceptableUcis).toContain('a7b7');
  });
});

describe('recurring-pattern language across games', () => {
  const first = coachFromPositions(sampleStored('a'), samplePositions(), []).game;
  const asPrior = (id: string, day: number) => ({ gameId: id, label: `vs someone (${day})`, playedAt: Date.UTC(2026, 9, day), findings: first.findings });

  it('calls a second occurrence a possible tendency', () => {
    const { game } = coachFromPositions(sampleStored('b'), samplePositions(), [asPrior('a', 1)]);
    expect(game.report!.recurring).toMatch(/Possible tendency/);
  });

  it('reports counts once the pattern repeats across several games', () => {
    const { game } = coachFromPositions(sampleStored('c'), samplePositions(), [asPrior('a', 1), asPrior('b', 2)]);
    expect(game.report!.recurring).toMatch(/appeared in 3 of your last 3 games/);
    // Recurring categories make moments more significant.
    const fresh = coachSample().game.moments.find((m) => m.ply === 21)!;
    expect(game.moments.find((m) => m.ply === 21)!.significance).toBeGreaterThan(fresh.significance);
  });
});

describe('quiet games', () => {
  it('produces no teaching moments when the engine sees nothing significant', () => {
    const g = storedFromPgn('[White "me"]\n[Black "you"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 d6 6. c3 O-O 7. Nbd2 a6 8. Bb3 Ba7 9. h3 h6 10. Re1 Re8 *', 'w');
    const positions: PositionEval[] = [g.plies[0].fenBefore, ...g.plies.map((p) => p.fenAfter)].map((fen, i) => ({
      fen,
      depth: 10,
      lines: [{ pv: g.plies[i] ? [g.plies[i].uci] : [], score: { type: 'cp', value: 20 }, depth: 10 }],
    }));
    const { game } = coachFromPositions(g, positions, []);
    expect(game.moments).toHaveLength(0);
    expect(game.report!.hurt).toHaveLength(0);
    expect(game.report!.headline).toMatch(/no serious mistakes/i);
  });
});
