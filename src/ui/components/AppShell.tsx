// The app's frame on every screen: a title row per screen and the bottom tab bar.
import type { ReactNode } from 'react';
import { navigate, useRoute } from '../store';

/** A screen's title row, with an optional back button and actions on the right. */
export function ScreenHeader({ title, back, actions }: { title: ReactNode; back?: string; actions?: ReactNode }) {
  return (
    <header className="screen-head">
      {back && (
        <button className="icon-btn" aria-label="Back" onClick={() => navigate(back)}>
          <Icon name="back" />
        </button>
      )}
      <h1>{title}</h1>
      {actions && <div className="screen-actions">{actions}</div>}
    </header>
  );
}

type TabId = 'home' | 'games' | 'drills' | 'progress' | 'play';
const TABS: { id: TabId; label: string; to: string }[] = [
  { id: 'home', label: 'Home', to: '/' },
  { id: 'games', label: 'Games', to: '/games' },
  { id: 'drills', label: 'Drills', to: '/drills' },
  { id: 'progress', label: 'Progress', to: '/progress' },
  { id: 'play', label: 'Play', to: '/coach' },
];

/** Which tab a route belongs to: a game opens from Games, Settings from Home. */
export function tabOf(path: string): TabId {
  if (path.startsWith('/game') || path.startsWith('/import')) return 'games';
  if (path.startsWith('/drills')) return 'drills';
  if (path.startsWith('/progress')) return 'progress';
  if (path.startsWith('/coach')) return 'play';
  return 'home';
}

export function TabBar() {
  const { path } = useRoute();
  const on = tabOf(path);
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <a key={t.id} href={`#${t.to}`} className={on === t.id ? 'on' : ''} aria-current={on === t.id ? 'page' : undefined}>
          <Icon name={t.id} />
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}

const PATHS: Record<TabId | 'gear' | 'plus' | 'back' | 'forward' | 'trash' | 'why' | 'showme' | 'try' | 'best', ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  games: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  drills: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.8" />
    </>
  ),
  progress: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  play: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 8.5l5.5 3.5-5.5 3.5z" />
    </>
  ),
  gear: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.9 12.5a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7M10 11v5.5M14 11v5.5" />,
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  why: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.2-2.5 3.8M12 17.2v.1" />
    </>
  ),
  showme: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  try: <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4.5a5.5 5.5 0 0 1-5.5 5.5h-.8a5.5 5.5 0 0 1-4.6-2.5L4.6 15a1.5 1.5 0 0 1 2.4-1.8L9 15" />,
  best: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
};

export function Icon({ name, size = 22 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
