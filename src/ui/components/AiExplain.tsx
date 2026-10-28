import { useEffect, useState } from 'react';
import type { AiExplanation, StoredGame } from '../../domain/types';
import { aiReady, explainPosition } from '../actions';
import { useApp } from '../store';
import { CoachText } from './CoachText';
import { EXPLAIN_VERSION } from '../../coach/momentContext';
import { PATTERN_LABEL, PATTERN_RULE, PATTERN_RULE_MISSED, type PatternTag } from '../../analysis/patterns';

/** The pattern behind a move as a tag plus its one-line rule. */
export function PatternChip({ tag, side }: { tag: PatternTag; side?: 'refutation' | 'better' }) {
  return (
    <p className="pattern-line small">
      <span className="pattern-tag">{PATTERN_LABEL[tag]}</span> {(side === 'better' && PATTERN_RULE_MISSED[tag]) || PATTERN_RULE[tag]}
    </p>
  );
}

/** Whether the AI instructor can be used right now (configured, switched on, unlocked). */
/** Configured on the server, but not usable yet — and why, in words the user can act on. */
export function useAiBlocker(): string | null {
  const { llm, settings } = useApp();
  if (!llm.provider) return null;
  if (!settings.useLlm) return null; // switched off on purpose: stay quiet
  if (llm.requiresToken && !settings.coachToken) return 'To get AI explanations here, enter your access code in Settings (gear icon on Home).';
  return null;
}

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
 * otherwise generated on request ("Why?"). Grounded in the stored
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
  const blocker = useAiBlocker();
  // Explanations written before the current rules (concrete reasons, engine facts) are redone on request.
  const stored = game.aiExplanations?.[ply];
  const cached = stored?.grounding?.endsWith(`|${EXPLAIN_VERSION}`) ? stored : undefined;
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

  if (!available && !cached) {
    return blocker ? <p className={`ai-box muted small ${compact ? 'compact' : ''}`}>{blocker}</p> : null;
  }
  return (
    <div className={`ai-box ${compact ? 'compact' : ''}`}>
      {cached ? (
        <>
          <span className="eyebrow">Why? · {cached.model === 'none' ? 'from Stockfish' : 'AI, grounded in Stockfish'}</span>
          <CoachText text={cached.headline || cached.whyBetter} className="why-headline" />
          {cached.patternTag && <PatternChip tag={cached.patternTag} side={cached.patternSide} />}
          {cached.model !== 'none' && (
            <details className="why-more">
              <summary className="small">More</summary>
              <Sections e={cached} bestSan={bestSan} oppName={oppName} />
            </details>
          )}
          {available && cached.model !== 'none' && (
            <button className="link small" disabled={state === 'loading'} onClick={() => run(true)}>
              {state === 'loading' ? 'Regenerating…' : 'Regenerate'}
            </button>
          )}
        </>
      ) : state === 'loading' ? (
        <p className="muted small">The coach is writing an explanation…</p>
      ) : (
        <button className="btn ghost small why-btn" onClick={() => run()}>
          Why?
        </button>
      )}
      {state === 'error' && <p className="muted small">AI explanation unavailable ({error}). The built-in explanation above still applies.</p>}
    </div>
  );
}
