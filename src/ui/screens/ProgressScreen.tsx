import { useMemo } from 'react';
import { aggregateProfile, describeFrequency } from '../../profile/profile';
import { gamePlayedAt, isRealGame } from '../../analysis/pipeline';
import { gameStats, trend } from '../../analysis/engineReview';
import { useApp } from '../store';
import { ScreenHeader } from '../components/AppShell';

const TREND: Record<string, string> = { improving: '↘ improving', worsening: '↗ more often', stable: '→ stable', new: 'new', insufficient: '' };

export function ProgressScreen() {
  const { games } = useApp();
  const analyzed = useMemo(() => games.filter((g) => g.status === 'analyzed' && isRealGame(g)), [games]);
  const profile = useMemo(
    () => aggregateProfile(analyzed.map((g) => ({ gameId: g.id, playedAt: gamePlayedAt(g), findings: g.findings, sanByPly: Object.fromEntries(g.plies.map((p) => [p.ply, p.san])) }))),
    [analyzed],
  );
  const accTrend = useMemo(() => trend(analyzed.flatMap((g) => { const s = gameStats(g); return s ? [{ at: gamePlayedAt(g), s }] : []; })), [analyzed]);

  return (
    <div className="progress-screen">
      <ScreenHeader title="Progress" />
      {analyzed.length === 0 ? (
        <section className="card">
          <p className="muted">Analyze a few games and your strengths, recurring weaknesses and trends show up here.</p>
        </section>
      ) : (
        <>
          <section className="card trend-card">
            <h3>How your games are going</h3>
            {accTrend ? (
              <p>
                Accuracy: <b>{accTrend.recent}</b> over your last {accTrend.n} games vs {accTrend.earlier} over the {accTrend.n} before
                {accTrend.recent - accTrend.earlier >= 3 ? ' — improving.' : accTrend.earlier - accTrend.recent >= 3 ? ' — a dip; check the recurring weaknesses below.' : ' — about the same.'}{' '}
                Blunders per game: <b>{accTrend.recentBlunders}</b> vs {accTrend.earlierBlunders}.
              </p>
            ) : (
              <p className="muted">Once you have 6 analyzed games, I'll compare your recent games with earlier ones ({analyzed.length}/6 so far).</p>
            )}
            <p className="muted small">Accuracy is a rough measure — short or one-sided games swing it a lot. It's not a rating estimate.</p>
          </section>
          <div className="grid-2">
            <section className="card">
              <h3>Recent strengths</h3>
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
        </>
      )}
    </div>
  );
}
