import { THEMES } from '../../domain/categories';
import { navigate, useApp } from '../store';
import { SAMPLE_PGN } from '../../fixtures/sampleGame';
import { parsePgn } from '../../chess/pgn';
import { importGame } from '../actions';
import { ChessComSync } from '../components/ChessComSync';
import { CoachGameCard } from '../components/CoachGameCard';
import { Icon, ScreenHeader } from '../components/AppShell';

export function Dashboard() {
  const { games, settings, refresh } = useApp();
  const gear = (
    <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => navigate('/settings')}>
      <Icon name="gear" />
    </button>
  );

  const trySample = async () => {
    const { game: g } = await importGame(parsePgn(SAMPLE_PGN), 'w');
    await refresh();
    navigate(`/game/${g.id}`);
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
    <div className="dashboard">
      <ScreenHeader title="Chess Coach" actions={gear} />
      <section className="card focus-card">
        <span className="eyebrow">Current focus</span>
        {settings.focus ? (
          <>
            <h2>{settings.focus.title}</h2>
            <p>{settings.focus.detail}</p>
            <p className="muted small">From your {THEMES[settings.focus.theme]?.label.toLowerCase()} pattern · set after your latest analyzed game</p>
          </>
        ) : (
          <p className="muted">
            Analyze a game to get your first focus — <a href="#/games">open Games</a>.
          </p>
        )}
      </section>
      <CoachGameCard />
    </div>
  );
}
