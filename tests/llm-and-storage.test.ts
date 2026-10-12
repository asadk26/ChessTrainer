import { describe, expect, it } from 'vitest';
import { allowedMoves, extractJson, mentionsOnlyKnownMoves, mergeLlmOutput, buildCoachPrompt } from '../src/coach/llmCoach';
import { coachFromPositions } from '../src/analysis/pipeline';
import { aggregateProfile } from '../src/profile/profile';
import { LocalStorageRepository, memoryStore } from '../src/storage/repository';
import { providerFromEnv } from '../server/llm';
import { samplePositions, sampleStored } from './helpers';

const { game } = coachFromPositions(sampleStored(), samplePositions(), []);

describe('LLM coaching layer', () => {
  it('selects a provider from env vars, or none', () => {
    expect(providerFromEnv({})).toBeNull();
    expect(providerFromEnv({ ANTHROPIC_API_KEY: 'k' })?.name).toBe('anthropic');
    expect(providerFromEnv({ OPENAI_BASE_URL: 'http://localhost:11434/v1', OPENAI_MODEL: 'llama3' })).toMatchObject({ name: 'openai', model: 'llama3' });
    expect(providerFromEnv({ ANTHROPIC_API_KEY: 'k', COACH_LLM_PROVIDER: 'none' })).toBeNull();
  });

  it('builds a prompt containing engine-verified facts', () => {
    const prompt = buildCoachPrompt(game, aggregateProfile([]), 850);
    expect(prompt).toContain('Nb5');
    expect(prompt).toContain('"better_move"');
    expect(prompt).toContain(game.moments[0].id);
  });

  it('extracts JSON from fenced or chatty responses', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"headline":"x"}')).toEqual({ headline: 'x' });
  });

  it('keeps the template list when any LLM item fails validation', () => {
    const { report } = mergeLlmOutput(game, { hurt: ['Nb5 went nowhere.', 'Qh5+ was winning.'] });
    expect(report.hurt).toEqual(game.report!.hurt);
  });

  it('rejects text that mentions moves not in the verified facts', () => {
    const allowed = allowedMoves(game);
    expect(mentionsOnlyKnownMoves('Nb5 looked active but Rb7 answered it.', allowed)).toBe(true);
    expect(mentionsOnlyKnownMoves('You should have played Qh5+ instead.', allowed)).toBe(false);
  });

  it('merges valid LLM text and falls back to templates for invalid fields', () => {
    const id = game.moments[0].id;
    const { report, moments } = mergeLlmOutput(game, {
      headline: 'Solid start, but chase fewer ghosts.',
      hurt: ['Nb5 and Bb5+ both looked active and went nowhere.'],
      focus: { title: 'Name their simplest reply before every attacking move.' },
      recurring: 'Totally a pattern because of Qxh7#.',
      moments: { [id]: { lesson: 'Active moves need a follow-up.', intent: 'You wanted Nxz9.' } },
    });
    expect(report.voice).toBe('llm');
    expect(report.headline).toBe('Solid start, but chase fewer ghosts.');
    expect(report.hurt[0].text).toBe('Nb5 and Bb5+ both looked active and went nowhere.');
    expect(report.hurt[0].plies).toEqual(game.report!.hurt[0].plies);
    expect(report.recurring).toBe(game.report!.recurring); // hallucinated move rejected
    expect(report.focus.theme).toBe(game.report!.focus.theme);
    expect(moments[0].text.lesson).toBe('Active moves need a follow-up.');
  });
});

describe('local storage repository', () => {
  it('round-trips games, drills, attempts and settings', async () => {
    const r = new LocalStorageRepository(memoryStore());
    await r.saveGame(game);
    expect((await r.listGames()).map((g) => g.id)).toEqual([game.id]);
    await r.replaceDrillsForGame(game.id, [{ id: 'd1', gameId: game.id, ply: 1, type: 'choose_plan', category: 'opened_vs_king', fen: 'x', orientation: 'w', prompt: 'p', explanation: 'e', createdAt: 1 }]);
    await r.addAttempt({ drillId: 'd1', at: 1, correct: true });
    await r.saveSettings({ ...(await r.getSettings()), rating: 900 });
    const backup = await r.exportAll();
    const r2 = new LocalStorageRepository(memoryStore());
    await r2.importAll(backup);
    expect((await r2.getGame(game.id))?.report?.headline).toBe(game.report!.headline);
    expect(await r2.listDrills()).toHaveLength(1);
    expect((await r2.getSettings()).rating).toBe(900);
    await r2.deleteGame(game.id);
    expect(await r2.listGames()).toHaveLength(0);
    expect(await r2.listDrills()).toHaveLength(0);
  });
});
