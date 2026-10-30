// "Most to learn": which game to review next.
import { describe, expect, it } from 'vitest';
import type { Confidence, Finding, MoveEval, StoredGame } from '../src/domain/types';
import { CLEAN_WIN_VALUE, gamesToAnalyzeNext, learningValue, rankGames, recency, reviewedToday, topPatterns } from '../src/coach/mostToLearn';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12);

interface Slip {
  ply: number; // odd plies are yours (you play White)
  gap: number; // practical drop: ≥22 blunder, ≥12 mistake, ≥6 inaccuracy
  confidence?: Confidence;
  category?: string;
  pattern?: string;
  mateIn?: number;
}

/** A small synthetic analyzed game: 20 plies, you as White. */
function game(id: string, daysAgo: number, slips: Slip[], o: { outcome?: 'win' | 'loss' | 'draw'; reviewedAt?: number; status?: StoredGame['status']; peakCp?: number } = {}): StoredGame {
  const plies = Array.from({ length: 20 }, (_, i) => ({ ply: i + 1, color: i % 2 === 0 ? 'w' : 'b', san: 'x', moveNumber: Math.floor(i / 2) + 1 }));
  const moves = plies.map((p, i) => {
    const s = slips.find((x) => x.ply === p.ply);
    const cpBefore = i === 0 ? (o.peakCp ?? 30) : 30;
    return { ply: p.ply, color: p.color, isBest: !s, winDrop: s?.gap ?? 0, practicalDrop: s?.gap ?? 0, cpBefore, cpAfter: s ? cpBefore - s.gap * 20 : cpBefore } as unknown as MoveEval;
  });
  const findings = slips
    .filter((s) => s.category)
    .map((s) => ({ kind: 'weakness', ply: s.ply, category: s.category, severity: 2, confidence: s.confidence ?? 'high', evidence: '', facts: { ...(s.pattern ? { pattern: s.pattern, patternSide: 'refutation' } : {}), ...(s.mateIn ? { mateIn: s.mateIn } : {}) } }) as unknown as Finding);
  const result = o.outcome === 'loss' ? '0-1' : o.outcome === 'draw' ? '1/2-1/2' : '1-0';
  return {
    id,
    status: o.status ?? 'analyzed',
    userColor: 'w',
    opponentName: id,
    headers: { result },
    importedAt: NOW - daysAgo * DAY,
    plies,
    findings,
    moments: [],
    completedMomentIds: [],
    analysis: { depth: 12, engine: 'test', analyzedAt: 0, positions: [], moves },
    reviewedAt: o.reviewedAt,
  } as unknown as StoredGame;
}

