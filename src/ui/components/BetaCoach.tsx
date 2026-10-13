import { useEffect, useMemo, useState } from 'react';
import type { Arrow, BetaChapter, BetaCoachReview, StoredGame } from '../../domain/types';
import { betaReview } from '../actions';
import { navigate, useApp, useRoute } from '../store';
import { AiWalkthroughView } from './AiWalkthroughView';
import type { TokenUsage } from '../../domain/types';
import { betaGrounding, betaPositions, buildBetaContext, currentReview, fmtEval } from '../../coach/betaCoach';
import { buildMoveEvals } from '../../analysis/analyzeGame';
import { positionCp } from '../../analysis/evaluation';
import { sideToMove } from '../../chess/board';
import { moveLabel } from '../../chess/pgn';
import { CoachText, HoverProvider } from './CoachText';
import { PositionDiagram, type DiagramSpec } from './PositionDiagram';
import { useAiAvailable, useAiBlocker } from './AiExplain';

/** Whether the Beta AI Coach tab is offered (an AI is configured and the beta isn't switched off). */
export function useBetaCoachOn(): boolean {
  const { llm, settings } = useApp();
  return !!llm.provider && settings.useLlm && settings.betaCoach !== false;
}

/** Games whose automatic first review failed this session: don't retry on every visit. */
const failed = new Set<string>();

const ASSESSMENT: Record<BetaChapter['assessment'], { text: string; tone: string } | undefined> = {
  well: { text: 'You played this well', tone: 'good' },
  mixed: { text: 'Mixed', tone: 'mixed' },
  poorly: { text: 'Where it went wrong', tone: 'bad' },
  neutral: undefined,
};

/** Engine facts for the diagrams (same positions the review was built on). */
function useEngineView(game: StoredGame) {
  return useMemo(() => {
    const positions = betaPositions(game);
    if (positions.length !== game.plies.length + 1) return undefined;
    const moves = buildMoveEvals(game.plies, positions);
    const cp = positions.map((p) => (sideToMove(p.fen) === game.userColor ? positionCp(p) : -positionCp(p)));
    return { moves, cp };
  }, [game]);
}

