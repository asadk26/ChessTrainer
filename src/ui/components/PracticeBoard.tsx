// The practice board inside Guided Review: one decision, explored properly.
//   1. the position before the move, with the move played and Stockfish's choice;
//   2. which other moves are just as good (no single "right" move when there isn't one);
//   3. the line after each, cut to the shortest stretch that shows the difference;
//   4. try your own move — Stockfish answers, you continue for a few moves;
//   5. compare where your line and Stockfish's line lead, in practical terms.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Arrow, PositionEval, SequenceFrame, StoredGame } from '../../domain/types';
import { COLOR_NAME, other, playLine } from '../../chess/board';
import { moveLabel } from '../../chess/pgn';
import { MATE_CP, positionCp, scoreToCp } from '../../analysis/evaluation';
import { compareLines, type LineComparison } from '../../analysis/compareLines';
import { QUALITY_LABEL, gapBetween, qualityOf, qualityOfGap, rankCandidates, type Quality } from '../../analysis/moveQuality';
import { DEEP_DEPTH } from '../../analysis/pipeline';
import { analysePosition } from '../actions';
import { CoachText } from './CoachText';
import type { Panels } from './reviewParts';
import { AiExplain } from './AiExplain';

const arrow = (uci: string, color: Arrow['color']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color });
const MAX_TRY_MOVES = 3;
const TRY_DEPTH = 14;

/** Evaluation for the side that just moved, from the position after the move. */
const cpForMover = (after: PositionEval | undefined) => (after ? -positionCp(after) : 0);

interface Decision {
  fen: string;
  played: StoredGame['plies'][number];
  before: PositionEval;
  after?: PositionEval;
}

function decisionAt(game: StoredGame, ply: number, deep?: { before?: PositionEval; after?: PositionEval }): Decision | undefined {
  const played = game.plies[ply - 1];
  const before = deep?.before ?? game.analysis?.positions[ply - 1];
  if (!played || !before?.lines[0]) return undefined;
  return { fen: played.fenBefore, played, before, after: deep?.after ?? game.analysis?.positions[ply] };
}

/** How the move played compares with Stockfish's choice, and why — from the stored analysis. */
export function gameMoveComparison(game: StoredGame, ply: number, deep?: { before?: PositionEval; after?: PositionEval }) {
  const d = decisionAt(game, ply, deep);
  if (!d) return undefined;
  const best = d.before.lines[0];
  const bestCp = scoreToCp(best.score);
  const playedCp = cpForMover(d.after);
  const quality: Quality =
    qualityOf(d.before, d.played.uci, playedCp) ?? qualityOfGap(gapBetween(bestCp, playedCp), d.played.uci === best.pv[0]);
  const ranked = rankCandidates(d.before);
  const sanOf = (uci: string) => playLine(d.fen, [uci])[0]?.san ?? uci;
  const alternatives = ranked.filter((r) => r.quality === 'equal' && r.uci !== d.played.uci).map((r) => sanOf(r.uci));
  const isUser = d.played.color === game.userColor;
  const comparison =
    isUser && quality !== 'best' && quality !== 'equal'
      ? compareLines({
          fen: d.fen,
          mover: d.played.color,
          preferred: { ucis: best.pv, cp: bestCp },
          other: { ucis: [d.played.uci, ...(d.after?.lines[0]?.pv ?? [])], cp: playedCp },
        })
      : undefined;
  return { decision: d, bestUci: best.pv[0], bestSan: sanOf(best.pv[0]), bestCp, playedCp, quality, alternatives, comparison, isUser };
}

type Mode = 'overview' | 'line' | 'try' | 'compare';
interface TryMove extends SequenceFrame {
  uci: string;
  by: 'you' | 'engine';
  quality?: Quality;
}

