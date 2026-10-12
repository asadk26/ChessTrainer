// App-level operations that combine storage, engine and coaching.
import type { Color, ParsedGame, StoredGame } from '../domain/types';
import { repo, type ImportSummary } from '../storage/repository';
import { getBrowserEngine } from '../engine/browserEngine';
import { analyzeGame, coachFromPositions, gamePlayedAt, priorGames } from '../analysis/pipeline';
import { isPlaceholderName, rememberUsername } from '../profile/identify';
import { aggregateProfile } from '../profile/profile';
import { buildCoachPrompt, extractJson, mergeLlmOutput } from '../coach/llmCoach';
import { getLlmStatus, llmComplete } from '../coach/llmClient';
import { positionCp, winPercent } from '../analysis/evaluation';

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function importGame(parsed: ParsedGame, userColor: Color): Promise<StoredGame> {
  const userName = userColor === 'w' ? parsed.headers.white : parsed.headers.black;
  const game: StoredGame = {
    id: newId(),
    importedAt: Date.now(),
    pgn: parsed.pgn,
    headers: parsed.headers,
    userColor,
    userName,
    userRating: userColor === 'w' ? parsed.headers.whiteElo : parsed.headers.blackElo,
    opponentName: userColor === 'w' ? parsed.headers.black : parsed.headers.white,
    plies: parsed.plies,
    status: 'imported',
    findings: [],
    moments: [],
    drillIds: [],
    completedMomentIds: [],
  };
  await repo.saveGame(game);
  const settings = await repo.getSettings();
  await repo.saveSettings({
    ...settings,
    usernames: rememberUsername(settings.usernames, userName),
    displayName: settings.displayName ?? (isPlaceholderName(userName) ? undefined : userName),
    rating: game.userRating ?? settings.rating,
  });
  return game;
}

/** Sets the dashboard focus from the most recent analyzed game. */
async function syncFocus() {
  const games = (await repo.listGames()).filter((g) => g.status === 'analyzed' && g.report);
  if (!games.length) return;
  const latest = games.sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a))[0];
  const settings = await repo.getSettings();
  await repo.saveSettings({ ...settings, focus: { ...latest.report!.focus, setAt: Date.now(), gameId: latest.id } });
}

const running = new Map<string, Promise<StoredGame>>();

export function runAnalysis(gameId: string, onProgress: (done: number, total: number) => void): Promise<StoredGame> {
  const existing = running.get(gameId);
  if (existing) return existing;
  const job = (async () => {
    const game = await repo.getGame(gameId);
    if (!game) throw new Error('Game not found');
    const settings = await repo.getSettings();
    const engine = await getBrowserEngine();
    if (!engine) throw new Error('Stockfish could not start in this browser (WebAssembly + Web Workers are required).');
    await repo.saveGame({ ...game, status: 'analyzing' });
    try {
      const all = await repo.listGames();
      const { game: analyzed, drills } = await analyzeGame(game, engine, {
        depth: settings.analysisDepth,
        prior: priorGames(game, all),
        onProgress,
      });
      await repo.saveGame(analyzed);
      await repo.replaceDrillsForGame(analyzed.id, drills);
      await syncFocus();
      return analyzed;
    } catch (e) {
      await repo.saveGame({ ...game, status: 'error', error: (e as Error).message });
      throw e;
    }
  })();
  running.set(gameId, job);
  job.finally(() => running.delete(gameId));
  return job;
}

/** Re-run the coaching layer (not the engine) — e.g. after more games were added. */
export async function recoach(gameId: string): Promise<StoredGame | undefined> {
  const game = await repo.getGame(gameId);
  if (!game?.analysis?.positions.length) return game;
  const all = await repo.listGames();
  const { game: g, drills } = coachFromPositions(game, game.analysis.positions, priorGames(game, all));
  await repo.saveGame(g);
  await repo.replaceDrillsForGame(g.id, drills);
  await syncFocus();
  return g;
}

/** Optional: ask the configured LLM to rewrite the coaching language. */
export async function enrichWithLlm(gameId: string): Promise<StoredGame> {
  const status = await getLlmStatus();
  if (!status.provider) throw new Error('No LLM configured');
  const game = await repo.getGame(gameId);
  if (!game?.report) throw new Error('Analyze the game first');
  const all = await repo.listGames();
  const prior = priorGames(game, all);
  const profile = aggregateProfile(prior.map((p) => ({ gameId: p.gameId, playedAt: p.playedAt, findings: p.findings })));
  const settings = await repo.getSettings();
  const text = await llmComplete(buildCoachPrompt(game, profile, settings.rating), settings.coachToken);
  const { report, moments } = mergeLlmOutput(game, extractJson(text));
  const updated = { ...game, report, moments };
  await repo.saveGame(updated);
  await syncFocus();
  return updated;
}

export async function markMomentDone(gameId: string, momentId: string) {
  const game = await repo.getGame(gameId);
  if (!game || game.completedMomentIds.includes(momentId)) return;
  await repo.saveGame({ ...game, completedMomentIds: [...game.completedMomentIds, momentId] });
}

/** Mover's view of a candidate move (win% and centipawns), from the live engine. Undefined if unavailable. */
export async function evaluateMove(fenAfter: string, depth = 12): Promise<{ win: number; cp: number } | undefined> {
  const engine = await getBrowserEngine();
  if (!engine) return undefined;
  const pos = await engine.analyse(fenAfter, { depth, multiPv: 1 });
  const cp = -positionCp(pos);
  return { win: winPercent(cp), cp };
}

export { closeToBest } from '../analysis/evaluation';

/** Merge a backup file (from Export) into this device's data. */
export async function importBackup(file: File): Promise<ImportSummary> {
  const summary = await repo.importAll(await file.text());
  await syncFocus();
  return summary;
}

export async function exportBackup() {
  const blob = new Blob([await repo.exportAll()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chess-coach-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function deleteGame(id: string) {
  await repo.deleteGame(id);
  await syncFocus();
}
