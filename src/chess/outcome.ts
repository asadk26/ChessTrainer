// The game's result from the player's side. A PGN result is always White–Black
// ("1-0" = White won, "0-1" = Black won), so it means nothing until we know
// which side the player was — and it can be missing ("*") or copied wrong,
// so the player can confirm or correct it.
import type { Color, StoredGame } from '../domain/types';

export type Outcome = 'win' | 'loss' | 'draw';

export const OUTCOME_LABEL: Record<Outcome, string> = { win: 'You won', loss: 'You lost', draw: 'Draw' };

export function outcomeFromResult(result: string | undefined, color: Color): Outcome | undefined {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return color === 'w' ? 'win' : 'loss';
  if (result === '0-1') return color === 'b' ? 'win' : 'loss';
  return undefined;
}

/** The player's confirmed outcome if they set one, otherwise what the PGN says. */
export function userOutcome(g: Pick<StoredGame, 'outcome' | 'headers' | 'userColor'>): Outcome | undefined {
  return g.outcome ?? outcomeFromResult(g.headers.result, g.userColor);
}

/** Back to a PGN-style result string, for code that reasons in White–Black terms. */
export function resultFor(outcome: Outcome | undefined, color: Color, fallback = '*'): string {
  if (!outcome) return fallback;
  if (outcome === 'draw') return '1/2-1/2';
  return (outcome === 'win') === (color === 'w') ? '1-0' : '0-1';
}
