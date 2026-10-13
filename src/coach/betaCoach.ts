// Beta AI Coach: the facts a model gets to form its own instructional reading of a
// whole game, and the checks its answer passes before we show it. Stockfish stays
// the factual anchor (evaluations, best moves, material, mates); the model may make
// broader coaching judgements, but concrete tactical claims must be backed by the
// engine data below — unsupported ones are removed, never shown.
import type { BetaCoachReview, Color, StoredGame } from '../domain/types';
import { COLOR_NAME, hasCastled, kingInCenter, materialBalance, materialPhrase, other, passedPawns, pawnWeaknesses, sideToMove, undevelopedMinors } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { MATE_CP, pd, positionCp, scoreToCp, winPercent } from '../analysis/evaluation';
import { BAND_LABEL, bandOf } from '../analysis/evalBand';
import { QUALITY_LABEL, rankCandidates } from '../analysis/moveQuality';
import { lineToPoint } from '../analysis/linePoint';
import { gameStats, verdictOf } from '../analysis/engineReview';
import { CATEGORIES, STRENGTHS } from '../domain/categories';
import { userOutcome } from '../chess/outcome';
import { gamePlayedAt, priorGames } from '../analysis/pipeline';
import { extractJson } from './llmCoach';
import { recurringPatterns, UngroundedError } from './momentContext';

export interface BetaContext {
  facts: Record<string, unknown>;
  /** Every move the answer may mention (game moves and supplied engine lines). */
  allowedMoves: Set<string>;
  /** Moves whose engine facts show material changing hands / a mate. */
  support: { material: Set<string>; mate: Set<string>; anyMaterial: boolean; anyMate: boolean };
  plyCount: number;
  userColor: Color;
  /** Plies of the user's moves (positions worth practising are the ones before them). */
  userPlies: Set<number>;
  grounding: string;
}

