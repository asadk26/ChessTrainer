import { useMemo, useSyncExternalStore } from 'react';
import type { StoredGame } from '../../domain/types';
import { THEMES } from '../../domain/categories';
import { navigate, useApp } from '../store';
import { SAMPLE_PGN } from '../../fixtures/sampleGame';
import { parsePgn } from '../../chess/pgn';
import { userOutcome } from '../../chess/outcome';
import { analysisQueue, importGame, isAnalysisRunning, pendingAnalysis, runAnalysisQueue } from '../actions';
import { gamePlayedAt, isRealGame } from '../../analysis/pipeline';
import { gameStats } from '../../analysis/engineReview';
import { gameOpening, opponentRating, shortDate } from '../../analysis/gameList';
import { blundersPerGame, gamesThisWeek, ratingTrend } from '../../analysis/homeStats';
import { ChessComSync } from '../components/ChessComSync';
import { Icon, ScreenHeader } from '../components/AppShell';

export function Dashboard() {
  const { games, refresh } = useApp();
  const gear = (
    <button className="icon-btn plain" aria-label="Settings" title="Settings" onClick={() => navigate('/settings')}>
      <Icon name="gear" />
    </button>
  );

  const trySample = async () => {
    const { game: g } = await importGame(parsePgn(SAMPLE_PGN), 'w');
    await refresh();
    navigate(`/game/${g.id}/review`);
  };

  if (games.length === 0) {
    return (
      <div className="narrow welcome">
        <ScreenHeader title="Chess Coach" actions={gear} />
        <h2>Your personal chess coach</h2>
        <p>
          Import your games and I'll look for the habits that actually cost you points — not every engine nitpick. Each review ends with one thing to
          focus on next game, a few drills, and a profile that tracks your patterns over time.
        </p>
        <div className="actions left">
          <button className="btn primary" onClick={() => navigate('/import')}>
            Import a game
          </button>
          <button className="btn ghost" onClick={trySample}>
            Try the sample game
          </button>
        </div>
        <section className="card">
          <h3>Or sync your Chess.com games</h3>
          <ChessComSync />
        </section>
        <p className="muted small">
          Moving from another device? Export your data there (Settings → Backup), then import it here in <a href="#/settings">Settings</a>.
        </p>
        <p className="muted small">Stockfish runs in your browser — free, private, and nothing to set up.</p>
      </div>
    );
  }

  return (
    <div className="narrow home">
      <ScreenHeader title="Chess Coach" actions={gear} />
      <FocusCard />
      <LatestGameCard />
      <StatsStrip />
    </div>
  );
}

function FocusCard() {
  const { settings } = useApp();
  return (
    <section className="card focus-card">
      <span className="eyebrow">Current focus</span>
      {settings.focus ? (
        <>
          <h2>{settings.focus.title}</h2>
          <details className="focus-more">
            <summary>Why this?</summary>
            <p>{settings.focus.detail}</p>
            <p className="muted small">From your {THEMES[settings.focus.theme]?.label.toLowerCase()} pattern · set after your latest analyzed game</p>
          </details>
        </>
      ) : (
        <p className="muted">Analyze a game to get your first focus.</p>
      )}
    </section>
  );
}

const firstSentence = (s?: string) => s?.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? s;

