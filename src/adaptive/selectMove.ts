// How the Adaptive Coach picks its move. Stockfish decides what is sound; the lesson and a small
// "would a person play this?" prior only choose between moves that are already sound enough.
//
//   Stockfish MultiPV candidates (full depth — analysis strength never changes)
//     → reference eval: Stockfish's best, or — when the coach is comfortably ahead — a lower
//       "good enough" target, so it stops pressing instead of crushing (ease-off)
//     → drop anything too far below the reference, anything whose own line sheds material
//       compared with Stockfish's best line, and anything that walks into mate
//     → score the rest: lesson (only for moves near the reference) + naturalness − gap + variety
//     → play the top score
//
// Playing strength comes only from this selection (COACH_TUNING), never from a shallow search.
import type { AdaptiveSkill, CoachCandidate, CoachMoveLog, PositionEval } from '../domain/types';
import { attackedEnemyPieces, attackersOf, materialAfterLine, pieceAt, sideToMove, uciToSan } from '../chess/board';
import { scoreToCp } from '../analysis/evaluation';
import { EQUAL_BAND, gapBetween } from '../analysis/moveQuality';
import { developmentReasons } from '../training/opening';
import { lockedCentre, moveFacts, pawnTension } from './features';

export type StrengthId = 'relaxed' | 'steady' | 'firm';

export interface StrengthTuning {
  label: string;
  detail: string;
  /** Widest win% gap below the reference the coach may choose. */
  band: number;
  /** Band while the coach is already worse (it defends properly; never hands anything back). */
  behindBand: number;
  /** Coach advantage (cp) above which it eases off instead of pressing; Infinity = never. */
  easeFrom: number;
  /** How much of its lead above easeFrom (cp) it is content to let go of, positionally only. */
  easeMaxCp: number;
}

/**
 * Every knob for coach playing strength and move choice, in one place. Bump `version` when you
 * change anything, so decision logs from playtests say which tuning produced them.
 */
export const COACH_TUNING = {
  version: 'p2.1',
  engine: { depth: 12, multiPv: 5 },
  strengths: {
    relaxed: { label: 'Relaxed', detail: 'Plays sound, natural moves but doesn’t press when ahead; occasionally a less precise move. Never hangs material.', band: 8, behindBand: 4, easeFrom: 60, easeMaxCp: 180 },
    steady: { label: 'Steady', detail: 'Sound, natural moves within ~0.5 pawns of best; eases off once clearly ahead. Never hangs material.', band: 5, behindBand: 2.5, easeFrom: 120, easeMaxCp: 120 },
    firm: { label: 'Firm', detail: 'Close to Stockfish’s best and presses every advantage; the lesson only breaks near-ties.', band: EQUAL_BAND, behindBand: 2, easeFrom: Infinity, easeMaxCp: 0 },
  } satisfies Record<StrengthId, StrengthTuning>,
  /** Coach eval (cp) at or below which it counts as "behind". */
  behindCp: -150,
  /** Hard cap on centipawns given up per allowed win% point of band. */
  cpPerBandPoint: 15,
  /** A lesson preference may only pick moves within this many win% of the reference. */
  lessonMaxGap: 3,
  /** While easing off, never more than this × band below Stockfish's best. */
  easeMaxGapFactor: 1.6,
  /**
   * Lessons whose target position is a balanced one start easing off sooner (cp), so the game
   * stays level long enough for the test to appear. Only applies to strengths that ease off.
   */
  skillEaseFrom: { positional_patience: 60 } as Partial<Record<AdaptiveSkill, number>>,
  weights: { gap: 0.5, lesson: 1, natural: 1, variety: 1.2, book: 0.5, repeat: 1.5 },
  /** Minimum time the coach "thinks" before moving, so replies don't feel instant. */
  minThinkMs: 700,
};

/** Plies of each engine line to follow before judging whether a move sheds material. */
export const MATERIAL_PLIES = 6;

