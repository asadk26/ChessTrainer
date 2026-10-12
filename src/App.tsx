import { AppProvider, navigate, useApp, useRoute } from './ui/store';
import { Dashboard } from './ui/screens/Dashboard';
import { ImportScreen } from './ui/screens/ImportScreen';
import { GameScreen } from './ui/screens/GameScreen';
import { DrillsScreen } from './ui/screens/DrillsScreen';

function Routes() {
  const { loaded } = useApp();
  const { parts, query } = useRoute();
  if (!loaded) return null;
  if (parts[0] === 'import') return <ImportScreen />;
  if (parts[0] === 'drills') return <DrillsScreen />;
  if (parts[0] === 'game' && parts[1]) {
    const tab = parts[2] === 'review' ? 'review' : parts[2] === 'drills' ? 'drills' : 'summary';
    const ply = query.get('ply');
    return <GameScreen key={parts[1]} id={parts[1]} tab={tab} ply={ply ? Number(ply) : undefined} />;
  }
  return <Dashboard />;
}

function Nav() {
  const { path } = useRoute();
  const link = (to: string, label: string) => (
    <a href={`#${to}`} className={(to === '/' ? path === '/' : path.startsWith(to)) ? 'on' : ''}>
      {label}
    </a>
  );
  return (
    <header className="topbar">
      <button className="brand" onClick={() => navigate('/')}>
        <span className="logo">♞</span> <span className="brand-text">Chess Coach</span>
      </button>
      <nav>
        {link('/', 'Dashboard')}
        {link('/import', 'Import')}
        {link('/drills', 'Drills')}
      </nav>
    </header>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Nav />
      <main className="container">
        <Routes />
      </main>
    </AppProvider>
  );
}
