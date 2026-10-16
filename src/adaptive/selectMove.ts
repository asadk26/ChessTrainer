// How the Adaptive Coach picks its move. Stockfish decides what is sound; the lesson only
// chooses between moves that are already sound enough.
//
//   Stockfish MultiPV candidates
//     → drop anything outside the strength band, or that sheds material in its own line
//     → score the rest: lesson relevance − distance from best + a little variety
//     → play the top score (Stockfish's best when nothing else qualifies)
//
// Playing strength comes from the band (how far from best the coach may stray), not from a
// shallow search: the analysis depth stays high enough to judge candidates reliably.
import type { AdaptiveSkill, CoachMoveLog, PositionEval } from '../domain/types';
import { attackedEnemyPieces, materialAfterLine, sideToMove } from '../chess/board';
import { scoreToCp } from '../analysis/evaluation';
import { EQUAL_BAND, gapBetween } from '../analysis/moveQuality';
import { developmentReasons } from '../training/opening';
import { lockedCentre, moveFacts, pawnTension } from './features';

export interface CoachStrength {
  id: 'relaxed' | 'steady' | 'firm';
  label: string;
  detail: string;
  /** Widest win% gap from Stockfish's best the coach may choose (≈ 10cp per point when level). */
  band: number;
}

export const STRENGTHS: CoachStrength[] = [
  { id: 'relaxed', label: 'Relaxed', detail: 'Sometimes picks a natural move up to ~0.8 pawns below best — never a blunder.', band: 8 },
  { id: 'steady', label: 'Steady', detail: 'Natural, sound moves within ~0.5 pawns of best.', band: 5 },
  { id: 'firm', label: 'Firm', detail: 'Plays close to Stockfish’s best; the lesson only breaks near-ties.', band: EQUAL_BAND },
];
export const DEFAULT_STRENGTH: CoachStrength['id'] = 'steady';

/** Search settings for the coach's candidates: analysis strength, independent of playing strength. */
export const COACH_ENGINE = { depth: 12, multiPv: 5 };

export interface SelectConfig {
  band: number;
  /** How much randomness to add between allowed moves (0 = deterministic). */
  variety: number;
}

export interface SelectContext {
  skill?: AdaptiveSkill;
  /** Square the opponent's last move landed on (to recognise recaptures). */
  lastMoveTo?: string;
  /** Moves your real opponents played in this position (opening book from your own games). */
  book?: Set<string>;
  rng?: () => number;
}

/** When the coach is already worse than this (cp, its own view), it stops conceding anything. */
export const BEHIND_CP = -150;
const W_GAP = 0.5;

export interface Candidate {
  uci: string;
  cp: number;
  gap: number;
  materialDelta: number;
  allowed: boolean;
  relevance: number;
}

/** Score each MultiPV candidate and mark which ones the coach may play. Pure. */
export function candidates(fen: string, pos: PositionEval, cfg: SelectConfig, ctx: SelectContext = {}): Candidate[] {
  const lines = pos.lines.filter((l) => l.pv.length);
  if (!lines.length) return [];
  const me = sideToMove(fen);
  const bestCp = scoreToCp(lines[0].score);
  // Already behind (or getting mated): play Stockfish-equal moves only, and cap the cp loss.
  const behind = bestCp <= BEHIND_CP;
  const band = behind ? Math.min(cfg.band, EQUAL_BAND) : cfg.band;
  const cpCap = behind ? 40 : band * 15;
  const bestMaterial = materialAfterLine(fen, lines[0].pv, me, 8);
  return lines.map((l, i) => {
    const cp = scoreToCp(l.score);
    const gap = i === 0 ? 0 : gapBetween(bestCp, cp);
    const materialDelta = i === 0 ? 0 : materialAfterLine(fen, l.pv, me, 8) - bestMaterial;
    const mateForMe = lines[0].score.type === 'mate' && lines[0].score.value > 0;
    const allowed =
      i === 0 ||
      (!mateForMe && gap <= band && Math.max(0, Math.min(1000, bestCp) - Math.min(1000, cp)) <= cpCap && materialDelta >= 0 && !(l.score.type === 'mate' && l.score.value < 0));
    return { uci: l.pv[0], cp, gap, materialDelta, allowed, relevance: ctx.skill ? relevance(ctx.skill, fen, l.pv[0], ctx) : 0 };
  });
}

