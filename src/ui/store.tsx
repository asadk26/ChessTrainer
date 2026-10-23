import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AdaptiveSession, Drill, DrillAttempt, PlayerSettings, StoredGame } from '../domain/types';
import { DEFAULT_SETTINGS } from '../storage/repository';
import { repo } from '../storage/repo';
import { getLlmStatus, type LlmStatus } from '../coach/llmClient';

interface AppState {
  loaded: boolean;
  games: StoredGame[];
  drills: Drill[];
  attempts: DrillAttempt[];
  sessions: AdaptiveSession[];
  settings: PlayerSettings;
  llm: LlmStatus;
  refresh(): Promise<void>;
  updateSettings(patch: Partial<PlayerSettings>): Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<AppState, 'refresh' | 'updateSettings'>>({
    loaded: false,
    games: [],
    drills: [],
    attempts: [],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    llm: { provider: null },
  });

  const refresh = useCallback(async () => {
    const [games, drills, attempts, sessions, settings, llm] = await Promise.all([
      repo.listGames(),
      repo.listDrills(),
      repo.listAttempts(),
      repo.listSessions(),
      repo.getSettings(),
      getLlmStatus(),
    ]);
    setState({ loaded: true, games, drills, attempts, sessions, settings, llm });
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<PlayerSettings>) => {
      const s = { ...(await repo.getSettings()), ...patch };
      await repo.saveSettings(s);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ ...state, refresh, updateSettings }), [state, refresh, updateSettings]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

// ------------------------------------------------------------ tiny router

function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function useRoute(): { path: string; parts: string[]; query: URLSearchParams } {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [p, q = ''] = path.split('?');
  return { path: p, parts: p.split('/').filter(Boolean), query: new URLSearchParams(q) };
}

export function navigate(path: string) {
  window.location.hash = path;
  window.scrollTo({ top: 0 });
}
