// Orchestrates: engine facts -> findings -> teaching moments -> report -> drills.
import type { Drill, Finding, PieceType, PlyRecord, PositionEval, StoredGame } from '../domain/types';
import type { Engine } from '../engine/types';
import { analyzeWithEngine, buildMoveEvals } from './analyzeGame';
import { detectFindings } from './detectors';
import { buildContexts } from './context';
import { explainMove } from './explain';
import type { MoveExplanation } from '../domain/types';
import { buildMoments, isStateFinding, type PriorGameFindings } from './moments';
import { buildReport } from '../coach/report';
import { endingNote } from '../coach/ending';
import { resultFor, userOutcome } from '../chess/outcome';
import { generateDrills } from '../drills/generate';
import { moveLabel } from '../chess/pgn';
import { COLOR_NAME, PIECE_NAME, playLine } from '../chess/board';
import { PATTERN_PHRASE, detectPattern, type PatternHit } from './patterns';
import { verdictOf } from './engineReview';

/** Chronological key: PGN date when available, import time otherwise. */
export function gamePlayedAt(g: Pick<StoredGame, 'headers' | 'importedAt'>): number {
  const d = g.headers.date?.replace(/\./g, '-');
  const t = d ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? t + (g.importedAt % 86_400_000) : g.importedAt;
}

export function gameLabel(g: StoredGame): string {
  return `vs ${g.opponentName}${g.headers.date ? ` (${g.headers.date})` : ''}`;
}

/** The pattern tag of each of the player's mistakes and blunders (empty when none applies). */
export function gamePatterns(game: Pick<StoredGame, 'plies' | 'userColor' | 'findings' | 'analysis'>): NonNullable<StoredGame['patterns']> {
  const out: NonNullable<StoredGame['patterns']> = {};
  const a = game.analysis;
  if (!a) return out;
  a.moves.forEach((e, i) => {
    const v = verdictOf(e);
    const p = game.plies[i];
    // Every move the coach teaches gets its mechanism, even when the position was already lost and
    // the verdict is milder (allowing mate from -5 is still a back-rank lesson).
    const taught = game.findings.some((f) => f.ply === p.ply && f.kind === 'weakness' && f.severity >= 2);
    if (e.color !== game.userColor || (v !== 'mistake' && v !== 'blunder' && !taught)) return;
    const cats = game.findings.filter((f) => f.ply === p.ply).map((f) => f.category as string);
    let hit = detectPattern(p.fenBefore, p.uci, a.positions[i + 1]?.lines[0]?.pv ?? [], a.positions[i]?.lines[0]?.pv ?? [], cats);
    if (hit?.tag === 'hanging_piece' && hit.side === 'better') hit = unfinishedTrade(game.plies, i, a.positions[i]?.lines[0]?.pv[0]) ?? hit;
    // The reply moves before the one the tactic is about, so the reveal starts from the first reply.
    // While the line still follows the game, a move of yours in it that isn't what you played is
    // Stockfish's sample, and is said so (once the opponent's moves differ, it's all a different line).
    let onGame = true;
    const lead =
      hit && hit.side === 'refutation' && hit.at > 1
        ? playLine(p.fenAfter, a.positions[i + 1]?.lines[0]?.pv ?? [], hit.at - 1).map((f, k) => {
            const actual = game.plies[i + 1 + k];
            const sample = onGame && k % 2 === 1 && !!actual && actual.san !== f.san;
            if (!actual || actual.san !== f.san) onGame = false;
            return sample ? `${f.san} (a sample move — you played ${actual.san})` : f.san;
          })
        : [];
    if (hit) out[p.ply] = { tag: hit.tag, side: hit.side, evidence: hit.evidence, ...(hit.hanging ? { hanging: hit.hanging } : {}), ...(lead.length ? { lead } : {}) };
  });
  return out;
}

/**
 * The free piece you didn't take had just captured one of yours (in the last few moves, and hasn't
 * moved since): not a gift — a trade you left unfinished.
 */
