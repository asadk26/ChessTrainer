import { useEffect, useRef, useState } from 'react';
import type { Arrow, GradedMove, OpeningLesson, StoredGame, TrainingDrill, TrainingPlan } from '../../domain/types';
import { analysePosition, buildTraining } from '../actions';
import { useApp } from '../store';
import { gradeOf, type Grade } from '../../coach/walkthrough';
import { QUALITY_LABEL, gapBetween, qualityOfGap } from '../../analysis/moveQuality';
import { positionCp, scoreToCp } from '../../analysis/evaluation';
import { moveLabel } from '../../chess/pgn';
import { CATEGORY_LABEL } from '../../training/diagnosis';
import { Board } from './Board';
import { CoachText, HoverProvider } from './CoachText';
import { Verdict } from './reviewParts';
import { useKeepTop } from './useKeepTop';

const failed = new Set<string>();
const GRADE_TITLE: Record<Grade, string> = { correct: 'You found the idea', reasonable: 'Reasonable', misses: 'Misses the idea' };
const GRADE_TONE: Record<Grade, 'good' | 'neutral' | 'bad'> = { correct: 'good', reasonable: 'neutral', misses: 'bad' };
const FORMAT_LABEL: Record<TrainingDrill['format'], string> = {
  tactical_puzzle: 'Tactic',
  strategic_choice: 'Choose a plan',
  predict_threat: "Opponent's idea",
  compare_plans: 'Compare moves',
  replay_sequence: 'Replay & decide',
  endgame_technique: 'Endgame technique',
  why_good: 'Why it worked',
  opening_lesson: 'Opening lesson',
};
const SOURCE_LABEL: Record<TrainingDrill['source'], string> = { this_game: 'this game', other_game: 'another of your games', derived: 'from this game’s line' };

/** Grade a move by Stockfish: from the stored candidates, else a quick live check. */
async function gradeMove(fen: string, uci: string, fenAfter: string, graded: GradedMove[]): Promise<GradedMove['quality']> {
  const known = graded.find((g) => g.uci === uci);
  if (known) return known.quality;
  const [before, after] = await Promise.all([analysePosition(fen, 14, 1), analysePosition(fenAfter, 14, 1)]);
  if (!before?.lines[0] || !after) throw new Error('Stockfish is not available to check this move.');
  return qualityOfGap(gapBetween(scoreToCp(before.lines[0].score), -positionCp(after)), false);
}

