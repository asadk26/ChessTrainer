// Beta AI Coach (v2): Stockfish is the referee, the model is the instructor.
//
// The model gets the whole game's engine evidence — every half-move's evaluation,
// where the evaluation trend shifted, Stockfish's candidates and short lines around
// those shifts, the material timeline, positional checkpoints — and decides for
// itself what the game's phases and instructive turning points were. Nothing here
// tells it which moments are the lessons.
//
// What it writes is then refereed sentence by sentence: moves must exist (in the
// game, in Stockfish's lines, or legal at that point), and concrete claims —
// material, mates, unstoppable pawns, "losing", praising a move Stockfish condemns,
// recommending a move Stockfish didn't consider — must agree with the engine data.
// Broad instructional judgements ("you became impatient") are left free.
import { Chess } from 'chess.js';
import type { BetaChapter, BetaCoachReview, Color, MoveEval, PositionEval, StoredGame } from '../domain/types';
import { COLOR_NAME, kingInCenter, kingSquare, materialBalance, materialPhrase, nonPawnMaterial, other, passedPawns, pawnWeaknesses, sideToMove, undevelopedMinors } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { MATE_CP, positionCp, scoreToCp, winPercent } from '../analysis/evaluation';
import { buildMoveEvals } from '../analysis/analyzeGame';
import { QUALITY_LABEL, rankCandidates } from '../analysis/moveQuality';
import { lineToPoint } from '../analysis/linePoint';
import { moveAccuracy, verdictOf, type Verdict } from '../analysis/engineReview';
import { CATEGORIES, STRENGTHS } from '../domain/categories';
import { userOutcome } from '../chess/outcome';
import { gamePlayedAt, priorGames } from '../analysis/pipeline';
import { extractJson } from './llmCoach';
import { recurringPatterns, UngroundedError } from './momentContext';

export const BETA_VERSION = 2;
export const BETA_DEEP_DEPTH = 18;

