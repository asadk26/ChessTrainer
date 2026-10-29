// Builds the concise post-game coaching report from findings + history.
import { Chess } from 'chess.js';
import { PATTERN_FOCUS, PATTERN_LABEL, PATTERN_PHRASE, forkedOnRim, patternLesson, type PatternTag } from '../analysis/patterns';
import type { CategoryId, Color, Finding, GameReport, MoveEval, PlyContext, PlyRecord, ReportItem, StrengthId, ThemeId } from '../domain/types';
import { rootCause } from '../analysis/rootCause';
import { CATEGORIES, STRENGTHS, THEMES } from '../domain/categories';
import { COLOR_NAME, materialPhrase, other } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import type { PriorGameFindings } from '../analysis/moments';
import { summarizePhases } from '../analysis/context';

export interface ReportInput {
  plies: PlyRecord[];
  findings: Finding[];
  userColor: Color;
  prior: PriorGameFindings[];
  contexts?: Map<number, PlyContext>;
  /** The player won (as confirmed or per the PGN). */
  won?: boolean;
  lost?: boolean;
  /** How the game ended, when it matters (won by resignation from a worse position, an early resignation). */
  ending?: string;
  /** Per-move engine evals, for the root-cause story (decisive drop + its setup). */
  evals?: MoveEval[];
  termination?: string;
}

export interface ThemeGroup {
  theme: ThemeId;
  findings: Finding[];
  /** Weight × severity × confidence. */
  score: number;
  /** Enough evidence to make claims about it: one high-confidence finding, or two medium ones. */
  strong: boolean;
}

const RECENT = 5;
export const REPORT_VERSION = 21;

/** Positions to draw for a theme: each episode's move, plus the retreat in a round trip. Max 4. */
function keyPliesOf(group: ThemeGroup, plies: PlyRecord[]): number[] {
  const out: number[] = [];
  const roundTrip = new Set(['inefficient_moves', 'premature_attack', 'pointless_check']);
  for (const e of episodes(group, plies)) {
    if (e.finding.ply <= 0) continue;
    out.push(e.finding.ply);
    const rel = e.finding.relatedPlies?.[0];
    if (rel && roundTrip.has(e.finding.category)) out.push(rel);
  }
  return [...new Set(out)].slice(0, 4);
}

/** Low-confidence findings are speculative: kept in storage, never used for coaching claims. */
export const isCredible = (f: Finding) => f.confidence !== 'low';
const confWeight = (f: Finding) => (f.confidence === 'high' ? 1 : f.confidence === 'low' ? 0 : 0.6);

/** Findings about the state of the game (slow development, the clock…), not about one move. */
export function isStateFinding(f: Finding): boolean {
  // King-pawn and pawn-storm findings are judged by what followed, often on a move Stockfish was fine
  // with: they belong in the story, never in a "find a better move" lesson.
  return ['development', 'passive_piece', 'time_management', 'king_pawns', 'pawn_storm'].includes(f.category) || (f.category === 'king_safety' && !!f.facts.notCastled);
}

/** A finding that can count toward a pattern (in this game or as history). */
export const countsAsPattern = (f: Finding) => f.kind === 'weakness' && f.severity >= 2 && isCredible(f);

/**
 * A finding that can lead this game's summary (headline, focus, what hurt). A slip made while clearly
 * winning before and after it (or a quicker mate missed while still mating) is a lesson to look at,
 * never what the game is about.
 */
const leadsSummary = (f: Finding) => countsAsPattern(f) && !f.facts.stillWinning;

function plyLabel(plies: PlyRecord[], ply: number): string {
  const p = plies[ply - 1];
  return p ? moveLabel(p) : `ply ${ply}`;
}

export function themeOf(category: string): ThemeId | undefined {
  return (CATEGORIES as Record<string, { theme: ThemeId }>)[category]?.theme;
}

