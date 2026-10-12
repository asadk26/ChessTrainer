import type { ReactNode } from 'react';
import type { BoardProps } from './Board';
import { CoachText } from './CoachText';

export function Verdict({ tone, title, text }: { tone: 'good' | 'bad' | 'neutral'; title: string; text?: string }) {
  const icon = tone === 'good' ? '✓' : tone === 'bad' ? '✗' : '•';
  return (
    <div className={`verdict ${tone}`} role="status">
      <span className="verdict-icon" aria-hidden>
        {icon}
      </span>
      <div>
        <div className="verdict-title">{title}</div>
        {text && <CoachText text={text} className="verdict-text" />}
      </div>
    </div>
  );
}

export interface Panels {
  board: BoardProps;
  /** Short instruction/explanation shown above the board. */
  prompt: ReactNode;
  /** Verdict + actions shown directly below the board. */
  banner: ReactNode;
  /** Secondary detail (engine numbers etc.). */
  details: ReactNode;
  /** Changes whenever the question/verdict changes, so the layout can keep it in view. */
  stateKey: string;
}
