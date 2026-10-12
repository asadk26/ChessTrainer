// Storage boundary. The app only talks to this interface, so moving from
// localStorage to IndexedDB or Supabase/Postgres means writing one new class.
// Suggested table mapping: games, drills, drill_attempts, player_settings
// (findings/moments/report can live as JSONB columns on games).
import type { Drill, DrillAttempt, PlayerSettings, StoredGame } from '../domain/types';

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
  importAll(json: string): Promise<void>;
}

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
  async exportAll() {
    return JSON.stringify(
      {
        version: 1,
        games: await this.listGames(),
        drills: await this.listDrills(),
        attempts: await this.listAttempts(),
        settings: await this.getSettings(),
      },
      null,
      2,
    );
  }
  async importAll(json: string) {
    const data = JSON.parse(json);
    if (data.version !== 1) throw new Error('Unsupported backup version');
    for (const g of data.games ?? []) await this.saveGame(g);
    this.write('drills', data.drills ?? []);
    this.write('attempts', data.attempts ?? []);
    if (data.settings) await this.saveSettings(data.settings);
  }
}

export const repo: CoachRepository = new LocalStorageRepository(
  typeof localStorage !== 'undefined' ? localStorage : memoryStore(),
);
