// Explore mode's single line of moves: numbering, and what happens when you play a move part-way.
import { Chess } from 'chess.js';

export interface ExploreMove {
  uci: string;
  san: string;
  fen: string;
  from: string;
  to: string;
}

/** "25...Qa5", "26.Qh4", "Qxa3": move numbers from the starting FEN, black's first move gets "...". */
export function lineLabels(startFen: string, moves: { san: string }[]): string[] {
  const parts = startFen.split(' ');
  let white = parts[1] !== 'b';
  let n = Number(parts[5]) || 1;
  return moves.map((m, i) => {
    const label = white ? `${n}.${m.san}` : i === 0 ? `${n}...${m.san}` : m.san;
    if (!white) n++;
    white = !white;
    return label;
  });
}

/**
 * Play a move at `cursor` (the number of moves currently shown). If it's the move already next in
 * the line, step forward and keep the rest; otherwise the rest of the line is replaced.
 */
export function playInLine(line: ExploreMove[], cursor: number, move: ExploreMove): { line: ExploreMove[]; cursor: number } {
  if (line[cursor]?.uci === move.uci) return { line, cursor: cursor + 1 };
  return { line: [...line.slice(0, cursor), move], cursor: cursor + 1 };
}

/** SAN for a UCI move in a position ('' if it isn't legal there). */
export function sanOf(fen: string, uci: string): string {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return '';
  }
}

/** The label a move would get if played from `fen` ("26.Qh4" / "25...Qa5"). */
export function moveLabelAt(fen: string, san: string): string {
  return lineLabels(fen, [{ san }])[0];
}