export function BetaCoach({ game }: { game: StoredGame }) {
  const { refresh, games, settings } = useApp();
  const available = useAiAvailable();
  const blocker = useAiBlocker();
  const r = currentReview(game);
  const old = !r && !!game.aiCoach;
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [showContext, setShowContext] = useState(false);
  const view = useEngineView(game);
  const { query } = useRoute();
  const mode = query.get('view') === 'walk' ? 'walk' : 'story';

  const run = async (force: boolean) => {
    setState('loading');
    setStage('Starting…');
    try {
      await betaReview(game.id, { force, onProgress: setStage });
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

  const label = (ply: number) => (game.plies[ply - 1] ? moveLabel(game.plies[ply - 1]) : `ply ${ply}`);
  const explore = (ply: number) => navigate(`/game/${game.id}/review?ply=${ply}&explore=1`);
  const browse = (ply: number) => navigate(`/game/${game.id}/review?ply=${Math.max(0, ply - 1)}`);

  /** The position before the move at `ply`, with the move played and Stockfish's choice, captioned from engine data only. */
  const diagram = (ply: number, reveal: boolean): DiagramSpec | undefined => {
    const p = game.plies[ply - 1];
    if (!p) return undefined;
    const e = view?.moves[ply - 1];
    const arrows: Arrow[] = [];
    let caption: string | undefined;
    if (reveal) {
      arrows.push({ from: p.from, to: p.to, color: 'played' });
      if (e?.bestUci && e.bestUci !== p.uci) arrows.push({ from: e.bestUci.slice(0, 2), to: e.bestUci.slice(2, 4), color: 'best' });
      if (view) {
        caption = `Stockfish: ${fmtEval(view.cp[ply - 1])} before, ${fmtEval(view.cp[ply])} after ${p.san} (for you)${e?.bestSan && e.bestUci !== p.uci ? `. Its choice: ${e.bestSan}` : ''}.`;
      }
    }
    return { ply, fen: p.fenBefore, arrows, title: `Before ${label(ply)}`, caption };
  };

  const stale = r && r.grounding !== betaGrounding(game);
  const context = useMemo(() => (showContext ? buildBetaContext(game, games, settings.rating)?.facts : undefined), [showContext, game, games, settings.rating]);

  return (
    <HoverProvider>
      <div className="summary beta-coach">
        <section className="card beta-intro">
          <span className="beta-badge">Beta</span> <strong>AI Coach</strong>
          <p className="muted small">
            An experiment: {r?.model ?? 'the AI'} reads the whole game with Stockfish's evaluation of every move and decides for itself what the story and turning points
            were. Stockfish is the referee — a concrete claim that contradicts its analysis is removed. Compare with the built-in coach on the Summary tab.
          </p>
          {!available && !r && <p className="muted small">{blocker ?? 'The AI coach is not available on this deployment.'}</p>}
          {old && state !== 'loading' && <p className="muted small">The review saved for this game is from the earlier format.</p>}
          {state === 'loading' && <p className="muted small">{stage}</p>}
          {state === 'error' && <p className="feedback bad small">The AI review failed: {error}</p>}
          {available && state !== 'loading' && (
            <button className="btn ghost small" onClick={() => run(!!r || old)}>
              {r ? 'Regenerate' : 'Write the AI review'}
            </button>
          )}
          {stale && <p className="muted small">The engine analysis or result changed since this was written — regenerate to update it.</p>}
        </section>

        <nav className="seg beta-modes" aria-label="AI Coach view">
          <button className={`seg-btn ${mode === 'story' ? 'on' : ''}`} onClick={() => navigate(`/game/${game.id}/ai`)}>
            Game story
          </button>
          <button className={`seg-btn ${mode === 'walk' ? 'on' : ''}`} onClick={() => navigate(`/game/${game.id}/ai?view=walk`)}>
            Guided walkthrough
          </button>
        </nav>

        {mode === 'walk' ? (
          <AiWalkthroughView game={game} plan={r} />
        ) : (
          r && <Review r={r} game={game} label={label} diagram={diagram} explore={explore} browse={browse} />
        )}
        {(r?.usage || game.aiWalkthrough?.usage) && (
          <p className="muted small">
            Gemini usage for this game: {r?.usage && <>lesson plan {usageText(r.usage)}</>}
            {r?.usage && game.aiWalkthrough?.usage && '; '}
            {game.aiWalkthrough?.usage && <>walkthrough {usageText(game.aiWalkthrough.usage)}</>}. Replaying uses none.
          </p>
        )}

        <details className="small muted beta-context" open={showContext} onToggle={(e) => setShowContext((e.target as HTMLDetailsElement).open)}>
          <summary>Show the Stockfish evidence the AI is given</summary>
          {context && <pre>{JSON.stringify(context, null, 1)}</pre>}
        </details>
      </div>
    </HoverProvider>
  );
}

const usageText = (u: TokenUsage) =>
  `${u.input.toLocaleString()} in / ${u.output.toLocaleString()} out${u.thinking ? ` (+${u.thinking.toLocaleString()} thinking)` : ''} tokens`;

function Review({
  r,
  game,
  label,
  diagram,
  explore,
  browse,
}: {
  r: BetaCoachReview;
  game: StoredGame;
  label: (ply: number) => string;
  diagram: (ply: number, reveal: boolean) => DiagramSpec | undefined;
  explore: (ply: number) => void;
  browse: (ply: number) => void;
}) {
  return (
    <>
      {r.story && (
        <section className="card headline-card">
          <span className="eyebrow">The game story</span>
          <CoachText text={r.story} className="beta-para story-text" />
        </section>
      )}

      {r.chapters.map((c, i) => {
        const a = ASSESSMENT[c.assessment];
        const spec = c.diagram ? diagram(c.anchorPly, true) : undefined;
        return (
          <section key={i} className={`card beta-chapter ${a?.tone ?? ''}`}>
            <div className="beta-chapter-head">
              <h3>{c.title}</h3>
              <span className="muted small">
                {label(c.fromPly)}
                {c.toPly !== c.fromPly ? ` – ${label(c.toPly)}` : ''}
              </span>
              {a && <span className={`beta-pill ${a.tone}`}>{a.text}</span>}
            </div>
            <div className={`beta-chapter-body ${spec ? 'with-diagram' : ''}`}>
              {spec && (
                <div className="beta-diagram">
                  <PositionDiagram spec={spec} orientation={game.userColor} size={240} onOpen={() => explore(c.anchorPly)} />
                </div>
              )}
              <div className="beta-chapter-text">
                {c.decisionPly && c.consequencePly && c.decisionPly !== c.consequencePly && (
                  <p className="beta-cause small">
                    <span>
                      Decision:{' '}
                      <button className="link" onClick={() => explore(c.decisionPly!)}>
                        {label(c.decisionPly)}
                      </button>
                    </span>
                    <span aria-hidden="true">→</span>
                    <span>
                      Consequence:{' '}
                      <button className="link" onClick={() => browse(c.consequencePly!)}>
                        {label(c.consequencePly)}
                      </button>
                    </span>
                  </p>
                )}
                <CoachText text={c.narrative} className="beta-para" />
                {c.lesson && (
                  <p className="beta-lesson">
                    <strong>Lesson: </strong>
                    <CoachText text={c.lesson} />
                  </p>
                )}
                {c.evidence.length > 0 && (
                  <ul className="beta-evidence small muted">
                    {c.evidence.map((x, j) => (
                      <li key={j}>
                        <CoachText text={x} />
                      </li>
                    ))}
                  </ul>
                )}
                {c.explore && (
                  <button className="btn ghost small" onClick={() => explore(c.anchorPly)}>
                    Explore this decision →
                  </button>
                )}
              </div>
            </div>
          </section>
        );
      })}

      {r.lessons.length > 0 && (
        <section className="card focus-card">
          <span className="eyebrow">What this game teaches you</span>
          {r.lessons.map((l, i) => (
            <CoachText key={i} text={l} className="beta-para" />
          ))}
        </section>
      )}

      {r.practice.length > 0 && (
        <section className="card">
          <h3>Practise these positions</h3>
          <div className="diagram-row">
            {r.practice.map((p) => {
              const spec = diagram(p.ply, false);
              return (
                <div key={p.ply} className="beta-practice">
                  {spec && <PositionDiagram spec={{ ...spec, title: `${game.userColor === 'w' ? 'White' : 'Black'} to move` }} orientation={game.userColor} size={190} onOpen={() => explore(p.ply)} />}
                  <CoachText text={p.why} className="small" />
                </div>
              );
            })}
          </div>
          <p className="muted small">Tap a board to try your own move there and compare it with Stockfish.</p>
        </section>
      )}

      <p className="muted small">
        Written {new Date(r.createdAt).toLocaleString()}
        {r.model ? ` by ${r.model}` : ''}.{' '}
        {r.removed.length === 0
          ? 'Every concrete claim agreed with Stockfish’s analysis.'
          : `${r.removed.length} statement${r.removed.length > 1 ? 's were' : ' was'} removed because Stockfish’s analysis contradicted or didn’t back ${r.removed.length > 1 ? 'them' : 'it'}.`}
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
  );
}
