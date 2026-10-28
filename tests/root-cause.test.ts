// Golden games: the summary must find the root cause (setup → decisive mistake → result) and take
// its lesson from the detector that explains it. These protect the coaching from silent regressions.
import { describe, expect, it } from 'vitest';
import { fixtureGame } from './helpers';
import { coachFromPositions } from '../src/analysis/pipeline';
import { buildMomentContext, namesConcreteReason, parseMomentExplanation } from '../src/coach/momentContext';

const coach = (n: Parameters<typeof fixtureGame>[0]) => {
  const f = fixtureGame(n);
  return coachFromPositions(f.game, f.positions, []);
};
const LOOSE = /check whether it can simply be taken|let go of a piece/;

// Ground truth (tests/truth): 12.f3 was Stockfish's own top move. The root cause is 13.Nh3 — the knight
// went to the rim, where …exf3 Rxf3 g4 forks it and the rook — then 16.Bxg4 took a pawn the f6 knight defended.
describe('golden: chunkmonkey420 vs Drearydoc (A16) — knight to the rim into a pawn fork, then a defended pawn', () => {
  const { game: g, drills } = coach('drearydoc-game');
  const f = (ply: number, cat: string) => g.findings.find((x) => x.ply === ply && x.category === cat);

  it('never blames 12.f3, Stockfish’s top move', () => {
    const r = g.report!;
    expect(g.findings.some((x) => x.ply === 23 && x.kind === 'weakness')).toBe(false);
    expect([r.headline, r.story ?? '', r.focus.title, r.focus.detail, ...r.hurt.map((h) => h.text)].join(' ')).not.toMatch(/12\.f3/);
    expect(g.moments.some((m) => m.ply === 23)).toBe(false);
  });
  it('13.Nh3: the knight on the rim walks into a pawn fork (…exf3 Rxf3 g4)', () => {
    const m = g.moments.find((x) => x.ply === 25);
    expect(m?.tactic?.tag).toMatch(/fork/);
    expect(f(25, 'piece_to_rim') ?? g.findings.find((x) => x.ply === 25 && x.facts.pattern)).toBeTruthy();
  });
  it('16.Bxg4 took a pawn defended by the knight on f6', () => {
    expect(f(31, 'defended_grab')?.evidence).toBe('16.Bxg4 took the pawn on g4, but it was defended by the knight on f6 — Nxg4 won your bishop.');
    expect(g.findings.some((x) => x.ply === 31 && x.category === 'premature_capture')).toBe(false);
  });
  it('tells the story in order: 13.Nh3, then the decisive 16.Bxg4, then the mate', () => {
    const s = g.report!.story!;
    const at = (t: string) => s.indexOf(t);
    expect(at('13.Nh3')).toBeGreaterThanOrEqual(0);
    expect(at('13.Nh3')).toBeLessThan(at('16.Bxg4'));
    expect(at('16.Bxg4')).toBeLessThan(at('checkmate on move 36'));
  });
  it('leads with 13.Nh3 and 16.Bxg4, and the lesson is counting defenders — never the generic blunder check', () => {
    const r = g.report!;
    expect(r.headline).toMatch(/16\.Bxg4/);
    expect(r.headline).toMatch(/13\.Nh3/);
    expect(r.focus.title).toBe('Before you capture, count the defenders.');
    expect(`${r.headline} ${r.focus.title} ${r.focus.detail}`).not.toMatch(LOOSE);
    expect(g.moments.find((m) => m.ply === 31)?.text.lesson).toMatch(/^Before you capture, count the defenders/);
  });
  it('drills the decisive move as "spot the danger": …Nxg4', () => {
    const d = drills.find((x) => x.ply === 31)!;
    expect(d.type).toBe('predict_response');
    expect(d.solutionSan).toBe('Nxg4');
  });
});

describe('golden: chunkmonkey420 vs Atayan48 — a discovered attack with tempo on the queen', () => {
  const { game: g } = coach('atayan-game');
  it('theme: discovered attack, from the decisive 16.Nxd6', () => {
    expect(g.report?.headline).toMatch(/^You walked into a discovered attack\./);
    expect(g.report?.focus.title).toBe("Before you capture, ask what your opponent's reply can uncover.");
    expect(g.report?.story).toMatch(/^The decisive mistake: 16\.Nxd6 walked into a discovered attack: Ne5 attacks the queen on f3/);
  });
});

describe('golden: king2008abhi vs chunkmonkey420 — a clean 12-move win', () => {
  const { game: g } = coach('abhi-game');
  it('credits 9...Qxg5 (if Qxg5, Nf3+ forks king and queen)', () => {
    expect(g.report?.didWell.some((d) => d.text.startsWith('9...Qxg5 took the knight on g5: it looked defended, but if Qxg5, Nf3+ forks the king and the queen on g5'))).toBe(true);
  });
  it('has no development lesson anywhere', () => {
    const r = g.report!;
    expect(g.findings.some((f) => f.category === 'development')).toBe(false);
    expect([r.headline, r.focus.title, ...r.hurt.map((h) => h.text), ...r.minorNotes.map((n) => n.text)].join(' ')).not.toMatch(/develop/i);
  });
});

describe('"Why?" must name the concrete reason', () => {
  const { game: g } = coach('drearydoc-game');
  const ctx = buildMomentContext(g, 31, { rating: 1050, prior: [] })!;
  it('treats advantage-talk as vague, and relations as concrete', () => {
    expect(namesConcreteReason('Rxf6 gains a clear advantage.')).toBe(false);
    expect(namesConcreteReason('Rxf6 is better.')).toBe(false);
    expect(namesConcreteReason('Nxg4 takes back, because the knight on f6 defends g4.')).toBe(true);
  });
  it("replaces a vague answer with the detector's board fact", () => {
    const e = parseMomentExplanation(JSON.stringify({ headline: 'Rxf6 gains a clear advantage.', whyBetter: 'Rxf6 gains a clear advantage.', takeaway: 'Be careful.' }), ctx, 31);
    expect(e.headline).toBe('16.Bxg4 took the pawn on g4, but it was defended by the knight on f6 — Nxg4 won your bishop.');
  });
});
