import { useSyncExternalStore } from 'react';
import { analysisQueue, pendingAnalysis, runAnalysisQueue } from '../actions';
import { useApp } from '../store';

/** Imported games waiting for Stockfish, analysed only when you ask — oldest first, stoppable. */
export function AnalysisQueue() {
  const { games, refresh } = useApp();
  const q = useSyncExternalStore(analysisQueue.subscribe, analysisQueue.get);
  const pending = pendingAnalysis(games).length;
  if (!pending && !q.running) return null;
  const run = (limit?: number) => void runAnalysisQueue(limit, () => void refresh()).then(() => refresh());
  return (
    <section className="card analysis-queue">
      <div className="row-between">
        <span>
          <b>{q.running ? `Analysing ${Math.min(q.done + 1, q.total)} of ${q.total}` : `${pending} game${pending === 1 ? '' : 's'} waiting for analysis`}</b>
          {q.running && q.current && <span className="muted small"> · {q.current}</span>}
        </span>
        {q.running ? (
          <button className="btn small" disabled={q.stopping} onClick={analysisQueue.stop}>
            {q.stopping ? 'Stopping after this game…' : 'Stop'}
          </button>
        ) : (
          <span className="actions left inline">
            {pending > 5 && (
              <button className="btn small" onClick={() => run(5)}>
                Analyse next 5
              </button>
            )}
            <button className="btn primary small" onClick={() => run()}>
              Analyse {pending > 5 ? `all ${pending}` : pending === 1 ? 'it' : 'them'}
            </button>
          </span>
        )}
      </div>
      <p className="muted small">
        {q.running
          ? `About a minute or two per game on a phone. Each game is saved as soon as it's done; stopping keeps everything finished so far${q.failed ? ` (${q.failed} failed — open them to retry)` : ''}.`
          : 'Oldest first, so each game’s coaching sees the ones before it. Export works without analysis; coaching, drills and the Adaptive Coach use analysed games.'}
      </p>
    </section>
  );
}
