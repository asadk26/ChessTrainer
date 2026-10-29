// npm run truth — score the app's analysis against the hand-verified ground truth (tests/truth).
// Runs the app's own coaching (detectors, patterns, moments, report) on the cached engine output,
// labels each ground-truth move the way the app explains it, and scores it per README-ground-truth.md:
// 1 for the primary label, 0.5 for a secondary one, 0 otherwise, and a hard fail for a must_not label.
//   --verbose            every moment, with the app's evidence and lesson
//   --holdout-details    also list holdout moments one by one (by default only their score is shown,
//                        so detectors are tuned on the tune split alone)
import type { Finding, StoredGame } from '../../src/domain/types.ts';
import { coachFromPositions } from '../../src/analysis/pipeline.ts';
import { primaryFinding } from '../../src/analysis/moments.ts';
import { isStateFinding } from '../../src/coach/report.ts';
import { THEMES } from '../../src/domain/categories.ts';
import { cachedPositions, loadTruth, storedGame, type TruthGame, type TruthMoment } from './data.ts';

const verbose = process.argv.includes('--verbose');
const holdoutDetails = process.argv.includes('--holdout-details');
const truth = loadTruth();

// ------------------------------------------------------------ the app's label for a move

/** The app's explanation of a finding, in the ground truth's words. `unclassified`: it names no mechanism. */
function appLabel(f: Finding): string {
  const pattern = f.facts.pattern as string | undefined;
  const better = f.facts.patternSide === 'better';
  if (f.facts.mate) return pattern === 'back_rank' ? 'back_rank_mate_allowed' : 'mate_allowed';
  if (f.facts.mateIn) return 'mate_missed';
  if (pattern) {
    const map: Record<string, [string, string]> = {
      knight_fork: ['fork_allowed', 'fork_missed'],
      fork: ['fork_allowed', 'fork_missed'],
      pawn_fork: ['pawn_fork_allowed', 'pawn_fork_missed'],
      bigger_capture: ['missed_bigger_capture', 'missed_bigger_capture'],
      skewer: ['skewer_allowed', 'skewer_missed'],
      greedy_queen: ['greedy_queen_raid', 'greedy_queen_raid_missed'],
      stuck_deep: ['trapped_piece_risk', 'trap_missed'],
      blocked_with_tempo: ['check_blocked_with_tempo', 'block_with_tempo_missed'],
      incomplete_exchange: ['incomplete_exchange', 'incomplete_exchange'],
      discovered_attack: ['discovered_attack_allowed', 'discovered_attack_missed'],
      in_between_move: ['in_between_move', 'in_between_move_missed'],
      pin: ['pin_allowed', 'pin_exploit_missed'],
      trapped_piece: ['trapped_piece', 'trap_missed'],
      opened_line: ['opened_line_to_own_king', 'opened_line_missed'],
      back_rank: ['back_rank_mate_allowed', 'mate_missed'],
      hanging_piece: ['hanging_piece', 'free_capture_missed'],
      removed_defender: ['removed_defender', 'removed_defender_missed'],
      unblocked_queen: ['opened_line_to_own_queen', 'opened_line_to_queen_missed'],
    };
    if (map[pattern]) return map[pattern][better ? 1 : 0];
  }
  // A category with its own mechanism (a defended pawn grab…) is what the app teaches, even when the
  // piece also ended up "hanging" in the material sense.
  const byCategory: Record<string, string> = {
    defended_grab: 'defended_target_grab',
    piece_to_rim: 'piece_to_rim',
    king_pawns: 'kingside_weakening',
    pawn_storm: 'pawn_storm',
    stranded_piece: 'trapped_piece',
    development: 'development',
    king_safety: 'king_safety',
    // "Moved an already-developed piece again" (v4 clean game: must not be taught on rushikeshdantakale).
    inefficient_moves: 'moved_piece_twice',
    premature_attack: 'moved_piece_twice',
  };
  if (byCategory[f.category]) return byCategory[f.category];
  // "Your X was already under attack, and your move didn't deal with it" (v2, sir-Deniy 17...Qb6+).
  if (f.category === 'missed_threat' && f.facts.threatFrom !== undefined) return 'threat_ignored';
  // "It could just be taken" is what these say when the board shows the piece simply lost; other
  // categories (counterplay against your king…) keep their own text whatever was captured.
  if (f.facts.hanging && ['blunder', 'missed_threat', 'gave_back_material'].includes(f.category)) return 'hanging_piece';
  return 'unclassified';
}

interface Labelled {
  label: string;
  finding?: Finding;
  lesson?: string;
  /** The ply became one of the game's teaching moments. */
  moment: boolean;
}

