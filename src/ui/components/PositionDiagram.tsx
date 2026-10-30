import { Chessboard } from 'react-chessboard';
import type { Square } from 'chess.js';
import type { Arrow, StoredGame } from '../../domain/types';
import { ARROW_COLORS } from './Board';
import { moveLabel } from '../../chess/pgn';
import { asGoodAsBest } from '../../analysis/moveQuality';

export interface DiagramSpec {
  ply: number;
  fen: string;
  arrows: Arrow[];
  title: string;
  kindLabel?: string;
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
  const x = kind === 'mistake' ? game.explanations?.[ply] : undefined;
  // A move as good as Stockfish's choice is never labelled a mistake or a missed chance here either
  // (the same rule as the "Equally good" badge), unless the explanation is about a later move.
  if (x && !(asGoodAsBest(e) && x.betterPly === ply)) {
    const label = x.kind === 'missed_opportunity' ? 'Missed chance' : 'Mistake';
    const why = x.better ? `${x.better}.` : undefined;
    const problem = x.problem ? `${x.problem.charAt(0).toUpperCase()}${x.problem.slice(1)}.` : undefined;
    return { ply, fen: p.fenBefore, arrows, title, kindLabel: label, caption: [problem, why].filter(Boolean).join(' ') || finding?.evidence };
  }
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
          customLightSquareStyle={{ backgroundColor: 'var(--sq-light)' }}
          customDarkSquareStyle={{ backgroundColor: 'var(--sq-dark)' }}
          customBoardStyle={{ borderRadius: 4 }}
        />
      </button>
      <figcaption>
        {spec.kindLabel && <span className={`kind-label ${spec.kindLabel === 'Missed chance' ? 'missed' : ''}`}>{spec.kindLabel}</span>}
        <b>{spec.title}</b>
        {spec.caption && <span>{spec.caption}</span>}
      </figcaption>
    </figure>
  );
}
