// Pre-game planner: pick ONE training objective from evidence in your real games, and where the
// game should start. Deterministic: the plan's preferences map to real scoring rules in the
// move selector, so free text from a language model could not change a single coach move.
import { Chess } from 'chess.js';
import type { AdaptivePlan, AdaptiveSession, AdaptiveSkill, Color, PositionExposure, StoredGame } from '../domain/types';
import { gamePlayedAt, gameLabel, isRealGame } from '../analysis/pipeline';
import { formatCp } from '../analysis/evaluation';
import { moveLabel } from '../chess/pgn';
import { SKILL_LABEL, gameEvidence, type SkillStatus } from './skills';

export const START_FEN = new Chess().fen();

const TEMPLATE: Record<AdaptiveSkill, Pick<AdaptivePlan, 'desiredPosition' | 'coachPreferences' | 'successSignals' | 'failureSignals'>> = {
  positional_patience: {
    desiredPosition: 'a closed or semi-closed, balanced middlegame with no immediate tactics',
    coachPreferences: ['keep central pawn tension', 'avoid unnecessary trades and forcing moves', 'prefer closed pawn structures'],
    successSignals: ['improves pieces before breaking with a pawn', 'pawn breaks that keep the balance', 'keeps quiet positions quiet'],
    failureSignals: ['a pawn break in a level, quiet position that costs a mistake’s worth while Stockfish wanted a piece move first'],
  },
  development_discipline: {
    desiredPosition: 'an unforced opening where your own development choices decide the position',
    coachPreferences: ['principled development', 'keep pieces on the board', 'avoid early forcing play', 'openings your real opponents play against you'],
    successSignals: ['minor pieces out and king castled by about move 10', 'no early queen trips or repeated piece moves'],
    failureSignals: ['two or more minor pieces still at home at move 10', 'early queen moves or moving the same piece twice'],
  },
  conversion: {
    desiredPosition: 'a real position from one of your games where you were clearly better',
    coachPreferences: ['defend soundly and keep pieces on', 'look for activity and counterplay', 'no concessions: Stockfish-equal moves only while behind'],
    successSignals: ['the advantage holds or grows', 'trades and simplifications when ahead', 'counterplay neutralised'],
    failureSignals: ['the advantage drops below about +1', 'material given back'],
  },
};

const CONFIDENCE_FACTOR = { none: 0, possible: 0.5, emerging: 0.8, established: 1 };
const DAY = 86_400_000;

/** Enough real evidence to build a game around it. */
export function eligible(s: SkillStatus): boolean {
  return s.weakness.confidence === 'emerging' || s.weakness.confidence === 'established' || (s.weakness.confidence === 'possible' && s.weakness.score >= 1.5);
}

export function priority(s: SkillStatus, now = Date.now()): number {
  if (!eligible(s)) return 0;
  let p = s.weakness.score * CONFIDENCE_FACTOR[s.weakness.confidence];
  const last = s.training.recent[0];
  if (last?.verdict === 'demonstrated' && now - last.at < 3 * DAY) p *= 0.5;
  else if (last?.verdict === 'failed') p *= 1.25;
  else if (last?.verdict === 'partial') p *= 1.1;
  // Don't keep serving a lesson that the games mostly fail to produce.
  if (s.training.lowEmergence) p *= 0.4;
  return p;
}

