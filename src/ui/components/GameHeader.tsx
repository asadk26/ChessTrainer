// The one header every game tab shares (Summary, Guided review, Drills, AI Coach): the same
// title, the same single detail line and the same tab selector in the same place, so switching
// tabs never moves anything.
import { useState } from 'react';
import type { StoredGame } from '../../domain/types';
import { OUTCOME_LABEL, userOutcome, type Outcome } from '../../chess/outcome';
import { shortDate } from '../../analysis/gameList';
import { reviewAgain, setOutcome } from '../actions';
import { copyText } from '../clipboard';
import { navigate, useApp } from '../store';
import { Icon } from './AppShell';

export type GameTab = 'summary' | 'review' | 'drills' | 'ai';
const LABEL: Record<GameTab, string> = { summary: 'Summary', review: 'Guided review', drills: 'Drills', ai: 'AI Coach' };

export function GameHeader({ game, tab, showTabs, betaOn, llmState }: { game: StoredGame; tab: GameTab; showTabs: boolean; betaOn: boolean; llmState: 'idle' | 'working' | 'error' }) {
  const tabs: GameTab[] = ['summary', 'review', 'drills', ...(betaOn ? (['ai'] as const) : [])];
  const status =
    llmState === 'working' ? 'AI coach is writing…' : llmState === 'error' ? 'AI coach unavailable — built-in coaching' : game.report?.voice === 'llm' ? 'Coach: AI' : undefined;
  return (
    <header className="game-header">
      <div className="title-row">
        <button className="icon-btn plain" aria-label="Back to games" onClick={() => navigate('/games')}>
          <Icon name="back" />
        </button>
        <h1>
          {game.headers.white} <span className="muted">vs</span> {game.headers.black}
        </h1>
      </div>
      <p className="game-meta muted small">
        <OutcomeSelect game={game} />
        <span>{game.userColor === 'w' ? 'White' : 'Black'}</span>
        <span>{shortDate(game)}</span>
        <CopyPgn pgn={game.pgn} />
        {game.reviewedAt && <ReviewAgain game={game} />}
        {status && <span>{status}</span>}
      </p>
      {showTabs && (
        <nav className="tabs" aria-label="Game views">
          {tabs.map((t) => (
            <button key={t} className={`tab ${tab === t ? 'on' : ''}`} aria-current={tab === t ? 'page' : undefined} onClick={() => navigate(t === 'summary' ? `/game/${game.id}` : `/game/${game.id}/${t}`)}>
              {LABEL[t]}
              {t === 'ai' && <span className="beta-badge">Beta</span>}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}

/** Reviewed: say so, and offer to put the game back into "Most to learn". */
function ReviewAgain({ game }: { game: StoredGame }) {
  const { refresh } = useApp();
  return (
    <span>
      Reviewed ✓{' '}
      <button className="link small" onClick={() => void reviewAgain(game.id).then(() => (refresh(), navigate(`/game/${game.id}/review`)))}>
        Review again
      </button>
    </span>
  );
}

function CopyPgn({ pgn }: { pgn: string }) {
  const [done, setDone] = useState<'' | 'ok' | 'fail'>('');
  return (
    <button
      className="link small"
      onClick={async () => {
        setDone((await copyText(pgn.trim() + '\n')) ? 'ok' : 'fail');
        window.setTimeout(() => setDone(''), 2000);
      }}
    >
      {done === 'ok' ? 'Copied ✓' : done === 'fail' ? 'Copy failed' : 'Copy PGN'}
    </button>
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
