import { useMemo, useState, useSyncExternalStore } from 'react';
import type { StoredGame } from '../../domain/types';
import { gameStats } from '../../analysis/engineReview';
import { filterGames, gameOpening, openingCounts, opponentRating, shortDate, type GameFilter } from '../../analysis/gameList';
import { userOutcome } from '../../chess/outcome';
import { navigate, useApp } from '../store';
import { analysisQueue, deleteGame, isAnalysisRunning, pendingAnalysis, runAnalysisQueue } from '../actions';
import { ChessComSync } from '../components/ChessComSync';
import { Icon, ScreenHeader } from '../components/AppShell';

const CHIPS: { id: GameFilter; label: string }[] = [
  { id: 'wins', label: 'Wins' },
  { id: 'losses', label: 'Losses' },
  { id: 'white', label: 'White' },
  { id: 'black', label: 'Black' },
  { id: 'unanalyzed', label: 'Unanalyzed' },
];

export function GamesScreen() {
  const { games } = useApp();
  const [on, setOn] = useState<Set<GameFilter>>(new Set());
  const [opening, setOpening] = useState('');
  const shown = useMemo(() => filterGames(games, on, opening || undefined), [games, on, opening]);
  const openings = useMemo(() => openingCounts(games), [games]);
  const toggle = (id: GameFilter) => setOn((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const filtering = on.size > 0 || !!opening;

  return (
    <div className="games-screen">
      <ScreenHeader
        title="Games"
        actions={
          <button className="icon-btn" aria-label="Import a game" title="Import a game" onClick={() => navigate('/import')}>
            <Icon name="plus" />
          </button>
        }
      />
      <AnalyzeBar />
      <div className="sync-line">
        <ChessComSync compact />
      </div>

      {games.length > 0 && (
        <div className="chips" role="group" aria-label="Filter games">
          {CHIPS.map((c) => (
            <button key={c.id} className={`chip ${on.has(c.id) ? 'on' : ''}`} aria-pressed={on.has(c.id)} onClick={() => toggle(c.id)}>
              {c.label}
            </button>
          ))}
          <label className={`chip select-chip ${opening ? 'on' : ''}`}>
            <span>{opening || 'Opening'}</span>
            <select aria-label="Filter by opening" value={opening} onChange={(e) => setOpening(e.target.value)}>
              <option value="">Any opening</option>
              {openings.map((o) => (
                <option key={o.family} value={o.family}>
                  {o.family} ({o.count})
                </option>
              ))}
            </select>
          </label>
          {filtering && (
            <button className="chip clear" onClick={() => (setOn(new Set()), setOpening(''))}>
              Clear
            </button>
          )}
        </div>
      )}

      {games.length === 0 ? (
        <section className="card">
          <p className="muted">No games yet. Sync Chess.com above, or tap + to paste a PGN.</p>
        </section>
      ) : shown.length === 0 ? (
        <p className="muted">No games match these filters.</p>
      ) : (
        <>
          {filtering && <p className="muted small list-count">{shown.length} of {games.length} games</p>}
          <ul className="game-list">
            {shown.map((g) => (
              <GameRow key={g.id} g={g} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function GameRow({ g }: { g: StoredGame }) {
  const { refresh } = useApp();
  const outcome = userOutcome(g);
  const rating = opponentRating(g);
  const stats = g.status === 'analyzed' ? gameStats(g) : undefined;
  const opening = gameOpening(g).name;
  const res = outcome === 'win' ? ['W', 'won'] : outcome === 'loss' ? ['L', 'lost'] : outcome === 'draw' ? ['D', 'draw'] : ['?', 'draw'];
  return (
    <li className="game-row" onClick={() => navigate(`/game/${g.id}/review`)}>
      <span className={`result ${res[1]}`} aria-label={outcome ?? 'unknown result'}>
        {res[0]}
      </span>
      <span className="gr-main">
        <span className="gr-top">
          <span className={`side-dot ${g.userColor}`} title={g.userColor === 'w' ? 'You played White' : 'You played Black'} aria-label={g.userColor === 'w' ? 'as White' : 'as Black'} />
          <b className="gr-opp">{g.opponentName}</b>
          {rating && <span className="muted small">{rating}</span>}
        </span>
        <span className="muted small gr-sub">
          {g.adaptive ? 'Adaptive Coach Game · ' : ''}
          {opening} · {shortDate(g)}
        </span>
      </span>
      <span className="gr-right">
        {stats ? (
          <span className="acc-badge" title="Your Stockfish accuracy (0–100)">
            {stats.you.accuracy}
          </span>
        ) : (
          <span className={`status-pill ${g.status === 'error' ? 'error' : isAnalysisRunning(g.id) ? 'analyzing' : ''}`}>
            {g.status === 'error' ? 'Error' : isAnalysisRunning(g.id) ? 'Analyzing…' : 'Not analyzed'}
          </span>
        )}
        <button
          className="icon subtle"
          aria-label={`Delete the game vs ${g.opponentName}`}
          onClick={async (e) => {
            e.stopPropagation();
            if (confirm(`Delete the game vs ${g.opponentName}?`)) {
              await deleteGame(g.id);
              await refresh();
            }
          }}
        >
          ×
        </button>
      </span>
    </li>
  );
}

/** "Analyze latest 5" / "Analyze all", or the running queue with a Stop button. */
function AnalyzeBar() {
  const { games, refresh } = useApp();
  const q = useSyncExternalStore(analysisQueue.subscribe, analysisQueue.get);
  const pending = pendingAnalysis(games).length;
  const busy = games.filter((g) => isAnalysisRunning(g.id)).length;
  const run = (limit?: number) => void runAnalysisQueue(limit, () => void refresh(), { newest: true }).then(() => refresh());
  if (q.running)
    return (
      <section className="card analyze-bar running">
        <div className="row-between">
          <span>
            <b>
              Analyzing {Math.min(q.done + 1, q.total)} of {q.total}
            </b>
            {q.current && <span className="muted small"> · {q.current}</span>}
          </span>
          <button className="btn small" disabled={q.stopping} onClick={analysisQueue.stop}>
            {q.stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
        <div className="progress">
          <div style={{ width: `${Math.round((q.done / Math.max(1, q.total)) * 100)}%` }} />
        </div>
        <p className="muted small">
          A minute or two per game on a phone. Each game is saved as soon as it's done{q.failed ? ` (${q.failed} failed — open them to retry)` : ''}.
        </p>
      </section>
    );
  return (
    <section className="analyze-bar">
      <div className="actions left inline">
        <button className="btn primary small" disabled={!pending} onClick={() => run(5)}>
          Analyze latest {Math.min(5, pending) || 5}
        </button>
        <button className="btn small" disabled={!pending} onClick={() => run()}>
          Analyze all{pending ? ` (${pending})` : ''}
        </button>
      </div>
      <span className="muted small">{pending ? `${pending} waiting` : busy ? `${busy} analyzing…` : 'All games analyzed'}</span>
    </section>
  );
}
