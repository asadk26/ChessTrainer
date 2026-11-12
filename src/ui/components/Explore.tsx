// Explore: free analysis on the board. You move for BOTH sides ("what if he plays this?"), the eval
// bar follows every position, and Stockfish's best move is one toggle away (off by default, so it
// never spoils anything; once on, it stays on). One line of moves with undo/redo — playing a
// different move part-way replaces the rest. Always marked as not your game.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Arrow, Color, PositionEval } from '../../domain/types';
import { positionCp, scoreToCp } from '../../analysis/evaluation';
import { evalText } from '../../coach/momentContext';
import { sideEvalText } from '../../coach/moveCard';
import { analyseLive } from '../actions';
import type { Panels } from './reviewParts';
import { lineLabels, moveLabelAt, playInLine, sanOf, type ExploreMove } from './exploreLine';

export const EXPLORE_DEPTH = 16;
/** Partial results shallower than this jump around too much to show. */
const SHOW_FROM_DEPTH = 8;
const PREF_BEST = 'chesscoach:explore:showBest';
const PREF_TOP = 'chesscoach:explore:top3';

const readPref = (k: string) => {
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
};
const writePref = (k: string, on: boolean) => {
  try {
    localStorage.setItem(k, on ? '1' : '0');
  } catch {
    /* private mode: the toggle still works for this visit */
  }
};

export interface ExploreStart {
  fen: string;
  /** Where it starts, for "Exploring from …" ("after 25.Qe2"). */
  label: string;
  /** Changes when a different start is opened (restarts the line). */
  key: string;
}

export interface ExploreOptions {
  start: ExploreStart | null;
  orientation: Color;
  /** Whose numbers: evals are said from this side ("you +0.8"). */
  you: Color;
  onClose: () => void;
  /** When set, a Practice | Explore toggle is shown; this switches back to Practice. */
  onPractice?: () => void;
}

const arrowOf = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });

