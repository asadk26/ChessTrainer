import { useEffect, useRef, useState } from 'react';
import type { ReportItem, StoredGame } from '../../domain/types';
import { enrichWithLlm, explainLessons, recoach, runAnalysis, setOutcome } from '../actions';
import { navigate, useApp } from '../store';
import { GuidedReview } from './GuidedReview';
import { DrillList } from './DrillsScreen';
import { CoachText, HoverProvider } from '../components/CoachText';
import { PositionDiagram, diagramFor, type DiagramSpec } from '../components/PositionDiagram';
import { REPORT_VERSION } from '../../coach/report';
import { engineNotes, gameStats } from '../../analysis/engineReview';
import { repo } from '../../storage/repository';
import { FlagButton } from '../components/FlagButton';
import { OUTCOME_LABEL, userOutcome, type Outcome } from '../../chess/outcome';
import type { FeedbackWhere } from '../../domain/types';

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
        // AI is used only where it adds most: explanations for this game's 1–2 lessons.
        if (llm.provider && settings.useLlm && (!llm.requiresToken || settings.coachToken)) void explainLessons(g.id).then(() => refresh());
      })
      .catch(async (e) => {
        setProgress(null);
        setError((e as Error).message);
        await refresh();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id, game?.status]);

  // Games analysed earlier (or synced) get their lesson explanations the first time they're opened.
  const explained = useRef<string | null>(null);
  useEffect(() => {
    if (!game || game.status !== 'analyzed' || explained.current === game.id) return;
    if (!llm.provider || !settings.useLlm || (llm.requiresToken && !settings.coachToken)) return;
    const missing = game.moments.some((m) => m.tier === 'lesson' && m.kind === 'mistake' && !game.aiExplanations?.[m.betterPly]);
    explained.current = game.id;
    if (missing)
      void explainLessons(game.id).then((n) => {
        if (n) void refresh();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id, game?.status, llm.provider]);

  return { progress, error, llmState, enrich };
}

function itemPlies(it: ReportItem): number[] {
  return (it.keyPlies ?? [...new Set(it.plies ?? [])].sort((a, b) => a - b)).filter((p) => p > 0).slice(0, 4);
}

function Items({
  items,
  game,
  kind,
  size = 200,
  shown,
  where,
}: {
  items: ReportItem[];
  game: StoredGame;
  kind: 'mistake' | 'good';
  where: FeedbackWhere;
  size?: number;
  /** Plies already drawn earlier in the summary — each position is shown once. */
  shown?: ReadonlySet<number>;
}) {
  const momentPlies = new Set(game.moments.map((m) => m.ply));
  // Open the review just before the move (or straight into its guided moment).
  const open = (ply: number) => navigate(`/game/${game.id}/review?ply=${momentPlies.has(ply) || kind === 'good' ? ply : Math.max(0, ply - 1)}`);
  return (
    <ul className="report-list">
      {items.map((it, i) => {
        const plies = itemPlies(it).filter((p) => !shown?.has(p));
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
            <FlagButton game={game} where={where} quote={it.text} ply={itemPlies(it)[0]} />
          </li>
        );
      })}
    </ul>
  );
}

