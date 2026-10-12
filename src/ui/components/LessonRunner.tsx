// An interactive lesson for one of the 1–2 most valuable moments of a game.
//   1. a question — "What is White's strongest reply?" or "Find a better move";
//   2. graded feedback by quality band (best / equally good / reasonable / refuted),
//      with a retry, and for a refuted try the opponent's concrete answer;
//   3. the point: both lines up to where something actually changes, side by side;
//   4. the take-away, and an optional deeper exploration.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Arrow, Color, PositionEval, SequenceFrame, StoredGame, TeachingMoment } from '../../domain/types';
import { COLOR_NAME, other, playLine } from '../../chess/board';
import { moveLabel } from '../../chess/pgn';
import { positionCp, scoreToCp } from '../../analysis/evaluation';
import { QUALITY_LABEL, gapBetween, qualityOf, qualityOfGap, type Quality } from '../../analysis/moveQuality';
import { lineToPoint, type LinePoint } from '../../analysis/linePoint';
import { compareLines } from '../../analysis/compareLines';
import { bandChange } from '../../analysis/evalBand';
import { analysePosition, markMomentDone } from '../actions';
import { CoachText } from './CoachText';
import { EvalChange } from './EvalBar';
import { Verdict, type Panels } from './reviewParts';
import { gameMoveComparison } from './PracticeBoard';
import { AiExplain } from './AiExplain';

type Phase = 'ask_reply' | 'reply_feedback' | 'ask_find' | 'find_feedback' | 'point' | 'wrap';
type Grade = 'right' | 'reasonable' | 'refuted';

interface Attempt {
  uci: string;
  san: string;
  fen: string;
  quality?: Quality;
  grade?: Grade;
  /** For a refuted try: the opponent's answer and what it leads to. */
  refutation?: { uci: string; point: LinePoint };
  /** For a reasonable try: what it misses compared with the best move. */
  misses?: string;
  checking: boolean;
}

const arrow = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });
const gradeOf = (q: Quality): Grade => (q === 'best' || q === 'equal' ? 'right' : q === 'good' || q === 'inaccuracy' ? 'reasonable' : 'refuted');

/** Frames of a line with a ‹ › stepper. */
function useStepper(frames: SequenceFrame[], key: string) {
  const [i, setI] = useState(frames.length);
  useEffect(() => setI(0), [key]);
  useEffect(() => {
    if (i >= frames.length) return;
    const t = window.setTimeout(() => setI((x) => x + 1), 900);
    return () => window.clearTimeout(t);
  }, [i, frames.length, key]);
  return { i: Math.min(i, frames.length), set: setI };
}

