import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiWalkthrough, Arrow, BetaCoachReview, StoredGame, WalkEvent } from '../../domain/types';
import { aiWalkthrough, analysePosition } from '../actions';
import { useApp } from '../store';
import { betaPositions } from '../../coach/betaCoach';
import { EVALUATE_PROMPT, currentWalkthrough, evaluationFeedback, gradeEvaluation, gradeOf, knownQuality, qualityFromAfter, walkGrounding, type Grade } from '../../coach/walkthrough';
import { materialSummary } from '../../analysis/linePoint';
import { QUALITY_LABEL, gapBetween, qualityOfGap, type Quality } from '../../analysis/moveQuality';
import { positionCp, scoreToCp } from '../../analysis/evaluation';
import { lineToSan, other, sideToMove } from '../../chess/board';
import { moveLabel } from '../../chess/pgn';
import { Board } from './Board';
import { MoveStrip } from './MoveStrip';
import { CoachText, HoverProvider } from './CoachText';
import { Verdict } from './reviewParts';
import { usePracticeBoard } from './PracticeBoard';
import { useAiAvailable } from './AiExplain';
import { useKeepTop } from './useKeepTop';

/** Walkthroughs whose automatic first write failed this session (not retried on every visit). */
const failed = new Set<string>();

interface Answer {
  grade: Grade | null; // null: the student asked to be shown
  text: string;
  note?: string;
  arrows?: Arrow[];
}

const GRADE_TITLE: Record<Grade, string> = { correct: 'You found the idea', reasonable: 'Reasonable', misses: 'Misses the idea' };
const GRADE_TONE: Record<Grade, 'good' | 'neutral' | 'bad'> = { correct: 'good', reasonable: 'neutral', misses: 'bad' };

/**
 * The AI walkthrough: the game replayed on the board with the coach's pacing — skipping
 * routine moves, a sentence here and there, pauses for real explanations, and a few
 * questions graded by Stockfish. Everything comes from one cached plan; no AI calls here.
 */
