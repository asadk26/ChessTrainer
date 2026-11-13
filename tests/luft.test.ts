// The back-rank lesson needs the luft counterfactual; a counter-threat captured with check is its own lesson.
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { backRankStands, detectPattern, PATTERN_RULE, withLuft } from '../src/analysis/patterns';

const RED8 = '2r1r1k1/p4ppp/2p1p3/2P5/1P1Q1P2/q7/5RPP/R5K1 b - - 1 26'; // JoeYoaGoGo, before 26...Red8
const uci = (fen: string, sans: string[]) => {
  const c = new Chess(fen);
  return sans.map((s) => {
    const m = c.move(s);
    return m.from + m.to + (m.promotion ?? '');
  });
};

describe('luft counterfactual', () => {
  it('gives the king an escape square by pushing the pawn furthest from the centre', () => {
    const after = new Chess(RED8);
    after.move('Red8');
    expect(withLuft(after.fen(), 'b')).toMatch(/^2rr2k1\/p4pp1\/2p1p2p\//);
  });
  it('keeps the back-rank lesson only when luft would have saved the game', () => {
    expect(backRankStands(506, 188)).toBe(true); // Harrison 20...Rdb8: luft halves it and more
    expect(backRankStands(9980, 549)).toBe(true); // a mate that luft stops
    expect(backRankStands(525, 515)).toBe(false); // 26...Red8: the queen goes anyway
    expect(backRankStands(260, 160)).toBe(false); // under 1.5 pawns saved
  });
});

describe('counter-threat captured with check (26...Red8 Qxd8+ Rxd8 Rxa3)', () => {
  it('is the lesson, not a back-rank attack', () => {
    const [played] = uci(RED8, ['Red8']);
    const after = new Chess(RED8);
    after.move('Red8');
    const reply = uci(after.fen(), ['Qxd8+', 'Rxd8', 'Rxa3']);
    const hit = detectPattern(RED8, played, reply, uci(RED8, ['Rcd8']));
    expect(hit?.tag).toBe('capture_with_check');
    expect(hit?.evidence).toMatch(/queen on a3 was attacked; Red8 hit back at the queen on d4, but Qxd8\+ takes it with check/);
    expect(PATTERN_RULE.capture_with_check).toBe('When your piece is attacked and you answer with a counter-threat, check whether they can capture your threat with check.');
  });
});