export function useLessonRunner(
  game: StoredGame,
  m: TeachingMoment | undefined,
  onDone: () => void,
  onSkip: () => void,
  onExplore: (ply: number) => void,
): Panels | null {
  const isLesson = !!m && m.kind === 'mistake' && m.tier === 'lesson';
  const [phase, setPhase] = useState<Phase>('ask_find');
  const [reply, setReply] = useState<Attempt | null>(null);
  const [find, setFind] = useState<Attempt | null>(null);
  const [tries, setTries] = useState(0);
  const [lineView, setLineView] = useState<'best' | 'game'>('best');
  const token = useRef(0);

  useEffect(() => {
    token.current++;
    setPhase(m?.question === 'predict_reply' ? 'ask_reply' : 'ask_find');
    setReply(null);
    setFind(null);
    setTries(0);
    setLineView('best');
  }, [m?.id, m?.question]);

  const positions = game.analysis?.positions ?? [];
  const played = m ? game.plies[m.ply - 1] : undefined;
  const betterPly = m ? game.plies[m.betterPly - 1] : undefined;
  const user = game.userColor;
  const opp: Color = other(user);
  const oppName = COLOR_NAME[opp];

  // The game move vs Stockfish's choice, with both lines cut where they make their point.
  const cmp = useMemo(() => (isLesson && m ? gameMoveComparison(game, m.betterPly) : undefined), [game, m, isLesson]);
  // The refutation of the game move: the opponent's best line up to its point.
  const refPoint = useMemo(() => {
    if (!isLesson || !m || !played) return undefined;
    const pv = positions[m.ply]?.lines[0]?.pv ?? [];
    return pv.length ? lineToPoint(played.fenAfter, pv, user, 8) : undefined;
  }, [isLesson, m, played, positions, user]);

  const replyFrames = refPoint?.frames ?? [];
  const pointLine = phase === 'point' ? (lineView === 'best' ? cmp?.comparison?.preferredFrames ?? [] : cmp?.comparison?.otherFrames ?? []) : [];
  const stepFrames = phase === 'reply_feedback' ? replyFrames : phase === 'point' ? pointLine : [];
  const stepper = useStepper(stepFrames, `${m?.id}:${phase}:${lineView}`);

  if (!isLesson || !m || !played || !betterPly) return null;

  const cpBefore = game.analysis?.moves[m.ply - 1]?.cpBefore ?? 0;
  const cpAfter = game.analysis?.moves[m.ply - 1]?.cpAfter ?? 0;
  const swing = bandChange(cpBefore, cpAfter);
  const bestSan = cmp?.bestSan ?? m.bestSan ?? '';
  const t = m.text;
  const btn = (label: string, onClick: () => void, kind: 'primary' | 'ghost' = 'primary', disabled = false) => (
    <button key={label} className={`btn ${kind}`} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
  const head = (
    <div className="moment-head">
      <span className="tag">Lesson · {m.priority === 1 ? 'what did you allow?' : m.priority === 2 ? 'missed chance' : m.priority === 6 ? 'a cleaner move' : 'key moment'}</span>
    </div>
  );
  const title = <h2 className="moment-title">{t.title}</h2>;
  const stepButtons = (frames: SequenceFrame[]) =>
    frames.length > 0 && (
      <div className="sequence">
        <button className="icon" aria-label="Previous" onClick={() => stepper.set(Math.max(0, stepper.i - 1))}>
          ‹
        </button>
        <div className="seq-moves">
          {frames.map((f, k) => (
            <span key={k} className={k === stepper.i - 1 ? 'on' : ''} onClick={() => stepper.set(k + 1)}>
              {f.san}
            </span>
          ))}
        </div>
        <button className="icon" aria-label="Next" onClick={() => stepper.set(Math.min(frames.length, stepper.i + 1))}>
          ›
        </button>
      </div>
    );
  const frameBoard = (startFen: string, frames: SequenceFrame[], first: Arrow[] = []) => {
    const f = stepper.i > 0 ? frames[stepper.i - 1] : undefined;
    return { fen: f?.fen ?? startFen, orientation: user, lastMove: f ? { from: f.from, to: f.to } : undefined, arrows: f ? [] : first };
  };

  // ------------------------------------------------ predict the opponent's reply
  if (phase === 'ask_reply' || phase === 'reply_feedback') {
    const onReply = (uci: string, san: string, fen: string) => {
      if (reply && !reply.checking && reply.grade === 'right') return false;
      const my = token.current;
      const pos = positions[m.ply];
      const known = qualityOf(pos, uci);
      const attempt: Attempt = { uci, san, fen, checking: !known, quality: known };
      if (known) {
        attempt.grade = gradeOf(known);
        setReply(attempt);
        setTries((n) => n + 1);
        if (attempt.grade === 'right') setPhase('reply_feedback');
        return true;
      }
      setReply(attempt);
      void analysePosition(fen, 12, 1).then((res) => {
        if (token.current !== my) return;
        const best = pos?.lines[0] ? scoreToCp(pos.lines[0].score) : 0;
        const q = res ? qualityOfGap(gapBetween(best, -positionCp(res))) : 'inaccuracy';
        setReply({ ...attempt, quality: q, grade: gradeOf(q), checking: false });
        setTries((n) => n + 1);
        if (gradeOf(q) === 'right') setPhase('reply_feedback');
      });
      return true;
    };
    const showing = phase === 'reply_feedback';
    const verdict = !reply ? (
      <Verdict tone="neutral" title={`Your turn: play ${oppName}'s strongest reply`} text="Drag a piece, or tap it and then the square." />
    ) : reply.checking ? (
      <Verdict tone="neutral" title={`Checking ${reply.san}…`} />
    ) : reply.grade === 'right' ? (
      <Verdict tone="good" title={`Right — ${reply.san}${reply.quality === 'equal' ? ` (as strong as ${m.refutationSan})` : ''}`} text={refPoint ? `What happens: ${refPoint.text}.` : undefined} />
    ) : showing ? (
      <Verdict
        tone="bad"
        title={`${oppName}'s strongest reply was ${m.refutationSan}`}
        text={`${reply.grade === 'reasonable' ? `${reply.san} is reasonable, but` : `${reply.san} would let you off the hook —`} ${m.refutationSan} is stronger. ${refPoint ? `What happens: ${refPoint.text}.` : ''}`}
      />
    ) : (
      <Verdict
        tone="bad"
        title={reply.grade === 'reasonable' ? `${reply.san} is reasonable — but there's something stronger` : `Not quite — ${reply.san} lets you off the hook`}
        text="Look for checks, captures and threats first. Try again, or see the answer."
      />
    );
    return {
      board: showing
        ? frameBoard(played.fenAfter, replyFrames, m.refutationUci ? [arrow(m.refutationUci, 'reply')] : [])
        : {
            fen: reply && !reply.checking && reply.grade !== 'right' ? played.fenAfter : reply?.fen ?? played.fenAfter,
            orientation: user,
            arrows: reply ? [arrow(reply.uci, 'guess')] : [arrow(played.uci, 'played')],
            lastMove: reply ? undefined : { from: played.from, to: played.to },
            movable: reply?.checking ? undefined : opp,
            onMove: onReply,
          },
      prompt: (
        <>
          {head}
          {title}
          <p>
            You played <b>{moveLabel(played)}</b>. Before we look at anything else: what is <b>{oppName}'s strongest reply</b>? Play it for {oppName}.
          </p>
          {showing && <EvalChange before={cpBefore} after={cpAfter} />}
          {showing && <p className="muted small">{swing.text.charAt(0).toUpperCase() + swing.text.slice(1)}.</p>}
        </>
      ),
      banner: (
        <>
          {verdict}
          {showing && stepButtons(replyFrames)}
          <div className="actions">
            {!showing && reply && !reply.checking && reply.grade !== 'right' && btn('Try again', () => setReply(null), 'ghost')}
            {!showing && reply && !reply.checking && reply.grade !== 'right' && tries >= 1 && btn('Show the answer', () => setPhase('reply_feedback'), 'ghost')}
            {!showing && !reply && btn('Skip lesson', onSkip, 'ghost')}
            {showing && btn(`Now find a better move than ${played.san} →`, () => setPhase('ask_find'))}
          </div>
        </>
      ),
      details: null,
      stateKey: `lesson:${m.id}:${phase}:${reply?.uci ?? ''}:${reply?.checking}`,
    };
  }

  // ------------------------------------------------------ find a better move
  if (phase === 'ask_find' || phase === 'find_feedback') {
    const pos: PositionEval | undefined = positions[m.betterPly - 1];
    const onFind = (uci: string, san: string, fen: string) => {
      if (find && (find.checking || find.grade === 'right')) return false;
      if (uci === betterPly.uci) {
        setFind({ uci, san, fen, checking: false, grade: 'refuted', quality: undefined, misses: `That's the game move. Look for something different.` });
        return true;
      }
      const my = token.current;
      const attempt: Attempt = { uci, san, fen, checking: true };
      setFind(attempt);
      const bestCp = pos?.lines[0] ? scoreToCp(pos.lines[0].score) : 0;
      void analysePosition(fen, 14, 1).then((res) => {
        if (token.current !== my) return;
        const cp = res ? -positionCp(res) : bestCp;
        const q = qualityOf(pos, uci, cp) ?? qualityOfGap(gapBetween(bestCp, cp));
        const grade = gradeOf(q);
        const next: Attempt = { ...attempt, quality: q, grade, checking: false };
        const answer = res?.lines[0]?.pv ?? [];
        if (grade === 'refuted' && answer.length) next.refutation = { uci: answer[0], point: lineToPoint(fen, answer, user, 8) };
        if (grade === 'reasonable' && pos?.lines[0]) {
          const c = compareLines({ fen: betterPly.fenBefore, mover: user, preferred: { ucis: pos.lines[0].pv, cp: bestCp }, other: { ucis: [uci, ...answer], cp } });
          next.misses = c?.summary;
        }
        setFind(next);
        setTries((n) => n + 1);
        if (grade === 'right') setPhase('find_feedback');
      });
      return true;
    };
    const ask =
      m.question === 'cleaner'
        ? `Your move ${played.san} was playable, but there's a cleaner move. Try to find it.`
        : m.priority === 2
          ? `There was something much stronger than ${played.san} here. Find it.`
          : phase === 'ask_find' && m.question === 'predict_reply'
            ? `Find a move that doesn't allow ${m.refutationSan}.`
            : `Find a better move than ${played.san}.`;
    const revealed = phase === 'find_feedback';
    const f = find;
    const verdict = !f ? (
      <Verdict tone="neutral" title={`Your turn: play a move for ${COLOR_NAME[user]}`} text="Drag a piece, or tap it and then the square." />
    ) : f.checking ? (
      <Verdict tone="neutral" title={`Checking ${f.san}…`} />
    ) : f.grade === 'right' ? (
      <Verdict
        tone="good"
        title={f.quality === 'best' ? `Right — ${f.san} is Stockfish's choice` : `Right — ${f.san} is as good as ${bestSan}`}
        text={cmp?.alternatives.length ? `Also fine here: ${cmp.alternatives.filter((a) => a !== f.san).concat(f.san === bestSan ? [] : [bestSan]).join(', ')}.` : undefined}
      />
    ) : revealed ? (
      <Verdict tone="neutral" title={`The move to find: ${bestSan}`} text={cmp?.alternatives.length ? `Just as good: ${cmp.alternatives.join(', ')}.` : undefined} />
    ) : f.grade === 'reasonable' ? (
      <Verdict tone="neutral" title={`Playable — ${f.san} (${QUALITY_LABEL[f.quality!].toLowerCase()})`} text={f.misses ? `But it misses something. ${f.misses}` : 'But there is something stronger. Try again?'} />
    ) : f.refutation ? (
      <Verdict tone="bad" title={`${f.san} runs into ${playLine(f.fen, [f.refutation.uci])[0]?.san ?? 'a strong reply'}`} text={`After ${f.san}, ${oppName} answers ${playLine(f.fen, [f.refutation.uci])[0]?.san}: ${f.refutation.point.text}. Try again?`} />
    ) : (
      <Verdict tone="bad" title={`Not quite — ${f.san}`} text={f.misses ?? 'Try again, or see the answer.'} />
    );
    const showBest = revealed && !(f && f.grade === 'right');
    return {
      board:
        f && !f.checking && f.grade !== 'right' && !revealed
          ? {
              fen: betterPly.fenBefore,
              orientation: user,
              arrows: [arrow(f.uci, 'guess'), ...(f.refutation ? [] : [])],
              movable: user,
              onMove: onFind,
            }
          : revealed
            ? { fen: betterPly.fenBefore, orientation: user, arrows: [...(showBest ? [] : [arrow(f!.uci, 'guess')]), ...(cmp ? [arrow(cmp.bestUci, 'best')] : [])] }
            : {
                fen: f?.fen ?? betterPly.fenBefore,
                orientation: user,
                arrows: f ? [arrow(f.uci, 'guess')] : [],
                movable: f?.checking ? undefined : user,
                onMove: onFind,
              },
      prompt: (
        <>
          {head}
          {title}
          <p>{ask}</p>
          {m.question !== 'predict_reply' && <EvalChange before={cpBefore} after={cpAfter} />}
        </>
      ),
      banner: (
        <>
          {verdict}
          <div className="actions">
            {f && !f.checking && f.grade !== 'right' && !revealed && btn('Try again', () => setFind(null), 'ghost')}
            {f && !f.checking && f.grade !== 'right' && !revealed && btn('Show the answer', () => setPhase('find_feedback'), 'ghost')}
            {!f && !revealed && tries === 0 && btn('Show the answer', () => setPhase('find_feedback'), 'ghost')}
            {revealed && btn('Why it matters →', () => setPhase('point'))}
          </div>
        </>
      ),
      details: null,
      stateKey: `lesson:${m.id}:${phase}:${f?.uci ?? ''}:${f?.checking}:${f?.grade}`,
    };
  }

  // ------------------------------------------- the point: where each move leads
  const c = cmp?.comparison;
  if (phase === 'point') {
    const frames = lineView === 'best' ? c?.preferredFrames ?? [] : c?.otherFrames ?? [];
    return {
      board: frameBoard(betterPly.fenBefore, frames, [arrow(lineView === 'best' ? cmp?.bestUci ?? '' : betterPly.uci, lineView === 'best' ? 'best' : 'played')]),
      prompt: (
        <>
          {head}
          <h2 className="moment-title">
            {bestSan} vs {betterPly.san}: where each move leads
          </h2>
          {c ? (
            <div className="compare-card">
              <div className={`cc-col ${lineView === 'best' ? 'on' : ''}`} onClick={() => setLineView('best')}>
                <div className="cc-head">After {bestSan}</div>
                {c.card.preferred.map((r, k) => (
                  <div key={k} className={`cc-row ${r.tone}`}>
                    {r.text}
                  </div>
                ))}
              </div>
              <div className={`cc-col ${lineView === 'game' ? 'on' : ''}`} onClick={() => setLineView('game')}>
                <div className="cc-head">After {betterPly.san} (game)</div>
                {c.card.other.map((r, k) => (
                  <div key={k} className={`cc-row ${r.tone}`}>
                    {r.text}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {c && <CoachText text={c.summary} className="ply-note" />}
          <p className="muted small">Tap a column to play through that line on the board.</p>
          <AiExplain game={game} ply={m.betterPly} bestSan={bestSan} auto />
        </>
      ),
      banner: (
        <>
          {stepButtons(frames)}
          <div className="actions">{btn('Take-away →', () => setPhase('wrap'))}</div>
        </>
      ),
      details: null,
      stateKey: `lesson:${m.id}:point:${lineView}`,
    };
  }

  // --------------------------------------------------------------- take-away
  return {
    board: { fen: betterPly.fenBefore, orientation: user, arrows: cmp ? [arrow(betterPly.uci, 'played'), arrow(cmp.bestUci, 'best')] : [] },
    prompt: (
      <>
        {head}
        <div className="lesson">
          <span className="lesson-label">Take-away</span>
          <CoachText text={t.lesson} />
        </div>
        {cmp && cmp.alternatives.length > 0 && <p className="muted small">Moves as good as {bestSan} here: {cmp.alternatives.join(', ')}.</p>}
      </>
    ),
    banner: (
      <div className="actions">
        {btn('Explore the position', () => onExplore(m.betterPly), 'ghost')}
        {btn('Continue the game →', () => {
          void markMomentDone(game.id, m.id);
          onDone();
        })}
      </div>
    ),
    details: null,
    stateKey: `lesson:${m.id}:wrap`,
  };
}
