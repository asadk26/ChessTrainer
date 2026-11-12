// The one board used everywhere (Guided Review, Explore, drills, Play, diagrams).
//
// react-chessboard only draws the position, arrows and move animation. Input is ours: a transparent
// layer over the board takes pointer events (mouse, touch and pen alike), so drag-and-drop and
// tap-tap behave the same on every screen and every device. We don't use the library's drag
// support: its pieces only re-check "can I be dragged?" when the position changes, so a board that
// became movable without a new position (Browse → "Find it first", "Try moves") silently refused
// drags while taps still worked.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess, type Square } from 'chess.js';
import type { Arrow, Color } from '../../domain/types';
import { useHover } from './CoachText';
import { CLASS_ICON, CLASS_LABEL, type MoveClass } from '../../analysis/moveQuality';
import { DRAG_THRESHOLD_PX, legalTargets, needsPromotion, squareAt, type PromotionPiece } from './boardInput';

/** The badge sits on the top-right corner of its square, wherever the board is turned. */
function SquareBadge({ square, cls, orientation }: { square: string; cls: MoveClass; orientation: Color }) {
  const f = square.charCodeAt(0) - 97;
  const r = Number(square[1]) - 1;
  const col = orientation === 'w' ? f : 7 - f;
  const row = orientation === 'w' ? 7 - r : r;
  return (
    <span className={`qb qb-${cls} square-badge`} style={{ left: `${(col + 1) * 12.5}%`, top: `${row * 12.5}%` }} title={CLASS_LABEL[cls]} aria-label={CLASS_LABEL[cls]}>
      {CLASS_ICON[cls]}
    </span>
  );
}

export const ARROW_COLORS: Record<Arrow['color'], string> = {
  played: 'rgba(214, 128, 38, 0.85)',
  best: 'rgba(46, 140, 92, 0.88)',
  best2: 'rgba(46, 140, 92, 0.55)',
  best3: 'rgba(46, 140, 92, 0.32)',
  reply: 'rgba(196, 64, 64, 0.82)',
  threat: 'rgba(196, 64, 64, 0.82)',
  guess: 'rgba(60, 108, 196, 0.85)',
};

const TONE: Record<string, React.CSSProperties> = {
  danger: { boxShadow: 'inset 0 0 0 4px rgba(196,64,64,0.75)' },
  good: { boxShadow: 'inset 0 0 0 4px rgba(46,140,92,0.75)' },
  focus: { boxShadow: 'inset 0 0 0 4px rgba(214,128,38,0.85)', backgroundColor: 'rgba(214,128,38,0.16)' },
  last: { backgroundColor: 'rgba(235, 200, 90, 0.42)' },
  hover: { boxShadow: 'inset 0 0 0 4px rgba(60,108,196,0.85)', backgroundColor: 'rgba(60,108,196,0.18)' },
  selected: { backgroundColor: 'rgba(60,108,196,0.35)' },
  dragOver: { boxShadow: 'inset 0 0 0 3px rgba(255,255,255,0.75)' },
};
const DOT = { backgroundImage: 'radial-gradient(circle, rgba(30,60,40,0.4) 0, rgba(30,60,40,0.4) 21%, transparent 22%)' };
const RING = { backgroundImage: 'radial-gradient(circle, transparent 0, transparent 72%, rgba(30,60,40,0.38) 73%)' };

const PROMO_GLYPH: Record<PromotionPiece, string> = { q: '♛', r: '♜', b: '♝', n: '♞' };
const PROMO_NAME: Record<PromotionPiece, string> = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };

export interface BoardProps {
  fen: string;
  orientation: Color;
  arrows?: Arrow[];
  highlights?: { square: string; tone: 'danger' | 'good' | 'focus' | 'last' }[];
  lastMove?: { from: string; to: string };
  /** When set, the side that may move pieces; the callback returns false to refuse the move. */
  movable?: Color;
  /** A move-quality badge pinned to a square's corner (the square the move landed on). */
  badge?: { square: string; cls: MoveClass };
  onMove?: (uci: string, san: string, fenAfter: string) => boolean | void;
  /** Fixed width in px (diagrams); by default the board fills its container. */
  size?: number;
  /** Coordinates along the edges (default on). */
  notation?: boolean;
}

interface Pending {
  pointerId: number;
  x0: number;
  y0: number;
  square: Square;
  /** The pointer went down on a piece the user may move. */
  own: boolean;
  /** …and that piece was already selected (a second tap deselects it). */
  wasSelected: boolean;
  dragging: boolean;
}