/** The skill to train next, or undefined when no skill has enough evidence yet. */
export function chooseSkill(profile: SkillStatus[], canStart: (s: AdaptiveSkill) => boolean, now = Date.now()): SkillStatus | undefined {
  return profile
    .filter((s) => canStart(s.skill))
    .map((s) => ({ s, p: priority(s, now) }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p)[0]?.s;
}

export function planFor(status: SkillStatus, games: StoredGame[], sessions: AdaptiveSession[], color?: Color): AdaptivePlan | undefined {
  const skill = status.skill;
  const basis: AdaptivePlan['basis'] = eligible(status) ? 'history' : 'practice';
  const n = status.weakness.games;
  const ex = status.weakness.examples[0];
  const exGame = ex && games.find((g) => g.id === ex.gameId);
  const seen = n >= 1 ? `in ${n % 1 ? n.toFixed(1) : n} of your games` : '';
  let start: AdaptivePlan['start'] = { fen: START_FEN, kind: 'standard' };
  let userColor: Color = color ?? exGame?.userColor ?? 'w';
  if (skill === 'conversion') {
    const pos = conversionStart(games, sessions);
    if (!pos) return undefined;
    const again = pos.exposure.prior ? ` · seen ${pos.exposure.prior}× before (last: ${pos.exposure.verdicts[0]?.replace('_', ' ') ?? 'unfinished'})` : '';
    start = { fen: pos.fen, kind: 'historical', key: pos.key, gameId: pos.game.id, ply: pos.ply, label: pos.label + again, exposure: pos.exposure };
    userColor = pos.game.userColor;
  }
  const reason =
    basis === 'practice'
      ? `Practice game: there isn't enough evidence in your real games to say ${SKILL_LABEL[skill].toLowerCase()} is a weakness.`
      : {
          positional_patience: `Quiet, level middlegames have gone wrong for you ${seen}: committal pawn moves or released tension before your pieces were ready.`,
          development_discipline: `Your openings have cost you ${seen}: pieces left at home, early queen moves or the same piece moved twice.`,
          conversion: `You have let good positions slip ${seen}.`,
        }[skill];
  return { skill, basis, reason, ...TEMPLATE[skill], evidence: status.weakness.examples, userColor, start };
}

// ------------------------------------------------------------ start positions & exposure
//
// Historical games are seed material, not the curriculum: patience and development always
// start from move 1 (fresh games); only conversion uses exact positions from your games, and
// those are rationed. Exposure of an exact position is tracked separately from skill exposure.
// Later, an "analogous position" provider can add StartCandidates without touching pickStart.

export interface StartCandidate {
  fen: string;
  key: string;
  game: StoredGame;
  ply: number;
  label: string;
  /** Higher is better before exposure is considered (e.g. shortly before a real slip). */
  weight: number;
}

/** Exact-position identity: board, side to move, castling, en passant (no move counters). */
export const positionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

/** How often this exact start position was used in earlier sessions, and how they went. */
export function positionExposure(key: string, sessions: AdaptiveSession[]): PositionExposure {
  const used = sessions
    .filter((s) => (s.plan.start.key ?? positionKey(s.plan.start.fen)) === key && s.plan.start.kind !== 'standard' && s.plan.start.fen !== START_FEN && s.status !== 'abandoned')
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
  return { prior: used.length, lastAt: used[0] ? (used[0].finishedAt ?? used[0].createdAt) : undefined, verdicts: used.flatMap((s) => (s.result ? [s.result.verdict] : [])) };
}

/**
 * Real positions from your games where you were clearly — but not trivially — better, with you
 * to move and nothing en prise. One per stretch of a game.
 */
export function historicalConversionStarts(games: StoredGame[]): StartCandidate[] {
  const out: StartCandidate[] = [];
  for (const g of games) {
    if (g.status !== 'analyzed' || !isRealGame(g) || !g.analysis) continue;
    const slipped = gameEvidence(g, 'conversion').examples.map((e) => e.ply);
    const moves = g.analysis.moves;
    for (let i = 1; i < g.plies.length; i++) {
      const p = g.plies[i];
      const prev = g.plies[i - 1];
      const m = moves[i];
      const pm = moves[i - 1];
      if (!m || !pm || p.color !== g.userColor || p.moveNumber < 12) continue;
      // Stable: you were already this much better before the opponent's last move, and that move wasn't a capture.
      if (m.cpBefore < 200 || m.cpBefore > 500 || -pm.cpBefore < 200 || prev.captured) continue;
      if (new Chess(p.fenBefore).inCheck()) continue;
      const beforeSlip = slipped.some((s) => s >= p.ply && s - p.ply <= 12);
      out.push({
        fen: p.fenBefore,
        key: positionKey(p.fenBefore),
        game: g,
        ply: p.ply - 1,
        label: `From your game ${gameLabel(g)}, before ${moveLabel(p)} — you were ${formatCp(m.cpBefore)}`,
        weight: (beforeSlip ? 10 : 0) + gamePlayedAt(g) / 1e13,
      });
      i += 5;
    }
  }
  return out;
}

/**
 * Choose a start position, rationing exact repeats: positions you already handled well are
 * retired; positions seen before rank below every fresh one (reused only for remediation,
 * i.e. when nothing fresh is left).
 */
export function pickStart(cands: StartCandidate[], sessions: AdaptiveSession[]): (StartCandidate & { exposure: PositionExposure }) | undefined {
  return cands
    .map((c) => ({ ...c, exposure: positionExposure(c.key, sessions) }))
    .filter((c) => !c.exposure.verdicts.includes('demonstrated'))
    .sort((a, b) => a.exposure.prior - b.exposure.prior || (a.exposure.lastAt ?? 0) - (b.exposure.lastAt ?? 0) || b.weight - a.weight)[0];
}

export function conversionStart(games: StoredGame[], sessions: AdaptiveSession[]) {
  return pickStart(historicalConversionStarts(games), sessions);
}

/** Coach moves already played from these positions in recent sessions (avoided, so games stay fresh). */
export function recentCoachMoves(sessions: AdaptiveSession[], userColor: Color, lastN = 3, maxPly = 16): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const recent = sessions
    .filter((s) => s.plan.userColor === userColor && s.plan.start.fen === START_FEN && s.status !== 'abandoned')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, lastN);
  for (const s of recent) {
    const c = new Chess(START_FEN);
    for (const uci of s.moves.slice(0, maxPly)) {
      if (c.turn() !== userColor) {
        const k = bookKey(c.fen());
        if (!out.has(k)) out.set(k, new Set());
        out.get(k)!.add(uci);
      }
      try {
        c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
      } catch {
        break;
      }
    }
  }
  return out;
}

/** Moves your real opponents chose in a position (as the side you'll face), to shape the opening. */
export function openingBook(games: StoredGame[], userColor: Color): Map<string, Set<string>> {
  const book = new Map<string, Set<string>>();
  for (const g of games) {
    if (!isRealGame(g) || g.userColor !== userColor) continue;
    for (const p of g.plies.slice(0, 24)) {
      if (p.color === userColor) continue;
      const key = bookKey(p.fenBefore);
      if (!book.has(key)) book.set(key, new Set());
      book.get(key)!.add(p.uci);
    }
  }
  return book;
}

export const bookKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
