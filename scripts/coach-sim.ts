// Developer tool: simulate Adaptive Coach games against a rough club-level player, run the normal
// analysis and the lesson assessment, and report how often each mode produces a real test.
//
//   npx tsx scripts/coach-sim.ts [gamesPerSkill=6] [strength=steady] [skill]
//
// SIM_USER=club gives a steadier player (fewer random moves). The simulated player is crude (Stockfish at low depth, picking among its top moves with an
// occasional random move): good for measuring steering and validity rates, not for judging how
// the coach feels — that needs real playtests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { createNodeEngine } from '../server/nodeEngine.ts';
import { coachFromPositions } from '../src/analysis/pipeline.ts';
import { evaluatePositions } from '../src/analysis/analyzeGame.ts';
import { parsePgn } from '../src/chess/pgn.ts';
import type { AdaptiveSkill, Color, PositionEval, StoredGame } from '../src/domain/types.ts';
import { COACH_ENGINE, STRENGTHS, selectCoachMove } from '../src/adaptive/selectMove.ts';
import { assessGame } from '../src/adaptive/assess.ts';
import { conversionStart, START_FEN } from '../src/adaptive/planner.ts';
import { notQuietBecause } from '../src/adaptive/features.ts';

const [nArg = '6', strengthArg = 'steady', onlySkill] = process.argv.slice(2);
const N = Number(nArg);
const band = STRENGTHS.find((s) => s.id === strengthArg)!.band;
const engine = createNodeEngine();
let seed = 12345;
const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function stored(pgn: string, color: Color, id: string): StoredGame {
  const g = parsePgn(pgn);
  return { id, importedAt: Date.now(), pgn: g.pgn, headers: g.headers, userColor: color, userName: 'me', opponentName: 'them', plies: g.plies, status: 'imported', findings: [], moments: [], drillIds: [], completedMomentIds: [] };
}

// Real analysed games from the test fixtures, for conversion start positions.
const FIX = join(import.meta.dirname, '..', 'tests', 'fixtures');
const fixtures = (['winning-game', 'knight-trip-game', 'kingside-storm-game', 'chaotic-game', 'black-win-game', 'queen-blunder-game', 'queen-hunt-game', 'resign-win-game', 'draw-game', 'sicilian-win-game'] as const).map((n) => {
  const color: Color = ['knight-trip-game', 'black-win-game', 'queen-blunder-game', 'queen-hunt-game', 'resign-win-game', 'draw-game'].includes(n) ? 'b' : 'w';
  const g = stored(readFileSync(join(FIX, `${n}.pgn`), 'utf8'), color, n);
  return coachFromPositions(g, JSON.parse(readFileSync(join(FIX, `${n}-positions.json`), 'utf8')) as PositionEval[], []).game;
});

/** ~900–1100: usually a decent move, sometimes a worse one, occasionally a random one. */
async function userMove(fen: string): Promise<string> {
  const c = new Chess(fen);
  const club = process.env.SIM_USER === 'club';
  if (rng() < (club ? 0.02 : 0.06)) {
    const ms = c.moves({ verbose: true });
    return ms[Math.floor(rng() * ms.length)].lan;
  }
  const p = await engine.analyse(fen, { depth: club ? 8 : 6, multiPv: 4 });
  const r = rng();
  const i = club ? (r < 0.6 ? 0 : r < 0.85 ? 1 : r < 0.95 ? 2 : 3) : r < 0.45 ? 0 : r < 0.7 ? 1 : r < 0.87 ? 2 : 3;
  return (p.lines[Math.min(i, p.lines.length - 1)] ?? p.lines[0]).pv[0];
}