function labelAt(game: StoredGame, ply: number): Labelled {
  const fs = game.findings.filter((f) => f.ply === ply && f.kind === 'weakness' && !isStateFinding(f));
  const moment = game.moments.find((m) => m.ply === ply && m.kind === 'mistake');
  const f = primaryFinding(fs) ?? [...fs].sort((a, b) => b.severity - a.severity)[0];
  if (!f) return { label: 'not_flagged', moment: !!moment };
  return { label: appLabel(f), finding: f, lesson: moment?.text.lesson, moment: !!moment };
}

// ------------------------------------------------------------ run

const coached = new Map<string, StoredGame>();
const missing: string[] = [];
for (const g of truth.games) {
  const positions = cachedPositions(g.game);
  if (!positions) {
    missing.push(g.game);
    continue;
  }
  coached.set(g.game, coachFromPositions(storedGame(g), positions, []).game);
}
if (missing.length) {
  console.error(`No cached engine output for ${missing.length} game(s) — run \`npm run truth:engine\` first:\n  ${missing.join('\n  ')}`);
  process.exit(2);
}

interface Scored {
  m: TruthMoment;
  got: Labelled;
  score: number;
  hardFail: boolean;
  problem?: string;
}

const results: Scored[] = truth.moments.map((m) => {
  const game = coached.get(m.game)!;
  const p = game.plies[m.ply - 1];
  // The ground truth is keyed by ply; make sure it is the same move.
  const sameFen = p && p.fenBefore.split(' ').slice(0, 4).join(' ') === m.fen_before.split(' ').slice(0, 4).join(' ');
  if (!p || p.san !== m.played || !sameFen) return { m, got: { label: 'not_flagged', moment: false }, score: 0, hardFail: false, problem: `ply ${m.ply} is ${p?.san ?? 'missing'}, not ${m.played}${sameFen ? '' : ' (FEN differs)'}` };
  const got = labelAt(game, m.ply);
  const score = got.label === m.primary_label ? 1 : m.secondary_labels.includes(got.label) ? 0.5 : 0;
  return { m, got, score, hardFail: m.must_not_label.includes(got.label) };
});

// ------------------------------------------------------------ report

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : '—');
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

function splitSummary(split: 'tune' | 'holdout') {
  const rs = results.filter((r) => r.m.split === split);
  const pts = rs.reduce((s, r) => s + r.score, 0);
  const exact = rs.filter((r) => r.score === 1).length;
  const half = rs.filter((r) => r.score === 0.5).length;
  const fails = rs.filter((r) => r.hardFail).length;
  const unflagged = rs.filter((r) => r.got.label === 'not_flagged').length;
  const unclassified = rs.filter((r) => r.got.label === 'unclassified').length;
  const wrong = rs.length - exact - half - unflagged - unclassified;
  console.log(
    `${pad(split, 8)} ${pts.toFixed(1)}/${rs.length} = ${pct(pts, rs.length)}   exact ${exact} · secondary ${half} · wrong label ${wrong} · unclassified ${unclassified} · not flagged ${unflagged} · HARD FAILS ${fails}`,
  );
}

console.log(`\nGround truth v${truth.version} — the app vs hand-verified labels\n`);
splitSummary('tune');
splitSummary('holdout');

// Holdout per-label totals (labels with 3+ holdout moments only — no per-moment detail).
{
  const hold = results.filter((r) => r.m.split === 'holdout');
  const byLabel = new Map<string, Scored[]>();
  for (const r of hold) byLabel.set(r.m.primary_label, [...(byLabel.get(r.m.primary_label) ?? []), r]);
  const rows = [...byLabel.entries()].filter(([, rs]) => rs.length >= 3).sort((a, b) => b[1].length - a[1].length);
  console.log(`\nholdout by label (3+ moments)\n${pad('label', 28)} ${pad('n', 4)}${pad('exact', 7)}${pad('half', 6)}score`);
  for (const [l, rs] of rows) {
    const pts = rs.reduce((a, r) => a + r.score, 0);
    console.log(`${pad(l, 28)} ${pad(String(rs.length), 4)}${pad(String(rs.filter((r) => r.score === 1).length), 7)}${pad(String(rs.filter((r) => r.score === 0.5).length), 6)}${pts.toFixed(1)}/${rs.length} = ${pct(pts, rs.length)}`);
  }
  const bad = hold.filter((r) => r.problem).length;
  if (bad) console.log(`!! ${bad} holdout moment(s) don't match their game at the given ply (check the truth file)`);
}

// hanging_piece precision per split: the label the app falls back on, so it should rise as specific detectors take over.
for (const split of ['tune', 'holdout'] as const) {
  const rs = results.filter((r) => r.m.split === split);
  const app = rs.filter((r) => r.got.label === 'hanging_piece').length;
  const hit = rs.filter((r) => r.got.label === 'hanging_piece' && r.m.primary_label === 'hanging_piece').length;
  console.log(`hanging_piece precision (${split}): ${hit}/${app} = ${pct(hit, app)}`);
}

