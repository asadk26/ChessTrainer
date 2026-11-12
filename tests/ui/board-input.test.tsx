// @vitest-environment jsdom
// The shared board's input: tap-tap and drag (pointer events), promotion, snap-back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Board, type BoardProps } from '../../src/ui/components/Board';
import { squareAt } from '../../src/ui/components/boardInput';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PROMO = '8/P6k/8/8/8/8/6K1/8 w - - 0 1';
const SIZE = 400; // the board fills 0..400 px in both directions
const SQ = SIZE / 8;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout and no PointerEvent: give every element the board's box, and a PointerEvent.
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: SIZE, height: SIZE, right: SIZE, bottom: SIZE, x: 0, y: 0, toJSON: () => ({}) });
  if (!('PointerEvent' in window)) {
    class PE extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? 'touch';
      }
    }
    (window as unknown as { PointerEvent: typeof PE }).PointerEvent = PE;
  }
  if (!('ResizeObserver' in window)) (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(props: Partial<BoardProps> & { onMove?: BoardProps['onMove'] }) {
  act(() => root.render(<Board fen={START} orientation="w" size={SIZE} {...props} />));
}

/** Centre of a square on a white-at-the-bottom board. */
const pt = (sq: string) => ({ clientX: (sq.charCodeAt(0) - 97 + 0.5) * SQ, clientY: (8 - Number(sq[1]) + 0.5) * SQ });
const layer = () => host.querySelector('[data-testid="board-input"]') as HTMLElement | null;

function fire(el: Element, type: string, at: { clientX: number; clientY: number }, pointerType = 'touch') {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType, button: 0, ...at }));
  });
}
function tap(sq: string, pointerType = 'touch', jitter = 0) {
  const p = pt(sq);
  fire(layer()!, 'pointerdown', p, pointerType);
  if (jitter) fire(layer()!, 'pointermove', { clientX: p.clientX + jitter, clientY: p.clientY + jitter }, pointerType);
  fire(layer()!, 'pointerup', { clientX: p.clientX + jitter, clientY: p.clientY + jitter }, pointerType);
}
function drag(from: string, to: string, pointerType = 'touch') {
  const a = pt(from);
  const b = pt(to);
  fire(layer()!, 'pointerdown', a, pointerType);
  for (let i = 1; i <= 5; i++) fire(layer()!, 'pointermove', { clientX: a.clientX + ((b.clientX - a.clientX) * i) / 5, clientY: a.clientY + ((b.clientY - a.clientY) * i) / 5 }, pointerType);
  fire(layer()!, 'pointerup', b, pointerType);
}
const squareStyle = (sq: string) => host.querySelector(`[data-square="${sq}"]`)?.outerHTML ?? '';

describe('squareAt', () => {
  it('maps points to squares for both orientations', () => {
    const rect = { left: 10, top: 20, width: 400 };
    expect(squareAt(15, 25, rect, 'w')).toBe('a8');
    expect(squareAt(405, 415, rect, 'w')).toBe('h1');
    expect(squareAt(15, 25, rect, 'b')).toBe('h1');
    expect(squareAt(5, 25, rect, 'w')).toBeNull();
  });
});

