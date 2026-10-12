import { describe, expect, it } from 'vitest';
import { archivesInWindow, planSync, sideOf, syncSummary, SyncError, type ChessComFetch, type ChessComGame, type SyncOptions } from '../src/sync/chesscom';
import { findDuplicate } from '../src/chess/fingerprint';
import { parsePgn } from '../src/chess/pgn';
import { proxyChessCom, userAgent } from '../server/chesscomProxy';
import { storedFromPgn } from './helpers';

const NOW = Date.UTC(2026, 9, 15, 12); // 15 Oct 2026
const API = 'https://api.chess.com/pub/player/chunkmonkey420/games/';
const MOVES = [
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 d5 6. exd5 Nxd5 7. Bg5 f6 8. Bh4 g5 9. Bg3 h5 10. h4 g4 1-0',
  '1. d4 d5 2. Bf4 Nc6 3. e3 e6 4. Bb5 Bd7 5. Nc3 a6 6. Ba4 Bb4 7. a3 Ba5 8. b4 Bb6 9. Bxc6 Bxc6 10. Nf3 Nf6 0-1',
  '1. c4 e5 2. Nc3 Nf6 3. g3 d5 4. cxd5 Nxd5 5. Bg2 Nb6 6. Nf3 Nc6 7. O-O Be7 8. d3 O-O 9. Be3 Be6 1/2-1/2',
];

let nextId = 1000;
function game(o: { white?: string; black?: string; moves?: string; day?: number; month?: number; time_class?: string; rules?: string; id?: number }): ChessComGame {
  const id = o.id ?? nextId++;
  const white = o.white ?? 'ChunkMonkey420';
  const black = o.black ?? 'someone';
  const day = o.day ?? 10;
  const month = o.month ?? 10;
  const moves = o.moves ?? MOVES[0];
  const result = moves.trim().split(' ').at(-1)!;
  const pgn = `[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2026.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[Link "https://www.chess.com/game/live/${id}"]\n\n${moves}`;
  return {
    url: `https://www.chess.com/game/live/${id}`,
    pgn,
    time_class: o.time_class ?? 'rapid',
    rules: o.rules ?? 'chess',
    end_time: Date.UTC(2026, month - 1, day, 18) / 1000,
    white: { username: white, result: 'win' },
    black: { username: black, result: 'resigned' },
  };
}

