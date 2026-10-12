import { useEffect, useState } from 'react';
import type { AiExplanation, StoredGame } from '../../domain/types';
import { aiReady, explainPosition } from '../actions';
import { useApp } from '../store';
import { CoachText } from './CoachText';

/** Whether the AI instructor can be used right now (configured, switched on, unlocked). */
export function useAiAvailable(): boolean {
  const { llm, settings } = useApp();
  return !!llm.provider && settings.useLlm && (!llm.requiresToken || !!settings.coachToken);
}

/** Positions whose automatic explanation failed this session: don't keep retrying on every visit. */
const failedAuto = new Set<string>();

function Sections({ e, bestSan, oppName }: { e: AiExplanation; bestSan?: string; oppName: string }) {
  const rows: [string, string][] = [
    ['What you were going for', e.tryingTo],
    ['What you missed', e.missed],
    [bestSan ? `Why ${bestSan} is better` : 'Why the better move is better', e.whyBetter],
    [`${oppName}'s best reply`, e.opponentReply],
    ['How the positions differ', e.difference],
    ['Carry this forward', e.takeaway],
    ['Pattern in your games', e.pattern],
  ];
  return (
    <dl className="three-part ai-sections">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              <CoachText text={v} />
            </dd>
          </div>
        ))}
    </dl>
  );
}

/**
 * The AI instructor's explanation of one move: shown from the cache if there is one,
 * otherwise generated on request ("Explain this more deeply"). Grounded in the stored
 * Stockfish analysis; falls back quietly to the built-in coaching when unavailable.
 */
export function AiExplain({
  game,
  ply,
  bestSan,
  auto = false,
  compact = false,
}: {
  game: StoredGame;
  ply: number;
  bestSan?: string;
  /** Generate without a click (used for the game's 1–2 lessons). */
  auto?: boolean;
  compact?: boolean;
}) {
  const { refresh } = useApp();
  const available = useAiAvailable();
  const cached = game.aiExplanations?.[ply];
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  const oppName = game.plies[ply - 1]?.color === 'w' ? 'Black' : 'White';

  const key = `${game.id}:${ply}`;
  const run = async (force = false, automatic = false) => {
    setState('loading');
    try {
      if (!(await aiReady())) throw new Error('The AI coach is not available.');
      await explainPosition(game.id, ply, { force });
      await refresh();
      setState('idle');
    } catch (e) {
      if (automatic) failedAuto.add(key);
      setError((e as Error).message);
      setState('error');
    }
  };
  useEffect(() => {
    if (auto && available && !cached && state === 'idle' && !failedAuto.has(key)) void run(false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, available, cached, ply]);

  if (!available && !cached) return null;
  return (
    <div className={`ai-box ${compact ? 'compact' : ''}`}>
      {cached ? (
        <>
          <span className="eyebrow">Coach's explanation · AI, grounded in Stockfish</span>
          {cached.confidence === 'small_difference' && <p className="muted small">The engine sees only a small difference here.</p>}
          <Sections e={cached} bestSan={bestSan} oppName={oppName} />
          {available && (
            <button className="link small" disabled={state === 'loading'} onClick={() => run(true)}>
              {state === 'loading' ? 'Regenerating…' : 'Regenerate'}
            </button>
          )}
        </>
      ) : state === 'loading' ? (
        <p className="muted small">The coach is writing an explanation…</p>
      ) : (
        <button className="btn ghost small" onClick={() => run()}>
          Explain this more deeply
        </button>
      )}
      {state === 'error' && <p className="muted small">AI explanation unavailable ({error}). The built-in explanation above still applies.</p>}
    </div>
  );
}
