// Guided review: play through the game move by move; the review pauses
// *before* each critical move and turns it into a guided moment. The question
// sits right above the board, the verdict right below it, so you always know
// whether your answer was right without scrolling.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Arrow, Finding, StoredGame, TeachingMoment } from '../../domain/types';
import { Board, type BoardProps } from '../components/Board';
import { FlagButton } from '../components/FlagButton';
import { Verdict, type Panels } from '../components/reviewParts';
import { gameMoveComparison, usePracticeBoard } from '../components/PracticeBoard';
import { useLessonRunner } from '../components/LessonRunner';
import { EvalChange } from '../components/EvalBar';
import { AiExplain, useAiAvailable, useAiBlocker } from '../components/AiExplain';
import { classifyMove, gapBetween, qualityOf, qualityOfGap, type MoveClass, type Quality } from '../../analysis/moveQuality';
import { QualityBadge, whiteEvals } from '../components/ReviewVisuals';
import { ActionButton, BoardZone, BottomSheet, CoachBubble, DockSheet, EvalStrip } from '../components/ReviewShell';
import { Icon } from '../components/AppShell';
import { evalText } from '../../coach/momentContext';
import { useFindFirst, useLineView } from '../components/ReviewSteps';
import { CoachText, HoverProvider } from '../components/CoachText';
import { MoveStrip } from '../components/MoveStrip';
import { categoryLabel } from '../../domain/categories';
import { moveLabel } from '../../chess/pgn';
import { COLOR_NAME, other, playLine } from '../../chess/board';
import { formatCp } from '../../analysis/evaluation';
import { engineNotes, verdictOf } from '../../analysis/engineReview';
import { closeToBest, evaluateMove, markMomentDone } from '../actions';
import { usesEngineReply } from '../../analysis/moments';
import { gamePlayedAt } from '../../analysis/pipeline';
import { themeOf } from '../../coach/report';
import { navigate, useApp } from '../store';

const uciArrow = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });
const toSquares = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) });

type BetterVerdict = 'correct' | 'ok' | 'wrong' | 'same' | 'checking' | 'shown';

/** A big, unmissable answer verdict shown directly under the board. */

