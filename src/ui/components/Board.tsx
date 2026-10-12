import { useMemo, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess, type Square } from 'chess.js';
import type { Arrow, Color } from '../../domain/types';
import { useHover } from './CoachText';

export const ARROW_COLORS: Record<Arrow['color'], string> = {
  played: 'rgba(214, 128, 38, 0.85)',
  best: 'rgba(46, 140, 92, 0.88)',
  reply: 'rgba(196, 64, 64, 0.82)',
  threat: 'rgba(196, 64, 64, 0.82)',
  guess: 'rgba(60, 108, 196, 0.85)',
};

const TONE: Record<string, React.CSSProperties> = {
  danger: { boxShadow: 'inset 0 0 0 4px rgba(196,64,64,0.75)' },
  good: { boxShadow: 'inset 0 0 0 4px rgba(46,140,92,0.75)' },
  focus: { boxShadow: 'inset 0 0 0 4px rgba(214,128,38,0.85)', background: 'rgba(214,128,38,0.16)' },
  last: { background: 'rgba(235, 200, 90, 0.42)' },
  hover: { boxShadow: 'inset 0 0 0 4px rgba(60,108,196,0.85)', background: 'rgba(60,108,196,0.18)' },
  selected: { background: 'rgba(60,108,196,0.35)' },
};

export interface BoardProps {
  fen: string;
  orientation: Color;
  arrows?: Arrow[];
  highlights?: { square: string; tone: 'danger' | 'good' | 'focus' | 'last' }[];
  lastMove?: { from: string; to: string };
  /** When set, the side that may move pieces; the callback returns true to accept the move. */
  movable?: Color;
  onMove?: (uci: string, san: string, fenAfter: string) => boolean | void;
}

/** Chessboard with arrows/highlights; supports drag-and-drop and tap-tap moves. */
export function Board({ fen, orientation, arrows = [], highlights = [], lastMove, movable, onMove }: BoardProps) {
  const hover = useHover();
  const [selected, setSelected] = useState<string | null>(null);

  const squareStyles = useMemo(() => {
    const st: Record<string, React.CSSProperties> = {};
    const add = (sq: string, style: React.CSSProperties) => (st[sq] = { ...st[sq], ...style });
    if (lastMove) {
      add(lastMove.from, TONE.last);
      add(lastMove.to, TONE.last);
    }
    highlights.forEach((h) => add(h.square, TONE[h.tone]));
    hover.squares.forEach((sq) => add(sq, TONE.hover));
    if (selected) add(selected, TONE.selected);
    return st;
  }, [lastMove, highlights, hover.squares, selected]);

  const tryMove = (from: string, to: string): boolean => {
    if (!movable || !onMove) return false;
    const c = new Chess(fen);
    const piece = c.get(from as Square);
    if (!piece || piece.color !== movable || c.turn() !== movable) return false;
    try {
      const mv = c.move({ from, to, promotion: 'q' });
      const ok = onMove(mv.from + mv.to + (mv.promotion ?? ''), mv.san, c.fen());
      setSelected(null);
      return ok !== false;
    } catch {
      return false;
    }
  };

  const onSquareClick = (square: Square) => {
    if (!movable) return;
    const c = new Chess(fen);
    const p = c.get(square);
    if (selected) {
      if (p && p.color === movable) return setSelected(square);
      if (!tryMove(selected, square)) setSelected(null);
      return;
    }
    if (p && p.color === movable && c.turn() === movable) setSelected(square);
  };

  return (
    <div className="board-frame">
      <Chessboard
        id="coach-board"
        position={fen}
        boardOrientation={orientation === 'w' ? 'white' : 'black'}
        arePiecesDraggable={!!movable}
        isDraggablePiece={({ piece }) => !!movable && piece[0] === movable}
        onPieceDrop={(from, to) => tryMove(from, to)}
        onSquareClick={onSquareClick}
        autoPromoteToQueen
        areArrowsAllowed={false}
        customArrows={arrows.filter((a, i) => arrows.findIndex((b) => b.from === a.from && b.to === a.to) === i).map((a) => [a.from as Square, a.to as Square, ARROW_COLORS[a.color]])}
        customSquareStyles={squareStyles}
        customLightSquareStyle={{ backgroundColor: 'var(--sq-light)' }}
        customDarkSquareStyle={{ backgroundColor: 'var(--sq-dark)' }}
        customBoardStyle={{ borderRadius: 6, boxShadow: '0 2px 14px var(--shadow)' }}
        animationDuration={220}
      />
    </div>
  );
}
