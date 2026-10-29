// "You've seen this before" must point at the same mistake, and count only those.
import { describe, expect, it } from 'vitest';
import { seenBefore } from '../src/coach/seenBefore';
import type { Finding, StoredGame, TeachingMoment } from '../src/domain/types';

const moment = (ply: number, category: string, tactic?: TeachingMoment['tactic']) => ({ id: `m${ply}`, ply, kind: 'mistake', category, tactic }) as TeachingMoment;
const finding = (ply: number, category: string) => ({ ply, category, kind: 'weakness', severity: 2, confidence: 'high', evidence: `${category} on ${ply}` }) as unknown as Finding;
const game = (id: string, day: number, moments: TeachingMoment[], version = 99): StoredGame =>
  ({ id, status: 'analyzed', headers: {}, importedAt: Date.UTC(2026, 9, day), moments, findings: moments.map((m) => finding(m.ply, m.category as string)), report: { version } }) as unknown as StoredGame;

describe('seen before', () => {
  const now = game('now', 20, []);
  const fork = moment(30, 'blunder', { tag: 'knight_fork', side: 'refutation' });

  it('matches the same tactic, not just the same broad theme', () => {
    const other = [game('a', 1, [moment(12, 'blunder', { tag: 'pin', side: 'refutation' })]), game('b', 2, [moment(14, 'blunder', { tag: 'knight_fork', side: 'refutation' })])];
    const s = seenBefore(now, fork, other, 99)!;
    expect(s.game.id).toBe('b');
    expect(s.count).toBe(1);
  });

  it('counts only earlier games with the same mistake, coached by the current rules', () => {
    const same = () => [moment(20, 'premature_attack')];
    const other = [game('a', 1, same()), game('b', 2, same()), game('old', 3, same(), 98), game('later', 25, same()), game('c', 4, [moment(8, 'inefficient_moves')])];
    const s = seenBefore(now, moment(21, 'premature_attack'), other, 99)!;
    expect(s.count).toBe(2);
    expect(s.game.id).toBe('b'); // the most recent one
  });

  it('says nothing when no earlier game had that exact mistake', () => {
    expect(seenBefore(now, moment(21, 'premature_attack'), [game('a', 1, [moment(8, 'development')])], 99)).toBeUndefined();
  });
});
