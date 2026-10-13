// App-level operations that combine storage, engine and coaching.
import type { AiExplanation, BetaCoachReview, CoachFeedback, Color, ParsedGame, PositionEval, StoredGame } from '../domain/types';
import { buildMomentContext, momentPrompt, parseMomentExplanation } from '../coach/momentContext';
import { feedbackReport } from '../coach/feedback';
import { betaPrompt, buildBetaContext, parseBetaReview } from '../coach/betaCoach';
import { outcomeFromResult, type Outcome } from '../chess/outcome';
import { findDuplicate } from '../chess/fingerprint';
import { planSync, syncSummary, SyncError, type ChessComFetch } from '../sync/chesscom';
import { chesscomFetch } from '../sync/chesscomClient';
import { REPORT_VERSION } from '../coach/report';
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

/**
 * The one way games get in — pasted PGN or Chess.com sync. A game that's already
 * here (same site id, or the same moves) isn't added twice; the existing one is returned.
 */
export async function importGame(
  parsed: ParsedGame,
  userColor: Color,
  outcome?: Outcome,
  source?: StoredGame['source'],
): Promise<{ game: StoredGame; duplicate: boolean }> {
  const existing = findDuplicate(await repo.listGames(), { headers: parsed.headers, plies: parsed.plies, source });
  if (existing) return { game: existing, duplicate: true };
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
    // Only stored when it differs from what the PGN says (or the PGN has no result).
    outcome: outcome && outcome !== outcomeFromResult(parsed.headers.result, userColor) ? outcome : undefined,
    source,
  };
  await repo.saveGame(game);
  const settings = await repo.getSettings();
  await repo.saveSettings({
    ...settings,
    usernames: rememberUsername(settings.usernames, userName),
    displayName: settings.displayName ?? (isPlaceholderName(userName) ? undefined : userName),
    rating: game.userRating ?? settings.rating,
  });
  return { game, duplicate: false };
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
  const clear = () => void running.delete(gameId);
  job.then(clear, clear);
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

/** Save a "this seems wrong" note on a game. */
export async function addFeedback(gameId: string, f: Omit<CoachFeedback, 'id' | 'createdAt' | 'reportVersion'>): Promise<void> {
  const game = await repo.getGame(gameId);
  if (!game) return;
  const note: CoachFeedback = { ...f, id: newId(), createdAt: Date.now(), reportVersion: game.report?.version };
  await repo.saveGame({ ...game, feedback: [...(game.feedback ?? []), note] });
}

export async function removeFeedback(gameId: string, id: string): Promise<void> {
  const game = await repo.getGame(gameId);
  if (!game?.feedback) return;
  const feedback = game.feedback.filter((f) => f.id !== id);
  await repo.saveGame({ ...game, feedback: feedback.length ? feedback : undefined });
}

/** All feedback as Markdown: copied to the clipboard when possible, otherwise downloaded. */
export async function exportFeedback(): Promise<'copied' | 'downloaded'> {
  const text = feedbackReport(await repo.listGames(), REPORT_VERSION);
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    downloadFeedback(text);
    return 'downloaded';
  }
}

