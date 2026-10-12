// Practical context for each of the user's moves: are they far ahead, under
// attack, in an endgame, racing pawns? Detectors and the report use this to
// decide what is instructive (e.g. when far ahead, giving material back and
// allowing counterplay matter far more than a lost tempo).
import type { Color, MoveEval, PlyContext, PlyRecord } from '../domain/types';
import {
  hasQueen,
  kingInCenter,
  kingZoneAttacks,
  nonPawnMaterial,
  other,
  passedPawns,
  pawnShield,
  relativeRank,
} from '../chess/board';
import { Chess } from 'chess.js';

export const AHEAD = 3;
export const FAR_AHEAD = 5;

/** Is `color`'s king under real pressure in this position? */
export function underKingPressure(fen: string, color: Color): boolean {
  const enemy = other(color);
  if (!hasQueen(fen, enemy) && nonPawnMaterial(fen) < 12) return false;
  let score = kingZoneAttacks(fen, color);
  const c = new Chess(fen);
  if (c.turn() === color && c.inCheck()) score += 2;
  if (pawnShield(fen, color) <= 1 && hasQueen(fen, enemy)) score += 1;
  return score >= 4;
}

export function isEndgame(fen: string): boolean {
  const npm = nonPawnMaterial(fen);
  return npm <= 14 || (!hasQueen(fen, 'w') && !hasQueen(fen, 'b') && npm <= 20);
}

/** Advanced passed pawns decide the game: someone has one on the 6th/7th, or both have one past the 5th. */
export function isPromotionRace(fen: string): boolean {
  const adv = (c: Color) => Math.max(0, ...passedPawns(fen, c).map((sq) => relativeRank(sq, c)));
  const w = adv('w');
  const b = adv('b');
  return nonPawnMaterial(fen) <= 24 && (w >= 6 || b >= 6 || (w >= 5 && b >= 5));
}

export function plyContext(p: PlyRecord, e: MoveEval, user: Color): PlyContext {
  const fen = p.fenBefore;
  const opp = other(user);
  // Settled material: what the side to move keeps after the engine's best line,
  // so a half-finished exchange doesn't look like being a queen down.
  const material = e.materialAfterBest;
  return {
    ply: p.ply,
    material,
    cp: e.cpBefore,
    ahead: material >= AHEAD,
    farAhead: material >= FAR_AHEAD,
    behind: material <= -AHEAD,
    kingPressure: underKingPressure(fen, user),
    attackingKing:
      underKingPressure(fen, opp) || (p.moveNumber >= 10 && kingInCenter(fen, opp) && hasQueen(fen, user) && hasQueen(fen, opp)),
    endgame: isEndgame(fen),
    race: isPromotionRace(fen),
  };
}

/** Context for every user move, keyed by ply. */
export function buildContexts(plies: PlyRecord[], evals: MoveEval[], user: Color): Map<number, PlyContext> {
  const out = new Map<number, PlyContext>();
  plies.forEach((p, i) => {
    if (p.color === user) out.set(p.ply, plyContext(p, evals[i], user));
  });
  return out;
}

export interface GamePhases {
  /** First user move from which they stayed materially ahead (≥3) for most of the game. */
  aheadFrom?: number;
  /** Share of user moves played while materially ahead. */
  aheadShare: number;
  behindShare: number;
  kingPressurePlies: number[];
  endgameFrom?: number;
  raceFrom?: number;
}

export function summarizePhases(contexts: Map<number, PlyContext>): GamePhases {
  const list = [...contexts.values()].sort((a, b) => a.ply - b.ply);
  const n = Math.max(1, list.length);
  const ahead = list.filter((c) => c.ahead);
  let aheadFrom: number | undefined;
  for (let i = 0; i < list.length; i++) {
    const rest = list.slice(i);
    if (list[i].ahead && rest.filter((c) => c.ahead).length / rest.length >= 0.8) {
      aheadFrom = list[i].ply;
      break;
    }
  }
  return {
    aheadFrom,
    aheadShare: ahead.length / n,
    behindShare: list.filter((c) => c.behind).length / n,
    kingPressurePlies: list.filter((c) => c.kingPressure).map((c) => c.ply),
    endgameFrom: list.find((c) => c.endgame)?.ply,
    raceFrom: list.find((c) => c.race)?.ply,
  };
}