const strip = (san: string) => san.replace(/[+#?!]+$/, '');
const isMate = (cp: number) => Math.abs(cp) >= MATE_CP - 1000;

/** Evaluation for the student, in words an instructor can use (pawns, or mate). */
function evalText(cp: number): string {
  if (isMate(cp)) {
    const n = Math.max(1, Math.round((MATE_CP - Math.abs(cp)) / 10));
    return cp > 0 ? `you have mate in ${n}` : `you are getting mated in ${n}`;
  }
  const v = cp / 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} (${BAND_LABEL[bandOf(cp)].toLowerCase()} for you)`;
}

export function trainingLevel(rating: number): string {
  if (rating < 800) return 'beginner: still learning to stop hanging pieces and spot one-move threats';
  if (rating < 1200) return 'improving club beginner (~800–1200): main gains come from blunder-checking, basic tactics, development and converting won positions';
  if (rating < 1600) return 'intermediate: tactics are mostly solid; plans, piece activity and endgames matter more';
  return 'advanced club player';
}

/** Header lines plus clean SAN movetext (no clock comments). */
function cleanPgn(game: StoredGame): string {
  const h = game.headers;
  const tags = [
    ['White', h.white],
    ['Black', h.black],
    ['Result', h.result],
    ['Date', h.date],
    ['TimeControl', h.timeControl],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `[${k} "${v}"]`);
  const moves = game.plies.map((p) => (p.color === 'w' ? `${p.moveNumber}. ${p.san}` : p.san)).join(' ');
  return `${tags.join('\n')}\n\n${moves} ${h.result ?? ''}`.trim();
}

/** Student-POV centipawns for the position after `i` plies. */
function userCpAt(game: StoredGame, i: number): number | undefined {
  const pos = game.analysis?.positions[i];
  if (!pos) return undefined;
  const cp = positionCp(pos);
  return sideToMove(pos.fen) === game.userColor ? cp : -cp;
}

export function buildBetaContext(game: StoredGame, all: StoredGame[], rating: number): BetaContext | undefined {
  const a = game.analysis;
  if (!a?.moves.length) return undefined;
  const user = game.userColor;
  const opp = other(user);
  const allowed = new Set(game.plies.map((p) => strip(p.san)));
  const support = { material: new Set<string>(), mate: new Set<string>(), anyMaterial: false, anyMate: false };
  const addLine = (sans: string[]) => sans.forEach((s) => allowed.add(strip(s)));
  const who = (c: Color) => (c === user ? 'you' : 'opponent');

  // --- evaluation timeline: once per full move, student POV.
  const timeline: string[] = [];
  for (let i = 2; i <= game.plies.length; i += 2) {
    const cp = userCpAt(game, i);
    if (cp !== undefined) timeline.push(`after move ${i / 2}: ${evalText(cp)}`);
  }
  const last = userCpAt(game, game.plies.length);
  if (game.plies.length % 2 && last !== undefined) timeline.push(`after move ${Math.ceil(game.plies.length / 2)} (final): ${evalText(last)}`);

  // --- material swings that actually happened (settled: the next move doesn't change material again).
  const bal = [materialBalance(game.plies[0]?.fenBefore ?? '', user), ...game.plies.map((p) => materialBalance(p.fenAfter, user))];
  const materialSwings: { ply: number; afterMove: string; change: string; materialNow: string }[] = [];
  let settled = bal[0];
  for (let i = 1; i < bal.length; i++) {
    if (bal[i] === settled || (i + 1 < bal.length && bal[i + 1] !== bal[i])) continue;
    const delta = bal[i] - settled;
    const p = game.plies[i - 1];
    materialSwings.push({
      ply: p.ply,
      afterMove: moveLabel(p),
      change: delta > 0 ? `you gained ${materialPhrase(delta)}` : `you lost ${materialPhrase(-delta)}`,
      materialNow: bal[i] === 0 ? 'level' : bal[i] > 0 ? `you are up ${materialPhrase(bal[i])}` : `you are down ${materialPhrase(-bal[i])}`,
    });
    // The captures that made the swing are what a material claim may name.
    for (let k = i - 1; k >= 0 && k >= i - 4; k--) if (game.plies[k].captured || bal[k + 1] !== bal[k]) support.material.add(strip(game.plies[k].san));
    if (i >= 2) support.material.add(strip(game.plies[i - 2].san)); // the move that allowed it
    if (Math.abs(delta) >= 1) support.anyMaterial = true;
    settled = bal[i];
  }
  const lastPly = game.plies[game.plies.length - 1];
  const finalPos = a.positions[game.plies.length];
  if (finalPos?.terminal === 'checkmate' && lastPly) {
    support.mate.add(strip(lastPly.san));
    support.anyMate = true;
  }

  // --- critical positions: the student's worst moves, the opponent's, and the student's hardest good finds.
  const evals = a.moves;
  const byDrop = (c: Color, kinds: string[]) =>
    evals
      .filter((e) => e.color === c && kinds.includes(verdictOf(e)))
      .sort((x, y) => pd(y) - pd(x));
  const picks = new Map<number, string[]>();
  const pick = (ply: number, why: string) => picks.set(ply, [...(picks.get(ply) ?? []), why]);
  byDrop(user, ['blunder', 'mistake']).slice(0, 4).forEach((e) => pick(e.ply, `your ${verdictOf(e)}`));
  byDrop(opp, ['blunder', 'mistake']).slice(0, 3).forEach((e) => {
    const next = evals[e.ply];
    const punished = next && ['best', 'equal', 'good'].includes(verdictOf(next));
    pick(e.ply, `opponent's ${verdictOf(e)}${next ? (punished ? ' — you found a good answer' : ' — your answer missed the best punishment') : ''}`);
  });
  const finds = evals
    .filter((e) => e.color === user && e.isBest)
    .map((e) => {
      const lines = a.positions[e.ply - 1]?.lines ?? [];
      if (lines.length < 2) return { e, gap: 0 };
      return { e, gap: winPercent(scoreToCp(lines[0].score)) - winPercent(scoreToCp(lines[1].score)) };
    })
    .filter((x) => x.gap >= 12)
    .sort((x, y) => y.gap - x.gap)
    .slice(0, 3);
  finds.forEach(({ e }) => pick(e.ply, 'you found the only clearly good move'));
  game.moments.filter((m) => m.kind === 'good_idea').forEach((m) => pick(m.ply, 'a strong idea of yours'));

  const criticalPositions = [...picks.entries()]
    .sort((x, y) => x[0] - y[0])
    .slice(0, 10)
    .map(([ply, why]) => {
      const p = game.plies[ply - 1];
      const before = a.positions[ply - 1];
      const after = a.positions[ply];
      const e = evals[ply - 1];
      const mover = p.color;
      const toYou = (cp: number) => (mover === user ? cp : -cp);
      const top = before ? rankCandidates(before).slice(0, 3) : [];
      const candidates = top.map((r) => {
        const line = before!.lines.find((l) => l.pv[0] === r.uci)!;
        const pt = lineToPoint(p.fenBefore, line.pv, mover, 8);
        const sans = pt.frames.map((f) => f.san);
        addLine(sans);
        if (pt.kind === 'material' || pt.kind === 'promotion') {
          support.material.add(strip(sans[0] ?? ''));
          pt.frames.filter((f) => f.san.includes('x')).forEach((f) => support.material.add(strip(f.san)));
        }
        if (pt.kind === 'mate' || isMate(r.cp)) sans.slice(0, 1).concat(sans.filter((s) => s.endsWith('#'))).forEach((s) => support.mate.add(strip(s)));
        return { move: sans[0], quality: QUALITY_LABEL[r.quality], evaluation: evalText(toYou(r.cp)), line: sans, whatHappens: pt.text };
      });
      const playedPt = lineToPoint(p.fenBefore, [p.uci, ...(after?.lines[0]?.pv ?? [])], mover, 8);
      const playedSans = playedPt.frames.map((f) => f.san);
      addLine(playedSans);
      if (playedPt.kind === 'material' || playedPt.kind === 'promotion') {
        support.material.add(strip(p.san));
        playedPt.frames.filter((f) => f.san.includes('x')).forEach((f) => support.material.add(strip(f.san)));
      }
      if (playedPt.kind === 'mate' || isMate(e.cpAfter)) {
        support.mate.add(strip(p.san));
        playedSans.filter((s) => s.endsWith('#')).forEach((s) => support.mate.add(strip(s)));
      }
      if (candidates.some((c) => c.whatHappens && /wins?|for/.test(c.whatHappens)) || playedPt.kind === 'material') support.anyMaterial = true;
      if (isMate(e.cpBefore) || isMate(e.cpAfter)) support.anyMate = true;
      const expl = mover === user ? game.explanations?.[ply] : undefined;
      return {
        ply,
        move: moveLabel(p),
        by: who(mover),
        whyCritical: why,
        fenBefore: p.fenBefore,
        verdict: QUALITY_LABEL[verdictOf(e)],
        evalBefore: evalText(toYou(e.cpBefore)),
        evalAfter: evalText(toYou(e.cpAfter)),
        stockfishTopMoves: candidates,
        playedMoveLine: { line: playedSans, whatHappens: playedPt.text },
        ruleBasedNote: expl ? `${expl.problem ?? ''} ${expl.better ?? ''}`.trim() || undefined : undefined,
      };
    });

  // --- positional checkpoints (end of opening, final position).
  const checkpoint = (i: number) => {
    const fen = i === 0 ? game.plies[0].fenBefore : game.plies[i - 1].fenAfter;
    const side = (c: Color) => {
      const w = pawnWeaknesses(fen, c);
      return {
        castled: hasCastled(fen, c),
        kingInCenter: kingInCenter(fen, c),
        undevelopedMinorPieces: undevelopedMinors(fen, c).length,
        doubledPawns: w.doubled,
        isolatedPawns: w.isolated,
        passedPawns: passedPawns(fen, c),
      };
    };
    return { afterMove: Math.ceil(i / 2), you: side(user), opponent: side(opp) };
  };
  const checkpoints = [Math.min(20, game.plies.length), game.plies.length].filter((v, i, xs) => v > 0 && xs.indexOf(v) === i).map(checkpoint);

  const features = game.findings
    .filter((f) => f.confidence !== 'low')
    .slice(0, 14)
    .map((f) => {
      const p = f.ply ? game.plies[f.ply - 1] : undefined;
      const label = f.kind === 'weakness' ? CATEGORIES[f.category as keyof typeof CATEGORIES]?.label : STRENGTHS[f.category as keyof typeof STRENGTHS]?.label;
      return { ply: f.ply || undefined, move: p ? moveLabel(p) : 'whole game', kind: f.kind, type: label ?? f.category, note: f.evidence };
    });

  // --- the student's recent history.
  const prior = priorGames(game, all);
  const recent = all
    .filter((g) => g.id !== game.id && g.status === 'analyzed' && gamePlayedAt(g) < gamePlayedAt(game))
    .sort((x, y) => gamePlayedAt(y) - gamePlayedAt(x))
    .slice(0, 8)
    .map((g) => ({ result: userOutcome(g) ?? 'unknown', yourAccuracy: gameStats(g)?.you.accuracy, ruleBasedFocus: g.report?.focus.title }));

  const stats = gameStats(game);
  const outcome = userOutcome(game);
  const facts = {
    student: { color: COLOR_NAME[user], rating, trainingLevel: trainingLevel(rating), result: outcome ?? 'unknown', opponentRating: user === 'w' ? game.headers.blackElo : game.headers.whiteElo },
    pgn: cleanPgn(game),
    termination: game.headers.termination,
    engineStats: stats
      ? { yourAccuracy: stats.you.accuracy, opponentAccuracy: stats.opponent.accuracy, yourMistakes: stats.you.mistake, yourBlunders: stats.you.blunder, opponentMistakes: stats.opponent.mistake, opponentBlunders: stats.opponent.blunder, caveat: stats.caveat }
      : null,
    evaluationTimeline: timeline,
    materialSwings,
    criticalPositions,
    positionalCheckpoints: checkpoints,
    detectedFeatures: features,
    recentGames: recent,
    recurringPatterns: recurringPatterns(prior, game.findings),
  };
  const userPlies = new Set(game.plies.filter((p) => p.color === user).map((p) => p.ply));
  return { facts, allowedMoves: allowed, support, plyCount: game.plies.length, userColor: user, userPlies, grounding: betaGrounding(game) };
}

