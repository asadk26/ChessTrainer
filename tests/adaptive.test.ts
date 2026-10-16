import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AdaptivePlan, AdaptiveSession, Color, EngineLine, PositionEval, StoredGame } from '../src/domain/types';
import { parsePgn } from '../src/chess/pgn';
import { coachFromPositions } from '../src/analysis/pipeline';
import { materialAfterLine, materialBalance, sideToMove } from '../src/chess/board';
import { candidates, selectCoachMove, STRENGTHS } from '../src/adaptive/selectMove';
import { assessGame } from '../src/adaptive/assess';
import { buildSkillProfile } from '../src/adaptive/skills';
import { chooseSkill, conversionStart, planFor, START_FEN } from '../src/adaptive/planner';
import { pawnBreaks } from '../src/adaptive/features';

// ------------------------------------------------------------ mock games

const FRENCH = '1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Nf3 Qb6 6. Be2 Bd7 7. O-O Nge7 8. Na3 Nf5 9. Nc2 Be7 10. Bd3 O-O 11. Re1 Rfc8';
const PATIENCE_FAIL = `${FRENCH} 12. b4 cxb4 13. cxb4 Nxb4 14. Nxb4 Bxb4 15. Bd2 Bxd2 16. Qxd2 Qa5 17. Qxa5 Rc3`;
const PATIENCE_GOOD = `${FRENCH} 12. Bf4 a6 13. h3 Qc7 14. Qd2 b5 15. b4 c4 16. Be2 a5 17. a3 axb4 18. axb4 Ra7`;
const DEV_GOOD = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 d6 6. Nc3 O-O 7. Bg5 h6 8. Bh4 Bg4 9. h3 Bh5 10. Re1 a6 11. a3 b5';
const DEV_BAD = '1. e4 e5 2. Qh5 Nc6 3. Qf3 Nf6 4. h3 d5 5. a3 Bc5 6. g4 O-O 7. Qg3 Re8 8. d3 a5 9. Qg2 h6 10. Qf3 Be6';
const QUICK_MATE = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';
/** White is a bishop up: a real-looking conversion start. */
const UP_A_PIECE = 'r4rk1/pp3ppp/2n5/3p4/3P4/2NB1N2/PP3PPP/R4RK1 w - - 0 15';

/** Deterministic quiet moves from a FEN (no captures, no checks), as a PGN with the FEN header. */
function quietGame(fen: string, plies: number): string {
  const c = new Chess(fen);
  for (let i = 0; i < plies; i++) {
    const m = c.moves({ verbose: true }).filter((x) => !x.captured && !x.san.includes('+')).sort((a, b) => a.san.localeCompare(b.san))[i % 3];
    c.move(m.san);
  }
  return `[SetUp "1"]\n[FEN "${fen}"]\n\n${c.pgn().replace(/^\[[^\n]*\n/gm, '').trim()}`;
}

/**
 * A fully analysed game with a controlled evaluation: `userCp(i)` is the evaluation (user's view)
 * of the position before ply i+1. Stockfish's best is the move played unless `best` overrides it.
 */
function analysed(pgn: string, user: Color, userCp: (i: number) => number, best: Record<number, string> = {}, id = 'g1', playedAt = '2026.10.01'): StoredGame {
  const parsed = parsePgn(pgn.includes('[') ? pgn : `[Date "${playedAt}"]\n\n${pgn}`);
  const plies = parsed.plies;
  const positions: PositionEval[] = [];
  for (let i = 0; i <= plies.length; i++) {
    const fen = i < plies.length ? plies[i].fenBefore : plies[i - 1].fenAfter;
    const c = new Chess(fen);
    const side = sideToMove(fen);
    const u = userCp(i);
    if (c.isCheckmate()) {
      positions.push({ fen, depth: 12, lines: [], terminal: 'checkmate' });
      continue;
    }
    const pv = best[i] ? [best[i]] : plies[i] ? [plies[i].uci] : [c.moves({ verbose: true })[0]?.lan ?? ''];
    positions.push({ fen, depth: 12, lines: [{ pv: pv.filter(Boolean), score: { type: 'cp', value: side === user ? u : -u }, depth: 12 }] });
  }
  const game: StoredGame = {
    id,
    importedAt: Date.parse(playedAt.replace(/\./g, '-')),
    pgn: parsed.pgn,
    headers: { ...parsed.headers, date: playedAt },
    userColor: user,
    userName: 'me',
    opponentName: 'them',
    plies,
    status: 'imported',
    findings: [],
    moments: [],
    drillIds: [],
    completedMomentIds: [],
  };
  return coachFromPositions(game, positions, []).game;
}

