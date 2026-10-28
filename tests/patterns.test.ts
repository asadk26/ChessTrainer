import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { fixtureGame } from './helpers';
import { coachFromPositions } from '../src/analysis/pipeline';
import { PATTERN_RULE, detectPattern } from '../src/analysis/patterns';
import { patternStats } from '../src/analysis/patternStats';
import { captureOpportunity } from '../src/analysis/boardFacts';
import { lineSteps, stepCaption } from '../src/analysis/lineSteps';
import { buildMomentContext, parseMomentExplanation } from '../src/coach/momentContext';

const game = (n: Parameters<typeof fixtureGame>[0], id: string = n, at?: number) => {
  const f = fixtureGame(n, id, at);
  return coachFromPositions(f.game, f.positions, []).game;
};
const fen = (moves: string[]) => {
  const c = new Chess();
  moves.forEach((m) => c.move(m));
  return c.fen();
};

describe('pattern tags on real mistakes', () => {
  it('tags what decided the move, with evidence, and saves it on the game', () => {
    const q = game('queen-blunder-game');
    expect(q.patterns?.[22]).toMatchObject({ tag: 'hanging_piece', side: 'refutation' }); // 11...Qd7 Nxd7
    expect(q.patterns?.[22]?.evidence).toContain('queen on d7');
    const s = game('sicilian-win-game');
    expect(s.patterns?.[21]).toMatchObject({ tag: 'trapped_piece' }); // 11.Bf4 Bxb2 … Bxa1
    expect(s.patterns?.[21]?.evidence).toContain('rook on a1');
  });
  it('leaves positional mistakes untagged rather than guessing', () => {
    const d = game('draw-game');
    expect(d.patterns?.[38]).toBeUndefined(); // 19...e4, a premature pawn break
  });
  it('a piece moved where it is taken for free is hanging', () => {
    // 1...Bg4?? Qxg4: nothing defends g4.
    expect(detectPattern('2b3k1/5ppp/8/8/8/8/5PPP/3Q2K1 b - - 0 1', 'c8g4', ['d1g4'], [], [])).toMatchObject({ tag: 'hanging_piece', hanging: 'moved' });
  });
  it('a piece that is merely defended — lost only to an exchange — is not hanging', () => {
    // 1...Nd4 is defended by the e5 pawn; Nxd4 exd4 is an even trade, nothing is lost.
    expect(detectPattern('6k1/5ppp/2n5/4p3/8/5N2/5PPP/6K1 b - - 0 1', 'c6d4', ['f3d4', 'e5d4'], [], [])).toBeUndefined();
  });
  it('a pawn push that takes the only guard away from a piece is a removed defender', () => {
    // 1.a5?? — the a4 pawn was the only guard of the b5 knight: Rxb5.
    const hit = detectPattern('1r4k1/5ppp/8/1N6/P7/8/5PPP/6K1 w - - 0 1', 'a4a5', ['b8b5'], [], []);
    expect(hit).toMatchObject({ tag: 'removed_defender', side: 'refutation' });
    expect(hit!.evidence).toBe('the pawn on a4 was the only guard of the knight on b5; after a5, Rxb5 took it');
  });
  it('a capture that abandons a guard is a grab, not a removed defender', () => {
    // 1.Qxa7 leaves the d5 knight to Rxd5: the lesson is the grab, so no removed-defender tag.
    const hit = detectPattern('3r2k1/p4ppp/8/3N4/8/8/3Q1PPP/6K1 w - - 0 1', 'd2a7', ['d8d5'], [], []);
    expect(hit?.tag).not.toBe('removed_defender');
  });
  it('moving the pawn that shielded your queen opens the line to it', () => {
    // 1...c4?? — the c5 pawn was blocking the g1 bishop from the b6 queen: Bxb6.
    const hit = detectPattern('6k1/5ppp/1q6/2p5/8/8/6PP/6BK b - - 0 1', 'c5c4', ['g1b6'], [], []);
    expect(hit).toMatchObject({ tag: 'unblocked_queen', side: 'refutation' });
    expect(hit!.evidence).toBe('the pawn on c5 was blocking the bishop on g1 from your queen on b6, and c4 moved it');
  });
  it('a pawn fork counts even when a desperado evens out the material inside the line', () => {
    // 1.Kh1?? g4 hits the f3 rook and h3 knight; 2.Rxf6 gxh3 — even on material, but the fork did it.
    const hit = detectPattern('6k1/8/5n2/6p1/8/5R1N/8/6K1 w - - 0 1', 'g1h1', ['g5g4', 'f3f6', 'g4h3'], [], []);
    expect(hit).toMatchObject({ tag: 'pawn_fork', side: 'refutation' });
    expect(hit!.evidence).toBe('g4 attacks the rook on f3 and the knight on h3 at once');
  });
  it('finds a knight fork in the better line (king and rook)', () => {
    const f = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
    const hit = detectPattern(f, 'e1e2', ['e8d7'], ['b5c7', 'e8d7', 'c7a8'], []);
    expect(hit).toMatchObject({ tag: 'knight_fork', side: 'better' });
    expect(hit!.evidence).toBe('Nc7+ forks the king and the rook on a8');
  });
  it('finds a discovered check that wins the queen', () => {
    // Be5+ uncovers the rook's check on d8 and attacks the queen on h8.
    const f = '3k3q/8/8/8/3B4/8/8/3RK3 w - - 0 1';
    const hit = detectPattern(f, 'e1e2', ['d8e8'], ['d4e5', 'd8c8', 'e5h8'], []);
    expect(hit).toMatchObject({ tag: 'discovered_attack', side: 'better' });
    expect(hit!.evidence).toContain('rook on d1, which now attacks the king');
  });
  it('every tag has a one-line rule', () => {
    for (const r of Object.values(PATTERN_RULE)) expect(r.length).toBeLessThan(140);
  });
});

