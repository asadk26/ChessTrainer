import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdaptiveSession, AdaptiveSkill, Color } from '../../domain/types';
import { navigate, useApp } from '../store';
import { Board } from '../components/Board';
import { buildSkillProfile, SKILL_LABEL, SKILLS, type SkillStatus } from '../../adaptive/skills';
import { chooseSkill, conversionStart, eligible, planFor } from '../../adaptive/planner';
import { DEFAULT_STRENGTH, STRENGTHS, type CoachStrength } from '../../adaptive/selectMove';
import { abandonSession, coachReply, finishSession, replay, saveMoves, startSession } from '../adaptiveActions';

const VERDICT_CLASS: Record<string, string> = { demonstrated: 'tag-good', partial: '', failed: 'tag-bad', not_tested: 'tag-muted' };
const VERDICT_SHORT: Record<string, string> = { demonstrated: 'Demonstrated', partial: 'Partly', failed: 'Not yet', not_tested: 'Not tested' };

export function CoachGameScreen() {
  const { games, sessions, refresh } = useApp();
  const live = sessions.find((s) => s.status === 'playing' || s.status === 'analysing');
  const [session, setSession] = useState<AdaptiveSession | undefined>(live);
  const [finished, setFinished] = useState<AdaptiveSession | undefined>();

  if (session) return <PlayView key={session.id} initial={session} onDone={async (s) => (await refresh(), setSession(undefined), setFinished(s))} />;
  if (finished) return <ResultView session={finished} onAgain={() => setFinished(undefined)} />;
  return <SetupView games={games} sessions={sessions} onStart={async (s) => (await refresh(), setSession(s))} />;
}

// ------------------------------------------------------------ setup

function SetupView({ games, sessions, onStart }: { games: ReturnType<typeof useApp>['games']; sessions: AdaptiveSession[]; onStart: (s: AdaptiveSession) => void }) {
  const profile = useMemo(() => buildSkillProfile(games, sessions), [games, sessions]);
  const convStart = useMemo(() => conversionStart(games, sessions), [games, sessions]);
  const canStart = (s: AdaptiveSkill) => s !== 'conversion' || !!convStart;
  const suggested = useMemo(() => chooseSkill(profile, canStart), [profile, convStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const [skill, setSkill] = useState<AdaptiveSkill>(suggested?.skill ?? 'development_discipline');
  const [color, setColor] = useState<'auto' | Color>('auto');
  const [strength, setStrength] = useState<CoachStrength['id']>(DEFAULT_STRENGTH);
  const [busy, setBusy] = useState(false);
  const status = profile.find((p) => p.skill === skill)!;
  const plan = useMemo(() => planFor(status, games, sessions, color === 'auto' ? undefined : color), [status, games, sessions, color]);
  const past = sessions.filter((s) => s.status === 'done' && s.result).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 5);

  const start = async () => {
    if (!plan) return;
    setBusy(true);
    onStart(await startSession(plan, strength));
  };

  return (
    <div className="narrow coach-game">
      <h1>Adaptive Coach Game</h1>
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
              <select value={strength} onChange={(e) => setStrength(e.target.value as CoachStrength['id'])}>
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
                <span className={`tag ${VERDICT_CLASS[s.result!.verdict]}`}>{VERDICT_SHORT[s.result!.verdict]}</span> {SKILL_LABEL[s.plan.skill]}{' '}
                <span className="muted small">{new Date(s.finishedAt ?? s.createdAt).toLocaleDateString()}</span>{' '}
                {s.gameId && <a href={`#/game/${s.gameId}`}>review</a>}
              </li>
            ))}
          </ul>
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

function ResultView({ session, onAgain }: { session: AdaptiveSession; onAgain: () => void }) {
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
  return (
    <div className="narrow coach-game">
      <h1>Today’s focus: {SKILL_LABEL[r.skill]}</h1>
      <section className="card">
        <span className={`tag ${VERDICT_CLASS[r.verdict]}`}>{r.valid ? `Result: ${VERDICT_SHORT[r.verdict]}` : 'Not meaningfully tested'}</span>
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
    </div>
  );
}
