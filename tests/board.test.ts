import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { parsePgn } from '../src/chess/pgn';
import { SAMPLE_PGN } from '../src/fixtures/sampleGame';
import {
  attackedEnemyPieces,
  hasCastled,
  isLegal,
  isLoose,
  kingInCenter,
  materialAfterLine,
  materialBalance,
  playLine,
  undevelopedMinors,
  exchangeGain,
} from '../src/chess/board';

describe('board state reconstruction', () => {
  const g = parsePgn(SAMPLE_PGN);

  it('every ply links fenBefore -> fenAfter consistently with a replay', () => {
    const c = new Chess();
    for (const p of g.plies) {
      expect(p.fenBefore).toBe(c.fen());
      c.move(p.san);
      expect(p.fenAfter).toBe(c.fen());
    }
  });

  it('positions match what a player would see at a selected move', () => {
    // After 11.Nb5 the knight is on b5 and c3 is empty.
    const c = new Chess(g.plies[20].fenAfter);
    expect(c.get('b5')).toEqual({ type: 'n', color: 'w' });
    expect(c.get('c3')).toBeUndefined();
    // After 12.Nc3 it is back.
    expect(new Chess(g.plies[22].fenAfter).get('c3')).toEqual({ type: 'n', color: 'w' });
  });

  it('computes material balance from either side', () => {
    expect(materialBalance(g.plies[0].fenBefore, 'w')).toBe(0);
    // After 5...Bxf3 Black is up a knight for the moment.
    expect(materialBalance(g.plies[9].fenAfter, 'b')).toBe(3);
    expect(materialBalance(g.plies[10].fenAfter, 'w')).toBe(0);
  });

  it('knows about development, castling and king position', () => {
    expect(undevelopedMinors(g.plies[0].fenBefore, 'w')).toHaveLength(4);
    expect(undevelopedMinors(g.plies[18].fenAfter, 'w')).toHaveLength(0);
    expect(hasCastled(g.plies[6].fenAfter, 'w')).toBe(true);
    expect(kingInCenter(g.plies[28].fenBefore, 'b')).toBe(true);
  });

  it('detects attacks and loose pieces', () => {
    // 11.Nb5 attacks the rook on a7 and the pawn on c7.
    const targets = attackedEnemyPieces(g.plies[20].fenAfter, 'b5').map((t) => t.square).sort();
    expect(targets).toEqual(['a7', 'c7']);
    // Before 17.Bc4, the bishop on d6 is attacked by the e5 pawn: loose.
    expect(isLoose(g.plies[32].fenBefore, 'd6')).toBe(true);
    expect(isLegal(g.plies[24].fenBefore, 'c4e2')).toBe(true);
  });

  it('measures material after a line, waiting for exchanges to settle', () => {
    const fen = g.plies[32].fenBefore; // White to move, exd6 wins a piece
    expect(materialAfterLine(fen, ['e5d6', 'c8d6'], 'w')).toBe(materialBalance(fen, 'w') + 2);
    expect(playLine(fen, ['e5d6', 'c8d6']).map((f) => f.san)).toEqual(['exd6', 'Nxd6']);
  });
});

describe('exchangeGain (static exchange on one square)', () => {
  it('an undefended piece is won outright', () => {
    expect(exchangeGain('6k1/8/8/3n4/8/8/8/3R2K1 w - - 0 1', 'd5', 'w')).toBe(3);
  });
  it('a defended piece attacked by an equal one is only a trade', () => {
    expect(exchangeGain('6k1/8/4p3/3n4/8/2N5/8/6K1 w - - 0 1', 'd5', 'w')).toBe(0);
  });
  it('two attackers against one defender still lose if the first attacker is worth more (maladly, b5 before 18...a5)', () => {
    // Nxb5 axb5 Qxb5: a knight for two pawns, so b5 is safe.
    expect(exchangeGain('2r2rk1/2qnbppp/p3p3/1p1pPn2/3P4/P1N2N1P/1P2QPP1/R1BR2K1 b - - 0 18', 'b5', 'w')).toBeLessThanOrEqual(0);
    // After 18...a5 the pawn has no defender: free.
    expect(exchangeGain('2r2rk1/2qnbppp/4p3/pp1pPn2/3P4/P1N2N1P/1P2QPP1/R1BR2K1 w - - 0 19', 'b5', 'w')).toBe(1);
  });
  it('a rook behind a rook (a battery) counts', () => {
    // Rd2 and Rd1 against a knight on d5 defended once by the e6 pawn: Rxd5 exd5 Rxd5 loses the exchange — not worth it.
    expect(exchangeGain('6k1/8/4p3/3n4/8/8/3R4/3R2K1 w - - 0 1', 'd5', 'w')).toBe(0);
    // Undefended: the front rook just takes.
    expect(exchangeGain('6k1/8/8/3n4/8/8/3R4/3R2K1 w - - 0 1', 'd5', 'w')).toBe(3);
  });
});