describe('pattern stats across games', () => {
  it('counts per tag, per month, real games only', () => {
    const a = game('queen-blunder-game', 'a', Date.UTC(2026, 8, 3));
    const b = game('black-win-game', 'b', Date.UTC(2026, 9, 3));
    const coach = { ...game('chaotic-game', 'c'), adaptive: { sessionId: 's', skill: 'conversion' as const } };
    const stats = patternStats([a, b, coach]);
    const hanging = stats.find((x) => x.tag === 'hanging_piece')!;
    expect(hanging.games).toBe(2);
    expect(Object.values(hanging.byMonth).reduce((x, y) => x + y, 0)).toBe(hanging.total);
    expect(hanging.trend).toBe('insufficient');
    // Games analysed before tags existed are tagged on the fly.
    expect(patternStats([{ ...a, patterns: undefined }])[0].total).toBeGreaterThan(0);
  });
});

describe('free captures are said as opportunities', () => {
  it('"X is hanging to your Y — still available next move" (or gone)', () => {
    const f = '4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1';
    expect(captureOpportunity(f, 'd1d5', 'e1e2', 'e8e7')).toBe('the knight on d5 is hanging to your rook on d1 — still available next move');
    expect(captureOpportunity(f, 'd1d5', 'e1e2', 'd5c3')).toBe('the knight on d5 is hanging to your rook on d1 — gone after your move');
    expect(captureOpportunity(fen(['e4', 'e5', 'Nf3', 'Nc6']), 'f3e5')).toBeUndefined(); // defended: not free
  });
});

describe('"Show me" steps', () => {
  it('captions each move from your side, and cuts the line at its point', () => {
    const q = game('queen-blunder-game');
    const p = q.plies[21];
    const steps = lineSteps(p.fenAfter, q.analysis!.positions[22].lines[0].pv, q.userColor);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.length).toBeLessThanOrEqual(5);
    expect(steps[0].caption).toBe('Nxd7 takes your queen on d7.');
    expect(steps[1].caption).toBe('Nxd7 takes back on d7.');
  });
  it('says when a move is forced', () => {
    const f = '4k3/8/8/8/8/8/3q4/4K3 w - - 0 1'; // White in check, one way out
    expect(stepCaption(f, 'e1d2', 'w')).toMatch(/^Kxd2 .*(only legal move out of check|gets out of check)/);
  });
});

