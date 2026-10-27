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
import { AiExplain } from '../components/AiExplain';
import { classifyMove, gapBetween, qualityOf, qualityOfGap, type MoveClass, type Quality } from '../../analysis/moveQuality';
import { EvalColumn, EvalGraph, QualityBadge, whiteEvals } from '../components/ReviewVisuals';
import { CoachText, HoverProvider } from '../components/CoachText';
import { MoveStrip } from '../components/MoveStrip';
import { categoryLabel } from '../../domain/categories';
import { moveLabel } from '../../chess/pgn';
import { COLOR_NAME, other, playLine } from '../../chess/board';
import { formatCp } from '../../analysis/evaluation';
import { engineNotes, verdictOf } from '../../analysis/engineReview';
import { closeToBest, evaluateMove, markMomentDone } from '../actions';
import { ENGINE_REPLY_CATEGORIES } from '../../analysis/moments';
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
  const engineReplyFirst = ENGINE_REPLY_CATEGORIES.includes(m.category);
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
  const practice = usePracticeBoard(game, practicePly, () => setPracticePly(null));
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
    (p) => setPracticePly(p),
  );
  const lesson = useLessonRunner(
    game,
    active,
    () => active && finish(active, true),
    () => active && finish(active, false),
    (p) => setPracticePly(p),
  );
  const seenBefore = useSeenBefore(game, active);
  // Only lessons stop the play-through; notes are shown in passing.
  const stopsAt = (m: TeachingMoment | undefined) => !!m && m.tier !== 'note' && !doneIds.has(m.id);

  const startMomentAt = (m: TeachingMoment) => {
    setPly(m.ply - 1);
    setActive(m);
  };
  const next = () => {
    if (active) return;
    const upcoming = momentAt.get(ply + 1);
    if (stopsAt(upcoming)) startMomentAt(upcoming!);
    else setPly((p) => Math.min(game.plies.length, p + 1));
  };
  const prev = () => (active ? setActive(undefined) : setPly((p) => Math.max(0, p - 1)));
  const nextMoment = moments.find((m) => m.ply > ply + 1 && stopsAt(m));

  // On phones the strip + question + board + verdict just fit the screen.
  // Keep that block aligned to the top whenever the move or the moment's state
  // changes, so the verdict is always visible and nothing jumps around.
  const stateKey = lesson?.stateKey ?? runner?.stateKey ?? `browse:${ply}`;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current && initialPly === undefined) {
      firstRender.current = false;
      return;
    }
    const initial = firstRender.current;
    firstRender.current = false;
    // Wait a frame so the board has its final size (matters when arriving from the summary).
    const id = window.setTimeout(() => {
      const el = topRef.current;
      if (!el || window.innerWidth > 860) return;
      const top = el.getBoundingClientRect().top + window.scrollY - 6;
      if (Math.abs(window.scrollY - top) > 3) window.scrollTo({ top, behavior: initial ? 'auto' : 'smooth' });
    }, initial ? 120 : 30);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey]);

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
  const hiddenPlies = useMemo(() => new Set(moments.filter((x) => x.tier !== 'note' && !doneIds.has(x.id)).map((x) => x.ply)), [moments, doneIds]);
  const badges = useMemo(() => {
    const out: Record<number, MoveClass | 'hidden'> = {};
    for (const [p, c] of Object.entries(classes)) out[Number(p)] = hiddenPlies.has(Number(p)) && Number(p) > ply ? 'hidden' : c;
    return out;
  }, [classes, hiddenPlies, ply]);
  const whites = useMemo(() => (game.analysis ? whiteEvals(game.plies, game.analysis.positions) : []), [game]);
  const graphMarks = useMemo(
    () => Object.fromEntries(Object.entries(badges).filter(([, c]) => c === 'inaccuracy' || c === 'mistake' || c === 'blunder' || c === 'brilliant' || c === 'great')) as Record<number, string>,
    [badges],
  );
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
      {evalAt && !evalAt.isBest && evalAt.bestSan && (game.analysis?.positions[ply - 1]?.lines[0]?.pv.length ?? 0) > 0 && (
        <button className="btn ghost small show-best" onClick={() => setPracticePly(ply)}>
          {mine ? `Explore: your move vs ${evalAt.bestSan}` : `Explore: ${evalAt.bestSan} instead`}
        </button>
      )}
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
            <button className="btn ghost small" onClick={() => setPracticePly(noteHere.betterPly)}>
              Explore
            </button>
          )}
          {noteHere.kind === 'mistake' && <AiExplain game={game} ply={noteHere.betterPly} bestSan={noteCmp?.bestSan} compact />}
        </div>
      )}
      {(!noteHere || noteHere.kind === 'good_idea') && evalAt && mine && !evalAt.isBest && <AiExplain game={game} ply={ply} bestSan={evalAt.bestSan} compact />}
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
  const browseBanner = (
    <>
      <div className="board-controls">
        <button className="icon" onClick={() => (setActive(undefined), setPly(0))} aria-label="Start">
          «
        </button>
        <button className="icon" onClick={prev} aria-label="Previous move">
          ‹
        </button>
        <button className="btn primary next-btn" onClick={next} disabled={ply >= game.plies.length}>
          {upcoming && !doneIds.has(upcoming.id) ? 'Next: stop & think' : 'Next'} ›
        </button>
        <button className="icon" onClick={() => (setActive(undefined), setPly(game.plies.length))} aria-label="End">
          »
        </button>
      </div>
      {nextMoment && !upcoming && (
        <div className="actions center">
          <button className="btn ghost" onClick={() => startMomentAt(nextMoment)}>
            Skip ahead to the next lesson ({moveLabel(game.plies[nextMoment.ply - 1])})
          </button>
        </div>
      )}
      {ply >= game.plies.length && (
        <div className="actions center">
          <button className="btn primary" onClick={() => navigate(`/game/${game.id}/drills`)}>
            Game over — practise the drills →
          </button>
        </div>
      )}
    </>
  );
  const browseDetails = evalAt ? (
    <p className="muted small">
      Engine after {moveLabel(game.plies[ply - 1])}: {formatCp(evalAt.cpAfter * (evalAt.color === game.userColor ? 1 : -1))} (your view)
    </p>
  ) : null;

  const panels: Panels = practice ?? lesson ?? runner ?? { board: browseBoard, prompt: browsePrompt, banner: browseBanner, details: browseDetails, stateKey };
  const marks = Object.fromEntries(
    moments.map((x) => [x.ply, doneIds.has(x.id) ? ('done' as const) : x.kind === 'good_idea' ? ('good' as const) : x.tier === 'note' ? ('note' as const) : ('bad' as const)]),
  );

  return (
    <HoverProvider>
      <div className={`rv ${active ? 'in-moment' : ''}`} ref={topRef}>
        {whites.length > 1 && (
          <EvalGraph values={whites} current={active ? active.ply - 1 : ply} marks={active ? {} : graphMarks} onSelect={(p) => (setPracticePly(null), setActive(undefined), setPly(p))} />
        )}
        <MoveStrip plies={game.plies} current={active ? active.ply - 1 : ply} marks={marks} badges={badges} onSelect={(p) => (setPracticePly(null), setActive(undefined), setPly(p))} />
        <div className="rv-grid">
          <div className={`rv-prompt ${active ? 'in-moment' : ''}`}>{panels.prompt}</div>
          <div className="rv-board">
            <div className="board-with-eval">
              <EvalColumn whiteCp={practice ? undefined : whites[active ? active.ply - 1 : ply]} orientation={game.userColor} />
              <div className="bwe-board">
                <Board {...panels.board} />
              </div>
            </div>
          </div>
          <div className="rv-banner">{panels.banner}</div>
          <aside className="rv-side">
            {active && seenBefore && (
              <div className="seen-before">
                <span className="eyebrow">You've seen this before</span>
                <p>
                  {seenBefore.exact ? 'The same kind of mistake' : 'A related mistake'} came up in your game vs <b>{seenBefore.game.opponentName}</b>:{' '}
                  {seenBefore.finding.evidence}
                  {seenBefore.count >= 2 ? ` That's ${seenBefore.count + 1} games now.` : ''}
                </p>
                <button className="link" onClick={() => navigate(`/game/${seenBefore.game.id}/review?ply=${seenBefore.finding.ply}`)}>
                  Open that position →
                </button>
              </div>
            )}
            {panels.details}
            <div className="legend">
              <span>
                <i style={{ background: 'rgb(214,128,38)' }} /> your move
              </span>
              <span>
                <i style={{ background: 'rgb(196,64,64)' }} /> opponent
              </span>
              <span>
                <i style={{ background: 'rgb(46,140,92)' }} /> better
              </span>
              <span>
                <i style={{ background: 'rgb(60,108,196)' }} /> your guess
              </span>
              {(['brilliant', 'great', 'best', 'equal', 'good', 'inaccuracy', 'mistake', 'blunder'] as const).map((c) => (
                <span key={c}>
                  <QualityBadge cls={c} label />
                </span>
              ))}
            </div>
            {moments.length > 0 && (
              <div className="moment-index">
                <span className="eyebrow">Lessons & notes</span>
                {moments.map((x) => (
                  <button key={x.id} className={`chip ${active?.id === x.id ? 'on' : ''} ${x.kind === 'good_idea' ? 'good' : ''}`} onClick={() => (x.tier === 'note' ? (setActive(undefined), setPracticePly(null), setPly(x.ply)) : startMomentAt(x))}>
                    {doneIds.has(x.id) ? '✓ ' : x.kind === 'good_idea' ? '★ ' : x.tier === 'lesson' ? '? ' : ''}
                    {moveLabel(game.plies[x.ply - 1])}
                  </button>
                ))}
              </div>
            )}
          </aside>
        </div>
      </div>
    </HoverProvider>
  );
}