function useMomentRunner(game: StoredGame, m: TeachingMoment | undefined, onDone: () => void, onSkip: () => void, onExplore: (ply: number) => void): Panels | null {
  const [stepIdx, setStepIdx] = useState(0);
  const [guess, setGuess] = useState<{ uci: string; san: string; fen: string; ok: boolean; shown?: boolean } | null>(null);
  const [better, setBetter] = useState<{ uci: string; san: string; fen: string; verdict: BetterVerdict; note?: string; quality?: Quality } | null>(null);
  const [frame, setFrame] = useState(0);
  const [betterFrame, setBetterFrame] = useState(-1);
  const [choice, setChoice] = useState<number | null>(null);
  const [showEngine, setShowEngine] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setStepIdx(0);
    setGuess(null);
    setBetter(null);
    setFrame(0);
    setBetterFrame(-1);
    setChoice(null);
    setShowEngine(false);
    window.clearInterval(timer.current);
  }, [m?.id]);

  const play = (len: number, set: (n: number) => void) => {
    window.clearInterval(timer.current);
    let i = 0;
    set(i);
    timer.current = window.setInterval(() => {
      i += 1;
      if (i >= len) return window.clearInterval(timer.current);
      set(i);
    }, 1100);
  };
  const step = m?.steps[stepIdx];
  useEffect(() => {
    if (m && step === 'reveal' && m.sequence.length) play(m.sequence.length, setFrame);
    return () => window.clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, m?.id]);

  // Where the game move and Stockfish's move lead, in practical terms (the heart of the lesson).
  const lessonCmp = useMemo(() => (m && m.kind !== 'good_idea' ? gameMoveComparison(game, m.betterPly) : undefined), [game, m]);

  if (!m || !step) return null;

  const mover = m.moverColor;
  const opp = other(mover);
  const oppName = COLOR_NAME[opp];
  const engineReplyFirst = usesEngineReply(m);
  const expectedReply = engineReplyFirst ? m.acceptableReplyUcis[0] : m.opponentReplyUci ?? m.acceptableReplyUcis[0];
  const expectedReplySan = expectedReply ? playLine(m.fenAfter, [expectedReply])[0]?.san : undefined;
  const betterPlayed = game.plies[m.betterPly - 1];
  const t = m.text;
  const isLastStep = stepIdx === m.steps.length - 1;

  const next = () => {
    window.clearInterval(timer.current);
    if (!isLastStep) setStepIdx(stepIdx + 1);
    else {
      void markMomentDone(game.id, m.id);
      onDone();
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
      const pos = game.analysis?.positions[m.betterPly - 1];
      setBetter({ uci, san, fen, verdict: 'correct', quality: uci === m.bestUci ? 'best' : qualityOf(pos, uci) ?? 'equal' });
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
      const quality = res && betterBestCp !== undefined ? qualityOfGap(gapBetween(betterBestCp, res.cp)) : undefined;
      setBetter({ uci, san, fen, verdict, note, quality });
    });
    return true;
  };

  const btn = (label: string, onClick: () => void, kind: 'primary' | 'ghost' = 'primary') => (
    <button key={label} className={`btn ${kind}`} onClick={onClick}>
      {label}
    </button>
  );
  const continueLabel = isLastStep ? 'Continue the game →' : 'Continue';
  const skip = btn('Skip moment', () => (window.clearInterval(timer.current), onSkip()), 'ghost');

  let board: BoardProps = { fen: m.fenBefore, orientation: mover };
  let prompt: ReactNode = null;
  let banner: ReactNode = null;

  switch (step) {
    case 'intro': {
      board = { fen: m.fenBefore, orientation: mover, arrows: m.introMarkup.arrows, highlights: m.introMarkup.highlights };
      prompt = <CoachText text={m.kind === 'good_idea' ? t.intent : `Let's stop here. ${t.intent}`} />;
      banner = <div className="actions">{[skip, btn(continueLabel, next)]}</div>;
      break;
    }
    case 'predict': {
      if (!guess) {
        board = {
          fen: m.fenAfter,
          orientation: mover,
          arrows: [uciArrow(m.playedUci, 'played')],
          highlights: m.introMarkup.highlights,
          movable: opp,
          onMove: onPredict,
        };
        banner = (
          <>
            <Verdict tone="neutral" title={`Your turn: move a ${oppName.toLowerCase()} piece`} text="Drag it, or tap the piece and then the square." />
            <div className="actions">
              {expectedReply &&
                btn(
                  'Show me',
                  () => setGuess({ uci: expectedReply, san: expectedReplySan ?? '', fen: playLine(m.fenAfter, [expectedReply])[0]?.fen ?? m.fenAfter, ok: true, shown: true }),
                  'ghost',
                )}
            </div>
          </>
        );
      } else {
        const sq = toSquares(guess.uci);
        const arrows: Arrow[] = guess.shown ? [uciArrow(guess.uci, 'reply')] : [uciArrow(guess.uci, 'guess')];
        if (!guess.shown && expectedReply && expectedReply !== guess.uci) arrows.push(uciArrow(expectedReply, 'reply'));
        board = {
          fen: guess.ok ? guess.fen : m.fenAfter,
          orientation: mover,
          arrows,
          lastMove: guess.ok ? sq : undefined,
          highlights: guess.shown ? [] : [{ square: sq.to, tone: guess.ok ? 'good' : 'danger' }],
        };
        const verdict = guess.shown ? (
          <Verdict tone="neutral" title={`${oppName}'s answer: ${expectedReplySan}`} text={engineReplyFirst ? t.predictCorrect : undefined} />
        ) : guess.ok ? (
          <Verdict tone="good" title={`Correct — ${guess.san}`} text={guess.uci === expectedReply ? t.predictCorrect : `${guess.san} works too. ${t.predictCorrect}`} />
        ) : (
          <Verdict tone="bad" title={`Not quite — you picked ${guess.san}`} text={`${t.predictOther} (red arrow)`} />
        );
        banner = (
          <>
            {verdict}
            <div className="actions">{btn('See what happened', next)}</div>
          </>
        );
      }
      prompt = <CoachText text={t.question} className="prompt" />;
      break;
    }
    case 'reveal': {
      const n = m.sequence.length;
      const idx = Math.min(frame, Math.max(0, n - 1));
      const f = m.sequence[idx];
      if (f) board = { fen: f.fen, orientation: mover, lastMove: { from: f.from, to: f.to }, arrows: [{ from: f.from, to: f.to, color: idx % 2 === 0 ? 'played' : 'reply' }] };
      prompt = <CoachText text={t.reveal} />;
      banner = (
        <>
          {n > 0 && (
            <div className="sequence">
              <button className="icon" aria-label="Previous" onClick={() => (window.clearInterval(timer.current), setFrame(Math.max(0, idx - 1)))}>
                ‹
              </button>
              <div className="seq-moves">
                {m.sequence.map((s, i) => (
                  <span key={i} className={i === idx ? 'on' : ''} onClick={() => (window.clearInterval(timer.current), setFrame(i))}>
                    {s.san}
                  </span>
                ))}
              </div>
              <button className="icon" aria-label="Next" onClick={() => (window.clearInterval(timer.current), setFrame(Math.min(n - 1, idx + 1)))}>
                ›
              </button>
              <button className="icon" aria-label="Replay" onClick={() => play(n, setFrame)}>
                ↻
              </button>
            </div>
          )}
          <div className="actions">{btn(continueLabel, next)}</div>
        </>
      );
      break;
    }
    case 'find_better': {
      const v = better?.verdict;
      if (betterFrame >= 0 && m.betterSequence[betterFrame]) {
        const f = m.betterSequence[betterFrame];
        board = { fen: f.fen, orientation: mover, lastMove: { from: f.from, to: f.to }, arrows: [{ from: f.from, to: f.to, color: betterFrame % 2 === 0 ? 'best' : 'reply' }] };
      } else if (!better || v === 'wrong' || v === 'same') {
        board = {
          fen: m.betterFen,
          orientation: mover,
          arrows: better ? [uciArrow(better.uci, 'guess')] : [],
          highlights: better ? [{ square: toSquares(better.uci).to, tone: 'danger' }] : [],
          movable: mover,
          onMove: onBetter,
        };
      } else {
        const arrows: Arrow[] = v === 'shown' ? [] : [uciArrow(better.uci, 'guess')];
        if (v !== 'correct' && m.bestUci) arrows.push(uciArrow(m.bestUci, 'best'));
        board = {
          fen: better.fen,
          orientation: mover,
          arrows,
          lastMove: toSquares(better.uci),
          highlights: v === 'correct' ? [{ square: toSquares(better.uci).to, tone: 'good' }] : [],
        };
      }
      const done = v === 'correct' || v === 'ok' || v === 'shown';
      const verdict = !better ? (
        <Verdict tone="neutral" title={`Your turn: play a move for ${COLOR_NAME[mover]}`} text="Drag a piece, or tap it and then the square." />
      ) : v === 'checking' ? (
        <Verdict tone="neutral" title={`Checking ${better.san}…`} />
      ) : v === 'correct' ? (
        <Verdict
          tone="good"
          title={
            better.quality === 'best' || !better.quality
              ? `Correct — ${better.san} is Stockfish's first choice`
              : better.quality === 'equal'
                ? `Correct — ${better.san} is just as good as ${m.bestSan}`
                : `Good — ${better.san} works; ${m.bestSan} is a little more precise`
          }
          text={t.why ?? t.betterCorrect}
        />
      ) : v === 'ok' ? (
        <Verdict
          tone="neutral"
          title={`Better than the game — but not the best`}
          text={`${better.san} improves on the game. The strongest was ${m.bestSan} (green arrow)${t.why ? `: ${t.why}` : '.'}`}
        />
      ) : v === 'shown' ? (
        <Verdict tone="neutral" title={`The move to find: ${m.bestSan}`} text={t.why ?? t.betterCorrect} />
      ) : v === 'same' ? (
        <Verdict tone="bad" title={`That's the game move (${better.san})`} text="Look for something different — try again." />
      ) : (
        <Verdict tone="bad" title={`Not quite — ${better.san}`} text={`${better.note ?? ''} Try another move, or reveal the answer.`.trim()} />
      );
      prompt = <CoachText text={t.betterPrompt} className="prompt" />;
      banner = (
        <>
          {verdict}
          {betterFrame >= 0 && (
            <div className="sequence">
              <div className="seq-moves">
                {m.betterSequence.map((s, i) => (
                  <span key={i} className={i === betterFrame ? 'on' : ''} onClick={() => (window.clearInterval(timer.current), setBetterFrame(i))}>
                    {s.san}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="actions">
            {!done && m.bestUci && btn('Show the answer', () => setBetter({ uci: m.bestUci!, san: m.bestSan ?? '', fen: m.betterSequence[0]?.fen ?? m.betterFen, verdict: 'shown' }), 'ghost')}
            {done && m.betterSequence.length > 1 && btn('Show the line', () => play(m.betterSequence.length, setBetterFrame), 'ghost')}
            {btn(done ? continueLabel : 'Skip', next, done ? 'primary' : 'ghost')}
          </div>
        </>
      );
      break;
    }
    case 'why_good': {
      const c = m.choice!;
      board = { fen: m.fenAfter, orientation: mover, arrows: m.introMarkup.arrows, highlights: m.introMarkup.highlights };
      prompt = <p className="prompt">{c.prompt}</p>;
      banner = (
        <>
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
          {choice !== null &&
            (choice === c.correct ? (
              <Verdict tone="good" title="Correct" text={c.explanation} />
            ) : (
              <Verdict tone="bad" title="Not quite" text={c.explanation} />
            ))}
          <div className="actions">{choice !== null && btn(continueLabel, next)}</div>
        </>
      );
      break;
    }
    case 'lesson': {
      board =
        m.kind === 'good_idea'
          ? { fen: m.fenAfter, orientation: mover, arrows: m.introMarkup.arrows, highlights: m.introMarkup.highlights }
          : {
              fen: m.betterFen,
              orientation: mover,
              arrows: [...(m.betterPly === m.ply ? [uciArrow(m.playedUci, 'played')] : []), ...(m.bestUci ? [uciArrow(m.bestUci, 'best')] : [])],
            };
      prompt = (
        <div className="lesson">
          <span className="lesson-label">Lesson</span>
          <CoachText text={t.lesson} />
        </div>
      );
      const x = m.explanation;
      banner = (
        <>
          {x && m.kind === 'mistake' && (
            <dl className="three-part">
              {x.intent && (
                <>
                  <dt>What you were going for</dt>
                  <dd>
                    <CoachText text={`${m.playedSan} ${x.intent}.`} />
                  </dd>
                </>
              )}
              <dt>{x.kind === 'mistake' ? 'What went wrong' : 'What you missed'}</dt>
              <dd>
                <CoachText
                  text={
                    x.kind === 'mistake' && x.problem
                      ? `${x.problem.charAt(0).toUpperCase()}${x.problem.slice(1)}.`
                      : `Nothing went wrong right away — but ${m.bestSan ?? 'a stronger move'} was available.`
                  }
                />
              </dd>
              {t.why && (
                <>
                  <dt>Why {x.betterSan ?? m.bestSan} is better</dt>
                  <dd>
                    <CoachText text={t.why} />
                  </dd>
                </>
              )}
              {lessonCmp?.comparison && (
                <>
                  <dt>Where each move leads</dt>
                  <dd>
                    <CoachText text={lessonCmp.comparison.summary} />
                  </dd>
                </>
              )}
              {lessonCmp && lessonCmp.alternatives.length > 0 && (
                <>
                  <dt>Also fine</dt>
                  <dd>{lessonCmp.alternatives.join(', ')} — Stockfish rates these as highly as {lessonCmp.bestSan}.</dd>
                </>
              )}
            </dl>
          )}
          <FlagButton
            game={game}
            where="moment"
            ply={m.ply}
            quote={[
              t.title,
              x?.intent && `What you were going for: ${m.playedSan} ${x.intent}.`,
              x?.problem && `What went wrong: ${x.problem}.`,
              t.why && `Why ${x?.betterSan ?? m.bestSan} is better: ${t.why}`,
              `Lesson: ${t.lesson}`,
            ]
              .filter(Boolean)
              .join(' | ')}
          />
          <div className="actions">
            {m.kind !== 'good_idea' && (game.analysis?.positions[m.betterPly - 1]?.lines[0]?.pv.length ?? 0) > 1 && btn('Explore the lines & try your own move', () => onExplore(m.betterPly), 'ghost')}
            {btn('Continue the game →', next)}
          </div>
        </>
      );
      break;
    }
  }

  const details = (
    <>
      <button className="link" onClick={() => setShowEngine(!showEngine)}>
        {showEngine ? 'Hide' : 'Show'} engine details
      </button>
      {showEngine && (
        <div className="engine-details">
          <div>
            Evaluation (your view): {formatCp(m.numbers.cpBefore)} before → {formatCp(m.numbers.cpAfter)} after {m.playedSan}
          </div>
          {m.bestSan && (
            <div>
              Engine's choice{m.betterPly !== m.ply ? ` on ${moveLabel(game.plies[m.betterPly - 1])}` : ''}: <b>{m.bestSan}</b> — {m.bestLineSan.slice(0, 5).join(' ')}
            </div>
          )}
        </div>
      )}
    </>
  );

  const head = (
    <div className="moment-head">
      <span className={`tag ${m.kind === 'good_idea' ? 'tag-good' : m.explanation?.kind === 'missed_opportunity' ? 'tag-missed' : ''}`}>
        {m.kind === 'good_idea'
          ? '★ Good idea'
          : `${m.explanation?.kind === 'missed_opportunity' ? 'Missed chance' : 'Mistake'} · ${categoryLabel(m.category)}`}
      </span>
      <div className="steps" aria-label={`Step ${stepIdx + 1} of ${m.steps.length}`}>
        {m.steps.map((s, i) => (
          <span key={s + i} className={`dot ${i < stepIdx ? 'done' : i === stepIdx ? 'on' : ''}`} />
        ))}
      </div>
    </div>
  );

  return {
    board,
    prompt: (
      <>
        {head}
        <h2 className="moment-title">{t.title}</h2>
        {prompt}
      </>
    ),
    banner,
    details,
    stateKey: `${m.id}:${stepIdx}:${guess?.uci ?? ''}:${better?.verdict ?? ''}:${choice ?? ''}`,
  };
}

/** "You did this before": the same kind of mistake in an earlier analyzed game. */
function useSeenBefore(game: StoredGame, m: TeachingMoment | undefined) {
  const { games } = useApp();
  return useMemo(() => {
    if (!m || m.kind !== 'mistake') return undefined;
    const theme = themeOf(m.category);
    const at = gamePlayedAt(game);
    const earlier = games
      .filter((g) => g.id !== game.id && g.status === 'analyzed' && gamePlayedAt(g) < at)
      .sort((a, b) => gamePlayedAt(b) - gamePlayedAt(a));
    for (const g of earlier) {
      const credible = (f: Finding) => f.kind === 'weakness' && f.severity >= 2 && f.confidence !== 'low' && f.ply > 0;
      const same = g.findings.find((f) => credible(f) && f.category === m.category) ?? g.findings.find((f) => credible(f) && themeOf(f.category) === theme);
      if (same) return { game: g, finding: same, exact: same.category === m.category, count: earlier.filter((x) => x.findings.some((f) => credible(f) && themeOf(f.category) === theme)).length };
    }
    return undefined;
  }, [games, game, m]);
}

export function GuidedReview({ game, initialPly, explore = false }: { game: StoredGame; initialPly?: number; explore?: boolean }) {
  const moments = game.moments;
  const momentAt = useMemo(() => new Map(moments.map((m) => [m.ply, m])), [moments]);
  // `explore`: open straight onto the practice board for the move at `initialPly` (from the AI Coach's diagrams).
  const exploring = explore && initialPly !== undefined && initialPly >= 1 && initialPly <= game.plies.length;
  const startMoment = initialPly !== undefined && !exploring ? momentAt.get(initialPly) : undefined;
  const [ply, setPly] = useState(startMoment ? startMoment.ply - 1 : Math.min(initialPly ?? 0, game.plies.length));
  const [active, setActive] = useState<TeachingMoment | undefined>(startMoment);
  const [doneIds, setDoneIds] = useState<Set<string>>(() => new Set(game.completedMomentIds));
  // The practice board for one decision (position before that move), or null.
  const [practicePly, setPracticePly] = useState<number | null>(exploring ? initialPly! : null);
  // Opened from the action bar: straight into "play your own moves".
  const [practiceTry, setPracticeTry] = useState(false);
  const practice = usePracticeBoard(game, practicePly, () => (setPracticePly(null), setPracticeTry(false)), practiceTry ? 'try' : 'overview');
  const topRef = useRef<HTMLDivElement>(null);

  const finish = (m: TeachingMoment, completed: boolean) => {
    if (completed) setDoneIds((s) => new Set(s).add(m.id));
    setActive(undefined);
    setPly(m.ply); // play the actual game move and carry on
  };
  const runner = useMomentRunner(
    game,
    active,
    () => active && finish(active, true),
    () => active && finish(active, false),
    (p) => (setPracticeTry(false), setPracticePly(p)),
  );
  const lesson = useLessonRunner(
    game,
    active,
    () => active && finish(active, true),
    () => active && finish(active, false),
    (p) => (setPracticeTry(false), setPracticePly(p)),
  );
  const seenBefore = useSeenBefore(game, active);
  // Only lessons stop the play-through; notes are shown in passing.
  const stopsAt = (m: TeachingMoment | undefined) => !!m && m.tier !== 'note' && !doneIds.has(m.id);

  const startMomentAt = (m: TeachingMoment) => {
    setPly(m.ply - 1);
    setActive(m);
  };
  // "Find it first": before each of your mistakes/blunders that isn't already a lesson, one try at a better move.
  const [attempted, setAttempted] = useState<Set<number>>(() => new Set());
  const findFirst = useFindFirst(game, (p) => (setAttempted((s) => new Set(s).add(p)), setPly(p)));
  const lineView = useLineView(game);
  const findsFirst = (n: number) =>
    game.plies[n - 1]?.color === game.userColor && (classes[n] === 'mistake' || classes[n] === 'blunder') && !attempted.has(n) && !(momentAt.get(n) && momentAt.get(n)!.tier !== 'note'); // lessons have their own flow
  const next = () => {
    if (active || findFirst.active) return;
    if (lineView.active) return void lineView.next();
    const n = ply + 1;
    const upcoming = momentAt.get(n);
    if (stopsAt(upcoming)) startMomentAt(upcoming!);
    else if (findsFirst(n)) findFirst.start(n);
    else setPly((p) => Math.min(game.plies.length, p + 1));
  };
  const prev = () => {
    if (lineView.active) return void lineView.prev();
    if (findFirst.active) return findFirst.cancel();
    if (active) setActive(undefined);
    else setPly((p) => Math.max(0, p - 1));
  };
  const jump = (p: number) => (setPracticePly(null), setActive(undefined), findFirst.cancel(), lineView.close(), setPly(p));
  const nextMoment = moments.find((m) => m.ply > ply + 1 && stopsAt(m));

  const stateKey = lesson?.stateKey ?? runner?.stateKey ?? findFirst.panels?.stateKey ?? lineView.panels?.stateKey ?? `browse:${ply}`;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (practicePly !== null) {
        if (e.key === 'Escape') setPracticePly(null);
        return;
      }
      if (active) return;
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const current = game.plies[ply - 1];
  const upcomingRaw = momentAt.get(ply + 1);
  const upcoming = upcomingRaw && upcomingRaw.tier !== 'note' ? upcomingRaw : undefined;
  const noteHere = ply > 0 ? moments.find((x) => x.ply === ply && x.tier === 'note') : undefined;
  const noteCmp = useMemo(() => (noteHere && noteHere.kind === 'mistake' ? gameMoveComparison(game, noteHere.betterPly) : undefined), [game, noteHere]);
  const evalAt = ply > 0 ? game.analysis?.moves[ply - 1] : undefined;
  const plyNotes = game.findings.filter((f) => f.ply === ply && ply > 0 && f.confidence !== 'low' && !momentAt.has(ply));
  // Badge for every move (both sides). Lessons not done yet show "?" so the stop-and-think
  // moments aren't given away; everything else can be scanned at a glance.
  const classes = useMemo(() => {
    const out: Record<number, MoveClass> = {};
    (game.analysis?.moves ?? []).forEach((e, i) => (out[i + 1] = classifyMove(e, game.analysis!.positions[i])));
    return out;
  }, [game.analysis]);
  // Hidden until reached: lessons not done yet, and your mistakes/blunders you haven't tried to improve on.
  const hiddenPlies = useMemo(() => {
    const out = new Set(moments.filter((x) => x.tier !== 'note' && !doneIds.has(x.id)).map((x) => x.ply));
    for (const [p, c] of Object.entries(classes)) if ((c === 'mistake' || c === 'blunder') && game.plies[Number(p) - 1].color === game.userColor && !attempted.has(Number(p))) out.add(Number(p));
    return out;
  }, [moments, doneIds, classes, attempted, game.plies, game.userColor]);
  const badges = useMemo(() => {
    const out: Record<number, MoveClass | 'hidden'> = {};
    for (const [p, c] of Object.entries(classes)) out[Number(p)] = hiddenPlies.has(Number(p)) && Number(p) > ply ? 'hidden' : c;
    return out;
  }, [classes, hiddenPlies, ply]);
  const whites = useMemo(() => (game.analysis ? whiteEvals(game.plies, game.analysis.positions) : []), [game]);
  const notesByPly = useMemo(() => new Map(engineNotes(game).map((n) => [n.ply, n])), [game]);
  const engineNote = notesByPly.get(ply);
  const verdict = evalAt ? verdictOf(evalAt) : undefined;
  const cls = ply > 0 ? classes[ply] : undefined;
  const mine = evalAt?.color === game.userColor;

  // ---------------------------------------------------------- play-through
  // The move just played (orange for yours, red for theirs) and, when it wasn't as good,
  // Stockfish's choice in green.
  const showBest = !!evalAt?.bestUci && !!cls && !['best', 'equal', 'great', 'brilliant'].includes(cls);
  const browseBoard: BoardProps = {
    fen: current ? current.fenAfter : game.plies[0].fenBefore,
    orientation: game.userColor,
    lastMove: current ? { from: current.from, to: current.to } : undefined,
    arrows: current ? [uciArrow(current.uci, current.color === game.userColor ? 'played' : 'reply'), ...(showBest ? [uciArrow(evalAt!.bestUci!, 'best')] : [])] : [],
    badge: current && cls ? { square: current.to, cls } : undefined,
  };
  const yours = current?.color === game.userColor;
  const lessonCount = moments.filter((x) => x.tier !== 'note').length;
  const noteCount = moments.filter((x) => x.tier === 'note').length;
  const browsePrompt = (
    <>
      {ply === 0 ? (
        <p>
          Play through your game move by move with <b>Next</b>.{' '}
          {lessonCount
            ? `I'll stop for ${lessonCount === 1 ? 'one short lesson' : `${lessonCount} short lessons`} — the most useful moments of this game — and ask you a question first.`
            : 'No lessons this time — nothing big went wrong.'}
          {noteCount ? ` ${noteCount} smaller point${noteCount === 1 ? '' : 's'} will show up as you pass ${noteCount === 1 ? 'it' : 'them'}.` : ''}
        </p>
      ) : (
        <p className="move-caption">
          <b>{moveLabel(current!)}</b> {cls && <QualityBadge cls={cls} label />} <span className="muted">— {yours ? 'you played' : `${game.opponentName} played`}</span>
          {momentAt.has(ply) && doneIds.has(momentAt.get(ply)!.id) && <span className="muted"> · reviewed ✓</span>}
        </p>
      )}
      {evalAt && verdict && !evalAt.isBest && evalAt.bestSan && (
        <p className={`engine-line v-${verdict}`}>
          <span className="engine-chip">Stockfish</span>
          {verdict === 'equal'
            ? ` its first choice was ${evalAt.bestSan} (green arrow), but this is just as good`
            : verdict === 'good'
              ? ` ${evalAt.bestSan} (green arrow) was a little more precise`
              : ` preferred ${evalAt.bestSan} (green arrow): ${formatCp(evalAt.cpBefore * (mine ? 1 : -1))} instead of ${formatCp(evalAt.cpAfter * (mine ? 1 : -1))}, your view`}
        </p>
      )}
      {engineNote && engineNote.kind === 'trap' && <CoachText text={engineNote.text} className="ply-note" />}
      {noteHere && (
        <div className="note-card">
          <span className="eyebrow">{noteHere.kind === 'good_idea' ? 'Good idea' : 'Worth knowing'}</span>
          <b className="note-title">{noteHere.text.title}</b>
          {noteHere.kind === 'mistake' && evalAt && <EvalChange before={evalAt.cpBefore * (mine ? 1 : -1)} after={evalAt.cpAfter * (mine ? 1 : -1)} />}
          <CoachText
            text={
              noteHere.kind === 'good_idea'
                ? noteHere.text.lesson
                : noteCmp?.comparison?.summary ?? (noteHere.explanation?.problem ? `${noteHere.explanation.problem.charAt(0).toUpperCase()}${noteHere.explanation.problem.slice(1)}.` : noteHere.text.lesson)
            }
          />
          {noteHere.kind === 'mistake' && (
            <button className="btn ghost small" onClick={() => (setPracticeTry(false), setPracticePly(noteHere.betterPly))}>
              Explore
            </button>
          )}
          {noteHere.kind === 'mistake' && <AiExplain game={game} ply={noteHere.betterPly} bestSan={noteCmp?.bestSan} compact />}
        </div>
      )}
      {plyNotes.map((f, i) => (
        <CoachText key={i} text={f.evidence} className={`ply-note ${f.kind === 'strength' ? 'good' : ''}`} />
      ))}
      {upcoming && (
        <p className="upcoming">
          ⚑ Next move is a lesson{doneIds.has(upcoming.id) ? ' (already reviewed — Next plays it)' : ' — Next will stop and ask you first'}.
        </p>
      )}
    </>
  );
  const browseDetails = evalAt ? (
    <p className="muted small">
      Engine after {moveLabel(game.plies[ply - 1])}: {formatCp(evalAt.cpAfter * (evalAt.color === game.userColor ? 1 : -1))} (your view)
    </p>
  ) : null;

  const focused = practice ?? lesson ?? runner ?? findFirst.panels ?? lineView.panels;
  const panels: Panels = focused ?? { board: browseBoard, prompt: browsePrompt, banner: null, details: browseDetails, stateKey };
  const steps = !practice && !lesson && !runner && !findFirst.panels && lineView.active ? lineView.info : undefined;
  const mode: 'browse' | 'focus' | 'steps' = !focused ? 'browse' : steps ? 'steps' : 'focus';
  const marks = Object.fromEntries(
    moments.map((x) => [x.ply, doneIds.has(x.id) ? ('done' as const) : x.kind === 'good_idea' ? ('good' as const) : x.tier === 'note' ? ('note' as const) : ('bad' as const)]),
  );

  // ---------------------------------------------------------- bottom sheet (Why?, More)
  const [sheet, setSheet] = useState<null | 'more' | 'why'>(null);
  useEffect(() => setSheet(null), [stateKey]);

  // One short, concrete sentence for the bubble: a detector's board fact first, then Stockfish.
  const plyFinding = ply > 0 ? game.findings.filter((f) => f.ply === ply && f.kind === 'weakness' && f.confidence !== 'low').sort((a, b) => b.severity - a.severity)[0] : undefined;
  const plyStrength = ply > 0 ? game.findings.find((f) => f.ply === ply && f.kind === 'strength' && f.category === 'found_tactic') : undefined;
  const bubbleLine =
    ply === 0
      ? lessonCount
        ? `Tap Next to play through the game. I'll stop for ${lessonCount === 1 ? 'one short lesson' : `${lessonCount} short lessons`} and ask you first.`
        : 'Tap Next to play through the game — nothing big went wrong, so no lessons this time.'
      : noteHere?.kind === 'good_idea'
        ? noteHere.text.lesson
        : plyFinding && !hiddenPlies.has(ply)
          ? plyFinding.evidence
          : plyStrength
            ? plyStrength.evidence
            : engineNote?.kind === 'trap'
              ? engineNote.text
              : evalAt && !evalAt.isBest && evalAt.bestSan
                ? verdict === 'equal'
                  ? `As good as Stockfish's ${evalAt.bestSan}.`
                  : verdict === 'good'
                    ? `${evalAt.bestSan} (green arrow) was a little more precise.`
                    : `Stockfish preferred ${evalAt.bestSan} (green arrow).`
                : cls === 'great'
                  ? 'The only good move here — well found.'
                  : cls === 'brilliant'
                    ? 'A sound sacrifice — Stockfish agrees.'
                    : '';
  const viewPly = active ? active.ply - 1 : steps ? ply : ply;
  const evalHere = practice ? undefined : whites[viewPly];
  const yourView = (w: number) => (game.userColor === 'w' ? w : -w);
  const browseHead =
    ply === 0 ? (
      <b>Start</b>
    ) : (
      <>
        <b>{moveLabel(current!)}</b>
        {cls && <QualityBadge cls={cls} label />}
        <span className="gr-head-eval">{evalHere !== undefined ? evalText(yourView(evalHere)) : ''}</span>
      </>
    );
  const moreExtra = !!(noteHere || plyNotes.length || engineNote || (evalAt && !evalAt.isBest));

  // ---------------------------------------------------------- action bar
  const goodOrWorse = !!cls && ['good', 'inaccuracy', 'mistake', 'blunder'].includes(cls);
  const canRefute = (game.analysis?.positions[ply]?.lines[0]?.pv.length ?? 0) > 0;
  const atEnd = ply >= game.plies.length;
  // Try your own moves: instead of your move here, or — after your opponent's move — as your reply.
  const tryPly = ply > 0 && current?.color === game.userColor ? ply : game.plies[ply]?.color === game.userColor ? ply + 1 : undefined;
  const nextLabel = atEnd ? 'Drills' : upcoming && !doneIds.has(upcoming.id) ? 'Next: stop & think' : 'Next';
  const actionBar = (
    <div className="gr-actions">
      {goodOrWorse && <ActionButton icon={<Icon name="why" />} label="Why?" onClick={() => setSheet('why')} />}
      {(cls === 'mistake' || cls === 'blunder') && canRefute && <ActionButton icon={<Icon name="showme" />} label="Show me" onClick={() => lineView.open(ply, 'refutation')} />}
      <ActionButton icon={<Icon name="try" />} label="Try moves" disabled={tryPly === undefined} onClick={() => (setPracticeTry(true), setPracticePly(tryPly!))} />
      {evalAt && !evalAt.isBest && evalAt.bestSan && <ActionButton icon={<Icon name="best" />} label="Best" onClick={() => lineView.open(ply, 'better')} />}
      <button className="btn primary gr-next" onClick={atEnd ? () => navigate(`/game/${game.id}/drills`) : next}>
        {nextLabel} ›
      </button>
    </div>
  );

  // ---------------------------------------------------------- sheet contents
  const aiOn = useAiAvailable();
  const aiBlocker = useAiBlocker();
  const { llm } = useApp();
  const whyCmp = useMemo(() => (sheet === 'why' && ply > 0 ? gameMoveComparison(game, ply) : undefined), [sheet, game, ply]);
  const whySheet = evalAt ? (
    <div className="gr-why">
      {plyFinding && !hiddenPlies.has(ply) && <CoachText text={plyFinding.evidence} className="why-headline" />}
      {verdict && evalAt.bestSan && !evalAt.isBest && (
        <p className="engine-line">
          <span className="engine-chip">Stockfish</span> preferred {evalAt.bestSan}: {formatCp(evalAt.cpBefore * (mine ? 1 : -1))} instead of {formatCp(evalAt.cpAfter * (mine ? 1 : -1))}, your view.
        </p>
      )}
      {whyCmp?.comparison && (
        <div className="why-box">
          <span className="eyebrow">Why {whyCmp.bestSan} leads to a better position</span>
          <CoachText text={whyCmp.comparison.summary} />
        </div>
      )}
      {mine ? (
        aiOn ? (
          <AiExplain game={game} ply={ply} bestSan={evalAt.bestSan} askLabel="Ask the AI coach" />
        ) : (
          <p className="muted small ai-status">{aiBlocker ?? (llm.provider ? 'AI explanations are switched off (Settings) — the explanation above is from Stockfish.' : 'AI explanations aren’t set up on this deployment — the explanation above is from Stockfish.')}</p>
        )
      ) : (
        <>
          <p className="muted small">This was {game.opponentName}'s move.</p>
          {(cls === 'mistake' || cls === 'blunder') && canRefute && (
            <button className="btn ghost small" onClick={() => (setSheet(null), lineView.open(ply, 'refutation'))}>
              Show how to punish it
            </button>
          )}
        </>
      )}
    </div>
  ) : null;
  const moreSheet = (
    <div className="gr-more-body">
      {mode === 'browse' ? browsePrompt : panels.prompt}
      {active && seenBefore && (
        <div className="seen-before">
          <span className="eyebrow">You've seen this before</span>
          <p>
            {seenBefore.exact ? 'The same kind of mistake' : 'A related mistake'} came up in your game vs <b>{seenBefore.game.opponentName}</b>: {seenBefore.finding.evidence}
            {seenBefore.count >= 2 ? ` That's ${seenBefore.count + 1} games now.` : ''}
          </p>
          <button className="link" onClick={() => navigate(`/game/${seenBefore.game.id}/review?ply=${seenBefore.finding.ply}`)}>
            Open that position →
          </button>
        </div>
      )}
      {panels.details}
      {mode === 'browse' && moments.length > 0 && (
        <div className="moment-index">
          <span className="eyebrow">Lessons & notes</span>
          {moments.map((x) => (
            <button key={x.id} className={`chip ${x.kind === 'good_idea' ? 'good' : ''}`} onClick={() => (setSheet(null), x.tier === 'note' ? (setActive(undefined), setPracticePly(null), setPly(x.ply)) : startMomentAt(x))}>
              {doneIds.has(x.id) ? '✓ ' : x.kind === 'good_idea' ? '★ ' : x.tier === 'lesson' ? '? ' : ''}
              {moveLabel(game.plies[x.ply - 1])}
            </button>
          ))}
        </div>
      )}
      {mode === 'browse' && nextMoment && !upcoming && (
        <button className="btn ghost small" onClick={() => (setSheet(null), startMomentAt(nextMoment))}>
          Skip ahead to the next lesson ({moveLabel(game.plies[nextMoment.ply - 1])})
        </button>
      )}
    </div>
  );

  return (
    <HoverProvider>
      <div className={`gr mode-${mode}`} ref={topRef}>
        <EvalStrip whiteCp={evalHere} userColor={game.userColor} />
        {mode === 'browse' ? (
          <CoachBubble head={browseHead} onMore={() => setSheet('more')} extra={moreExtra}>
            <CoachText text={bubbleLine} />
          </CoachBubble>
        ) : mode === 'steps' ? (
          <CoachBubble
            head={
              <>
                <b>{steps!.title}</b>
                <span className="gr-head-eval">
                  {Math.max(0, steps!.idx + 1)}/{steps!.total}
                </span>
              </>
            }
          >
            <CoachText text={steps!.caption} />
          </CoachBubble>
        ) : (
          <CoachBubble tall onMore={() => setSheet('more')}>
            {panels.prompt}
          </CoachBubble>
        )}
        <BoardZone>
          <Board {...panels.board} />
        </BoardZone>
        <div className="gr-strip">
          <button className="gr-arrow" aria-label="Previous move" onClick={prev}>
            <Icon name="back" size={20} />
          </button>
          <MoveStrip plies={game.plies} current={active ? active.ply - 1 : ply} marks={marks} badges={badges} onSelect={jump} />
          <button className="gr-arrow" aria-label="Next move" onClick={next}>
            <Icon name="forward" size={20} />
          </button>
        </div>
        {mode === 'browse' && actionBar}
        {mode === 'focus' && <div className="gr-dock">{panels.banner}</div>}
        {mode === 'steps' && (
          <DockSheet onClose={lineView.close}>
            {panels.prompt}
            {panels.banner}
          </DockSheet>
        )}
        <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet === 'why' ? `Why? — ${current ? moveLabel(current) : ''}` : mode === 'browse' ? (current ? moveLabel(current) : 'Start') : 'The full explanation'}>
          {sheet === 'why' ? whySheet : moreSheet}
        </BottomSheet>
      </div>
    </HoverProvider>
  );
}
