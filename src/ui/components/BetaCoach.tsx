import { useEffect, useState } from 'react';
import type { StoredGame } from '../../domain/types';
import { betaReview } from '../actions';
import { navigate, useApp } from '../store';
import { betaGrounding } from '../../coach/betaCoach';
import { moveLabel } from '../../chess/pgn';
import { CoachText, HoverProvider } from './CoachText';
import { PositionDiagram } from './PositionDiagram';
import { useAiAvailable, useAiBlocker } from './AiExplain';

/** Whether the Beta AI Coach tab is offered (an AI is configured and the beta isn't switched off). */
export function useBetaCoachOn(): boolean {
  const { llm, settings } = useApp();
  return !!llm.provider && settings.useLlm && settings.betaCoach !== false;
}

/** Games whose automatic first review failed this session: don't retry on every visit. */
const failed = new Set<string>();

/**
 * The Beta AI Coach: the model's own reading of the whole game, with Stockfish as
 * evidence. Shown apart from the built-in coach so the two can be compared.
 */
export function BetaCoach({ game }: { game: StoredGame }) {
  const { refresh } = useApp();
  const available = useAiAvailable();
  const blocker = useAiBlocker();
  const r = game.aiCoach;
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  const run = async (force: boolean) => {
    setState('loading');
    try {
      await betaReview(game.id, { force });
      await refresh();
      setState('idle');
    } catch (e) {
      if (!force) failed.add(game.id);
      setError((e as Error).message);
      setState('error');
    }
  };
  // Written once per game; after that only on request.
  useEffect(() => {
    if (available && !r && state === 'idle' && !failed.has(game.id)) void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, r, game.id]);

  const open = (ply: number) => navigate(`/game/${game.id}/review?ply=${ply - 1}`);
  const label = (ply: number) => (game.plies[ply - 1] ? moveLabel(game.plies[ply - 1]) : `ply ${ply}`);
  const stale = r && r.grounding !== betaGrounding(game);

  return (
    <HoverProvider>
      <div className="summary beta-coach">
        <section className="card beta-intro">
          <span className="beta-badge">Beta</span> <strong>AI Coach</strong>
          <p className="muted small">
            An experiment: {r?.model ?? 'the AI'} forms its own view of the game, using Stockfish as evidence. Evaluations, best moves and tactics still come from
            Stockfish — any concrete claim the engine analysis doesn't back is removed. Compare it with the built-in coach on the Summary tab.
          </p>
          {!available && !r && <p className="muted small">{blocker ?? 'The AI coach is not available on this deployment.'}</p>}
          {state === 'loading' && <p className="muted small">The coach is reviewing the whole game… (this can take 20–40 seconds)</p>}
          {state === 'error' && <p className="feedback bad small">The AI review failed: {error}</p>}
          {available && state !== 'loading' && (
            <button className="btn ghost small" onClick={() => run(!!r)}>
              {r ? 'Regenerate' : 'Write the AI review'}
            </button>
          )}
          {stale && <p className="muted small">The engine analysis or result changed since this was written — regenerate to update it.</p>}
        </section>

        {r && (
          <>
            <section className="card">
              <h3>AI Game Summary</h3>
              {r.summary.map((p, i) => (
                <CoachText key={i} text={p} className="beta-para" />
              ))}
            </section>

            <section className="card">
              <h3>AI Insights</h3>
              <dl className="three-part">
                {r.insights.strengths.length > 0 && (
                  <div>
                    <dt className="good-h">Strengths shown</dt>
                    <dd>
                      <ul className="report-list">
                        {r.insights.strengths.map((s, i) => (
                          <li key={i}>
                            <CoachText text={s} />
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                )}
                {r.insights.weaknesses.length > 0 && (
                  <div>
                    <dt className="bad-h">Weaknesses and habits</dt>
                    <dd>
                      <ul className="report-list">
                        {r.insights.weaknesses.map((s, i) => (
                          <li key={i}>
                            <CoachText text={s} />
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                )}
                {r.insights.trend && (
                  <div>
                    <dt>Trend</dt>
                    <dd>
                      <CoachText text={r.insights.trend} />
                    </dd>
                  </div>
                )}
                {r.insights.observations.length > 0 && (
                  <div>
                    <dt>Beyond single moves</dt>
                    <dd>
                      <ul className="report-list">
                        {r.insights.observations.map((s, i) => (
                          <li key={i}>
                            <CoachText text={s} />
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                )}
              </dl>
            </section>

            {r.instructor.priority && (
              <section className="card focus-card">
                <span className="eyebrow">AI Instructor · your training priority</span>
                <h2>{r.instructor.priority}</h2>
                {r.instructor.whyItMatters && <CoachText text={r.instructor.whyItMatters} className="beta-para" />}
                {r.instructor.moments.length > 0 && (
                  <>
                    <h4>Where this game shows it</h4>
                    <ul className="report-list">
                      {r.instructor.moments.map((m, i) => (
                        <li key={i}>
                          <button className="link" onClick={() => open(m.ply)}>
                            {label(m.ply)}
                          </button>
                          <CoachText text={m.note} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {r.instructor.thinkDifferently && (
                  <>
                    <h4>Next game, think like this</h4>
                    <CoachText text={r.instructor.thinkDifferently} className="beta-para" />
                  </>
                )}
                {r.instructor.practice.length > 0 && (
                  <>
                    <h4>Positions worth practising</h4>
                    <div className="diagram-row">
                      {r.instructor.practice.map((p) => {
                        const before = game.plies[p.ply - 1];
                        // The position to solve: no arrows, no answer in the caption.
                        const spec = before && { ply: p.ply, fen: before.fenBefore, arrows: [], title: `${game.userColor === 'w' ? 'White' : 'Black'} to move` };
                        return (
                          <div key={p.ply} className="beta-practice">
                            {spec && <PositionDiagram spec={spec} orientation={game.userColor} size={180} onOpen={() => open(p.ply)} />}
                            <p className="small">
                              <button className="link" onClick={() => open(p.ply)}>
                                Before {label(p.ply)}
                              </button>
                              : <CoachText text={p.why} />
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>
            )}

            <p className="muted small">
              Written {new Date(r.createdAt).toLocaleString()}
              {r.model ? ` by ${r.model}` : ''}.{' '}
              {r.removed.length === 0 ? 'Every concrete claim matched Stockfish’s analysis.' : `${r.removed.length} statement${r.removed.length > 1 ? 's' : ''} removed because Stockfish’s analysis didn’t back ${r.removed.length > 1 ? 'them' : 'it'}.`}
            </p>
            {r.removed.length > 0 && (
              <details className="small muted">
                <summary>Show removed statements</summary>
                <ul>
                  {r.removed.map((x, i) => (
                    <li key={i}>
                      “{x.text}” — {x.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </HoverProvider>
  );
}