export function useExplore({ start, orientation, you, onClose, onPractice }: ExploreOptions) {
  const [line, setLine] = useState<ExploreMove[]>([]);
  const [cursor, setCursor] = useState(0);
  const [showBest, setShowBest] = useState(() => readPref(PREF_BEST));
  const [top3, setTop3] = useState(() => readPref(PREF_TOP));
  const [ev, setEv] = useState<{ fen: string; pos?: PositionEval; done: boolean } | null>(null);

  // A different starting position: a fresh line.
  const startKey = start?.key;
  useEffect(() => {
    setLine([]);
    setCursor(0);
  }, [startKey]);

  const fen = start ? (cursor > 0 ? line[cursor - 1]?.fen ?? start.fen : start.fen) : '';
  const multiPv = showBest && top3 ? 3 : 1;

  // One search at a time for the position on the board; moving again cancels the old one, so the
  // numbers on screen always belong to this position.
  const seq = useRef(0);
  useEffect(() => {
    if (!start || !fen) return;
    const my = ++seq.current;
    const ctl = new AbortController();
    setEv({ fen, done: false });
    void analyseLive(fen, EXPLORE_DEPTH, multiPv, {
      signal: ctl.signal,
      onUpdate: (pos) => seq.current === my && pos.depth >= SHOW_FROM_DEPTH && setEv({ fen, pos, done: false }),
    }).then((pos) => {
      if (seq.current === my && !ctl.signal.aborted) setEv({ fen, pos, done: true });
    });
    return () => ctl.abort();
  }, [fen, multiPv, startKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = ev && ev.fen === fen ? ev.pos : undefined;
  const thinking = !!start && !(ev && ev.fen === fen && ev.done);
  const turn = (fen.split(' ')[1] === 'b' ? 'b' : 'w') as Color;
  const whiteCp = pos && (pos.lines.length || pos.terminal) ? (turn === 'w' ? positionCp(pos) : -positionCp(pos)) : undefined;
  const labels = useMemo(() => (start ? lineLabels(start.fen, line) : []), [start, line]);

  if (!start) return { active: false as const, panels: null, whiteCp: undefined, undo: () => {}, redo: () => {} };

  const undo = () => setCursor((c) => Math.max(0, c - 1));
  const redo = () => setCursor((c) => Math.min(line.length, c + 1));
  const reset = () => setCursor(0);

  const onMove = (uci: string, san: string, fenAfter: string) => {
    const mv: ExploreMove = { uci, san, fen: fenAfter, from: uci.slice(0, 2), to: uci.slice(2, 4) };
    const next = playInLine(line, cursor, mv);
    setLine(next.line);
    setCursor(next.cursor);
    return true;
  };

  // Stockfish's top move(s) for the side to move, with the eval after each (from your side).
  const shownLines = showBest && pos ? pos.lines.slice(0, top3 ? 3 : 1) : [];
  const tops = shownLines
    .map((l) => {
      const uci = l.pv[0];
      const san = uci ? sanOf(fen, uci) : '';
      const cpMover = scoreToCp(l.score);
      return san ? { uci, label: moveLabelAt(fen, san), cpYou: turn === you ? cpMover : -cpMover } : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const colors: Arrow['color'][] = ['best', 'best2', 'best3'];
  const last = cursor > 0 ? line[cursor - 1] : undefined;
  const sideName = turn === 'w' ? 'White' : 'Black';
  const gameOver = pos?.terminal;

  const spinner = thinking ? <span className="spinner" role="status" aria-label="Stockfish is thinking" /> : null;
  const evalNow =
    gameOver === 'checkmate'
      ? `Checkmate — ${turn === 'w' ? 'Black' : 'White'} wins.`
      : gameOver
        ? 'Draw.'
        : whiteCp !== undefined
          ? `${sideEvalText(you === 'w' ? whiteCp : -whiteCp, you)} · ${sideName} to move`
          : `${sideName} to move`;

  const panels: Panels = {
    board: {
      fen,
      orientation,
      movable: gameOver ? undefined : turn,
      onMove,
      lastMove: last ? { from: last.from, to: last.to } : undefined,
      arrows: tops.map((t, i) => arrowOf(t.uci, colors[i])),
    },
    prompt: (
      <div className="explore-prompt">
        <div className="explore-head">
          <span className="explore-tag">Exploring — not your game</span>
          {spinner}
          <button className="explore-close" onClick={onClose} aria-label="Close Explore">
            ✕
          </button>
        </div>
        <p className="explore-eval">
          {evalNow}
          {thinking && pos ? <span className="explore-depth"> · depth {pos.depth}</span> : null}
        </p>
        {showBest && !gameOver && (
          <p className="explore-best">
            {tops.length === 0 ? (
              <span className="muted">Best move: thinking…</span>
            ) : (
              tops.map((t, i) => (
                <span key={t.uci} className={`explore-top top-${i + 1}`}>
                  {i === 0 ? 'Best: ' : ''}
                  <b>{t.label}</b> → {evalText(t.cpYou)}
                  {i < tops.length - 1 ? ' · ' : ''}
                </span>
              ))
            )}
          </p>
        )}
        {!line.length && !showBest && <p className="explore-hint">From the position {start.label}. Move pieces for both sides.</p>}
      </div>
    ),
    banner: (
      <div className="explore-dock">
        <div className="explore-nav">
          <button className="icon" onClick={undo} disabled={cursor === 0} aria-label="Undo">
            ‹
          </button>
          <div className="explore-line" aria-label="Moves you tried">
            <button className={`ms-move ${cursor === 0 ? 'on' : ''}`} onClick={reset}>
              start
            </button>
            {line.map((m, i) => (
              <button key={i} className={`ms-move ${cursor === i + 1 ? 'on' : ''} ${i >= cursor ? 'ahead' : ''}`} onClick={() => setCursor(i + 1)}>
                {labels[i] ?? m.san}
              </button>
            ))}
            {!line.length && <span className="muted small">Your moves appear here</span>}
          </div>
          <button className="icon" onClick={redo} disabled={cursor >= line.length} aria-label="Redo">
            ›
          </button>
        </div>
        <div className="explore-toggles">
          <label className="switch">
            <input
              type="checkbox"
              checked={showBest}
              onChange={(e) => {
                setShowBest(e.target.checked);
                writePref(PREF_BEST, e.target.checked);
              }}
            />
            <span className="switch-track" aria-hidden />
            Show best move
          </label>
          {showBest && (
            <button
              className={`chip top3 ${top3 ? 'on' : ''}`}
              aria-pressed={top3}
              title="Show Stockfish's top 3 moves"
              onClick={() => {
                setTop3(!top3);
                writePref(PREF_TOP, !top3);
              }}
            >
              Top 3
            </button>
          )}
        </div>
        <div className="explore-row">
          {onPractice && (
            <div className="seg small-seg" role="group" aria-label="Board mode">
              <button className="seg-btn" onClick={onPractice}>
                Practice
              </button>
              <button className="seg-btn on" aria-pressed="true">
                Explore
              </button>
            </div>
          )}
          <button className="btn ghost small explore-back" onClick={reset} disabled={cursor === 0}>
            Back to game position
          </button>
        </div>
      </div>
    ),
    details: null,
    stateKey: `explore:${start.key}:${cursor}:${line.length}`,
  };

  return { active: true as const, panels, whiteCp, undo, redo };
}