export const STRENGTHS = (Object.keys(COACH_TUNING.strengths) as StrengthId[]).map((id) => ({ id, ...COACH_TUNING.strengths[id] }));
export const DEFAULT_STRENGTH: StrengthId = 'steady';
/** Search settings for the coach's candidates: analysis strength, independent of playing strength. */
export const COACH_ENGINE = COACH_TUNING.engine;
export type CoachStrength = (typeof STRENGTHS)[number];

export interface SelectConfig {
  /** Widest win% gap from the reference (sessions store this as `band`). */
  band: number;
  strength?: StrengthId;
  /** Randomness between allowed moves (0 = deterministic). Defaults to the tuning value. */
  variety?: number;
}

export interface SelectContext {
  skill?: AdaptiveSkill;
  /** Square the opponent's last move landed on (to recognise recaptures). */
  lastMoveTo?: string;
  /** Moves your real opponents played in this position (opening book from your own games). */
  book?: Set<string>;
  /** Coach moves from recent sessions in this exact position: avoided so games stay fresh. */
  avoid?: Set<string>;
  rng?: () => number;
}

export interface Candidate extends CoachCandidate {
  allowed: boolean;
  /** Win% gap from Stockfish's best (gap is from the reference). */
  gapBest: number;
  materialDelta: number;
  parts: { lesson: number; natural: number; gap: number; noise: number; repeat: number };
}

export interface Decision {
  bestCp: number;
  refCp: number;
  band: number;
  eased: boolean;
  behind: boolean;
  cands: Candidate[];
}

function tuningFor(cfg: SelectConfig): StrengthTuning {
  if (cfg.strength) return COACH_TUNING.strengths[cfg.strength];
  // Older sessions only stored the band: match it, else treat it as a custom band without ease-off.
  return STRENGTHS.find((s) => s.band === cfg.band) ?? { label: 'Custom', detail: '', band: cfg.band, behindBand: Math.min(cfg.band, EQUAL_BAND), easeFrom: Infinity, easeMaxCp: 0 };
}

/** Score each MultiPV candidate and mark which ones the coach may play. Pure. */
export function decide(fen: string, pos: PositionEval, cfg: SelectConfig, ctx: SelectContext = {}): Decision | undefined {
  const lines = pos.lines.filter((l) => l.pv.length);
  if (!lines.length) return undefined;
  const t = tuningFor(cfg);
  const me = sideToMove(fen);
  const bestCp = scoreToCp(lines[0].score);
  const behind = bestCp <= COACH_TUNING.behindCp;
  const mateForMe = lines[0].score.type === 'mate' && lines[0].score.value > 0;
  // Ease-off: comfortably ahead, the coach is content with any move that keeps it above refCp.
  const easeFrom = Number.isFinite(t.easeFrom) && ctx.skill ? Math.min(t.easeFrom, COACH_TUNING.skillEaseFrom[ctx.skill] ?? Infinity) : t.easeFrom;
  const eased = !behind && !mateForMe && bestCp > easeFrom;
  const refCp = eased ? Math.max(easeFrom, bestCp - t.easeMaxCp) : bestCp;
  const band = behind ? t.behindBand : cfg.band;
  const cpCap = band * COACH_TUNING.cpPerBandPoint;
  // Material at the end of each line once exchanges have settled — followed for at least
  // MATERIAL_PLIES so a pawn regained a few moves later (e.g. the Petrov) doesn't count as lost.
  const material = (pv: string[]) => materialAfterLine(fen, pv, me, 10, MATERIAL_PLIES);
  const bestMaterial = material(lines[0].pv);
  const rng = ctx.rng ?? Math.random;
  const variety = cfg.variety ?? COACH_TUNING.weights.variety;
  const W = COACH_TUNING.weights;

  const cands = lines.map((l, i): Candidate => {
    const uci = l.pv[0];
    const cp = scoreToCp(l.score);
    const gapBest = i === 0 ? 0 : gapBetween(bestCp, cp);
    const gap = cp >= refCp ? 0 : gapBetween(refCp, cp);
    const materialDelta = i === 0 ? 0 : material(l.pv) - bestMaterial;
    let out: CoachCandidate['out'];
    if (i > 0) {
      if (mateForMe) out = 'mate';
      else if (l.score.type === 'mate' && l.score.value < 0) out = 'mate';
      else if (materialDelta < 0) out = 'material';
      else if (gap > band || Math.max(0, Math.min(1000, refCp) - Math.min(1000, cp)) > cpCap) out = 'band';
      else if (eased && gapBest > band * COACH_TUNING.easeMaxGapFactor) out = 'band';
    }
    const raw = ctx.skill ? relevance(ctx.skill, fen, uci, ctx) : 0;
    const lesson = gap <= COACH_TUNING.lessonMaxGap ? raw : 0;
    const natural = naturalness(fen, uci, ctx) + (ctx.book?.has(uci) ? W.book : 0);
    const repeat = ctx.avoid?.has(uci) ? -W.repeat : 0;
    const noise = variety * rng();
    const parts = { lesson: W.lesson * lesson, natural: W.natural * natural, gap: -W.gap * gap, noise, repeat };
    const score = parts.lesson + parts.natural + parts.gap + parts.noise + parts.repeat;
    return { uci, san: uciToSan(fen, uci) ?? uci, cp, gap, gapBest, lesson, natural, score, out, allowed: !out, materialDelta, parts };
  });
  return { bestCp, refCp, band, eased, behind, cands };
}

