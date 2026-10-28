import { AppProvider, useApp, useRoute } from './ui/store';
import { Dashboard } from './ui/screens/Dashboard';
import { ImportScreen } from './ui/screens/ImportScreen';
import { GameScreen } from './ui/screens/GameScreen';
import { DrillsScreen } from './ui/screens/DrillsScreen';
import { CoachGameScreen } from './ui/screens/CoachGameScreen';
import { GamesScreen } from './ui/screens/GamesScreen';
import { ProgressScreen } from './ui/screens/ProgressScreen';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { TabBar } from './ui/components/AppShell';

function Routes() {
  const { loaded } = useApp();
  const { parts, query } = useRoute();
  if (!loaded) return null;
  if (parts[0] === 'import') return <ImportScreen />;
  if (parts[0] === 'games') return <GamesScreen />;
  if (parts[0] === 'progress') return <ProgressScreen />;
  if (parts[0] === 'settings') return <SettingsScreen />;
  if (parts[0] === 'drills') return <DrillsScreen />;
  if (parts[0] === 'coach') return <CoachGameScreen />;
  if (parts[0] === 'game' && parts[1]) {
    const tab = parts[2] === 'review' ? 'review' : parts[2] === 'drills' ? 'drills' : parts[2] === 'ai' ? 'ai' : 'summary';
    const ply = query.get('ply');
    return <GameScreen key={parts[1]} id={parts[1]} tab={tab} ply={ply ? Number(ply) : undefined} explore={query.get('explore') === '1'} already={query.get('already') === '1'} />;
  }
  return <Dashboard />;
}

export default function App() {
  return (
    <AppProvider>
      <main className="container">
        <Routes />
      </main>
      <TabBar />
    </AppProvider>
  );
}