/** A fake Chess.com API that records the paths it was asked for. */
function fakeApi(months: Record<string, ChessComGame[] | 'malformed' | number>, archives: unknown = Object.keys(months).map((m) => API + m)) {
  const calls: string[] = [];
  const fetcher: ChessComFetch = async (path) => {
    calls.push(path);
    if (path.endsWith('/archives')) return typeof archives === 'number' ? { status: archives } : { status: 200, json: { archives } };
    const key = path.replace(/^player\/[^/]+\/games\//, '');
    const m = months[key];
    if (m === undefined) return { status: 404, json: { code: 0, message: 'not found' } };
    if (typeof m === 'number') return { status: m, retryAfter: 120 };
    if (m === 'malformed') return { status: 200, json: { nope: true } };
    return { status: 200, json: { games: m } };
  };
  return { fetcher, calls };
}

const opts = (o: Partial<SyncOptions> = {}): SyncOptions => ({ username: 'chunkmonkey420', days: 30, timeClasses: ['rapid'], now: NOW, maxGames: 10, ...o });

describe('Chess.com sync', () => {
  it('matches the username regardless of case and picks the right side', async () => {
    expect(sideOf({ white: { username: 'ChunkMonkey420' }, black: { username: 'x' } }, ' CHUNKMONKEY420 ')).toBe('w');
    expect(sideOf({ white: { username: 'x' }, black: { username: 'chunkMONKEY420' } }, 'chunkmonkey420')).toBe('b');
    expect(sideOf({ white: { username: 'x' }, black: { username: 'y' } }, 'chunkmonkey420')).toBeUndefined();

    const { fetcher } = fakeApi({ '2026/10': [game({ white: 'CHUNKMONKEY420', black: 'opp1', moves: MOVES[0] }), game({ white: 'opp2', black: 'ChunkMonkey420', moves: MOVES[1] })] });
    const plan = await planSync(opts({ username: 'ChunkMonkey420' }), fetcher, []);
    expect(plan.toImport.map((c) => [c.parsed.headers.white, c.color])).toEqual([
      ['CHUNKMONKEY420', 'w'],
      ['opp2', 'b'],
    ]);
  });

  it('imports several games from one archive, oldest first, standard Rapid only by default', async () => {
    const { fetcher } = fakeApi({
      '2026/10': [
        game({ day: 12, moves: MOVES[0] }),
        game({ day: 3, moves: MOVES[1] }),
        game({ day: 8, moves: MOVES[2], time_class: 'blitz' }),
        game({ day: 9, moves: MOVES[2], rules: 'chess960' }),
        game({ day: 9, white: 'a', black: 'b', moves: MOVES[2] }), // not the user's game
      ],
    });
    const plan = await planSync(opts(), fetcher, []);
    expect(plan.toImport.map((c) => c.parsed.headers.date)).toEqual(['2026.10.03', '2026.10.12']);
    expect(plan.toImport.every((c) => c.source.site === 'chesscom' && c.source.timeClass === 'rapid')).toBe(true);
    expect(syncSummary(plan, 30)).toBe('2 new games imported.');

    const withBlitz = await planSync(opts({ timeClasses: ['rapid', 'blitz'] }), fetcher, []);
    expect(withBlitz.toImport).toHaveLength(3);
  });

  it('prefers Rapid when more games match than one sync takes', async () => {
    const { fetcher } = fakeApi({ '2026/10': [game({ day: 14, moves: MOVES[0], time_class: 'blitz' }), game({ day: 2, moves: MOVES[1] }), game({ day: 13, moves: MOVES[2], time_class: 'blitz' })] });
    const plan = await planSync(opts({ timeClasses: ['rapid', 'blitz'], maxGames: 2 }), fetcher, []);
    expect(plan.toImport.map((c) => c.source.timeClass)).toEqual(['rapid', 'blitz']);
    expect(plan.deferred).toBe(1);
    expect(syncSummary(plan, 30)).toMatch(/2 new games imported\. 1 more will come in on the next sync\./);
  });

  it("doesn't import games that are already here — synced before, or pasted by hand without headers", async () => {
    const g1 = game({ id: 1, moves: MOVES[0] });
    const g2 = game({ id: 2, moves: MOVES[1] });
    const { fetcher } = fakeApi({ '2026/10': [g1, g2] });
    const first = await planSync(opts(), fetcher, []);
    const synced = storedFromPgn(first.toImport[1].parsed.pgn, 'w', 'synced');
    synced.source = first.toImport[1].source;
    const pasted = storedFromPgn(MOVES[0], 'w', 'pasted'); // bare moves, like a fresh Chess.com share
    const again = await planSync(opts(), fetcher, [synced, pasted]);
    expect(again.toImport).toHaveLength(0);
    expect(again.duplicates).toBe(2);
    expect(syncSummary(again, 30)).toBe('No new games from the last 30 days.');
  });

  it('dedupes by site id first, and never merges two different site ids', () => {
    const a = parsePgn(game({ id: 7, moves: MOVES[0] }).pgn!);
    const stored = { ...storedFromPgn(a.pgn, 'w', 'x'), headers: a.headers };
    expect(findDuplicate([stored], { headers: a.headers, plies: a.plies })?.id).toBe('x');
    const other = parsePgn(game({ id: 8, moves: MOVES[0] }).pgn!);
    expect(findDuplicate([stored], { headers: other.headers, plies: other.plies })).toBeUndefined();
  });

  it('only reads months inside the window, and never re-reads a finished month', async () => {
    expect(archivesInWindow([API + '2025/01', API + '2026/08', API + '2026/09', API + '2026/10'], NOW, 30)).toEqual([API + '2026/09', API + '2026/10']);
    const { fetcher, calls } = fakeApi({ '2025/01': [game({ month: 1 })], '2026/09': [game({ month: 9, day: 20, moves: MOVES[1] })], '2026/10': [game({ moves: MOVES[0] })] });
    const first = await planSync(opts(), fetcher, []);
    expect(first.toImport).toHaveLength(2);
    expect(calls).toEqual(['player/chunkmonkey420/games/archives', 'player/chunkmonkey420/games/2026/09', 'player/chunkmonkey420/games/2026/10']);
    calls.length = 0;
    const second = await planSync(opts({ now: NOW + 3_600_000 }), fetcher, [], first.state);
    expect(calls).toEqual(['player/chunkmonkey420/games/archives', 'player/chunkmonkey420/games/2026/10']);
    expect(second.toImport.map((c) => c.parsed.headers.date)).toEqual(['2026.10.10']); // September is done; October is re-checked
  });

  it("doesn't call Chess.com again within a minute of the last sync", async () => {
    const { fetcher, calls } = fakeApi({ '2026/10': [] });
    const first = await planSync(opts(), fetcher, []);
    calls.length = 0;
    const again = await planSync(opts({ now: NOW + 20_000 }), fetcher, [], first.state);
    expect(again.cooledDown).toBe(true);
    expect(calls).toHaveLength(0);
    expect(syncSummary(again, 30)).toMatch(/Already synced a moment ago/);
  });

  it('explains unknown users, rate limiting, network errors and malformed responses', async () => {
    const fail = async (f: ChessComFetch, o = opts()) => {
      try {
        await planSync(o, f, []);
      } catch (e) {
        return e as SyncError;
      }
      throw new Error('expected a SyncError');
    };
    expect(await fail(fakeApi({}, 404).fetcher)).toMatchObject({ kind: 'not_found', message: 'Chess.com has no player called "chunkmonkey420".' });
    expect(await fail(fakeApi({ '2026/10': 429 }).fetcher)).toMatchObject({ kind: 'rate_limited', message: expect.stringMatching(/slow down\. Try again in 2 minutes/) });
    expect(await fail(fakeApi({ '2026/10': 503 }).fetcher)).toMatchObject({ kind: 'network' });
    expect(await fail(async () => Promise.reject(new TypeError('Failed to fetch')))).toMatchObject({ kind: 'network', message: expect.stringMatching(/Couldn't reach Chess\.com/) });
    expect(await fail(fakeApi({}, { not: 'a list' }).fetcher)).toMatchObject({ kind: 'bad_response' });
    expect(await fail(fakeApi({ '2026/10': 'malformed' }).fetcher)).toMatchObject({ kind: 'bad_response' });
    expect(await fail(fakeApi({ '2026/10': [] }).fetcher, opts({ username: 'no spaces allowed' }))).toMatchObject({ kind: 'invalid_username' });
  });

  it('skips entries it cannot read instead of failing the whole sync', async () => {
    const broken = { ...game({ moves: MOVES[1] }), pgn: '1. e4 e5 2. Qxx9' };
    const { fetcher } = fakeApi({ '2026/10': [broken, { junk: true } as unknown as ChessComGame, game({ moves: MOVES[0] })] });
    expect((await planSync(opts(), fetcher, [])).toImport).toHaveLength(1);
  });
});

describe('Chess.com proxy', () => {
  it('only forwards the two read-only endpoints, with an identifying User-Agent', async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ua: new Headers(init?.headers).get('user-agent') });
      return new Response('{"archives":[]}', { status: 200 });
    }) as typeof fetch;
    const env = { CHESSCOM_CONTACT: 'me@example.com' };
    const ok = await proxyChessCom('player/chunkmonkey420/games/archives', env, fakeFetch);
    expect(ok).toMatchObject({ status: 200, headers: { 'x-chesscom-proxy': '1' } });
    expect(seen[0]).toEqual({ url: 'https://api.chess.com/pub/player/chunkmonkey420/games/archives', ua: userAgent(env) });
    expect(userAgent(env)).toMatch(/ChessCoach\/1\.0 .*contact: me@example\.com/);
    expect((await proxyChessCom('player/chunkmonkey420/games/2026/09', env, fakeFetch)).headers['cache-control']).toBe('public, max-age=86400');
    for (const bad of ['player/x/stats', 'player/chunkmonkey420', '../../etc', 'https://evil.example/', null]) {
      expect((await proxyChessCom(bad, env, fakeFetch)).status).toBe(400);
    }
    expect(seen).toHaveLength(2);
  });
});
