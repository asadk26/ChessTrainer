// How the game ended, when that changes the lesson: a win by resignation from a
// worse position, or resigning a position that was still playable at this level.
import { Chess } from 'chess.js';
import type { PositionEval, StoredGame } from '../domain/types';
import { COLOR_NAME, materialBalance, other, playLine } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { MATE_CP, positionCp } from '../analysis/evaluation';

function howItEnded(termination: string | undefined, who: string): string {
  const t = (termination ?? '').toLowerCase();
  if (t.includes('time')) return `${who} ran out of time`;
  if (t.includes('abandon')) return `${who} abandoned the game`;
  if (t.includes('resign')) return `${who} resigned`;
  return `${who} resigned (or ran out of time)`;
}

export function endingNote(game: StoredGame, positions: PositionEval[]): string | undefined {
  const last = game.plies.at(-1);
  const final = positions[game.plies.length];
  if (!last || !final) return undefined;
  if (new Chess(last.fenAfter).isGameOver()) return undefined; // mate or a draw on the board: nothing to add
  const me = game.userColor;
  const won = (game.headers.result === '1-0' && me === 'w') || (game.headers.result === '0-1' && me === 'b');
  const lost = (game.headers.result === '0-1' && me === 'w') || (game.headers.result === '1-0' && me === 'b');
  const toMove = last.color === 'w' ? 'b' : 'w';
  const cp = toMove === me ? positionCp(final) : -positionCp(final); // the user's view
  const opp = COLOR_NAME[other(me)];

  if (won && last.color === me && cp <= -150) {
    return `You won because ${howItEnded(game.headers.termination, opp)} right after ${moveLabel(last)} — but that move actually left ${opp} better. Enjoy the point, but don't count on that next time.`;
  }
  if (lost && last.color !== me && cp > -900 && Math.abs(cp) < MATE_CP - 1000) {
    const t = (game.headers.termination ?? '').toLowerCase();
    if (t && !t.includes('resign')) return undefined; // lost on time or abandoned: resigning isn't the lesson
    // Count material after the obvious recapture, if the engine's first move is one.
    const reply = playLine(last.fenAfter, final.lines[0]?.pv ?? [], 1)[0];
    const settled = reply?.san.includes('x') ? reply.fen : last.fenAfter;
    const down = -materialBalance(settled, me);
    const what = down >= 3 ? `you were down ${down} points of material` : `the position was bad`;
    const lead = t ? `You resigned after ${moveLabel(last)}: ${what}.` : `If you resigned after ${moveLabel(last)}: ${what}.`;
    return `${lead} That's a lot, but at this level opponents give material back all the time — unless it's a forced mate, playing on is usually worth it.`;
  }
  return undefined;
}