/** Chessboard with arrows/highlights; drag-and-drop and tap-tap both always work. */
export function Board({ fen, orientation, arrows = [], highlights = [], lastMove, movable, onMove, badge, size, notation = true }: BoardProps) {
  const hover = useHover();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const frame = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const pending = useRef<Pending | null>(null);
  // After a drop the piece is already where it landed: don't animate it there from its old square.
  const noAnimFen = useRef<string | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<{ from: Square; html: string; over: Square | null; x: number; y: number } | null>(null);
  const [promo, setPromo] = useState<{ from: Square; to: Square; color: Color; dropped: boolean } | null>(null);

  const chess = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return null;
    }
  }, [fen]);
  const interactive = !!movable && !!onMove && !!chess && chess.turn() === movable;

  // A new position (or the board stops taking moves): forget any half-made move.
  useEffect(() => {
    pending.current = null;
    setSelected(null);
    setDrag(null);
    setPromo(null);
  }, [fen, interactive]);

  const canMoveFrom = (sq: Square) => {
    if (!interactive || !chess) return false;
    const p = chess.get(sq);
    return !!p && p.color === movable;
  };
  const targetsOf = (sq: Square | null) => (sq && chess && canMoveFrom(sq) ? legalTargets(chess, sq) : new Map<Square, boolean>());
  const shownFrom = drag?.from ?? selected;
  const targets = useMemo(() => targetsOf(shownFrom), [shownFrom, chess, interactive]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Make the move; true if it was made (or the promotion picker opened for it). */
  const commit = (from: Square, to: Square, dropped: boolean, promotion?: PromotionPiece): boolean => {
    if (!chess || !onMove || !canMoveFrom(from) || !targetsOf(from).has(to)) return false;
    if (!promotion && needsPromotion(chess, from, to)) {
      setPromo({ from, to, color: chess.turn(), dropped });
      setSelected(null);
      return true;
    }
    const c = new Chess(fen);
    try {
      const mv = c.move({ from, to, promotion });
      if (dropped) noAnimFen.current = c.fen();
      const ok = onMove(mv.from + mv.to + (mv.promotion ?? ''), mv.san, c.fen()) !== false;
      if (!ok) noAnimFen.current = null;
      setSelected(null);
      return ok;
    } catch {
      return false;
    }
  };

  const armed = useRef<PromotionPiece | null>(null);
  const pickPromotion = (p: PromotionPiece) => {
    armed.current = null;
    if (!promo) return;
    setPromo(null);
    commit(promo.from, promo.to, promo.dropped, p);
  };

  const at = (e: { clientX: number; clientY: number }) => (layer.current ? squareAt(e.clientX, e.clientY, layer.current.getBoundingClientRect(), orientation) : null);
  const placeGhost = (e: { clientX: number; clientY: number }) => {
    const g = ghost.current;
    const rect = frame.current?.getBoundingClientRect();
    if (g && rect) g.style.transform = `translate(${e.clientX - rect.left}px, ${e.clientY - rect.top}px) translate(-50%, -50%)`;
  };
  const endDrag = () => {
    pending.current = null;
    setDrag(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pending.current) return; // a second finger: ignore it
    e.preventDefault();
    if (promo) return setPromo(null); // tapping off the picker cancels the promotion
    const sq = at(e);
    if (!sq) return;
    try {
      layer.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* not supported: we still get events while over the board */
    }
    const own = canMoveFrom(sq);
    pending.current = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, square: sq, own, wasSelected: selected === sq, dragging: false };
    if (own) setSelected(sq); // show its moves straight away
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pending.current;
    if (!p || p.pointerId !== e.pointerId || !p.own) return;
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < DRAG_THRESHOLD_PX) return;
      p.dragging = true;
      const html = frame.current?.querySelector(`[data-square="${p.square}"] [data-piece]`)?.innerHTML ?? '';
      const rect = frame.current?.getBoundingClientRect();
      setDrag({ from: p.square, html, over: at(e), x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
      return;
    }
    placeGhost(e);
    const over = at(e);
    setDrag((d) => (d && d.over !== over ? { ...d, over } : d));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pending.current;
    if (!p || p.pointerId !== e.pointerId) return;
    pending.current = null;
    const sq = at(e);
    if (p.dragging) {
      setDrag(null);
      if (sq === p.square) return; // put back where it was: stays selected
      if (!sq || !commit(p.square, sq, true)) setSelected(null); // illegal square: snaps back
      return;
    }
    // A tap.
    if (p.own) {
      if (p.wasSelected) setSelected(null);
      return;
    }
    if (selected && sq && commit(selected, sq, false)) return;
    setSelected(null);
  };

  const onPointerCancel = () => {
    if (pending.current?.dragging) setSelected(null);
    endDrag();
  };

  const squareStyles = useMemo(() => {
    const st: Record<string, React.CSSProperties> = {};
    const add = (sq: string, style: React.CSSProperties) => (st[sq] = { ...st[sq], ...style });
    if (lastMove) {
      add(lastMove.from, TONE.last);
      add(lastMove.to, TONE.last);
    }
    highlights.forEach((h) => add(h.square, TONE[h.tone]));
    hover.squares.forEach((sq) => add(sq, TONE.hover));
    if (shownFrom) add(shownFrom, TONE.selected);
    targets.forEach((capture, sq) => add(sq, capture ? RING : DOT));
    if (drag?.over && drag.over !== drag.from && targets.has(drag.over)) add(drag.over, TONE.dragOver);
    if (promo) add(promo.to, TONE.selected);
    return st;
  }, [lastMove, highlights, hover.squares, shownFrom, targets, drag, promo]);

  const animate = noAnimFen.current === fen ? 0 : size ? 0 : 220;
  useEffect(() => {
    if (noAnimFen.current && noAnimFen.current !== fen) noAnimFen.current = null;
  }, [fen]);

  const promoCol = promo ? (orientation === 'w' ? promo.to.charCodeAt(0) - 97 : 104 - promo.to.charCodeAt(0)) : 0;
  const promoFromTop = promo ? (orientation === 'w') === (promo.to[1] === '8') : true;

  return (
    <div className={`board-frame ${interactive ? 'movable' : ''}`} ref={frame} style={size ? { width: size } : undefined} data-board={uid}>
      {drag && <style>{`[data-board="${uid}"] [data-square="${drag.from}"] [data-piece] { opacity: 0.3 !important; }`}</style>}
      <Chessboard
        id={`board-${uid}`}
        position={fen}
        {...(size ? { boardWidth: size } : {})}
        boardOrientation={orientation === 'w' ? 'white' : 'black'}
        arePiecesDraggable={false}
        areArrowsAllowed={false}
        showBoardNotation={notation}
        customArrows={arrows.filter((a, i) => arrows.findIndex((b) => b.from === a.from && b.to === a.to) === i).map((a) => [a.from as Square, a.to as Square, ARROW_COLORS[a.color]])}
        customSquareStyles={squareStyles}
        customLightSquareStyle={{ backgroundColor: 'var(--sq-light)' }}
        customDarkSquareStyle={{ backgroundColor: 'var(--sq-dark)' }}
        customBoardStyle={size ? { borderRadius: 4 } : { borderRadius: 6, boxShadow: '0 2px 14px var(--shadow)' }}
        animationDuration={animate}
      />
      {badge && <SquareBadge {...badge} orientation={orientation} />}
      {interactive && (
        <div
          ref={layer}
          className="board-input"
          data-testid="board-input"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={(e) => pending.current?.pointerId === e.pointerId && onPointerCancel()}
          onContextMenu={(e) => e.preventDefault()}
        />
      )}
      {drag && <div ref={ghost} className="board-ghost" aria-hidden style={{ transform: `translate(${drag.x}px, ${drag.y}px) translate(-50%, -50%)` }} dangerouslySetInnerHTML={{ __html: drag.html }} />}
      {promo && (
        <div className="promo-picker" role="dialog" aria-label="Promote to" style={{ left: `${promoCol * 12.5}%`, [promoFromTop ? 'top' : 'bottom']: 0 }}>
          {(['q', 'r', 'b', 'n'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`promo-btn promo-${promo.color}`}
              aria-label={PROMO_NAME[p]}
              // Only a press that starts on the button picks it: the tap that opened the picker
              // also sends a click to whatever is now under the finger (often the queen).
              onPointerDown={(e) => (e.stopPropagation(), (armed.current = p))}
              onPointerUp={() => armed.current === p && pickPromotion(p)}
              onClick={(e) => e.detail === 0 && pickPromotion(p)}
            >
              {PROMO_GLYPH[p]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