/** `startIn: 'try'` opens straight on "play your own moves" (Guided Review's Try moves button). */
export function usePracticeBoard(game: StoredGame, ply: number | null, onClose: () => void, startIn: 'overview' | 'try' = 'overview'): Panels | null {
  const [mode, setMode] = useState<Mode>('overview');
  const [lineView, setLineView] = useState<'preferred' | 'other'>('preferred');
  const [lineStep, setLineStep] = useState(0);
  const [longLine, setLongLine] = useState(false);
  const [deep, setDeep] = useState<{ before?: PositionEval; after?: PositionEval }>({});
  const [deepening, setDeepening] = useState(false);
  const [tryMoves, setTryMoves] = useState<TryMove[]>([]);
  const [tryBusy, setTryBusy] = useState(false);
  const [tryEnd, setTryEnd] = useState<{ cp: number; pv: string[] } | null>(null);
  const [compareView, setCompareView] = useState<'yours' | 'stockfish'>('yours');
  const token = useRef(0);

  // Reset whenever a different decision is opened, and look deeper if this one wasn't analysed deeply.
  useEffect(() => {
    token.current++;
    const my = token.current;
    setMode(startIn === 'try' && ply !== null && game.plies[ply - 1]?.color === game.userColor ? 'try' : 'overview');
    setLineView('preferred');
    setLineStep(0);
    setLongLine(false);
    setDeep({});
    setTryMoves([]);
    setTryBusy(false);
    setTryEnd(null);
    setCompareView('yours');
    if (ply === null) return;
    const played = game.plies[ply - 1];
    const before = game.analysis?.positions[ply - 1];
    const after = game.analysis?.positions[ply];
    if (!played || !before || before.depth >= DEEP_DEPTH) return;
    setDeepening(true);
    void Promise.all([
      analysePosition(played.fenBefore, DEEP_DEPTH, 3),
      after && !after.terminal ? analysePosition(played.fenAfter, DEEP_DEPTH, 1) : Promise.resolve(undefined),
    ]).then(([b, a]) => {
      if (token.current !== my) return;
      setDeep({ before: b?.lines.length ? b : undefined, after: a?.lines.length ? a : undefined });
      setDeepening(false);
    });
  }, [ply, game]);

  const info = useMemo(() => (ply === null ? undefined : gameMoveComparison(game, ply, deep)), [game, ply, deep]);

  if (ply === null || !info) return null;
  const { decision: d, bestUci, bestSan, bestCp, quality, alternatives, comparison, isUser } = info;
  const mover = d.played.color;
  const oppName = COLOR_NAME[other(mover)];
  const who = isUser ? 'your move' : `${game.opponentName}'s move`;
  const btn = (label: string, onClick: () => void, kind: 'primary' | 'ghost' = 'ghost', disabled = false) => (
    <button key={label} className={`btn ${kind}`} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
  const qChip = (q: Quality) => <span className={`q-chip q-${q}`}>{QUALITY_LABEL[q]}</span>;
  const back = (
    <button className="btn ghost" onClick={() => setMode('overview')}>
      Back
    </button>
  );

  // ------------------------------------------------------------- overview
  if (mode === 'overview') {
    const arrows: Arrow[] = [arrow(bestUci, 'best')];
    if (d.played.uci !== bestUci) arrows.unshift(arrow(d.played.uci, 'played'));
    return {
      board: { fen: d.fen, orientation: game.userColor, arrows },
      prompt: (
        <>
          <p className="move-caption">
            <b>{moveLabel(d.played)}</b> <span className="muted">— {who}</span> {qChip(quality)}
          </p>
          {quality === 'best' ? (
            <p>This was Stockfish's first choice.</p>
          ) : quality === 'equal' ? (
            <p>
              As good as Stockfish's first choice (<b>{bestSan}</b>) — nothing to fix here.
            </p>
          ) : (
            <p className="best-move">
              Stockfish's choice: <b>{bestSan}</b> <span className="muted small">(green arrow; orange is what was played)</span>
            </p>
          )}
          {alternatives.length > 0 && (
            <p className="muted small">
              Just as good: <b>{alternatives.join(', ')}</b> — there isn't one single right move here.
            </p>
          )}
          {comparison && (
            <div className="why-box">
              <span className="eyebrow">Why {bestSan} leads to a better position</span>
              <CoachText text={comparison.summary} />
            </div>
          )}
          {deepening && <p className="muted small">Checking this position more deeply…</p>}
          {isUser && quality !== 'best' && <AiExplain game={game} ply={ply} bestSan={bestSan} compact />}
        </>
      ),
      banner: (
        <div className="actions practice-actions">
          {btn(`See the lines`, () => (setMode('line'), setLineStep(0), setLineView('preferred')), 'primary')}
          {isUser && btn('Try your own move', () => (setMode('try'), setTryMoves([]), setTryEnd(null)))}
          {btn('Back to the game', onClose)}
        </div>
      ),
      details: null,
      stateKey: `practice:${ply}:overview`,
    };
  }

  // ----------------------------------------------------------------- lines
  if (mode === 'line') {
    const prefFull = playLine(d.fen, d.before.lines[0].pv, 10);
    const otherFull = playLine(d.fen, [d.played.uci, ...(d.after?.lines[0]?.pv ?? [])], 10);
    const prefShort = comparison?.preferredFrames.length ? comparison.preferredFrames : prefFull.slice(0, 4);
    const otherShort = comparison?.otherFrames.length ? comparison.otherFrames : otherFull.slice(0, 4);
    const frames = lineView === 'preferred' ? (longLine ? prefFull : prefShort) : longLine ? otherFull : otherShort;
    const step = Math.min(lineStep, frames.length);
    const at = step ? frames[step - 1] : undefined;
    const showOther = d.played.uci !== bestUci;
    return {
      board: {
        fen: at ? at.fen : d.fen,
        orientation: game.userColor,
        lastMove: at ? { from: at.from, to: at.to } : undefined,
        arrows: step === 0 && frames[0] ? [arrow(frames[0].from + frames[0].to, lineView === 'preferred' ? 'best' : 'played')] : [],
      },
      prompt: (
        <>
          {showOther && (
            <div className="seg small-seg">
              <button className={`seg-btn ${lineView === 'preferred' ? 'on' : ''}`} onClick={() => (setLineView('preferred'), setLineStep(0))}>
                After {bestSan} (Stockfish)
              </button>
              <button className={`seg-btn ${lineView === 'other' ? 'on' : ''}`} onClick={() => (setLineView('other'), setLineStep(0))}>
                After {d.played.san} ({isUser ? 'you' : 'game'})
              </button>
            </div>
          )}
          <div className="line-moves">
            <button className={`ms-move ${step === 0 ? 'on' : ''}`} onClick={() => setLineStep(0)}>
              start
            </button>
            {frames.map((f, i) => (
              <button key={i} className={`ms-move ${step === i + 1 ? 'on' : ''} ${i === 0 ? (lineView === 'preferred' ? 'best' : 'played') : ''}`} onClick={() => setLineStep(i + 1)}>
                {f.san}
              </button>
            ))}
          </div>
          <p className="muted small">
            {longLine ? "Stockfish's full continuation — it shows the idea, not the only way to play. " : 'Only as many moves as it takes to see the difference. '}
            <button className="link small" onClick={() => (setLongLine(!longLine), setLineStep(0))}>
              {longLine ? 'Show the short version' : 'Show the longer line'}
            </button>
          </p>
          {comparison && step === frames.length && <CoachText text={comparison.summary} className="ply-note" />}
        </>
      ),
      banner: (
        <div className="board-controls">
          <button className="icon" onClick={() => setLineStep(Math.max(0, step - 1))} aria-label="Previous move in line">
            ‹
          </button>
          <button className="btn primary next-btn" onClick={() => setLineStep(Math.min(frames.length, step + 1))} disabled={step >= frames.length}>
            Next ›
          </button>
          {back}
        </div>
      ),
      details: null,
      stateKey: `practice:${ply}:line:${lineView}:${step}`,
    };
  }

  // --------------------------------------------------------- try your own
  const yourMoves = tryMoves.filter((m) => m.by === 'you').length;
  const current = tryMoves.at(-1)?.fen ?? d.fen;
  const yourTurn = (current.split(' ')[1] as typeof mover) === mover;

  const onTry = (uci: string, san: string, fen: string) => {
    if (tryBusy || !yourTurn || yourMoves >= MAX_TRY_MOVES) return false;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const refCp = tryEnd?.cp ?? bestCp;
    const first = tryMoves.length === 0;
    const mine: TryMove = { uci, san, fen, from, to, caption: '', by: 'you' };
    setTryMoves((xs) => [...xs, mine]);
    setTryBusy(true);
    const my = token.current;
    void analysePosition(fen, TRY_DEPTH, 1).then((res) => {
      if (token.current !== my) return;
      const cp = res ? cpForMover(res) : refCp;
      const q = first ? (qualityOf(d.before, uci, cp) ?? qualityOfGap(gapBetween(refCp, cp), uci === bestUci)) : qualityOfGap(gapBetween(refCp, cp));
      const replyUci = res?.lines[0]?.pv[0];
      setTryMoves((xs) => xs.map((m) => (m === mine ? { ...m, quality: q } : m)));
      if (!replyUci) {
        setTryEnd({ cp: res?.terminal === 'checkmate' ? MATE_CP : cp, pv: [] });
        setTryBusy(false);
        return;
      }
      window.setTimeout(() => {
        if (token.current !== my) return;
        const f = playLine(fen, [replyUci])[0];
        if (f) setTryMoves((xs) => [...xs, { ...f, uci: replyUci, by: 'engine' }]);
        setTryEnd({ cp, pv: res?.lines[0]?.pv.slice(1) ?? [] });
        setTryBusy(false);
      }, 450);
    });
    return true;
  };

  if (mode === 'try') {
    const last = tryMoves.at(-1);
    const canCompare = yourMoves > 0 && !tryBusy;
    const done = yourMoves >= MAX_TRY_MOVES && !tryBusy;
    return {
      board: {
        fen: current,
        orientation: game.userColor,
        lastMove: last ? { from: last.from, to: last.to } : undefined,
        arrows: !tryMoves.length && d.played.uci !== bestUci ? [arrow(d.played.uci, 'played')] : [],
        movable: !tryBusy && yourTurn && yourMoves < MAX_TRY_MOVES ? mover : undefined,
        onMove: onTry,
      },
      prompt: (
        <>
          <p className="move-caption">
            <b>Your idea</b> <span className="muted">— instead of {moveLabel(d.played)}</span>
          </p>
          {!tryMoves.length && (
            <p>
              Play a move for {COLOR_NAME[mover]} (drag, or tap then tap). Stockfish will answer, and you can continue for up to {MAX_TRY_MOVES} moves before comparing.
            </p>
          )}
          {tryMoves.length > 0 && (
            <ol className="try-list">
              {tryMoves.map((m, i) =>
                m.by === 'you' ? (
                  <li key={i}>
                    <b>{m.san}</b> {m.quality ? qChip(m.quality) : <span className="muted small">checking…</span>}
                    {tryMoves[i + 1] ? <span className="muted"> · {oppName} answers {tryMoves[i + 1].san}</span> : null}
                  </li>
                ) : null,
              )}
            </ol>
          )}
          {done && <p className="muted small">That's enough to compare.</p>}
        </>
      ),
      banner: (
        <div className="actions practice-actions">
          {btn(`Compare with ${bestSan}`, () => (setMode('compare'), setCompareView('yours')), 'primary', !canCompare)}
          {btn('Reset', () => (setTryMoves([]), setTryEnd(null)), 'ghost', tryBusy)}
          {back}
        </div>
      ),
      details: null,
      stateKey: `practice:${ply}:try:${tryMoves.length}:${tryBusy}`,
    };
  }

  // ---------------------------------------------------------------- compare
  const yourLine = [...tryMoves.map((m) => m.uci), ...(tryEnd?.pv ?? [])];
  const yourFirst = tryMoves[0];
  const sameAsBest = yourFirst?.uci === bestUci;
  const cmp: LineComparison | undefined =
    yourFirst && !sameAsBest
      ? compareLines({
          fen: d.fen,
          mover,
          preferred: { ucis: d.before.lines[0].pv, cp: bestCp },
          // If every move you tried was as good as Stockfish's, don't let depth noise say otherwise.
          other: { ucis: yourLine, cp: tryMoves.every((m) => m.by === 'engine' || m.quality === 'best' || m.quality === 'equal') ? bestCp : tryEnd?.cp ?? bestCp },
          maxPlies: Math.max(4, tryMoves.length),
        })
      : undefined;
  // Show at least the moves you actually played.
  const yourFrames = playLine(d.fen, yourLine, Math.max(tryMoves.length, cmp?.otherFrames.length ?? 0));
  const sfFrames = cmp?.preferredFrames.length ? cmp.preferredFrames : playLine(d.fen, d.before.lines[0].pv, Math.max(2, tryMoves.length));
  const shown = compareView === 'yours' ? yourFrames : sfFrames;
  const end = shown.at(-1);
  const summary = sameAsBest
    ? `You found Stockfish's move, ${bestSan}.`
    : cmp?.summary ?? 'Not enough moves to compare yet.';
  return {
    board: { fen: end?.fen ?? d.fen, orientation: game.userColor, lastMove: end ? { from: end.from, to: end.to } : undefined },
    prompt: (
      <>
        <div className="seg small-seg">
          <button className={`seg-btn ${compareView === 'yours' ? 'on' : ''}`} onClick={() => setCompareView('yours')}>
            Your line
          </button>
          <button className={`seg-btn ${compareView === 'stockfish' ? 'on' : ''}`} onClick={() => setCompareView('stockfish')}>
            Stockfish's line
          </button>
        </div>
        <p className="muted small">{shown.map((f) => f.san).join(' ')} — the board shows where it leads.</p>
        <div className="why-box">
          <span className="eyebrow">{sameAsBest ? 'Nice' : `Your ${yourFirst?.san ?? 'move'} vs ${bestSan}`}</span>
          <CoachText text={summary} />
        </div>
      </>
    ),
    banner: (
      <div className="actions practice-actions">
        {btn('Try another move', () => (setMode('try'), setTryMoves([]), setTryEnd(null)), 'primary')}
        {btn('Back to the overview', () => setMode('overview'))}
      </div>
    ),
    details: null,
    stateKey: `practice:${ply}:compare:${compareView}`,
  };
}
