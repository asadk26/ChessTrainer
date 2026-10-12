// Builds the concise post-game coaching report from findings + history.
import type { CategoryId, Color, Finding, GameReport, PlyContext, PlyRecord, ReportItem, StrengthId, ThemeId } from '../domain/types';
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
  /** How the game ended, when it matters (won by resignation from a worse position, an early resignation). */
  ending?: string;
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
export const REPORT_VERSION = 10;

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

/** A finding that can count toward a pattern (in this game or as history). */
export const countsAsPattern = (f: Finding) => f.kind === 'weakness' && f.severity >= 2 && isCredible(f);

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
    const t = themeOf(f.category);
    if (!t) continue;
    groups.set(t, [...(groups.get(t) ?? []), f]);
  }
  return [...groups.entries()]
    .map(([theme, fs]) => ({
      theme,
      findings: fs,
      score: fs.reduce((a, f) => a + CATEGORIES[f.category as CategoryId].weight * f.severity * confWeight(f), 0),
      strong: fs.some((f) => f.confidence === 'high') || fs.length >= 2,
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
        const rest = eps.filter((e) => !mates.includes(e)).map((e) => `On ${e.label}, ${lowerFirst(e.finding.evidence)}`);
        const each = mates.map((e) => `move ${plies[e.finding.ply - 1].moveNumber} (${e.finding.facts.bestSan} instead of ${plies[e.finding.ply - 1].san})`);
        return [`You missed a checkmate ${mates.length === 2 ? 'twice' : `${mates.length} times`}: ${joinList(each)}. ${mates.every((e) => plies[e.finding.ply - 1].captured) ? 'Each time you took material instead — but mate ends the game, so checks come first.' : 'Checks come first: mate ends the game.'}`, ...rest].join(' ');
      }
      return [...eps]
        .sort((a, b) => b.finding.severity - a.finding.severity)
        .map((e) => `On ${e.label}, ${lowerFirst(e.finding.evidence)}`)
        .join(' ');
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

function didWellItems(findings: Finding[], plies: PlyRecord[], userColor: Color): ReportItem[] {
  const strengths = findings.filter((f) => f.kind === 'strength' && isCredible(f));
  const has = (id: StrengthId) => strengths.find((f) => f.category === id);
  const items: ReportItem[] = [];
  const opp = COLOR_NAME[other(userColor)];
  const plyList = (f: Finding) => [f.ply, ...(f.relatedPlies ?? [])].filter((p) => p > 0);
  const push = (f: Finding | undefined, text: (f: Finding) => string) => {
    if (f) items.push({ text: text(f), category: f.category as StrengthId, plies: plyList(f) });
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

  push(has('found_tactic'), (f) => f.evidence);
  push(has('won_free_material'), (f) => `${f.evidence} When your opponent left something hanging, you noticed.`);
  push(has('passed_pawn'), (f) => `${f.evidence} In the endgame that pawn was worth more than any piece.`);
  push(has('neutralized_counterplay'), (f) => `${f.evidence} Trading off the attackers was exactly right.`);
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
};

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
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  const groups = groupByTheme(findings);
  const strongGroups = groups.filter((g) => g.strong);
  const didWell = didWellItems(findings, plies, userColor);
  // Main summary: themes with strong evidence first; a weaker (but credible) theme only fills remaining space.
  const shown = [...strongGroups, ...groups.filter((g) => !g.strong)].slice(0, 3);
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
  const focusTheme = chooseFocus(groups, prior) ?? groups[0]?.theme ?? 'opponent_threats';
  const focusMeta = focusFor(focusTheme, findings);

  let headline: string;
  const openingStrengths = findings.filter((f) => f.kind === 'strength' && ['center_control', 'developed_pieces', 'castled_early'].includes(f.category));
  const openingWeak = findings.some((f) => countsAsPattern(f) && (f.category === 'development' || (f.category === 'king_safety' && f.facts.notCastled)));
  const solidOpening = openingStrengths.length >= 2 && !openingWeak;
  const lead = strongGroups[0];
  if (!lead) {
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
    const clause = lead.theme === 'tactics' && mates ? `you missed ${mates >= 2 ? 'checkmates' : 'a checkmate'} on the board` : THEMES[lead.theme].clause;
    headline = `${opener}${opener ? clause : capitalise(clause)}. The key lesson from this game: ${lowerFirst(focusMeta.focusTitle)}`;
  }

  return {
    headline,
    didWell,
    hurt,
    recurring: recurringText(groups, plies, prior),
    focus: { title: focusMeta.focusTitle, detail: focusMeta.focusDetail, theme: focusTheme },
    minorNotes,
    story: [input.ending, gameStory(plies, contexts)].filter(Boolean).join(' ') || undefined,
    voice: 'template',
    version: REPORT_VERSION,
  };
}

function lowerFirst(s: string) {
  if (/^(White|Black)\b/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
