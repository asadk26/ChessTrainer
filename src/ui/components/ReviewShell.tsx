// The fixed zones of Guided Review (modelled on chess.com's Game Review): a thin horizontal eval
// bar, a fixed-height coach bubble, the board sized to the space that's left, the move strip, and
// an action bar — plus a bottom sheet for anything longer. Nothing in the layout scrolls.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Color } from '../../domain/types';
import { winPercent } from '../../analysis/evaluation';
import { evalText } from '../../coach/momentContext';

/** Thin full-width bar: your side fills from the left; the number is from your point of view. */
export function EvalStrip({ whiteCp, userColor }: { whiteCp?: number; userColor: Color }) {
  const mine = whiteCp === undefined ? undefined : userColor === 'w' ? whiteCp : -whiteCp;
  const share = mine === undefined ? 50 : Math.min(97, Math.max(3, winPercent(mine)));
  const label = mine === undefined ? '' : evalText(mine);
  return (
    <div className={`gr-eval you-${userColor}`} role="img" aria-label={mine === undefined ? 'Evaluation not shown' : `Evaluation ${label} from your side`}>
      <div className="gr-eval-fill" style={{ width: `${share}%` }} />
      {label && <span className={`gr-eval-num ${share >= 50 ? 'on-mine' : 'on-theirs'}`}>{label}</span>}
    </div>
  );
}

/**
 * The coach's bubble above the board: a fixed height whatever it says, so the board never moves.
 * Tapping it opens the full text; "Tap for more" shows when there's more than fits.
 */
export function CoachBubble({ head, children, onMore, extra = false, tall = false }: { head?: ReactNode; children: ReactNode; onMore?: () => void; extra?: boolean; tall?: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (el) setOver(el.scrollHeight > el.clientHeight + 2);
  });
  const more = !!onMore && (over || extra);
  return (
    <div
      className={`gr-bubble ${tall ? 'tall' : ''} ${more ? 'has-more' : ''}`}
      role={onMore ? 'button' : undefined}
      tabIndex={onMore ? 0 : undefined}
      aria-label={onMore ? 'Coach — tap for the full explanation' : undefined}
      onClick={onMore}
      onKeyDown={(e) => onMore && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onMore())}
    >
      {head && <div className="gr-bubble-head">{head}</div>}
      <div className="gr-bubble-body" ref={body}>
        {children}
      </div>
      {more && <span className="gr-more">Tap for more</span>}
    </div>
  );
}

/** The board as large as the space allows (edge to edge on phones), centred in its zone. */
export function BoardZone({ children }: { children: ReactNode }) {
  const zone = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const el = zone.current;
    if (!el) return;
    const fit = () => setSize(Math.floor(Math.min(el.clientWidth, el.clientHeight)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="gr-board-zone" ref={zone}>
      <div className="gr-board" style={size ? { width: size, height: size } : { visibility: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

/** Swipe down (on the handle or header) to close. */
function useSwipeDown(onClose: () => void) {
  const start = useRef<number | null>(null);
  const [dy, setDy] = useState(0);
  return {
    dy,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        start.current = e.clientY;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e: React.PointerEvent) => start.current !== null && setDy(Math.max(0, e.clientY - start.current)),
      onPointerUp: () => {
        if (dy > 70) onClose();
        start.current = null;
        setDy(0);
      },
      onPointerCancel: () => ((start.current = null), setDy(0)),
    },
  };
}

/** A sheet that slides up over the lower part of the screen; swipe down, tap outside or ✕ to close. */
export function BottomSheet({ open, title, onClose, children }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode }) {
  const swipe = useSwipeDown(onClose);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) setShown(true);
    else {
      const t = window.setTimeout(() => setShown(false), 220);
      return () => window.clearTimeout(t);
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open, onClose]);
  if (!shown) return null;
  return (
    <div className={`gr-sheet-wrap ${open ? 'open' : ''}`}>
      <div className="gr-sheet-backdrop" onClick={onClose} />
      <div className="gr-sheet" role="dialog" aria-modal="true" style={swipe.dy ? { transform: `translateY(${swipe.dy}px)`, transition: 'none' } : undefined}>
        <div className="gr-sheet-top" {...swipe.handlers}>
          <span className="gr-handle" aria-hidden />
          <div className="gr-sheet-title">{title}</div>
          <button className="gr-sheet-close" aria-label="Close" onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>
            ✕
          </button>
        </div>
        <div className="gr-sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** A sheet docked under the board (the board shrinks to stay fully visible) — for step-by-step lines. */
export function DockSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const swipe = useSwipeDown(onClose);
  return (
    <div className="gr-dock-sheet" style={swipe.dy ? { transform: `translateY(${swipe.dy}px)` } : undefined}>
      <div className="gr-sheet-top compact" {...swipe.handlers}>
        <span className="gr-handle" aria-hidden />
      </div>
      {children}
    </div>
  );
}

export function ActionButton({ icon, label, onClick, disabled }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="gr-act" onClick={onClick} disabled={disabled}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
