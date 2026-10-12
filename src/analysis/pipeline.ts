// Orchestrates: engine facts -> findings -> teaching moments -> report -> drills.
import type { Drill, PositionEval, StoredGame } from '../domain/types';
import type { Engine } from '../engine/types';
import { analyzeWithEngine, buildMoveEvals } from './analyzeGame';
import { detectFindings } from './detectors';
import { buildContexts } from './context';
import { buildMoments, type PriorGameFindings } from './moments';
import { buildReport } from '../coach/report';
import { generateDrills } from '../drills/generate';
import { moveLabel } from '../chess/pgn';
import { COLOR_NAME } from '../chess/board';

/** Chronological key: PGN date when available, import time otherwise. */
export function gamePlayedAt(g: Pick<StoredGame, 'headers' | 'importedAt'>): number {
  const d = g.headers.date?.replace(/\./g, '-');
  const t = d ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? t + (g.importedAt % 86_400_000) : g.importedAt;
}

export function gameLabel(g: StoredGame): string {
  return `vs ${g.opponentName}${g.headers.date ? ` (${g.headers.date})` : ''}`;
}

/** Analyzed games played before `game`, as coaching history. */
export function priorGames(game: StoredGame, all: StoredGame[]): PriorGameFindings[] {
  const at = gamePlayedAt(game);
  return all
    .filter((g) => g.id !== game.id && g.status === 'analyzed' && gamePlayedAt(g) < at)
    .map((g) => ({ gameId: g.id, label: gameLabel(g), playedAt: gamePlayedAt(g), findings: g.findings }));
}

/** Deterministic coaching from stored engine output (no engine needed). */
export function coachFromPositions(game: StoredGame, positions: PositionEval[], prior: PriorGameFindings[]): { game: StoredGame; drills: Drill[] } {
  const moves = buildMoveEvals(game.plies, positions);
  const contexts = buildContexts(game.plies, moves, game.userColor);
  const findings = detectFindings(
    { plies: game.plies, evals: moves, positions, userColor: game.userColor, result: game.headers.result, contexts },
    game.headers.timeControl,
  );
  const moments = buildMoments({ gameId: game.id, plies: game.plies, evals: moves, positions, findings, userColor: game.userColor, prior });
  const report = buildReport({ plies: game.plies, findings, userColor: game.userColor, prior, contexts });
  const drills = generateDrills(game.id, moments);
  return {
    game: {
      ...game,
      status: 'analyzed',
      error: undefined,
      analysis: {
        depth: positions[0]?.depth ?? 0,
        engine: game.analysis?.engine ?? 'Stockfish',
        analyzedAt: Date.now(),
        positions,
        moves,
      },
      findings,
      moments,
      report,
      drillIds: drills.map((d) => d.id),
      completedMomentIds: game.completedMomentIds.filter((id) => moments.some((m) => m.id === id)),
    },
    drills,
  };
}

export async function analyzeGame(
  game: StoredGame,
  engine: Engine,
  opts: { depth: number; prior: PriorGameFindings[]; onProgress?: (done: number, total: number) => void },
): Promise<{ game: StoredGame; drills: Drill[] }> {
  const { positions } = await analyzeWithEngine(game.plies, engine, { depth: opts.depth, onProgress: opts.onProgress });
  const res = coachFromPositions({ ...game, analysis: game.analysis ?? { depth: opts.depth, engine: engine.name, analyzedAt: 0, positions: [], moves: [] } }, positions, opts.prior);
  res.game.analysis!.engine = engine.name;
  return res;
}

export function describePly(game: StoredGame, ply: number): string {
  const p = game.plies[ply - 1];
  return p ? `${moveLabel(p)} (${COLOR_NAME[p.color]})` : '';
}