const plan = (skill: AdaptivePlan['skill'], extra: Partial<AdaptivePlan> = {}): AdaptivePlan => ({
  skill,
  basis: 'history',
  reason: '',
  desiredPosition: '',
  coachPreferences: [],
  successSignals: [],
  failureSignals: [],
  evidence: [],
  userColor: 'w',
  start: { fen: START_FEN },
  ...extra,
});

const lines = (fen: string, list: [string, number, string[]?][]): PositionEval => ({
  fen,
  depth: 12,
  lines: list.map(([uci, cp, rest]) => ({ pv: [uci, ...(rest ?? [])], score: { type: 'cp', value: cp }, depth: 12 }) satisfies EngineLine),
});

const fenAfter = (pgn: string) => {
  const c = new Chess();
  c.loadPgn(pgn);
  return c.fen();
};

// ------------------------------------------------------------ move selection

describe('coach move selection', () => {
  // Black to move after 15.b4 in the patience game: ...cxb4 releases the tension, ...c4 closes it.
  const closed = fenAfter(`${FRENCH} 12. Bf4 a6 13. h3 Qc7 14. Qd2 b5 15. b4`);
  const pos = lines(closed, [
    ['c5b4', 30, ['c3b4']],
    ['c5c4', 22],
    ['h7h6', 0],
    ['a6a5', -40],
    ['c7d8', -200],
  ]);

  it('never plays a move outside the allowed loss threshold, at any strength or skill', () => {
    for (const s of STRENGTHS)
      for (const skill of [undefined, 'positional_patience', 'development_discipline', 'conversion'] as const)
        for (let seed = 0; seed < 60; seed++) {
          let x = seed + 1;
          const rng = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
          const pick = selectCoachMove(closed, pos, { band: s.band, strength: s.id, variety: 1.5 }, { skill, rng })!;
          expect(pick.log.gap).toBeLessThanOrEqual(s.band);
          expect(pick.uci).not.toBe('c7d8');
        }
  });

  it('prefers the lesson move among sound ones (patience keeps the tension)', () => {
    const pick = selectCoachMove(closed, pos, { band: 5, variety: 0 }, { skill: 'positional_patience' })!;
    expect(pick.uci).toBe('c5c4');
    expect(pick.log.reason).toBe('lesson');
  });

  it('falls back to the best move when no lesson-relevant candidate is sound enough', () => {
    expect(selectCoachMove(closed, pos, { band: 5, variety: 0 })!.uci).toBe('c5b4');
    // The quiet, lesson-friendly move is now too costly: only the best remains.
    const far = lines(closed, [
      ['c5b4', 30, ['c3b4']],
      ['c5c4', -120],
    ]);
    const pick = selectCoachMove(closed, far, { band: 5, variety: 0 }, { skill: 'positional_patience' })!;
    expect(pick.uci).toBe('c5b4');
    expect(pick.log.reason).toBe('only');
  });

  it('never chooses a move whose own line sheds material, even when the evaluation looks close', () => {
    const c = new Chess(closed);
    const me = sideToMove(closed);
    // Find a coach move that simply hangs a piece to a capture.
    let hang: [string, string] | undefined;
    for (const m of c.moves({ verbose: true })) {
      if (m.piece === 'p' || m.captured) continue;
      const after = new Chess(m.after);
      const take = after.moves({ verbose: true }).find((r) => r.to === m.to);
      if (take && materialAfterLine(closed, [m.lan, take.lan], me) - materialBalance(closed, me) <= -3) {
        hang = [m.lan, take.lan];
        break;
      }
    }
    expect(hang).toBeDefined();
    const p = lines(closed, [
      ['c5c4', 25, ['a2a3']],
      [hang![0], 24, [hang![1]]],
    ]);
    for (let i = 0; i < 20; i++) expect(selectCoachMove(closed, p, { band: 8, variety: 3 }, { skill: 'conversion', rng: () => i / 20 })!.uci).toBe('c5c4');
  });

  it('concedes nothing extra once it is already worse', () => {
    const p = lines(closed, [
      ['c5b4', -300, ['c3b4']],
      ['c5c4', -330],
      ['h7h6', -380],
    ]);
    const allowed = candidates(closed, p, { band: 8, variety: 0 }).filter((c) => c.allowed).map((c) => c.uci);
    expect(allowed).toEqual(['c5b4', 'c5c4']);
  });

  it('development mode prefers developing over an early queen move of the same value', () => {
    const fen = fenAfter('1. e4 e5 2. Nf3');
    const p = lines(fen, [
      ['d8f6', -30],
      ['b8c6', -34],
      ['d7d6', -36],
    ]);
    expect(selectCoachMove(fen, p, { band: 5, variety: 0 }, { skill: 'development_discipline' })!.uci).toBe('b8c6');
  });

  it('conversion mode defends without trading pieces when a quiet move is just as good', () => {
    // White (the coach here) is worse; Bxe4 trades a piece, Rfe1 keeps pieces on.
    const fen = 'r4rk1/pp3ppp/2n5/3p4/3Pn3/2NB1N2/PP3PPP/R4RK1 w - - 0 15';
    const p = lines(fen, [
      ['d3e4', -120, ['d5e4']],
      ['f1e1', -125],
    ]);
    expect(selectCoachMove(fen, p, { band: 5, variety: 0 }, { skill: 'conversion' })!.uci).toBe('f1e1');
  });
});