const strip = (san: string) => san.replace(/[+#?!]+$/, '');
const isMate = (cp: number) => Math.abs(cp) >= MATE_CP - 1000;
const BAD: Verdict[] = ['mistake', 'blunder'];
const FINE: Verdict[] = ['best', 'equal'];

/** Student-POV evaluation, compact: "+0.7", "-2.3", "mate in 3 for you", "mate in 2 against you". */
export function fmtEval(cp: number): string {
  if (isMate(cp)) {
    const n = Math.max(1, Math.round((MATE_CP - Math.abs(cp)) / 10));
    return cp > 0 ? `mate in ${n} for you` : `mate in ${n} against you`;
  }
  const v = cp / 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}
const fmtDelta = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d / 100).toFixed(1)}`;

/**
 * Net material for `pov` where the whole line settles: the last point (up to 12 plies)
 * where the next move in the line isn't a capture, so it never counts mid-exchange.
 */
function netAfterLine(fen: string, ucis: string[], pov: Color): { text: string; sans: string[] } | undefined {
  const c = new Chess(fen);
  const caps: boolean[] = [];
  const bals: number[] = [];
  const sans: string[] = [];
  for (const u of ucis.slice(0, 12)) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] ?? 'q' });
      sans.push(m.san);
      caps.push(!!m.captured);
      bals.push(materialBalance(c.fen(), pov));
    } catch {
      break;
    }
  }
  for (let k = bals.length - 1; k >= 1; k--) {
    // After ply k (0-based index k), settled if this move and the next aren't captures.
    if (!caps[k] && !(caps[k + 1] ?? false)) {
      const d = bals[k] - materialBalance(fen, pov);
      return { text: `${d === 0 ? 'level in material' : d > 0 ? `up ${materialPhrase(d)}` : `down ${materialPhrase(-d)}`} once the line settles`, sans: sans.slice(0, k + 1) };
    }
  }
  return undefined;
}

export function trainingLevel(rating: number): string {
  if (rating < 800) return 'beginner: still learning to stop hanging pieces and spot one-move threats';
  if (rating < 1200) return 'improving club beginner (~800–1200): main gains come from blunder-checking, basic tactics, development, converting won positions and not drifting in quiet positions';
  if (rating < 1600) return 'intermediate: tactics are mostly solid; plans, piece activity and endgames matter more';
  return 'advanced club player';
}

function cleanPgn(game: StoredGame): string {
  const h = game.headers;
  const tags = [
    ['White', h.white],
    ['Black', h.black],
    ['Result', h.result],
    ['Date', h.date],
    ['TimeControl', h.timeControl],
    ['Termination', h.termination],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `[${k} "${v}"]`);
  const moves = game.plies.map((p) => (p.color === 'w' ? `${p.moveNumber}. ${p.san}` : p.san)).join(' ');
  return `${tags.join('\n')}\n\n${moves} ${h.result ?? ''}`.trim();
}

/** The game's positions, with any Beta deep re-checks in place of the fast analysis. */
export function betaPositions(game: StoredGame): PositionEval[] {
  const base = game.analysis?.positions ?? [];
  const deep = game.aiCoachDeep ?? {};
  return base.map((p, i) => deep[i] ?? p);
}

interface Series {
  positions: PositionEval[];
  moves: MoveEval[];
  /** Student-POV centipawns after i plies. */
  cp: number[];
  /** Student-POV win% after i plies. */
  win: number[];
}

function series(game: StoredGame): Series | undefined {
  const positions = betaPositions(game);
  if (positions.length !== game.plies.length + 1) return undefined;
  const moves = buildMoveEvals(game.plies, positions);
  const cp = positions.map((p) => {
    const v = positionCp(p);
    return sideToMove(p.fen) === game.userColor ? v : -v;
  });
  return { positions, moves, cp, win: cp.map(winPercent) };
}

export interface Shift {
  /** Plies (1-based) of the first and last move that drove the shift. */
  fromPly: number;
  toPly: number;
  /** Student-POV evaluation before the first and after the last move. */
  before: number;
  after: number;
  direction: 'against you' | 'in your favour';
  /** Every move in the stretch (with two moves of lead-up), with its effect. */
  moves: { ply: number; change: number }[];
}

/**
 * Where the evaluation trend moved: runs of same-direction evaluation changes
 * (one big move, or several smaller ones close together). Evidence only — which
 * of them matter, and which move caused each, is the instructor's call.
 */
export function evaluationShifts(game: StoredGame, s = series(game)): Shift[] {
  if (!s) return [];
  const d = s.win.slice(1).map((w, i) => w - s.win[i]); // d[k-1] = effect of ply k
  const out: Shift[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const from = run[0];
    const to = run[run.length - 1];
    const net = s.win[to] - s.win[from - 1];
    if (Math.abs(net) >= 8) {
      const lead = Math.max(1, from - 2);
      const moves = [];
      for (let k = lead; k <= to; k++) moves.push({ ply: k, change: s.cp[k] - s.cp[k - 1] });
      out.push({ fromPly: from, toPly: to, before: s.cp[from - 1], after: s.cp[to], direction: net < 0 ? 'against you' : 'in your favour', moves });
    }
    run = [];
  };
  for (let k = 1; k <= game.plies.length; k++) {
    const x = d[k - 1];
    if (Math.abs(x) < 3) continue;
    const sign = Math.sign(x);
    const last = run[run.length - 1];
    if (run.length && (k - last > 4 || Math.sign(d[last - 1]) !== sign)) {
      // A small move the other way doesn't break a run; a real one does.
      if (Math.sign(d[last - 1]) !== sign && Math.abs(x) < 5 && k - last <= 4) continue;
      flush();
    }
    run.push(k);
  }
  flush();
  return out;
}

/** Moves worth showing Stockfish's candidates for, most important first. */
function candidatePlies(game: StoredGame, s: Series, shifts: Shift[]): number[] {
  const score = new Map<number, number>();
  const bump = (ply: number, v: number) => score.set(ply, Math.max(score.get(ply) ?? 0, v));
  const effect = (k: number) => Math.abs(s.win[k] - s.win[k - 1]);
  for (const sh of shifts) for (const m of sh.moves) if (effect(m.ply) >= 3 || game.plies[m.ply - 1].color === game.userColor) bump(m.ply, effect(m.ply) + 5);
  s.moves.forEach((e) => {
    const v = verdictOf(e);
    if (e.color === game.userColor && v !== 'best' && v !== 'equal' && v !== 'good') bump(e.ply, effect(e.ply));
    if (e.color !== game.userColor && BAD.includes(v)) bump(e.ply, effect(e.ply));
  });
  for (const f of onlyMoves(game, s)) bump(f.ply, 10 + f.gap / 2);
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([p]) => p)
    .sort((a, b) => a - b);
}

/** The student's moves where Stockfish's best was clearly better than its second choice — and they found it. */
function onlyMoves(game: StoredGame, s: Series): { ply: number; gap: number }[] {
  return s.moves
    .filter((e) => e.color === game.userColor && e.isBest)
    .map((e) => {
      const lines = s.positions[e.ply - 1]?.lines ?? [];
      return { ply: e.ply, gap: lines.length < 2 ? 0 : winPercent(scoreToCp(lines[0].score)) - winPercent(scoreToCp(lines[1].score)) };
    })
    .filter((x) => x.gap >= 10)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 5);
}

/**
 * Positions (indices) to re-check at depth 18 before the review: both sides of
 * the moves that moved the evaluation, so the evidence isn't depth-12 noise.
 */
export function betaDeepTargets(game: StoredGame, max = 16): number[] {
  // One pass per analysis: re-targeting on the deeper numbers would never settle.
  if (game.aiCoachDeep) return [];
  const s = series(game);
  if (!s) return [];
  const have = new Set([...(game.analysis?.deepPositions ?? []), ...Object.keys(game.aiCoachDeep ?? {}).map(Number)]);
  const plies = candidatePlies(game, s, evaluationShifts(game, s))
    .map((k) => ({ k, e: Math.abs(s.win[k] - s.win[k - 1]) }))
    .sort((a, b) => b.e - a.e);
  const out: number[] = [];
  for (const { k } of plies) {
    for (const i of [k - 1, k]) if (!have.has(i) && !out.includes(i) && !s.positions[i].terminal) out.push(i);
    if (out.length >= max) break;
  }
  return out.slice(0, max).sort((a, b) => a - b);
}

/** Re-check the target positions with any engine (browser WASM or Node). */
export async function deepenForBeta(
  game: StoredGame,
  analyse: (fen: string) => Promise<PositionEval>,
  onProgress?: (done: number, total: number) => void,
): Promise<Record<number, PositionEval>> {
  const targets = betaDeepTargets(game);
  const out: Record<number, PositionEval> = { ...(game.aiCoachDeep ?? {}) };
  const positions = game.analysis?.positions ?? [];
  for (let n = 0; n < targets.length; n++) {
    const i = targets[n];
    out[i] = await analyse(positions[i].fen);
    onProgress?.(n + 1, targets.length);
  }
  return out;
}

export interface BetaContext {
  facts: Record<string, unknown>;
  /** Moves the answer may name: the game's, Stockfish's lines', and every legal move in a game position. */
  allowedMoves: Set<string>;
  /** Per position index: Stockfish's candidate first moves (what may be recommended there). */
  candidatesAt: Map<number, Set<string>>;
  /** Every Stockfish candidate move anywhere (for recommendations not tied to a move number). */
  allCandidates: Set<string>;
  support: { material: Set<string>; mate: Set<string>; promotion: Set<string>; anyMaterial: boolean; anyMate: boolean; promotedInGame: boolean };
  verdicts: Map<number, Verdict>;
  /** Student-POV centipawns after each ply. */
  cp: number[];
  plyCount: number;
  userColor: Color;
  userPlies: Set<number>;
  grounding: string;
}

export function betaGrounding(game: StoredGame): string {
  const a = game.analysis;
  return `v${BETA_VERSION}|${a?.analyzedAt}|${a?.depth}|${a?.deepPositions?.length ?? 0}|${Object.keys(game.aiCoachDeep ?? {}).length}|${game.userColor}|${userOutcome(game) ?? ''}`;
}

export function buildBetaContext(game: StoredGame, all: StoredGame[], rating: number): BetaContext | undefined {
  const s = series(game);
  if (!s || !game.plies.length) return undefined;
  const user = game.userColor;
  const opp = other(user);
  const who = (c: Color) => (c === user ? 'you' : 'opponent');
  const label = (k: number) => moveLabel(game.plies[k - 1]);

  const allowed = new Set<string>();
  const candidatesAt = new Map<number, Set<string>>();
  const allCandidates = new Set<string>();
  const support = { material: new Set<string>(), mate: new Set<string>(), promotion: new Set<string>(), anyMaterial: false, anyMate: false, promotedInGame: false };
  game.plies.forEach((p) => {
    allowed.add(strip(p.san));
    if (p.san.includes('=')) {
      support.promotion.add(strip(p.san));
      support.promotedInGame = true;
    }
  });
  // Any legal move at any point of the game may be discussed (claims about it are checked separately).
  [game.plies[0].fenBefore, ...game.plies.map((p) => p.fenAfter)].forEach((fen) => new Chess(fen).moves().forEach((m) => allowed.add(strip(m))));

  // --- every half-move: evaluation after it, its effect, Stockfish's verdict.
  const timeline = game.plies.map((p, i) => {
    const k = i + 1;
    const e = s.moves[i];
    const v = verdictOf(e);
    const mat = materialBalance(p.fenAfter, user) - materialBalance(p.fenBefore, user);
    const parts = [`${label(k)} (${who(p.color)}): ${fmtEval(s.cp[k])} (${fmtDelta(s.cp[k] - s.cp[k - 1])})`, QUALITY_LABEL[v].toLowerCase()];
    if (!e.isBest && e.bestSan && v !== 'equal') parts.push(`Stockfish preferred ${e.bestSan}`);
    if (mat) parts.push(mat > 0 ? `you gain ${materialPhrase(mat)}` : `you lose ${materialPhrase(-mat)}`);
    return parts.join(' · ');
  });

  // --- material that actually changed hands, once each exchange settles.
  const bal = [materialBalance(game.plies[0].fenBefore, user), ...game.plies.map((p) => materialBalance(p.fenAfter, user))];
  const materialTimeline: { ply: number; afterMove: string; change: string; balance: string }[] = [];
  let settled = bal[0];
  for (let i = 1; i < bal.length; i++) {
    if (bal[i] === settled || (i + 1 < bal.length && bal[i + 1] !== bal[i])) continue;
    const delta = bal[i] - settled;
    materialTimeline.push({
      ply: i,
      afterMove: label(i),
      change: delta > 0 ? `you gained ${materialPhrase(delta)}` : `you lost ${materialPhrase(-delta)}`,
      balance: bal[i] === 0 ? 'level' : bal[i] > 0 ? `you are up ${materialPhrase(bal[i])}` : `you are down ${materialPhrase(-bal[i])}`,
    });
    for (let k = Math.max(1, i - 4); k <= i; k++) if (game.plies[k - 1].captured || bal[k] !== bal[k - 1]) support.material.add(strip(game.plies[k - 1].san));
    if (i >= 2) support.material.add(strip(game.plies[i - 2].san));
    support.anyMaterial = true;
    settled = bal[i];
  }
  if (s.positions[game.plies.length]?.terminal === 'checkmate') {
    support.mate.add(strip(game.plies[game.plies.length - 1].san));
    support.anyMate = true;
  }

  // --- where the evaluation trend moved.
  const shifts = evaluationShifts(game, s);
  const evaluationShiftsOut = shifts.map((sh) => ({
    moves: `${label(sh.fromPly)} … ${label(sh.toPly)}`,
    fromPly: sh.fromPly,
    toPly: sh.toPly,
    direction: sh.direction,
    evalBefore: fmtEval(sh.before),
    evalAfter: fmtEval(sh.after),
    moveByMove: sh.moves.map((m) => `${label(m.ply)} (${who(game.plies[m.ply - 1].color)}) ${fmtDelta(m.change)}`),
  }));

  const netText = (mover: Color, net: { text: string; sans: string[] } | undefined, shown: string[]) => {
    if (!net) return undefined;
    net.sans.forEach((x) => allowed.add(strip(x)));
    const longer = net.sans.length > shown.length ? ` (full line: ${net.sans.join(' ')})` : '';
    return `${mover === user ? 'you are' : 'the opponent is'} ${net.text}${longer}`;
  };

  // --- Stockfish's candidates around the moves that matter (both sides).
  const candidatePositions = candidatePlies(game, s, shifts).map((k) => {
    const p = game.plies[k - 1];
    const before = s.positions[k - 1];
    const after = s.positions[k];
    const e = s.moves[k - 1];
    const toYou = (cp: number) => (p.color === user ? cp : -cp);
    // Right after a capture, count material from before it, so a recapture isn't "winning a queen".
    const prev = k >= 2 ? game.plies[k - 2] : undefined;
    const inExchange = !!prev?.captured;
    const netAfter = (ucis: string[]) => (inExchange ? netAfterLine(prev!.fenBefore, [prev!.uci, ...ucis], p.color) : netAfterLine(p.fenBefore, ucis, p.color));
    const firsts = new Set<string>();
    const top = rankCandidates(before)
      .slice(0, 3)
      .map((r) => {
        const line = before.lines.find((l) => l.pv[0] === r.uci)!;
        const pt = lineToPoint(p.fenBefore, line.pv, p.color, 8);
        const sans = pt.frames.map((f) => f.san);
        sans.forEach((x) => allowed.add(strip(x)));
        if (sans[0]) firsts.add(strip(sans[0]));
        if (pt.kind === 'material') {
          support.material.add(strip(sans[0] ?? ''));
          pt.frames.filter((f) => f.san.includes('x')).forEach((f) => support.material.add(strip(f.san)));
          support.anyMaterial = true;
        }
        if (pt.kind === 'promotion') {
          [sans[0], ...sans.filter((x) => x.includes('='))].forEach((x) => x && support.promotion.add(strip(x)));
        }
        if (pt.kind === 'mate' || isMate(r.cp)) {
          [sans[0], ...sans.filter((x) => x.endsWith('#'))].forEach((x) => x && support.mate.add(strip(x)));
          support.anyMate = true;
        }
        return {
          move: sans[0],
          evalForYou: fmtEval(toYou(r.cp)),
          stockfish: QUALITY_LABEL[r.quality].toLowerCase(),
          line: sans.join(' '),
          whatHappens: inExchange ? undefined : pt.text,
          afterFullLine: netText(p.color, netAfter(line.pv), sans),
        };
      });
    candidatesAt.set(k - 1, firsts);
    firsts.forEach((x) => allCandidates.add(x));
    const played = lineToPoint(p.fenBefore, [p.uci, ...(after?.lines[0]?.pv ?? [])], p.color, 8);
    const playedSans = played.frames.map((f) => f.san);
    playedSans.forEach((x) => allowed.add(strip(x)));
    if (played.kind === 'material') {
      support.material.add(strip(p.san));
      played.frames.filter((f) => f.san.includes('x')).forEach((f) => support.material.add(strip(f.san)));
      support.anyMaterial = true;
    }
    if (played.kind === 'mate' || isMate(e.cpAfter)) {
      support.mate.add(strip(p.san));
      support.anyMate = true;
    }
    return {
      ply: k,
      beforeMove: label(k),
      toMove: who(p.color),
      note: inExchange ? `${label(k - 1)} was a capture: material below is counted from before it` : undefined,
      fen: p.fenBefore,
      depth: before.depth,
      evalBefore: fmtEval(s.cp[k - 1]),
      stockfishTop: top,
      played: {
        move: p.san,
        evalAfter: fmtEval(s.cp[k]),
        stockfish: QUALITY_LABEL[verdictOf(e)].toLowerCase(),
        line: playedSans.join(' '),
        whatHappens: inExchange ? undefined : played.text,
        afterFullLine: netText(p.color, netAfter([p.uci, ...(after?.lines[0]?.pv ?? [])]), playedSans),
      },
    };
  });

  // --- phase markers and positional checkpoints.
  const queensOff = game.plies.findIndex((p) => !/q/i.test(p.fenAfter.split(' ')[0].replace(/[^qQ]/g, '')) );
  const endgame = game.plies.findIndex((p) => nonPawnMaterial(p.fenAfter) <= 26 && !/[qQ]/.test(p.fenAfter.split(' ')[0]));
  const phaseMarkers = {
    queensTradedAfter: queensOff >= 0 ? label(queensOff + 1) : null,
    endgameFrom: endgame >= 0 ? label(endgame + 1) : null,
  };
  const checkpoint = (i: number) => {
    const fen = game.plies[i - 1].fenAfter;
    const side = (c: Color) => {
      const w = pawnWeaknesses(fen, c);
      return {
        // From the moves, not the board: a castled king that later walked to g2 still castled.
        castled: game.plies.slice(0, i).some((p) => p.color === c && p.san.startsWith('O-O')),
        king: kingSquare(fen, c),
        kingInCenter: kingInCenter(fen, c),
        undevelopedMinors: undevelopedMinors(fen, c).length,
        doubledPawns: w.doubled,
        isolatedPawns: w.isolated,
        passedPawns: passedPawns(fen, c),
      };
    };
    const m = materialBalance(fen, user);
    return { afterMove: label(i), material: m === 0 ? 'level' : m > 0 ? `you are up ${materialPhrase(m)}` : `you are down ${materialPhrase(-m)}`, you: side(user), opponent: side(opp) };
  };
  const cps: number[] = [];
  for (let i = 20; i < game.plies.length; i += 20) cps.push(i);
  cps.push(game.plies.length);
  const positionalCheckpoints = cps.map(checkpoint);

  // --- the moves by kind (labels only; the instructor decides what they mean).
  const verdicts = new Map<number, Verdict>(s.moves.map((e) => [e.ply, verdictOf(e)]));
  const by = (c: Color, vs: Verdict[]) => s.moves.filter((e) => e.color === c && vs.includes(verdicts.get(e.ply)!)).map((e) => `${label(e.ply)} ${fmtDelta(s.cp[e.ply] - s.cp[e.ply - 1])}`);
  const notableMoves = {
    yourOnlyMoveFinds: onlyMoves(game, s).map((f) => `${label(f.ply)} (the next-best move was much worse)`),
    yourMistakesAndBlunders: by(user, BAD),
    yourInaccuracies: by(user, ['inaccuracy']),
    opponentMistakesAndBlunders: by(opp, BAD),
  };

  const detections = game.findings
    .filter((f) => f.confidence !== 'low')
    .slice(0, 12)
    .map((f) => ({
      move: f.ply ? label(f.ply) : 'whole game',
      kind: f.kind,
      type: (f.kind === 'weakness' ? CATEGORIES[f.category as keyof typeof CATEGORIES]?.label : STRENGTHS[f.category as keyof typeof STRENGTHS]?.label) ?? f.category,
      note: f.evidence,
    }));

  const mine = s.moves.filter((e) => e.color === user);
  const theirs = s.moves.filter((e) => e.color !== user);
  const acc = (xs: MoveEval[]) => Math.round(xs.reduce((a, e) => a + moveAccuracy(e.winDrop), 0) / Math.max(1, xs.length));
  const recent = all
    .filter((g) => g.id !== game.id && g.status === 'analyzed' && gamePlayedAt(g) < gamePlayedAt(game))
    .sort((x, y) => gamePlayedAt(y) - gamePlayedAt(x))
    .slice(0, 8)
    .map((g) => userOutcome(g) ?? 'unknown');

  const outcome = userOutcome(game);
  const facts = {
    student: {
      color: COLOR_NAME[user],
      rating,
      trainingLevel: trainingLevel(rating),
      result: outcome ?? 'unknown',
      opponentRating: user === 'w' ? game.headers.blackElo : game.headers.whiteElo,
    },
    pgn: cleanPgn(game),
    evaluationScale:
      `All evaluations are in pawns from YOUR (${COLOR_NAME[user]}'s) point of view: positive is good for you. Roughly: within ±0.5 equal; ±0.5–1.5 slightly better/worse; ±1.5–3 clearly better/worse; beyond ±3 winning/losing. Changes in brackets are each move's effect.`,
    engine: `Stockfish, depth ${game.analysis?.depth ?? 12} for every position; positions around the evaluation shifts re-checked at depth ${BETA_DEEP_DEPTH}.`,
    accuracy: { you: acc(mine), opponent: acc(theirs) },
    evaluationTimeline: timeline,
    evaluationShifts: evaluationShiftsOut,
    candidatePositions,
    materialTimeline,
    phaseMarkers,
    positionalCheckpoints,
    notableMoves,
    ruleBasedDetections: { note: 'Automatic pattern detectors; reliable but incomplete. Context, not a list of lessons.', items: detections },
    playerProfile: {
      note: 'Context from earlier games only. Mention a tendency only if THIS game shows it too.',
      recentResults: recent,
      recurringTendencies: recurringPatterns(priorGames(game, all), game.findings).map((r) => `${r.pattern} (${r.inRecentGames} recent games)`),
    },
  };
  return {
    facts,
    allowedMoves: allowed,
    candidatesAt,
    allCandidates,
    support,
    verdicts,
    cp: s.cp,
    plyCount: game.plies.length,
    userColor: user,
    userPlies: new Set(game.plies.filter((p) => p.color === user).map((p) => p.ply)),
    grounding: betaGrounding(game),
  };
}

export function betaPrompt(ctx: BetaContext): string {
  return `Here is the whole game with Stockfish's evidence. Decide for yourself what the instructive story is.\n\n${JSON.stringify(ctx.facts, null, 1)}`;
}