describe('most to learn', () => {
  it('ranks by learning value × recency', () => {
    const big = game('big', 1, [{ ply: 5, gap: 30, category: 'blunder' }, { ply: 9, gap: 15, category: 'blunder' }], { outcome: 'loss' });
    const small = game('small', 1, [{ ply: 5, gap: 8, category: 'blunder' }], { outcome: 'loss' });
    const oldBig = game('oldBig', 21, [{ ply: 5, gap: 30, category: 'blunder' }, { ply: 9, gap: 15, category: 'blunder' }], { outcome: 'loss' });
    const order = rankGames([small, oldBig, big], NOW).map((r) => r.game.id);
    // big: (3 + 2) × 0.91 ≈ 4.5; oldBig: 5 × 0.125 ≈ 0.6; small: 0.5 × 0.91 ≈ 0.45.
    expect(order).toEqual(['big', 'oldBig', 'small']);
  });

  it('weights by severity and confidence, and counts unexplained mistakes at 0.2', () => {
    const g = game('g', 0, [
      { ply: 5, gap: 30, category: 'blunder', confidence: 'high' }, // 3 × 1
      { ply: 7, gap: 15, category: 'blunder', confidence: 'medium' }, // 2 × 0.6
      { ply: 9, gap: 15 }, // a mistake with no finding: 2 × 0.2
      { ply: 11, gap: 8, category: 'premature_attack', confidence: 'low' }, // 0.5 × 0.2
    ], { outcome: 'loss' });
    expect(learningValue(g, []).value).toBeCloseTo(3 + 1.2 + 0.4 + 0.1, 5);
  });

  it('decays with a 7-day half-life', () => {
    expect(recency(NOW, NOW)).toBe(1);
    expect(recency(NOW - 7 * DAY, NOW)).toBeCloseTo(0.5, 10);
    expect(recency(NOW - 14 * DAY, NOW)).toBeCloseTo(0.25, 10);
  });

  it('leaves out reviewed games (until you review again)', () => {
    const a = game('a', 1, [{ ply: 5, gap: 30, category: 'blunder' }], { outcome: 'loss', reviewedAt: NOW - DAY });
    const b = game('b', 1, [{ ply: 5, gap: 15, category: 'blunder' }], { outcome: 'loss' });
    expect(rankGames([a, b], NOW).map((r) => r.game.id)).toEqual(['b']);
    expect(rankGames([{ ...a, reviewedAt: undefined }, b], NOW)[0].game.id).toBe('a');
  });

  it('+50% for one of your top 3 patterns, +25% for a loss from +3', () => {
    const fork = (id: string, days: number) => game(id, days, [{ ply: 5, gap: 30, category: 'blunder', pattern: 'knight_fork' }], { outcome: 'loss' });
    const history = [fork('h1', 3), fork('h2', 4)];
    const top = topPatterns([...history, fork('now', 0)]);
    expect(top[0]).toBe('tactic:knight_fork:refutation');
    const base = learningValue(game('plain', 0, [{ ply: 5, gap: 30, category: 'blunder' }], { outcome: 'loss' }), top).value;
    expect(learningValue(fork('now', 0), top).value).toBeCloseTo(base * 1.5, 5);
    const threw = game('threw', 0, [{ ply: 5, gap: 30, category: 'blunder' }], { outcome: 'loss', peakCp: 320 });
    expect(learningValue(threw, top).value).toBeCloseTo(base * 1.25, 5);
    expect(learningValue(threw, top).chips).toContain('Lost from +3');
    expect(learningValue(fork('now', 0), top).chips).toEqual(['Knight fork allowed', 'Your #1 pattern']);
  });

  it('a clean win gets a small fixed value: it ranks low but can still show', () => {
    const clean = game('clean', 0, [], { outcome: 'win' });
    const loss = game('loss', 0, [{ ply: 5, gap: 15, category: 'blunder' }], { outcome: 'loss' });
    expect(learningValue(clean, []).value).toBe(CLEAN_WIN_VALUE);
    expect(rankGames([clean, loss], NOW).map((r) => r.game.id)).toEqual(['loss', 'clean']);
  });

  it('chips come only from high- or medium-confidence findings', () => {
    const low = game('low', 0, [{ ply: 5, gap: 30, category: 'blunder', confidence: 'low', pattern: 'fork' }], { outcome: 'loss' });
    expect(learningValue(low, []).chips).toEqual([]);
    const medium = game('medium', 0, [{ ply: 5, gap: 30, category: 'blunder', confidence: 'medium', pattern: 'fork' }], { outcome: 'loss' });
    expect(learningValue(medium, []).chips).toEqual(['Fork allowed']);
    const mate = game('mate', 0, [{ ply: 5, gap: 15, category: 'tactical_blindness', mateIn: 2 }], { outcome: 'draw', peakCp: 400 });
    expect(learningValue(mate, []).chips).toEqual(['Missed mate in 2', 'Drew from +3']);
  });

  it('"done for today" once a review is finished today', () => {
    expect(reviewedToday([game('a', 2, [], { reviewedAt: NOW - 60_000 })], NOW)).toBe(true);
    expect(reviewedToday([game('a', 2, [], { reviewedAt: NOW - 2 * DAY })], NOW)).toBe(false);
  });

  it('with fewer than 3 games to review, queues the 5 most recent unanalyzed games, losses first', () => {
    const waiting = [
      game('w1', 1, [], { status: 'imported', outcome: 'win' }),
      game('l2', 2, [], { status: 'imported', outcome: 'loss' }),
      game('w3', 3, [], { status: 'imported', outcome: 'win' }),
      game('l4', 4, [], { status: 'imported', outcome: 'loss' }),
      game('w5', 5, [], { status: 'imported', outcome: 'win' }),
      game('l9', 9, [], { status: 'imported', outcome: 'loss' }), // too old: 6th most recent
    ];
    expect(gamesToAnalyzeNext(waiting).map((g) => g.id)).toEqual(['l2', 'l4', 'w1', 'w3', 'w5']);
    const ready = [1, 2, 3].map((d) => game(`r${d}`, d, [], { outcome: 'win' }));
    expect(gamesToAnalyzeNext([...ready, ...waiting])).toEqual([]);
  });
});
