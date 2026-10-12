import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { coachFromPositions } from '../src/analysis/pipeline';
import { describeMove, gerundPhrase } from '../src/analysis/movePurpose';
import { fileStatus, mobility, pawnWeaknesses } from '../src/chess/board';
import type { PositionEval } from '../src/domain/types';
import { fixtureGame, samplePositions, sampleStored, storedFromPgn } from './helpers';

const sample = coachFromPositions(sampleStored(), samplePositions(), []).game;
const winning = (() => {
  const { game, positions } = fixtureGame('winning-game');
  return coachFromPositions(game, positions, []).game;
})();

describe('why the better move is better', () => {
  it('names the concrete purpose of the engine move', () => {
    // 13.Bb5+ (ply 25): Rad1 brings the rook to the open d-file.
    expect(sample.explanations![25].better).toMatch(/Rad1 .*open d-file/);
    // 17.Bc4 (ply 33): exd6 wins the bishop — supported by a short line, not a dump.
    const x = sample.explanations![33];
    expect(x.better).toMatch(/exd6 wins the bishop on d6/);
    expect(x.support).toBeUndefined(); // the capture is the move itself — no line needed
    // 23.Ba7 (ply 45): Rfb1 gives the king an escape square so the checks run out.
    expect(winning.explanations![45].better).toMatch(/escape square on f1/);
    // 12.Nc3 retreat (better move for the 11.Nb5 episode): f4 opens the f-file toward the king.
    expect(sample.explanations![21].better).toMatch(/f4 opens the f-file/);
  });

  it('describes what the played move was going for, from the board only', () => {
    expect(sample.explanations![33].intent).toBe('attacks the loose queen on e6');
    expect(winning.explanations![43].intent).toMatch(/attacks the loose queen on c3/);
    expect(gerundPhrase('attacks the rook and moves your bishop out of danger')).toBe('attacking the rook and moving your bishop out of danger');
  });

  it('distinguishes a true mistake from a missed opportunity', () => {
    expect(sample.explanations![33].kind).toBe('missed_opportunity'); // 17.Bc4: nothing lost, exd6 missed
    expect(winning.explanations![43]).toMatchObject({ kind: 'mistake', problem: expect.stringMatching(/win your bishop/) });
    expect(winning.explanations![45].problem).toMatch(/start checking your king with Qg4\+/);
    expect(winning.explanations![67].problem).toMatch(/given your rook for a knight/); // 34.Rxe5+
  });

  it('is not fooled by a different engine line (browser output for the same game)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { game } = fixtureGame('winning-game');
    const browser = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'winning-game-positions-browser.json'), 'utf8'));
    const g = coachFromPositions(game, browser, []).game;
    expect(g.explanations![45].better).toMatch(/escape square on f1/);
    expect(g.explanations![43].problem).toMatch(/win your bishop/);
  });

  it('omits the reason rather than guessing when the moves do the same thing', () => {
    // 41.Be1 vs Bb4: both just move the bishop out of danger — no distinguishing reason.
    expect(winning.explanations![81].better).toBeUndefined();
  });

  it('feeds the explanation into teaching moments', () => {
    const m = sample.moments.find((x) => x.ply === 33)!;
    expect(m.explanation?.kind).toBe('missed_opportunity');
    expect(m.text.why).toMatch(/exd6 wins the bishop/);
    expect(m.text.intent).toMatch(/attacking the loose queen on e6/);
  });
});

describe('move purposes', () => {
  const start = new Chess().fen();
  it('recognises development and castling', () => {
    expect(describeMove({ fen: start, uci: 'g1f3' })!.purposes[0].id).toBe('develop');
    const c = new Chess();
    for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']) c.move(m);
    expect(describeMove({ fen: c.fen(), uci: 'e1g1' })!.purposes[0].id).toBe('castle');
  });

  it('only claims "takes away a threat" if the threat existed before the played move', () => {
    // From the winning game: Rab1 does not "stop ...Qxd4" — that capture only existed because of 22.Bd4.
    expect(winning.explanations![43].better ?? '').not.toMatch(/takes away/);
  });

  it("doesn't call a losing exchange a trade", () => {
    expect(winning.explanations![43].intent).not.toMatch(/trades/);
  });

  it('has positional helpers', () => {
    const fen = '4k3/8/8/8/8/2P5/2P2P2/4K3 w - - 0 1';
    expect(pawnWeaknesses(fen, 'w')).toEqual({ doubled: ['c3', 'c2'], isolated: ['c3', 'c2', 'f2'] });
    expect(fileStatus(fen, 'd', 'w')).toBe('open');
    expect(fileStatus('4k3/3p4/8/8/8/8/8/4K3 w - - 0 1', 'd', 'w')).toBe('half-open');
    expect(mobility(start, 'c1')).toBe(0);
    expect(mobility(start, 'g1')).toBe(2);
  });
});

describe('positional detectors (conservative)', () => {
  it('flags a recapture that wrecks the pawn structure when a clean one existed', () => {
    const g = storedFromPgn('[White "me"]\n[Black "you"]\n\n1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6 5. Nf3 Bg4 6. h3 Bxf3 7. gxf3 *', 'w');
    const fens = [g.plies[0].fenBefore, ...g.plies.map((p) => p.fenAfter)];
    const positions: PositionEval[] = fens.map((fen, i) => {
      const next = g.plies[i];
      const side = fen.split(' ')[1];
      // Before 7.gxf3 the engine prefers 7.Qxf3; afterwards White is slightly worse off.
      if (i === 12) return { fen, depth: 10, lines: [{ pv: ['d1f3', 'e7e6'], score: { type: 'cp', value: 60 }, depth: 10 }] };
      if (i === 13) return { fen, depth: 10, lines: [{ pv: ['e7e6'], score: { type: 'cp', value: 30 }, depth: 10 }] };
      return { fen, depth: 10, lines: [{ pv: next ? [next.uci] : [], score: { type: 'cp', value: side === 'w' ? 20 : -20 }, depth: 10 }] };
    });
    const { game } = coachFromPositions(g, positions, []);
    const f = game.findings.find((x) => x.category === 'pawn_structure');
    expect(f).toMatchObject({ ply: 13, confidence: 'medium' });
    expect(f!.evidence).toMatch(/doubled pawns on the f-file.*Qxf3/);
  });

  it('stays quiet when the structural damage was the best move anyway (8.gxf3 in the winning game)', () => {
    expect(winning.findings.some((f) => f.category === 'pawn_structure')).toBe(false);
  });
});
