import { describe, expect, it } from 'vitest';
import { outcomeFromResult, resultFor, userOutcome } from '../src/chess/outcome';
import { coachFromPositions } from '../src/analysis/pipeline';
import { fixtureGame } from './helpers';

describe('game outcome from the player side', () => {
  it('reads PGN results as White–Black, whichever side you played', () => {
    expect(outcomeFromResult('1-0', 'w')).toBe('win');
    expect(outcomeFromResult('1-0', 'b')).toBe('loss');
    expect(outcomeFromResult('0-1', 'b')).toBe('win');
    expect(outcomeFromResult('1/2-1/2', 'b')).toBe('draw');
    expect(outcomeFromResult('*', 'w')).toBeUndefined();
    expect(resultFor('win', 'b')).toBe('0-1');
    expect(resultFor(undefined, 'w', '*')).toBe('*');
  });

  it("uses the player's correction over the PGN", () => {
    const { game } = fixtureGame('black-win-game'); // PGN says 0-1 (Black, the player, won)
    expect(userOutcome(game)).toBe('win');
    expect(userOutcome({ ...game, outcome: 'loss' })).toBe('loss');
  });

  it('coaches the corrected result: resigning right after the blunder', () => {
    const { game, positions } = fixtureGame('black-win-game');
    const story = coachFromPositions({ ...game, outcome: 'loss' }, positions, []).game.report!.story!;
    expect(story).not.toMatch(/You won/);
    expect(story).toMatch(/If you resigned after 15\.\.\.Bxf2\+: you were clearly worse\. Just before 15\.\.\.Bxf2\+ you were clearly better — that one move turned the game around\./);
  });

  it('says nothing about the ending when the result is unknown', () => {
    const { game, positions } = fixtureGame('black-win-game');
    const g = { ...game, headers: { ...game.headers, result: '*' } };
    expect(coachFromPositions(g, positions, []).game.report!.story ?? '').not.toMatch(/resigned|You won/);
  });
});
