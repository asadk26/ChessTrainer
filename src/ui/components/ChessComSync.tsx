import { useState, useSyncExternalStore } from 'react';
import type { ChessComSettings, ChessComTimeClass } from '../../domain/types';
import { SyncError, validUsername } from '../../sync/chesscom';
import { syncChessCom } from '../actions';
import { useApp } from '../store';

const CLASSES: { id: ChessComTimeClass; label: string }[] = [
  { id: 'rapid', label: 'Rapid' },
  { id: 'blitz', label: 'Blitz' },
  { id: 'bullet', label: 'Bullet' },
  { id: 'daily', label: 'Daily' },
];
const DEFAULTS: Omit<ChessComSettings, 'username'> = { days: 30, timeClasses: ['rapid'] };

type Status = { tone: 'neutral' | 'good' | 'bad'; text: string } | null;

// Sync state lives outside the component: importing the first game swaps the
// dashboard layout, which remounts this panel mid-sync.
let shared: { busy: boolean; status: Status } = { busy: false, status: null };
const listeners = new Set<() => void>();
const setShared = (patch: Partial<typeof shared>) => {
  shared = { ...shared, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Manual Chess.com sync (import only): a username setting and one button. No background polling. */
export function ChessComSync({ compact = false }: { compact?: boolean }) {
  const { settings, updateSettings, refresh } = useApp();
  const cfg = settings.chesscom;
  const [editing, setEditing] = useState(!cfg);
  const [draft, setDraft] = useState<ChessComSettings>(cfg ?? { username: '', ...DEFAULTS });
  const { busy, status } = useSyncExternalStore(subscribe, () => shared);
  const setBusy = (busy: boolean) => setShared({ busy });
  const setStatus = (status: Status) => setShared({ status });

  const save = async () => {
    if (!validUsername(draft.username)) {
      setStatus({ tone: 'bad', text: 'Enter your Chess.com username (3–25 letters, numbers, "_" or "-").' });
      return;
    }
    const timeClasses = draft.timeClasses.length ? draft.timeClasses : DEFAULTS.timeClasses;
    await updateSettings({ chesscom: { ...draft, username: draft.username.trim(), timeClasses } });
    setEditing(false);
    setStatus(null);
  };

  const sync = async () => {
    setBusy(true);
    try {
      const { message, imported } = await syncChessCom((t) => setStatus({ tone: 'neutral', text: t }));
      await refresh();
      setStatus({ tone: 'good', text: imported.length ? `${message} They're ready to export now; analyse them on the Games tab whenever you like.` : message });
    } catch (e) {
      const text =
        e instanceof SyncError
          ? e.message
          : "Something went wrong while syncing. Your games are safe; try again later, or paste a PGN with + on the Games tab.";
      setStatus({ tone: 'bad', text });
    } finally {
      setBusy(false);
    }
  };

  // On the Games tab: just the sync button; the account itself is set up in Settings.
  if (compact && !cfg)
    return (
      <p className="muted small chesscom-sync">
        Sync your Chess.com games: <a href="#/settings">add your username in Settings</a>.
      </p>
    );

  if (editing || !cfg) {
    return (
      <div className="chesscom-sync editing">
        <label>
          Chess.com username
          <input
            value={draft.username}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="e.g. chunkmonkey420"
            onChange={(e) => setDraft({ ...draft, username: e.target.value })}
          />
        </label>
        <label>
          Sync games from the last
          <select value={draft.days} onChange={(e) => setDraft({ ...draft, days: Number(e.target.value) })}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
        <fieldset className="checks">
          <legend>Time controls</legend>
          {CLASSES.map((c) => (
            <label key={c.id} className="check">
              <input
                type="checkbox"
                checked={draft.timeClasses.includes(c.id)}
                onChange={(e) =>
                  setDraft({ ...draft, timeClasses: e.target.checked ? [...draft.timeClasses, c.id] : draft.timeClasses.filter((x) => x !== c.id) })
                }
              />
              {c.label}
            </label>
          ))}
        </fieldset>
        <div className="actions left inline">
          <button className="btn primary small" onClick={save}>
            Save
          </button>
          {cfg && (
            <button className="link" onClick={() => (setDraft(cfg), setEditing(false))}>
              Cancel
            </button>
          )}
          {cfg && (
            <button className="link" onClick={async () => (await updateSettings({ chesscom: undefined }), setDraft({ username: '', ...DEFAULTS }))}>
              Disconnect
            </button>
          )}
        </div>
        <p className="muted small">Uses Chess.com's public game archive — no password or login. Standard chess only; Rapid games come first.</p>
        {status && <div className={`feedback ${status.tone}`}>{status.text}</div>}
      </div>
    );
  }

  const classes = cfg.timeClasses.map((c) => CLASSES.find((x) => x.id === c)?.label ?? c).join(', ');
  return (
    <div className="chesscom-sync">
      <div className="row-between">
        <span>
          Chess.com: <b>{cfg.username}</b> <span className="muted small">· last {cfg.days} days · {classes}</span>{' '}
          {!compact && (
            <button className="link small" onClick={() => setEditing(true)}>
              change
            </button>
          )}
        </span>
        <button className="btn primary small" disabled={busy} onClick={sync}>
          {busy ? 'Syncing…' : 'Sync Chess.com'}
        </button>
      </div>
      {status && <div className={`feedback ${status.tone}`}>{status.text}</div>}
    </div>
  );
}
