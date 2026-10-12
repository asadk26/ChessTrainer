import { Chessboard } from 'react-chessboard';
import type { Square } from 'chess.js';
import type { Arrow, StoredGame } from '../../domain/types';
import { ARROW_COLORS } from './Board';
import { moveLabel } from '../../chess/pgn';

export interface DiagramSpec {
  ply: number;
  fen: string;
  arrows: Arrow[];
  title: string;
  caption?: string;
}

/**
 * Board diagram for one moment of the game. Mistakes show the position before
 * the move with your move (orange) and the engine's better move (green);
 * good moves show your move in green.
 */
export function diagramFor(game: StoredGame, ply: number, kind: 'mistake' | 'good'): DiagramSpec | undefined {
  const p = game.plies[ply - 1];
  if (!p) return undefined;
  const e = game.analysis?.moves[ply - 1];
  const arrows: Arrow[] = [{ from: p.from, to: p.to, color: kind === 'good' ? 'best' : 'played' }];
  let title = moveLabel(p);
  if (kind === 'mistake' && e?.bestUci && !e.isBest && e.bestUci !== p.uci) {
    arrows.push({ from: e.bestUci.slice(0, 2), to: e.bestUci.slice(2, 4), color: 'best' });
    title += ` · better: ${e.bestSan}`;
  }
  const finding = game.findings.find((f) => f.ply === ply && f.confidence !== 'low' && (kind === 'good' ? f.kind === 'strength' : f.kind === 'weakness'));
  return { ply, fen: p.fenBefore, arrows, title, caption: finding?.evidence };
}

export function PositionDiagram({
  spec,
  orientation,
  size = 220,
  onOpen,
}: {
  spec: DiagramSpec;
  orientation: 'w' | 'b';
  size?: number;
  onOpen?: () => void;
}) {
  return (
    <figure className="diagram" style={{ width: size }}>
      <button className="diagram-board" onClick={onOpen} aria-label={`Open ${spec.title} on the board`}>
        <Chessboard
          id={`diagram-${spec.ply}-${size}`}
          position={spec.fen}
          boardWidth={size}
          boardOrientation={orientation === 'w' ? 'white' : 'black'}
          arePiecesDraggable={false}
          areArrowsAllowed={false}
          showBoardNotation={false}
          animationDuration={0}
          customArrows={spec.arrows.map((a) => [a.from as Square, a.to as Square, ARROW_COLORS[a.color]])}
          customLightSquareStyle={{ backgroundColor: '#ece7db' }}
          customDarkSquareStyle={{ backgroundColor: '#9fb19a' }}
          customBoardStyle={{ borderRadius: 4 }}
        />
      </button>
      <figcaption>
        <b>{spec.title}</b>
        {spec.caption && <span>{spec.caption}</span>}
      </figcaption>
    </figure>
  );
}