async function play(skill: AdaptiveSkill, startFen: string, user: Color, maxPlies: number) {
  const c = new Chess(startFen);
  const log: { gap: number; reason: string }[] = [];
  for (let i = 0; i < maxPlies && !c.isGameOver(); i++) {
    const fen = c.fen();
    let uci: string;
    if (c.turn() === user) uci = await userMove(fen);
    else {
      const pos = await engine.analyse(fen, COACH_ENGINE);
      const pick = selectCoachMove(fen, pos, { band, strength: strengthArg as never }, { skill, lastMoveTo: c.history({ verbose: true }).at(-1)?.to, rng })!;
      log.push({ gap: pick.log.gap, reason: pick.log.reason });
      uci = pick.uci;
    }
    c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
  }
  const header = startFen === START_FEN ? '' : `[SetUp "1"]\n[FEN "${startFen}"]\n`;
  const pgn = `${header}[White "${user === 'w' ? 'me' : 'Coach'}"]\n[Black "${user === 'b' ? 'me' : 'Coach'}"]\n\n${c.pgn().replace(/^\[[^\n]*\]\n/gm, '').trim()}`;
  const g = stored(pgn, user, 'sim');
  const positions = await evaluatePositions(g.plies, engine, { depth: 12, multiPv: 3 });
  return { game: coachFromPositions(g, positions, []).game, log };
}

const skills: AdaptiveSkill[] = onlySkill ? [onlySkill as AdaptiveSkill] : ['positional_patience', 'development_discipline', 'conversion'];
for (const skill of skills) {
  const rows: string[] = [];
  const used: { id: string; createdAt: number; status: string; plan: { start: { fen: string; key: string; kind: string } } }[] = [];
  const verdicts: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let gaps: number[] = [];
  let moments = 0;
  for (let k = 0; k < N; k++) {
    const user: Color = k % 2 ? 'b' : 'w';
    let start = START_FEN;
    let userColor = user;
    if (skill === 'conversion') {
      const pos = conversionStart(fixtures, used as never[])!;
      used.push({ id: `s${k}`, createdAt: k, status: 'done', plan: { start: { fen: pos.fen, key: pos.key, kind: 'historical' } } });
      start = pos.fen;
      userColor = pos.game.userColor;
    }
    const { game, log } = await play(skill, start, userColor, skill === 'development_discipline' ? 40 : 70);
    const r = assessGame(game, { skill, basis: 'history', reason: '', desiredPosition: '', coachPreferences: [], successSignals: [], failureSignals: [], evidence: [], userColor, start: { fen: start } });
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    for (const l of log) reasons[l.reason] = (reasons[l.reason] ?? 0) + 1;
    gaps = gaps.concat(log.filter((l) => l.reason !== 'best' && l.reason !== 'only').map((l) => l.gap));
    moments += r.stats.quietMoves ?? r.stats.userMoves ?? 0;
    const why: Record<string, number> = {};
    game.plies.forEach((p, i) => {
      if (p.color === userColor && p.moveNumber <= 30) {
        const w = notQuietBecause(p, game.analysis!.moves[i], game.plies[i - 1]) ?? 'QUIET';
        why[w] = (why[w] ?? 0) + 1;
      }
    });
    rows.push(`  ${k + 1}. ${userColor} ${game.plies.length} plies → ${r.verdict}  ${JSON.stringify(r.stats)}${skill === 'positional_patience' ? `  why: ${JSON.stringify(why)}` : ''}`);
    console.log(rows.at(-1));
  }
  const coachMoves = Object.values(reasons).reduce((a, b) => a + b, 0);
  console.log(
    `${skill} [${strengthArg}]: verdicts ${JSON.stringify(verdicts)}; avg test moments ${(moments / N).toFixed(1)}; coach moves ${JSON.stringify(reasons)}; ` +
      `non-best ${(((coachMoves - (reasons.best ?? 0) - (reasons.only ?? 0)) / coachMoves) * 100).toFixed(0)}%, avg gap ${(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length)).toFixed(1)}, max ${Math.max(0, ...gaps).toFixed(1)}`,
  );
}
engine.dispose();
