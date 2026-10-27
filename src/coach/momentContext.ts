// The facts an AI instructor gets for one position — all from Stockfish and the
// deterministic coach — and the checks its answer must pass before we show it.
// The model explains; it never decides the chess.
import type { AiExplanation, Finding, PlyContext, StoredGame } from '../domain/types';
import { COLOR_NAME, materialBalance, materialPhrase, other } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { positionCp, scoreToCp } from '../analysis/evaluation';
import { BAND_LABEL, bandChange, bandOf } from '../analysis/evalBand';
import { QUALITY_LABEL, gapBetween, qualityOf, qualityOfGap, rankCandidates } from '../analysis/moveQuality';
import { lineToPoint } from '../analysis/linePoint';
import { compareLines } from '../analysis/compareLines';
import { buildContexts } from '../analysis/context';
import { CATEGORIES, THEMES } from '../domain/categories';
import { themeOf, countsAsPattern } from './report';
import { extractJson, mentionsOnlyKnownMoves } from './llmCoach';
import { moveBoardFacts, type MoveBoardFacts } from '../analysis/boardFacts';
import { MATE_CP, formatCp } from '../analysis/evaluation';
import { lineToSan } from '../chess/board';
import type { PriorGameFindings } from '../analysis/moments';

const band = (cp: number) => BAND_LABEL[bandOf(cp)].toLowerCase();

/** Bumped when the explanation's input or rules change, so older cached explanations are redone on request. */
export const EXPLAIN_VERSION = 'why2';

/** Below this win% gap the two moves are close: say so in one line instead of inventing reasons. */
export const SMALL_DIFFERENCE = 6;

/** "+0.6", "−1.2", "M3" (mate for the mover), "−M2" (getting mated). */
export function evalText(cp: number): string {
  if (Math.abs(cp) < MATE_CP - 1000) return formatCp(cp);
  const n = Math.max(1, Math.round((MATE_CP - Math.abs(cp)) / 10));
  return cp > 0 ? `M${n}` : `-M${n}`;
}

function factList(f: MoveBoardFacts | undefined): string[] {
  if (!f) return [];
  return [...f.does, ...f.newPins, ...f.leavesHanging, ...f.ignoresHanging];
}
const sanLine = (frames: { san: string }[]) => frames.map((f) => f.san);

export interface MomentContext {
  /** The facts sent to the model (serialised as JSON). */
  facts: Record<string, unknown>;
  /** Every move the answer may mention. */
  allowedMoves: Set<string>;
  /** Changes when the underlying engine analysis changes. */
  grounding: string;
  /** The two moves are close: one plain line is the honest explanation. */
  smallDifference?: boolean;
  /** A deterministic concrete reason, used if the AI's answer doesn't name one. */
  fallbackReason?: string;
  /** For the one-line small-difference answer. */
  summary?: { playedSan: string; bestSan?: string; evalPlayed: string; evalBest: string };
}

/** Recurring patterns from recent games: themes with credible findings in 2+ of them. */
export function recurringPatterns(prior: PriorGameFindings[], here: Finding[]) {
  const recent = [...prior].sort((a, b) => b.playedAt - a.playedAt).slice(0, 8);
  const games = new Map<string, number>();
  for (const g of recent) {
    const themes = new Set(g.findings.filter((f) => f.kind === 'weakness' && countsAsPattern(f)).map((f) => themeOf(f.category)).filter(Boolean));
    themes.forEach((t) => games.set(t!, (games.get(t!) ?? 0) + 1));
  }
  const hereThemes = new Set(here.map((f) => themeOf(f.category)).filter(Boolean));
  return [...games.entries()]
    .filter(([t, n]) => n >= 2 || (n >= 1 && hereThemes.has(t as never)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => ({ pattern: THEMES[t as keyof typeof THEMES].label, inRecentGames: `${n} of the last ${recent.length}`, relatedToThisMove: hereThemes.has(t as never) }));
}

function situation(c: PlyContext | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.farAhead) out.push('you are far ahead in material');
  else if (c.ahead) out.push('you are ahead in material');
  if (c.behind) out.push('you are behind in material');
  if (c.kingPressure) out.push('your king is under pressure');
  if (c.attackingKing) out.push("you have chances against the opponent's king");
  if (c.race) out.push('it is a pawn race');
  else if (c.endgame) out.push('it is an endgame');
  return out;
}

/**
 * Structured, engine-grounded context for the move at `ply` (the position before it,
 * the move played, Stockfish's candidates and lines, and what each leads to).
 */
