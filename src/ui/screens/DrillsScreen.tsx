import { useEffect, useMemo, useState } from 'react';
import type { Arrow, Drill, StoredGame } from '../../domain/types';
import { FlagButton } from '../components/FlagButton';
import { Board } from '../components/Board';
import { CoachText, HoverProvider } from '../components/CoachText';
import { navigate, useApp } from '../store';
import { repo } from '../../storage/repo';
import { categoryLabel } from '../../domain/categories';
import { PATTERN_LABEL } from '../../analysis/patterns';
import { playLine, sideToMove } from '../../chess/board';
import { closeToBest, evaluateMove, recoach } from '../actions';
import { REPORT_VERSION } from '../../coach/report';
import { ScreenHeader } from '../components/AppShell';

const TYPE_LABEL: Record<Drill['type'], string> = {
  find_better: 'Find the better move',
  predict_response: 'Spot the danger',
  identify_problem: 'Identify the problem',
  choose_plan: 'Choose the plan',
};

function DrillRunner({ drill, onNext, hasNext, game }: { drill: Drill; onNext: () => void; hasNext: boolean; game?: StoredGame }) {
  const { refresh } = useApp();
  const [answer, setAnswer] = useState<{ correct: boolean; uci?: string; san?: string; fen?: string; option?: number; checking?: boolean } | null>(null);

  const record = async (correct: boolean) => {
    await repo.addAttempt({ drillId: drill.id, at: Date.now(), correct });
    await refresh();
  };

  const onMove = (uci: string, san: string, fen: string) => {
    if (answer && !answer.checking && answer.correct) return false;
    if (drill.acceptableUcis?.includes(uci)) {
      setAnswer({ correct: true, uci, san, fen });
      void record(true);
      return true;
    }
    if (drill.type === 'find_better' && drill.solutionUci) {
      // Not in the stored list: let the engine judge it against the solution.
      setAnswer({ correct: false, uci, san, fen, checking: true });
      const solFen = playLine(drill.fen, [drill.solutionUci])[0]?.fen;
      void Promise.all([evaluateMove(fen), solFen ? evaluateMove(solFen) : undefined]).then(([mine, best]) => {
        const ok = !!mine && !!best && closeToBest(mine, best);
        setAnswer({ correct: ok, uci, san, fen });
        void record(ok);
      });
      return true;
    }
    setAnswer({ correct: false, uci, san, fen });
    void record(false);
    return true;
  };

  const isMoveDrill = drill.type === 'find_better' || drill.type === 'predict_response';
  const arrows: Arrow[] = [];
  if (drill.questionArrow && !answer) arrows.push(drill.questionArrow);
  if (answer?.uci) arrows.push({ from: answer.uci.slice(0, 2), to: answer.uci.slice(2, 4), color: 'guess' });
  if (answer && !answer.checking && !answer.correct && drill.solutionUci)
    arrows.push({ from: drill.solutionUci.slice(0, 2), to: drill.solutionUci.slice(2, 4), color: 'best' });
  const showFen = answer?.correct && answer.fen ? answer.fen : drill.fen;
  const done = answer && !answer.checking;

  return (
    <div className="review">
      <div className="review-board">
        <Board
          fen={showFen}
          orientation={drill.orientation}
          arrows={arrows}
          movable={isMoveDrill && (!answer || (!answer.correct && !answer.checking)) ? sideToMove(drill.fen) : undefined}
          onMove={onMove}
        />
      </div>
      <div className="review-panel card">
        <div className="moment-head">
          <span className="tag">{TYPE_LABEL[drill.type]}</span>
          {/* What it's about only after answering: before, it would give the answer away. */}
          {done && <span className="muted small">{drill.tactic ? PATTERN_LABEL[drill.tactic] : categoryLabel(drill.category)}</span>}
        </div>
        <CoachText text={drill.prompt} className="prompt" />
        {drill.options && (
          <div className="options">
            {drill.options.map((o, i) => (
              <button
                key={i}
                disabled={!!answer}
                className={`option ${answer ? (i === drill.correctIndex ? 'right' : i === answer.option ? 'wrong' : '') : ''}`}
                onClick={() => {
                  const correct = i === drill.correctIndex;
                  setAnswer({ correct, option: i });
                  void record(correct);
                }}
              >
                {o}
              </button>
            ))}
          </div>
        )}
        {answer?.checking && <div className="feedback neutral">Checking {answer.san}…</div>}
        {done && (
          <div className={`feedback ${answer.correct ? 'good' : 'bad'}`}>
            <CoachText
              text={
                (answer.correct
                  ? `Correct${answer.san ? ` — ${answer.san}` : ''}. `
                  : `Not quite${answer.san ? ` — ${answer.san}` : ''}.${drill.solutionSan ? ` The answer was ${drill.solutionSan}.` : ''} `) + drill.explanation
              }
            />
          </div>
        )}
        {done && game && <FlagButton game={game} where="drill" ply={drill.ply} quote={`${drill.prompt} | ${drill.explanation}`} />}
        <div className="actions">
          {done && !answer.correct && isMoveDrill && (
            <button className="btn ghost" onClick={() => setAnswer(null)}>
              Try again
            </button>
          )}
          {(done || answer?.correct) && (
            <button className="btn primary" onClick={onNext}>
              {hasNext ? 'Next drill' : 'Done'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DrillList({ gameId }: { gameId?: string }) {
  const { drills, attempts, games } = useApp();
  const solved = useMemo(() => new Set(attempts.filter((a) => a.correct).map((a) => a.drillId)), [attempts]);
  const list = useMemo(() => {
    // Multiple-choice drills from older versions are retired (too many overlapping answers);
    // their games get board drills when they're re-coached.
    const ds = drills.filter((d) => (!gameId || d.gameId === gameId) && (d.type === 'find_better' || d.type === 'predict_response'));
    if (gameId) return ds;
    // Unsolved first, then oldest attempts — light spaced repetition.
    return [...ds].sort((a, b) => Number(solved.has(a.id)) - Number(solved.has(b.id)) || b.createdAt - a.createdAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drills.map((d) => d.id + d.type).join('|'), gameId]);
  const [idx, setIdx] = useState(0);
  const [finished, setFinished] = useState(false);

  if (list.length === 0) return <p className="muted narrow">No drills yet — analyze a game first.</p>;
  if (finished) {
    const n = list.filter((d) => solved.has(d.id)).length;
    return (
      <div className="narrow card">
        <h2>Drills done</h2>
        <p>
          You've solved {n} of {list.length}. Come back to the ones you missed before your next game.
        </p>
        <div className="actions left">
          <button className="btn ghost" onClick={() => (setIdx(0), setFinished(false))}>
            Go again
          </button>
          <button className="btn primary" onClick={() => navigate('/')}>
            Back to Home
          </button>
        </div>
      </div>
    );
  }
  const drill = list[Math.min(idx, list.length - 1)];
  const game = games.find((g) => g.id === drill.gameId);
  return (
    <div>
      <div className="drill-progress muted small">
        Drill {idx + 1} of {list.length}
        {!gameId && game ? ` · from your game vs ${game.opponentName}` : ''}
        {solved.has(drill.id) ? ' · solved before' : ''}
      </div>
      <DrillRunner
        key={drill.id}
        drill={drill}
        game={game}
        hasNext={idx < list.length - 1}
        onNext={() => (idx < list.length - 1 ? setIdx(idx + 1) : setFinished(true))}
      />
    </div>
  );
}

export function DrillsScreen() {
  const { games, refresh } = useApp();
  const [updating, setUpdating] = useState(false);
  // Games coached by an older version get today's drills (board drills, current wording) first.
  useEffect(() => {
    const stale = games.filter((g) => g.status === 'analyzed' && g.report && g.report.voice === 'template' && (g.report.version ?? 1) < REPORT_VERSION);
    if (!stale.length) return;
    setUpdating(true);
    void (async () => {
      for (const g of stale) await recoach(g.id);
      await refresh();
      setUpdating(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <HoverProvider>
      <ScreenHeader title="Drills" />
      <p className="muted">Positions from your own games: spot the danger, or find the better move.</p>
      {updating ? <p className="muted">Updating drills from your latest coaching…</p> : <DrillList />}
    </HoverProvider>
  );
}
