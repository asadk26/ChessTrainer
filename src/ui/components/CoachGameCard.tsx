import { useMemo } from 'react';
import { navigate, useApp } from '../store';
import { buildSkillProfile, SKILL_LABEL } from '../../adaptive/skills';
import { chooseSkill, conversionStart } from '../../adaptive/planner';

/** Dashboard entry point for Adaptive Coach Games, with the focus the planner would pick. */
export function CoachGameCard() {
  const { games, sessions } = useApp();
  const pick = useMemo(() => {
    const conv = conversionStart(games, sessions);
    return chooseSkill(buildSkillProfile(games, sessions), (s) => s !== 'conversion' || !!conv);
  }, [games, sessions]);
  const live = sessions.some((s) => s.status === 'playing' || s.status === 'analysing');
  return (
    <section className="card">
      <span className="eyebrow">Adaptive Coach Game</span>
      <h3>{live ? 'Game in progress' : pick ? `Practise: ${SKILL_LABEL[pick.skill]}` : 'Play the coach'}</h3>
      <p className="muted small">
        {pick
          ? 'A normal game, shaped around something your real games say you need — teaching comes afterwards.'
          : 'A normal game against a coach that plays sound moves. Once your analysed games show a clear pattern, the coach will shape games around it.'}
      </p>
      <button className="btn primary" onClick={() => navigate('/coach')}>
        {live ? 'Resume' : 'Start'}
      </button>
    </section>
  );
}
