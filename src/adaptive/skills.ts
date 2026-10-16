// Skill profile for the Adaptive Coach, kept as three separate layers:
//   1. weakness   — detected in REAL games only (coach games never change it)
//   2. training   — results of Adaptive Coach games
//   3. confirmation — what real games played after the last good training result show
// Derived on demand from games + sessions, so it can never go stale.
import type { AdaptiveSession, AdaptiveSkill, AdaptiveVerdict, CategoryId, SkillExample, StoredGame } from '../domain/types';
import { gamePlayedAt, isRealGame } from '../analysis/pipeline';
import { moveLabel } from '../chess/pgn';
import { pawnBreaks } from './features';

export const SKILLS: AdaptiveSkill[] = ['positional_patience', 'development_discipline', 'conversion'];

export const SKILL_LABEL: Record<AdaptiveSkill, string> = {
  positional_patience: 'Positional patience',
  development_discipline: 'Development discipline',
  conversion: 'Converting an advantage',
};

/** Existing finding categories that count as evidence for each skill. */
const CATEGORIES: Record<AdaptiveSkill, CategoryId[]> = {
  positional_patience: ['central_tension', 'premature_attack'],
  development_discipline: ['development', 'early_queen', 'inefficient_moves'],
  conversion: ['gave_back_material', 'failure_to_simplify', 'unnecessary_complications', 'hunting_material', 'allowed_counterplay'],
};

export type Confidence = 'none' | 'possible' | 'emerging' | 'established';

export interface SkillStatus {
  skill: AdaptiveSkill;
  label: string;
  weakness: {
    score: number;
    level: 'none' | 'low' | 'medium' | 'high';
    /** Games that support it (a game with only the weak pawn-break signal counts as half). */
    games: number;
    confidence: Confidence;
    examples: SkillExample[];
  };
  training: {
    /** Valid tests only ("not meaningfully tested" games are not counted). */
    tests: number;
    lastTestedAt?: number;
    recent: { at: number; verdict: AdaptiveVerdict; sessionId: string }[];
    /** Recent sessions mostly produced no valid test: the steering isn't producing this lesson. */
    lowEmergence: boolean;
  };
  /** Real games after the last demonstrated result, and how many showed the weakness again. */
  confirmation?: { since: number; realGames: number; reappeared: number };
}

interface GameEvidence {
  weight: number;
  examples: SkillExample[];
}

/** Evidence for one skill in one real, analysed game. */
export function gameEvidence(game: StoredGame, skill: AdaptiveSkill): GameEvidence {
  const at = gamePlayedAt(game);
  const examples: SkillExample[] = [];
  let weight = 0;
  for (const f of game.findings) {
    if (f.kind !== 'weakness' || f.confidence === 'low' || f.severity < 2 || !CATEGORIES[skill].includes(f.category as CategoryId)) continue;
    const p = game.plies[f.ply - 1];
    if (skill === 'development_discipline' && p && p.moveNumber > 15) continue;
    weight = Math.max(weight, f.severity === 3 ? 1.5 : 1);
    examples.push({ gameId: game.id, ply: f.ply, text: f.evidence, at });
  }
  if (skill === 'positional_patience' && game.analysis) {
    // The pawn-break signal is a heuristic: on its own it only ever counts as half a game.
    const premature = pawnBreaks(game.plies, game.analysis.moves, game.userColor).filter((b) => b.kind === 'premature');
    if (premature.length) {
      weight = weight ? Math.max(weight, 1) + 0.25 : 0.5;
      for (const b of premature.slice(0, 2)) {
        const p = game.plies[b.ply - 1];
        examples.push({ gameId: game.id, ply: b.ply, text: `${moveLabel(p)} broke with a pawn in a quiet, level position; Stockfish preferred ${b.bestSan} first.`, at });
      }
    }
  }
  return { weight, examples };
}

export function buildSkillProfile(games: StoredGame[], sessions: AdaptiveSession[]): SkillStatus[] {
  const real = games.filter((g) => g.status === 'analyzed' && isRealGame(g)).sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a));
  return SKILLS.map((skill) => {
    let score = 0;
    let n = 0;
    const examples: SkillExample[] = [];
    real.forEach((g, i) => {
      const e = gameEvidence(g, skill);
      if (!e.weight) return;
      score += e.weight * (i < 5 ? 1 : i < 15 ? 0.6 : 0.3);
      n += Math.min(1, e.weight);
      examples.push(...e.examples);
    });
    const confidence: Confidence = n >= 3 ? 'established' : n >= 2 ? 'emerging' : n >= 1 ? 'possible' : 'none';
    const level = score >= 3 ? 'high' : score >= 1.5 ? 'medium' : score > 0 ? 'low' : 'none';

    const mine = sessions
      .filter((s) => s.plan.skill === skill && s.status === 'done' && s.result?.valid)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    const recent = mine.slice(0, 5).map((s) => ({ at: s.finishedAt ?? s.createdAt, verdict: s.result!.verdict, sessionId: s.id }));
    const lastGood = mine.find((s) => s.result!.verdict === 'demonstrated');
    let confirmation: SkillStatus['confirmation'];
    if (lastGood) {
      const since = lastGood.finishedAt ?? lastGood.createdAt;
      const after = real.filter((g) => gamePlayedAt(g) > since);
      confirmation = { since, realGames: after.length, reappeared: after.filter((g) => gameEvidence(g, skill).weight >= 1).length };
    }
    return {
      skill,
      label: SKILL_LABEL[skill],
      weakness: { score: Math.round(score * 10) / 10, level, games: n, confidence, examples: examples.slice(0, 4) },
      training: { tests: mine.length, lastTestedAt: recent[0]?.at, recent, lowEmergence: lowEmergence(sessions, skill) },
      confirmation,
    };
  });
}

/** Most of the recent finished sessions for this skill produced no valid test. */
export function lowEmergence(sessions: AdaptiveSession[], skill: AdaptiveSkill, window = 5): boolean {
  const recent = sessions.filter((s) => s.plan.skill === skill && s.status === 'done' && s.result).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, window);
  return recent.length >= 3 && recent.filter((s) => !s.result!.valid).length / recent.length >= 0.6;
}
