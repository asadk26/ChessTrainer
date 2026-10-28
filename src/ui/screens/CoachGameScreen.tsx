import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdaptiveSession, AdaptiveSkill, Color } from '../../domain/types';
import { navigate, useApp } from '../store';
import { Board } from '../components/Board';
import { buildSkillProfile, SKILL_LABEL, SKILLS, type SkillStatus } from '../../adaptive/skills';
import { chooseSkill, conversionStart, eligible, planFor } from '../../adaptive/planner';
import { DEFAULT_STRENGTH, STRENGTHS, type StrengthId } from '../../adaptive/selectMove';
import { coachMoveLine, exportPlaytest, moveLabels, sessionLog, statsText } from '../../adaptive/playtest';
import type { PlaytestFeedback } from '../../domain/types';
import { abandonSession, coachReply, finishSession, replay, saveFeedback, saveMoves, startSession } from '../adaptiveActions';
import { copyText, downloadText } from '../clipboard';
import { pendingAnalysis } from '../actions';

const VERDICT_CLASS: Record<string, string> = { demonstrated: 'tag-good', partial: '', failed: 'tag-bad', not_tested: 'tag-muted' };
const VERDICT_SHORT: Record<string, string> = { demonstrated: 'Demonstrated', partial: 'Partly', failed: 'Not yet', not_tested: 'Not tested' };

export function CoachGameScreen() {
  const { games, sessions, refresh } = useApp();
  const live = sessions.find((s) => s.status === 'playing' || s.status === 'analysing');
  const [session, setSession] = useState<AdaptiveSession | undefined>(live);
  const [finished, setFinished] = useState<AdaptiveSession | undefined>();

  if (session) return <PlayView key={session.id} initial={session} onDone={async (s) => (await refresh(), setSession(undefined), setFinished(s))} />;
  if (finished) return <ResultView session={finished} onAgain={async () => (await refresh(), setFinished(undefined))} />;
  return <SetupView games={games} sessions={sessions} onStart={async (s) => (await refresh(), setSession(s))} onOpen={setFinished} />;
}

// ------------------------------------------------------------ setup

