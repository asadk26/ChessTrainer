import { Chess } from 'chess.js';
import type { EngineLine, PositionEval, Score } from '../domain/types';
import type { AnalyseOptions, Engine, LiveOptions } from './types';

/** Parse a UCI "info" line. Returns undefined for lines without a usable PV/score. */
export function parseInfoLine(line: string): (EngineLine & { multipv: number }) | undefined {
  if (!line.startsWith('info ') || !line.includes(' pv ') || !line.includes(' score ')) return undefined;
  if (line.includes(' lowerbound') || line.includes(' upperbound')) return undefined;
  const tokens = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let score: Score | undefined;
  let pv: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth') depth = Number(tokens[++i]);
    else if (t === 'multipv') multipv = Number(tokens[++i]);
    else if (t === 'score') {
      const kind = tokens[++i];
      const value = Number(tokens[++i]);
      if (kind === 'cp') score = { type: 'cp', value };
      else if (kind === 'mate') score = { type: 'mate', value };
    } else if (t === 'pv') {
      pv = tokens.slice(i + 1);
      break;
    }
  }
  if (!score || pv.length === 0) return undefined;
  return { depth, multipv, score, pv };
}

/** Positions that need no engine: checkmate, stalemate, insufficient material. */
export function terminalEval(fen: string): PositionEval | undefined {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { fen, depth: 0, lines: [], terminal: 'checkmate' };
  if (c.isStalemate()) return { fen, depth: 0, lines: [], terminal: 'stalemate' };
  if (c.isInsufficientMaterial()) return { fen, depth: 0, lines: [], terminal: 'draw' };
  return undefined;
}

type Send = (cmd: string) => void;

/**
 * Speaks UCI over any line-based transport. Requests are queued so a single
 * engine instance can be shared safely.
 */
export class UciEngine implements Engine {
  private queue: Promise<unknown> = Promise.resolve();
  private listener: ((line: string) => void) | null = null;
  private ready: Promise<void>;
  private currentMultiPv = -1;

  constructor(
    readonly name: string,
    private send: Send,
    private onDispose: () => void = () => {},
  ) {
    this.ready = this.waitFor('uciok', () => this.send('uci'))
      .then(() => this.waitFor('readyok', () => this.send('isready')))
      .then(() => undefined);
  }

  /** Feed one line of engine output. */
  receive(line: string) {
    for (const l of line.split('\n')) if (l.trim()) this.listener?.(l.trim());
  }

  private waitFor(token: string, start: () => void, onLine?: (l: string) => void): Promise<string> {
    return new Promise((resolve) => {
      this.listener = (l) => {
        onLine?.(l);
        if (l.startsWith(token)) {
          this.listener = null;
          resolve(l);
        }
      };
      start();
    });
  }

  /**
   * Evaluate one position. `live.signal` cancels it: a queued search is skipped and a running one
   * is stopped (it resolves early with what it had, and `aborted: true`). `live.onUpdate` receives
   * the lines so far each time the engine reports, for a display that deepens as it thinks.
   */
  analyse(fen: string, opts: AnalyseOptions, live: LiveOptions = {}): Promise<PositionEval> {
    const term = terminalEval(fen);
    if (term) return Promise.resolve(term);
    const job = this.queue.then(async () => {
      if (live.signal?.aborted) return { fen, depth: 0, lines: [], aborted: true } satisfies PositionEval;
      await this.ready;
      if (this.currentMultiPv !== opts.multiPv) {
        this.send(`setoption name MultiPV value ${opts.multiPv}`);
        this.currentMultiPv = opts.multiPv;
        await this.waitFor('readyok', () => this.send('isready'));
      }
      const lines = new Map<number, EngineLine>();
      const sorted = () => [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      const stop = () => this.send('stop');
      if (live.signal?.aborted) return { fen, depth: 0, lines: [], aborted: true } satisfies PositionEval;
      live.signal?.addEventListener('abort', stop, { once: true });
      try {
        await this.waitFor(
          'bestmove',
          () => {
            this.send(`position fen ${fen}`);
            this.send(`go depth ${opts.depth}`);
          },
          (l) => {
            const info = parseInfoLine(l);
            if (!info) return;
            lines.set(info.multipv, { pv: info.pv, score: info.score, depth: info.depth });
            if (live.onUpdate && !live.signal?.aborted) live.onUpdate({ fen, depth: info.depth, lines: sorted() });
          },
        );
      } finally {
        live.signal?.removeEventListener('abort', stop);
      }
      if (live.signal?.aborted) return { fen, depth: 0, lines: sorted(), aborted: true } satisfies PositionEval;
      return { fen, depth: opts.depth, lines: sorted() } satisfies PositionEval;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  dispose() {
    try {
      this.send('quit');
    } catch {
      /* ignore */
    }
    this.onDispose();
  }
}
