import { useEffect, useRef } from 'react';
import type { PlyRecord } from '../../domain/types';

export function MoveList({
  plies,
  current,
  onSelect,
  marks = {},
}: {
  plies: PlyRecord[];
  current: number;
  onSelect: (ply: number) => void;
  marks?: Record<number, 'good' | 'bad'>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('.mv.on')?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  const rows: { no: number; w?: PlyRecord; b?: PlyRecord }[] = [];
  for (const p of plies) {
    if (p.color === 'w' || rows.length === 0) rows.push({ no: p.moveNumber, [p.color]: p });
    else rows[rows.length - 1].b = p;
  }
  const cell = (p?: PlyRecord) =>
    p ? (
      <button className={`mv ${current === p.ply ? 'on' : ''} ${marks[p.ply] ?? ''}`} onClick={() => onSelect(p.ply)}>
        {p.san}
        {marks[p.ply] && <span className={`mark ${marks[p.ply]}`} />}
      </button>
    ) : (
      <span className="mv empty" />
    );
  return (
    <div className="movelist" ref={ref}>
      {rows.map((r) => (
        <div className="mv-row" key={r.no}>
          <span className="mv-no">{r.no}.</span>
          {cell(r.w)}
          {cell(r.b)}
        </div>
      ))}
    </div>
  );
}