export function buildMomentContext(game: StoredGame, ply: number, opts: { rating: number; prior: PriorGameFindings[] }): MomentContext | undefined {
  const played = game.plies[ply - 1];
  const before = game.analysis?.positions[ply - 1];
  const after = game.analysis?.positions[ply];
  const moves = game.analysis?.moves;
  if (!played || !before?.lines[0] || !moves) return undefined;
  const me = played.color;
  const isUser = me === game.userColor;
  const opp = other(me);
  const bestCp = scoreToCp(before.lines[0].score);
  const playedCp = after ? -positionCp(after) : bestCp;
  const quality = qualityOf(before, played.uci, playedCp) ?? qualityOfGap(gapBetween(bestCp, playedCp), played.uci === before.lines[0].pv[0]);
  const allowed = new Set<string>(game.plies.map((p) => p.san.replace(/[+#]$/, '')));
  const add = (sans: string[]) => sans.forEach((s) => allowed.add(s.replace(/[+#]$/, '')));

  const candidates = rankCandidates(before).slice(0, 3).map((r) => {
    const line = before.lines.find((l) => l.pv[0] === r.uci)!;
    const pt = lineToPoint(played.fenBefore, line.pv, me, 8);
    add(sanLine(pt.frames));
    return { move: pt.frames[0]?.san, quality: QUALITY_LABEL[r.quality], evaluation: band(r.cp), line: sanLine(pt.frames), whatHappens: pt.text };
  });
  const playedLine = lineToPoint(played.fenBefore, [played.uci, ...(after?.lines[0]?.pv ?? [])], me, 8);
  add(sanLine(playedLine.frames));
  const replyLine = after?.lines[0]?.pv.length ? lineToPoint(played.fenAfter, after.lines[0].pv, me, 8) : undefined;
  if (replyLine) add(sanLine(replyLine.frames));
  const cmp =
    quality !== 'best'
      ? compareLines({ fen: played.fenBefore, mover: me, preferred: { ucis: before.lines[0].pv, cp: bestCp }, other: { ucis: [played.uci, ...(after?.lines[0]?.pv ?? [])], cp: playedCp } })
      : undefined;
  if (cmp) {
    add(sanLine(cmp.preferredFrames));
    add(sanLine(cmp.otherFrames));
  }
  const contexts = buildContexts(game.plies, moves, me);
  const here = game.findings.filter((f) => (f.ply === ply || f.relatedPlies?.includes(ply)) && f.confidence !== 'low');
  const swing = bandChange(bestCp, playedCp);
  const expl = game.explanations?.[ply];
  const mat = materialBalance(played.fenBefore, me);

  const facts = {
    student: { color: COLOR_NAME[me], rating: opts.rating, isStudentsMove: isUser },
    fen: played.fenBefore,
    moveNumber: played.moveNumber,
    sideToMove: COLOR_NAME[me],
    situation: [mat ? `material: ${mat > 0 ? `you are up ${materialPhrase(mat)}` : `you are down ${materialPhrase(-mat)}`}` : 'material is level', ...situation(contexts.get(ply))],
    movePlayed: {
      move: played.san,
      label: moveLabel(played),
      quality: QUALITY_LABEL[quality],
      evaluationBefore: band(bestCp),
      evaluationAfter: band(playedCp),
      swing: swing.text,
      lineAfterIt: sanLine(playedLine.frames),
      whatHappens: playedLine.text,
    },
    stockfishCandidates: candidates,
    opponentStrongestReply: replyLine
      ? { move: replyLine.frames[0]?.san, by: COLOR_NAME[opp], line: sanLine(replyLine.frames), whatHappens: replyLine.text }
      : null,
    comparison: cmp
      ? {
          summary: cmp.summary,
          clearDifference: cmp.clear,
          betterMoveFacts: cmp.card.preferred.map((r) => r.text),
          playedMoveFacts: cmp.card.other.map((r) => r.text),
        }
      : null,
    detectedFeatures: here.map((f) => ({ kind: f.kind, type: f.kind === 'weakness' ? CATEGORIES[f.category as keyof typeof CATEGORIES]?.label : f.category, note: f.evidence })),
    builtInCoachExplanation: expl ? { intent: expl.intent, problem: expl.problem, whyBetter: expl.better } : null,
    recentRecurringPatterns: recurringPatterns(opts.prior, here),
  };
  // Concrete engine and board facts: the explanation must cite at least one of these.
  const bestUci = before.lines[0].pv[0];
  const gap = gapBetween(bestCp, playedCp);
  const bestFacts = quality !== 'best' ? moveBoardFacts(played.fenBefore, bestUci, before.lines[0].pv) : undefined;
  const playedFacts = moveBoardFacts(played.fenBefore, played.uci, [played.uci, ...(after?.lines[0]?.pv ?? [])]);
  const bestLine4 = lineToSan(played.fenBefore, before.lines[0].pv, 4);
  const playedLine4 = lineToSan(played.fenBefore, [played.uci, ...(after?.lines[0]?.pv ?? [])], 4);
  add(bestLine4);
  add(playedLine4);
  (facts as Record<string, unknown>).engineFacts = {
    pointOfView: COLOR_NAME[me],
    evaluationBefore: evalText(bestCp),
    afterPlayedMove: { move: played.san, evaluation: evalText(playedCp), first4Moves: playedLine4 },
    afterBestMove: quality !== 'best' ? { move: bestLine4[0], evaluation: evalText(bestCp), first4Moves: bestLine4 } : null,
    smallDifference: gap < SMALL_DIFFERENCE,
    differenceInWinningChances: `${Math.round(gap)}%`,
  };
  (facts as Record<string, unknown>).boardFacts = {
    playedMove: factList(playedFacts),
    bestMove: factList(bestFacts),
  };
  const grounding = `${before.lines[0].pv[0]}|${before.depth}|${bestCp}|${playedCp}|${EXPLAIN_VERSION}`;
  const smallDifference = gap < SMALL_DIFFERENCE;
  const reasons = factList(bestFacts);
  // Reasons start with a move in SAN ("f4 opens…", "Nf3 develops…"): never change their case.
  const fallbackReason = reasons.length ? `${reasons[0]}.` : undefined;
  const summary = { playedSan: played.san, bestSan: quality !== 'best' ? bestLine4[0] : undefined, evalPlayed: evalText(playedCp), evalBest: evalText(bestCp) };
  return { facts, allowedMoves: allowed, grounding, smallDifference, fallbackReason, summary };
}

/**
 * When the two moves are close, the honest explanation is one plain line — built from the
 * engine and board facts, no AI needed (and nothing to invent).
 */
export function smallDifferenceExplanation(ctx: MomentContext, ply: number): AiExplanation {
  const s = ctx.summary!;
  const reason = ctx.fallbackReason ? `: ${ctx.fallbackReason}` : '.';
  const line = s.bestSan
    ? `Small difference — ${s.playedSan} is fine. Stockfish slightly prefers ${s.bestSan} (${s.evalBest} instead of ${s.evalPlayed})${reason}`
    : `${s.playedSan} was Stockfish's choice.`;
  return { ply, tryingTo: '', missed: '', whyBetter: line, opponentReply: '', difference: '', takeaway: '', pattern: '', confidence: 'small_difference', model: 'none', createdAt: Date.now(), grounding: ctx.grounding };
}

export function momentPrompt(ctx: MomentContext): string {
  return `Explain this position to the student. All chess facts are below; use only these.\n\n${JSON.stringify(ctx.facts, null, 1)}`;
}

const FIELDS = ['tryingTo', 'missed', 'whyBetter', 'opponentReply', 'difference', 'takeaway', 'pattern'] as const;

export class UngroundedError extends Error {}

/** Parse the model's answer, keeping it only if it is well-formed and mentions no move outside the engine facts. */
export function parseMomentExplanation(text: string, ctx: MomentContext, ply: number, model?: string): AiExplanation {
  const raw = extractJson(text) as Record<string, unknown>;
  const out = { ply, model, createdAt: Date.now(), grounding: ctx.grounding } as AiExplanation;
  for (const k of FIELDS) {
    const v = raw[k];
    const s = typeof v === 'string' ? v.trim() : '';
    if (s.length > 600) throw new UngroundedError(`The AI answer was too long (${k}).`);
    if (s && !mentionsOnlyKnownMoves(s, ctx.allowedMoves)) throw new UngroundedError(`The AI mentioned a move that isn't in Stockfish's analysis (${k}).`);
    out[k] = s;
  }
  if (!out.whyBetter && !out.takeaway) throw new UngroundedError('The AI answer was empty.');
  out.confidence = ctx.smallDifference || raw.confidence === 'small_difference' ? 'small_difference' : 'clear';
  // A real difference needs a concrete reason: a square or a move. If the answer only waves its
  // hands, lead with a reason taken from the board facts instead.
  if (out.confidence === 'clear' && !namesConcreteReason(out.whyBetter) && ctx.fallbackReason)
    out.whyBetter = `${ctx.fallbackReason}${out.whyBetter ? ` ${out.whyBetter}` : ''}`;
  return out;
}

/** Mentions a square (e5) or a move (Nf3, O-O): something checkable on the board. */
export function namesConcreteReason(text: string): boolean {
  return /\b[a-h][1-8]\b/.test(text) || /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|O-O(?:-O)?)\b/.test(text);
}
