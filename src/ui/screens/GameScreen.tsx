import { useEffect, useRef, useState } from 'react';
import type { ReportItem, StoredGame } from '../../domain/types';
import { enrichWithLlm, recoach, runAnalysis } from '../actions';
import { navigate, useApp } from '../store';
import { GuidedReview } from './GuidedReview';
import { DrillList } from './DrillsScreen';
import { CoachText, HoverProvider } from '../components/CoachText';
import { PositionDiagram, diagramFor, type DiagramSpec } from '../components/PositionDiagram';
import { REPORT_VERSION } from '../../coach/report';
import { repo } from '../../storage/repository';

function useAnalysis(game: StoredGame | undefined) {
  const { refresh, settings, llm } = useApp();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [llmState, setLlmState] = useState<'idle' | 'working' | 'error'>('idle');
  const started = useRef<string | null>(null);

  const enrich = async (id: string) => {
    setLlmState('working');
    try {
      await enrichWithLlm(id);
      await refresh();
      setLlmState('idle');
    } catch (e) {
      console.warn('LLM coaching failed, keeping template coaching:', e);
      setLlmState('error');
    }
  };

  useEffect(() => {
    if (!game || started.current === game.id) return;
    if (game.status !== 'imported' && game.status !== 'analyzing') return;
    started.current = game.id;
    setError(null);
    setProgress({ done: 0, total: game.plies.length + 1 });
    runAnalysis(game.id, (done, total) => setProgress({ done, total }))
      .then(async (g) => {
        setProgress(null);
        await refresh();
        if (llm.provider && settings.useLlm && (!llm.requiresToken || settings.coachToken)) void enrich(g.id);
      })
      .catch(async (e) => {
        setProgress(null);
        setError((e as Error).message);
        await refresh();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id, game?.status]);

  return { progress, error, llmState, enrich };
}

function Items({ items, game, kind, size = 200 }: { items: ReportItem[]; game: StoredGame; kind: 'mistake' | 'good'; size?: number }) {
  const momentPlies = new Set(game.moments.map((m) => m.ply));
  // Open the review just before the move (or straight into its guided moment).
  const open = (ply: number) => navigate(`/game/${game.id}/review?ply=${momentPlies.has(ply) || kind === 'good' ? ply : Math.max(0, ply - 1)}`);
  return (
    <ul className="report-list">
      {items.map((it, i) => {
        const plies = (it.keyPlies ?? [...new Set(it.plies ?? [])].sort((a, b) => a - b)).filter((p) => p > 0).slice(0, 4);
        const specs = plies.map((p) => diagramFor(game, p, kind)).filter((d): d is DiagramSpec => !!d);
        return (
          <li key={i}>
            <CoachText text={it.text} />
            {specs.length > 0 && (
              <div className="diagram-row">
                {specs.map((d) => (
                  <PositionDiagram key={d.ply} spec={d} orientation={game.userColor} size={size} onOpen={() => open(d.ply)} />
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Summary({ game }: { game: StoredGame }) {
  const r = game.report!;
  return (
    <div className="summary">
      <section className="card headline-card">
        <p className="headline">{r.headline}</p>
        {r.story && <p className="story muted">{r.story}</p>}
      </section>
      <section className="card">
        <h3 className="good-h">What you did well</h3>
        {r.didWell.length ? <Items items={r.didWell} game={game} kind="good" /> : <p className="muted">Nothing stood out this time.</p>}
      </section>
      <section className="card">
        <h3 className="bad-h">What hurt you</h3>
        <p className="muted small diagram-key">
          <span className="key orange" /> your move <span className="key green" /> better move · tap a board to replay it
        </p>
        {r.hurt.length ? <Items items={r.hurt} game={game} kind="mistake" /> : <p className="muted">No significant problems. Nice.</p>}
      </section>
      <section className="card">
        <h3>Recurring pattern</h3>
        <p>{r.recurring}</p>
      </section>
      <section className="card focus-card">
        <span className="eyebrow">Focus for next game</span>
        <h2>{r.focus.title}</h2>
        <p>{r.focus.detail}</p>
      </section>
      {r.minorNotes.length > 0 && (
        <section className="card subtle-card">
          <h3>Smaller notes</h3>
          <Items items={r.minorNotes} game={game} kind="mistake" size={160} />
        </section>
      )}
      <div className="actions">
        {game.moments.length > 0 && (
          <button className="btn primary" onClick={() => navigate(`/game/${game.id}/review`)}>
            Replay the game ({game.moments.length} guided moment{game.moments.length > 1 ? 's' : ''})
          </button>
        )}
        <button className="btn ghost" onClick={() => navigate(`/game/${game.id}/drills`)}>
          Drills
        </button>
      </div>
    </div>
  );
}

export function GameScreen({ id, tab, ply }: { id: string; tab: 'summary' | 'review' | 'drills'; ply?: number }) {
  const { games, refresh, llm } = useApp();
  const game = games.find((g) => g.id === id);
  const { progress, error, llmState, enrich } = useAnalysis(game);

  // Reports from an older app version get re-coached from the stored engine
  // output (seconds, no engine run) so they pick up diagrams and new findings.
  const upgraded = useRef<string | null>(null);
  useEffect(() => {
    if (!game || game.status !== 'analyzed' || !game.report || upgraded.current === game.id) return;
    if ((game.report.version ?? 1) >= REPORT_VERSION || game.report.voice !== 'template') return;
    upgraded.current = game.id;
    void recoach(game.id).then(() => refresh());
  }, [game, refresh]);

  if (!game) return <div className="narrow"><p className="muted">Game not found.</p></div>;

  const header = (
    <div className={`game-header ${tab === 'review' ? 'compact' : ''}`}>
      <div>
        <h1>
          {game.headers.white} <span className="muted">vs</span> {game.headers.black}
        </h1>
        <p className="muted small">
          {game.headers.result} · you played {game.userColor === 'w' ? 'White' : 'Black'}
          {game.headers.date ? ` · ${game.headers.date}` : ''}
          {game.report ? ` · coach voice: ${game.report.voice === 'llm' ? 'AI' : 'built-in'}` : ''}
          {llmState === 'working' && ' · AI coach is writing…'}
          {llmState === 'error' && ' · AI coach unavailable, using built-in coaching'}
        </p>
      </div>
      {game.status === 'analyzed' && (
        <nav className="tabs">
          {(['summary', 'review', 'drills'] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => navigate(t === 'summary' ? `/game/${id}` : `/game/${id}/${t}`)}>
              {t === 'summary' ? 'Summary' : t === 'review' ? 'Guided review' : 'Drills'}
            </button>
          ))}
        </nav>
      )}
    </div>
  );

  if (game.status !== 'analyzed') {
    const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="narrow">
        {header}
        <div className="card">
          {error || game.status === 'error' ? (
            <>
              <div className="feedback bad">{error ?? game.error}</div>
              <button
                className="btn primary"
                onClick={async () => {
                  await repo.saveGame({ ...game, status: 'imported', error: undefined });
                  await refresh();
                }}
              >
                Retry analysis
              </button>
            </>
          ) : (
            <>
              <p>Stockfish is looking at every position{progress ? ` (${progress.done}/${progress.total})` : ''}…</p>
              <div className="progress">
                <div style={{ width: `${pct}%` }} />
              </div>
              <p className="muted small">Then I'll pick out what's actually worth teaching.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}
      {tab === 'summary' && <Summary game={game} />}
      {tab === 'review' && <GuidedReview key={game.id + (ply ?? '')} game={game} initialPly={ply} />}
      {tab === 'drills' && (
        <HoverProvider>
          <DrillList gameId={game.id} />
        </HoverProvider>
      )}
      {tab === 'summary' && (
        <div className="actions left small-actions">
          <button className="link" onClick={async () => (await recoach(game.id), await refresh())}>
            Re-run coaching with latest history
          </button>
          {llm.provider && (
            <button className="link" disabled={llmState === 'working'} onClick={() => enrich(game.id)}>
              {game.report?.voice === 'llm' ? 'Rewrite with AI coach again' : 'Rewrite with AI coach'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
