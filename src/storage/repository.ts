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

const PREFIX = 'chesscoach:v1:';

/** Minimal Storage-like interface so tests can pass an in-memory map. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

export class LocalStorageRepository implements CoachRepository {
  constructor(private store: KeyValueStore = globalThis.localStorage) {}

  private read<T>(key: string, fallback: T): T {
    try {
      const raw = this.store.getItem(PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown) {
    this.store.setItem(PREFIX + key, JSON.stringify(value));
  }

  private gameIds(): string[] {
    return this.read<string[]>('games:index', []);
  }

  async listGames() {
    return this.gameIds()
      .map((id) => this.read<StoredGame | undefined>(`game:${id}`, undefined))
      .filter((g): g is StoredGame => !!g);
  }
  async getGame(id: string) {
    return this.read<StoredGame | undefined>(`game:${id}`, undefined);
  }
  async saveGame(game: StoredGame) {
    const ids = this.gameIds();
    if (!ids.includes(game.id)) this.write('games:index', [...ids, game.id]);
    this.write(`game:${game.id}`, game);
  }
  async deleteGame(id: string) {
    this.write('games:index', this.gameIds().filter((x) => x !== id));
    this.store.removeItem(PREFIX + `game:${id}`);
    await this.replaceDrillsForGame(id, []);
  }
  async listDrills() {
    return this.read<Drill[]>('drills', []);
  }
  async replaceDrillsForGame(gameId: string, drills: Drill[]) {
    const rest = (await this.listDrills()).filter((d) => d.gameId !== gameId);
    this.write('drills', [...rest, ...drills]);
  }
  async listAttempts() {
    return this.read<DrillAttempt[]>('attempts', []);
  }
  async addAttempt(a: DrillAttempt) {
    this.write('attempts', [...(await this.listAttempts()), a]);
  }
  async getSettings() {
    return { ...DEFAULT_SETTINGS, ...this.read<Partial<PlayerSettings>>('settings', {}) };
  }
  async saveSettings(s: PlayerSettings) {
    this.write('settings', s);
  }
  async getSyncState() {
    return this.read<SyncState | undefined>('chesscomSync', undefined);
  }
  async saveSyncState(s: SyncState | undefined) {
    if (s) this.write('chesscomSync', s);
    else this.store.removeItem(PREFIX + 'chesscomSync');
  }
  async listSessions() {
    return this.read<AdaptiveSession[]>('adaptiveSessions', []);
  }
  async saveSession(s: AdaptiveSession) {
    this.write('adaptiveSessions', [...(await this.listSessions()).filter((x) => x.id !== s.id), s]);
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

  async importAll(json: string): Promise<ImportSummary> {
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
        await this.saveGame(g);
        summary.gamesAdded++;
      } else if (freshness(g) > freshness(existing)) {
        await this.saveGame({
          ...g,
          completedMomentIds: [...new Set([...existing.completedMomentIds, ...g.completedMomentIds])],
          feedback: mergeFeedback(existing.feedback, g.feedback),
        });
        summary.gamesUpdated++;
      } else {
        // Keep this device's analysis, but never drop feedback notes from the other device.
        const feedback = mergeFeedback(existing.feedback, g.feedback);
        if ((feedback?.length ?? 0) > (existing.feedback?.length ?? 0)) await this.saveGame({ ...existing, feedback });
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
    this.write('drills', [...drills.values()]);

    const attempts = await this.listAttempts();
    const seen = new Set(attempts.map((a) => `${a.drillId}@${a.at}`));
    for (const a of data.attempts ?? []) {
      if (a && !seen.has(`${a.drillId}@${a.at}`)) {
        attempts.push(a);
        seen.add(`${a.drillId}@${a.at}`);
        summary.attempts++;
      }
    }
    this.write('attempts', attempts);

    const sessions = new Map((await this.listSessions()).map((x) => [x.id, x]));
    for (const x of data.adaptiveSessions ?? []) {
      const mine = x && typeof x.id === 'string' ? sessions.get(x.id) : undefined;
      if (x && typeof x.id === 'string' && (!mine || (x.finishedAt ?? 0) > (mine.finishedAt ?? 0))) sessions.set(x.id, x);
    }
    this.write('adaptiveSessions', [...sessions.values()]);

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

export const repo: CoachRepository = new LocalStorageRepository(
  typeof localStorage !== 'undefined' ? localStorage : memoryStore(),
);
