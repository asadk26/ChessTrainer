import { describe, expect, it } from 'vitest';
import { KvRepository, PREFIX, prefixedEntries, type AsyncKeyValueStore } from '../src/storage/repository';
import { waitingForAnalysis } from '../src/analysis/pipeline';
import { sampleStored } from './helpers';

/** An async store with random latency, like IndexedDB. */
function slowStore(): AsyncKeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const wait = () => new Promise((r) => setTimeout(r, Math.random() * 5));
  return {
    data,
    get: async (k) => (await wait(), data.get(k) ?? null),
    set: async (k, v) => void (await wait(), data.set(k, v)),
    remove: async (k) => void (await wait(), data.delete(k)),
  };
}

describe('async repository (IndexedDB-style)', () => {
  it('never loses a game when many saves run at once (sync importing while analysis saves)', async () => {
    const repo = new KvRepository(slowStore());
    await Promise.all(Array.from({ length: 12 }, (_, i) => repo.saveGame(sampleStored(`g${i}`))));
    await Promise.all([repo.saveGame({ ...sampleStored('g3'), status: 'analyzed' }), repo.saveGame(sampleStored('g12')), repo.deleteGame('g0')]);
    const ids = (await repo.listGames()).map((g) => g.id).sort();
    expect(ids).toEqual(['g1', 'g10', 'g11', 'g12', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']);
    expect((await repo.getGame('g3'))!.status).toBe('analyzed');
  });

  it('keeps concurrent session and attempt writes', async () => {
    const repo = new KvRepository(slowStore());
    await Promise.all([1, 2, 3].map((i) => repo.addAttempt({ drillId: `d${i}`, at: i, correct: true } as never)));
    expect((await repo.listAttempts()).length).toBe(3);
  });
});

describe('localStorage → IndexedDB migration', () => {
  it('copies only this app’s entries', () => {
    const entries: Record<string, string> = { [`${PREFIX}games:index`]: '["a"]', [`${PREFIX}game:a`]: '{}', 'chesscoach:theme': 'dark', other: 'x' };
    const keys = Object.keys(entries);
    const ls = { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (k: string) => entries[k] ?? null };
    expect(prefixedEntries(ls).map(([k]) => k)).toEqual([`${PREFIX}games:index`, `${PREFIX}game:a`]);
  });
});

describe('analysis queue', () => {
  it('waits on imported real games only, oldest first, and picks up interrupted ones', () => {
    const a = { ...sampleStored('a', Date.UTC(2026, 9, 3)), headers: { ...sampleStored().headers, date: '2026.10.03' } };
    const b = { ...sampleStored('b'), headers: { ...sampleStored().headers, date: '2026.10.01' }, status: 'analyzing' as const };
    const done = { ...sampleStored('c'), status: 'analyzed' as const };
    const coach = { ...sampleStored('d'), adaptive: { sessionId: 's', skill: 'conversion' as const } };
    expect(waitingForAnalysis([a, b, done, coach]).map((g) => g.id)).toEqual(['b', 'a']);
    expect(waitingForAnalysis([a, b], (id) => id === 'b').map((g) => g.id)).toEqual(['a']);
  });
});