function SetupView({
  games,
  sessions,
  onStart,
  onOpen,
}: {
  games: ReturnType<typeof useApp>['games'];
  sessions: AdaptiveSession[];
  onStart: (s: AdaptiveSession) => void;
  onOpen: (s: AdaptiveSession) => void;
}) {
  const profile = useMemo(() => buildSkillProfile(games, sessions), [games, sessions]);
  const convStart = useMemo(() => conversionStart(games, sessions), [games, sessions]);
  const canStart = (s: AdaptiveSkill) => s !== 'conversion' || !!convStart;
  const suggested = useMemo(() => chooseSkill(profile, canStart), [profile, convStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const [skill, setSkill] = useState<AdaptiveSkill>(suggested?.skill ?? 'development_discipline');
  const [color, setColor] = useState<'auto' | Color>('auto');
  const [strength, setStrength] = useState<StrengthId>(DEFAULT_STRENGTH);
  const [busy, setBusy] = useState(false);
  const status = profile.find((p) => p.skill === skill)!;
  const plan = useMemo(() => planFor(status, games, sessions, color === 'auto' ? undefined : color), [status, games, sessions, color]);
  const past = sessions.filter((s) => s.status === 'done' && s.result).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 8);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const start = async () => {
    if (!plan) return;
    setBusy(true);
    onStart(await startSession(plan, strength));
  };

  return (
    <div className="narrow coach-game">
      <h1>Adaptive Coach Game</h1>
      {pendingAnalysis(games).length > 0 && (
        <p className="feedback neutral small">
          {pendingAnalysis(games).length} of your games aren’t analysed yet, so they don’t count here. Analyse them from the Games tab for a better-informed plan.
        </p>
      )}
      <p className="muted">
        A normal game against a coach that plays sound moves, but steers toward a kind of position your own games say you need to practise. Teaching
        comes after the game.
      </p>

      <section className="card">
        {suggested ? (
          <>
            <div className="eyebrow">Suggested from your games</div>
            <h3>{SKILL_LABEL[suggested.skill]}</h3>
          </>
        ) : (
          <p className="muted small">
            None of these shows up often enough in your analysed games yet to build a game around it. You can still play a practice game — its result
            is recorded as practice.
          </p>
        )}
        <div className="skill-list">
          {SKILLS.map((s) => {
            const st = profile.find((p) => p.skill === s)!;
            const disabled = !canStart(s);
            return (
              <button key={s} className={`skill-opt${skill === s ? ' on' : ''}`} disabled={disabled} onClick={() => setSkill(s)}>
                <strong>{SKILL_LABEL[s]}</strong>
                <span className="muted small">{disabled ? 'Needs a position from your games where you were clearly better' : evidenceLine(st)}</span>
                {st.training.recent[0] && <span className={`tag ${VERDICT_CLASS[st.training.recent[0].verdict]}`}>Last: {VERDICT_SHORT[st.training.recent[0].verdict]}</span>}
                {st.training.lowEmergence && <span className="muted small">Recent games rarely produced a real test of this.</span>}
              </button>
            );
          })}
        </div>
      </section>

      {plan && (
        <section className="card">
          <div className="eyebrow">{plan.basis === 'history' ? 'Today’s focus' : 'Practice game'}</div>
          <h3>{SKILL_LABEL[plan.skill]}</h3>
          <p>{plan.reason}</p>
          <p className="small">
            <strong>The coach will steer toward</strong> {plan.desiredPosition}.
          </p>
          {plan.start.label && <p className="small muted">{plan.start.label}.</p>}
          {plan.evidence.length > 0 && (
            <details className="small">
              <summary>Evidence from your games</summary>
              <ul>
                {plan.evidence.slice(0, 3).map((e) => (
                  <li key={`${e.gameId}-${e.ply}`}>
                    <a href={`#/game/${e.gameId}/review?ply=${e.ply}`}>{e.text}</a>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="row-controls">
            {plan.skill !== 'conversion' && (
              <label>
                You play
                <select value={color} onChange={(e) => setColor(e.target.value as 'auto' | Color)}>
                  <option value="auto">Auto ({plan.userColor === 'w' ? 'White' : 'Black'})</option>
                  <option value="w">White</option>
                  <option value="b">Black</option>
                </select>
              </label>
            )}
            <label>
              Coach strength
              <select value={strength} onChange={(e) => setStrength(e.target.value as StrengthId)}>
                {STRENGTHS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">{STRENGTHS.find((s) => s.id === strength)!.detail}</p>
          <button className="btn primary" disabled={busy} onClick={start}>
            Start game
          </button>
        </section>
      )}

      {past.length > 0 && (
        <section className="card">
          <h3>Recent coach games</h3>
          <ul className="plain">
            {past.map((s) => (
              <li key={s.id}>
                <button className="link" onClick={() => onOpen(s)}>
                  <span className={`tag ${VERDICT_CLASS[s.result!.verdict]}`}>{VERDICT_SHORT[s.result!.verdict]}</span> {SKILL_LABEL[s.plan.skill]}
                </button>{' '}
                <span className="muted small">
                  {new Date(s.finishedAt ?? s.createdAt).toLocaleDateString()} · {s.strength ?? `band ${s.band}`}
                  {s.feedback ? ' · feedback ✓' : ''}
                </span>
              </li>
            ))}
          </ul>
          <details className="small">
            <summary>Playtest summary &amp; export</summary>
            <pre className="coach-log">{statsText(sessions)}</pre>
            <div className="actions left">
              <button className="btn" onClick={async () => setExportMsg((await copyText(exportPlaytest(sessions))) ? 'Copied all coach-game logs.' : 'Copy failed — use Download.')}>
                Copy all logs
              </button>
              <button className="btn ghost" onClick={() => (downloadText(exportPlaytest(sessions), `coach-games-${new Date().toISOString().slice(0, 10)}.txt`), setExportMsg('Downloaded.'))}>
                Download
              </button>
            </div>
            {exportMsg && <p className="muted small">{exportMsg}</p>}
          </details>
        </section>
      )}
    </div>
  );
}

function evidenceLine(st: SkillStatus): string {
  const w = st.weakness;
  if (w.confidence === 'none') return 'Not seen in your real games yet';
  const g = w.games % 1 ? w.games.toFixed(1) : String(w.games);
  return `${eligible(st) ? 'Seen' : 'Hinted at'} in ${g} real game${w.games === 1 ? '' : 's'} (${w.confidence})`;
}

// ------------------------------------------------------------ play

function PlayView({ initial, onDone }: { initial: AdaptiveSession; onDone: (s: AdaptiveSession) => void }) {
  const [session, setSession] = useState(initial);
  const [thinking, setThinking] = useState(false);
  const [progress, setProgress] = useState<string | null>(initial.status === 'analysing' ? 'Analysing your game…' : null);
  const [error, setError] = useState<string | null>(null);
  const user = session.plan.userColor;
  const chess = useMemo(() => replay(session), [session]);
  const fen = chess.fen();
  const last = chess.history({ verbose: true }).at(-1);
  const busy = useRef(false);

  const finish = async (ending: NonNullable<AdaptiveSession['ending']>, s = session) => {
    setProgress('Saving your game…');
    try {
      const { session: done } = await finishSession(s, ending, setProgress);
      onDone(done);
    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
    }
  };

  // Resume an interrupted analysis.
  useEffect(() => {
    if (initial.status === 'analysing') void finish(initial.ending ?? 'stopped', initial);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Game over, or the coach to move.
  useEffect(() => {
    if (session.status !== 'playing' || progress || busy.current) return;
    if (chess.isGameOver()) {
      void finish(chess.isCheckmate() ? 'checkmate' : 'draw');
      return;
    }
    if (chess.turn() === user) return;
    busy.current = true;
    setThinking(true);
    coachReply(session)
      .then(setSession)
      .catch((e) => setError((e as Error).message))
      .finally(() => {
        busy.current = false;
        setThinking(false);
      });
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = (uci: string) => {
    if (thinking || chess.turn() !== user) return false;
    const next = { ...session, moves: [...session.moves, uci] };
    setSession(next);
    void saveMoves(next, next.moves);
    return true;
  };

  const moveText = useMemo(() => {
    const parts: string[] = [];
    const h = chess.history({ verbose: true });
    h.forEach((m, i) => {
      const n = Number(m.before.split(' ')[5]);
      if (m.color === 'w') parts.push(`${n}.${m.san}`);
      else parts.push(i === 0 ? `${n}…${m.san}` : m.san);
    });
    return parts.join(' ');
  }, [chess]);

  if (progress)
    return (
      <div className="narrow coach-game">
        <h1>Adaptive Coach Game</h1>
        <div className="card">
          <p>{progress}</p>
          <p className="muted small">Running the normal game analysis, then checking how today’s focus went.</p>
        </div>
      </div>
    );

  return (
    <div className="narrow coach-game">
      <div className="coach-head">
        <span className="eyebrow">Focus: {SKILL_LABEL[session.plan.skill]}</span>
        <span className="muted small">{thinking ? 'Coach is thinking…' : chess.turn() === user ? 'Your move' : ''}</span>
      </div>
      <Board fen={fen} orientation={user} movable={!thinking && chess.turn() === user ? user : undefined} onMove={onMove} lastMove={last ? { from: last.from, to: last.to } : undefined} />
      <p className="moves small">{moveText || <span className="muted">{session.plan.start.label ?? 'Normal starting position.'}</span>}</p>
      {error && <div className="feedback bad">{error}</div>}
      <div className="actions left">
        <button className="btn" onClick={() => void finish('stopped')} disabled={thinking}>
          End game &amp; review
        </button>
        <button className="btn ghost" onClick={() => confirm('Resign this game?') && void finish('resigned')} disabled={thinking}>
          Resign
        </button>
        <button
          className="btn ghost"
          onClick={async () => {
            if (!confirm('Discard this game without saving it?')) return;
            await abandonSession(session);
            onDone({ ...session, status: 'abandoned' });
          }}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ result

function ResultView({ session: initial, onAgain }: { session: AdaptiveSession; onAgain: () => void }) {
  const [session, setSession] = useState(initial);
  const [copied, setCopied] = useState<string | null>(null);
  const r = session.result;
  if (!r)
    return (
      <div className="narrow coach-game">
        <h1>Adaptive Coach Game</h1>
        <div className="card">
          <p>{session.status === 'abandoned' ? 'Game discarded — nothing was saved.' : 'No result.'}</p>
          <button className="btn primary" onClick={onAgain}>
            Back
          </button>
        </div>
      </div>
    );
  const labels = moveLabels(session);
  return (
    <div className="narrow coach-game">
      <h1>Today’s focus: {SKILL_LABEL[r.skill]}</h1>
      <section className="card">
        <span className={`tag ${VERDICT_CLASS[r.verdict]}`}>{r.valid ? `Result: ${VERDICT_SHORT[r.verdict]}` : 'Not meaningfully tested'}</span>
        {r.valid && r.testMoments !== undefined && <span className="muted small"> · {r.testMoments} test moment{r.testMoments === 1 ? '' : 's'}</span>}
        <p>{r.explanation}</p>
        {r.moments.length > 0 && (
          <ul className="plain moments">
            {r.moments.map((m) => (
              <li key={m.ply} className={`moment-${m.tone}`}>
                <a href={`#/game/${session.gameId}/review?ply=${m.ply}`}>
                  <strong>{m.label}</strong>
                </a>{' '}
                {m.text}
              </li>
            ))}
          </ul>
        )}
        {r.evidence && r.evidence.length > 0 && (
          <details className="small">
            <summary>Why this verdict</summary>
            <ul>
              {r.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </details>
        )}
        <p className="muted small">
          {!r.valid
            ? 'Nothing is concluded from this game. Your real-game profile is unchanged.'
            : r.retestSoon
              ? 'Worth testing again soon. This counts as training progress only — your real-game profile is unchanged.'
              : 'Saved as training progress. Real games will confirm whether it sticks.'}
        </p>
        <div className="actions left">
          {session.gameId && (
            <button className="btn primary" onClick={() => navigate(`/game/${session.gameId}`)}>
              Open full review
            </button>
          )}
          <button className="btn" onClick={onAgain}>
            Play another
          </button>
        </div>
      </section>

      <FeedbackCard session={session} onSaved={setSession} />

      <section className="card">
        <details>
          <summary>
            <strong>Coach decision log</strong> <span className="muted small">— why the coach played each move</span>
          </summary>
          <p className="muted small">
            Each line: Stockfish’s best and its evaluation, why the coach chose its move, and how far below best it was. Candidates show the
            evaluation, lesson points (L), naturalness (N) and total score; ✗ marks moves that weren’t allowed.
          </p>
          <pre className="coach-log">{session.coachLog.map((l) => coachMoveLine(l, labels[l.ply - 1] ?? `ply ${l.ply}`)).join('\n')}</pre>
        </details>
        <div className="actions left">
          <button className="btn" onClick={async () => setCopied((await copyText(sessionLog(session))) ? 'Copied — paste it to me for tuning.' : 'Copy failed.')}>
            Copy game log
          </button>
        </div>
        {copied && <p className="muted small">{copied}</p>}
      </section>
    </div>
  );
}

const CHOICES = {
  natural: { q: 'Did the coach play naturally?', opts: [['yes', 'Yes'], ['mixed', 'Mostly'], ['no', 'No']] },
  lesson: { q: 'Did the lesson situation come up?', opts: [['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']] },
  verdict: { q: 'Was the verdict fair?', opts: [['fair', 'Yes'], ['partly', 'Partly'], ['unfair', 'No']] },
} as const;

/** Optional playtest notes, saved with the session and included in the exported log. */
function FeedbackCard({ session, onSaved }: { session: AdaptiveSession; onSaved: (s: AdaptiveSession) => void }) {
  const [fb, setFb] = useState<Omit<PlaytestFeedback, 'at'>>(session.feedback ?? {});
  const [saved, setSaved] = useState(!!session.feedback);
  const set = (patch: Partial<PlaytestFeedback>) => (setFb({ ...fb, ...patch }), setSaved(false));
  return (
    <section className="card feedback-card">
      <h3>Playtest notes <span className="muted small">(optional)</span></h3>
      {(Object.keys(CHOICES) as (keyof typeof CHOICES)[]).map((k) => (
        <div key={k} className="fb-row">
          <span className="small">{CHOICES[k].q}</span>
          <div className="seg">
            {CHOICES[k].opts.map(([v, label]) => (
              <button key={v} className={fb[k] === v ? 'on' : ''} onClick={() => set({ [k]: v } as Partial<PlaytestFeedback>)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <label className="small block">
        Any move that felt weird? (e.g. “14...h5”)
        <input value={fb.weirdMoves ?? ''} onChange={(e) => set({ weirdMoves: e.target.value })} />
      </label>
      <label className="small block">
        Anything else (e.g. an assessment that felt wrong)
        <textarea rows={2} value={fb.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </label>
      <button className="btn" disabled={saved} onClick={async () => (onSaved(await saveFeedback(session, fb)), setSaved(true))}>
        {saved ? 'Saved ✓' : 'Save notes'}
      </button>
    </section>
  );
}
