import { useMemo, useState } from 'react';
import { aggregateProfile, describeFrequency } from '../../profile/profile';
import { gamePlayedAt } from '../../analysis/pipeline';
import { THEMES } from '../../domain/categories';
import { navigate, useApp } from '../store';
import { SAMPLE_PGN } from '../../fixtures/sampleGame';
import { parsePgn } from '../../chess/pgn';
import { deleteGame, downloadFeedback, exportBackup, exportFeedback, importBackup, importGame } from '../actions';
import { feedbackCount } from '../../coach/feedback';
import { userOutcome } from '../../chess/outcome';
import { gameStats, trend } from '../../analysis/engineReview';
import { ChessComSync } from '../components/ChessComSync';

const TREND: Record<string, string> = { improving: '↘ improving', worsening: '↗ more often', stable: '→ stable', new: 'new', insufficient: '' };

export function Dashboard() {
  const { games, settings, llm, attempts, drills, refresh, updateSettings } = useApp();
  const [showSettings, setShowSettings] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const flagged = feedbackCount(games);
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
  const statsById = useMemo(() => new Map(analyzed.map((g) => [g.id, gameStats(g)] as const)), [analyzed]);
  const accTrend = useMemo(
    () => trend(analyzed.flatMap((g) => (statsById.get(g.id) ? [{ at: gamePlayedAt(g), s: statsById.get(g.id)! }] : []))),
    [analyzed, statsById],
  );
  const solvedIds = new Set(attempts.filter((a) => a.correct).map((a) => a.drillId));
  const openDrills = drills.filter((d) => !solvedIds.has(d.id)).length;

  const trySample = async () => {
    const { game: g } = await importGame(parsePgn(SAMPLE_PGN), 'w');
    await refresh();
    navigate(`/game/${g.id}`);
  };

  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await importBackup(file);
      await refresh();
      setImportMsg({
        ok: true,
        text: `Imported ${r.gamesAdded} new game${r.gamesAdded === 1 ? '' : 's'}${r.gamesUpdated ? `, updated ${r.gamesUpdated}` : ''}${r.gamesKept ? `, kept ${r.gamesKept} you already had` : ''}, ${r.drills} drills and ${r.attempts} drill attempts.`,
      });
    } catch (e) {
      setImportMsg({ ok: false, text: (e as Error).message });
    }
  };
  const importButton = (
    <label className="btn ghost file-btn">
      Import data (JSON)
      <input type="file" accept="application/json,.json" onChange={(e) => (void onImportFile(e.target.files?.[0]), (e.target.value = ''))} />
    </label>
  );

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
        <section className="card">
          <h3>Or sync your Chess.com games</h3>
          <ChessComSync />
        </section>
        <p className="muted small">
          Moving from another device? Export your data there (Dashboard → Settings), then restore it here: {importButton}
        </p>
        {importMsg && <div className={`feedback ${importMsg.ok ? 'good' : 'bad'}`}>{importMsg.text}</div>}
        <p className="muted small">Stockfish runs in your browser — free, private, and nothing to set up.</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      {importMsg && <div className={`feedback ${importMsg.ok ? 'good' : 'bad'}`}>{importMsg.text}</div>}
      <section className="card sync-card">
        <ChessComSync />
      </section>
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

      {analyzed.length > 0 && (
        <section className="card trend-card">
          <h3>How your games are going</h3>
          {accTrend ? (
            <p>
              Accuracy: <b>{accTrend.recent}</b> over your last {accTrend.n} games vs {accTrend.earlier} over the {accTrend.n} before
              {accTrend.recent - accTrend.earlier >= 3 ? ' — improving.' : accTrend.earlier - accTrend.recent >= 3 ? ' — a dip; check the recurring weaknesses below.' : ' — about the same.'}{' '}
              Blunders per game: <b>{accTrend.recentBlunders}</b> vs {accTrend.earlierBlunders}.
            </p>
          ) : (
            <p className="muted">
              Each game's Stockfish accuracy is shown next to it below. Once you have 6 analyzed games, I'll compare your recent games with earlier ones ({analyzed.length}/6 so far).
            </p>
          )}
          <p className="muted small">Accuracy is a rough measure — short or one-sided games swing it a lot. It's not a rating estimate.</p>
        </section>
      )}

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
            const outcome = userOutcome(g);
            const won = outcome === 'win';
            const lost = outcome === 'loss';
            return (
              <li key={g.id} onClick={() => navigate(`/game/${g.id}`)}>
                <span className={`result ${won ? 'won' : lost ? 'lost' : 'draw'}`}>{won ? 'W' : lost ? 'L' : outcome === 'draw' ? '½' : '?'}</span>
                <span className="g-main">
                  vs <b>{g.opponentName}</b> <span className="muted small">{g.userColor === 'w' ? 'as White' : 'as Black'}</span>
                  <span className="muted small block">{g.status === 'analyzed' ? g.report?.focus.title : g.status === 'error' ? `Error: ${g.error}` : 'Not analyzed yet'}</span>
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

      {flagged > 0 && (
        <section className="card feedback-card">
          <h3>Coach feedback</h3>
          <p className="muted small">
            You've flagged {flagged} thing{flagged === 1 ? '' : 's'} the coach got wrong. Copy them (with the game PGNs) and paste them to Claude to improve the coach.
          </p>
          <div className="actions left inline">
            <button className="btn primary small" onClick={async () => setFeedbackMsg((await exportFeedback()) === 'copied' ? 'Copied to the clipboard.' : 'Downloaded as a file.')}>
              Copy feedback
            </button>
            <button className="btn ghost small" onClick={() => void downloadFeedback()}>
              Download (.md)
            </button>
            {feedbackMsg && <span className="muted small">{feedbackMsg}</span>}
          </div>
        </section>
      )}

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
            {llm.provider && (
            <label className="check">
              <input type="checkbox" checked={settings.useLlm} onChange={(e) => updateSettings({ useLlm: e.target.checked })} />
              AI instructor explanations ({llm.provider} · {llm.model}) — for each game's 1–2 lessons, and on request
            </label>
            )}
            {llm.reason && <div className="muted small">{llm.reason}</div>}
            {llm.requiresToken && (
              <label>
                AI coach access code
                <input
                  type="password"
                  autoComplete="off"
                  defaultValue={settings.coachToken ?? ''}
                  placeholder="COACH_ACCESS_TOKEN from your deployment"
                  onBlur={(e) => updateSettings({ coachToken: e.target.value.trim() || undefined })}
                />
              </label>
            )}
            <div className="muted small">
              Known usernames: {Object.keys(settings.usernames).join(', ') || '—'} · {profile.gamesAnalyzed} games analyzed
            </div>
            <div className="actions left">
              <button className="btn ghost" onClick={exportBackup}>
                Export data (JSON)
              </button>
              {importButton}
            </div>
            <p className="muted small">
              Export on one device and import on another to move your games, drills and profile. Importing merges — it never deletes what's already here.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
