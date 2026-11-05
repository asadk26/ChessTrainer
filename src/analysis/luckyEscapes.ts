// "Lucky escapes": an inaccuracy of yours that allowed a clear, named tactic your opponent didn't
// play. Not a lesson: a light note on the move and a short list in the summary. They are kept apart
// from findings, so they never become the headline, the focus or a recurring-pattern claim.
import type { Color, MoveEval, PlyRecord, PositionEval, StoredGame } from '../domain/types';
import { COLOR_NAME, PIECE_NAME, materialAfterLine, materialBalance, other, pieceAt, playLine } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { verdictOf } from './engineReview';
import { MATE_CP, scoreToCp } from './evaluation';
import { detectPattern, type PatternTag } from './patterns';

export type LuckyEscape = NonNullable<StoredGame['luckyEscapes']>[number];

/** Named tactics clear enough to point out on a move that wasn't a mistake. */
const CLEAR: PatternTag[] = ['knight_fork', 'fork', 'pawn_fork', 'discovered_attack', 'skewer', 'hanging_piece', 'back_rank'];

/** "24.Nh6+" for the reply to the user's move at ply index `i`. */
function replyLabel(plies: PlyRecord[], i: number, san: string): string {
  const p = plies[i];
  const n = p.color === 'b' ? p.moveNumber + 1 : p.moveNumber;
  return p.color === 'b' ? `${n}.${san}` : `${n}...${san}`;
}

export function findLuckyEscapes(plies: PlyRecord[], evals: MoveEval[], positions: PositionEval[], userColor: Color, taughtPlies: Set<number>): LuckyEscape[] {
  const out: LuckyEscape[] = [];
  plies.forEach((p, i) => {
    const e = evals[i];
    const next = plies[i + 1];
    // Only inaccuracies (mistakes and blunders get the full treatment) that aren't already explained.
    if (p.color !== userColor || !e || !next || verdictOf(e) !== 'inaccuracy' || taughtPlies.has(p.ply)) return;
    const opp = other(userColor);
    // What they actually played, from their side: a mate, or something clearly better than the line, isn't luck.
    const actual = evals[i + 1];
    if (next.san.includes('#')) return;
    for (const line of positions[i + 1]?.lines ?? []) {
      const first = line.pv[0];
      // They played it: not an escape.
      if (!first || first === next.uci) continue;
      const mate = scoreToCp(line.score) >= MATE_CP - 1000;
      const hit = detectPattern(p.fenBefore, p.uci, line.pv, [], []);
      const named = hit && hit.side === 'refutation' && hit.at === 1 && CLEAR.includes(hit.tag);
      if (!mate && !named) continue;
      if (actual && actual.cpAfter >= scoreToCp(line.score) + 100) continue;
      // High confidence: the line really wins something (or mates) once the captures are over.
      const gain = materialAfterLine(p.fenAfter, line.pv, opp) - materialBalance(p.fenAfter, opp);
      if (!mate && gain < 1) continue;
      // A loose pawn isn't worth a note; a piece is.
      if (!mate && hit!.tag === 'hanging_piece' && (pieceAt(p.fenAfter, first.slice(2, 4))?.type ?? 'p') === 'p') continue;
      // Lucky: in the game, the material didn't change hands over the next few moves.
      const later = plies[Math.min(plies.length - 1, i + 3)];
      if (materialBalance(later.fenAfter, userColor) < materialBalance(p.fenAfter, userColor) - 1) continue;
      const san = playLine(p.fenAfter, [first], 1)[0]?.san ?? first;
      const move = replyLabel(plies, i, san);
      const who = COLOR_NAME[opp];
      let text: string;
      if (mate) text = `Lucky escape: ${move} started a forced mate. ${who} didn't play it.`;
      else if (hit!.tag === 'hanging_piece') {
        const victim = pieceAt(p.fenAfter, first.slice(2, 4));
        text = `Lucky escape: ${move} would have taken your ${victim ? PIECE_NAME[victim.type] : 'piece'} on ${first.slice(2, 4)} for free. ${who} didn't play it.`;
      } else {
        // The evidence starts with the move ("Nh6+ uncovers the queen on h3, which now attacks the bishop on e6").
        const rest = hit!.evidence.startsWith(san) ? hit!.evidence.slice(san.length).trim() : hit!.evidence;
        text = `Lucky escape: ${move} ${rest}. ${who} didn't play it.`;
      }
      out.push({ ply: p.ply, tag: mate ? 'mate' : hit!.tag, move, text, after: moveLabel(p) });
      break;
    }
  });
  return out;
}