/** Back-compat helper used by tests: the candidates with their allowed flags. */
export function candidates(fen: string, pos: PositionEval, cfg: SelectConfig, ctx: SelectContext = {}): Candidate[] {
  return decide(fen, pos, cfg, ctx)?.cands ?? [];
}

export function selectCoachMove(fen: string, pos: PositionEval, cfg: SelectConfig, ctx: SelectContext = {}): { uci: string; log: Omit<CoachMoveLog, 'ply'> } | undefined {
  const d = decide(fen, pos, cfg, ctx);
  if (!d) return undefined;
  const best = d.cands[0];
  const allowed = d.cands.filter((c) => c.allowed);
  const top = allowed.length === 1 ? best : allowed.reduce((a, c) => (c.score! > a.score! ? c : a));
  const reason = allowed.length === 1 ? 'only' : explain(top, best, d);
  return {
    uci: top.uci,
    log: {
      uci: top.uci,
      san: top.san,
      bestUci: best.uci,
      bestSan: best.san,
      bestCp: d.bestCp,
      gap: top.gapBest,
      allowed: allowed.length,
      relevance: top.lesson,
      reason,
      eased: d.eased || undefined,
      band: d.band,
      cands: d.cands.map(({ uci, san, cp, gap, lesson, natural, score, out }) => ({ uci, san, cp, gap: round(gap), lesson: round(lesson), natural: round(natural), score: round(score!), out })),
    },
  };
}

const round = (x: number) => Math.round(x * 10) / 10;

/** Which part of the score made the chosen move beat Stockfish's best. */
function explain(top: Candidate, best: Candidate, d: Decision): CoachMoveLog['reason'] {
  if (top === best) return 'best';
  const diff = {
    lesson: top.parts.lesson - best.parts.lesson,
    natural: top.parts.natural - best.parts.natural + (top.parts.repeat - best.parts.repeat),
    noise: top.parts.noise - best.parts.noise,
  };
  const [driver] = (Object.entries(diff) as [keyof typeof diff, number][]).sort((a, b) => b[1] - a[1])[0];
  if (driver === 'lesson' && diff.lesson > 0) return 'lesson';
  if (driver === 'natural' && diff.natural > 0) return 'natural';
  if (d.eased && top.gapBest >= EQUAL_BAND) return 'eased';
  return top.gapBest < EQUAL_BAND ? 'near_best' : 'variety';
}