export async function downloadFeedback(text?: string) {
  const body = text ?? feedbackReport(await repo.listGames(), REPORT_VERSION);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/markdown' }));
  a.download = `chess-coach-feedback-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The player corrects how the game ended; the coaching is re-run (no engine needed). */
export async function setOutcome(gameId: string, outcome: Outcome) {
  const game = await repo.getGame(gameId);
  if (!game) return;
  await repo.saveGame({ ...game, outcome: outcome === outcomeFromResult(game.headers.result, game.userColor) ? undefined : outcome });
  await recoach(gameId);
}

/** How many new games one sync brings in; the rest come next time (analysis takes a while). */
export const SYNC_MAX_GAMES = 10;

export interface SyncResult {
  message: string;
  imported: StoredGame[];
}

/**
 * Manual Chess.com sync: find new games in the last N days, import them through
 * importGame (same model, dedupe and pipeline as pasted games), then analyse them
 * one at a time, oldest first, so each game's coaching sees the ones before it.
 */
export async function syncChessCom(onProgress?: (text: string) => void, fetcher: ChessComFetch = chesscomFetch): Promise<SyncResult> {
  const settings = await repo.getSettings();
  const cfg = settings.chesscom;
  if (!cfg?.username) throw new SyncError('invalid_username', 'Add your Chess.com username in Settings first.');
  onProgress?.('Checking Chess.com…');
  const plan = await planSync(
    { username: cfg.username, days: cfg.days, timeClasses: cfg.timeClasses, now: Date.now(), maxGames: SYNC_MAX_GAMES },
    fetcher,
    await repo.listGames(),
    await repo.getSyncState(),
  );
  const imported: StoredGame[] = [];
  for (const c of plan.toImport) {
    const { game, duplicate } = await importGame(c.parsed, c.color, undefined, c.source);
    if (!duplicate) imported.push(game);
  }
  await repo.saveSyncState(plan.state);
  const message = syncSummary({ ...plan, toImport: imported.length === plan.toImport.length ? plan.toImport : plan.toImport.slice(0, imported.length) }, cfg.days);
  return { message, imported };
}

/** Analyse games one after another (Stockfish runs one position at a time anyway). */
export async function analyzeInOrder(games: StoredGame[], onProgress?: (done: number, total: number, current: StoredGame) => void) {
  for (let i = 0; i < games.length; i++) {
    onProgress?.(i, games.length, games[i]);
    try {
      await runAnalysis(games[i].id, () => undefined);
    } catch (e) {
      console.warn('Analysis failed for synced game', games[i].id, e);
    }
  }
  onProgress?.(games.length, games.length, games[games.length - 1]);
}

const liveCache = new Map<string, Promise<PositionEval | undefined>>();

/** Live engine analysis of one position (cached per position/depth), for the practice board. */
export function analysePosition(fen: string, depth: number, multiPv = 1): Promise<PositionEval | undefined> {
  const key = `${fen}|${depth}|${multiPv}`;
  let p = liveCache.get(key);
  if (!p) {
    p = getBrowserEngine()
      .then((engine) => (engine ? engine.analyse(fen, { depth, multiPv }) : undefined))
      .catch(() => undefined);
    liveCache.set(key, p);
  }
  return p;
}

/** Is an AI instructor available and switched on (and, when hosted, unlocked)? */
export async function aiReady(): Promise<boolean> {
  const status = await getLlmStatus();
  const settings = await repo.getSettings();
  return !!status.provider && settings.useLlm && (!status.requiresToken || !!settings.coachToken);
}

const inflight = new Map<string, Promise<AiExplanation>>();

/**
 * An AI explanation of the move at `ply`, grounded in the stored Stockfish analysis.
 * Cached on the game: revisiting costs nothing unless `force` asks to regenerate.
 */
export function explainPosition(gameId: string, ply: number, opts: { force?: boolean } = {}): Promise<AiExplanation> {
  const key = `${gameId}:${ply}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const game = await repo.getGame(gameId);
    if (!game) throw new Error('Game not found');
    const cached = game.aiExplanations?.[ply];
    const all = await repo.listGames();
    const settings = await repo.getSettings();
    const ctx = buildMomentContext(game, ply, { rating: settings.rating, prior: priorGames(game, all) });
    if (!ctx) throw new Error('No engine analysis for this move yet.');
    if (cached && !opts.force && cached.grounding === ctx.grounding) return cached;
    const status = await getLlmStatus();
    if (!status.provider) throw new Error('No AI coach is configured.');
    const text = await llmComplete(momentPrompt(ctx), settings.coachToken, 4096, 'moment');
    const expl = parseMomentExplanation(text, ctx, ply, status.model);
    const fresh = (await repo.getGame(gameId)) ?? game;
    await repo.saveGame({ ...fresh, aiExplanations: { ...(fresh.aiExplanations ?? {}), [ply]: expl } });
    return expl;
  })();
  inflight.set(key, job);
  const clear = () => void inflight.delete(key);
  job.then(clear, clear);
  return job;
}

/** Lessons whose automatic explanation failed this session (not retried automatically). */
const failedLessons = new Set<string>();

/** Richer explanations for the 1–2 lessons of a game (only those, and only if not cached). */
export async function explainLessons(gameId: string): Promise<number> {
  if (!(await aiReady())) return 0;
  const game = await repo.getGame(gameId);
  if (!game) return 0;
  let n = 0;
  for (const m of game.moments.filter((x) => x.tier === 'lesson' && x.kind === 'mistake')) {
    if (game.aiExplanations?.[m.betterPly] || failedLessons.has(`${gameId}:${m.betterPly}`)) continue;
    try {
      await explainPosition(gameId, m.betterPly);
      n++;
    } catch (e) {
      console.warn('AI explanation failed; the built-in coaching stays.', e);
      failedLessons.add(`${gameId}:${m.betterPly}`);
    }
  }
  return n;
}

const betaInflight = new Map<string, Promise<BetaCoachReview>>();

/**
 * The Beta AI Coach's whole-game review (summary, insights, one training priority).
 * Cached on the game; only regenerated when asked (`force`).
 */
export function betaReview(gameId: string, opts: { force?: boolean } = {}): Promise<BetaCoachReview> {
  const running = betaInflight.get(gameId);
  if (running) return running;
  const job = (async () => {
    const game = await repo.getGame(gameId);
    if (!game) throw new Error('Game not found');
    if (game.aiCoach && !opts.force) return game.aiCoach;
    const settings = await repo.getSettings();
    const ctx = buildBetaContext(game, await repo.listGames(), settings.rating);
    if (!ctx) throw new Error('No engine analysis for this game yet.');
    const status = await getLlmStatus();
    if (!status.provider) throw new Error('No AI coach is configured.');
    const text = await llmComplete(betaPrompt(ctx), settings.coachToken, 12000, 'beta');
    const review = parseBetaReview(text, ctx, game, status.model);
    const fresh = (await repo.getGame(gameId)) ?? game;
    await repo.saveGame({ ...fresh, aiCoach: review });
    return review;
  })();
  betaInflight.set(gameId, job);
  const clear = () => void betaInflight.delete(gameId);
  job.then(clear, clear);
  return job;
}
