// "Show me": an engine line as steps the student taps through one at a time, each with an arrow
// and a one-line caption of what that move does — from board facts, from the student's side
// ("takes your bishop on f4", "attacks their queen"). Never autoplayed.
import { Chess } from 'chess.js';
import type { Color, PieceType } from '../domain/types';
import { PIECE_NAME, other } from '../chess/board';
import { describeMove } from './movePurpose';
import { lineToPoint } from './linePoint';
import { pinsBy } from './boardFacts';

export interface LineStep {
  /** Position before the move. */
  before: string;
  /** Position after it. */
  fen: string;
  uci: string;
  san: string;
  from: string;
  to: string;
  color: Color;
  caption: string;
}

const piece = (t: PieceType, s: string, whose: 'your' | 'their') => (t === 'p' ? `${whose} pawn on ${s}` : `${whose} ${PIECE_NAME[t]} on ${s}`);

/** One line on what a move does, from `pov`'s side. */
export function stepCaption(fenBefore: string, uci: string, pov: Color, prevTo?: string, pv?: string[]): string {
  const c = new Chess(fenBefore);
  const mover = c.turn() as Color;
  const inCheck = c.inCheck();
  const legal = c.moves().length;
  let mv;
  try {
    mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
  } catch {
    return '';
  }
  const mine = mover === pov;
  const whoseVictim = mine ? 'their' : 'your';
  const parts: string[] = [];
  if (mv.san.includes('#')) parts.push('checkmate');
  if (mv.captured) parts.push(mv.to === prevTo ? `takes back on ${mv.to}` : `takes ${piece(mv.captured as PieceType, mv.to, whoseVictim)}`);
  if (mv.promotion) parts.push(`promotes to a ${PIECE_NAME[mv.promotion as PieceType]}`);
  if (mv.san.includes('+') && !mv.san.includes('#')) parts.push('gives check');
  // What else it does: the strongest board purpose that isn't already said.
  const d = describeMove({ fen: fenBefore, uci, pv: pv ?? [uci] });
  const extra = (d?.purposes ?? [])
    .filter((p) => !['capture', 'check', 'mate', 'win_material'].includes(p.id) || !mv.captured)
    .filter((p) => !(p.id === 'check' || p.id === 'capture'))
    .sort((a, b) => b.weight - a.weight)[0];
  if (extra) parts.push(mine ? extra.text : extra.text.replace(/\byour\b/g, 'their').replace(/\btheir (\w+) on/g, (m) => m));
  const pin = pinsBy(c.fen(), mover).find((p) => !pinsBy(fenBefore, mover).includes(p) && !/pins the pawn/.test(p));
  if (pin && parts.length < 3) parts.push(pin.replace(/^the \w+ on \w\d /, '').replace(/^pins/, 'pins'));
  if (inCheck) parts.unshift(legal === 1 ? 'the only legal move out of check' : 'gets out of check');
  else if (legal === 1) parts.unshift('the only legal move');
  // Nothing to say about it: just the move, rather than filler like "a quiet move".
  if (!parts.length) return `${mv.san}.`;
  return `${mv.san} ${parts.slice(0, 3).join(', ')}.`.replace(/ ,/g, ',');
}

/**
 * The line as steps: cut where its point is visible (a capture settles, mate, promotion), at least
 * 3 and at most `max` moves.
 */
export function lineSteps(fen: string, ucis: string[], pov: Color, max = 5): LineStep[] {
  const point = lineToPoint(fen, ucis, pov, max).frames.length;
  const n = Math.min(max, Math.max(Math.min(3, ucis.length), point));
  const c = new Chess(fen);
  const out: LineStep[] = [];
  for (let i = 0; i < Math.min(n, ucis.length); i++) {
    const before = c.fen();
    const uci = ucis[i];
    let mv;
    try {
      mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
    } catch {
      break;
    }
    out.push({ before, fen: c.fen(), uci, san: mv.san, from: mv.from, to: mv.to, color: mv.color as Color, caption: stepCaption(before, uci, pov, out[i - 1]?.to, ucis.slice(i)) });
  }
  return out;
}

export { other };
