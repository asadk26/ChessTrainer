// Storage boundary. The app only talks to this interface, so moving from
// localStorage to IndexedDB or Supabase/Postgres means writing one new class.
// Suggested table mapping: games, drills, drill_attempts, player_settings
// (findings/moments/report can live as JSONB columns on games).
import type { AdaptiveSession, Drill, DrillAttempt, PlayerSettings, StoredGame } from '../domain/types';
import type { SyncState } from '../sync/chesscom';
import { mergeFeedback } from '../coach/feedback';

export interface CoachRepository {
  listGames(): Promise<StoredGame[]>;
  getGame(id: string): Promise<StoredGame | undefined>;
  saveGame(game: StoredGame): Promise<void>;
  deleteGame(id: string): Promise<void>;
  listDrills(): Promise<Drill[]>;
  replaceDrillsForGame(gameId: string, drills: Drill[]): Promise<void>;
  listAttempts(): Promise<DrillAttempt[]>;
  addAttempt(a: DrillAttempt): Promise<void>;
  getSettings(): Promise<PlayerSettings>;
  saveSettings(s: PlayerSettings): Promise<void>;
  exportAll(): Promise<string>;
  /** Merge a backup into the current data (never deletes anything). */
  importAll(json: string): Promise<ImportSummary>;
  /** Chess.com sync bookkeeping (which finished months were already read). Not part of backups. */
  getSyncState(): Promise<SyncState | undefined>;
  saveSyncState(s: SyncState | undefined): Promise<void>;
  /** Adaptive Coach Game sessions (training results; part of backups). */
  listSessions(): Promise<AdaptiveSession[]>;
  saveSession(s: AdaptiveSession): Promise<void>;
}

export interface ImportSummary {
  gamesAdded: number;
  gamesUpdated: number;
  gamesKept: number;
  drills: number;
  attempts: number;
}

export class BackupError extends Error {}

export const DEFAULT_SETTINGS: PlayerSettings = {
  usernames: {},
  rating: 850,
  analysisDepth: 12,
  useLlm: true,
};

export const PREFIX = 'chesscoach:v1:';

/** Minimal Storage-like interface so tests can pass an in-memory map. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The same, asynchronous (IndexedDB). */
export interface AsyncKeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The app's localStorage entries (only keys with the app prefix). */
export function prefixedEntries(ls: Pick<Storage, 'length' | 'key' | 'getItem'>): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    const v = k?.startsWith(PREFIX) ? ls.getItem(k) : null;
    if (k && v !== null) out.push([k, v]);
  }
  return out;
}

export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

export function asAsync(s: KeyValueStore): AsyncKeyValueStore {
  return {
    get: async (k) => s.getItem(k),
    set: async (k, v) => s.setItem(k, v),
    remove: async (k) => s.removeItem(k),
  };
}

/**
 * Key-value backed repository (IndexedDB in the browser, an in-memory map in tests). Every
 * read-modify-write runs one at a time, so a sync importing games while the analysis queue
 * saves results can never lose an entry.
 */
