// Review visuals: move-quality badges, the vertical evaluation bar beside the board, and the
// whole-game evaluation graph. All evaluations here are from White's point of view.
import { useRef } from 'react';
import type { Color, PlyRecord, PositionEval } from '../../domain/types';
import { positionCp, winPercent } from '../../analysis/evaluation';
import { CLASS_ICON, CLASS_LABEL, type MoveClass } from '../../analysis/moveQuality';
import { evalText } from '../../coach/momentContext';

export function QualityBadge({ cls, label = false, className = '' }: { cls: MoveClass | 'hidden'; label?: boolean; className?: string }) {
  if (cls === 'hidden')
    return (
      <span className={`qb qb-hidden ${className}`} title="A lesson — the verdict shows once you've done it">
        ?
      </span>
    );
  return (
    <span className={`qb-wrap ${className}`} title={CLASS_LABEL[cls]}>
      <span className={`qb qb-${cls}`} aria-hidden>
        {CLASS_ICON[cls]}
      </span>
      {label && <span className={`qb-label qb-text-${cls}`}>{CLASS_LABEL[cls]}</span>}
      {!label && <span className="sr-only">{CLASS_LABEL[cls]}</span>}
    </span>
  );
}

/** Evaluation of every position of the game (start + after each ply), White's point of view. */
export function whiteEvals(plies: PlyRecord[], positions: PositionEval[]): number[] {
  return positions.map((pos, i) => {
    const toMove: Color = i < plies.length ? plies[i].color : plies[plies.length - 1]?.color === 'w' ? 'b' : 'w';
    const cp = positionCp(pos);
    return toMove === 'w' ? cp : -cp;
  });
}

/** Vertical bar beside the board: the side at the bottom of the board fills from the bottom. */
export function EvalColumn({ whiteCp, orientation }: { whiteCp?: number; orientation: Color }) {
  const known = whiteCp !== undefined;
  const white = known ? Math.min(98, Math.max(2, winPercent(whiteCp))) : 50;
  const bottomShare = orientation === 'w' ? white : 100 - white;
  const text = known ? evalText(whiteCp) : '';
  const whiteAhead = (whiteCp ?? 0) >= 0;
  const labelAtBottom = whiteAhead === (orientation === 'w');
  return (
    <div className={`eval-col ${orientation === 'w' ? 'white-bottom' : 'black-bottom'}`} aria-label={known ? `Evaluation ${text} (White's view)` : 'Evaluation unknown'} role="img">
      <div className="eval-col-fill" style={{ height: `${bottomShare}%` }} />
      {known && <span className={`eval-col-num ${labelAtBottom ? 'bottom' : 'top'} ${whiteAhead ? 'on-white' : 'on-black'}`}>{text.replace(/^\+/, '')}</span>}
    </div>
  );
}

/** The game's evaluation as a small graph; tap anywhere to jump to that move. */
export function EvalGraph({
  values,
  current,
  onSelect,
  marks = {},
}: {
  values: number[];
  current: number;
  onSelect: (ply: number) => void;
  /** Plies to mark with a coloured dot (e.g. mistakes and blunders). */
  marks?: Record<number, string>;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const n = Math.max(1, values.length - 1);
  const W = 1000;
  const y = (cp: number) => 100 - winPercent(cp);
  const x = (i: number) => (i / n) * W;
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `0,100 ${line} ${W},100`;
  const pick = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    onSelect(Math.max(0, Math.min(n, Math.round(((clientX - r.left) / r.width) * n))));
  };
  return (
    <svg
      ref={ref}
      className="eval-graph"
      viewBox={`0 0 ${W} 100`}
      preserveAspectRatio="none"
      role="slider"
      aria-label="Evaluation over the game — tap to jump to a move"
      aria-valuemin={0}
      aria-valuemax={n}
      aria-valuenow={current}
      tabIndex={0}
      onClick={(e) => pick(e.clientX)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSelect(Math.min(n, current + 1));
        if (e.key === 'ArrowLeft') onSelect(Math.max(0, current - 1));
      }}
    >
      <rect className="eg-bg" x="0" y="0" width={W} height="100" />
      <polygon className="eg-area" points={area} />
      <line className="eg-mid" x1="0" x2={W} y1="50" y2="50" />
      <polyline className="eg-line" points={line} vectorEffect="non-scaling-stroke" />
      {Object.entries(marks).map(([ply, cls]) => (
        <line key={ply} className={`eg-mark eg-${cls}`} x1={x(Number(ply))} x2={x(Number(ply))} y1={y(values[Number(ply)] ?? 0) - 7} y2={y(values[Number(ply)] ?? 0) + 7} vectorEffect="non-scaling-stroke" />
      ))}
      <line className="eg-cursor" x1={x(current)} x2={x(current)} y1="0" y2="100" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