// ------------------------------------------------------------- refereeing ---

const PIECE_SAN = /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][18]=[QRBN]|O-O(?:-O)?)[+#]?/g;
/** "19...e4", "19. Nc3", "21.Nxe4", "…e4", "...fxe4" */
const NUMBERED = /(\d{1,3})?(\.{3}|…|\.)\s?((?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|[a-h][1-8]|O-O(?:-O)?)(?:=[QRBN])?)[+#]?/g;

const MATERIAL_CLAIM =
  /\b(?:wins?|winning|won|loses?|losing|lost|hangs?|hung|hanging|drops?|dropped|blunder(?:s|ed)?|gives? away|gave away|traps?|trapped|forks?|forked|skewers?|skewered|pins?|pinned|picks? up|picked up|grabs?|grabbed|nets?|netted)\b[^.!?]{0,40}?\b(?:queen|rook|bishop|knight|piece|pawn|exchange|material)s?\b/i;
const TACTIC_CLAIM = /\b(?:fork|skewer|discovered attack|double attack|removes? the defender|deflection)\b/i;
const MATE_CLAIM = /\b(?:mates|mated|checkmate|mating|forces? mate|forced mate|mate in \d)\b/i;
const UNSTOPPABLE_CLAIM = /\b(?:unstoppable|cannot be stopped|can't be stopped|could not be stopped|couldn't be stopped|will promote|queens by force)\b/i;
const EVAL_CLAIM = /\b(?:is losing|was losing|losing position|lost position|dead lost|completely winning|totally winning|winning position|decisive(?:ly)?|game over|resignable)\b/i;
const PRAISE = /\b(?:strong|excellent|good|great|best|well[- ]timed|correct|powerful|brilliant|accurate|clever|precise|smart|right idea|well played|instructive break|fine move)\b/i;
const BLAME = /\b(?:mistake|blunder|error|inaccura\w*|bad move|weak move|wrong|careless|dubious|premature)\b/i;
const RECOMMEND = /\b(?:better (?:was|is|would)|was better|is better|would have been (?:better|stronger)|should have|stronger was|instead,? |best was|was best|preferred|recommend\w*|the right move)\b/i;
const CONTRAST = /\b(?:but|however|although|though|yet|while|whereas|instead)\b/i;

const negated = (sentence: string, re: RegExp) => {
  const m = re.exec(sentence);
  if (!m) return false;
  const before = sentence.slice(Math.max(0, m.index - 25), m.index).toLowerCase();
  return /\b(?:not|n't|never|no|looked|looks|seemed|seems|appeared|felt)\b[^.]*$/.test(before) || /^-looking/.test(sentence.slice(m.index + m[0].length));
};

interface Anchor {
  san: string;
  /** Game ply this refers to, when it names a played move. */
  ply?: number;
  /** Named with a move number but not the move played there: an alternative at that point. */
  alternativeAt?: number;
}

/** The moves a sentence names, resolved against the game where it names them with move numbers. */
export function anchorsIn(sentence: string, game: StoredGame): { anchors: Anchor[]; problems: string[] } {
  const anchors: Anchor[] = [];
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const m of sentence.matchAll(NUMBERED)) {
    const [, num, dots, san] = m;
    const color: Color = dots === '.' ? 'w' : 'b';
    seen.add(m.index!);
    if (!num) {
      // "…e4" — a Black move without a number: any Black move with that SAN.
      const plies = game.plies.filter((p) => p.color === 'b' && strip(p.san) === san);
      if (plies.length) plies.forEach((p) => anchors.push({ san, ply: p.ply }));
      else anchors.push({ san });
      continue;
    }
    const n = Number(num);
    const p = game.plies.find((x) => x.moveNumber === n && x.color === color);
    if (!p) {
      problems.push(`${num}${dots}${san} is not a move number in this game`);
      continue;
    }
    if (strip(p.san) === san) anchors.push({ san, ply: p.ply });
    else {
      // An alternative written with the move number: must be legal at that point.
      const legal = new Chess(p.fenBefore).moves().map(strip);
      if (!legal.includes(san)) problems.push(`${num}${dots}${san} is not legal at that point (${moveLabel(p)} was played)`);
      else anchors.push({ san, alternativeAt: p.ply - 1 });
    }
  }
  for (const m of sentence.matchAll(PIECE_SAN)) {
    const san = strip(m[0]);
    // Already read as part of a numbered move.
    if ([...seen].some((i) => i <= m.index! && m.index! <= i + 6)) continue;
    const plies = game.plies.filter((p) => strip(p.san) === san);
    if (plies.length) plies.forEach((p) => anchors.push({ san, ply: p.ply }));
    else anchors.push({ san });
  }
  return { anchors, problems };
}

/** How the move at `ply` changed the evaluation for the side that played it (centipawns, mates capped). */
function moverChange(ctx: BetaContext, game: StoredGame, ply: number): number {
  const cap = (c: number) => Math.max(-1500, Math.min(1500, c));
  const d = cap(ctx.cp[ply]) - cap(ctx.cp[ply - 1]);
  return game.plies[ply - 1].color === ctx.userColor ? d : -d;
}

export interface Checked {
  text: string;
  removed: { text: string; reason: string }[];
}

/**
 * Referee one passage sentence by sentence. A sentence is removed when it names a
 * move that doesn't exist, or makes a concrete claim the engine data contradicts.
 */
export function checkText(text: string, ctx: BetaContext, game: StoredGame): Checked {
  const removed: Checked['removed'] = [];
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const kept = sentences.filter((s) => {
    const drop = (reason: string) => (removed.push({ text: s, reason }), false);
    const { anchors, problems } = anchorsIn(s, game);
    if (problems.length) return drop(problems[0]);
    const unknown = anchors.find((a) => !ctx.allowedMoves.has(a.san));
    if (unknown) return drop(`${unknown.san} is not a move in the game, in Stockfish's lines, or legal anywhere in it`);
    const sans = anchors.map((a) => a.san);
    const played = anchors.filter((a) => a.ply !== undefined);

    if (MATE_CLAIM.test(s) && !negated(s, MATE_CLAIM) && !(sans.length ? sans.some((m) => ctx.support.mate.has(m)) : ctx.support.anyMate)) {
      return drop("Stockfish's analysis shows no such mate");
    }
    if ((MATERIAL_CLAIM.test(s) || TACTIC_CLAIM.test(s)) && !negated(s, MATERIAL_CLAIM) && !(sans.length ? sans.some((m) => ctx.support.material.has(m)) : ctx.support.anyMaterial)) {
      return drop("Stockfish's analysis doesn't show that material change");
    }
    // Without a move named, "couldn't be stopped" is about the game itself: a pawn must actually have promoted.
    if (UNSTOPPABLE_CLAIM.test(s) && !negated(s, UNSTOPPABLE_CLAIM) && !(sans.length ? sans.some((m) => ctx.support.promotion.has(m)) : ctx.support.promotedInGame)) {
      return drop("Stockfish's analysis shows no pawn that couldn't be stopped");
    }
    if (EVAL_CLAIM.test(s) && !negated(s, EVAL_CLAIM)) {
      const big = (k: number) => Math.abs(ctx.cp[k]) >= 200;
      const ok = played.length ? played.some((a) => big(a.ply!) || big(a.ply! - 1)) : ctx.cp.some((c) => Math.abs(c) >= 200);
      if (!ok) return drop("Stockfish's evaluation never got that one-sided there");
    }
    const contrast = CONTRAST.test(s);
    if (PRAISE.test(s) && !negated(s, PRAISE) && !contrast && !RECOMMEND.test(s)) {
      // Judged on the evaluation itself, not the label: a move that cost its player half a pawn isn't praised.
      const bad = played.find((a) => BAD.includes(ctx.verdicts.get(a.ply!)!) || moverChange(ctx, game, a.ply!) <= -50);
      if (bad) {
        const k = bad.ply!;
        return drop(`Stockfish shows ${moveLabel(game.plies[k - 1])} made ${game.plies[k - 1].color === ctx.userColor ? 'your' : "the opponent's"} position worse (${fmtEval(ctx.cp[k - 1])} → ${fmtEval(ctx.cp[k])} for you)`);
      }
    }
    if (BLAME.test(s) && !negated(s, BLAME) && !contrast && played.length && played.every((a) => FINE.includes(ctx.verdicts.get(a.ply!)!))) {
      return drop(`Stockfish rates ${moveLabel(game.plies[played[0].ply! - 1])} as ${ctx.verdicts.get(played[0].ply!) === 'best' ? 'the best move' : 'as good as the best'}`);
    }
    if (RECOMMEND.test(s)) {
      // Alternatives recommended must be moves Stockfish actually put forward there.
      const alts = anchors.filter((a) => a.ply === undefined);
      const bad = alts.find((a) => !(a.alternativeAt !== undefined ? ctx.candidatesAt.get(a.alternativeAt)?.has(a.san) : ctx.allCandidates.has(a.san)));
      if (bad) return drop(`${bad.san} isn't among Stockfish's candidate moves there`);
    }
    return true;
  });
  return { text: kept.join(' ').trim(), removed };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const ASSESS = ['well', 'mixed', 'poorly', 'neutral'] as const;

/** Parse and referee the model's review. Throws when too little survives. */
export function parseBetaReview(text: string, ctx: BetaContext, game: StoredGame, model?: string): BetaCoachReview {
  const raw = extractJson(text) as Record<string, any>;
  const removed: BetaCoachReview['removed'] = [];
  const check = (v: unknown, max: number) => {
    const c = checkText(str(v, max), ctx, game);
    removed.push(...c.removed);
    return c.text;
  };
  const ply = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= ctx.plyCount ? (n as number) : undefined;
  };

  const chapters: BetaChapter[] = arr(raw.chapters)
    .slice(0, 8)
    .map((c: any): BetaChapter | undefined => {
      let fromPly = ply(c?.fromPly) ?? ply(c?.anchorPly);
      let toPly = ply(c?.toPly) ?? fromPly;
      if (!fromPly || !toPly) return undefined;
      if (toPly < fromPly) [fromPly, toPly] = [toPly, fromPly];
      const a = ply(c?.anchorPly);
      const anchorPly = a && a >= fromPly - 4 && a <= toPly + 2 ? a : fromPly;
      const narrative = check(c?.narrative, 1600);
      if (!narrative) return undefined;
      return {
        title: str(c?.title, 90) || 'Untitled phase',
        fromPly,
        toPly,
        anchorPly,
        kind: str(c?.kind, 40) || 'phase',
        assessment: ASSESS.includes(c?.assessment) ? c.assessment : 'mixed',
        narrative,
        evidence: arr(c?.evidence)
          .slice(0, 5)
          .map((x) => check(x, 300))
          .filter(Boolean),
        lesson: check(c?.lesson, 400),
        diagram: c?.diagram !== false,
        explore: !!c?.explore,
        decisionPly: ply(c?.decisionPly),
        consequencePly: ply(c?.consequencePly),
      };
    })
    .filter((c): c is BetaChapter => !!c)
    .sort((x, y) => x.fromPly - y.fromPly);
  if (chapters.length < 2) throw new UngroundedError('The AI review had too few chapters that agreed with the engine analysis.');

  return {
    version: 2,
    story: check(raw.story, 900),
    chapters,
    lessons: arr(raw.lessons)
      .slice(0, 2)
      .map((x) => check(x, 500))
      .filter(Boolean),
    practice: arr(raw.practice)
      .slice(0, 3)
      .map((m: any) => ({ ply: ply(m?.ply), why: check(m?.why, 400) }))
      // A position to practise is the one before one of the student's own moves.
      .filter((m): m is { ply: number; why: string } => !!m.ply && ctx.userPlies.has(m.ply) && !!m.why),
    removed,
    model,
    createdAt: Date.now(),
    grounding: ctx.grounding,
  };
}

/** A cached review in the current format, or undefined. */
export function currentReview(game: StoredGame): BetaCoachReview | undefined {
  const r = game.aiCoach;
  return r && r.version === BETA_VERSION ? (r as BetaCoachReview) : undefined;
}