// ------------------------------------------------------------ assessment (mock scenarios)

const level = () => 20;

describe('mock scenario: positional patience', () => {
  it('a premature pawn break in a quiet, level position fails the test', () => {
    // 12.b4 (ply 23) drops to -1.5 while Stockfish wanted Bf4 first.
    const g = analysed(PATIENCE_FAIL, 'w', (i) => (i <= 22 ? 20 : -150), { 22: 'c1f4' });
    expect(pawnBreaks(g.plies, g.analysis!.moves, 'w').find((b) => b.ply === 23)?.kind).toBe('premature');
    const r = assessGame(g, plan('positional_patience'));
    expect(r.valid).toBe(true);
    expect(r.verdict).toBe('failed');
    expect(r.moments[0].label).toBe('12.b4');
    expect(r.retestSoon).toBe(true);
  });

  it('a prepared break after improving pieces is demonstrated', () => {
    const r = assessGame(analysed(PATIENCE_GOOD, 'w', level), plan('positional_patience'));
    expect(r.verdict).toBe('demonstrated');
    expect(r.moments.some((m) => m.tone === 'good' && m.label === '15.b4')).toBe(true);
  });

  it('a small inaccuracy with a pawn is "questionable", never a failure on its own', () => {
    const g = analysed(PATIENCE_FAIL, 'w', (i) => (i <= 22 ? 20 : -40), { 22: 'c1f4' });
    expect(pawnBreaks(g.plies, g.analysis!.moves, 'w').find((b) => b.ply === 23)?.kind).toBe('questionable');
    expect(assessGame(g, plan('positional_patience')).verdict).not.toBe('failed');
  });

  it('a clean game with too few quiet decisions and no break is only "partly" (not enough evidence)', () => {
    const r = assessGame(analysed(`${FRENCH} 12. Bf4 a6 13. h3 Qc7`, 'w', level), plan('positional_patience'));
    expect(r.stats.quietMoves).toBe(5);
    expect(r.verdict).toBe('partial');
  });

  it('a tactical slip in a quiet position is not counted as a patience failure', () => {
    // 14.Nxb4?? style material loss: the slip is excluded from the patience average and shown as neutral.
    const g = analysed(PATIENCE_GOOD, 'w', level);
    const i = g.plies.findIndex((p) => p.san === 'Qd2');
    g.analysis!.moves[i] = { ...g.analysis!.moves[i], materialAfterReply: g.analysis!.moves[i].materialBefore - 3, winDrop: 30, practicalDrop: 30 };
    const r = assessGame(g, plan('positional_patience'));
    expect(r.stats.tacticalSlips).toBe(1);
    expect(r.verdict).toBe('demonstrated');
    expect(r.moments.some((m) => m.tone === 'neutral')).toBe(true);
  });

  it('is "not meaningfully tested" when the game never reached a quiet middlegame', () => {
    const r = assessGame(analysed(QUICK_MATE, 'w', level), plan('positional_patience'));
    expect(r.valid).toBe(false);
    expect(r.verdict).toBe('not_tested');
    expect(r.moments).toEqual([]);
  });
});

