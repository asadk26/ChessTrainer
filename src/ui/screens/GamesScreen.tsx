import { useMemo } from 'react';
import { gamePlayedAt } from '../../analysis/pipeline';
import { gameStats } from '../../analysis/engineReview';
import { userOutcome } from '../../chess/outcome';
import { navigate, useApp } from '../store';
import { deleteGame } from '../actions';
import { ChessComSync } from '../components/ChessComSync';
import { AnalysisQueue } from '../components/AnalysisQueue';
import { Icon, ScreenHeader } from '../components/AppShell';

export function GamesScreen() {
  const { games, refresh } = useApp();
  const recent = useMemo(() => [...games].sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a)), [games]);
  const statsById = useMemo(() => new Map(games.filter((g) => g.status === 'analyzed').map((g) => [g.id, gameStats(g)] as const)), [games]);
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
      <section className="card sync-card">
        <ChessComSync compact />
      </section>
      <AnalysisQueue />
      {recent.length === 0 ? (
        <section className="card">
          <p className="muted">No games yet. Sync Chess.com above, or tap + to paste a PGN.</p>
        </section>
      ) : (
        <section className="card">
          <ul className="games">
            {recent.map((g) => {
              const outcome = userOutcome(g);
              const won = outcome === 'win';
              const lost = outcome === 'loss';
              return (
                <li key={g.id} onClick={() => navigate(`/game/${g.id}`)}>
                  <span className={`result ${won ? 'won' : lost ? 'lost' : 'draw'}`}>{won ? 'W' : lost ? 'L' : outcome === 'draw' ? '½' : '?'}</span>
                  <span className="g-main">
                    vs <b>{g.opponentName}</b> <span className="muted small">{g.userColor === 'w' ? 'as White' : 'as Black'}</span>
                    <span className="muted small block">
                      {g.adaptive ? 'Adaptive Coach Game · ' : ''}
                      {g.status === 'analyzed' ? g.report?.focus.title : g.status === 'error' ? `Error: ${g.error}` : 'Not analyzed yet'}
                    </span>
                  </span>
                  {statsById.get(g.id) && (
                    <span className="acc-badge" title="Stockfish accuracy (0–100)">
                      {statsById.get(g.id)!.you.accuracy}
                    </span>
                  )}
                  <span className="muted small">{g.headers.date ?? new Date(g.importedAt).toLocaleDateString()}</span>
                  <button
                    className="icon subtle"
                    aria-label="Delete game"
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
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