describe('short "Why?"', () => {
  const q = game('queen-blunder-game');
  const ctx = buildMomentContext(q, 22, { rating: 900, prior: [] })!;
  it('keeps a concrete one-sentence headline and attaches the board pattern (never the model’s)', () => {
    const e = parseMomentExplanation(
      JSON.stringify({ headline: 'After Qd7, Nxd7 simply takes your queen on d7. Also more words here.', whyBetter: 'Qe7 keeps the queen safe.', takeaway: 'x', pattern: 'some recurring note' }),
      ctx,
      22,
    );
    expect(e.headline).toBe('After Qd7, Nxd7 simply takes your queen on d7.');
    expect(e.patternTag).toBe('hanging_piece');
    expect(e.pattern).toBe('some recurring note');
  });
  it('falls back to the concrete reason when the headline is vague', () => {
    const e = parseMomentExplanation(JSON.stringify({ headline: 'That was a bad idea.', whyBetter: 'Qe7 keeps the queen safe.', takeaway: 'x' }), ctx, 22);
    expect(e.headline).toBe('Qe7 keeps the queen safe.');
  });
});

describe('regression: chunkmonkey420 vs Atayan48 (flagged: "it was a discovered attack")', () => {
  const g = game('atayan-game');
  const p16 = 31; // 16.Nxd6
  it('names the discovered attack (…Ne5 hits the queen and uncovers Qd8 on the knight)', () => {
    const f = g.findings.find((x) => x.ply === p16 && x.category === 'blunder')!;
    expect(f.facts.pattern).toBe('discovered_attack');
    expect(f.evidence).toBe('16.Nxd6 walked into a discovered attack: Ne5 attacks the queen on f3 and uncovers the queen on d8, which now attacks the knight on d6.');
    expect(g.moments.find((m) => m.ply === p16)?.text.title).toBe('16.Nxd6 — walked into a discovered attack');
    expect(g.report?.focus.title).toBe("Before you capture, ask what your opponent's reply can uncover.");
    expect(g.report?.headline).toMatch(/^You walked into a discovered attack\./);
  });
  it('drills it as "spot the danger": play …Ne5, and the answer names the discovered attack', () => {
    const f = fixtureGame('atayan-game');
    const d = coachFromPositions(f.game, f.positions, []).drills.find((x) => x.ply === p16)!;
    expect(d.type).toBe('predict_response');
    expect(d.prompt).toBe("You played Nxd6 (arrow). What's Black's strongest reply? Play it for Black.");
    expect(d.solutionSan).toBe('Ne5');
    expect(d.explanation).toMatch(/discovered attack/);
  });
  it('no longer claims 16.Nxf6+ "would have won the knight" (it was an even trade)', () => {
    expect(g.findings.some((x) => x.ply === p16 && x.category === 'tactical_blindness')).toBe(false);
  });
});

