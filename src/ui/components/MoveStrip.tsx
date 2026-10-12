import { useEffect, useRef } from 'react';
import type { PlyRecord } from '../../domain/types';

/**
 * The game as one horizontal, swipeable strip. Keeps the current move centred
 * by scrolling the strip itself — never the page — so stepping through moves
 * doesn't make the screen jump.
 */
export function MoveStrip({
  plies,
  current,
  onSelect,
  marks = {},
}: {
  plies: PlyRecord[];
  current: number;
  onSelect: (ply: number) => void;
  marks?: Record<number, 'good' | 'bad' | 'done'>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = ref.current;
    const el = strip?.querySelector<HTMLElement>(`[data-ply="${current}"]`);
    if (!strip || !el) return;
    const left = el.offsetLeft - strip.clientWidth / 2 + el.clientWidth / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [current]);

  return (
    <div className="move-strip" ref={ref} role="list" aria-label="Moves">
      <button data-ply={0} className={`ms-move start ${current === 0 ? 'on' : ''}`} onClick={() => onSelect(0)}>
        Start
      </button>
      {plies.map((p) => (
        <span key={p.ply} className="ms-item" role="listitem">
          {p.color === 'w' && <span className="ms-no">{p.moveNumber}.</span>}
          <button
            data-ply={p.ply}
            className={`ms-move ${current === p.ply ? 'on' : ''} ${marks[p.ply] ? `mark-${marks[p.ply]}` : ''}`}
            onClick={() => onSelect(p.ply)}
            title={marks[p.ply] ? (marks[p.ply] === 'good' ? 'Good idea' : 'Critical moment') : undefined}
          >
            {p.san}
          </button>
        </span>
      ))}
    </div>
  );
}
