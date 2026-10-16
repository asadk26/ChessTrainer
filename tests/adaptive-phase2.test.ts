import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AdaptiveSession, EngineLine, PositionEval, StoredGame } from '../src/domain/types';
import { COACH_TUNING, STRENGTHS, candidates, naturalness, selectCoachMove } from '../src/adaptive/selectMove';
import { bookKey, pickStart, positionExposure, positionKey, priority, recentCoachMoves, START_FEN, type StartCandidate } from '../src/adaptive/planner';
import { buildSkillProfile } from '../src/adaptive/skills';
import { exportPlaytest, playtestStats, sessionLog } from '../src/adaptive/playtest';
import { materialBalance, materialAfterLine } from '../src/chess/board';

const lines = (fen: string, list: [string, number, string[]?][]): PositionEval => ({
  fen,
  depth: 12,
  lines: list.map(([uci, cp, rest]) => ({ pv: [uci, ...(rest ?? [])], score: { type: 'cp', value: cp }, depth: 12 }) satisfies EngineLine),
});
const after = (pgn: string) => {
  const c = new Chess();
  c.loadPgn(pgn);
  return c.fen();
};

// Black to move in a closed French: ...c4, ...h6, ...a5 are all quiet; ...cxb4 releases tension.
const CLOSED = after('1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Nf3 Qb6 6. Be2 Bd7 7. O-O Nge7 8. Na3 Nf5 9. Nc2 Be7 10. Bd3 O-O 11. Re1 Rfc8 12. Bf4 a6 13. h3 Qc7 14. Qd2 b5 15. b4');

describe('strength: ease-off when comfortably ahead', () => {
  // The coach is +3. 'h7h6' is 0.8 worse than best — outside Steady's normal band, inside its ease-off.
  const p = lines(CLOSED, [
    ['c5b4', 300, ['c3b4']],
    ['h7h6', 220],
    ['a6a5', 120],
  ]);
  it('Steady may stop pressing (keeps the material), Firm may not', () => {
    const steady = candidates(CLOSED, p, { band: 5, strength: 'steady' });
    const firm = candidates(CLOSED, p, { band: COACH_TUNING.strengths.firm.band, strength: 'firm' });
    expect(steady.find((c) => c.uci === 'h7h6')!.allowed).toBe(true);
    expect(firm.find((c) => c.uci === 'h7h6')!.allowed).toBe(false);
  });
  it('never strays more than 1.6 bands from best, and never sheds material, even when eased', () => {
    for (const s of STRENGTHS)
      for (let k = 0; k < 40; k++) {
        const pick = selectCoachMove(CLOSED, p, { band: s.band, strength: s.id, variety: 3 }, { rng: () => (k * 7919) % 100 / 100 })!;
        expect(pick.log.gap).toBeLessThanOrEqual(s.band * COACH_TUNING.easeMaxGapFactor);
      }
  });
  it('patience eases off sooner (keeps the game level), other skills do not', () => {
    const level = lines(CLOSED, [
      ['c5b4', 90, ['c3b4']],
      ['h7h6', 20],
    ]);
    // At +0.9, patience is already easing (towards +0.6); development still measures from best.
    const patience = candidates(CLOSED, level, { band: 5, strength: 'steady' }, { skill: 'positional_patience' })[1];
    const dev = candidates(CLOSED, level, { band: 5, strength: 'steady' }, { skill: 'development_discipline' })[1];
    expect(patience.allowed).toBe(true);
    expect(dev.allowed).toBe(false);
    expect(patience.gap).toBeLessThan(dev.gap);
  });
});

