import type { Color, GameHeaders } from '../domain/types';

export const normalizeName = (n: string) => n.trim().toLowerCase();

export interface Identification {
  color: Color;
  name: string;
  /** True when we matched a username seen in earlier imports. */
  confident: boolean;
}

/**
 * Work out which side "me" is, using usernames from previously imported games.
 * Returns null when there is no evidence, so the UI can ask.
 */
export function identifyUser(headers: GameHeaders, known: Record<string, number>): Identification | null {
  const w = known[normalizeName(headers.white)] ?? 0;
  const b = known[normalizeName(headers.black)] ?? 0;
  if (w === 0 && b === 0) return null;
  if (w >= b) return { color: 'w', name: headers.white, confident: b === 0 };
  return { color: 'b', name: headers.black, confident: w === 0 };
}

export function rememberUsername(known: Record<string, number>, name: string): Record<string, number> {
  const key = normalizeName(name);
  return { ...known, [key]: (known[key] ?? 0) + 1 };
}