export function selectCoachMove(fen: string, pos: PositionEval, cfg: SelectConfig, ctx: SelectContext = {}): { uci: string; log: Omit<CoachMoveLog, 'ply'> } | undefined {
  const all = candidates(fen, pos, cfg, ctx);
  if (!all.length) return undefined;
  const best = all[0];
  const allowed = all.filter((c) => c.allowed);
  const rng = ctx.rng ?? Math.random;
  const log = (c: Candidate, reason: CoachMoveLog['reason']) => ({ uci: c.uci, log: { uci: c.uci, bestUci: best.uci, gap: c.gap, allowed: allowed.length, relevance: c.relevance, reason } });
  if (allowed.length === 1) return log(best, 'only');
  let top = best;
  let topScore = -Infinity;
  for (const c of allowed) {
    const s = c.relevance - W_GAP * c.gap + cfg.variety * rng();
    if (s > topScore) {
      top = c;
      topScore = s;
    }
  }
  if (top === best) return log(best, 'best');
  return log(top, top.relevance > best.relevance ? 'lesson' : 'variety');
}

// ------------------------------------------------------------ lesson relevance

/**
 * Small integer-ish points: how well a (sound) coach move serves the lesson. Bounded so it can
 * only choose among allowed moves, never outweigh soundness.
 */
export function relevance(skill: AdaptiveSkill, fen: string, uci: string, ctx: Pick<SelectContext, 'lastMoveTo' | 'book'> = {}): number {
  const f = moveFacts(fen, uci, ctx.lastMoveTo);
  if (!f) return 0;
  const moveNumber = Number(fen.split(' ')[5] ?? 1);
  const forcing = (!!f.capture && !f.recapture) || f.check;
  const tradesPiece = !!f.capture && f.capture !== 'p' && !f.recapture;
  const queensOff = /q/.test(fen.split(' ')[0]) && /Q/.test(fen.split(' ')[0]) && !(/q/.test(f.fenAfter.split(' ')[0]) && /Q/.test(f.fenAfter.split(' ')[0]));
  const book = ctx.book?.has(uci) ? 1.5 : 0;
  let r = 0;
  switch (skill) {
    case 'positional_patience': {
      // Keep the position closed, balanced and unforced, so the player has to find a plan.
      if (moveNumber < 3) return book;
      r += forcing ? -1 : 1;
      if (pawnTension(f.fenAfter) >= pawnTension(fen)) r += 1;
      if (f.capture === 'p' && 'cdef'.includes(uci[2]) && !f.recapture) r -= 1.5;
      if (lockedCentre(f.fenAfter) > lockedCentre(fen)) r += 1;
      else if (lockedCentre(f.fenAfter) > 0) r += 0.5;
      if (queensOff) r -= 1;
      return r + book;
    }
    case 'development_discipline': {
      // A principled, unforced opening with pieces kept on: the player's own choices decide.
      if (moveNumber > 14) return 0;
      r += Math.max(-1, Math.min(1.8, developmentReasons(fen, uci, moveNumber, []).score));
      if (!forcing) r += 1;
      if (tradesPiece) r -= 1.5;
      return r + book;
    }
    case 'conversion': {
      // Defend properly: keep pieces on and look for activity, so the advantage has to be earned.
      if (tradesPiece) r -= 2;
      if (queensOff) r -= 1;
      if (f.check || (f.capture === undefined && attackedEnemyPieces(f.fenAfter, uci.slice(2, 4)).length > 0)) r += 1;
      return r;
    }
  }
}
