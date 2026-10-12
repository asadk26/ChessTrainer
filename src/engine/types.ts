import type { PositionEval } from '../domain/types';

export interface AnalyseOptions {
  depth: number;
  multiPv: number;
}

/** Anything that can evaluate a FEN: browser Web Worker, Node child process, or a test stub. */
export interface Engine {
  readonly name: string;
  analyse(fen: string, opts: AnalyseOptions): Promise<PositionEval>;
  dispose(): void;
}
