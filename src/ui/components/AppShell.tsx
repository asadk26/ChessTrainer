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

const PATHS: Record<TabId | 'gear' | 'plus' | 'back' | 'trash', ReactNode> = {
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
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.9 12.5a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7M10 11v5.5M14 11v5.5" />,
  back: <path d="M15 5l-7 7 7 7" />,
};

export function Icon({ name, size = 22 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
