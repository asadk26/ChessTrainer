import { useMemo, useState } from 'react';
import { aggregateProfile, describeFrequency } from '../../profile/profile';
import { gamePlayedAt, isRealGame } from '../../analysis/pipeline';
import { gameStats, trend } from '../../analysis/engineReview';
import { byColor, byOpening, byTimeOfDay, resultsBy, startedAt, TIME_OF_DAY, type ResultRow } from '../../analysis/results';
import { patternStats, type PatternStat } from '../../analysis/patternStats';
import { PATTERN_RULE, PATTERN_RULE_MISSED } from '../../analysis/patterns';
import { navigate, useApp } from '../store';
import { ScreenHeader } from '../components/AppShell';

const TREND: Record<string, string> = { improving: '↘ improving', worsening: '↗ more often', stable: '→ stable', new: 'new', insufficient: '' };

export function ProgressScreen() {
  const { games } = useApp();
  const real = useMemo(() => games.filter(isRealGame), [games]);
  const analyzed = useMemo(() => real.filter((g) => g.status === 'analyzed'), [real]);

  if (!real.length)
    return (
      <div className="narrow progress-screen">
        <ScreenHeader title="Progress" />
        <section className="card">
          <p className="muted">Sync or import some games and your results, strengths, recurring weaknesses and trends show up here.</p>
        </section>
      </div>
    );

  return (
    <div className="narrow progress-screen">
      <ScreenHeader title="Progress" />
      <ResultsCard />
      <AccuracyCard />
      {analyzed.length > 0 ? (
        <>
          <ProfileCards />
          <TacticsCard />
        </>
      ) : (
        <section className="card">
          <p className="muted">Analyze some games (Games tab) to see your strengths, recurring weaknesses and the tactics that cost you.</p>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------ results

function ResultsCard() {
  const { games } = useApp();
  const overall = useMemo(() => resultsBy(games, () => ({ key: 'all', label: 'All games' }))[0], [games]);
  const colors = useMemo(() => resultsBy(games, byColor), [games]);
  const openings = useMemo(() => resultsBy(games, byOpening), [games]);
  const times = useMemo(() => {
    const rows = resultsBy(games, byTimeOfDay());
    return TIME_OF_DAY.flatMap((t) => rows.filter((r) => r.key === t.key));
  }, [games]);
  const untimed = useMemo(() => games.filter((g) => isRealGame(g) && !startedAt(g)).length, [games]);
  const [allOpenings, setAllOpenings] = useState(false);
  if (!overall) return null;
  const shownOpenings = allOpenings ? openings : openings.filter((r) => r.n >= 2).slice(0, 6);
  const hidden = openings.length - shownOpenings.length;

  return (
    <section className="card results-card">
      <h3>Results</h3>
      <div className="record">
        <span className="record-main">
          <b className="w">{overall.w}W</b> <b className="d">{overall.d}D</b> <b className="l">{overall.l}L</b>
        </span>
        <span className="muted small">
          {overall.score}% score · {overall.n} game{overall.n === 1 ? '' : 's'}
        </span>
      </div>
      <ResultBar r={overall} />

      <h4>By colour</h4>
      <ResultTable rows={colors} />

      <h4>By opening</h4>
      {shownOpenings.length ? <ResultTable rows={shownOpenings} /> : <p className="muted small">No opening played twice yet.</p>}
      {hidden > 0 && (
        <button className="link small" onClick={() => setAllOpenings(!allOpenings)}>
          {allOpenings ? 'Show fewer' : `Show all ${openings.length} openings`}
        </button>
      )}

      <h4>By time of day</h4>
      {times.length ? <ResultTable rows={times} /> : <p className="muted small">Your PGNs don't say what time the games were played (Chess.com games synced here do).</p>}
      {times.length > 0 && untimed > 0 && (
        <p className="muted small">
          {untimed} game{untimed === 1 ? '' : 's'} without a start time {untimed === 1 ? "isn't" : "aren't"} counted here.
        </p>
      )}
    </section>
  );
}

function ResultTable({ rows }: { rows: ResultRow[] }) {
  return (
    <ul className="result-table">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="rt-head">
            <span className="rt-label">{r.label}</span>
            <span className="muted small">
              {r.w}–{r.d}–{r.l} · <b className={r.score >= 55 ? 'good-h' : r.score <= 45 ? 'bad-h' : ''}>{r.score}%</b>
            </span>
          </div>
          <ResultBar r={r} />
        </li>
      ))}
    </ul>
  );
}

function ResultBar({ r }: { r: ResultRow }) {
  const pct = (x: number) => `${(x / Math.max(1, r.n)) * 100}%`;
  return (
    <div className="result-bar" role="img" aria-label={`${r.w} wins, ${r.d} draws, ${r.l} losses`}>
      <span className="w" style={{ width: pct(r.w) }} />
      <span className="d" style={{ width: pct(r.d) }} />
      <span className="l" style={{ width: pct(r.l) }} />
    </div>
  );
}

// ------------------------------------------------------------ accuracy

function AccuracyCard() {
  const { games } = useApp();
  const analyzed = useMemo(() => games.filter((g) => g.status === 'analyzed' && isRealGame(g)), [games]);
  const accTrend = useMemo(
    () =>
      trend(
        analyzed.flatMap((g) => {
          const s = gameStats(g);
          return s ? [{ at: gamePlayedAt(g), s }] : [];
        }),
      ),
    [analyzed],
  );
  if (!analyzed.length) return null;
  return (
    <section className="card trend-card">
      <h3>Accuracy</h3>
      {accTrend ? (
        <p>
          <b>{accTrend.recent}</b> over your last {accTrend.n} games vs {accTrend.earlier} over the {accTrend.n} before
          {accTrend.recent - accTrend.earlier >= 3 ? ' — improving.' : accTrend.earlier - accTrend.recent >= 3 ? ' — a dip; check the recurring weaknesses below.' : ' — about the same.'}{' '}
          Blunders per game: <b>{accTrend.recentBlunders}</b> vs {accTrend.earlierBlunders}.
        </p>
      ) : (
        <p className="muted">Once you have 6 analyzed games, I'll compare your recent games with earlier ones ({analyzed.length}/6 so far).</p>
      )}
      <p className="muted small">Accuracy is a rough measure — short or one-sided games swing it a lot. It's not a rating estimate.</p>
    </section>
  );
}

// ------------------------------------------------------------ strengths and weaknesses

function ProfileCards() {
  const { games } = useApp();
  const profile = useMemo(
    () =>
      aggregateProfile(
        games
          .filter((g) => g.status === 'analyzed' && isRealGame(g))
          .map((g) => ({ gameId: g.id, playedAt: gamePlayedAt(g), findings: g.findings, sanByPly: Object.fromEntries(g.plies.map((p) => [p.ply, p.san])) })),
      ),
    [games],
  );
  return (
    <div className="grid-2">
      <section className="card">
        <h3>Strengths</h3>
        {profile.strengths.length === 0 && profile.improving.length === 0 && <p className="muted">Nothing yet.</p>}
        <ul className="plain">
          {profile.strengths.slice(0, 4).map((s) => (
            <li key={s.id}>
              <span className="ok-dot" /> {s.label} <span className="muted small">· {s.recentGames} of last {s.recentWindow}</span>
            </li>
          ))}
          {profile.improving.slice(0, 2).map((c) => (
            <li key={c.category}>
              <span className="ok-dot" /> Fewer {c.label.toLowerCase()} <span className="muted small">· improving</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h3>Recurring weaknesses</h3>
        {profile.categories.length === 0 && <p className="muted">No weaknesses flagged yet.</p>}
        <ul className="plain weak-list">
          {profile.categories.slice(0, 6).map((c) => (
            <li key={c.category}>
              <div className="weak-row">
                <span>{c.label}</span>
                <span className="count">{c.occurrences}</span>
              </div>
              <div className="muted small">
                {describeFrequency(c)}
                {TREND[c.trend] ? ` · ${TREND[c.trend]}` : ''}
                {c.lastOccurrence?.san ? ` · last: ${c.lastOccurrence.san}` : ''}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ------------------------------------------------------------ tactics (pattern tags)

function TacticsCard() {
  const { games } = useApp();
  const against = useMemo(() => patternStats(games, 'refutation'), [games]);
  const missed = useMemo(() => patternStats(games, 'better'), [games]);
  const months = useMemo(() => lastMonths(4), []);
  if (!against.length && !missed.length) return null;
  return (
    <section className="card tactics-card">
      <h3>Tactics</h3>
      <p className="muted small">From the board in your analyzed mistakes. Bars: the last four months.</p>
      {against.length > 0 && (
        <>
          <h4>That cost you</h4>
          <TacticList stats={against} months={months} side="refutation" />
        </>
      )}
      {missed.length > 0 && (
        <>
          <h4>You missed</h4>
          <TacticList stats={missed} months={months} side="better" />
        </>
      )}
    </section>
  );
}

const TACTIC_TREND: Record<PatternStat['trend'], string> = { improving: '↘ less often', worsening: '↗ more often', stable: '→ steady', insufficient: '' };

function TacticList({ stats, months, side }: { stats: PatternStat[]; months: string[]; side: 'refutation' | 'better' }) {
  const max = Math.max(1, ...stats.flatMap((s) => months.map((m) => s.byMonth[m] ?? 0)));
  return (
    <ul className="tactic-list">
      {stats.slice(0, 6).map((s) => (
        <li key={s.tag}>
          <div className="tl-head">
            <span className="pattern-tag">{s.label}</span>
            <span className="muted small">
              {s.total}× in {s.games} game{s.games === 1 ? '' : 's'}
              {TACTIC_TREND[s.trend] ? ` · ${TACTIC_TREND[s.trend]}` : ''}
            </span>
          </div>
          <div className="tl-body">
            <div className="month-bars" aria-label={months.map((m) => `${monthLabel(m)}: ${s.byMonth[m] ?? 0}`).join(', ')}>
              {months.map((m) => (
                <span key={m} title={`${monthLabel(m)}: ${s.byMonth[m] ?? 0}`}>
                  <span className="mb-track">
                    <i style={{ height: `${((s.byMonth[m] ?? 0) / max) * 100}%` }} />
                  </span>
                  <em>{monthLabel(m)[0]}</em>
                </span>
              ))}
            </div>
            <div className="tl-text small">
              <p className="muted">{(side === 'better' && PATTERN_RULE_MISSED[s.tag]) || PATTERN_RULE[s.tag]}</p>
              {s.examples[0] && (
                <button className="link small" onClick={() => navigate(`/game/${s.examples[0].gameId}/review?ply=${s.examples[0].ply}`)}>
                  See an example
                </button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function lastMonths(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
