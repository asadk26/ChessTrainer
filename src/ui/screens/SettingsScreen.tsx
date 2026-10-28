import { useState } from 'react';
import { useApp } from '../store';
import { downloadFeedback, exportBackup, exportFeedback, importBackup } from '../actions';
import { feedbackCount } from '../../coach/feedback';
import { llmPing } from '../../coach/llmClient';
import { getThemePref, setThemePref, type ThemePref } from '../theme';
import { ChessComSync } from '../components/ChessComSync';
import { ExportPgns } from '../components/ExportPgns';
import { ScreenHeader } from '../components/AppShell';

export function SettingsScreen() {
  const { games, settings, llm, updateSettings } = useApp();
  const analyzed = games.filter((g) => g.status === 'analyzed').length;
  return (
    <div className="narrow settings-screen">
      <ScreenHeader title="Settings" back="/" />

      <section className="card">
        <h3>You</h3>
        <div className="settings-grid">
          <label>
            Your rating
            <input type="number" value={settings.rating} onChange={(e) => updateSettings({ rating: Number(e.target.value) || 850 })} />
          </label>
          <label>
            Analysis depth
            <select value={settings.analysisDepth} onChange={(e) => updateSettings({ analysisDepth: Number(e.target.value) })}>
              <option value={10}>10 — fast</option>
              <option value={12}>12 — standard</option>
              <option value={14}>14 — thorough</option>
              <option value={16}>16 — slow</option>
            </select>
          </label>
        </div>
      </section>

      <section className="card">
        <h3>Theme</h3>
        <ThemeChoice />
      </section>

      <section className="card">
        <h3>Chess.com account</h3>
        <ChessComSync />
      </section>

      {(llm.provider || llm.reason) && (
        <section className="card">
          <h3>AI instructor</h3>
          <div className="settings-grid">
            {llm.provider && (
              <label className="check">
                <input type="checkbox" checked={settings.useLlm} onChange={(e) => updateSettings({ useLlm: e.target.checked })} />
                AI instructor explanations ({llm.provider} · {llm.model}) — for each game's 1–2 lessons, and on request
              </label>
            )}
            {llm.provider && (
              <label className="check">
                <input type="checkbox" checked={settings.betaCoach !== false} disabled={!settings.useLlm} onChange={(e) => updateSettings({ betaCoach: e.target.checked })} />
                <span>
                  <span className="beta-badge">Beta</span> AI Coach tab — the AI's own whole-game review, shown next to the built-in coach for comparison
                </span>
              </label>
            )}
            {llm.reason && <div className="muted small">{llm.reason}</div>}
            {llm.requiresToken && (
              <label>
                Access code
                <input
                  type="password"
                  autoComplete="off"
                  defaultValue={settings.coachToken ?? ''}
                  placeholder="COACH_ACCESS_TOKEN from your deployment"
                  onChange={(e) => updateSettings({ coachToken: e.target.value.trim() || undefined })}
                />
              </label>
            )}
            {llm.provider && <AiStatus />}
          </div>
        </section>
      )}

      <ExportPgns />
      <DataCard />
      <FeedbackCard />
      <p className="muted small">
        Known usernames: {Object.keys(settings.usernames).join(', ') || '—'} · {analyzed} game{analyzed === 1 ? '' : 's'} analyzed
      </p>
    </div>
  );
}

const THEMES: { id: ThemePref; label: string }[] = [
  { id: 'system', label: 'Automatic' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

function ThemeChoice() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  return (
    <div className="seg">
      {THEMES.map((t) => (
        <button key={t.id} className={`seg-btn ${pref === t.id ? 'on' : ''}`} onClick={() => (setThemePref(t.id), setPref(t.id))}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Backup export and merge-import (JSON). */
export function DataCard() {
  const { refresh } = useApp();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await importBackup(file);
      await refresh();
      setMsg({
        ok: true,
        text: `Imported ${r.gamesAdded} new game${r.gamesAdded === 1 ? '' : 's'}${r.gamesUpdated ? `, updated ${r.gamesUpdated}` : ''}${r.gamesKept ? `, kept ${r.gamesKept} you already had` : ''}, ${r.drills} drills and ${r.attempts} drill attempts.`,
      });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <section className="card">
      <h3>Backup</h3>
      <div className="actions left">
        <button className="btn ghost" onClick={exportBackup}>
          Export data (JSON)
        </button>
        <label className="btn ghost file-btn">
          Import data (JSON)
          <input type="file" accept="application/json,.json" onChange={(e) => (void onFile(e.target.files?.[0]), (e.target.value = ''))} />
        </label>
      </div>
      <p className="muted small">Export on one device and import on another to move your games, drills and profile. Importing merges — it never deletes what's already here.</p>
      {msg && <div className={`feedback ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
    </section>
  );
}

function FeedbackCard() {
  const { games } = useApp();
  const [msg, setMsg] = useState<string | null>(null);
  const flagged = feedbackCount(games);
  if (!flagged) return null;
  return (
    <section className="card feedback-card">
      <h3>Coach feedback</h3>
      <p className="muted small">
        You've flagged {flagged} thing{flagged === 1 ? '' : 's'} the coach got wrong. Copy them (with the game PGNs) and paste them to Claude to improve the coach.
      </p>
      <div className="actions left inline">
        <button className="btn primary small" onClick={async () => setMsg((await exportFeedback()) === 'copied' ? 'Copied to the clipboard.' : 'Downloaded as a file.')}>
          Copy feedback
        </button>
        <button className="btn ghost small" onClick={() => void downloadFeedback()}>
          Download (.md)
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </section>
  );
}

/** Where the AI instructor stands, and a one-click end-to-end test (access code, key, model). */
function AiStatus() {
  const { llm, settings } = useApp();
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; msg?: string }>({ state: 'idle' });
  const missingCode = llm.requiresToken && !settings.coachToken;
  const run = async () => {
    setTest({ state: 'running' });
    try {
      await llmPing(settings.coachToken);
      setTest({ state: 'ok' });
    } catch (e) {
      setTest({ state: 'error', msg: (e as Error).message });
    }
  };
  return (
    <div className="small">
      <div className={missingCode || !settings.useLlm ? 'bad-h' : 'muted'}>
        {!settings.useLlm
          ? 'AI explanations are switched off.'
          : missingCode
            ? 'Access code missing: the "Why?" buttons stay hidden until you enter it.'
            : 'AI explanations are on. Tap "Why?" on any of your moves that wasn\'t Stockfish\'s best.'}
      </div>
      <button className="btn ghost small" disabled={test.state === 'running'} onClick={run}>
        {test.state === 'running' ? 'Testing…' : 'Test AI connection'}
      </button>{' '}
      {test.state === 'ok' && <span className="good-h">Connected — {llm.provider} · {llm.model} answered.</span>}
      {test.state === 'error' && <span className="bad-h">Failed: {test.msg}</span>}
    </div>
  );
}