export function TrainingView({ game }: { game: StoredGame }) {
  const { refresh, games } = useApp();
  const t = game.aiTraining;
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [active, setActive] = useState<TrainingDrill | null>(null);
  const [opening, setOpening] = useState(false);

  const run = async (force: boolean) => {
    setState('loading');
    setStage('Starting…');
    try {
      await buildTraining(game.id, { force, onProgress: setStage });
      await refresh();
      setState('idle');
    } catch (e) {
      if (!force) failed.add(game.id);
      setError((e as Error).message);
      setState('error');
    }
  };
  useEffect(() => {
    if (!t && state === 'idle' && !failed.has(game.id)) void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, game.id]);

  if (!t) {
    return (
      <section className="card">
        {state === 'loading' && <p className="muted small">{stage}</p>}
        {state === 'error' && <p className="feedback bad small">Couldn't build the training: {error}</p>}
        {state !== 'loading' && (
          <button className="btn ghost small" onClick={() => run(false)}>
            Build training from this game
          </button>
        )}
      </section>
    );
  }
  const gameOf = (id: string) => games.find((g) => g.id === id);

  if (opening && t.opening) return <OpeningTrainer key="opening" lesson={t.opening} gameId={game.id} onClose={() => setOpening(false)} />;
  if (active) {
    const g = gameOf(active.gameId) ?? game;
    return <DrillRunner key={active.id} drill={active} game={g} onClose={() => setActive(null)} onNext={nextDrill(t, active, setActive)} />;
  }

  return (
    <HoverProvider>
      <section className="card focus-card">
        <span className="eyebrow">Training priority · experimental</span>
        <h2>{CATEGORY_LABEL[t.priority.category]}</h2>
        <CoachText text={t.priority.title} className="beta-para" />
        {t.priority.why && <CoachText text={t.priority.why} className="beta-para muted" />}
        {t.priority.signals.length > 0 && (
          <ul className="beta-evidence small muted">
            {t.priority.signals.map((x, i) => (
              <li key={i}>
                <CoachText text={x.text} />
              </li>
            ))}
          </ul>
        )}
        <details className="small muted">
          <summary>What else was considered</summary>
          <ul>
            {t.considered.map((c) => (
              <li key={c.category}>
                {CATEGORY_LABEL[c.category]} — score {c.score}: {c.reason}
              </li>
            ))}
          </ul>
        </details>
      </section>

      {t.lessons.map((l) => (
        <section key={l.id} className="card train-lesson">
          <span className="eyebrow">{CATEGORY_LABEL[l.category]}</span>
          <h3>{l.title}</h3>
          <p className="beta-lesson">
            <strong>The habit: </strong>
            <CoachText text={l.skill} />
          </p>
          <div className="train-drills">
            {l.drills.map((d) => (
              <button
                key={d.id}
                className="train-drill"
                onClick={() => (d.format === 'opening_lesson' ? setOpening(true) : setActive(d))}
                disabled={d.format === 'opening_lesson' && !t.opening}
              >
                <span className="beta-pill">{FORMAT_LABEL[d.format]}</span>
                <span className="small">{d.format === 'opening_lesson' ? t.opening?.title ?? d.prompt : d.prompt}</span>
                <span className="muted small">{SOURCE_LABEL[d.source]}</span>
              </button>
            ))}
          </div>
        </section>
      ))}

      <p className="muted small">
        Texts by {t.writtenBy === 'template' ? 'templates (the AI coach was not available)' : t.writtenBy}; positions and grades by Stockfish.
        {t.usage ? ` Gemini: ${t.usage.input.toLocaleString()} in / ${t.usage.output.toLocaleString()} out tokens.` : ''}{' '}
        <button className="link small" disabled={state === 'loading'} onClick={() => run(true)}>
          {state === 'loading' ? stage : 'Rebuild'}
        </button>
      </p>
      {t.removed.length > 0 && (
        <details className="small muted">
          <summary>{t.removed.length} statement(s) removed by the Stockfish referee</summary>
          <ul>
            {t.removed.map((x, i) => (
              <li key={i}>
                “{x.text}” — {x.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </HoverProvider>
  );
}

function nextDrill(t: TrainingPlan, current: TrainingDrill, set: (d: TrainingDrill | null) => void) {
  const all = t.lessons.flatMap((l) => l.drills).filter((d) => d.format !== 'opening_lesson');
  const i = all.findIndex((d) => d.id === current.id);
  const next = all[i + 1];
  return next ? () => set(next) : undefined;
}

// ------------------------------------------------------------ drills ---

function DrillRunner({ drill, game, onClose, onNext }: { drill: TrainingDrill; game: StoredGame; onClose: () => void; onNext?: () => void }) {
  const seq = drill.format === 'replay_sequence' ? drill.sequence : undefined;
  const fenAt = (i: number) => (i === 0 ? game.plies[0].fenBefore : game.plies[i - 1].fenAfter);
  const [pos, setPos] = useState(seq ? seq.fromPly - 1 : -1); // position index for replays
  const [answer, setAnswer] = useState<{ grade: Grade; note: string; arrows: Arrow[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const atDecision = !seq || pos === seq.decisionPly - 1;
  const fen = seq ? fenAt(pos) : drill.fen;
  const best = drill.graded[0];
  const arrowOf = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });
  const respond = (quality: GradedMove['quality'], uci: string, san: string) =>
    setAnswer({
      grade: gradeOf(quality),
      note: `Stockfish rates ${san}: ${QUALITY_LABEL[quality].toLowerCase()}${best && best.uci !== uci ? ` — its first choice was ${best.san}` : ''}.`,
      arrows: [arrowOf(uci, 'guess'), ...(best && best.uci !== uci ? [arrowOf(best.uci, 'best')] : [])],
    });
  const moveFormats = ['tactical_puzzle', 'predict_threat', 'why_good', 'endgame_technique'];
  const onMove = (uci: string, san: string, fenAfter: string) => {
    if (answer || checking || !moveFormats.includes(drill.format)) return false;
    setChecking(true);
    void gradeMove(drill.fen, uci, fenAfter, drill.graded)
      .then((q) => respond(q, uci, san))
      .catch((e: Error) => setAnswer({ grade: 'misses', note: e.message, arrows: [] }))
      .finally(() => setChecking(false));
    return false;
  };
  const last = seq && pos > 0 ? game.plies[pos - 1] : undefined;
  const options = drill.options ?? drill.graded.slice(0, 3);
  const top = useKeepTop<HTMLDivElement>(`${pos}|${answer?.grade ?? ''}`);

  return (
    <HoverProvider>
      <div className="rv walk" ref={top}>
        <div className="rv-grid">
          <div className="rv-prompt walk-progress small muted">
            {FORMAT_LABEL[drill.format]} · {SOURCE_LABEL[drill.source]}
            {drill.source === 'other_game' ? ` (${drill.gameLabel})` : ''}
          </div>
          <div className="rv-board">
            <Board
              fen={fen}
              orientation={drill.orientation}
              arrows={answer?.arrows ?? []}
              lastMove={last ? { from: last.from, to: last.to } : undefined}
              movable={moveFormats.includes(drill.format) && !answer ? drill.toMove : undefined}
              onMove={onMove}
            />
          </div>
          <div className="rv-banner">
            <div className="walk-card interactive">
              {seq && !atDecision && pos < seq.decisionPly - 1 && (
                <>
                  <p className="small muted">Playing through from {moveLabel(game.plies[seq.fromPly - 1])}…</p>
                  <button className="btn primary" onClick={() => setPos((p) => p + 1)}>
                    Next move
                  </button>
                </>
              )}
              {atDecision && (
                <>
                  <p>
                    <strong>{drill.prompt}</strong>
                  </p>
                  {!answer && drill.hint && <p className="muted small">Hint: {drill.hint}</p>}
                  {!answer && moveFormats.includes(drill.format) && <p className="muted small">{checking ? 'Checking with Stockfish…' : 'Play your move on the board.'}</p>}
                  {!answer && !moveFormats.includes(drill.format) && (
                    <div className="walk-options">
                      {options.map((o) => (
                        <button key={o.uci} className="btn ghost" onClick={() => respond(o.quality, o.uci, o.san)}>
                          <b>{o.san}</b>
                        </button>
                      ))}
                    </div>
                  )}
                  {!answer && (
                    <button className="link small" onClick={() => best && respond(best.quality, best.uci, best.san)}>
                      Show me
                    </button>
                  )}
                </>
              )}
              {answer && (
                <>
                  <Verdict tone={GRADE_TONE[answer.grade]} title={GRADE_TITLE[answer.grade]} text={drill.feedback[answer.grade]} />
                  <p className="muted small">{answer.note}</p>
                  <CoachText text={drill.explanation} className="beta-para" />
                  {seq && pos < seq.toPly && (
                    <button className="btn ghost small" onClick={() => setPos((p) => Math.min(seq.toPly, p + 1))}>
                      Play on: what happened in the game ({pos < game.plies.length ? moveLabel(game.plies[pos]) : ''}) →
                    </button>
                  )}
                </>
              )}
              <div className="walk-controls">
                <button className="btn ghost" onClick={onClose}>
                  Back to training
                </button>
                {answer && onNext && (
                  <button className="btn primary" onClick={onNext}>
                    Next drill
                  </button>
                )}
              </div>
            </div>
          </div>
          <aside className="rv-side">
            <ul className="beta-evidence small muted">
              {drill.facts.map((f, i) => (
                <li key={i}>
                  <CoachText text={f} />
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </HoverProvider>
  );
}

// ---------------------------------------------------- opening trainer ---

const RUNS = 'chesscoach:v1:openingRuns:';

function OpeningTrainer({ lesson, gameId, onClose }: { lesson: OpeningLesson; gameId: string; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState<{ grade: Grade; note: string; uci: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [misses, setMisses] = useState(0);
  const [runs, setRuns] = useState<{ runs: number; clean: number }>(() => {
    try {
      return JSON.parse(localStorage.getItem(RUNS + gameId) ?? '') as { runs: number; clean: number };
    } catch {
      return { runs: 0, clean: 0 };
    }
  });
  const timer = useRef<number>();
  const step = lesson.steps[i];
  const done = i >= lesson.steps.length;

  // Their moves play themselves.
  useEffect(() => {
    if (!step || step.side !== 'theirs') return;
    timer.current = window.setTimeout(() => setI((k) => k + 1), 900);
    return () => window.clearTimeout(timer.current);
  }, [step]);
  useEffect(() => {
    if (!done) return;
    const next = { runs: runs.runs + 1, clean: runs.clean + (misses === 0 ? 1 : 0) };
    setRuns(next);
    try {
      localStorage.setItem(RUNS + gameId, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const fen = done ? lesson.steps[lesson.steps.length - 1].fen : step.fen;
  const prev = i > 0 ? lesson.steps[i - 1] : undefined;
  const onMove = (uci: string, san: string, fenAfter: string) => {
    if (!step || step.side !== 'yours' || answer || checking) return false;
    setChecking(true);
    void gradeMove(step.fen, uci, fenAfter, step.acceptable ?? [])
      .then((q) => {
        const grade = uci === step.move.uci ? 'correct' : gradeOf(q);
        if (grade === 'misses') setMisses((m) => m + 1);
        const note =
          uci === step.move.uci
            ? 'That’s the move in this line.'
            : grade === 'misses'
              ? `Stockfish rates ${san}: ${QUALITY_LABEL[q].toLowerCase()}.`
              : `${san} is fine too (Stockfish: ${QUALITY_LABEL[q].toLowerCase()}). We'll continue with ${step.move.san} to stay on this lesson's line.`;
        setAnswer({ grade, note, uci });
      })
      .finally(() => setChecking(false));
    return false;
  };
  const advance = () => {
    setAnswer(null);
    setI((k) => k + 1);
  };
  const restart = () => {
    setAnswer(null);
    setMisses(0);
    setI(0);
  };
  const players = step?.candidates?.filter((c) => c.share !== undefined) ?? [];
  const top = useKeepTop<HTMLDivElement>(`${i}|${answer?.grade ?? ''}|${done}`);

  return (
    <HoverProvider>
      <div className="rv walk" ref={top}>
        <div className="rv-grid">
          <div className="rv-prompt walk-progress small muted">
            {lesson.name} · move {Math.ceil(((done ? lesson.steps.length : i) + 1) / 2)} · {runs.clean}/{runs.runs} clean runs
          </div>
          <div className="rv-board">
            <Board
              fen={fen}
              orientation={lesson.userColor}
              arrows={answer && step ? [{ from: step.move.uci.slice(0, 2), to: step.move.uci.slice(2, 4), color: 'best' }] : []}
              lastMove={prev ? { from: prev.move.uci.slice(0, 2), to: prev.move.uci.slice(2, 4) } : undefined}
              movable={step?.side === 'yours' && !answer ? lesson.userColor : undefined}
              onMove={onMove}
            />
          </div>
          <div className="rv-banner">
            <div className="walk-card interactive">
              {i === 0 && !answer && (
                <>
                  <strong>{lesson.title}</strong>
                  <CoachText text={lesson.summary} className="beta-para" />
                </>
              )}
              {done ? (
                <>
                  <strong>{misses === 0 ? 'Clean run: you played every move soundly.' : `${misses} move${misses > 1 ? 's' : ''} to review — run it again until it's clean.`}</strong>
                  <CoachText text={lesson.middlegamePlan} className="beta-para" />
                  <ul className="small">
                    {lesson.principles.map((p, k) => (
                      <li key={k}>
                        <CoachText text={p} />
                      </li>
                    ))}
                  </ul>
                  {lesson.traps.length > 0 && <p className="small muted">Watch for: {lesson.traps.join(' ')}</p>}
                  <div className="walk-controls">
                    <button className="btn primary" onClick={restart}>
                      Run it again
                    </button>
                    <button className="btn ghost" onClick={onClose}>
                      Back to training
                    </button>
                  </div>
                </>
              ) : step.side === 'theirs' ? (
                <p className="small">
                  <CoachText text={step.idea} />
                </p>
              ) : (
                <>
                  {!answer && (
                    <>
                      <p>
                        <strong>Your move.</strong> {step.undeveloped.length ? `Still at home: ${step.undeveloped.join(', ')}.` : 'Everything is developed.'}
                        {!step.castled && Math.ceil(step.ply / 2) >= 4 ? ' Not castled yet.' : ''}
                      </p>
                      <p className="muted small">{checking ? 'Checking with Stockfish…' : 'Play a move on the board.'}</p>
                      <button className="link small" onClick={() => setAnswer({ grade: 'misses', note: `The line plays ${step.move.san}.`, uci: step.move.uci })}>
                        Show me
                      </button>
                    </>
                  )}
                  {answer && (
                    <>
                      <Verdict tone={GRADE_TONE[answer.grade]} title={GRADE_TITLE[answer.grade]} text={answer.note} />
                      <CoachText text={step.idea} className="beta-para" />
                      {step.duties.length > 0 && <p className="small muted">Guard duties: {step.duties.join('; ')}.</p>}
                      {step.inGame && step.inGame.san !== step.move.san && (
                        <p className="small muted">
                          In your game you played {step.inGame.san} here (Stockfish: {QUALITY_LABEL[step.inGame.quality].toLowerCase()}).
                        </p>
                      )}
                      {players.length > 0 && <p className="small muted">Players near your rating: {players.map((c) => `${c.san} ${Math.round((c.share ?? 0) * 100)}%`).join(', ')}.</p>}
                      <div className="walk-controls">
                        {answer.grade === 'misses' && answer.uci !== step.move.uci && (
                          <button className="btn ghost" onClick={() => setAnswer(null)}>
                            Try again
                          </button>
                        )}
                        <button className="btn primary" onClick={advance}>
                          Continue with {step.move.san}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            {!done && (
              <button className="link small" onClick={onClose}>
                Back to training
              </button>
            )}
          </div>
          <aside className="rv-side small muted">
            <p>
              <strong>Principles</strong>
            </p>
            <ul>
              {lesson.principles.map((p, k) => (
                <li key={k}>
                  <CoachText text={p} />
                </li>
              ))}
            </ul>
            {lesson.deviation && (
              <p>
                In your game you left this plan at move {Math.ceil(lesson.deviation.ply / 2)} with {lesson.deviation.played}; the line plays {lesson.deviation.recommended}.
              </p>
            )}
            <p>{lesson.lichess ? 'Includes Lichess data from players near your rating.' : 'Lichess data not available: moves chosen by Stockfish and development principles.'}</p>
          </aside>
        </div>
      </div>
    </HoverProvider>
  );
}