// ------------------------------------------------------------ naturalness

/**
 * Would a club player plausibly play this? A small prior so that, among sound moves, the coach
 * prefers human-looking ones: recaptures, development, castling — not early king walks, edge
 * knights or unprovoked retreats. It never makes an unsound move playable.
 */
export function naturalness(fen: string, uci: string, ctx: Pick<SelectContext, 'lastMoveTo'> = {}): number {
  const f = moveFacts(fen, uci, ctx.lastMoveTo);
  if (!f) return 0;
  const moveNumber = Number(fen.split(' ')[5] ?? 1);
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const side = sideToMove(fen);
  const queensOn = /q/.test(fen.split(' ')[0]) && /Q/.test(fen.split(' ')[0]);
  let n = 0;
  if (f.recapture) n += 1.5;
  if (f.san.startsWith('O-O')) n += 1;
  else if (f.piece === 'k' && queensOn && !f.capture) n -= 1.5;
  if (moveNumber <= 12 && developmentReasons(fen, uci, moveNumber, []).score > 0) n += 0.5;
  if (f.piece === 'q' && moveNumber <= 8 && !f.capture) n -= 1;
  if (f.piece === 'n' && 'ah'.includes(to[0]) && !f.capture) n -= 0.5;
  if (f.piece === 'p' && 'ah'.includes(from[0]) && moveNumber <= 10 && !f.capture) n -= 0.5;
  // Retreat to the back rank of a piece nobody was attacking.
  const back = side === 'w' ? '1' : '8';
  const piece = pieceAt(fen, from);
  if (piece && piece.type !== 'k' && piece.type !== 'p' && to[1] === back && from[1] !== back && !f.capture && attackersOf(fen, from, side === 'w' ? 'b' : 'w').length === 0) n -= 0.5;
  return n;
}

// ------------------------------------------------------------ lesson relevance

/**
 * Small integer-ish points: how well a (sound) coach move serves the lesson. Bounded so it can
 * only choose among allowed moves, never outweigh soundness.
 */
export function relevance(skill: AdaptiveSkill, fen: string, uci: string, ctx: Pick<SelectContext, 'lastMoveTo'> = {}): number {
  const f = moveFacts(fen, uci, ctx.lastMoveTo);
  if (!f) return 0;
  const moveNumber = Number(fen.split(' ')[5] ?? 1);
  const forcing = (!!f.capture && !f.recapture) || f.check;
  const tradesPiece = !!f.capture && f.capture !== 'p' && !f.recapture;
  const queensOff = /q/.test(fen.split(' ')[0]) && /Q/.test(fen.split(' ')[0]) && !(/q/.test(f.fenAfter.split(' ')[0]) && /Q/.test(f.fenAfter.split(' ')[0]));
  let r = 0;
  switch (skill) {
    case 'positional_patience': {
      // Keep the position closed, balanced and unforced, so the player has to find a plan.
      if (moveNumber < 3) return 0;
      r += forcing ? -1 : 1;
      if (pawnTension(f.fenAfter) >= pawnTension(fen)) r += 1;
      if (f.capture === 'p' && 'cdef'.includes(uci[2]) && !f.recapture) r -= 1.5;
      if (lockedCentre(f.fenAfter) > lockedCentre(fen)) r += 1;
      else if (lockedCentre(f.fenAfter) > 0) r += 0.5;
      if (queensOff) r -= 1;
      return r;
    }
    case 'development_discipline': {
      // A principled, unforced opening with pieces kept on: the player's own choices decide.
      if (moveNumber > 14) return 0;
      r += Math.max(-1, Math.min(1.8, developmentReasons(fen, uci, moveNumber, []).score));
      if (!forcing) r += 1;
      if (tradesPiece) r -= 1.5;
      return r;
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
