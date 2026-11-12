import type { PositionEval } from '../domain/types';

export interface AnalyseOptions {
  depth: number;
  multiPv: number;
}

/** For live analysis: cancel a search, and see its lines as they deepen. */
export interface LiveOptions {
  signal?: AbortSignal;
  onUpdate?: (partial: PositionEval) => void;
}

/** Anything that can evaluate a FEN: browser Web Worker, Node child process, or a test stub. */
export interface Engine {
  readonly name: string;
  analyse(fen: string, opts: AnalyseOptions): Promise<PositionEval>;
  dispose(): void;
}
