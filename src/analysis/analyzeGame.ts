import type { MoveEval, PlyRecord, PositionEval } from '../domain/types';
import { lineToSan, materialAfterLine, materialBalance } from '../chess/board';
import type { Engine } from '../engine/types';
import { MATE_CP, evalChange, practicalDrop } from './evaluation';

export interface EngineAnalysisResult {
  positions: PositionEval[];
  moves: MoveEval[];
}

/** Run the engine over every position of the game (start position + after each ply). */
export async function evaluatePositions(
  plies: PlyRecord[],
  engine: Engine,
  opts: { depth: number; multiPv?: number; onProgress?: (done: number, total: number) => void },
): Promise<PositionEval[]> {
  const fens = [plies[0].fenBefore, ...plies.map((p) => p.fenAfter)];
  const out: PositionEval[] = [];
  for (let i = 0; i < fens.length; i++) {
    out.push(await engine.analyse(fens[i], { depth: opts.depth, multiPv: opts.multiPv ?? 3 }));
    opts.onProgress?.(i + 1, fens.length);
  }
  return out;
}

/** Turn raw position evaluations into per-move facts (mover's point of view). */
export function buildMoveEvals(plies: PlyRecord[], positions: PositionEval[]): MoveEval[] {
  return plies.map((p, i) => {
    const before = positions[i];
    const after = positions[i + 1];
    const change = evalChange(before, after);
    const best = before.lines[0];
    const reply = after.lines[0];
    const bestUci = best?.pv[0];
    const bestLineSan = best ? lineToSan(p.fenBefore, best.pv, 6) : [];
    const replyLineUci = reply ? reply.pv.slice(0, 8) : [];
    const replyLineSan = reply ? lineToSan(p.fenAfter, reply.pv, 6) : [];
    const materialBefore = materialBalance(p.fenBefore, p.color);
    const materialAfterReply = reply ? materialAfterLine(p.fenAfter, reply.pv, p.color) : materialBalance(p.fenAfter, p.color);
    return {
      ply: p.ply,
      color: p.color,
      san: p.san,
      uci: p.uci,
      ...change,
      bestUci,
      bestSan: bestLineSan[0],
      bestLineSan,
      replyLineSan,
      replyLineUci,
      isBest: !!bestUci && bestUci === p.uci,
      materialBefore,
      materialAfterReply,
      practicalDrop: practicalDrop({ ...change, materialBefore, materialAfterReply }),
      materialAfterBest: best ? materialAfterLine(p.fenBefore, best.pv, p.color) : materialBefore,
      mateThreatAgainst: change.cpAfter <= -(MATE_CP - 100),
    } satisfies MoveEval;
  });
}

export async function analyzeWithEngine(
  plies: PlyRecord[],
  engine: Engine,
  opts: { depth: number; onProgress?: (done: number, total: number) => void },
): Promise<EngineAnalysisResult> {
  const positions = await evaluatePositions(plies, engine, opts);
  return { positions, moves: buildMoveEvals(plies, positions) };
}