// Per-label precision / recall on the primary label (tune only unless --holdout-details).
const shown = holdoutDetails ? results : results.filter((r) => r.m.split === 'tune');
const labels = new Set<string>([...shown.map((r) => r.m.primary_label), ...shown.map((r) => r.got.label)]);
labels.delete('not_flagged');
labels.delete('unclassified');
console.log(`\n${holdoutDetails ? 'all moments' : 'tune moments'}\n${pad('label', 28)} ${pad('truth', 6)}${pad('app', 5)}${pad('hit', 5)}${pad('precision', 11)}recall`);
for (const l of [...labels].sort()) {
  const truthN = shown.filter((r) => r.m.primary_label === l).length;
  const appN = shown.filter((r) => r.got.label === l).length;
  const hit = shown.filter((r) => r.m.primary_label === l && r.got.label === l).length;
  console.log(`${pad(l, 28)} ${pad(String(truthN), 6)}${pad(String(appN), 5)}${pad(String(hit), 5)}${pad(pct(hit, appN), 11)}${pct(hit, truthN)}`);
}

console.log('\nEvery moment (✓ exact · ½ secondary · ✗ wrong · ? unclassified · – not flagged · ‼ hard fail):');
for (const split of holdoutDetails ? (['tune', 'holdout'] as const) : (['tune'] as const)) {
  console.log(`  ${split}`);
  for (const r of results.filter((x) => x.m.split === split)) {
    const mark = r.hardFail ? '‼' : r.score === 1 ? '✓' : r.score === 0.5 ? '½' : r.got.label === 'unclassified' ? '?' : r.got.label === 'not_flagged' ? '–' : '✗';
    const cat = r.got.finding ? ` [${r.got.finding.category}${r.got.moment ? ', moment' : ''}]` : '';
    console.log(`  ${mark} ${pad(r.m.id, 34)} want ${pad(r.m.primary_label, 26)} got ${r.got.label}${cat}${r.problem ? `  !! ${r.problem}` : ''}`);
    if (verbose) {
      if (r.got.finding) console.log(`      app:    ${r.got.finding.evidence}`);
      if (r.got.lesson) console.log(`      lesson: ${r.got.lesson}`);
      console.log(`      truth:  ${r.m.mechanism}`);
    }
  }
}

// Clean games: no invented "hanging pieces" / "develop faster" lesson.
console.log('\nClean games (must not teach these):');
let cleanFails = 0;
for (const c of truth.clean_games) {
  const g = coached.get(c.game)!;
  const taught = new Set<string>();
  // Every finding behind a teaching moment, not only its primary one: each shapes what the moment says.
  for (const m of g.moments.filter((x) => x.kind === 'mistake')) {
    taught.add(labelAt(g, m.ply).label);
    for (const f of g.findings.filter((x) => x.ply === m.ply && x.kind === 'weakness')) taught.add(appLabel(f));
  }
  for (const f of g.findings.filter((x) => x.kind === 'weakness' && x.confidence !== 'low')) {
    if (g.report?.hurt.some((h) => h.plies?.includes(f.ply) && (!h.category || h.category === f.category))) taught.add(appLabel(f));
  }
  if (g.report?.focus.theme === 'opening_development') taught.add('development');
  if (g.report?.focus.theme === 'loose_pieces') taught.add('hanging_piece');
  const bad: string[] = c.must_not_lesson.filter((l) => taught.has(l));
  // A clean game has nothing to fix: its focus must be the default advice, not a mistake's lesson.
  if (g.report && (!g.report.focus.generic || g.report.focus.title !== THEMES.opponent_threats.focusTitle)) bad.push('a mistake lesson as the focus');
  cleanFails += bad.length ? 1 : 0;
  console.log(`  ${bad.length ? '‼' : '✓'} ${pad(c.game, 38)} ${bad.length ? `teaches ${bad.join(', ')}` : 'ok'}   (focus: ${g.report?.focus.title})`);
}

// Expected summaries: the story's root cause.
console.log('\nExpected summaries:');
for (const g of truth.games.filter((x): x is TruthGame & { expected_summary: NonNullable<TruthGame['expected_summary']> } => !!x.expected_summary)) {
  const r = coached.get(g.game)!.report!;
  console.log(`  ${g.game}`);
  console.log(`    want:     ${g.expected_summary.story.join(' → ')}`);
  console.log(`    story:    ${r.story ?? '(none)'}`);
  console.log(`    headline: ${r.headline}`);
}

const hardFails = results.filter((r) => r.hardFail).length + cleanFails;
console.log(`\n${hardFails ? `${hardFails} hard fail(s)` : 'No hard fails'}.`);
process.exit(hardFails ? 1 : 0);
