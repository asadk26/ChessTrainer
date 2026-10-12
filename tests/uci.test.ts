import { describe, expect, it } from 'vitest';
import { parseInfoLine, UciEngine } from '../src/engine/uci';

describe('UCI handling', () => {
  it('parses info lines with multipv, cp and mate scores', () => {
    expect(parseInfoLine('info depth 14 seldepth 20 multipv 2 score cp 75 nodes 1 nps 1 pv d2d4 b8d7 h2h3')).toEqual({
      depth: 14,
      multipv: 2,
      score: { type: 'cp', value: 75 },
      pv: ['d2d4', 'b8d7', 'h2h3'],
    });
    expect(parseInfoLine('info depth 9 multipv 1 score mate -3 pv e1e2')?.score).toEqual({ type: 'mate', value: -3 });
    expect(parseInfoLine('info depth 9 score cp 20 lowerbound pv e2e4')).toBeUndefined();
    expect(parseInfoLine('info string NNUE evaluation enabled')).toBeUndefined();
  });

  it('drives a fake engine and collects the deepest line per multipv', async () => {
    const sent: string[] = [];
    let engine!: UciEngine;
    engine = new UciEngine('fake', (cmd) => {
      sent.push(cmd);
      queueMicrotask(() => {
        if (cmd === 'uci') engine.receive('id name Fake\nuciok');
        else if (cmd === 'isready') engine.receive('readyok');
        else if (cmd.startsWith('go')) {
          engine.receive('info depth 1 multipv 1 score cp 10 pv e2e4\ninfo depth 1 multipv 2 score cp 5 pv d2d4');
          engine.receive('info depth 2 multipv 1 score cp 30 pv e2e4 e7e5\ninfo depth 2 multipv 2 score cp 12 pv d2d4 d7d5');
          engine.receive('bestmove e2e4');
        }
      });
    });
    const res = await engine.analyse('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 2, multiPv: 2 });
    expect(res.lines.map((l) => l.pv[0])).toEqual(['e2e4', 'd2d4']);
    expect(res.lines[0].score).toEqual({ type: 'cp', value: 30 });
    expect(sent).toContain('setoption name MultiPV value 2');
    expect(sent).toContain('go depth 2');
  });

  it('short-circuits game-over positions', async () => {
    const engine = new UciEngine('never', () => {});
    const mate = await engine.analyse('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', { depth: 10, multiPv: 1 });
    expect(mate.terminal).toBe('checkmate');
  });
});
