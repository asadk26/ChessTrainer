// Adaptive Coach Game flow: start → coach moves (Stockfish + lesson-aware selection) → finish →
// the normal analysis pipeline → assessment saved as a training result.
import { Chess } from 'chess.js';
import type { AdaptivePlan, AdaptiveSession, StoredGame } from '../domain/types';
import { repo } from '../storage/repository';
import { getBrowserEngine } from '../engine/browserEngine';
import { parsePgn } from '../chess/pgn';
import { COACH_ENGINE, STRENGTHS, selectCoachMove, type CoachStrength } from '../adaptive/selectMove';
import { bookKey, openingBook, START_FEN } from '../adaptive/planner';
import { assessGame } from '../adaptive/assess';
import { runAnalysis } from './actions';

const newId = () => `acg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export async function startSession(plan: AdaptivePlan, strength: CoachStrength['id']): Promise<AdaptiveSession> {
  const s: AdaptiveSession = {
    id: newId(),
    createdAt: Date.now(),
    plan,
    band: STRENGTHS.find((x) => x.id === strength)!.band,
    depth: COACH_ENGINE.depth,
    moves: [],
    coachLog: [],
    status: 'playing',
  };
  await repo.saveSession(s);
  return s;
}

export function replay(session: AdaptiveSession): Chess {
  const c = new Chess(session.plan.start.fen);
  for (const uci of session.moves) c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
  return c;
}

export async function saveMoves(session: AdaptiveSession, moves: string[], log = session.coachLog): Promise<AdaptiveSession> {
  const next = { ...session, moves, coachLog: log };
  await repo.saveSession(next);
  return next;
}

let book: { color: string; map: Map<string, Set<string>> } | undefined;

/** The coach's reply in the current position. */
export async function coachReply(session: AdaptiveSession): Promise<AdaptiveSession> {
  const engine = await getBrowserEngine();
  if (!engine) throw new Error('Stockfish could not start in this browser.');
  const c = replay(session);
  const fen = c.fen();
  const pos = await engine.analyse(fen, { depth: session.depth, multiPv: COACH_ENGINE.multiPv });
  if (!book || book.color !== session.plan.userColor) book = { color: session.plan.userColor, map: openingBook(await repo.listGames(), session.plan.userColor) };
  const last = c.history({ verbose: true }).at(-1);
  const pick = selectCoachMove(fen, pos, { band: session.band, variety: 1.2 }, { skill: session.plan.skill, lastMoveTo: last?.to, book: book.map.get(bookKey(fen)) });
  if (!pick) throw new Error('The engine returned no move.');
  return saveMoves(session, [...session.moves, pick.uci], [...session.coachLog, { ply: session.moves.length + 1, ...pick.log }]);
}

function pgnFor(session: AdaptiveSession, userName: string, ending: NonNullable<AdaptiveSession['ending']>): string {
  const c = replay(session);
  const user = session.plan.userColor;
  const result =
    ending === 'checkmate' ? (c.turn() === 'w' ? '0-1' : '1-0') : ending === 'draw' ? '1/2-1/2' : ending === 'resigned' ? (user === 'w' ? '0-1' : '1-0') : '*';
  const d = new Date();
  const headers: [string, string][] = [
    ['Event', 'Adaptive Coach Game'],
    ['Site', 'Chess Coach'],
    ['Date', `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`],
    ['White', user === 'w' ? userName : 'Coach'],
    ['Black', user === 'b' ? userName : 'Coach'],
    ['Result', result],
  ];
  if (session.plan.start.fen !== START_FEN) headers.push(['SetUp', '1'], ['FEN', session.plan.start.fen]);
  const moves = c.pgn().replace(/^\[[^\n]*\]\n/gm, '').trim().replace(/\s*\*?$/, '');
  return `${headers.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n${moves} ${result}`;
}

/** Save the game, run the normal analysis, then assess the lesson. */
export async function finishSession(
  session: AdaptiveSession,
  ending: NonNullable<AdaptiveSession['ending']>,
  onProgress: (text: string) => void,
): Promise<{ session: AdaptiveSession; game?: StoredGame }> {
  const settings = await repo.getSettings();
  if (session.moves.length < 2) {
    const abandoned = { ...session, status: 'abandoned' as const, ending, finishedAt: Date.now() };
    await repo.saveSession(abandoned);
    return { session: abandoned };
  }
  let s: AdaptiveSession = { ...session, status: 'analysing', ending };
  await repo.saveSession(s);
  let gameId = s.gameId;
  if (!gameId) {
    const parsed = parsePgn(pgnFor(s, settings.displayName ?? 'You', ending));
    const user = s.plan.userColor;
    // Saved directly (not via importGame): never merged with another game, never changes your settings.
    const game: StoredGame = {
      id: `${s.id}-game`,
      importedAt: Date.now(),
      pgn: parsed.pgn,
      headers: parsed.headers,
      userColor: user,
      userName: user === 'w' ? parsed.headers.white : parsed.headers.black,
      opponentName: 'Coach',
      plies: parsed.plies,
      status: 'imported',
      findings: [],
      moments: [],
      drillIds: [],
      completedMomentIds: [],
      adaptive: { sessionId: s.id, skill: s.plan.skill },
    };
    await repo.saveGame(game);
    gameId = game.id;
    s = { ...s, gameId };
    await repo.saveSession(s);
  }
  const game = await runAnalysis(gameId, (done, total) => onProgress(`Analysing your game… ${done}/${total}`));
  const result = assessGame(game, s.plan);
  s = { ...s, status: 'done', result, finishedAt: Date.now() };
  await repo.saveSession(s);
  return { session: s, game };
}

export async function abandonSession(session: AdaptiveSession) {
  await repo.saveSession({ ...session, status: 'abandoned', finishedAt: Date.now() });
}
