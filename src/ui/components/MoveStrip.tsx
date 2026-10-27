import { useEffect, useRef } from 'react';
import type { PlyRecord } from '../../domain/types';
import { VERDICT_LABEL, type Verdict } from '../../analysis/engineReview';
import { CLASS_LABEL, type MoveClass } from '../../analysis/moveQuality';
import { QualityBadge } from './ReviewVisuals';

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
  verdicts = {},
  badges,
}: {
  plies: PlyRecord[];
  current: number;
  onSelect: (ply: number) => void;
  marks?: Record<number, 'good' | 'bad' | 'done' | 'note'>;
  /** Stockfish's verdict per ply (both sides), shown as an underline. */
  verdicts?: Record<number, Verdict>;
  /** Move-quality badge per ply (replaces the verdict underline); 'hidden' for lessons not done yet. */
  badges?: Record<number, MoveClass | 'hidden'>;
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
            className={`ms-move ${current === p.ply ? 'on' : ''} ${marks[p.ply] ? `mark-${marks[p.ply]}` : ''} ${!badges && verdicts[p.ply] ? `v-${verdicts[p.ply]}` : ''}`}
            onClick={() => onSelect(p.ply)}
            title={
              [
                marks[p.ply] ? (marks[p.ply] === 'good' ? 'Good idea' : marks[p.ply] === 'note' ? 'Worth knowing' : 'Lesson') : '',
                badges?.[p.ply] && badges[p.ply] !== 'hidden' ? `Stockfish: ${CLASS_LABEL[badges[p.ply] as MoveClass]}` : !badges && verdicts[p.ply] ? `Stockfish: ${VERDICT_LABEL[verdicts[p.ply]]}` : '',
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
          >
            {p.san}
            {badges?.[p.ply] && <QualityBadge cls={badges[p.ply]} className="ms-badge" />}
          </button>
        </span>
      ))}
    </div>
  );
}