export class KvRepository implements CoachRepository {
  private store: AsyncKeyValueStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: KeyValueStore | AsyncKeyValueStore) {
    this.store = 'getItem' in store ? asAsync(store) : store;
  }

  private atomic<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read<T>(key: string, fallback: T): Promise<T> {
    try {
      const raw = await this.store.get(PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown) {
    return this.store.set(PREFIX + key, JSON.stringify(value));
  }

  private gameIds(): Promise<string[]> {
    return this.read<string[]>('games:index', []);
  }

  async listGames() {
    const games = await Promise.all((await this.gameIds()).map((id) => this.read<StoredGame | undefined>(`game:${id}`, undefined)));
    return games.filter((g): g is StoredGame => !!g);
  }
  async getGame(id: string) {
    return this.read<StoredGame | undefined>(`game:${id}`, undefined);
  }
  private async putGame(game: StoredGame) {
    const ids = await this.gameIds();
    if (!ids.includes(game.id)) await this.write('games:index', [...ids, game.id]);
    await this.write(`game:${game.id}`, game);
  }
  saveGame(game: StoredGame) {
    return this.atomic(() => this.putGame(game));
  }
  private async putDrillsForGame(gameId: string, drills: Drill[]) {
    const rest = (await this.listDrills()).filter((d) => d.gameId !== gameId);
    await this.write('drills', [...rest, ...drills]);
  }
  deleteGame(id: string) {
    return this.atomic(async () => {
      await this.write('games:index', (await this.gameIds()).filter((x) => x !== id));
      await this.store.remove(PREFIX + `game:${id}`);
      await this.putDrillsForGame(id, []);
    });
  }
  async listDrills() {
    return this.read<Drill[]>('drills', []);
  }
  replaceDrillsForGame(gameId: string, drills: Drill[]) {
    return this.atomic(() => this.putDrillsForGame(gameId, drills));
  }
  async listAttempts() {
    return this.read<DrillAttempt[]>('attempts', []);
  }
  addAttempt(a: DrillAttempt) {
    return this.atomic(async () => this.write('attempts', [...(await this.listAttempts()), a]));
  }
  async getSettings() {
    return { ...DEFAULT_SETTINGS, ...(await this.read<Partial<PlayerSettings>>('settings', {})) };
  }
  async saveSettings(s: PlayerSettings) {
    await this.write('settings', s);
  }
  async getSyncState() {
    return this.read<SyncState | undefined>('chesscomSync', undefined);
  }
  async saveSyncState(s: SyncState | undefined) {
    if (s) await this.write('chesscomSync', s);
    else await this.store.remove(PREFIX + 'chesscomSync');
  }
  async listSessions() {
    return this.read<AdaptiveSession[]>('adaptiveSessions', []);
  }
  saveSession(s: AdaptiveSession) {
    return this.atomic(async () => this.write('adaptiveSessions', [...(await this.listSessions()).filter((x) => x.id !== s.id), s]));
  }
  async exportAll() {
    return JSON.stringify(
      {
        app: 'chess-coach',
        version: 1,
        exportedAt: new Date().toISOString(),
        games: await this.listGames(),
        drills: await this.listDrills(),
        attempts: await this.listAttempts(),
        adaptiveSessions: await this.listSessions(),
        settings: { ...(await this.getSettings()), coachToken: undefined },
      },
      null,
      2,
    );
  }

  importAll(json: string): Promise<ImportSummary> {
    return this.atomic(() => this.importUnlocked(json));
  }

  private async importUnlocked(json: string): Promise<ImportSummary> {
    let data: Partial<Backup>;
    try {
      data = JSON.parse(json);
    } catch {
      throw new BackupError("This file isn't valid JSON.");
    }
    if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.games)) {
      throw new BackupError("This doesn't look like a Chess Coach backup (expected an export from this app).");
    }
    const summary: ImportSummary = { gamesAdded: 0, gamesUpdated: 0, gamesKept: 0, drills: 0, attempts: 0 };
    const freshness = (g: StoredGame) => g.analysis?.analyzedAt ?? g.importedAt ?? 0;

    for (const g of data.games) {
      if (!g || typeof g.id !== 'string' || !Array.isArray(g.plies)) continue;
      const existing = await this.getGame(g.id);
      if (!existing) {
        await this.putGame(g);
        summary.gamesAdded++;
      } else if (freshness(g) > freshness(existing)) {
        await this.putGame({
          ...g,
          completedMomentIds: [...new Set([...existing.completedMomentIds, ...g.completedMomentIds])],
          feedback: mergeFeedback(existing.feedback, g.feedback),
        });
        summary.gamesUpdated++;
      } else {
        // Keep this device's analysis, but never drop feedback notes from the other device.
        const feedback = mergeFeedback(existing.feedback, g.feedback);
        if ((feedback?.length ?? 0) > (existing.feedback?.length ?? 0)) await this.putGame({ ...existing, feedback });
        summary.gamesKept++;
      }
    }

    const drills = new Map((await this.listDrills()).map((d) => [d.id, d]));
    for (const d of data.drills ?? []) {
      if (d && typeof d.id === 'string' && !drills.has(d.id)) {
        drills.set(d.id, d);
        summary.drills++;
      }
    }
    await this.write('drills', [...drills.values()]);

    const attempts = await this.listAttempts();
    const seen = new Set(attempts.map((a) => `${a.drillId}@${a.at}`));
    for (const a of data.attempts ?? []) {
      if (a && !seen.has(`${a.drillId}@${a.at}`)) {
        attempts.push(a);
        seen.add(`${a.drillId}@${a.at}`);
        summary.attempts++;
      }
    }
    await this.write('attempts', attempts);

    const sessions = new Map((await this.listSessions()).map((x) => [x.id, x]));
    for (const x of data.adaptiveSessions ?? []) {
      const mine = x && typeof x.id === 'string' ? sessions.get(x.id) : undefined;
      if (x && typeof x.id === 'string' && (!mine || (x.finishedAt ?? 0) > (mine.finishedAt ?? 0))) sessions.set(x.id, x);
    }
    await this.write('adaptiveSessions', [...sessions.values()]);

    if (data.settings) {
      const local = await this.getSettings();
      const incoming = { ...DEFAULT_SETTINGS, ...data.settings };
      const usernames = { ...local.usernames };
      for (const [k, n] of Object.entries(incoming.usernames ?? {})) usernames[k] = Math.max(usernames[k] ?? 0, n);
      const hadData = summary.gamesKept + summary.gamesUpdated > 0 || (await this.listGames()).length > summary.gamesAdded;
      await this.saveSettings({
        ...(hadData ? local : incoming),
        usernames,
        displayName: local.displayName ?? incoming.displayName,
        coachToken: local.coachToken,
        focus: (incoming.focus?.setAt ?? 0) > (local.focus?.setAt ?? 0) ? incoming.focus : local.focus,
      });
    }
    return summary;
  }
}

interface Backup {
  app: string;
  version: number;
  games: StoredGame[];
  drills: Drill[];
  attempts: DrillAttempt[];
  adaptiveSessions?: AdaptiveSession[];
  settings: PlayerSettings;
}

/** Kept for tests and older code: the same repository over a synchronous store. */
export class LocalStorageRepository extends KvRepository {
  constructor(store: KeyValueStore = globalThis.localStorage) {
    super(store);
  }
}
