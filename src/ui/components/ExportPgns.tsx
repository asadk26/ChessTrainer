import { useState } from 'react';
import { useApp } from '../store';
import { chesscomFetch } from '../../sync/chesscomClient';
import { joinPgns, recentChessComPgns, storedPgns } from '../../sync/exportPgn';
import { copyText, downloadText } from '../clipboard';

/** Export your latest games as one PGN: download a file or copy it all, from Chess.com or from the app. */
export function ExportPgns() {
  const { games, settings } = useApp();
  const username = settings.chesscom?.username ?? '';
  const [count, setCount] = useState(20);
  const [source, setSource] = useState<'chesscom' | 'app'>(username ? 'chesscom' : 'app');
  const [rapidOnly, setRapidOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const collect = async (): Promise<string[]> => {
    if (source === 'app') return storedPgns(games, count);
    const { pgns } = await recentChessComPgns(username, count, chesscomFetch, rapidOnly ? ['rapid'] : undefined);
    return pgns;
  };
  const run = async (how: 'download' | 'copy') => {
    setBusy(true);
    setMsg(null);
    try {
      const pgns = await collect();
      if (!pgns.length) return setMsg({ ok: false, text: 'No games found.' });
      const text = joinPgns(pgns);
      if (how === 'download') {
        downloadText(text, `${source === 'chesscom' ? username : 'chess-coach'}-last-${pgns.length}-${new Date().toISOString().slice(0, 10)}.pgn`);
        setMsg({ ok: true, text: `Downloaded ${pgns.length} game${pgns.length > 1 ? 's' : ''} in one PGN file.` });
      } else {
        const ok = await copyText(text);
        setMsg(ok ? { ok: true, text: `Copied ${pgns.length} game${pgns.length > 1 ? 's' : ''} to the clipboard.` } : { ok: false, text: "Couldn't copy: use Download instead." });
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card export-card">
      <h3>Export PGNs</h3>
      <div className="export-row">
        <label>
          Last
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} games
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <select value={source} onChange={(e) => setSource(e.target.value as 'chesscom' | 'app')}>
            <option value="chesscom" disabled={!username}>
              Chess.com{username ? ` (${username})` : ' — set your username above'}
            </option>
            <option value="app">Games in this app ({games.length})</option>
          </select>
        </label>
        {source === 'chesscom' && (
          <label className="check">
            <input type="checkbox" checked={rapidOnly} onChange={(e) => setRapidOnly(e.target.checked)} /> Rapid only
          </label>
        )}
      </div>
      <div className="actions left">
        <button className="btn primary" disabled={busy} onClick={() => run('download')}>
          {busy ? 'Fetching…' : 'Download .pgn'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => run('copy')}>
          Copy all
        </button>
      </div>
      {msg && <p className={`small ${msg.ok ? 'muted' : 'bad-h'}`}>{msg.text}</p>}
      <p className="muted small">Newest first, all in one file. From Chess.com nothing is imported or analysed — it's just the PGNs.</p>
    </section>
  );
}
