// Builds the concise post-game coaching report from findings + history.
import type { CategoryId, Color, Finding, GameReport, PlyRecord, ReportItem, StrengthId, ThemeId } from '../domain/types';
import { CATEGORIES, STRENGTHS, THEMES } from '../domain/categories';
import { COLOR_NAME, other } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import type { PriorGameFindings } from '../analysis/moments';

export interface ReportInput {
  plies: PlyRecord[];
  findings: Finding[];
  userColor: Color;
  prior: PriorGameFindings[];
}

interface ThemeGroup {
  theme: ThemeId;
  findings: Finding[];
  score: number;
}

const RECENT = 5;

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
    if (f.kind !== 'weakness' || f.severity < 2) continue;
    const t = themeOf(f.category);
    if (!t) continue;
    groups.set(t, [...(groups.get(t) ?? []), f]);
  }
  return [...groups.entries()]
    .map(([theme, fs]) => ({
      theme,
      findings: fs,
      score: fs.reduce((a, f) => a + CATEGORIES[f.category as CategoryId].weight * f.severity, 0),
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

function hurtText(group: ThemeGroup, plies: PlyRecord[], userColor: Color): string {
  const eps = episodes(group, plies);
  const opp = COLOR_NAME[other(userColor)];
  const labels = eps.map((e) => e.label);
  switch (group.theme) {
    case 'active_without_followup': {
      const n = eps.length;
      return `${n > 1 ? 'Several moves looked active' : 'A move looked active'} but had no follow-up: ${joinList(labels)}. ${n > 1 ? 'Each time' : 'There'}, ${opp}'s simplest reply left your piece with nothing to do, so you spent tempi without improving your position.`;
    }
    case 'tactics':
      return [...eps]
        .sort((a, b) => b.finding.severity - a.finding.severity)
        .map((e) => `On ${e.label}, ${lowerFirst(e.finding.evidence)}`)
        .join(' ');
    case 'loose_pieces':
    case 'opponent_threats':
      return eps.map((e) => e.finding.evidence).join(' ');
    default:
      return `${THEMES[group.theme].label}: ${eps.map((e) => lowerFirst(e.finding.evidence)).join(' ')}`;
  }
}

function didWellItems(findings: Finding[], plies: PlyRecord[], userColor: Color): ReportItem[] {
  const strengths = findings.filter((f) => f.kind === 'strength');
  const has = (id: StrengthId) => strengths.find((f) => f.category === id);
  const items: ReportItem[] = [];
  const opp = COLOR_NAME[other(userColor)];

  const opening = [has('center_control'), has('developed_pieces'), has('castled_early')].filter(Boolean) as Finding[];
  if (opening.length >= 2) {
    const parts: string[] = [];
    const c = has('center_control');
    if (c) parts.push(`claimed the center with ${joinList(c.facts.moves as string[])}`);
    if (has('developed_pieces')) parts.push('got all your minor pieces out by move 10');
    const k = has('castled_early');
    if (k) parts.push(`castled on move ${k.facts.move}`);
    items.push({ text: `Your opening fundamentals were solid: you ${joinList(parts)}.`, category: opening[0].category as StrengthId, plies: opening.map((f) => f.ply).filter((p) => p > 0) });
  } else if (opening.length === 1) {
    items.push({ text: STRENGTHS[opening[0].category as StrengthId].phrase, category: opening[0].category as StrengthId });
  }

  const brk = has('opened_vs_king');
  if (brk) {
    items.push({
      text: `${plyLabel(plies, brk.ply)} was a good idea: ${opp}'s king was still on ${brk.facts.oppKing}, and you started opening lines toward it.`,
      category: 'opened_vs_king',
      plies: [brk.ply],
    });
  }
  const pun = has('punished_mistake');
  if (pun) items.push({ text: `${pun.evidence} When your opponent slipped, you noticed.`, category: 'punished_mistake', plies: [pun.ply] });
  if (has('no_hanging')) items.push({ text: "You didn't leave any pieces hanging — that's the most important habit at this level.", category: 'no_hanging' });
  if (items.length < 2 && has('converted_advantage')) items.push({ text: STRENGTHS.converted_advantage.phrase, category: 'converted_advantage' });
  return items.slice(0, 3);
}

const SOFT_NOTES: Partial<Record<CategoryId, (f: Finding) => string>> = {
  central_tension: (f) =>
    `${f.evidence.replace(/\.$/, '')}. ${f.facts.engineFine ? "That's not a mistake, but it" : 'It'} let your opponent off the hook a little: keeping the tension leaves them the harder decision.`,
  premature_capture: (f) => `${f.evidence} Not a big deal, but worth noticing.`,
  time_management: (f) => f.evidence,
  early_queen: (f) => f.evidence,
};

function recurringText(groups: ThemeGroup[], plies: PlyRecord[], prior: PriorGameFindings[]): string {
  const recentPrior = [...prior].sort((a, b) => b.playedAt - a.playedAt).slice(0, RECENT - 1);
  if (groups.length === 0) {
    return recentPrior.length
      ? 'No recurring weakness showed up in this game. Keep doing what you did.'
      : "This is your first analyzed game, so there's no pattern to compare against yet.";
  }
  const top = groups[0];
  const themeLabel = THEMES[top.theme].label.toLowerCase();
  const eps = episodes(top, plies);
  const inThisGame = eps.length > 1 ? `In this game, ${joinList(eps.map((e) => e.label))} all fit that pattern.` : `In this game, ${eps[0].label} fits it.`;
  if (recentPrior.length === 0) {
    return `This is your first analyzed game, so nothing counts as a pattern yet. ${inThisGame} I'll watch whether this shows up again — one game isn't a trend.`;
  }
  const withTheme = recentPrior.filter((g) => g.findings.some((f) => f.kind === 'weakness' && f.severity >= 2 && themeOf(f.category) === top.theme));
  const total = recentPrior.length + 1;
  let text: string;
  if (withTheme.length === 0) {
    text = `${capitalise(themeLabel)} didn't show up in your previous ${recentPrior.length === 1 ? 'game' : `${recentPrior.length} games`}, so treat this as a possible tendency, not a pattern. ${inThisGame}`;
  } else if (withTheme.length === 1) {
    const ex = withTheme[0];
    text = `Possible tendency: something similar happened in your game ${ex.label}. ${inThisGame} That's 2 of your last ${total} games — worth watching.`;
  } else {
    text = `This has now appeared in ${withTheme.length + 1} of your last ${total} games: you again ${THEMES[top.theme].clause}. ${inThisGame} This is becoming more important than opening theory for you.`;
  }
  // Good news: something common before that didn't appear this time.
  const currentThemes = new Set(groups.map((g) => g.theme));
  const priorCounts = new Map<ThemeId, number>();
  for (const g of recentPrior) {
    const ts = new Set(g.findings.filter((f) => f.kind === 'weakness' && f.severity >= 2).map((f) => themeOf(f.category)).filter(Boolean) as ThemeId[]);
    ts.forEach((t) => priorCounts.set(t, (priorCounts.get(t) ?? 0) + 1));
  }
  const improved = [...priorCounts.entries()].filter(([t, n]) => n >= 2 && !currentThemes.has(t)).sort((a, b) => b[1] - a[1])[0];
  if (improved) {
    text += ` Good sign: ${THEMES[improved[0]].label.toLowerCase()} (seen in ${improved[1]} of your previous ${recentPrior.length} games) didn't show up this time.`;
  }
  return text;
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function chooseFocus(groups: ThemeGroup[], prior: PriorGameFindings[]): ThemeId | undefined {
  if (!groups.length) return undefined;
  const recentPrior = [...prior].sort((a, b) => b.playedAt - a.playedAt).slice(0, RECENT - 1);
  const scoreOf = (g: ThemeGroup) =>
    g.score + recentPrior.filter((p) => p.findings.some((f) => f.kind === 'weakness' && f.severity >= 2 && themeOf(f.category) === g.theme)).length;
  return [...groups].sort((a, b) => scoreOf(b) - scoreOf(a))[0].theme;
}

export function buildReport(input: ReportInput): GameReport {
  const { plies, findings, userColor, prior } = input;
  const groups = groupByTheme(findings);
  const didWell = didWellItems(findings, plies, userColor);
  const hurt: ReportItem[] = groups.slice(0, 3).map((g) => ({
    text: hurtText(g, plies, userColor),
    plies: g.findings.flatMap((f) => [f.ply, ...(f.relatedPlies ?? [])]),
    category: g.findings[0].category,
  }));
  const minorNotes: ReportItem[] = findings
    .filter((f) => f.kind === 'weakness' && f.severity === 1 && SOFT_NOTES[f.category as CategoryId])
    .slice(0, 2)
    .map((f) => ({ text: SOFT_NOTES[f.category as CategoryId]!(f), plies: [f.ply], category: f.category }));

  const focusTheme = chooseFocus(groups, prior) ?? 'opponent_threats';
  const focusMeta = THEMES[focusTheme];

  let headline: string;
  const openingStrengths = findings.filter((f) => f.kind === 'strength' && ['center_control', 'developed_pieces', 'castled_early'].includes(f.category));
  const openingWeak = findings.some((f) => f.kind === 'weakness' && f.severity >= 2 && (f.category === 'development' || (f.category === 'king_safety' && f.facts.notCastled)));
  const solidOpening = openingStrengths.length >= 2 && !openingWeak;
  if (groups.length === 0) {
    headline = solidOpening
      ? 'A clean game: solid opening fundamentals and no serious mistakes for me to flag. Keep the same habits next game.'
      : 'No serious mistakes for me to flag in this game. Keep the same habits next game.';
  } else {
    const opener = solidOpening ? 'Your opening fundamentals were mostly solid, but ' : '';
    const clause = THEMES[groups[0].theme].clause;
    headline = `${opener}${opener ? clause : capitalise(clause)}. The key lesson from this game: ${lowerFirst(focusMeta.focusTitle)}`;
  }

  return {
    headline,
    didWell,
    hurt,
    recurring: recurringText(groups, plies, prior),
    focus: { title: focusMeta.focusTitle, detail: focusMeta.focusDetail, theme: focusTheme },
    minorNotes,
    voice: 'template',
  };
}

function lowerFirst(s: string) {
  if (/^(White|Black)\b/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
