import { useEffect, useRef } from 'react';

/**
 * On phones the board is sticky and the commentary sits right under it: whenever `key`
 * changes (a new step or answer), bring the block back to the top of the screen so the
 * commentary is never hidden behind the board.
 */
export function useKeepTop<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.innerWidth > 860) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 6;
    if (Math.abs(window.scrollY - top) > 3) window.scrollTo({ top, behavior: 'smooth' });
  }, [key]);
  return ref;
}