/** Identifies the analysis (and result) a review was built on; a cached review with another key is stale. */
export function betaGrounding(game: StoredGame): string {
  const a = game.analysis;
  return `${a?.analyzedAt}|${a?.depth}|${a?.deepPositions?.length ?? 0}|${game.userColor}|${userOutcome(game) ?? ''}`;
}

export function betaPrompt(ctx: BetaContext): string {
  return `Review this whole game for the student. The engine facts below are the evidence; the interpretation is yours.\n\n${JSON.stringify(ctx.facts, null, 1)}`;
}

// ------------------------------------------------------------- checking ---

const SAN = /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])|O-O(?:-O)?)[+#]?/g;
const MATERIAL_CLAIM =
  /\b(?:wins?|winning|won|loses?|losing|lost|hangs?|hung|hanging|drops?|dropped|blunder(?:s|ed)?|gives? away|gave away|traps?|trapped|forks?|forked|skewers?|skewered|pins?|pinned|picks? up|picked up|grabs?|grabbed)\b[^.!?]{0,40}?\b(?:queen|rook|bishop|knight|piece|pawn|exchange|material)s?\b/i;
const TACTIC_CLAIM = /\b(?:fork|skewer|discovered attack|double attack|removes? the defender)\b/i;
const MATE_CLAIM = /\b(?:mate|mates|mated|checkmate|mating)\b/i;
const MOVE_NUMBER = /\bmove (\d{1,3})\b|\b(\d{1,3})\.{1,3}\s?(?=[KQRBNa-hO])/g;

export interface Checked {
  text: string;
  removed: { text: string; reason: string }[];
}

/** Moves a sentence names: SAN tokens, plus "move 23" / "23." references resolved to that move's SANs. */
function anchors(sentence: string, game: StoredGame): string[] {
  const out = (sentence.match(SAN) ?? []).map(strip);
  for (const m of sentence.matchAll(MOVE_NUMBER)) {
    const n = Number(m[1] ?? m[2]);
    game.plies.filter((p) => p.moveNumber === n).forEach((p) => out.push(strip(p.san)));
  }
  return out;
}

/**
 * Keep a sentence unless it names a move outside the engine facts, or makes a
 * concrete material / mate claim the engine facts don't back.
 */
export function checkText(text: string, ctx: BetaContext, game: StoredGame): Checked {
  const removed: Checked['removed'] = [];
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const kept = sentences.filter((s) => {
    const drop = (reason: string) => (removed.push({ text: s, reason }), false);
    const unknown = (s.match(SAN) ?? []).map(strip).find((m) => !ctx.allowedMoves.has(m));
    if (unknown) return drop(`${unknown} is not a move in the game or in Stockfish's lines`);
    const refs = anchors(s, game);
    if (MATE_CLAIM.test(s) && !(refs.length ? refs.some((m) => ctx.support.mate.has(m)) : ctx.support.anyMate)) {
      return drop("Stockfish's analysis shows no such mate");
    }
    if ((MATERIAL_CLAIM.test(s) || TACTIC_CLAIM.test(s)) && !(refs.length ? refs.some((m) => ctx.support.material.has(m)) : ctx.support.anyMaterial)) {
      return drop("Stockfish's analysis doesn't show that material change");
    }
    return true;
  });
  return { text: kept.join(' ').trim(), removed };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

/** Parse and check the model's answer. Throws when nothing usable is left. */
export function parseBetaReview(text: string, ctx: BetaContext, game: StoredGame, model?: string): BetaCoachReview {
  const raw = extractJson(text) as Record<string, any>;
  const removed: BetaCoachReview['removed'] = [];
  const check = (v: unknown, max: number) => {
    const c = checkText(str(v, max), ctx, game);
    removed.push(...c.removed);
    return c.text;
  };
  const list = (v: unknown, n: number) =>
    arr(v)
      .slice(0, n)
      .map((x) => check(x, 400))
      .filter(Boolean);
  const validPly = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= ctx.plyCount ? (v as number) : undefined);

  const summary = arr(raw.summary)
    .slice(0, 4)
    .map((p) => check(p, 1400))
    .filter(Boolean);
  if (!summary.length) throw new UngroundedError('The AI game summary was empty or unsupported by the engine analysis.');
  const ins = raw.insights ?? {};
  const inst = raw.instructor ?? {};
  const moments = arr(inst.moments)
    .slice(0, 4)
    .map((m: any) => ({ ply: validPly(m?.ply), note: check(m?.note, 500) }))
    .filter((m): m is { ply: number; note: string } => !!m.ply && !!m.note);
  const practice = arr(inst.practice)
    .slice(0, 2)
    .map((m: any) => ({ ply: validPly(m?.ply), why: check(m?.why, 400) }))
    // A position to practise is the one before one of the student's own moves.
    .filter((m): m is { ply: number; why: string } => !!m.ply && ctx.userPlies.has(m.ply) && !!m.why);
  return {
    summary,
    insights: { strengths: list(ins.strengths, 4), weaknesses: list(ins.weaknesses, 4), trend: check(ins.trend, 500), observations: list(ins.observations, 2) },
    instructor: {
      priority: check(inst.priority, 160),
      whyItMatters: check(inst.whyItMatters, 900),
      moments,
      thinkDifferently: check(inst.thinkDifferently, 900),
      practice,
    },
    removed,
    model,
    createdAt: Date.now(),
    grounding: ctx.grounding,
  };
}
