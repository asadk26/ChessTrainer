// Turns teaching moments into short drills that reinforce the *concept*.
import type { Color, Drill, DrillType, TeachingMoment } from '../domain/types';
import { COLOR_NAME, other, playLine } from '../chess/board';
import { usesEngineReply } from '../analysis/moments';

/** What happened, then the rule to take away (both from the moment, so a tactic is named). */
const explain = (m: TeachingMoment) => [m.text.reveal, m.text.lesson].filter(Boolean).join(' ');

function drillFor(m: TeachingMoment, type: DrillType, gameId: string): Drill | undefined {
  const mover: Color = m.moverColor;
  const opp = COLOR_NAME[other(mover)];
  const me = COLOR_NAME[mover];
  const base = { gameId, ply: m.ply, category: m.category, tactic: m.tactic?.tag, createdAt: Date.now() };
  switch (type) {
    case 'find_better': {
      if (!m.bestUci) return undefined;
      const good = m.kind === 'good_idea';
      const missedWin = m.category === 'tactical_blindness' || m.tactic?.side === 'better';
      const solution = good ? m.playedUci : m.bestUci;
      return {
        ...base,
        id: `${gameId}:${m.ply}:better`,
        type,
        fen: good ? m.fenBefore : m.betterFen,
        orientation: mover,
        prompt: good
          ? `${me} to move. You found a strong idea here in the game — find it again.`
          : missedWin
            ? `${me} to move. ${m.text.betterPrompt || "There's a way to win material — find it."}`
            : `${me} to move. In the game you played ${m.betterPly === m.ply ? m.playedSan : 'a retreat'}. Find a better move.`,
        acceptableUcis: Array.from(new Set([solution, ...(good ? [m.bestUci] : []), ...m.acceptableUcis])),
        solutionUci: solution,
        solutionSan: good ? m.playedSan : m.bestSan,
        explanation: explain(m),
      };
    }
    case 'predict_response': {
      if (!m.acceptableReplyUcis.length) return undefined;
      const solutionUci = m.acceptableReplyUcis[0];
      return {
        ...base,
        id: `${gameId}:${m.ply}:predict`,
        type,
        fen: m.fenAfter,
        orientation: mover,
        prompt: `You played ${m.playedSan} (arrow). What's ${opp}'s strongest reply? Play it for ${opp}.`,
        acceptableUcis: m.acceptableReplyUcis,
        solutionUci,
        solutionSan: playLine(m.fenAfter, [solutionUci])[0]?.san,
        questionArrow: { from: m.playedUci.slice(0, 2), to: m.playedUci.slice(2, 4), color: 'played' },
        explanation: explain(m),
      };
    }
  }
}

/**
 * One drill per moment, always a move on the board (no multiple choice):
 *  - "Spot the danger" when the lesson is the opponent's reply (a blunder, a missed threat, a tactic
 *    you walked into) — play their strongest answer to the move you made;
 *  - "Find the better move" otherwise (a missed win, a positional mistake, a good idea).
 */
function preferredTypes(m: TeachingMoment): DrillType[] {
  if (m.kind === 'mistake' && usesEngineReply(m)) return ['predict_response', 'find_better'];
  return ['find_better'];
}

/** Up to 3 drills per game, from the most significant moments. */
export function generateDrills(gameId: string, moments: TeachingMoment[], max = 3): Drill[] {
  const out: Drill[] = [];
  for (const m of [...moments].sort((a, b) => b.significance - a.significance)) {
    if (out.length >= max) break;
    const d = preferredTypes(m).map((t) => drillFor(m, t, gameId)).find(Boolean);
    if (d) out.push(d);
  }
  return out;
}
