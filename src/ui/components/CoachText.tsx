import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface HoverState {
  squares: string[];
  set(squares: string[]): void;
}
const HoverCtx = createContext<HoverState>({ squares: [], set: () => {} });

export function HoverProvider({ children }: { children: ReactNode }) {
  const [squares, set] = useState<string[]>([]);
  const value = useMemo(() => ({ squares, set }), [squares]);
  return <HoverCtx.Provider value={value}>{children}</HoverCtx.Provider>;
}

export const useHover = () => useContext(HoverCtx);

// SAN moves (Nb5, exd6, Bb5+, O-O excluded) and bare squares (c7).
const TOKEN = /\b([KQRBN]?[a-h]?[1-8]?x?([a-h][1-8])(?:=[QRBN])?[+#]?)(?![\w])/g;

/**
 * Renders coaching text; moves and squares become hover targets that light
 * up the matching square on the board, keeping text and board connected.
 */
export function CoachText({ text, className }: { text: string; className?: string }) {
  const { set } = useHover();
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const square = m[2];
    parts.push(
      <span
        key={m.index}
        className="sq-ref"
        onMouseEnter={() => set([square])}
        onMouseLeave={() => set([])}
        onTouchStart={() => set([square])}
        onTouchEnd={() => set([])}
      >
        {m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <p className={className}>{parts}</p>;
}