function Summary({ game }: { game: StoredGame }) {
  const r = game.report!;
  const lessons = game.moments.filter((m) => m.tier !== 'note').length;
  const stats = gameStats(game);
  const notes = engineNotes(game);
  // Positions drawn under "what hurt you" aren't repeated in the smaller notes,
  // and an item doesn't repeat a position an earlier item already showed.
  const hurtShown = new Set<number>();
  const hurtItems = r.hurt.map((it) => {
    const keep = { ...it, keyPlies: itemPlies(it).filter((p) => !hurtShown.has(p)) };
    keep.keyPlies.forEach((p) => hurtShown.add(p));
    return keep;
  });
  return (
    <div className="summary">
      <section className="card headline-card">
        <p className="headline">{r.headline}</p>
        <FlagButton game={game} where="headline" quote={r.headline} />
        {r.story && <p className="story muted">{r.story}</p>}
        {r.story && <FlagButton game={game} where="story" quote={r.story} />}
        {stats && (
          <p className="accuracy-line">
            <span className="engine-chip">Stockfish</span> Accuracy: <b>you {stats.you.accuracy}</b> · {game.opponentName} {stats.opponent.accuracy}
            <span className="muted">
              {' '}· your {stats.you.inaccuracy} inaccurac{stats.you.inaccuracy === 1 ? 'y' : 'ies'}, {stats.you.mistake} mistake{stats.you.mistake === 1 ? '' : 's'},{' '}
              {stats.you.blunder} blunder{stats.you.blunder === 1 ? '' : 's'}
            </span>
            {stats.caveat && <span className="muted small block">{stats.caveat}</span>}
          </p>
        )}
      </section>
      <section className="card">
        <h3 className="good-h">What you did well</h3>
        {r.didWell.length ? <Items items={r.didWell} game={game} kind="good" where="did_well" /> : <p className="muted">Nothing stood out this time.</p>}
      </section>
      <section className="card">
        <h3 className="bad-h">What hurt you</h3>
        <p className="muted small diagram-key">
          <span className="key orange" /> your move <span className="key green" /> better move · tap a board to replay it
        </p>
        {r.hurt.length ? <Items items={hurtItems} game={game} kind="mistake" where="hurt" /> : <p className="muted">No significant problems. Nice.</p>}
      </section>
      <section className="card">
        <h3>Recurring pattern</h3>
        <p>{r.recurring}</p>
        <FlagButton game={game} where="recurring" quote={r.recurring} />
      </section>
      <section className="card focus-card">
        <span className="eyebrow">Focus for next game</span>
        <h2>{r.focus.title}</h2>
        <p>{r.focus.detail}</p>
        <FlagButton game={game} where="focus" quote={`${r.focus.title} ${r.focus.detail}`} />
      </section>
      {notes.length > 0 && (
        <section className="card subtle-card engine-notes">
          <h3>Stockfish's other notes</h3>
          <p className="muted small">Engine facts the coach didn't turn into lessons — so a move without a lesson isn't automatically the best move.</p>
          <ul className="report-list">
            {notes.map((n) => (
              <li key={n.ply + n.kind}>
                <span className={`note-kind ${n.kind}`}>{n.kind === 'trap' ? 'It worked, but…' : n.kind === 'uncovered' ? 'Your move' : 'Their miss'}</span>
                <CoachText text={n.text} />
                <button className="link small" onClick={() => navigate(`/game/${game.id}/review?ply=${n.ply}`)}>
                  Show on the board →
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {r.minorNotes.length > 0 && (
        <section className="card subtle-card">
          <h3>Smaller notes</h3>
          <Items items={r.minorNotes} game={game} kind="mistake" size={160} shown={hurtShown} where="note" />
        </section>
      )}
      <div className="actions">
        {game.moments.length > 0 && (
          <button className="btn primary" onClick={() => navigate(`/game/${game.id}/review`)}>
            Replay the game{lessons ? ` (${lessons} short lesson${lessons > 1 ? 's' : ''})` : ''}
          </button>
        )}
        <button className="btn ghost" onClick={() => navigate(`/game/${game.id}/drills`)}>
          Drills
        </button>
      </div>
    </div>
  );
}

/** "You lost ▾" — the player can correct a missing or wrong PGN result. */
function OutcomeSelect({ game }: { game: StoredGame }) {
  const { refresh } = useApp();
  const current = userOutcome(game);
  return (
    <select
      className="outcome-select"
      aria-label="How the game ended for you"
      value={current ?? ''}
      onChange={async (e) => {
        await setOutcome(game.id, e.target.value as Outcome);
        await refresh();
      }}
    >
      {!current && <option value="">Result unknown</option>}
      {(['win', 'loss', 'draw'] as Outcome[]).map((o) => (
        <option key={o} value={o}>
          {OUTCOME_LABEL[o]}
        </option>
      ))}
    </select>
  );
}

export function GameScreen({ id, tab, ply, already }: { id: string; tab: 'summary' | 'review' | 'drills'; ply?: number; already?: boolean }) {
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
          <OutcomeSelect game={game} /> · you played {game.userColor === 'w' ? 'White' : 'Black'}
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
      {already && <div className="feedback neutral">You'd already imported this game, so here's the existing one (no duplicate added).</div>}
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
