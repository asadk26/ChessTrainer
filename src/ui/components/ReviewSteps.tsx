// Two short interactions for Guided Review:
//  - "Find it first": stop before one of your mistakes/blunders, one try at a better move, then reveal.
//  - "Show me": Stockfish's line, one tapped move at a time, each with an arrow and a one-line caption.
import { useMemo, useState, type ReactNode } from 'react';
import type { Arrow, StoredGame } from '../../domain/types';
import type { BoardProps } from './Board';
import { Verdict, type Panels } from './reviewParts';
import { CoachText } from './CoachText';
import { gapBetween, qualityOf, qualityOfGap, type Quality } from '../../analysis/moveQuality';
import { scoreToCp } from '../../analysis/evaluation';
import { lineSteps } from '../../analysis/lineSteps';
import { moveLabel } from '../../chess/pgn';
import { uciToSan } from '../../chess/board';
import { evaluateMove } from '../actions';

const arrow = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });

// ------------------------------------------------------------ find it first

export function useFindFirst(game: StoredGame, onContinue: (ply: number) => void) {
  const [state, setState] = useState<{ ply: number; guess?: { uci: string; san: string; fen: string; quality?: Quality; checking?: boolean } } | null>(null);

  const panels = ((): Panels | null => {
    if (!state) return null;
    const p = game.plies[state.ply - 1];
    const pos = game.analysis?.positions[state.ply - 1];
    const best = pos?.lines[0]?.pv[0];
    const bestSan = best ? uciToSan(p.fenBefore, best) : undefined;
    const g = state.guess;
    const done = !!g && !g.checking;
    const finish = () => (setState(null), onContinue(state.ply));
    const onMove = (uci: string, san: string, fen: string) => {
      if (g) return false;
      if (uci === p.uci) {
        setState({ ...state, guess: { uci, san, fen, quality: qualityOf(pos, uci) ?? 'mistake' } });
        return true;
      }
      const known = qualityOf(pos, uci);
      if (known) {
        setState({ ...state, guess: { uci, san, fen, quality: known } });
        return true;
      }
      setState({ ...state, guess: { uci, san, fen, checking: true } });
      void evaluateMove(fen).then((res) => {
        const bestCp = pos?.lines[0] ? scoreToCp(pos.lines[0].score) : undefined;
        const quality = res && bestCp !== undefined ? qualityOfGap(gapBetween(bestCp, res.cp)) : undefined;
        setState((s) => (s && s.ply === state.ply ? { ...s, guess: { uci, san, fen, quality: quality ?? 'mistake' } } : s));
      });
      return true;
    };
    const good = g?.quality && ['best', 'equal', 'good'].includes(g.quality);
    const board: BoardProps = !g
      ? { fen: p.fenBefore, orientation: game.userColor, movable: game.userColor, onMove }
      : {
          fen: g.fen,
          orientation: game.userColor,
          arrows: [arrow(g.uci, 'guess'), ...(done && best && best !== g.uci ? [arrow(best, 'best')] : [])],
          lastMove: { from: g.uci.slice(0, 2), to: g.uci.slice(2, 4) },
        };
    const verdict: ReactNode = !g ? (
      <Verdict tone="neutral" title={`Your turn: find a better move for ${game.userColor === 'w' ? 'White' : 'Black'}`} text="One try — then I'll show you." />
    ) : g.checking ? (
      <Verdict tone="neutral" title={`Checking ${g.san}…`} />
    ) : g.uci === p.uci ? (
      <Verdict tone="bad" title={`That's the move you played (${g.san})`} text={`Stockfish's move was ${bestSan} (green arrow).`} />
    ) : good ? (
      <Verdict tone="good" title={`Yes — ${g.san}${g.quality === 'good' ? ' works' : ' is right'}`} text={g.uci === best ? "That's Stockfish's first choice." : `Stockfish rates it ${g.quality === 'good' ? 'good — its first choice was' : 'as good as'} ${bestSan}.`} />
    ) : (
      <Verdict tone="bad" title={`Not quite — ${g.san}`} text={`Stockfish's move was ${bestSan} (green arrow).`} />
    );
    return {
      board,
      prompt: (
        <>
          <p className="move-caption">
            <b>Find it first</b> <span className="muted">— before {moveLabel(p)}</span>
          </p>
          <p>Stockfish found something better than the move you played here. Can you?</p>
        </>
      ),
      banner: (
        <>
          {verdict}
          <div className="actions">
            {!g && (
              <button className="btn ghost" onClick={finish}>
                Skip
              </button>
            )}
            {done && (
              <button className="btn primary" onClick={finish}>
                Continue — see {moveLabel(p)} →
              </button>
            )}
          </div>
        </>
      ),
      details: null,
      stateKey: `find:${state.ply}:${g?.uci ?? ''}:${g?.checking ? 1 : 0}`,
    };
  })();

  return { active: !!state, start: (ply: number) => setState({ ply }), cancel: () => setState(null), panels };
}