function unfinishedTrade(plies: PlyRecord[], i: number, bestUci: string | undefined): PatternHit | undefined {
  if (!bestUci) return;
  const sqr = bestUci.slice(2, 4);
  const me = plies[i].color;
  // The last move that touched the square decides: an opponent capture landing there, and nothing since.
  for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
    const q = plies[k];
    if (q.from === sqr) return;
    if (q.to !== sqr) continue;
    if (q.color === me || !q.captured) return;
    const best = playLine(plies[i].fenBefore, [bestUci], 1)[0];
    return { tag: 'incomplete_exchange', side: 'better', at: 0, evidence: `${moveLabel(q)} took your ${PIECE_NAME[q.captured as PieceType]}, and ${best?.san ?? bestUci} would have taken back` };
  }
}

/** Findings about a missed chance of your own: a better-line tactic is what they're about. */
const MISSED: string[] = ['tactical_blindness'];

/**
 * Attach the tactic that decided a move to the findings about it, so the takeaway comes from what
 * the board shows (a discovered attack, a fork…) rather than from the generic category text.
 * A plain hanging piece isn't a named tactic: it only records how the piece was lost.
 */
export function annotatePatterns(findings: Finding[], patterns: NonNullable<StoredGame['patterns']>, plies: PlyRecord[]) {
  for (const f of findings) {
    const hit = patterns[f.ply];
    if (f.kind !== 'weakness' || !hit || isStateFinding(f)) continue;
    if ((hit.tag === 'hanging_piece' || hit.tag === 'threat_ignored') && hit.side === 'refutation') {
      // Allowing mate is about the checks, not about the pawn the first check happens to take.
      if (hit.hanging && !f.facts.mate) f.facts = { ...f.facts, hanging: hit.hanging };
      continue;
    }
    // A free piece you didn't take is a named chance like any other (below: missed wins only).
    // The opponent's tactic explains any mistake on that move except a missed win of your own;
    // a tactic in the better line only explains a missed win.
    if (hit.side === 'refutation' ? MISSED.includes(f.category) : !MISSED.includes(f.category)) continue;
    const p = plies[f.ply - 1];
    f.facts = { ...f.facts, pattern: hit.tag, patternSide: hit.side, patternEvidence: hit.evidence, ...(hit.lead ? { patternLead: hit.lead } : {}) };
    f.evidence = `${moveLabel(p)} ${PATTERN_PHRASE[hit.tag][hit.side]}: ${hit.lead ? `after ${hit.lead.join(' ')}, ` : ''}${hit.evidence}.`;
  }
}

/** Games from real play. Adaptive Coach games record training results, never real-game weaknesses. */
export const isRealGame = (g: Pick<StoredGame, 'adaptive'>) => !g.adaptive;

/**
 * Real games still waiting for analysis, oldest first. 'analyzing' counts too unless it is
 * running right now (a reload interrupted it).
 */
export function waitingForAnalysis(games: StoredGame[], isRunning: (id: string) => boolean = () => false): StoredGame[] {
  return games
    .filter((g) => isRealGame(g) && (g.status === 'imported' || (g.status === 'analyzing' && !isRunning(g.id))))
    .sort((a, b) => gamePlayedAt(a) - gamePlayedAt(b));
}

/** Analyzed games played before `game`, as coaching history. */
export function priorGames(game: StoredGame, all: StoredGame[]): PriorGameFindings[] {
  const at = gamePlayedAt(game);
  return all
    .filter((g) => g.id !== game.id && g.status === 'analyzed' && isRealGame(g) && gamePlayedAt(g) < at)
    .map((g) => ({ gameId: g.id, label: gameLabel(g), playedAt: gamePlayedAt(g), findings: g.findings }));
}