describe('naturalness', () => {
  it('prefers recapturing over an equally good alternative', () => {
    // 1.e4 d5 2.exd5: Black recaptures (Qxd5) vs Nf6 — both fine for Stockfish.
    const fen = after('1. e4 d5 2. exd5');
    expect(naturalness(fen, 'd8d5', { lastMoveTo: 'd5' })).toBeGreaterThan(naturalness(fen, 'g8f6', { lastMoveTo: 'd5' }));
    const pick = selectCoachMove(fen, lines(fen, [['g8f6', -30], ['d8d5', -34]]), { band: 5, strength: 'steady', variety: 0 }, { lastMoveTo: 'd5' })!;
    expect(pick.uci).toBe('d8d5');
    expect(pick.log.reason).toBe('natural');
  });
  it('dislikes early king walks and queen sorties', () => {
    const fen = after('1. e4 e5 2. Nf3');
    expect(naturalness(fen, 'e8e7')).toBeLessThan(0);
    expect(naturalness(fen, 'd8f6')).toBeLessThan(naturalness(fen, 'b8c6'));
  });
});

describe('freshness: same weakness, different game', () => {
  it('avoids repeating its own recent opening moves when an equal alternative exists', () => {
    const fen = after('1. e4');
    const p = lines(fen, [['e7e5', -30], ['c7c5', -32]]);
    const ctx = { avoid: new Set(['e7e5']) };
    expect(selectCoachMove(fen, p, { band: 5, strength: 'steady', variety: 0 }, ctx)!.uci).toBe('c7c5');
    expect(selectCoachMove(fen, p, { band: 5, strength: 'steady', variety: 0 })!.uci).toBe('e7e5');
  });

  it('collects the coach moves of recent fresh-start sessions', () => {
    const s = session({ moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] });
    const m = recentCoachMoves([s], 'w');
    expect(m.get(bookKey(after('1. e4')))!.has('e7e5')).toBe(true);
    expect(m.get(bookKey(after('1. e4 e5 2. Nf3')))!.has('b8c6')).toBe(true);
    expect(m.get(bookKey(START_FEN))).toBeUndefined(); // the user's own move isn't the coach's
  });
});

describe('exact-position exposure', () => {
  const g = { id: 'real' } as StoredGame;
  const fenA = 'r4rk1/pp3ppp/2n5/3p4/3P4/2NB1N2/PP3PPP/R4RK1 w - - 0 15';
  const fenB = 'r4rk1/pp3ppp/2n5/3p4/3P4/2N2N2/PPB2PPP/R4RK1 w - - 0 15';
  const cands: StartCandidate[] = [
    { fen: fenA, key: positionKey(fenA), game: g, ply: 20, label: 'A', weight: 10 },
    { fen: fenB, key: positionKey(fenB), game: g, ply: 40, label: 'B', weight: 1 },
  ];
  const used = (fen: string, verdict: 'demonstrated' | 'failed', at: number) =>
    session({ plan: { ...session().plan, skill: 'conversion', start: { fen, kind: 'historical', key: positionKey(fen) } }, finishedAt: at, result: result(verdict) });

  it('prefers fresh positions over ones already used', () => {
    expect(pickStart(cands, [])!.label).toBe('A');
    const pick = pickStart(cands, [used(fenA, 'failed', 1)])!;
    expect(pick.label).toBe('B');
    expect(pick.exposure.prior).toBe(0);
  });
  it('retires a position once it was handled well, and reuses others only when nothing fresh is left', () => {
    expect(pickStart(cands, [used(fenA, 'demonstrated', 1)])!.label).toBe('B');
    const remediation = pickStart(cands, [used(fenA, 'failed', 1), used(fenB, 'demonstrated', 2)])!;
    expect(remediation.label).toBe('A');
    expect(remediation.exposure).toEqual({ prior: 1, lastAt: 1, verdicts: ['failed'] });
    expect(pickStart(cands, [used(fenA, 'demonstrated', 1), used(fenB, 'demonstrated', 2)])).toBeUndefined();
  });
  it('counts exposure per exact position, separately from skill exposure', () => {
    const e = positionExposure(positionKey(fenA), [used(fenA, 'failed', 5), used(fenA, 'failed', 9), session()]);
    expect(e.prior).toBe(2);
    expect(e.lastAt).toBe(9);
  });
});