function LatestGameCard() {
  const { games, refresh } = useApp();
  const q = useSyncExternalStore(analysisQueue.subscribe, analysisQueue.get);
  const latest: StoredGame | undefined = useMemo(() => games.filter(isRealGame).sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a))[0], [games]);
  const waiting = pendingAnalysis(games).length;
  const analyzeAll = () => void runAnalysisQueue(undefined, () => void refresh(), { newest: true }).then(() => refresh());
  if (!latest) return null;

  const outcome = userOutcome(latest);
  const res = outcome === 'win' ? ['W', 'won'] : outcome === 'loss' ? ['L', 'lost'] : outcome === 'draw' ? ['D', 'draw'] : ['?', 'draw'];
  const rating = opponentRating(latest);
  const analyzed = latest.status === 'analyzed';
  const acc = analyzed ? gameStats(latest)?.you.accuracy : undefined;
  const busy = q.running || isAnalysisRunning(latest.id);

  return (
    <section className="card latest-card">
      <span className="eyebrow">Latest game</span>
      <button className="latest-game" onClick={() => navigate(`/game/${latest.id}/review`)}>
        <span className={`result ${res[1]}`}>{res[0]}</span>
        <span className="gr-main">
          <span className="gr-top">
            <span className={`side-dot ${latest.userColor}`} aria-label={latest.userColor === 'w' ? 'as White' : 'as Black'} />
            <b className="gr-opp">{latest.opponentName}</b>
            {rating && <span className="muted small">{rating}</span>}
          </span>
          <span className="muted small gr-sub">
            {gameOpening(latest).name} · {shortDate(latest)}
          </span>
        </span>
        {acc !== undefined && (
          <span className="acc-badge" title="Your Stockfish accuracy (0–100)">
            {acc}
          </span>
        )}
      </button>
      {analyzed && latest.report?.headline && <p className="latest-headline">{firstSentence(latest.report.headline)}</p>}

      {q.running ? (
        <div className="latest-progress">
          <div className="row-between">
            <span className="small">
              <b>
                Analyzing {Math.min(q.done + 1, q.total)} of {q.total}
              </b>
              {q.current && <span className="muted"> · {q.current}</span>}
            </span>
            <button className="btn small" disabled={q.stopping} onClick={analysisQueue.stop}>
              {q.stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round((q.done / Math.max(1, q.total)) * 100)}%` }} />
          </div>
        </div>
      ) : analyzed ? (
        <div className="actions left inline">
          <button className="btn primary" onClick={() => navigate(`/game/${latest.id}/review`)}>
            Review
          </button>
          {waiting > 0 && (
            <button className="link small" onClick={analyzeAll}>
              {waiting} game{waiting === 1 ? '' : 's'} waiting — analyze
            </button>
          )}
        </div>
      ) : (
        <div className="actions left inline">
          <button className="btn primary" disabled={busy} onClick={analyzeAll}>
            {busy ? 'Analyzing…' : waiting > 1 ? `${waiting} games waiting — analyze` : 'Analyze it'}
          </button>
        </div>
      )}
    </section>
  );
}

function StatsStrip() {
  const { games } = useApp();
  const rating = useMemo(() => ratingTrend(games), [games]);
  const week = useMemo(() => gamesThisWeek(games), [games]);
  const blunders = useMemo(() => blundersPerGame(games), [games]);
  const tc = rating?.timeClass ? `${rating.timeClass[0].toUpperCase()}${rating.timeClass.slice(1)} rating` : 'Rating';
  return (
    <section className="stats-strip" aria-label="Your stats">
      <div className="stat">
        <span className="stat-label">{tc}</span>
        {rating ? (
          <>
            <span className="stat-value">{rating.current}</span>
            <span className={`stat-sub ${rating.change > 0 ? 'up' : rating.change < 0 ? 'down' : ''}`}>
              {rating.change > 0 ? '▲ +' : rating.change < 0 ? '▼ ' : ''}
              {rating.change === 0 ? 'no change' : rating.change} · 30 days
            </span>
            <Sparkline points={rating.points} down={rating.change < 0} />
          </>
        ) : (
          <span className="stat-sub">No ratings in your PGNs yet</span>
        )}
      </div>
      <div className="stat">
        <span className="stat-label">This week</span>
        <span className="stat-value">{week}</span>
        <span className="stat-sub">game{week === 1 ? '' : 's'} played</span>
      </div>
      <div className="stat">
        <span className="stat-label">Blunders / game</span>
        {blunders ? (
          <>
            <span className="stat-value">{blunders.recent}</span>
            <span className={`stat-sub ${blunders.earlier === undefined ? '' : blunders.recent < blunders.earlier ? 'up' : blunders.recent > blunders.earlier ? 'down' : ''}`}>
              {blunders.earlier === undefined ? `last ${blunders.n} analyzed` : `was ${blunders.earlier} · last ${blunders.n}`}
            </span>
          </>
        ) : (
          <span className="stat-sub">Analyze a game to see this</span>
        )}
      </div>
    </section>
  );
}

function Sparkline({ points, down }: { points: number[]; down?: boolean }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(1, max - min);
  const d = points.map((p, i) => `${((i / (points.length - 1)) * 100).toFixed(1)},${(22 - ((p - min) / span) * 20).toFixed(1)}`).join(' ');
  return (
    <svg className={`sparkline ${down ? 'down' : ''}`} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
