// Playtest tooling: a compact, copyable decision log per coach game, and aggregate stats across
// sessions (how often each lesson actually emerges, how the coach played at each strength).
import { Chess } from 'chess.js';
import type { AdaptiveSession, AdaptiveSkill, CoachMoveLog } from '../domain/types';
import { formatCp } from '../analysis/evaluation';
import { SKILL_LABEL, SKILLS, lowEmergence } from './skills';
import { COACH_TUNING } from './selectMove';

const REASON: Record<CoachMoveLog['reason'], string> = {
  best: 'Stockfish’s best',
  only: 'only sound move',
  near_best: 'equally good alternative',
  lesson: 'chosen for the lesson',
  natural: 'more natural-looking',
  eased: 'easing off (ahead)',
  variety: 'slightly weaker, within band',
};
export const reasonText = (r: CoachMoveLog['reason']) => REASON[r] ?? r;

/** "14...Nd7" for each ply of a session, from its start position. */
export function moveLabels(s: AdaptiveSession): string[] {
  const c = new Chess(s.plan.start.fen);
  const out: string[] = [];
  for (const uci of s.moves) {
    const n = c.moveNumber();
    const white = c.turn() === 'w';
    try {
      const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
      out.push(`${n}${white ? '.' : '...'}${m.san}`);
    } catch {
      out.push(uci);
    }
  }
  return out;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

/** One coach move, as one line of the decision log. */
export function coachMoveLine(l: CoachMoveLog, label: string): string {
  const head = `${label.padEnd(10)} best ${l.bestSan ?? l.bestUci}${l.bestCp !== undefined ? ` (${formatCp(l.bestCp)})` : ''} · ${reasonText(l.reason)}${l.gap ? ` · −${l.gap.toFixed(1)}%` : ''}${l.eased ? ' · eased' : ''}${l.ms !== undefined ? ` · ${l.ms}ms` : ''}`;
  if (!l.cands?.length) return head;
  const cands = l.cands
    .map((c) => `${c.san} ${formatCp(c.cp)}${c.out ? ` ✗${c.out}` : ` L${c.lesson} N${c.natural} =${c.score}`}`)
    .join(' | ');
  return `${head}\n${' '.repeat(12)}${cands}`;
}

export function sessionLog(s: AdaptiveSession): string {
  const labels = moveLabels(s);
  const r = s.result;
  const fb = s.feedback;
  const date = new Date(s.finishedAt ?? s.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    `=== Coach game ${s.id} · ${date} · ${SKILL_LABEL[s.plan.skill]} (${s.plan.basis}) · ${s.strength ?? 'band'} ${s.band} · tuning ${s.tuning ?? 'p1'}`,
    `You: ${s.plan.userColor === 'w' ? 'White' : 'Black'} · start: ${s.plan.start.kind === 'historical' || s.plan.start.gameId ? `historical (${s.plan.start.label ?? s.plan.start.gameId}; prior exposures ${s.plan.start.exposure?.prior ?? '?'})` : 'standard'} · ending: ${s.ending ?? s.status}${s.outcome ? ` (${s.outcome})` : ''}`,
    `Moves: ${labels.map((l, i) => (i > 0 && l.includes('...') && !labels[i - 1].includes('...') ? l.replace(/^\d+\.\.\./, '') : l)).join(' ')}`,
  ];
  if (r) {
    lines.push(`Verdict: ${r.valid ? r.verdict : 'not meaningfully tested'} · test moments ${r.testMoments ?? '?'} · ${r.explanation}`);
    for (const e of r.evidence ?? []) lines.push(`  · ${e}`);
    for (const m of r.moments) lines.push(`  ${m.tone === 'good' ? '+' : m.tone === 'bad' ? '−' : '•'} ${m.label}: ${m.text}`);
  }
  if (fb) lines.push(`Feedback: natural=${fb.natural ?? '-'} lesson=${fb.lesson ?? '-'} verdict=${fb.verdict ?? '-'}${fb.weirdMoves ? ` · weird: ${fb.weirdMoves}` : ''}${fb.notes ? ` · notes: ${fb.notes}` : ''}`);
  lines.push('Coach moves (best · why · gap from best; candidates: eval, L=lesson, N=natural, =score, ✗=not allowed):');
  for (const l of s.coachLog) lines.push(coachMoveLine(l, labels[l.ply - 1] ?? `ply ${l.ply}`));
  return lines.join('\n');
}

export interface SkillPlaytestStats {
  skill: AdaptiveSkill;
  label: string;
  finished: number;
  valid: number;
  notTested: number;
  verdicts: Record<string, number>;
  avgTestMoments: number;
  /** Most recent finished sessions mostly produced no valid test. */
  lowEmergence: boolean;
}

export interface StrengthPlaytestStats {
  strength: string;
  games: number;
  results: Record<string, number>;
  coachMoves: number;
  reasons: Record<string, number>;
  avgNonBestGap: number;
  natural: Record<string, number>;
}

export function playtestStats(sessions: AdaptiveSession[]): { skills: SkillPlaytestStats[]; strengths: StrengthPlaytestStats[] } {
  const done = sessions.filter((s) => s.status === 'done' && s.result);
  const skills = SKILLS.map((skill) => {
    const mine = done.filter((s) => s.plan.skill === skill);
    const verdicts: Record<string, number> = {};
    for (const s of mine) verdicts[s.result!.verdict] = (verdicts[s.result!.verdict] ?? 0) + 1;
    const valid = mine.filter((s) => s.result!.valid);
    return {
      skill,
      label: SKILL_LABEL[skill],
      finished: mine.length,
      valid: valid.length,
      notTested: mine.length - valid.length,
      verdicts,
      avgTestMoments: mine.length ? Math.round((mine.reduce((a, s) => a + (s.result!.testMoments ?? 0), 0) / mine.length) * 10) / 10 : 0,
      lowEmergence: lowEmergence(sessions, skill),
    };
  });
  const byStrength = new Map<string, AdaptiveSession[]>();
  for (const s of sessions.filter((x) => x.status === 'done' || x.status === 'analysing')) {
    const k = s.strength ?? `band ${s.band}`;
    byStrength.set(k, [...(byStrength.get(k) ?? []), s]);
  }
  const strengths = [...byStrength.entries()].map(([strength, list]) => {
    const results: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    const natural: Record<string, number> = {};
    let gaps = 0;
    let nonBest = 0;
    let coachMoves = 0;
    for (const s of list) {
      results[s.outcome ?? 'unknown'] = (results[s.outcome ?? 'unknown'] ?? 0) + 1;
      if (s.feedback?.natural) natural[s.feedback.natural] = (natural[s.feedback.natural] ?? 0) + 1;
      for (const l of s.coachLog) {
        coachMoves++;
        reasons[l.reason] = (reasons[l.reason] ?? 0) + 1;
        if (l.reason !== 'best' && l.reason !== 'only') {
          nonBest++;
          gaps += l.gap;
        }
      }
    }
    return { strength, games: list.length, results, coachMoves, reasons, avgNonBestGap: nonBest ? Math.round((gaps / nonBest) * 10) / 10 : 0, natural };
  });
  return { skills, strengths };
}

export function statsText(sessions: AdaptiveSession[]): string {
  const { skills, strengths } = playtestStats(sessions);
  const lines = [`=== Playtest summary · ${sessions.filter((s) => s.status === 'done').length} finished coach games · tuning ${COACH_TUNING.version}`];
  for (const s of skills)
    if (s.finished)
      lines.push(
        `${s.label}: ${s.finished} games, valid test in ${s.valid} (${pct(s.valid, s.finished)}), avg test moments ${s.avgTestMoments}, verdicts ${JSON.stringify(s.verdicts)}${s.lowEmergence ? ' — LOW EMERGENCE' : ''}`,
      );
  for (const s of strengths)
    lines.push(
      `${s.strength}: ${s.games} games, your results ${JSON.stringify(s.results)}, coach moves ${s.coachMoves} (${Object.entries(s.reasons).map(([k, v]) => `${k} ${pct(v, s.coachMoves)}`).join(', ')}), avg gap of non-best ${s.avgNonBestGap}%, felt natural ${JSON.stringify(s.natural)}`,
    );
  return lines.join('\n');
}

/** Everything a tuning round needs: the summary plus each game's decision log. */
export function exportPlaytest(sessions: AdaptiveSession[]): string {
  const finished = sessions.filter((s) => s.status === 'done').sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  return [statsText(sessions), ...finished.map(sessionLog)].join('\n\n') + '\n';
}
