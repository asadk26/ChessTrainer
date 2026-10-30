// Line and praise text must describe what the move itself does, on the board as it stands.
import { describe, expect, it } from 'vitest';
import { stepCaption, lineSteps } from '../src/analysis/lineSteps';
import { coachFromPositions } from '../src/analysis/pipeline';
import { cachedPositions, loadTruth, storedGame } from '../scripts/truth/data';

describe('line step captions', () => {
  it('"takes back" only after a capture on that square', () => {
    // 1...Nh4 (no capture), 2.Qxh4 takes the knight that just stepped there: not a recapture.
    const steps = lineSteps('6k1/5ppp/8/7Q/8/5n2/6PP/6K1 b - - 0 1', ['f3h4', 'h5h4'], 'w', 2);
    expect(steps[1].caption).toMatch(/^Qxh4 takes their knight on h4/);
    expect(steps[1].caption).not.toMatch(/takes back/);
    // A real recapture still says so: 1...Rxd4 2.Rxd4.
    const re = lineSteps('3r2k1/5ppp/8/8/3N4/8/6PP/3R2K1 b - - 0 1', ['d8d4', 'd1d4'], 'w', 2);
    expect(re[1].caption).toMatch(/^Rxd4 takes back on d4/);
  });
  it("doesn't credit a move with a capture that only happens later in the line", () => {
    // 1.Bh4 is quiet; the knight only comes to d4 afterwards (...Nd4 Nxd4).
    const caption = stepCaption('r2qk2r/pppb1pp1/2np1n1p/6B1/2P5/2NP1NP1/PP2PPBP/R2QK2R w KQkq - 0 9', 'g5h4', 'w', undefined, ['g5h4', 'c6d4', 'f3d4', 'a7a6']);
    expect(caption).not.toMatch(/wins the knight on d4/);
  });
});

describe('credit the move that set it up (vs T_Cel)', () => {
  it('26.a4 hit the pinned bishop; 27.axb5 is not "free material" on its own', () => {
    const g = loadTruth().games.find((x) => x.game.includes('T_Cel'))!;
    const game = coachFromPositions(storedGame(g), cachedPositions(g.game)!, []).game;
    const did = game.report!.didWell.map((d) => d.text).join(' ');
    expect(did).toMatch(/26\.a4 attacked the bishop on b5\. It couldn't get away: your rook on b1 pins the bishop on b5 to the queen on b6\. 27\.axb5 won it/);
    expect(did).not.toMatch(/genuinely free material: 27\.axb5/);
    expect(did).not.toMatch(/wins the queen on b6/);
  });
});