describe('mock scenario: development discipline', () => {
  it('pieces out and castled by move 10 is demonstrated', () => {
    const r = assessGame(analysed(DEV_GOOD, 'w', level), plan('development_discipline'));
    expect(r.verdict).toBe('demonstrated');
    expect(r.stats.undevelopedAt10).toBe(0);
  });
  it('queen trips with pieces at home fail when they cost something', () => {
    // The queen trips (plies 3, 5, 13, 17) each give away a little.
    const r = assessGame(analysed(DEV_BAD, 'w', (i) => 20 - 40 * [3, 5, 13, 17].filter((q) => i >= q).length), plan('development_discipline'));
    expect(r.verdict).toBe('failed');
    expect(r.stats.undevelopedAt10).toBeGreaterThanOrEqual(2);
    expect(r.evidence!.some((e) => e.startsWith('Rule:'))).toBe(true);
  });
  it('slow development that Stockfish did not punish is only "partly", not a failure', () => {
    const slow = '1. d4 d5 2. c4 e6 3. e3 Nf6 4. a3 Be7 5. b4 O-O 6. c5 c6 7. Bd3 b6 8. f4 a5 9. Bb2 Ba6 10. h3 Nbd7';
    const r = assessGame(analysed(slow, 'w', level), plan('development_discipline'));
    expect(r.stats.undevelopedAt10).toBe(2);
    expect(r.stats.openingFindings).toBe(0);
    expect(r.verdict).toBe('partial');
    expect(r.explanation).toContain("didn't punish");
  });
  it('a game over before move 10 is not meaningfully tested', () => {
    expect(assessGame(analysed(QUICK_MATE, 'w', level), plan('development_discipline')).verdict).toBe('not_tested');
  });
  it('a game already decided by move 8 is not meaningfully tested', () => {
    expect(assessGame(analysed(DEV_GOOD, 'w', (i) => (i < 14 ? 20 : 600)), plan('development_discipline')).verdict).toBe('not_tested');
  });
});

describe('mock scenario: conversion after winning material', () => {
  const pgn = quietGame(UP_A_PIECE, 20);
  const start = { fen: UP_A_PIECE };
  const long = quietGame(UP_A_PIECE, 30);
  it('keeping the extra piece and making progress is demonstrated', () => {
    const r = assessGame(analysed(long, 'w', (i) => 350 + i * 8), plan('conversion', { start }));
    expect(r.verdict).toBe('demonstrated');
    expect(r.testMoments).toBeGreaterThanOrEqual(12);
  });
  it('holding the advantage without progress, or for only a few moves, is only "partly"', () => {
    expect(assessGame(analysed(long, 'w', () => 350), plan('conversion', { start })).verdict).toBe('partial');
    expect(assessGame(analysed(pgn, 'w', () => 350), plan('conversion', { start })).verdict).toBe('partial');
  });
  it('letting it slip fails', () => {
    const r = assessGame(analysed(pgn, 'w', (i) => (i < 9 ? 350 : 40)), plan('conversion', { start }));
    expect(r.verdict).toBe('failed');
    expect(r.moments[0].tone).toBe('bad');
  });
  it('stopping after a few moves is not meaningfully tested', () => {
    expect(assessGame(analysed(quietGame(UP_A_PIECE, 5), 'w', () => 350), plan('conversion', { start })).verdict).toBe('not_tested');
  });
  it('the start position comes from a real game where you were clearly and stably better', () => {
    const real = analysed(PATIENCE_GOOD, 'w', (i) => (i < 20 ? 20 : 320), {}, 'real');
    const pos = conversionStart([real], [])!;
    expect(pos.game.id).toBe('real');
    const ply = real.plies[pos.ply];
    expect(ply.fenBefore).toBe(pos.fen);
    expect(ply.color).toBe('w');
    expect(real.plies[pos.ply - 1].captured).toBeUndefined();
    expect(real.analysis!.moves[pos.ply].cpBefore).toBeGreaterThanOrEqual(200);
  });
});