describe('Board input', () => {
  it('tap-tap: tap a piece, its legal moves get dots, tap a dot to move', () => {
    const onMove = vi.fn(() => true);
    render({ movable: 'w', onMove });
    tap('e2');
    expect(squareStyle('e4')).toContain('radial-gradient');
    expect(squareStyle('e3')).toContain('radial-gradient');
    expect(squareStyle('e5')).not.toContain('radial-gradient');
    tap('e4');
    expect(onMove).toHaveBeenCalledWith('e2e4', 'e4', expect.stringContaining('4P3'));
  });

  it('tap-tap works with the mouse too, and a little finger wobble is still a tap', () => {
    const onMove = vi.fn(() => true);
    render({ movable: 'w', onMove });
    tap('g1', 'mouse');
    tap('f3', 'mouse');
    expect(onMove).toHaveBeenLastCalledWith('g1f3', 'Nf3', expect.any(String));
    render({ fen: START, movable: 'w', onMove: (onMove.mockClear(), onMove) });
    tap('d2', 'touch', 2);
    tap('d4');
    expect(onMove).toHaveBeenLastCalledWith('d2d4', 'd4', expect.any(String));
  });

  it('tapping elsewhere deselects; tapping the selected piece again deselects', () => {
    const onMove = vi.fn(() => true);
    render({ movable: 'w', onMove });
    tap('e2');
    tap('a5');
    expect(squareStyle('e4')).not.toContain('radial-gradient');
    tap('e4');
    tap('e2');
    tap('e2');
    tap('e4');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('drag and drop makes the move', () => {
    const onMove = vi.fn(() => true);
    render({ movable: 'w', onMove });
    drag('e2', 'e4');
    expect(onMove).toHaveBeenCalledWith('e2e4', 'e4', expect.any(String));
    drag('g1', 'f3', 'mouse');
    expect(onMove).toHaveBeenLastCalledWith('g1f3', 'Nf3', expect.any(String));
  });

  it('dropping on an illegal square snaps back without a move or an error', () => {
    const onMove = vi.fn(() => true);
    render({ movable: 'w', onMove });
    drag('e2', 'e5');
    expect(onMove).not.toHaveBeenCalled();
    expect(host.querySelector('.board-ghost')).toBeNull();
    drag('e2', 'e4');
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('drag still works when the board becomes movable without the position changing', () => {
    const onMove = vi.fn(() => true);
    render({ onMove });
    expect(layer()).toBeNull(); // not movable: no input layer, nothing to grab
    render({ movable: 'w', onMove });
    drag('e2', 'e4');
    expect(onMove).toHaveBeenCalledWith('e2e4', 'e4', expect.any(String));
  });

  it('only the side to move can be moved', () => {
    const onMove = vi.fn(() => true);
    render({ movable: 'w', onMove });
    drag('e7', 'e5');
    tap('e7');
    tap('e5');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('a refused move leaves the board usable', () => {
    const onMove = vi.fn(() => false);
    render({ movable: 'w', onMove });
    drag('e2', 'e4');
    tap('d2');
    tap('d4');
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it('promotion shows a picker for both drag and tap-tap', () => {
    const onMove = vi.fn(() => true);
    render({ fen: PROMO, movable: 'w', onMove });
    drag('a7', 'a8');
    expect(onMove).not.toHaveBeenCalled();
    const knight = host.querySelector('button[aria-label="Knight"]')!;
    expect(knight).toBeTruthy();
    fire(knight, 'pointerdown', pt('a5'));
    fire(knight, 'pointerup', pt('a5'));
    expect(onMove).toHaveBeenCalledWith('a7a8n', 'a8=N', expect.any(String));

    onMove.mockClear();
    render({ fen: PROMO, movable: 'w', onMove });
    tap('a7');
    tap('a8');
    // The click that follows the opening tap must not pick a piece by itself.
    act(() => host.querySelector('button[aria-label="Queen"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(onMove).not.toHaveBeenCalled();
    const queen = host.querySelector('button[aria-label="Queen"]')!;
    fire(queen, 'pointerdown', pt('a8'));
    fire(queen, 'pointerup', pt('a8'));
    expect(onMove).toHaveBeenCalledWith('a7a8q', 'a8=Q', expect.any(String));
  });

  it('tapping off the promotion picker cancels it', () => {
    const onMove = vi.fn(() => true);
    render({ fen: PROMO, movable: 'w', onMove });
    tap('a7');
    tap('a8');
    expect(host.querySelector('.promo-picker')).toBeTruthy();
    fire(layer()!, 'pointerdown', pt('e4'));
    fire(layer()!, 'pointerup', pt('e4'));
    expect(host.querySelector('.promo-picker')).toBeNull();
    expect(onMove).not.toHaveBeenCalled();
  });
});
