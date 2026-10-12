import { useMemo, useState } from 'react';
import type { Color } from '../../domain/types';
import { parsePgn, PgnError } from '../../chess/pgn';
import { identifyUser } from '../../profile/identify';
import { SAMPLE_PGN } from '../../fixtures/sampleGame';
import { importGame } from '../actions';
import { navigate, useApp } from '../store';

export function ImportScreen() {
  const { settings, refresh } = useApp();
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<Color | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { game: parsePgn(text) };
    } catch (e) {
      return { error: e instanceof PgnError ? e.message : 'Could not read this PGN.' };
    }
  }, [text]);

  const game = parsed && 'game' in parsed ? parsed.game : undefined;
  const auto = game ? identifyUser(game.headers, settings.usernames) : null;
  const me = chosen ?? auto?.color ?? null;

  const submit = async () => {
    if (!game || !me) return;
    setBusy(true);
    const stored = await importGame(game, me);
    await refresh();
    navigate(`/game/${stored.id}`);
  };

  return (
    <div className="narrow">
      <h1>Import a game</h1>
      <p className="muted">Paste a PGN from Chess.com, Lichess or anywhere else. Everything stays in this browser.</p>
      <textarea
        className="pgn-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setChosen(null);
        }}
        placeholder={'[White "you"]\n[Black "opponent"]\n\n1. e4 e5 2. Nf3 ...'}
        spellCheck={false}
      />
      <div className="actions left">
        <button className="btn ghost" onClick={() => (setText(SAMPLE_PGN), setChosen(null))}>
          Load sample game
        </button>
      </div>

      {parsed && 'error' in parsed && <div className="feedback bad">{parsed.error}</div>}

      {game && (
        <div className="card">
          <div className="game-preview">
            <div>
              <b>{game.headers.white}</b> {game.headers.whiteElo ? `(${game.headers.whiteElo})` : ''} vs <b>{game.headers.black}</b>{' '}
              {game.headers.blackElo ? `(${game.headers.blackElo})` : ''}
            </div>
            <div className="muted small">
              {game.headers.result} · {Math.ceil(game.plies.length / 2)} moves {game.headers.date ? `· ${game.headers.date}` : ''}
            </div>
          </div>
          <p className="label">Which one is you?</p>
          {auto?.confident && !chosen && <p className="muted small">Recognised <b>{auto.name}</b> from your earlier games.</p>}
          <div className="seg">
            {(['w', 'b'] as Color[]).map((c) => (
              <button key={c} className={`seg-btn ${me === c ? 'on' : ''}`} onClick={() => setChosen(c)}>
                {c === 'w' ? '♔' : '♚'} {c === 'w' ? game.headers.white : game.headers.black}
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="btn primary" disabled={!me || busy} onClick={submit}>
              {busy ? 'Saving…' : 'Analyze game'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