describe('emergence tracking', () => {
  it('deprioritises a lesson whose recent games mostly produced no valid test', () => {
    const notTested = [1, 2, 3].map((i) => session({ id: `n${i}`, finishedAt: i, result: result('not_tested') }));
    const base = buildSkillProfile([], []).find((s) => s.skill === 'positional_patience')!;
    const status = { ...base, weakness: { ...base.weakness, score: 3, confidence: 'established' as const } };
    const low = { ...status, training: { ...status.training, lowEmergence: true } };
    expect(priority(low)).toBeLessThan(priority(status));
    expect(buildSkillProfile([], notTested).find((s) => s.skill === 'positional_patience')!.training.lowEmergence).toBe(true);
    expect(playtestStats(notTested).skills[0]).toMatchObject({ finished: 3, valid: 0, notTested: 3, lowEmergence: true });
  });
});

describe('decision log export', () => {
  it('contains the best move, the choice, the reason and the candidates for every coach move', () => {
    const fen = after('1. e4');
    const pick = selectCoachMove(fen, lines(fen, [['e7e5', -30], ['c7c5', -32], ['g7g5', -250]]), { band: 5, strength: 'steady', variety: 0 }, { skill: 'positional_patience' })!;
    const s = session({ moves: ['e2e4', pick.uci], coachLog: [{ ply: 2, ...pick.log, ms: 420 }], result: result('partial'), feedback: { natural: 'mixed', weirdMoves: '1...g5', at: 1 } });
    const log = sessionLog(s);
    expect(log).toMatch(/1\.\.\.(e5|c5)\s+best e5 \(-0\.3\)/);
    expect(log).toContain('g5 -2.5 ✗band');
    expect(log).toContain('weird: 1...g5');
    expect(log).toContain('tuning p2');
    expect(exportPlaytest([s])).toContain('=== Playtest summary');
  });
});

describe('material guard still holds after the Phase 2 changes', () => {
  it('a pawn regained a few moves later (the Petrov) is not counted as lost', () => {
    const fen = after('1. e4 e5 2. Nf3');
    const pos = lines(fen, [
      ['b8c6', -30, ['f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1']],
      ['g8f6', -40, ['f3e5', 'd7d6', 'e5f3', 'f6e4', 'd2d3', 'e4f6']],
    ]);
    expect(candidates(fen, pos, { band: 5, strength: 'steady' })[1].allowed).toBe(true);
  });

  it('a sound-looking candidate whose own line loses material is never allowed', () => {
    const c = new Chess(CLOSED);
    const me = 'b';
    const hang = c.moves({ verbose: true }).find((m) => {
      if (m.piece === 'p' || m.captured) return false;
      const take = new Chess(m.after).moves({ verbose: true }).find((r) => r.to === m.to);
      return take && materialAfterLine(CLOSED, [m.lan, take.lan], me) - materialBalance(CLOSED, me) <= -3;
    })!;
    const take = new Chess(hang.after).moves({ verbose: true }).find((r) => r.to === hang.to)!;
    for (const s of STRENGTHS) {
      const cands = candidates(CLOSED, lines(CLOSED, [['c5c4', 200, ['a2a3']], [hang.lan, 199, [take.lan]]]), { band: s.band, strength: s.id });
      expect(cands[1]).toMatchObject({ allowed: false, out: 'material' });
    }
  });
});

// ------------------------------------------------------------ helpers

function result(verdict: 'demonstrated' | 'failed' | 'partial' | 'not_tested'): NonNullable<AdaptiveSession['result']> {
  return { skill: 'positional_patience', valid: verdict !== 'not_tested', verdict, headline: '', explanation: 'x', moments: [], retestSoon: true, stats: {}, testMoments: 3, evidence: ['Rule: test'] };
}

function session(over: Partial<AdaptiveSession> = {}): AdaptiveSession {
  return {
    id: 's1',
    createdAt: 1,
    finishedAt: 2,
    plan: {
      skill: 'positional_patience',
      basis: 'history',
      reason: '',
      desiredPosition: '',
      coachPreferences: [],
      successSignals: [],
      failureSignals: [],
      evidence: [],
      userColor: 'w',
      start: { fen: START_FEN, kind: 'standard' },
    },
    band: 5,
    strength: 'steady',
    tuning: COACH_TUNING.version,
    depth: 12,
    moves: [],
    coachLog: [],
    status: 'done',
    ...over,
  };
}
