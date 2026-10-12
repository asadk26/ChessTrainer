// Turns teaching moments into short drills that reinforce the *concept*.
import type { CategoryId, Color, Drill, DrillType, TeachingMoment } from '../domain/types';
import { COLOR_NAME, other, playLine } from '../chess/board';
import { ENGINE_REPLY_CATEGORIES } from '../analysis/moments';

export const PROBLEM_OPTIONS = [
  'It leaves a piece hanging',
  'It wastes time (a tempo, or development)',
  "It ignores the opponent's threat",
  'It weakens your king',
  'It lets the opponent back into the game',
  "It's a good move",
];

const PROBLEM_INDEX: Partial<Record<CategoryId, number>> = {
  blunder: 0,
  calculation: 0,
  inefficient_moves: 1,
  premature_attack: 1,
  pointless_check: 1,
  early_queen: 1,
  missed_threat: 2,
  king_safety: 3,
  gave_back_material: 0,
  hunting_material: 1,
  allowed_counterplay: 4,
  unnecessary_complications: 4,
  failure_to_simplify: 4,
};

function drillFor(m: TeachingMoment, type: DrillType, gameId: string): Drill | undefined {
  const mover: Color = m.moverColor;
  const opp = COLOR_NAME[other(mover)];
  const me = COLOR_NAME[mover];
  const base = { gameId, ply: m.ply, category: m.category, createdAt: Date.now() };
  switch (type) {
    case 'find_better': {
      if (!m.bestUci) return undefined;
      const tactic = m.category === 'tactical_blindness';
      return {
        ...base,
        id: `${gameId}:${m.ply}:better`,
        type,
        fen: m.betterFen,
        orientation: mover,
        prompt: tactic
          ? `${me} to move. There's a way to win material — find it.`
          : `${me} to move. In the game you played ${m.betterPly === m.ply ? m.playedSan : 'a retreat'}. Find a more useful move.`,
        acceptableUcis: Array.from(new Set([m.bestUci, ...m.acceptableUcis])),
        solutionUci: m.bestUci,
        solutionSan: m.bestSan,
        explanation: m.text.reveal || m.text.lesson,
      };
    }
    case 'predict_response': {
      if (!m.acceptableReplyUcis.length) return undefined;
      const punishing = ENGINE_REPLY_CATEGORIES.includes(m.category);
      const solutionUci = punishing ? m.acceptableReplyUcis[0] : m.opponentReplyUci ?? m.acceptableReplyUcis[0];
      return {
        ...base,
        id: `${gameId}:${m.ply}:predict`,
        type,
        fen: m.fenAfter,
        orientation: mover,
        prompt: punishing
          ? `You played ${m.playedSan} (arrow). What is ${opp}'s most dangerous response? Play it for ${opp}.`
          : `You played ${m.playedSan} (arrow). What is ${opp}'s most natural response? Play it for ${opp}.`,
        acceptableUcis: m.acceptableReplyUcis,
        solutionUci,
        solutionSan: playLine(m.fenAfter, [solutionUci])[0]?.san,
        questionArrow: { from: m.playedUci.slice(0, 2), to: m.playedUci.slice(2, 4), color: 'played' },
        explanation: m.text.reveal,
      };
    }
    case 'identify_problem': {
      const idx = PROBLEM_INDEX[m.category as CategoryId];
      if (idx === undefined) return undefined;
      return {
        ...base,
        id: `${gameId}:${m.ply}:problem`,
        type,
        fen: m.fenBefore,
        orientation: mover,
        prompt: `${me} is considering ${m.playedSan} (arrow). What's the problem with it?`,
        options: PROBLEM_OPTIONS,
        correctIndex: idx,
        questionArrow: { from: m.playedUci.slice(0, 2), to: m.playedUci.slice(2, 4), color: 'played' },
        explanation: `${m.text.reveal} ${m.text.lesson}`.trim(),
      };
    }
    case 'choose_plan': {
      if (m.kind !== 'good_idea') return undefined;
      return {
        ...base,
        id: `${gameId}:${m.ply}:plan`,
        type,
        fen: m.fenBefore,
        orientation: mover,
        prompt: `${opp} is behind in development and the ${opp.toLowerCase()} king is still in the center. What general plan makes the most sense?`,
        options: ['Launch a knight attack on the queenside', 'Finish development and open the center', 'Trade queens immediately'],
        correctIndex: 1,
        explanation: `With the enemy king stuck in the center, open lines toward it — in the game, ${m.playedSan} did exactly that. A lone knight attack is easy to parry, and trading queens takes the pressure off. ${m.text.lesson}`,
      };
    }
  }
}

/** Preferred drill types per moment category, most instructive first. */
function preferredTypes(m: TeachingMoment): DrillType[] {
  if (m.kind === 'good_idea') return ['choose_plan'];
  switch (m.category) {
    case 'tactical_blindness':
    case 'missed_king_attack':
      return ['find_better'];
    case 'premature_attack':
    case 'pointless_check':
    case 'inefficient_moves':
      return ['predict_response', 'identify_problem', 'find_better'];
    case 'blunder':
    case 'missed_threat':
    case 'calculation':
    case 'gave_back_material':
      return ['identify_problem', 'predict_response', 'find_better'];
    case 'allowed_counterplay':
    case 'unnecessary_complications':
      return ['predict_response', 'identify_problem', 'find_better'];
    case 'hunting_material':
    case 'failure_to_simplify':
      return ['identify_problem', 'find_better'];
    default:
      return ['find_better', 'identify_problem'];
  }
}

/** ~2–3 drills per game, varied in type, from the most significant moments. */
export function generateDrills(gameId: string, moments: TeachingMoment[], max = 3): Drill[] {
  const ordered = [...moments].sort((a, b) => b.significance - a.significance);
  const out: Drill[] = [];
  const usedTypes = new Set<DrillType>();
  // First pass: one drill per moment, preferring a type we haven't used yet.
  for (const m of ordered) {
    if (out.length >= max) break;
    const types = preferredTypes(m);
    const pick = types.find((t) => !usedTypes.has(t)) ?? types[0];
    const d = drillFor(m, pick, gameId) ?? types.map((t) => drillFor(m, t, gameId)).find(Boolean);
    if (d) {
      out.push(d);
      usedTypes.add(d.type);
    }
  }
  return out;
}