export function groupByTheme(findings: Finding[]): ThemeGroup[] {
  const groups = new Map<ThemeId, Finding[]>();
  for (const f of findings) {
    if (!countsAsPattern(f)) continue;
    // A move that walked into a tactic (a pawn fork after a retreat to the rim…) belongs with tactics.
    const t = f.facts.pattern && f.facts.patternSide !== 'better' && f.facts.pattern !== 'hanging_piece' ? 'tactics' : themeOf(f.category);
    if (!t) continue;
    groups.set(t, [...(groups.get(t) ?? []), f]);
  }
  return [...groups.entries()]
    .map(([theme, fs]) => ({
      theme,
      findings: fs,
      score: fs.reduce((a, f) => a + CATEGORIES[f.category as CategoryId].weight * f.severity * confWeight(f), 0),
      // Two categories on the same move are one piece of evidence, not two.
      strong: fs.some((f) => f.confidence === 'high') || new Set(fs.map((f) => f.ply)).size >= 2,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Distinct "episodes" (move or move → follow-up) in a theme, labelled for text. */
function episodes(group: ThemeGroup, plies: PlyRecord[]): { label: string; plies: number[]; finding: Finding }[] {
  const seen = new Set<number>();
  const out: { label: string; plies: number[]; finding: Finding }[] = [];
  for (const f of [...group.findings].sort((a, b) => a.ply - b.ply)) {
    if (seen.has(f.ply)) continue;
    seen.add(f.ply);
    const rel = f.relatedPlies?.[0];
    out.push({
      label: rel ? `${plyLabel(plies, f.ply)} followed by ${plies[rel - 1]?.san}` : plyLabel(plies, f.ply),
      plies: [f.ply, ...(f.relatedPlies ?? [])],
      finding: f,
    });
  }
  return out;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/** Short clause per conversion finding, for "you made it harder: …" sentences. */
function conversionClause(f: Finding, plies: PlyRecord[], opp: string): string {
  const mv = plyLabel(plies, f.ply);
  switch (f.category) {
    case 'hunting_material':
      return `${mv} grabbed another pawn before finishing development`;
    case 'gave_back_material':
      return `${mv} gave back ${f.facts.victimPiece ? `your ${f.facts.victimPiece}` : 'material'}`;
    case 'unnecessary_complications':
      return `${mv} returned material for complications`;
    case 'allowed_counterplay':
      if (f.facts.perpetual) return `${mv} let ${opp} force a draw by perpetual check (${(f.facts.replyLine as string[]).slice(0, 3).join(' ')})`;
      return f.facts.drawish ? `${mv} let ${opp} start checking your king with a draw in hand` : `${mv} let ${opp}'s pieces come alive against your king`;
    case 'failure_to_simplify':
      return `${mv} kept the queens on when a trade was there`;
    default:
      return `${mv}: ${lowerFirst(f.evidence)}`;
  }
}

/**
 * Moves that walked into the same tactic share one sentence: "19...Rfd8 and 20...Rdb8 both walked
 * into a back-rank attack: Rxd8+ hits…; Qxb8+ hits…". Others keep their own.
 */
function mergeByPattern(eps: { label: string; finding: Finding }[], plies: PlyRecord[]): string {
  const key = (e: { finding: Finding }) => (e.finding.facts.pattern && e.finding.facts.patternSide !== 'better' ? String(e.finding.facts.pattern) : undefined);
  const out: string[] = [];
  const done = new Set<number>();
  eps.forEach((e, k) => {
    if (done.has(k)) return;
    const tag = key(e);
    const same = tag ? eps.map((x, j) => ({ x, j })).filter(({ x }) => key(x) === tag) : [];
    if (same.length < 2) return void out.push(onMove(e));
    same.forEach(({ j }) => done.add(j));
    const group = same.map(({ x }) => x).sort((a, b) => a.finding.ply - b.finding.ply);
    const lead = (x: { finding: Finding }) => (Array.isArray(x.finding.facts.patternLead) ? ` (after ${(x.finding.facts.patternLead as string[]).join(' ')})` : '');
    const ev = group.map((x) => String(x.finding.facts.patternEvidence ?? ''));
    const head = `${joinList(group.map((x) => plyLabel(plies, x.finding.ply)))} ${group.length === 2 ? 'both' : 'each'} ${PATTERN_PHRASE[tag as PatternTag].refutation}`;
    // Same words after the key move ("hits the king on its back rank…"): say them once.
    const rest = ev.map((t) => t.slice(t.indexOf(' ') + 1));
    if (rest.every((r) => r === rest[0])) out.push(`${head}: ${group.map((x, j) => `${ev[j].split(' ')[0]}${lead(x)}`).join(', then ')} — each ${rest[0]}.`);
    else out.push(`${head}: ${group.map((x, j) => `${lead(x) ? `after ${(x.finding.facts.patternLead as string[]).join(' ')}, ` : ''}${ev[j]}`).join('; ')}.`);
  });
  return out.join(' ');
}

/** "On 13.Nh3, …" — unless the evidence already starts with the move. */
const onMove = (e: { label: string; finding: Finding }) => (e.finding.evidence.startsWith(e.label.split(' ')[0]) ? e.finding.evidence : `On ${e.label}, ${lowerFirst(e.finding.evidence)}`);

function hurtText(group: ThemeGroup, plies: PlyRecord[], userColor: Color): string {
  const eps = episodes(group, plies);
  const opp = COLOR_NAME[other(userColor)];
  const labels = eps.map((e) => e.label);
  switch (group.theme) {
    case 'active_without_followup': {
      const chasedEp = eps.find((e) => e.finding.facts.chased);
      if (chasedEp && eps.length === 1) return chasedEp.finding.evidence;
      const n = eps.length;
      return `${n > 1 ? 'Several moves looked active' : 'A move looked active'} but had no follow-up: ${joinList(labels)}. ${n > 1 ? 'Each time' : 'There'}, ${opp}'s simplest reply left your piece with nothing to do, so you spent tempi without improving your position.`;
    }
    case 'conversion': {
      const lead = Math.max(...group.findings.map((f) => Number(f.facts.material ?? f.facts.materialBefore ?? 0)));
      const top = [...eps].sort((a, b) => b.finding.severity - a.finding.severity || a.finding.ply - b.finding.ply).slice(0, 4);
      const clauses = top.sort((a, b) => a.finding.ply - b.finding.ply).map((e) => conversionClause(e.finding, plies, opp));
      if (group.findings.some((f) => f.facts.perpetual)) return `You had a winning position, but ${joinList(clauses)}.`;
      return `${lead >= 3 ? `You were up ${materialPhrase(lead)}, but you` : 'When ahead, you'} made the win harder than it needed to be: ${joinList(clauses)}.`;
    }
    case 'tactics': {
      const mates = eps.filter((e) => e.finding.facts.mateIn);
      if (mates.length >= 2) {
        const rest = eps.filter((e) => !mates.includes(e)).map(onMove);
        const each = mates.map((e) => `move ${plies[e.finding.ply - 1].moveNumber} (${e.finding.facts.bestSan} instead of ${plies[e.finding.ply - 1].san})`);
        return [`You missed a checkmate ${mates.length === 2 ? 'twice' : `${mates.length} times`}: ${joinList(each)}. ${mates.every((e) => plies[e.finding.ply - 1].captured) ? 'Each time you took material instead — but mate ends the game, so checks come first.' : 'Checks come first: mate ends the game.'}`, ...rest].join(' ');
      }
      return mergeByPattern([...eps].sort((a, b) => b.finding.severity - a.finding.severity), plies);
    }
    case 'king_safety': {
      const storms = eps.filter((e) => Array.isArray(e.finding.facts.storm) && (e.finding.facts.storm as string[]).length >= 2);
      if (storms.length >= 2) {
        const rest = eps.filter((e) => !storms.includes(e));
        return [
          `${joinList(storms.map((e) => e.label))} pushed pawns in front of your own king while ${opp}'s pawns were storming toward it — each one opened lines for the attack.`,
          ...rest.map((e) => e.finding.evidence),
        ].join(' ');
      }
      return eps.map((e) => e.finding.evidence).join(' ');
    }
    case 'loose_pieces':
    case 'stranded':
    case 'opponent_threats':
    case 'endgame':
    case 'opening_development':
      return eps.map((e) => e.finding.evidence).join(' ');
    default:
      return `${THEMES[group.theme].label}: ${eps.map((e) => lowerFirst(e.finding.evidence)).join(' ')}`;
  }
}

/** Your king was attacked: you were mated, allowed mate, or the coach found an attack or a weakness around it. */
export function kingUnderAttack(findings: Finding[], plies: PlyRecord[], userColor: Color): boolean {
  const last = plies[plies.length - 1];
  if (last) {
    const c = new Chess(last.fenAfter);
    if (c.isCheckmate() && c.turn() === userColor) return true;
  }
  return findings.some(
    (f) =>
      f.kind === 'weakness' &&
      isCredible(f) &&
      (!!f.facts.mate || ['back_rank', 'opened_line'].includes(String(f.facts.pattern)) || ['king_safety', 'king_pawns', 'pawn_storm'].includes(f.category)),
  );
}

function didWellItems(findings: Finding[], plies: PlyRecord[], userColor: Color): ReportItem[] {
  // Never praise king safety in a game where the king was mated or attacked.
  const kingHit = kingUnderAttack(findings, plies, userColor);
  const strengths = findings.filter((f) => f.kind === 'strength' && isCredible(f) && !(kingHit && f.category === 'castled_early'));
  const has = (id: StrengthId) => strengths.find((f) => f.category === id);
  const items: ReportItem[] = [];
  const opp = COLOR_NAME[other(userColor)];
  const plyList = (f: Finding) => [f.ply, ...(f.relatedPlies ?? [])].filter((p) => p > 0);
  const push = (f: Finding | undefined, text: (f: Finding) => string) => {
    if (!f) return;
    // One credit per move: don't praise the same move twice in different words.
    const plies = plyList(f);
    if (plies.length && plies.every((p) => items.some((it) => it.plies?.includes(p)))) return;
    items.push({ text: text(f), category: f.category as StrengthId, plies });
  };

  const opening = [has('center_control'), has('developed_pieces'), has('castled_early')].filter(Boolean) as Finding[];
  if (opening.length >= 2) {
    const parts: string[] = [];
    const c = has('center_control');
    if (c) parts.push(`claimed the center with ${joinList(c.facts.moves as string[])}`);
    if (has('developed_pieces')) parts.push('got all your minor pieces out by move 10');
    const k = has('castled_early');
    if (k) parts.push(`castled on move ${k.facts.move}`);
    items.push({ text: `Your opening fundamentals were solid: you ${joinList(parts)}.`, category: opening[0].category as StrengthId, plies: opening.map((f) => f.ply).filter((p) => p > 0) });
  }

  for (const f of strengths.filter((x) => x.category === 'found_tactic')) push(f, (x) => x.evidence);
  push(has('won_free_material'), (f) => `${f.evidence} When your opponent left something hanging, you noticed.`);
  push(has('passed_pawn'), (f) => `${f.evidence} In the endgame that pawn was worth more than any piece.`);
  push(has('neutralized_counterplay'), (f) => (f.facts.captured ? f.evidence : `${f.evidence} Trading off the attackers was exactly right.`));
  push(has('opened_vs_king'), (f) => `${plyLabel(plies, f.ply)} was a good idea: ${opp}'s king was still on ${f.facts.oppKing}, and you started opening lines toward it.`);
  push(has('defensive_resource'), (f) => f.evidence);
  push(has('simplified_when_ahead'), (f) => `${f.evidence} Trades make a material lead easier to convert.`);
  push(has('punished_mistake'), (f) => `${f.evidence} When your opponent slipped, you noticed.`);
  if (has('no_hanging')) items.push({ text: "You didn't leave any pieces hanging — that's the most important habit at this level.", category: 'no_hanging' });
  if (items.length < 2 && opening.length === 1) items.push({ text: STRENGTHS[opening[0].category as StrengthId].phrase, category: opening[0].category as StrengthId });
  if (items.length < 2 && has('converted_advantage')) items.push({ text: STRENGTHS.converted_advantage.phrase, category: 'converted_advantage' });
  return items.slice(0, 3);
}

const SOFT_NOTES: Partial<Record<CategoryId, (f: Finding) => string>> = {
  central_tension: (f) =>
    `${f.evidence.replace(/\.$/, '')}. ${f.facts.engineFine ? "That's not a mistake, but it" : 'It'} let your opponent off the hook a little: keeping the tension leaves them the harder decision.`,
  premature_capture: (f) => `${f.evidence} Not a big deal, but worth noticing.`,
  time_management: (f) => f.evidence,
  early_queen: (f) => f.evidence,
  failure_to_simplify: (f) => `${f.evidence} Not costly this time, but a good habit when ahead.`,
  unnecessary_complications: (f) => `${f.evidence} It didn't cost much, but simple is safer.`,
  hunting_material: (f) => f.evidence,
  gave_back_material: (f) => f.evidence,
  development: (f) => `${f.evidence} It didn't cost anything this game, but it's a habit worth watching.`,
};

/** A small, cost-free note: shown under "smaller notes", never as a main problem or the focus. */
const isSoft = (f: Finding) => f.severity === 1 && !!SOFT_NOTES[f.category as CategoryId];

function recentOf(prior: PriorGameFindings[]) {
  return [...prior].sort((a, b) => b.playedAt - a.playedAt).slice(0, RECENT - 1);
}

/**
 * The specific habit a finding represents. Broad themes hide real differences:
 * "didn't castle" and "pushed pawns in front of a castled king" are both king
 * safety, but different habits; being chased by pawns isn't a knight round trip.
 */
export function habitKey(f: Finding): string {
  if (f.category === 'king_safety') return f.facts.notCastled ? 'king_safety:not_castled' : 'king_safety:shelter';
  if (f.facts.chased) return 'inefficient_moves:chased_by_pawns';
  const t = themeOf(f.category);
  return t ? `theme:${t}` : f.category;
}

const HABIT_LABEL: Record<string, string> = {
  'king_safety:shelter': 'pushing pawns in front of your castled king',
  'king_safety:not_castled': 'leaving your king in the center',
  'inefficient_moves:chased_by_pawns': 'letting a piece get chased around by pawns',
};

/** Plain name for the habit behind a group, e.g. "pushing pawns in front of your castled king". */
function habitLabel(group: ThemeGroup): string {
  const keys = group.findings.map(habitKey);
  const specific = keys.find((k) => HABIT_LABEL[k]);
  return specific ? HABIT_LABEL[specific] : THEMES[group.theme].label.toLowerCase();
}

function priorHasTheme(g: PriorGameFindings, theme: ThemeId, current?: Finding[]) {
  const keys = current ? new Set(current.filter((f) => themeOf(f.category) === theme).map(habitKey)) : undefined;
  return g.findings.some((f) => countsAsPattern(f) && themeOf(f.category) === theme && (!keys || keys.has(habitKey(f))));
}

function recurringText(groups: ThemeGroup[], plies: PlyRecord[], prior: PriorGameFindings[]): string {
  const recentPrior = recentOf(prior);
  const strong = groups.filter((g) => g.strong);
  const goodNews = (): string => {
    // "Gone" means no credible sign of it at all this game; "clear before" means strong evidence back then.
    const current = new Set(groups.map((g) => g.theme));
    const counts = new Map<ThemeId, number>();
    for (const g of recentPrior) {
      groupByTheme(g.findings)
        .filter((x) => x.strong)
        .forEach((x) => counts.set(x.theme, (counts.get(x.theme) ?? 0) + 1));
    }
    const improved = [...counts.entries()].filter(([t, n]) => n >= 2 && !current.has(t)).sort((a, b) => b[1] - a[1])[0];
    return improved
      ? ` Good sign: ${THEMES[improved[0]].label.toLowerCase()} (clear in ${improved[1]} of your previous ${recentPrior.length} games) didn't clearly show up this time.`
      : '';
  };

  if (strong.length === 0) {
    if (!recentPrior.length) return "This is your first analyzed game, so there's no pattern to compare against yet.";
    return `Nothing in this game clearly repeats an earlier pattern.${goodNews()}`;
  }
  // Prefer a strong theme that actually has history; otherwise the strongest one.
  const withHistory = strong.find((g) => recentPrior.some((p) => priorHasTheme(p, g.theme, g.findings)));
  const top = withHistory ?? strong[0];
  const themeLabel = habitLabel(top);
  const eps = episodes(top, plies);
  const inThisGame =
    eps.length > 2
      ? `In this game, ${joinList(eps.map((e) => e.label))} all fit that pattern.`
      : eps.length === 2
        ? `In this game, ${joinList(eps.map((e) => e.label))} both fit that pattern.`
        : `In this game, ${eps[0].label} fits it.`;
  if (recentPrior.length === 0) {
    return `This is your first analyzed game, so nothing counts as a pattern yet. ${inThisGame} I'll watch whether this shows up again — one game isn't a trend.`;
  }
  const withTheme = recentPrior.filter((g) => priorHasTheme(g, top.theme, top.findings));
  const total = recentPrior.length + 1;
  let text: string;
  if (withTheme.length === 0) {
    text = `${capitalise(themeLabel)} didn't show up in your previous ${recentPrior.length === 1 ? 'game' : `${recentPrior.length} games`}, so treat this as a possible tendency, not a pattern. ${inThisGame}`;
  } else if (withTheme.length === 1) {
    text = `Possible tendency: something similar happened in your game ${withTheme[0].label}. ${inThisGame} That's 2 of your last ${total} games — worth watching.`;
  } else {
    text = `This has now appeared in ${withTheme.length + 1} of your last ${total} games: ${again(THEMES[top.theme].clause)}. ${inThisGame} This is becoming more important than opening theory for you.`;
  }
  return text + goodNews();
}

/** "you made it harder…" → "you again made it harder…"; other clauses → "again, pieces were left…". */
function again(clause: string): string {
  return clause.startsWith('you ') ? `you again ${clause.slice(4)}` : `again, ${clause}`;
}

function capitalise(s: string) {
  // A sentence that starts with a pawn move ("g4 attacks…") keeps its lowercase SAN.
  return /^[a-h](x[a-h])?[1-8]/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The focus comes from this game's strong evidence. History can tip the
 * balance between strong themes, but can never promote a weak match.
 */
export function chooseFocus(groups: ThemeGroup[], prior: PriorGameFindings[]): ThemeId | undefined {
  const eligible = groups.filter((g) => g.strong);
  if (!eligible.length) return undefined;
  const recentPrior = recentOf(prior);
  const scoreOf = (g: ThemeGroup) => g.score + 0.5 * Math.min(3, recentPrior.filter((p) => priorHasTheme(p, g.theme, g.findings)).length);
  return [...eligible].sort((a, b) => scoreOf(b) - scoreOf(a))[0].theme;
}

/**
 * Theme focus text, adjusted to what actually happened. King safety in a game
 * where you castled early is about keeping the pawn shield, not about castling.
 */
export function focusFor(theme: ThemeId, findings: Finding[]): { focusTitle: string; focusDetail: string; clause: string; label: string } {
  const meta = THEMES[theme];
  // A specific tactic decided the game (a discovered attack, a fork…): that is the lesson, not
  // the generic theme text.
  // It can come from a neighbouring theme (a fork found on a "calculation" move), as long as it
  // mattered at least as much as anything in this theme.
  const credible = (f: Finding) => f.kind === 'weakness' && f.severity >= 2 && f.confidence !== 'low';
  const top = Math.max(0, ...findings.filter((f) => credible(f) && themeOf(f.category) === theme).map((f) => f.severity));
  const decided = findings
    .filter((f) => credible(f) && f.facts.pattern && f.facts.patternSide !== 'better' && (themeOf(f.category) === theme || f.severity >= top))
    .sort((a, b) => b.severity - a.severity || Number(themeOf(b.category) === theme) - Number(themeOf(a.category) === theme))[0];
  if (decided) {
    const tag = decided.facts.pattern as PatternTag;
    return { focusTitle: PATTERN_FOCUS[tag].title, focusDetail: PATTERN_FOCUS[tag].detail, clause: `you ${PATTERN_PHRASE[tag].refutation}`, label: PATTERN_LABEL[tag] };
  }
  if (theme === 'loose_pieces') {
    // "Blunder check" is only the lesson when a piece really was simply left hanging. Allowing mate,
    // or losing material to a reply we can't name, needs the full checks-captures-attacks search.
    const here = findings.filter((f) => f.kind === 'weakness' && themeOf(f.category) === theme && f.severity >= 2 && f.confidence !== 'low');
    if (here.some((f) => f.facts.mate && f.severity >= 3))
      return {
        ...meta,
        focusTitle: 'Before every move, look at the checks your opponent will have next.',
        focusDetail: 'Checkmates at this level almost always start with a check you never looked at. Before each move, list every check your opponent would have afterwards — especially queen and rook checks near your king — and make sure none of them works.',
        clause: 'you allowed a checkmate',
        label: 'Allowing mate',
      };
    if (here.length && !here.some((f) => f.facts.hanging === 'moved' || f.facts.hanging === 'left'))
      return {
        ...meta,
        focusTitle: "Before you commit, look at your opponent's checks, captures and attacks after your move.",
        focusDetail: "Material went in this game to replies that weren't simple captures of a loose piece. Before each move, picture the position after it and ask what your opponent's most forcing reply is: checks first, then captures, then attacks.",
        clause: "moves lost material to replies you didn't check",
        label: 'Checking the reply',
      };
  }
  if (theme === 'king_safety') {
    const ks = findings.filter((f) => f.category === 'king_safety' && countsAsPattern(f));
    if (ks.length && !ks.some((f) => f.facts.notCastled)) {
      return {
        ...meta,
        focusTitle: "Once you've castled, leave the pawns in front of your king alone — especially when your opponent's pawns are storming toward it.",
        focusDetail:
          "Pushing your own king's pawns opens lines for the attacker. Meet a pawn storm by bringing pieces over to defend and by hitting back in the center, and before every move ask what your opponent's next pawn push will open up.",
      };
    }
  }
  return meta;
}

/** One or two sentences on the shape of the game, from the per-move context. */
export function gameStory(plies: PlyRecord[], contexts: Map<number, PlyContext> | undefined): string | undefined {
  if (!contexts || contexts.size < 8) return undefined;
  const list = [...contexts.values()].sort((a, b) => a.ply - b.ply);
  const phases = summarizePhases(contexts);
  const mv = (ply: number) => plies[ply - 1]?.moveNumber ?? Math.ceil(ply / 2);
  const parts: string[] = [];
  const firstAhead = list.find((c, i) => c.ahead && list.slice(i, i + 4).every((x) => x.ahead));
  if (firstAhead && phases.aheadShare >= 0.3) {
    // The first stretch of being ahead, its peak, and how low the lead fell afterwards.
    const start = list.indexOf(firstAhead);
    let end = start;
    while (end + 1 < list.length && list[end + 1].ahead) end++;
    const stretch = list.slice(start, end + 1);
    const peak = stretch.reduce((a, c) => (c.material > a.material ? c : a), firstAhead);
    const low = list.slice(end + 1).reduce<PlyContext | undefined>((a, c) => (!a || c.material < a.material ? c : a), undefined);
    let s =
      mv(peak.ply) === mv(firstAhead.ply)
        ? `You were up ${materialPhrase(peak.material)} from move ${mv(firstAhead.ply)}`
        : `You were materially ahead from move ${mv(firstAhead.ply)} (up to ${materialPhrase(peak.material)} by move ${mv(peak.ply)})`;
    if (low && low.material <= 1) {
      s += `, but the lead shrank to ${low.material <= 0 ? 'nothing' : materialPhrase(low.material)} by move ${mv(low.ply)}`;
      const regained = list.slice(list.indexOf(low)).find((c) => c.ahead);
      if (regained) s += ` before you pulled ahead again`;
    }
    parts.push(s + '.');
  } else if (phases.behindShare >= 0.3) {
    const firstBehind = list.find((c) => c.behind)!;
    parts.push(`You were behind in material from move ${mv(firstBehind.ply)}, so this game was about finding resources.`);
  }
  // A see-saw game: the evaluation crossed from clearly better to clearly worse (or back) at least twice.
  const swings: { side: 'win' | 'lose'; ply: number }[] = [];
  for (const c of list) {
    const side = c.cp >= 200 ? 'win' : c.cp <= -200 ? 'lose' : undefined;
    if (side && side !== swings.at(-1)?.side) swings.push({ side, ply: c.ply });
  }
  if (swings.length >= 3) {
    const steps = swings.slice(0, 5).map((w, k) => `${w.side === 'win' ? 'winning' : 'worse'} ${k === 0 ? 'around' : 'by'} move ${mv(w.ply)}`);
    parts.unshift(`This game swung back and forth: you were ${joinList(steps)}.`);
  }
  const last = plies.at(-1);
  const userColor = list[0] ? plies[list[0].ply - 1]?.color : undefined;
  const mated = last?.san.endsWith('#') ? last : undefined;
  if (mated && mated.color === userColor) parts.push(`You finished it with checkmate: ${moveLabel(mated)}.`);
  if (phases.kingPressurePlies.length >= 3) parts.push(`Your king came under pressure around move ${mv(phases.kingPressurePlies[0])}.`);
  const raceCtx = phases.raceFrom ? list.find((c) => c.ply >= phases.raceFrom!) : undefined;
  if (phases.raceFrom && raceCtx && Math.abs(raceCtx.material) < 5) parts.push(`From move ${mv(phases.raceFrom)} it was a race between passed pawns.`);
  else if (!phases.raceFrom && phases.endgameFrom && phases.endgameFrom < plies.length - 6) parts.push(`The game reached an endgame around move ${mv(phases.endgameFrom)}.`);
  return parts.length ? parts.join(' ') : undefined;
}

export function buildReport(input: ReportInput): GameReport {
  const { plies, findings, userColor, prior, contexts } = input;
  const groups = groupByTheme(findings.filter(leadsSummary));
  const strongGroups = groups.filter((g) => g.strong);
  const didWell = didWellItems(findings, plies, userColor);
  // Main summary: themes with strong evidence first; a weaker (but credible) theme only fills remaining space.
  const shown = [...strongGroups, ...groups.filter((g) => !g.strong && !g.findings.every(isSoft))].slice(0, 3);
  const hurt: ReportItem[] = shown.map((g) => ({
    text: hurtText(g, plies, userColor),
    plies: g.findings.flatMap((f) => [f.ply, ...(f.relatedPlies ?? [])]),
    keyPlies: keyPliesOf(g, plies),
    category: g.findings[0].category,
  }));
  const minorNotes: ReportItem[] = findings
    .filter((f) => f.kind === 'weakness' && f.severity === 1 && isCredible(f) && SOFT_NOTES[f.category as CategoryId])
    .slice(0, 2)
    .map((f) => ({ text: SOFT_NOTES[f.category as CategoryId]!(f), plies: [f.ply], category: f.category }));

  // With no strong theme, a credible weaker one (the one we'll mention) still beats a generic default.
  // In a game you won, weak evidence isn't a lesson: the default advice is more honest than a guess.
  const chosen = chooseFocus(groups, prior) ?? (input.won ? undefined : groups.find((g) => !g.findings.every(isSoft))?.theme);
  // A loss with a decisive drop: the lesson comes from what explains that move (or its setup),
  // and the story tells it in order — setup, decisive mistake, result.
  const rc = input.evals && input.lost ? rootCause({ plies, evals: input.evals, userColor, findings, termination: input.termination, lost: true }) : undefined;
  // Only a specific explanation (a named tactic, a defended pawn, mate, a truly loose piece) takes
  // over the headline and the focus; otherwise the story is still told, under the usual headline.
  const specific = (f: Finding) => (!!f.facts.pattern && f.facts.patternSide !== 'better') || f.category === 'defended_grab' || !!f.facts.mate || f.facts.hanging === 'moved' || f.facts.hanging === 'left';
  const decisiveLesson = rc && specific(rc.decisive) ? lessonFor(rc.decisive, findings) : undefined;
  const focusTheme = decisiveLesson?.theme ?? chosen ?? 'opponent_threats';
  // The default advice stays default: no tactic from a weak finding dressed up as this game's lesson.
  const focusMeta = decisiveLesson ?? focusFor(focusTheme, chosen ? findings.filter(leadsSummary) : []);

  let headline: string;
  const openingStrengths = findings.filter((f) => f.kind === 'strength' && ['center_control', 'developed_pieces', 'castled_early'].includes(f.category));
  const openingWeak = findings.some((f) => countsAsPattern(f) && (f.category === 'development' || (f.category === 'king_safety' && f.facts.notCastled)));
  const solidOpening = openingStrengths.length >= 2 && !openingWeak;
  const lead = strongGroups[0];
  // Real mistakes that didn't add up to a strong theme still aren't a "clean game".
  const slips = findings.filter((f) => leadsSummary(f) && !isStateFinding(f));
  if (rc && decisiveLesson) {
    const centre = rc.setup.some((f) => f.category === 'king_safety' && f.facts.notCastled);
    const setup = rc.setup
      .filter((f) => SETUP_CATEGORIES.includes(f.category) && !(f.category === 'king_safety' && f.facts.notCastled))
      .map((f) => setupClause(f, userColor))
      .filter(Boolean);
    headline = `${capitalise(decisiveLesson.clause)}${setup.length ? `, after ${setup.join(' and ')}` : ''}${centre ? ', with your king still in the centre' : ''}. The key lesson from this game: ${lowerFirst(focusMeta.focusTitle)}`;
  } else if (!lead && slips.length) {
    headline = `${solidOpening ? 'Your opening fundamentals were mostly solid. ' : ''}No single habit stood out strongly enough to call it a pattern, but ${new Set(slips.map((f) => f.ply)).size === 1 ? 'one mistake is' : 'a few mistakes are'} worth reviewing. The key lesson from this game: ${lowerFirst(focusMeta.focusTitle)}`;
  } else if (!lead && input.lost) {
    headline = `No single mistake decided this game — it slipped away a little at a time. The key lesson from this game: ${lowerFirst(focusMeta.focusTitle)}`;
  } else if (!lead) {
    const start = input.won ? 'A strong win' : 'A clean game';
    headline = solidOpening
      ? `${start}: solid opening fundamentals and no serious mistakes for me to flag. Keep the same habits next game.`
      : input.won
        ? 'A strong win with no serious mistakes for me to flag. Keep the same habits next game.'
        : 'No serious mistakes for me to flag in this game. Keep the same habits next game.';
  } else if (lead.theme === 'conversion') {
    const wonMaterial = findings.some((f) => f.category === 'won_free_material');
    headline = `${wonMaterial ? 'You picked up free material early and built a winning position' : 'You built a winning position'}, but ${THEMES.conversion.clause}. The key lesson from this game: ${lowerFirst(focusMeta.focusTitle)}`;
  } else {
    const opener = solidOpening ? 'Your opening fundamentals were mostly solid, but ' : '';
    const mates = lead.findings.filter((f) => f.facts.mateIn).length;
    // When a specific tactic decided it, say that instead of the theme's generic clause.
    const patterned = lead.theme === focusTheme && focusMeta.clause !== THEMES[focusTheme].clause;
    const clause = lead.theme === 'tactics' && mates ? `you missed ${mates >= 2 ? 'checkmates' : 'a checkmate'} on the board` : patterned ? focusMeta.clause : THEMES[lead.theme].clause;
    headline = `${opener}${opener ? clause : capitalise(clause)}. The key lesson from this game: ${lowerFirst(focusMeta.focusTitle)}`;
  }

  return {
    headline,
    didWell,
    hurt,
    recurring: recurringText(groups, plies, prior),
    focus: {
      title: focusMeta.focusTitle,
      detail: [focusMeta.focusDetail, decisiveLesson && rc?.setup[0] ? setupLesson(rc.setup[0], plies) : ''].filter(Boolean).join(' '),
      theme: focusTheme,
      ...(chosen || decisiveLesson ? {} : { generic: true }),
    },
    minorNotes,
    story: (rc ? [rc.story, input.ending] : [input.ending, gameStory(plies, contexts)]).filter(Boolean).join(' ') || undefined,
    voice: 'template',
    version: REPORT_VERSION,
  };
}

/** The lesson of the move that decided a game: its named tactic or specific detector first. */
function lessonFor(f: Finding, findings: Finding[]): { focusTitle: string; focusDetail: string; clause: string; label: string; theme: ThemeId } | undefined {
  const theme = themeOf(f.category);
  if (f.facts.pattern && f.facts.patternSide !== 'better') {
    const tag = f.facts.pattern as PatternTag;
    return { focusTitle: PATTERN_FOCUS[tag].title, focusDetail: PATTERN_FOCUS[tag].detail, clause: `you ${PATTERN_PHRASE[tag].refutation}`, label: PATTERN_LABEL[tag], theme: theme ?? 'tactics' };
  }
  if (f.category === 'defended_grab') return { ...THEMES.counting, clause: `${THEMES.counting.clause} (${moveOf(f)})`, theme: 'counting' };
  if (!theme) return undefined;
  // Everything else: the theme's own focus, sharpened by what the board showed (mate, a truly loose piece…).
  return { ...focusFor(theme, findings.filter((x) => x.ply === f.ply)), theme };
}

const moveOf = (f: Finding) => (f.facts.move as string | undefined) ?? /^(\d+\.(?:\.\.)?\S+)/.exec(f.evidence)?.[1] ?? `move ${Math.ceil(f.ply / 2)}`;

const SETUP_CATEGORIES = ['king_pawns', 'pawn_storm', 'piece_to_rim', 'king_safety', 'pawn_structure'];

/** How a set-up move reads inside the headline ("after 12.f3 loosened the pawns in front of your king"). */
function setupClause(f: Finding, userColor: Color): string | undefined {
  const mv = moveOf(f);
  // The tactic the setup move walked into says more than its category (13.Nh3: a pawn fork, not just "the rim").
  if (f.facts.pattern && f.facts.patternSide !== 'better') return `${mv} ${PATTERN_PHRASE[f.facts.pattern as PatternTag].refutation}`;
  switch (f.category) {
    case 'king_pawns':
      return `${mv} loosened the pawns in front of your king`;
    case 'pawn_storm':
      return `${COLOR_NAME[other(userColor)]}'s pawns stormed your king's side`;
    case 'piece_to_rim':
      return `your ${String(f.facts.piece ?? 'piece')} was driven to the rim (${mv})`;
    case 'king_safety':
      return `${mv} weakened your king`;
    case 'pawn_structure':
      return `${mv} weakened your pawns`;
  }
  return undefined;
}

/** The set-up move's lesson for the focus detail: its tactic's rule when it walked into one, else its category's. */
function setupLesson(f: Finding, plies: PlyRecord[]): string {
  const tag = f.facts.pattern as PatternTag | undefined;
  const p = plies[f.ply - 1];
  const lesson = tag && f.facts.patternSide !== 'better' ? lowerFirst(patternLesson(tag, 'refutation', !!p && forkedOnRim(p, String(f.facts.patternEvidence ?? '')))) : SETUP_LESSON[f.category];
  return lesson ? `Also from this game: ${lesson}` : '';
}

/** A second, set-up lesson, added to the focus detail. */
const SETUP_LESSON: Partial<Record<string, string>> = {
  king_pawns: "leave the pawns in front of your castled king alone — moving them gives the opponent's pawns targets to chase.",
  pawn_storm: "when the opponent's pawns march at your king, hit back in the centre and keep your pieces off the squares they attack.",
  piece_to_rim: 'when a pawn chases a knight or bishop, bring it back toward the centre, not to the edge.',
  king_safety: 'keep the pawns in front of your castled king where they are unless you gain something concrete.',
};

function lowerFirst(s: string) {
  if (/^(White|Black)\b/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
