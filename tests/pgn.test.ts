import { describe, expect, it } from 'vitest';
import { normalizePgn, parsePgn, PgnError, moveLabel } from '../src/chess/pgn';
import { SAMPLE_PGN } from '../src/fixtures/sampleGame';

describe('PGN parsing', () => {
  it('parses the sample game including smart-quoted headers', () => {
    const g = parsePgn(SAMPLE_PGN);
    expect(g.headers.white).toBe('chunkmonkey420');
    expect(g.headers.black).toBe('mirokvp');
    expect(g.headers.whiteElo).toBe(865);
    expect(g.headers.blackElo).toBe(772);
    expect(g.headers.result).toBe('1-0');
    expect(g.headers.date).toBe('2026.10.12');
    expect(g.plies).toHaveLength(33);
  });

  it('records SAN, UCI, colors and move numbers per ply', () => {
    const g = parsePgn(SAMPLE_PGN);
    const nb5 = g.plies[20];
    expect(nb5).toMatchObject({ ply: 21, moveNumber: 11, color: 'w', san: 'Nb5', uci: 'c3b5', piece: 'n' });
    expect(moveLabel(nb5)).toBe('11.Nb5');
    expect(moveLabel(g.plies[21])).toBe('11...Rb7');
    const castle = g.plies[6];
    expect(castle.san).toBe('O-O');
    expect(castle.uci).toBe('e1g1');
    expect(g.plies[14]).toMatchObject({ san: 'dxe5', captured: 'p' });
    expect(g.plies[32].san).toBe('Bc4');
  });

  it('normalises pasted text (smart quotes, 0-0 castling, CRLF)', () => {
    expect(normalizePgn('[White “a”]\r\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. 0-0')).toBe('[White "a"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O');
    const g = parsePgn('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. 0-0 Nf6 *');
    expect(g.plies[6].san).toBe('O-O');
    expect(g.headers.white).toBe('White');
  });

  it('reads %clk comments', () => {
    const g = parsePgn('[White "a"]\n[Black "b"]\n[TimeControl "600"]\n\n1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:55.5]} 2. Nf3 {[%clk 0:09:40]} *');
    expect(g.plies.map((p) => p.clockSeconds)).toEqual([598, 595.5, 580]);
    expect(g.headers.timeControl).toBe('600');
  });

  it('rejects empty or illegal PGNs with a readable error', () => {
    expect(() => parsePgn('   ')).toThrow(PgnError);
    expect(() => parsePgn('1. e4 e5 2. Ke3 Ke6 3. Qxh8')).toThrow(PgnError);
  });
});