export function AiWalkthroughView({ game, plan }: { game: StoredGame; plan: BetaCoachReview | undefined }) {
  const { refresh } = useApp();
  const available = useAiAvailable();
  const w = currentWalkthrough(game, plan);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');

  const run = async (force: boolean) => {
    setState('loading');
    setStage('Starting…');
    try {
      await aiWalkthrough(game.id, { force, onProgress: setStage });
      await refresh();
      setState('idle');
    } catch (e) {
      if (!force) failed.add(game.id);
      setError((e as Error).message);
      setState('error');
    }
  };
  useEffect(() => {
    if (available && !w && state === 'idle' && !failed.has(game.id)) void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, w, game.id]);

  if (!w || !plan) {
    return (
      <section className="card">
        {state === 'loading' && <p className="muted small">{stage}</p>}
        {state === 'error' && <p className="feedback bad small">The AI walkthrough failed: {error}</p>}
        {available && state !== 'loading' && (
          <button className="btn ghost small" onClick={() => run(false)}>
            Write the AI walkthrough
          </button>
        )}
        {!available && <p className="muted small">The AI coach isn't available (check the access code in Settings).</p>}
      </section>
    );
  }
  const stale = w.grounding !== walkGrounding(plan);
  return (
    <>
      {stale && (
        <p className="muted small">
          This walkthrough was written from an earlier lesson plan.{' '}
          <button className="link" disabled={state === 'loading'} onClick={() => run(true)}>
            Rewrite it
          </button>
        </p>
      )}
      <Walk key={w.createdAt} game={game} plan={plan} w={w} onRegenerate={() => run(true)} busy={state === 'loading' ? stage : undefined} />
    </>
  );
}

function Walk({ game, plan, w, onRegenerate, busy }: { game: StoredGame; plan: BetaCoachReview; w: AiWalkthrough; onRegenerate: () => void; busy?: string }) {
  const user = game.userColor;
  const n = game.plies.length;
  const positions = useMemo(() => betaPositions(game), [game]);
  const cpUser = (i: number) => {
    const p = positions[i];
    if (!p) return 0;
    const v = positionCp(p);
    return sideToMove(p.fen) === user ? v : -v;
  };
  const stops = w.events;
  const stopPos = (e: WalkEvent) => (e.timing === 'before' ? e.ply - 1 : e.ply);

  const [pos, setPos] = useState(0);
  const [stopIdx, setStopIdx] = useState(-1); // -1: intro; stops.length: the end
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [checking, setChecking] = useState(false);
  const [exploreFor, setExploreFor] = useState<number | null>(null);
  const practice = usePracticeBoard(game, exploreFor, () => setExploreFor(null));
  const anim = useRef(0);
  const [moving, setMoving] = useState(false);

  /** At a "find your move" question: did the student already play a move as good as Stockfish's here? */
  const playedWell = (e: WalkEvent) => {
    if (!e.interaction || e.interaction.kind === 'predict_reply' || e.interaction.kind === 'evaluate_position') return false;
    const p = game.plies[e.ply - 1];
    const q = knownQuality(positions[e.ply - 1], p.uci)?.quality;
    return p.color === user && (q === 'best' || q === 'equal');
  };
  const ev: WalkEvent | undefined = !moving && stopIdx >= 0 && stopIdx < stops.length && stopPos(stops[stopIdx]) === pos ? stops[stopIdx] : undefined;
  const waiting = ev?.type === 'interactive' && !answer;
  const fen = pos === 0 ? game.plies[0].fenBefore : game.plies[pos - 1].fenAfter;
  const last = pos > 0 ? game.plies[pos - 1] : undefined;

  /** Play through to `target`, one move at a time, then land on stop `idx`. */
  const goTo = (target: number, idx: number) => {
    const token = ++anim.current;
    setAnswer(null);
    setExploreFor(null);
    const step = (p: number) => {
      if (token !== anim.current) return;
      setPos(p);
      if (p >= target) {
        setMoving(false);
        return setStopIdx(idx);
      }
      window.setTimeout(() => step(p + 1), 320);
    };
    if (target <= pos) {
      setMoving(false);
      setPos(target);
      setStopIdx(idx);
    } else {
      setMoving(true);
      step(pos + 1);
    }
  };
  const next = () => {
    if (waiting || moving) return;
    const i = stopIdx + 1;
    if (i >= stops.length) return goTo(n, stops.length);
    goTo(stopPos(stops[i]), i);
  };
  const back = () => {
    const i = Math.max(-1, Math.min(stopIdx, stops.length) - 1);
    anim.current++;
    setMoving(false);
    setAnswer(null);
    setExploreFor(null);
    setStopIdx(i);
    setPos(i >= 0 ? stopPos(stops[i]) : 0);
  };
  /** Manual stepping: shows whatever stop is at that position. */
  const stepTo = (p: number) => {
    anim.current++;
    setMoving(false);
    setAnswer(null);
    setExploreFor(null);
    const q = Math.max(0, Math.min(n, p));
    setPos(q);
    let idx = -1;
    stops.forEach((e, i) => stopPos(e) <= q && (idx = i));
    setStopIdx(idx);
  };

  // ------------------------------------------------------------ grading ---
  const bestArrows = (ply: number): Arrow[] => {
    const p = game.plies[ply - 1];
    const best = positions[ply - 1]?.lines[0]?.pv[0];
    const arrows: Arrow[] = [{ from: p.from, to: p.to, color: 'played' }];
    if (best && best !== p.uci) arrows.push({ from: best.slice(0, 2), to: best.slice(2, 4), color: 'best' });
    return arrows;
  };
  const sanAt = (fenAt: string, uci: string) => lineToSan(fenAt, [uci], 1)[0] ?? uci;

  /** Grade a move at position index `at` (the mover's point of view), from stored lines or a quick live check. */
  const gradeMove = async (at: number, uci: string, fenAfter: string): Promise<{ quality: Quality; cp: number }> => {
    const pos0 = positions[at];
    const known = knownQuality(pos0, uci);
    if (known) return known;
    const after = await analysePosition(fenAfter, 14, 1);
    if (!after) throw new Error('Stockfish is not available to check this move.');
    return qualityFromAfter(pos0, uci, after);
  };
  const respond = (e: WalkEvent, grade: Grade | null, note?: string, arrows?: Arrow[]) =>
    setAnswer({ grade, text: grade ? e.interaction!.feedback[grade] : '', note, arrows });

  const onBoardMove = (uci: string, san: string, fenAfter: string) => {
    if (!ev?.interaction || answer || checking) return false;
    const at = ev.interaction.kind === 'predict_reply' ? ev.ply : ev.ply - 1;
    setChecking(true);
    void gradeMove(at, uci, fenAfter)
      .then((r) => {
        const fenAt = at === 0 ? game.plies[0].fenBefore : game.plies[at - 1].fenAfter;
        const best = positions[at].lines[0]?.pv[0];
        const bestSan = best ? sanAt(fenAt, best) : undefined;
        const who = ev.interaction!.kind === 'predict_reply' ? `${user === 'w' ? 'Black' : 'White'}'s` : 'your';
        const note = `Stockfish rates ${san}: ${QUALITY_LABEL[r.quality].toLowerCase()}${bestSan && bestSan !== san ? ` — ${who === 'your' ? 'its first choice' : `${who} strongest`} was ${bestSan}` : ''}.`;
        const asPlayed = ev.interaction!.kind !== 'predict_reply' && uci === game.plies[ev.ply - 1].uci;
        const arrows: Arrow[] = [{ from: uci.slice(0, 2), to: uci.slice(2, 4), color: 'guess' }];
        if (best && best !== uci) arrows.push({ from: best.slice(0, 2), to: best.slice(2, 4), color: 'best' });
        respond(ev, gradeOf(r.quality), asPlayed ? `${note} That's what you played in the game.` : note, arrows);
      })
      .catch((err: Error) => respond(ev, null, err.message))
      .finally(() => setChecking(false));
    return false; // the board stays on the game position; the guess is shown as an arrow
  };
  const onOption = (uci: string, san: string) => {
    if (!ev?.interaction || answer) return;
    const at = ev.ply - 1;
    const known = knownQuality(positions[at], uci);
    let quality: Quality;
    if (known) quality = known.quality;
    else {
      // The move played, when it isn't among the stored candidates: judged from the game's own evaluation.
      const bestCp = scoreToCp(positions[at].lines[0].score);
      quality = qualityOfGap(gapBetween(bestCp, -positionCp(positions[at + 1])), false);
    }
    respond(ev, gradeOf(quality), `Stockfish rates ${san}: ${QUALITY_LABEL[quality].toLowerCase()}.`, bestArrows(ev.ply));
  };
  const onEvaluate = (a: 'better' | 'equal' | 'worse') => {
    if (!ev?.interaction || answer) return;
    const at = ev.timing === 'before' ? ev.ply - 1 : ev.ply;
    const cp = cpUser(at);
    const last = at > 0 ? game.plies[at - 1] : undefined;
    const fenAt = last ? last.fenAfter : game.plies[0].fenBefore;
    const text = evaluationFeedback({
      cp,
      prevCp: at > 0 ? cpUser(at - 1) : undefined,
      lastMove: last ? { label: moveLabel(last), byOpponent: last.color !== user } : undefined,
      material: materialSummary(fenAt, user),
      opponent: user === 'w' ? 'Black' : 'White',
    });
    // The AI's feedback for this question is not used: it was written before the answer was known.
    setAnswer({ grade: gradeEvaluation(cp, a), text });
  };

  // ------------------------------------------------------------- render ---
  const counts = { interactive: 0, explain: 0, brief: 0 };
  stops.forEach((e) => counts[e.type]++);
  const skipped = n - new Set(stops.map((e) => e.ply)).size;

  const revealed = !!answer || (ev && ev.type !== 'interactive');
  const arrows: Arrow[] = answer?.arrows ?? (ev && revealed && ev.timing === 'before' ? bestArrows(ev.ply) : []);
  const movable =
    ev?.interaction && !answer && (ev.interaction.kind === 'find_move' || ev.interaction.kind === 'predict_reply')
      ? ev.interaction.kind === 'find_move'
        ? user
        : other(user)
      : undefined;

  const keepTop = useKeepTop<HTMLDivElement>(`${stopIdx}|${!!answer}|${moving}`);
  const marks = Object.fromEntries(stops.map((e) => [e.ply, e.type === 'interactive' ? ('good' as const) : ('note' as const)]));

  let commentary: React.ReactNode;
  if (moving) {
    commentary = <p className="muted small walk-card">Playing through…</p>;
  } else if (stopIdx === -1) {
    commentary = (
      <div className="walk-card">
        <span className="eyebrow">AI walkthrough · Beta</span>
        <CoachText text={plan.story} className="beta-para" />
        <p className="muted small">
          {stops.length} stops: {counts.interactive} question{counts.interactive === 1 ? '' : 's'}, {counts.explain} explanation{counts.explain === 1 ? '' : 's'}, {counts.brief} quick
          note{counts.brief === 1 ? '' : 's'}. The other {skipped} moves play through.
        </p>
      </div>
    );
  } else if (stopIdx >= stops.length) {
    commentary = (
      <div className="walk-card">
        <span className="eyebrow">What this game teaches you</span>
        {plan.lessons.map((l, i) => (
          <CoachText key={i} text={l} className="beta-para" />
        ))}
        {plan.practice.length > 0 && (
          <>
            <p className="small">Practise these positions:</p>
            <div className="walk-practice">
              {plan.practice.map((p) => (
                <button key={p.ply} className="btn ghost small" onClick={() => setExploreFor(p.ply)}>
                  Before {moveLabel(game.plies[p.ply - 1])}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="walk-actions">
          <button className="btn ghost" onClick={() => (setStopIdx(-1), setPos(0))}>
            Start again
          </button>
        </div>
      </div>
    );
  } else if (ev) {
    const seq = ev.sequenceId ? plan.sequences.find((q) => q.id === ev.sequenceId) : undefined;
    commentary = (
      <div className={`walk-card ${ev.type}`}>
        <div className="walk-head">
          <span className="walk-move">{ev.timing === 'before' ? `Before ${moveLabel(game.plies[ev.ply - 1])}` : moveLabel(game.plies[ev.ply - 1])}</span>
          {ev.title && <strong>{ev.title}</strong>}
        </div>
        {seq && (
          <p className="beta-cause small">
            <span>
              {game.plies[seq.decisionPly - 1].color === user ? 'Decision' : `${user === 'w' ? 'Black' : 'White'}'s decision`}: {moveLabel(game.plies[seq.decisionPly - 1])}
            </span>
            {seq.consequencePly && (
              <>
                <span aria-hidden="true">→</span>
                <span>Consequence: {moveLabel(game.plies[seq.consequencePly - 1])}</span>
              </>
            )}
          </p>
        )}
        {/* "Who is better?" narration is evaluative by nature: shown only once answered, so it can't give the answer away. */}
        {ev.narration && (ev.interaction?.kind !== 'evaluate_position' || answer) && <CoachText text={ev.narration} className="beta-para" />}
        {ev.interaction && (
          <div className="walk-question">
            {playedWell(ev) && <p className="walk-replay small">You found this in the game ({moveLabel(game.plies[ev.ply - 1])}). Find it again, and look for why it was right.</p>}
            <p>
              <strong>{ev.interaction.kind === 'evaluate_position' ? EVALUATE_PROMPT(user === 'w' ? 'White' : 'Black') : ev.interaction.prompt}</strong>
            </p>
            {!answer && ev.interaction.hint && ev.interaction.kind !== 'evaluate_position' && <p className="muted small">Hint: {ev.interaction.hint}</p>}
            {!answer && (ev.interaction.kind === 'find_move' || ev.interaction.kind === 'predict_reply') && (
              <p className="muted small">{checking ? 'Checking with Stockfish…' : `Play ${ev.interaction.kind === 'predict_reply' ? "your opponent's" : 'your'} move on the board.`}</p>
            )}
            {!answer && ev.interaction.options && (
              <div className="walk-options">
                {ev.interaction.options.map((o) => (
                  <button key={o.uci} className="btn ghost" onClick={() => onOption(o.uci, o.san)}>
                    <b>{o.san}</b> — {o.label}
                  </button>
                ))}
              </div>
            )}
            {!answer && ev.interaction.kind === 'evaluate_position' && (
              <div className="walk-options">
                {(['better', 'equal', 'worse'] as const).map((a) => (
                  <button key={a} className="btn ghost" onClick={() => onEvaluate(a)}>
                    {a === 'better' ? "I'm better" : a === 'equal' ? 'About equal' : "I'm worse"}
                  </button>
                ))}
              </div>
            )}
            {!answer && (
              <button className="link small" onClick={() => respond(ev, null)}>
                Show me
              </button>
            )}
            {answer && (
              <>
                {answer.grade && <Verdict tone={GRADE_TONE[answer.grade]} title={GRADE_TITLE[answer.grade]} text={answer.text} />}
                {answer.note && <p className="muted small">{answer.note}</p>}
                {ev.interaction.reveal && <CoachText text={ev.interaction.reveal} className="beta-para" />}
              </>
            )}
          </div>
        )}
        {revealed && ev.takeaway && (
          <p className="beta-lesson">
            <strong>Takeaway: </strong>
            <CoachText text={ev.takeaway} />
          </p>
        )}
        {revealed && ev.explore && (
          <div className="walk-explore small">
            <span className="muted">Lines worth trying:</span>
            <ul>
              {ev.explore.map((x) => (
                <li key={x.uci}>
                  <b>{x.san}</b> — <CoachText text={x.label} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {revealed && ev.timing === 'before' && (
          <button className="btn ghost small" onClick={() => setExploreFor(ev.ply)}>
            Explore this decision →
          </button>
        )}
      </div>
    );
  } else {
    commentary = <p className="muted small walk-card">Playing through… Tap Next for the coach's next stop.</p>;
  }

  if (practice) {
    return (
      <HoverProvider>
        <div className="rv walk">
          <div className="rv-grid">
            <div className="rv-prompt">{practice.prompt}</div>
            <div className="rv-board">
              <Board {...practice.board} />
            </div>
            <div className="rv-banner">
              {practice.banner}
              <button className="btn ghost small" onClick={() => setExploreFor(null)}>
                Return to the walkthrough
              </button>
            </div>
            <aside className="rv-side">
              {ev?.explore && (
                <div className="walk-explore small">
                  <span className="eyebrow">The coach's suggested lines</span>
                  <ul>
                    {ev.explore.map((x) => (
                      <li key={x.uci}>
                        <b>{x.san}</b> — <CoachText text={x.label} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {practice.details}
            </aside>
          </div>
        </div>
      </HoverProvider>
    );
  }

  return (
    <HoverProvider>
      <div className="rv walk" ref={keepTop}>
        <MoveStrip plies={game.plies} current={pos} marks={marks} onSelect={stepTo} />
        <div className="rv-grid">
          <div className="rv-prompt walk-progress small muted">
            {stopIdx >= 0 && stopIdx < stops.length ? `Stop ${stopIdx + 1} of ${stops.length}` : stopIdx === -1 ? 'Ready' : 'Finished'} · {pos === 0 ? 'start' : moveLabel(game.plies[pos - 1])}
          </div>
          <div className="rv-board">
            <Board fen={fen} orientation={user} arrows={arrows} lastMove={last ? { from: last.from, to: last.to } : undefined} movable={movable} onMove={onBoardMove} />
          </div>
          <div className="rv-banner">
            {commentary}
            <div className="walk-controls">
              <button className="btn ghost" onClick={back} disabled={stopIdx < 0} aria-label="Previous stop">
                ⏮
              </button>
              <button className="btn ghost" onClick={() => stepTo(pos - 1)} disabled={pos === 0} aria-label="Back one move">
                ‹
              </button>
              <button className="btn primary" onClick={next} disabled={waiting || moving || stopIdx >= stops.length}>
                {moving ? 'Playing through…' : waiting ? 'Answer or tap “Show me”' : stopIdx === -1 ? 'Start the walkthrough' : stopIdx + 1 >= stops.length ? 'Finish' : 'Next'}
              </button>
              <button className="btn ghost" onClick={() => stepTo(pos + 1)} disabled={pos >= n} aria-label="Forward one move">
                ›
              </button>
            </div>
          </div>
          <aside className="rv-side">
            <div className="walk-meta small muted">
              <p>
                Written {new Date(w.createdAt).toLocaleString()}
                {w.model ? ` by ${w.model}` : ''} from the same lesson plan as the AI Coach review.
                {w.removed.length ? ` ${w.removed.length} statement${w.removed.length > 1 ? 's' : ''} removed by the Stockfish referee.` : ''}
              </p>
              {busy ? (
                <p>{busy}</p>
              ) : (
                <button className="link small" onClick={onRegenerate}>
                  Rewrite the walkthrough
                </button>
              )}
            </div>
          </aside>
        </div>
      </div>
    </HoverProvider>
  );
}
