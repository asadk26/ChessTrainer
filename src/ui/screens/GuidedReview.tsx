import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Arrow, StoredGame, TeachingMoment } from '../../domain/types';
import { Board, type BoardProps } from '../components/Board';
import { CoachText, HoverProvider } from '../components/CoachText';
import { MoveList } from '../components/MoveList';
import { categoryLabel } from '../../domain/categories';
import { moveLabel } from '../../chess/pgn';
import { COLOR_NAME, other, playLine } from '../../chess/board';
import { formatCp } from '../../analysis/evaluation';
import { closeToBest, evaluateMove, markMomentDone } from '../actions';
import { ENGINE_REPLY_CATEGORIES } from '../../analysis/moments';
import { navigate } from '../store';

const uciArrow = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });

type BetterVerdict = 'correct' | 'ok' | 'wrong' | 'same' | 'checking' | 'shown';

function useMomentRunner(game: StoredGame, m: TeachingMoment, onNext: () => void, isLast: boolean) {
  const [stepIdx, setStepIdx] = useState(0);
  const [guess, setGuess] = useState<{ uci: string; san: string; fen: string; ok: boolean; shown?: boolean } | null>(null);
  const [better, setBetter] = useState<{ uci: string; san: string; fen: string; verdict: BetterVerdict; note?: string } | null>(null);
  const [frame, setFrame] = useState(0);
  const [betterFrame, setBetterFrame] = useState(-1);
  const [choice, setChoice] = useState<number | null>(null);
  const [showEngine, setShowEngine] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const step = m.steps[stepIdx];
  const mover = m.moverColor;
  const opp = other(mover);
  const engineReplyFirst = ENGINE_REPLY_CATEGORIES.includes(m.category);
  const expectedReply = engineReplyFirst ? m.acceptableReplyUcis[0] : m.opponentReplyUci ?? m.acceptableReplyUcis[0];
  const expectedReplySan = expectedReply ? playLine(m.fenAfter, [expectedReply])[0]?.san : undefined;
  const betterPlayed = game.plies[m.betterPly - 1];

  // Reset when the moment changes.
  useEffect(() => {
    setStepIdx(0);
    setGuess(null);
    setBetter(null);
    setFrame(0);
    setBetterFrame(-1);
    setChoice(null);
    setShowEngine(false);
  }, [m.id]);

  // Auto-play the sequence when entering the reveal step.
  const play = (len: number, set: (n: number) => void, start = 0) => {
    window.clearInterval(timer.current);
    let i = start;
    set(i);
    timer.current = window.setInterval(() => {
      i += 1;
      if (i >= len) return window.clearInterval(timer.current);
      set(i);
    }, 1100);
  };
  useEffect(() => {
    if (step === 'reveal' && m.sequence.length) play(m.sequence.length, setFrame);
    return () => window.clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, m.id]);

  const next = () => {
    window.clearInterval(timer.current);
    if (stepIdx < m.steps.length - 1) setStepIdx(stepIdx + 1);
    else {
      void markMomentDone(game.id, m.id);
      onNext();
    }
  };

  const onPredict = (uci: string, san: string, fen: string) => {
    if (guess) return false;
    setGuess({ uci, san, fen, ok: m.acceptableReplyUcis.includes(uci) });
    return true;
  };

  const onBetter = (uci: string, san: string, fen: string) => {
    if (better && better.verdict !== 'wrong' && better.verdict !== 'same') return false;
    setBetterFrame(-1);
    if (uci === betterPlayed?.uci) {
      setBetter({ uci, san, fen, verdict: 'same' });
      return true;
    }
    if (uci === m.bestUci || m.acceptableUcis.includes(uci)) {
      setBetter({ uci, san, fen, verdict: 'correct' });
      return true;
    }
    setBetter({ uci, san, fen, verdict: 'checking' });
    void evaluateMove(fen).then((res) => {
      const { betterBestWin: bestW, betterPlayedWin: playedW, betterBestCp } = m.numbers;
      let verdict: BetterVerdict = 'wrong';
      let note: string | undefined;
      if (!res) note = "The engine isn't available to check this move.";
      else if (closeToBest(res, { win: bestW, cp: betterBestCp ?? -10000 })) verdict = 'correct';
      else if (res.win >= playedW + 8) verdict = 'ok';
      setBetter({ uci, san, fen, verdict, note });
    });
    return true;
  };

  // ------------------------------------------------------------ board
  let board: BoardProps = { fen: m.fenBefore, orientation: mover };
  const playedArrow = uciArrow(m.playedUci, 'played');
  switch (step) {
    case 'intro':
      board = { fen: m.fenBefore, orientation: mover, arrows: m.introMarkup.arrows, highlights: m.introMarkup.highlights };
      break;
    case 'predict': {
      if (!guess) {
        board = { fen: m.fenAfter, orientation: mover, arrows: [playedArrow], highlights: m.introMarkup.highlights, movable: opp, onMove: onPredict };
      } else {
        const arrows: Arrow[] = [uciArrow(guess.uci, 'guess')];
        if (expectedReply && expectedReply !== guess.uci) arrows.push(uciArrow(expectedReply, 'reply'));
        const arrowsShown: Arrow[] = guess.shown ? [uciArrow(guess.uci, 'reply')] : arrows;
        board = { fen: guess.ok ? guess.fen : m.fenAfter, orientation: mover, arrows: arrowsShown, lastMove: guess.ok ? { from: guess.uci.slice(0, 2), to: guess.uci.slice(2, 4) } : undefined };
      }
      break;
    }
    case 'reveal': {
      const f = m.sequence[Math.min(frame, m.sequence.length - 1)];
      if (f) {
        const byMe = (Math.min(frame, m.sequence.length - 1) % 2 === 0) === true;
        board = { fen: f.fen, orientation: mover, lastMove: { from: f.from, to: f.to }, arrows: [{ from: f.from, to: f.to, color: byMe ? 'played' : 'reply' }] };
      }
      break;
    }
    case 'find_better': {
      if (betterFrame >= 0 && m.betterSequence[betterFrame]) {
        const f = m.betterSequence[betterFrame];
        board = { fen: f.fen, orientation: mover, lastMove: { from: f.from, to: f.to }, arrows: [{ from: f.from, to: f.to, color: betterFrame % 2 === 0 ? 'best' : 'reply' }] };
      } else if (!better || better.verdict === 'wrong' || better.verdict === 'same') {
        const arrows: Arrow[] = better ? [uciArrow(better.uci, 'guess')] : [];
        board = { fen: m.betterFen, orientation: mover, arrows, movable: mover, onMove: onBetter };
      } else {
        const arrows: Arrow[] = better.verdict === 'shown' ? [] : [uciArrow(better.uci, 'guess')];
        if (better.verdict !== 'correct' && m.bestUci) arrows.push(uciArrow(m.bestUci, 'best'));
        board = { fen: better.fen, orientation: mover, arrows, lastMove: { from: better.uci.slice(0, 2), to: better.uci.slice(2, 4) } };
      }
      break;
    }
    case 'why_good':
      board = { fen: m.fenAfter, orientation: mover, arrows: m.introMarkup.arrows, highlights: m.introMarkup.highlights };
      break;
    case 'lesson':
      board =
        m.kind === 'good_idea'
          ? { fen: m.fenAfter, orientation: mover, arrows: m.introMarkup.arrows, highlights: m.introMarkup.highlights }
          : { fen: m.betterFen, orientation: mover, arrows: [...(m.betterPly === m.ply ? [playedArrow] : []), ...(m.bestUci ? [uciArrow(m.bestUci, 'best')] : [])] };
      break;
  }

  // ------------------------------------------------------------ panel
  const t = m.text;
  const btn = (label: string, onClick: () => void, kind: 'primary' | 'ghost' = 'primary') => (
    <button className={`btn ${kind}`} onClick={onClick}>
      {label}
    </button>
  );
  let body: ReactNode = null;
  switch (step) {
    case 'intro':
      body = (
        <>
          <CoachText text={t.intent} />
          <div className="actions">{btn('Continue', next)}</div>
        </>
      );
      break;
    case 'predict':
      body = (
        <>
          <CoachText text={t.question} className="prompt" />
          {!guess && <p className="hint">Move one of {COLOR_NAME[opp]}'s pieces on the board.</p>}
          {guess && (
            <div className={`feedback ${guess.ok ? 'good' : 'neutral'}`}>
              <CoachText
                text={
                  guess.shown
                    ? `${COLOR_NAME[opp]}'s most natural answer is ${expectedReplySan}. Keep it in mind for the next step.`
                    : guess.ok
                      ? guess.uci === expectedReply
                        ? t.predictCorrect
                        : `${guess.san} works too. ${t.predictCorrect}`
                      : `You picked ${guess.san}. ${t.predictOther}`
                }
              />
            </div>
          )}
          <div className="actions">
            {!guess && expectedReply && btn('Show me', () => setGuess({ uci: expectedReply, san: expectedReplySan ?? '', fen: playLine(m.fenAfter, [expectedReply])[0]?.fen ?? m.fenAfter, ok: true, shown: true }), 'ghost')}
            {guess && btn('See what happened', next)}
          </div>
        </>
      );
      break;
    case 'reveal': {
      const n = m.sequence.length;
      body = (
        <>
          <CoachText text={t.reveal} />
          {n > 0 && (
            <div className="sequence">
              <button className="icon" aria-label="Previous" onClick={() => (window.clearInterval(timer.current), setFrame(Math.max(0, frame - 1)))}>‹</button>
              <div className="seq-moves">
                {m.sequence.map((f, i) => (
                  <span key={i} className={i === Math.min(frame, n - 1) ? 'on' : ''} onClick={() => (window.clearInterval(timer.current), setFrame(i))}>
                    {f.san}
                  </span>
                ))}
              </div>
              <button className="icon" aria-label="Next" onClick={() => (window.clearInterval(timer.current), setFrame(Math.min(n - 1, frame + 1)))}>›</button>
              <button className="icon" aria-label="Replay" onClick={() => play(n, setFrame)}>↻</button>
            </div>
          )}
          <div className="actions">{btn('Continue', next)}</div>
        </>
      );
      break;
    }
    case 'find_better': {
      const v = better?.verdict;
      const fb =
        v === 'correct'
          ? `${better!.san}! ${t.betterCorrect}`
          : v === 'ok'
            ? `${better!.san} is an improvement on the game, but there's something stronger: ${m.bestSan}.`
            : v === 'shown'
              ? `The move to find was ${m.bestSan}.`
              : v === 'same'
              ? `That's the move from the game (${better!.san}). Look for something else.`
              : v === 'wrong'
                ? `${better!.san} doesn't quite solve it. ${better?.note ?? ''} Try again, or reveal the move.`
                : v === 'checking'
                  ? `Checking ${better!.san}…`
                  : '';
      const done = v === 'correct' || v === 'ok' || v === 'shown';
      body = (
        <>
          <CoachText text={t.betterPrompt} className="prompt" />
          {!better && <p className="hint">Play a move for {COLOR_NAME[mover]} on the board.</p>}
          {better && (
            <div className={`feedback ${v === 'correct' ? 'good' : v === 'ok' || v === 'checking' || v === 'shown' ? 'neutral' : 'bad'}`}>
              <CoachText text={fb} />
            </div>
          )}
          {betterFrame >= 0 && (
            <div className="sequence">
              <div className="seq-moves">
                {m.betterSequence.map((f, i) => (
                  <span key={i} className={i === betterFrame ? 'on' : ''} onClick={() => (window.clearInterval(timer.current), setBetterFrame(i))}>
                    {f.san}
                  </span>
                ))}
              </div>
              <button className="icon" aria-label="Replay" onClick={() => play(m.betterSequence.length, setBetterFrame)}>↻</button>
            </div>
          )}
          <div className="actions">
            {!done && m.bestUci && btn('Show the better move', () => setBetter({ uci: m.bestUci!, san: m.bestSan ?? '', fen: m.betterSequence[0]?.fen ?? m.betterFen, verdict: 'shown' }), 'ghost')}
            {done && m.betterSequence.length > 1 && btn('Show the line', () => play(m.betterSequence.length, setBetterFrame), 'ghost')}
            {btn(done ? 'Continue' : 'Skip', next, done ? 'primary' : 'ghost')}
          </div>
        </>
      );
      break;
    }
    case 'why_good': {
      const c = m.choice!;
      body = (
        <>
          <CoachText text={t.intent} />
          <p className="prompt">{c.prompt}</p>
          <div className="options">
            {c.options.map((o, i) => (
              <button
                key={i}
                className={`option ${choice !== null ? (i === c.correct ? 'right' : i === choice ? 'wrong' : '') : ''}`}
                disabled={choice !== null}
                onClick={() => setChoice(i)}
              >
                {o}
              </button>
            ))}
          </div>
          {choice !== null && (
            <div className={`feedback ${choice === c.correct ? 'good' : 'neutral'}`}>
              <CoachText text={(choice === c.correct ? 'Exactly. ' : 'Not quite. ') + c.explanation} />
            </div>
          )}
          <div className="actions">{choice !== null && btn('Continue', next)}</div>
        </>
      );
      break;
    }
    case 'lesson':
      body = (
        <>
          <div className="lesson">
            <span className="lesson-label">Lesson</span>
            <CoachText text={t.lesson} />
          </div>
          <button className="link" onClick={() => setShowEngine(!showEngine)}>
            {showEngine ? 'Hide' : 'Show'} engine details
          </button>
          {showEngine && (
            <div className="engine-details">
              <div>
                Evaluation: {formatCp(m.numbers.cpBefore)} → {formatCp(m.numbers.cpAfter)} (your point of view)
              </div>
              {m.bestSan && (
                <div>
                  Engine's choice{m.betterPly !== m.ply ? ` on ${moveLabel(game.plies[m.betterPly - 1])}` : ''}: <b>{m.bestSan}</b> — {m.bestLineSan.slice(0, 5).join(' ')}
                </div>
              )}
            </div>
          )}
          <div className="actions">{btn(isLast ? 'Finish → drills' : 'Next moment', next)}</div>
        </>
      );
      break;
  }

  const panel = (
    <div className="moment">
      <div className="moment-head">
        <span className={`tag ${m.kind === 'good_idea' ? 'tag-good' : ''}`}>{m.kind === 'good_idea' ? 'Good idea' : categoryLabel(m.category)}</span>
        <div className="steps">
          {m.steps.map((s, i) => (
            <span key={s + i} className={`dot ${i < stepIdx ? 'done' : i === stepIdx ? 'on' : ''}`} />
          ))}
        </div>
      </div>
      <h2 className="moment-title">{t.title}</h2>
      {body}
    </div>
  );
  return { board, panel };
}

export function GuidedReview({ game, initialMoment, initialPly }: { game: StoredGame; initialMoment?: number; initialPly?: number }) {
  const moments = game.moments;
  const [mode, setMode] = useState<'moment' | 'browse'>(initialPly !== undefined || moments.length === 0 ? 'browse' : 'moment');
  const [mi, setMi] = useState(Math.min(initialMoment ?? 0, Math.max(0, moments.length - 1)));
  const [ply, setPly] = useState(initialPly ?? 0);
  const moment = moments[mi];

  const goNext = () => {
    if (mi < moments.length - 1) setMi(mi + 1);
    else navigate(`/game/${game.id}/drills`);
  };
  const runner = useMomentRunner(game, moment ?? moments[0] ?? ({} as TeachingMoment), goNext, mi === moments.length - 1);

  // Keyboard navigation in browse mode.
  useEffect(() => {
    if (mode !== 'browse') return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setPly((p) => Math.max(0, p - 1));
      if (e.key === 'ArrowRight') setPly((p) => Math.min(game.plies.length, p + 1));
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [mode, game.plies.length]);

  const browseBoard: BoardProps = useMemo(() => {
    const p = game.plies[ply - 1];
    const fen = p ? p.fenAfter : game.plies[0].fenBefore;
    const markMoment = moments.find((x) => x.ply === ply);
    return {
      fen,
      orientation: game.userColor,
      lastMove: p ? { from: p.from, to: p.to } : undefined,
      highlights: markMoment ? [{ square: p!.to, tone: markMoment.kind === 'good_idea' ? 'good' : 'danger' }] : [],
    };
  }, [ply, game, moments]);

  const board = mode === 'moment' && moment ? runner.board : browseBoard;
  const evalAt = ply > 0 ? game.analysis?.moves[ply - 1] : undefined;

  return (
    <HoverProvider>
      <div className="review">
        <div className="review-board">
          <Board {...board} />
          {mode === 'browse' && (
            <div className="board-controls">
              <button className="icon" onClick={() => setPly(0)} aria-label="Start">«</button>
              <button className="icon" onClick={() => setPly(Math.max(0, ply - 1))} aria-label="Previous move">‹</button>
              <span className="ply-label">{ply === 0 ? 'Start' : moveLabel(game.plies[ply - 1])}</span>
              <button className="icon" onClick={() => setPly(Math.min(game.plies.length, ply + 1))} aria-label="Next move">›</button>
              <button className="icon" onClick={() => setPly(game.plies.length)} aria-label="End">»</button>
            </div>
          )}
          <div className="legend">
            <span><i style={{ background: 'rgb(214,128,38)' }} /> your move</span>
            <span><i style={{ background: 'rgb(196,64,64)' }} /> opponent</span>
            <span><i style={{ background: 'rgb(46,140,92)' }} /> better</span>
            <span><i style={{ background: 'rgb(60,108,196)' }} /> your guess</span>
          </div>
        </div>
        <div className="review-panel card">
          <div className="moment-chips">
            <button className={`chip ${mode === 'browse' ? 'on' : ''}`} onClick={() => setMode('browse')}>
              Move list
            </button>
            {moments.map((x, i) => (
              <button
                key={x.id}
                className={`chip ${mode === 'moment' && i === mi ? 'on' : ''} ${x.kind === 'good_idea' ? 'good' : ''} ${game.completedMomentIds.includes(x.id) ? 'done' : ''}`}
                onClick={() => {
                  setMi(i);
                  setMode('moment');
                }}
                title={x.text.title}
              >
                {x.kind === 'good_idea' ? '★ ' : ''}
                {moveLabel(game.plies[x.ply - 1])}
              </button>
            ))}
          </div>
          {mode === 'moment' && moment ? (
            runner.panel
          ) : (
            <div className="browse">
              <MoveList
                plies={game.plies}
                current={ply}
                onSelect={setPly}
                marks={Object.fromEntries(moments.map((x) => [x.ply, x.kind === 'good_idea' ? 'good' : 'bad']))}
              />
              {evalAt && (
                <p className="muted small">
                  {moveLabel(game.plies[ply - 1])}: eval {formatCp(evalAt.cpAfter * (evalAt.color === game.userColor ? 1 : -1))} (your view)
                  {evalAt.bestSan && !evalAt.isBest ? ` · engine preferred ${evalAt.bestSan}` : ''}
                </p>
              )}
              {moments.find((x) => x.ply === ply) && (
                <button
                  className="btn primary"
                  onClick={() => {
                    setMi(moments.findIndex((x) => x.ply === ply));
                    setMode('moment');
                  }}
                >
                  Review this teaching moment
                </button>
              )}
              {moments.length === 0 && <p className="muted">No teaching moments in this game — nothing significant to review.</p>}
            </div>
          )}
        </div>
      </div>
    </HoverProvider>
  );
}
