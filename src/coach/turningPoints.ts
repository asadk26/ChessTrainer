// The turning points of a game, in order, for the story and a headline that fits the result:
// material won from the opponent's mistake, an edge let slip, a blunder the opponent didn't punish,
// and how it ended. Everything here comes from findings and the engine's evals — no guesses.
import type { Color, Finding, MoveEval, PlyRecord } from '../domain/types';
import { COLOR_NAME, materialPhrase, other } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { PATTERN_LABEL, type PatternTag } from '../analysis/patterns';

export interface Escape {
  /** Your move that should have lost. */
  ply: number;
  /** The opponent's move that let it go. */
  missedBy: PlyRecord;
  /** What they should have played ("27.Qxd8+"). */
  punish: string;
}

/** How a move would be written if `color` played `san` on move `n` ("27.Qxd8+", "27...Qxd8+"). */
const labelFor = (n: number, color: Color, san: string) => `${n}${color === 'w' ? '.' : '...'}${san}`;

/**
 * Your move cost at least two pawns' worth and left you clearly worse, and the opponent's very next
 * move (not Stockfish's) gave most of that back: they missed it.
 */
export function unpunished(plies: PlyRecord[], evals: MoveEval[], ply: number): Escape | undefined {
  const mine = evals[ply - 1];
  const theirs = evals[ply];
  const reply = plies[ply];
  if (!mine || !theirs || !reply || theirs.isBest || !theirs.bestSan) return;
  if (mine.cpBefore - mine.cpAfter < 200 || mine.cpAfter > -150) return;
  // Their eval before their move is your cpAfter, from their side; their move threw most of it away.
  if (theirs.cpBefore < 150 || theirs.cpBefore - theirs.cpAfter < 200 || theirs.cpAfter > theirs.cpBefore / 2) return;
  return { ply, missedBy: reply, punish: labelFor(reply.moveNumber, reply.color, theirs.bestSan) };
}

/** "White missed it: 27.Qe4 instead of 27.Qxd8+." */
export function missedLine(e: Escape): string {
  return `${COLOR_NAME[e.missedBy.color]} missed it: ${moveLabel(e.missedBy)} instead of ${e.punish}.`;
}

export interface TurningPoints {
  wonMaterial?: Finding;
  slip?: Finding;
  escapes: (Escape & { finding: Finding })[];
  mate?: { mate: PlyRecord; setup?: Finding };
}

export function turningPoints(plies: PlyRecord[], evals: MoveEval[] | undefined, findings: Finding[], userColor: Color): TurningPoints {
  const tp: TurningPoints = { escapes: [] };
  tp.wonMaterial = findings.find((f) => f.category === 'punished_mistake');
  tp.slip = findings.find((f) => f.category === 'let_edge_slip');
  if (evals) {
    const blunders = findings.filter((f) => f.kind === 'weakness' && f.severity >= 2 && f.confidence !== 'low' && !f.facts.stillWinning && f.ply > 0 && plies[f.ply - 1]?.color === userColor);
    for (const f of blunders) {
      if (tp.escapes.some((x) => x.ply === f.ply)) continue;
      const e = unpunished(plies, evals, f.ply);
      if (e) tp.escapes.push({ ...e, finding: f });
    }
  }
  const last = plies.at(-1);
  if (last?.san.endsWith('#') && last.color === userColor) tp.mate = { mate: last, setup: findings.find((f) => f.category === 'found_tactic' && f.facts.mateThreat && f.relatedPlies?.includes(last.ply)) };
  return tp;
}

/** What went wrong, in brackets after the move: its tactic, or a specific category. */
function what(f: Finding): string {
  if (f.facts.mate) return ' (allowed a mate)';
  if (f.facts.pattern && f.facts.patternSide !== 'better') return ` (${PATTERN_LABEL[f.facts.pattern as PatternTag].toLowerCase()})`;
  if (f.category === 'defended_grab') return ' (took a defended pawn)';
  return '';
}

/**
 * The story of a game you won with a blunder the opponent didn't punish, in move order: "You went a
 * pawn up when 18.Nc5 dropped one (18...Nxc5 19.dxc5 Bxc5). 23...Qa2 let the edge slip, though you
 * stayed material up. 26...Red8 should have cost you dearly, but White missed it — 27.Qe4 instead of
 * 27.Qxd8+. You finished with mate: 28...Rd1 set it up, and 29...Rxf1# ended it." `ahead`: the
 * general story's "you were up … from move …" sentence, kept when there is one.
 */
export function winStory(tp: TurningPoints, plies: PlyRecord[], userColor: Color, ahead?: string): string | undefined {
  const esc = tp.escapes[0];
  if (!esc) return undefined;
  const lbl = (ply: number) => moveLabel(plies[ply - 1]);
  const events: { ply: number; text: string }[] = [];
  if (ahead) events.push({ ply: 0, text: ahead });
  else if (tp.wonMaterial && tp.wonMaterial.ply < esc.ply) {
    const gain = Number(tp.wonMaterial.facts.gain ?? 1);
    const mistake = tp.wonMaterial.relatedPlies?.[0];
    const moves = (tp.wonMaterial.evidence.match(/collected it: (.*)\.$/) ?? [])[1];
    events.push({ ply: tp.wonMaterial.ply, text: `You went ${materialPhrase(gain)} up when ${mistake ? lbl(mistake) : 'your opponent'} dropped ${gain === 1 ? 'one' : 'it'}${moves ? ` (${moves})` : ''}.` });
  }
  if (tp.slip) events.push({ ply: tp.slip.ply, text: `${lbl(tp.slip.ply)} let the edge slip${tp.slip.facts.stillAhead ? ', though you stayed material up' : ''}.` });
  events.push({ ply: esc.ply, text: `${lbl(esc.ply)} should have cost you dearly, but ${COLOR_NAME[other(userColor)]} missed it — ${moveLabel(esc.missedBy)} instead of ${esc.punish}.` });
  if (tp.mate) events.push({ ply: tp.mate.mate.ply, text: tp.mate.setup ? `You finished with mate: ${lbl(tp.mate.setup.ply)} set it up, and ${moveLabel(tp.mate.mate)} ended it.` : `You finished it with checkmate: ${moveLabel(tp.mate.mate)}.` });
  return events.sort((a, b) => a.ply - b.ply).map((e) => e.text).join(' ');
}

/** The short version for the headline, in move order: "you went a pawn up, let the edge slip, blundered with 26...Red8 (…) and got away with it, then finished with mate". */
export function winArc(tp: TurningPoints, plies: PlyRecord[]): string | undefined {
  const esc = tp.escapes[0];
  if (!esc) return undefined;
  const steps: string[] = [];
  if (tp.wonMaterial && tp.wonMaterial.ply < esc.ply) steps.push(`went ${materialPhrase(Number(tp.wonMaterial.facts.gain ?? 1))} up`);
  if (tp.slip && tp.slip.ply < esc.ply) steps.push('let the edge slip');
  steps.push(`blundered with ${moveLabel(plies[esc.ply - 1])}${what(esc.finding)} and got away with it`);
  if (tp.mate) steps.push('finished with mate');
  const last = steps.pop()!;
  return steps.length ? `${steps.join(', ')}, then ${last}` : last;
}