/** Deterministic coaching from stored engine output (no engine needed). */
export function coachFromPositions(game: StoredGame, positions: PositionEval[], prior: PriorGameFindings[]): { game: StoredGame; drills: Drill[] } {
  const moves = buildMoveEvals(game.plies, positions);
  const contexts = buildContexts(game.plies, moves, game.userColor);
  const findings = detectFindings(
    { plies: game.plies, evals: moves, positions, userColor: game.userColor, result: resultFor(userOutcome(game), game.userColor, game.headers.result), contexts },
    game.headers.timeControl,
  );
  // The tactic behind each mistake, from the board. When a specific one decided it (a discovered
  // attack, a fork…), the finding says so instead of the generic "left unprotected".
  const patterns = gamePatterns({ ...game, findings, analysis: { positions, moves } as StoredGame['analysis'] });
  annotatePatterns(findings, patterns, game.plies);
  // Three-part explanations for every credible mistake / missed chance of the user.
  const explanations: Record<number, MoveExplanation> = {};
  for (const f of findings) {
    if (f.kind !== 'weakness' || f.ply <= 0 || f.confidence === 'low' || explanations[f.ply]) continue;
    // Findings about the state of the game (development by move 10, a passive piece, the clock)
    // aren't about one move, so they don't get a move explanation.
    if (isStateFinding(f)) continue;
    if (game.plies[f.ply - 1]?.color !== game.userColor) continue;
    const betterPly = Number(f.facts.worsePly ?? f.ply);
    explanations[f.ply] = explainMove({ plies: game.plies, evals: moves, positions, contexts, ply: f.ply, betterPly, findings });
  }
  const moments = buildMoments({ gameId: game.id, plies: game.plies, evals: moves, positions, findings, userColor: game.userColor, prior, explanations });
  const report = buildReport({ plies: game.plies, findings, userColor: game.userColor, prior, contexts, ending: endingNote(game, positions), won: userOutcome(game) === 'win', lost: userOutcome(game) === 'loss', evals: moves, termination: game.headers.termination });
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
        deepPositions: game.analysis?.deepPositions?.filter((i) => (positions[i]?.depth ?? 0) >= DEEP_DEPTH),
      },
      findings,
      explanations,
      moments,
      report,
      patterns,
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
  const base = { ...game, analysis: game.analysis ?? { depth: opts.depth, engine: engine.name, analyzedAt: 0, positions: [], moves: [] } };
  const res = await deepenCritical(base, positions, engine, opts.prior, opts.onProgress);
  res.game.analysis!.engine = engine.name;
  return res;
}

/** Critical teaching moments get a deeper look; ordinary moves keep the fast analysis. */
export const DEEP_DEPTH = 18;

/**
 * Re-analyse the positions around each teaching moment (before the move, and after
 * it) at depth 18 with three candidate moves, then coach again from those better
 * evaluations. Only a handful of positions, so imports stay fast.
 */
export async function deepenCritical(
  game: StoredGame,
  positions: PositionEval[],
  engine: Engine,
  prior: PriorGameFindings[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ game: StoredGame; drills: Drill[] }> {
  // Before any lesson is shown, the move it is about is re-checked at DEEP_DEPTH (both sides of it),
  // so the near-best rule ("best or within 0.3 of best: no lesson") is judged on the deep numbers.
  // Moments can change after re-scoring, so new ones get a second round.
  let result = coachFromPositions(game, positions, prior);
  const deep = [...positions];
  let done = 0;
  for (let round = 0; round < 2; round++) {
    const wanted = new Set<number>();
    for (const m of result.game.moments) {
      wanted.add(m.betterPly - 1); // before the decision
      wanted.add(m.ply - 1); // before the move played
      wanted.add(m.ply); // after the move played
      for (const f of result.game.findings) {
        if (f.ply !== m.ply || f.facts.worsePly == null) continue;
        const w = Number(f.facts.worsePly);
        wanted.add(w - 1);
        wanted.add(w);
      }
    }
    const todo = [...wanted].filter((i) => deep[i] && !deep[i].terminal && deep[i].depth < DEEP_DEPTH).sort((a, b) => a - b);
    if (!todo.length) break;
    const total = positions.length + done + todo.length;
    for (const i of todo) {
      deep[i] = await engine.analyse(deep[i].fen, { depth: DEEP_DEPTH, multiPv: 3 });
      onProgress?.(positions.length + ++done, total);
    }
    const deepPositions = deep.map((p, i) => (p.depth >= DEEP_DEPTH ? i : -1)).filter((i) => i >= 0);
    result = coachFromPositions({ ...game, analysis: { ...(game.analysis ?? { depth: 0, engine: engine.name, analyzedAt: 0, positions: [], moves: [] }), deepPositions } }, deep, prior);
  }
  return result;
}

export function describePly(game: StoredGame, ply: number): string {
  const p = game.plies[ply - 1];
  return p ? `${moveLabel(p)} (${COLOR_NAME[p.color]})` : '';
}
