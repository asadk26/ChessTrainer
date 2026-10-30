// Two short interactions for Guided Review:
//  - "Find it first": stop before one of your mistakes/blunders, one try at a better move, then reveal.
//  - "Show me": Stockfish's line, one tapped move at a time, each with an arrow and a one-line caption.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Arrow, StoredGame } from '../../domain/types';
import type { BoardProps } from './Board';
import { Verdict, type Panels } from './reviewParts';
import { CoachText } from './CoachText';
import { gapBetween, qualityOf, qualityOfGap, type Quality } from '../../analysis/moveQuality';
import { scoreToCp } from '../../analysis/evaluation';

/** Plain words for an evaluation from your side. */
const bandText = (cp: number) => (cp >= 300 ? "you're winning" : cp >= 120 ? "you're clearly better" : cp >= 40 ? "you're slightly better" : cp > -40 ? 'about equal' : cp > -120 ? "you're slightly worse" : cp > -300 ? "you're clearly worse" : "you're losing");
import { lineSteps } from '../../analysis/lineSteps';
import { materialText } from '../../analysis/linePoint';
import { compareLines } from '../../analysis/compareLines';
import { positionCp } from '../../analysis/evaluation';
import { evalText } from '../../coach/momentContext';
import { moveLabel } from '../../chess/pgn';
import { uciToSan } from '../../chess/board';
import { analysePosition, evaluateMove } from '../actions';
import { sideEvalText } from '../../coach/moveCard';
import { COLOR_NAME, materialBalance } from '../../chess/board';

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

  // The point of the line, said after its last move: what it wins, where Stockfish stands, and —
  // for your own moves — how it compares with the better move.
  const point = useMemo(() => {
    if (!view || !steps.length || !game.analysis) return undefined;
    const p = game.plies[view.ply - 1];
    const a = game.analysis;
    const start = view.kind === 'refutation' ? p.fenAfter : p.fenBefore;
    const material = materialText(start, steps[steps.length - 1].fen, game.userColor);
    const pos = view.kind === 'refutation' ? a.positions[view.ply] : a.positions[view.ply - 1];
    // Engine scores are for the side to move; turn them into your point of view.
    const toMove = view.kind === 'refutation' ? (p.color === 'w' ? 'b' : 'w') : p.color;
    const cp = pos ? (toMove === game.userColor ? positionCp(pos) : -positionCp(pos)) : undefined;
    let compare: string | undefined;
    if (view.kind === 'refutation' && p.color === game.userColor && a.positions[view.ply - 1]?.lines[0]) {
      const before = a.positions[view.ply - 1];
      const c = compareLines({
        fen: p.fenBefore,
        mover: p.color,
        preferred: { ucis: before.lines[0].pv, cp: scoreToCp(before.lines[0].score) },
        other: { ucis: [p.uci, ...(a.positions[view.ply]?.lines[0]?.pv ?? [])], cp: cp ?? 0 },
      });
      if (c?.clear) compare = c.summary;
    }
    // A line for the opponent's move names the side: "If Black had played Qa5: Black slightly better (you −0.5)".
    const theirs = view.kind === 'better' && p.color !== game.userColor;
    const evalLine = cp === undefined ? '' : theirs ? `If ${COLOR_NAME[p.color]} had played ${steps[0].san}: ${sideEvalText(cp, game.userColor)}.` : `Stockfish: ${bandText(cp)} (${evalText(cp)}).`;
    const parts = [
      material ? `${material.charAt(0).toUpperCase()}${material.slice(1)}.` : 'No material changes hands in these moves.',
      evalLine,
      compare ?? '',
    ];
    return parts.filter(Boolean).join(' ');
  }, [game, view?.ply, view?.kind, steps]); // eslint-disable-line react-hooks/exhaustive-deps

  // The eval bar follows the line: each step's position, from the shared engine (cached), White's view.
  const [stepCp, setStepCp] = useState<Record<string, number>>({});
  const stepFen = view && steps.length ? (view.idx >= 0 ? steps[view.idx].fen : undefined) : undefined;
  useEffect(() => {
    if (!stepFen || stepCp[stepFen] !== undefined) return;
    let live = true;
    void analysePosition(stepFen, 12).then((pos) => {
      if (!live || !pos) return;
      const white = stepFen.split(' ')[1] === 'w';
      setStepCp((m) => ({ ...m, [stepFen]: white ? positionCp(pos) : -positionCp(pos) }));
    });
    return () => {
      live = false;
    };
  }, [stepFen]); // eslint-disable-line react-hooks/exhaustive-deps

  // One comparison at the top of the best line for your own move: "Your move: 24.Qh4 (+0.3) · Best line: Qc2 (+2.5)".
  const compareTop = useMemo(() => {
    if (!view || view.kind !== 'better' || !game.analysis) return undefined;
    const p = game.plies[view.ply - 1];
    const e = game.analysis.moves[view.ply - 1];
    if (!e || p.color !== game.userColor || !e.bestSan || e.isBest) return undefined;
    return `Your move: ${moveLabel(p)} (${evalText(e.cpAfter)}) · Best line: ${e.bestSan} (${evalText(e.cpBefore)})`;
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
          {compareTop && <p className="line-compare">{compareTop}</p>}
          <ol className={`line-steps ${last && point ? 'at-end' : ''}`}>
            {steps.map((x, i) => (
              <li key={i} className={`${i === view.idx ? 'on' : i < view.idx ? 'done' : 'todo'}${i <= view.idx && materialBalance(x.before, 'w') !== materialBalance(x.fen, 'w') ? ' material' : ''}`}>
                {i <= view.idx ? <CoachText text={x.caption} /> : <span className="muted">…</span>}
              </li>
            ))}
          </ol>
          {view.idx < 0 && <p className="muted small">Tap Next to play the first move.</p>}
          {last && point && (
            <div className="line-point">
              <span className="eyebrow">Where it leads</span>
              <CoachText text={point} />
            </div>
          )}
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
        compare: compareTop,
        /** White's view, for the eval bar: the current step's position (undefined until the engine answers). */
        whiteCp: view.idx >= 0 ? stepCp[steps[view.idx].fen] : undefined,
        materialChange: view.idx >= 0 && materialBalance(steps[view.idx].before, 'w') !== materialBalance(steps[view.idx].fen, 'w'),
        point: view.idx >= steps.length - 1 ? point : undefined,
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