// ------------------------------------------------------------ show me (line steps)

export type LineKind = 'refutation' | 'better';

export function useLineView(game: StoredGame) {
  const [view, setView] = useState<{ ply: number; kind: LineKind; idx: number } | null>(null);
  const steps = useMemo(() => {
    if (!view) return [];
    const p = game.plies[view.ply - 1];
    const a = game.analysis;
    if (!a) return [];
    return view.kind === 'refutation'
      ? lineSteps(p.fenAfter, a.positions[view.ply]?.lines[0]?.pv ?? [], game.userColor, 5)
      : lineSteps(p.fenBefore, a.positions[view.ply - 1]?.lines[0]?.pv ?? [], game.userColor, 5);
  }, [game, view?.ply, view?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const panels = ((): Panels | null => {
    if (!view || !steps.length) return null;
    const p = game.plies[view.ply - 1];
    const s = view.idx >= 0 ? steps[view.idx] : undefined;
    const start = view.kind === 'refutation' ? p.fenAfter : p.fenBefore;
    const mine = (c: string) => c === game.userColor;
    const board: BoardProps = {
      fen: s ? s.fen : start,
      orientation: game.userColor,
      arrows: s ? [arrow(s.uci, view.kind === 'better' && mine(s.color) ? 'best' : mine(s.color) ? 'played' : 'reply')] : view.kind === 'refutation' ? [arrow(p.uci, 'played')] : [],
      lastMove: s ? { from: s.from, to: s.to } : view.kind === 'refutation' ? { from: p.from, to: p.to } : undefined,
    };
    const last = view.idx >= steps.length - 1;
    const title = view.kind === 'refutation' ? `What goes wrong after ${moveLabel(p)}` : `The better line instead of ${moveLabel(p)}`;
    return {
      board,
      prompt: (
        <>
          <p className="move-caption">
            <b>{title}</b> <span className="muted">· move {Math.max(0, view.idx + 1)} of {steps.length}</span>
          </p>
          <ol className="line-steps">
            {steps.map((x, i) => (
              <li key={i} className={i === view.idx ? 'on' : i < view.idx ? 'done' : 'todo'}>
                {i <= view.idx ? <CoachText text={x.caption} /> : <span className="muted">…</span>}
              </li>
            ))}
          </ol>
          {view.idx < 0 && <p className="muted small">Tap Next to play the first move.</p>}
        </>
      ),
      banner: (
        <div className="board-controls">
          <button className="icon" aria-label="Back" disabled={view.idx < 0} onClick={() => setView({ ...view, idx: view.idx - 1 })}>
            ‹
          </button>
          {!last ? (
            <button className="btn primary next-btn" onClick={() => setView({ ...view, idx: view.idx + 1 })}>
              Next ›
            </button>
          ) : (
            <button className="btn primary next-btn" onClick={() => setView(null)}>
              Done
            </button>
          )}
          <button className="btn ghost" onClick={() => setView(null)}>
            Close
          </button>
        </div>
      ),
      details: null,
      stateKey: `line:${view.ply}:${view.kind}:${view.idx}`,
    };
  })();

  const info = view && steps.length
    ? {
        title: view.kind === 'refutation' ? `What goes wrong after ${moveLabel(game.plies[view.ply - 1])}` : `The better line instead of ${moveLabel(game.plies[view.ply - 1])}`,
        caption: view.idx >= 0 ? steps[view.idx].caption : 'Tap Next to play the first move.',
        idx: view.idx,
        total: steps.length,
      }
    : undefined;
  return {
    active: !!view && steps.length > 0,
    info,
    open: (ply: number, kind: LineKind) => setView({ ply, kind, idx: -1 }),
    close: () => setView(null),
    next: () => view && setView({ ...view, idx: Math.min(steps.length - 1, view.idx + 1) }),
    prev: () => view && setView({ ...view, idx: Math.max(-1, view.idx - 1) }),
    panels,
  };
}