// ------------------------------------------------------------ profile

describe('skill profile and planner', () => {
  const fail1 = analysed(PATIENCE_FAIL, 'w', (i) => (i <= 22 ? 20 : -150), { 22: 'c1f4' }, 'r1', '2026.09.01');
  const fail2 = analysed(PATIENCE_FAIL, 'w', (i) => (i <= 22 ? 20 : -150), { 22: 'c1f4' }, 'r2', '2026.09.05');
  const session = (verdict: 'demonstrated' | 'not_tested', at: number): AdaptiveSession => ({
    id: `s-${verdict}`,
    createdAt: at - 1000,
    finishedAt: at,
    plan: plan('positional_patience'),
    band: 5,
    depth: 12,
    moves: [],
    coachLog: [],
    status: 'done',
    gameId: 'coach',
    result: { skill: 'positional_patience', valid: verdict !== 'not_tested', verdict, headline: '', explanation: '', moments: [], retestSoon: false, stats: {} },
  });

  it('treats the pawn-break heuristic conservatively: half a game each', () => {
    const p = buildSkillProfile([fail1], []).find((s) => s.skill === 'positional_patience')!;
    expect(p.weakness.games).toBe(0.5);
    expect(p.weakness.confidence).toBe('none');
    const two = buildSkillProfile([fail1, fail2], []).find((s) => s.skill === 'positional_patience')!;
    expect(two.weakness.confidence).toBe('possible');
  });

  it('records a valid test as training progress without touching real-game weakness', () => {
    const coachGame = { ...analysed(PATIENCE_FAIL, 'w', (i) => (i <= 22 ? 20 : -150), { 22: 'c1f4' }, 'coach', '2026.10.10'), adaptive: { sessionId: 's', skill: 'positional_patience' as const } };
    const before = buildSkillProfile([fail1, fail2], []).find((s) => s.skill === 'positional_patience')!;
    const after = buildSkillProfile([fail1, fail2, coachGame], [session('demonstrated', Date.parse('2026-10-10')), session('not_tested', Date.parse('2026-10-11'))]).find(
      (s) => s.skill === 'positional_patience',
    )!;
    expect(after.weakness).toEqual(before.weakness);
    expect(after.training.tests).toBe(1);
    expect(after.training.recent[0].verdict).toBe('demonstrated');
    expect(after.confirmation).toEqual({ since: Date.parse('2026-10-10'), realGames: 0, reappeared: 0 });
  });

  it('only plans from real evidence; otherwise a game is labelled practice', () => {
    const profile = buildSkillProfile([fail1], []);
    expect(chooseSkill(profile, () => true)).toBeUndefined();
    const p = planFor(profile.find((s) => s.skill === 'positional_patience')!, [fail1], []);
    expect(p?.basis).toBe('practice');
  });

  it('coach games are excluded from the history the normal coach uses', async () => {
    const { priorGames } = await import('../src/analysis/pipeline');
    const coachGame = { ...fail2, id: 'cg', adaptive: { sessionId: 's', skill: 'positional_patience' as const } };
    const later = { ...fail2, id: 'later', headers: { ...fail2.headers, date: '2026.12.01' } };
    expect(priorGames(later, [fail1, coachGame, later]).map((g) => g.gameId)).toEqual(['r1']);
  });
});
