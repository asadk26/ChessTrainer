// How the game ended, when that changes the lesson: a win by resignation from a
// worse position, or resigning a position that was still playable at this level.
import { Chess } from 'chess.js';
import type { PositionEval, StoredGame } from '../domain/types';
import { COLOR_NAME, materialBalance, materialPhrase, other, playLine } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { userOutcome } from '../chess/outcome';
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
  const outcome = userOutcome(game);
  const won = outcome === 'win';
  const lost = outcome === 'loss';
  const toMove = last.color === 'w' ? 'b' : 'w';
  const cp = toMove === me ? positionCp(final) : -positionCp(final); // the user's view
  const opp = COLOR_NAME[other(me)];

  if (won && last.color === me && cp <= -150) {
    return `You won because ${howItEnded(game.headers.termination, opp)} right after ${moveLabel(last)} — but that move actually left ${opp} better. Enjoy the point, but don't count on that next time.`;
  }
  // A win the opponent gave up on while you were clearly winning: say so, it was deserved.
  if (won && cp >= 150 && !/checkmate|time vs|insufficient/i.test(game.headers.termination ?? '')) {
    const up = materialBalance(last.fenAfter, me);
    const how = howItEnded(game.headers.termination, opp);
    return `${how.charAt(0).toUpperCase()}${how.slice(1)} after ${moveLabel(last)}, with you ${up >= 1 ? `up ${materialPhrase(up)}` : 'clearly better'} — a deserved win.`;
  }
  if (lost) {
    const t = (game.headers.termination ?? '').toLowerCase();
    if (t && !t.includes('resign')) return undefined; // lost on time or abandoned: resigning isn't the lesson
    const ifResigned = t ? 'You resigned' : 'If you resigned';
    // Were you better just before your own last move? Then that one move turned the game.
    const beforeCp = last.color === me && positions[game.plies.length - 1] ? positionCp(positions[game.plies.length - 1]) : undefined;
    const turned = beforeCp !== undefined && beforeCp >= 150 ? ` Just before ${moveLabel(last)} you were clearly better — that one move turned the game around.` : '';
    if (cp >= -150) {
      return `${ifResigned} after ${moveLabel(last)}, that was too early: the position wasn't lost (${cp >= 150 ? 'you were actually better' : 'it was roughly equal'}).`;
    }
    if (cp > -900 && Math.abs(cp) < MATE_CP - 1000) {
      // Count material after the obvious recapture, if the engine's first move is one.
      const reply = playLine(last.fenAfter, final.lines[0]?.pv ?? [], 1)[0];
      const settled = reply?.san.includes('x') ? reply.fen : last.fenAfter;
      const down = -materialBalance(settled, me);
      const what = down >= 3 ? `you were down ${down} points of material` : 'you were clearly worse';
      return `${ifResigned} after ${moveLabel(last)}: ${what}.${turned} ${down >= 3 ? "That's a lot, but at" : 'Worse is not lost: at'} this level opponents give material back all the time — unless it's a forced mate, playing on is usually worth it.`;
    }
    return turned ? turned.trim() : undefined;
  }
  return undefined;
}
