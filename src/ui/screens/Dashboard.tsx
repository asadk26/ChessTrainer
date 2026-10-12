import { useMemo, useState } from 'react';
import { aggregateProfile, describeFrequency } from '../../profile/profile';
import { gamePlayedAt } from '../../analysis/pipeline';
import { THEMES } from '../../domain/categories';
import { navigate, useApp } from '../store';
import { SAMPLE_PGN } from '../../fixtures/sampleGame';
import { parsePgn } from '../../chess/pgn';
import { deleteGame, importGame } from '../actions';
import { repo } from '../../storage/repository';

const TREND: Record<string, string> = { improving: '↘ improving', worsening: '↗ more often', stable: '→ stable', new: 'new', insufficient: '' };

export function Dashboard() {
  const { games, settings, llm, attempts, drills, refresh, updateSettings } = useApp();
  const [showSettings, setShowSettings] = useState(false);
  const analyzed = games.filter((g) => g.status === 'analyzed');
  const profile = useMemo(
    () =>
      aggregateProfile(
        analyzed.map((g) => ({
          gameId: g.id,
          playedAt: gamePlayedAt(g),
          findings: g.findings,
          sanByPly: Object.fromEntries(g.plies.map((p) => [p.ply, p.san])),
        })),
      ),
    [analyzed],
  );
  const recent = [...games].sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a));
  const solvedIds = new Set(attempts.filter((a) => a.correct).map((a) => a.drillId));
  const openDrills = drills.filter((d) => !solvedIds.has(d.id)).length;

  const trySample = async () => {
    const g = await importGame(parsePgn(SAMPLE_PGN), 'w');
    await refresh();
    navigate(`/game/${g.id}`);
  };

  const exportData = async () => {
    const blob = new Blob([await repo.exportAll()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chess-coach-backup.json';
    a.click();
  };

  if (games.length === 0) {
    return (
      <div className="narrow welcome">
        <h1>Your personal chess coach</h1>
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
        <p className="muted small">Stockfish runs in your browser. {llm.provider ? `AI coach voice: ${llm.provider} (${llm.model}).` : 'No AI key configured — coaching uses built-in explanations.'}</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <section className="card focus-card">
        <span className="eyebrow">Current focus</span>
        {settings.focus ? (
          <>
            <h2>{settings.focus.title}</h2>
            <p>{settings.focus.detail}</p>
            <p className="muted small">From your {THEMES[settings.focus.theme]?.label.toLowerCase()} pattern · set after your latest analyzed game</p>
          </>
        ) : (
          <p className="muted">Analyze a game to get your first focus.</p>
        )}
      </section>

      <div className="grid-2">
        <section className="card">
          <h3>Recent strengths</h3>
          {profile.strengths.length === 0 && <p className="muted">Nothing yet.</p>}
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

      <section className="card">
        <div className="row-between">
          <h3>Recent games</h3>
          <div className="actions inline">
            {openDrills > 0 && (
              <button className="btn ghost" onClick={() => navigate('/drills')}>
                {openDrills} drill{openDrills > 1 ? 's' : ''} to practise
              </button>
            )}
            <button className="btn primary" onClick={() => navigate('/import')}>
              Import game
            </button>
          </div>
        </div>
        <ul className="games">
          {recent.map((g) => {
            const won = (g.headers.result === '1-0' && g.userColor === 'w') || (g.headers.result === '0-1' && g.userColor === 'b');
            const lost = (g.headers.result === '0-1' && g.userColor === 'w') || (g.headers.result === '1-0' && g.userColor === 'b');
            return (
              <li key={g.id} onClick={() => navigate(`/game/${g.id}`)}>
                <span className={`result ${won ? 'won' : lost ? 'lost' : 'draw'}`}>{won ? 'W' : lost ? 'L' : '½'}</span>
                <span className="g-main">
                  vs <b>{g.opponentName}</b> <span className="muted small">{g.userColor === 'w' ? 'as White' : 'as Black'}</span>
                  <span className="muted small block">{g.status === 'analyzed' ? g.report?.focus.title : g.status === 'error' ? `Error: ${g.error}` : 'Not analyzed yet'}</span>
                </span>
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

      <section className="card settings">
        <button className="link" onClick={() => setShowSettings(!showSettings)}>
          {showSettings ? 'Hide' : 'Show'} settings
        </button>
        {showSettings && (
          <div className="settings-grid">
            <label>
              Your rating
              <input type="number" value={settings.rating} onChange={(e) => updateSettings({ rating: Number(e.target.value) || 850 })} />
            </label>
            <label>
              Engine depth
              <select value={settings.analysisDepth} onChange={(e) => updateSettings({ analysisDepth: Number(e.target.value) })}>
                <option value={10}>10 — fast</option>
                <option value={12}>12 — standard</option>
                <option value={14}>14 — thorough</option>
                <option value={16}>16 — slow</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.useLlm} disabled={!llm.provider} onChange={(e) => updateSettings({ useLlm: e.target.checked })} />
              AI coach voice {llm.provider ? `(${llm.provider} · ${llm.model})` : '(not configured — see .env.example)'}
            </label>
            <div className="muted small">
              Known usernames: {Object.keys(settings.usernames).join(', ') || '—'} · {profile.gamesAnalyzed} games analyzed
            </div>
            <div className="actions left">
              <button className="btn ghost" onClick={exportData}>
                Export data (JSON)
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