describe('the takeaway comes from the tactic found (sample of chunkmonkey420 games)', () => {
  const moment = (g: ReturnType<typeof game>, ply: number) => g.moments.find((m) => m.ply === ply)!;
  const BLUNDER_CHECK = 'Before you let go of a piece, ask: can it be captured for free on its new square — and did moving it leave something else unprotected?';

  it('a queen check that also hits a loose knight is a fork, not "a piece left unprotected" (vs Jose-Dang, 11.Nb5 Qa5+)', () => {
    const g = game('josedang-game');
    expect(g.patterns?.[21]).toMatchObject({ tag: 'fork', side: 'refutation' });
    expect(g.patterns?.[21]?.evidence).toBe('Qa5+ attacks the king and the knight on b5 at once');
    expect(moment(g, 21).text.title).toBe('11.Nb5 — walked into a fork');
    expect(moment(g, 21).text.lesson).toBe(PATTERN_RULE.fork);
    expect(moment(g, 21).tactic).toEqual({ tag: 'fork', side: 'refutation' });
  });
  it('a capture of a defended pawn is "count the defenders", not "left unprotected" (vs Jose-Dang, 5.Nxe5 Nxe5)', () => {
    const g = game('josedang-game');
    expect(g.findings.find((f) => f.ply === 9)).toMatchObject({ category: 'defended_grab' });
    expect(moment(g, 9).text.title).toBe('5.Nxe5 — that pawn was defended');
    expect(moment(g, 9).text.lesson).not.toBe(BLUNDER_CHECK);
  });
  it('a back-rank tactic is the lesson even when the move is also a rook round trip (vs Harrisonisbadatchess69, 19...Rfd8)', () => {
    const g = game('harrison-game');
    const m = moment(g, 38);
    expect(m.text.title).toBe('19...Rfd8 — walked into a back-rank attack');
    expect(m.text.lesson).toBe(PATTERN_RULE.back_rank);
    expect(g.report?.focus.title).toBe('Give your king an escape square before the back rank gets busy.');
  });
  it('a piece already under attack is a missed threat, not "left unprotected" (vs aditya_satyam, 7.d3 Qxg4)', () => {
    const g = game('aditya-game');
    expect(g.patterns?.[13]).toMatchObject({ tag: 'hanging_piece', hanging: 'already' });
    expect(g.findings.find((f) => f.ply === 13)?.category).toBe('missed_threat');
    expect(moment(g, 13).text.lesson).not.toBe(BLUNDER_CHECK);
  });
  it('a discovered attack on a "calculation" move teaches the discovered-attack rule; a late mate still gets flagged (vs halfmast530)', () => {
    const g = game('halfmast-game');
    expect(moment(g, 30).text.lesson).toBe(PATTERN_RULE.discovered_attack); // 15...Nd2
    const mate = g.findings.find((f) => f.ply === 34 && f.facts.mate)!; // 17...Qh4?? Qxf7+ Kd8 Qd7#
    expect(mate.severity).toBe(2); // the game was already lost: shown, but not the lesson of the game
    expect(g.report?.headline).toMatch(/^You walked into a discovered attack, with your king still in the centre\./);
    expect(g.report?.story).toMatch(/14\.\.\.Qg5.*Then the decisive mistake: 15\.\.\.Nd2 walked into a discovered attack/);
  });
  it('allowing mate in one is "allowed checkmate" with a checks lesson (vs Blundering32, 7...f5 Qf7#)', () => {
    const g = game('blundering-game');
    const m = moment(g, 14);
    expect(m.text.title).toBe('7...f5 — allowed checkmate');
    expect(m.text.lesson).toMatch(/checks your opponent would have next/);
    expect(g.report?.focus.title).toBe('Before every move, look at the checks your opponent will have next.');
  });
  it('a trade is not a hanging piece (vs jnhbleachie, 7...Nxc3 bxc3)', () => {
    const g = game('jnhbleachie-game');
    expect(g.patterns?.[14]).toBeUndefined();
  });
  it('a loss with no decisive mistake is not called "a clean game"', () => {
    for (const n of ['josedang-game', 'harrison-game', 'aditya-game', 'halfmast-game', 'blundering-game', 'jnhbleachie-game'] as const) expect(game(n).report?.headline).not.toMatch(/clean game/i);
  });
});

describe('regression: a quick win vs king2008abhi (flagged: "lessons about developing, but it was a quick win")', () => {
  const g = game('abhi-game');
  it("doesn't make development the lesson when you were well ahead and won", () => {
    expect(g.findings.some((f) => f.category === 'development')).toBe(false);
    expect(g.report?.headline).toMatch(/^A strong win/);
    expect(g.report?.focus.generic).toBe(true); // nothing to work on: Home keeps the previous focus
  });
  it('says how it ended, and never calls a capture with material at stake "routine"', () => {
    expect(g.report?.story).toBe('White abandoned the game after 12...Nd7, with you up 2 pawns — a deserved win.');
    expect(g.findings.some((f) => f.category === 'time_management' && /Qxg5/.test(f.evidence))).toBe(false);
  });
});

describe('regression: a discovered check in a line (AyeNaing1, 26...Nxb3) froze the analysis', () => {
  it('finishes: a check given by a piece that did not move is not walked toward the king', () => {
    // Stockfish's line 26...g6 27.Rxc5 Qxc5 28.Bf3 Bb8+: the bishop leaves h2 and the h6 rook gives the check.
    const t = Date.now();
    detectPattern('5rk1/2q3pp/p6r/n1p4B/3p4/1P1P4/1B3PPb/2RQ1R1K b - - 4 26', 'a5b3', ['d1b3', 'g8h8'], ['g7g6', 'c1c5', 'c7c5', 'h5f3', 'h2b8', 'h1g1'], []);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
