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

describe('backup import (moving between devices)', () => {
  const drill = (id: string) => ({ id, gameId: game.id, ply: 1, type: 'choose_plan' as const, category: 'opened_vs_king' as const, fen: 'x', orientation: 'w' as const, prompt: 'p', explanation: 'e', createdAt: 1 });

  it('merges instead of replacing, and reports what changed', async () => {
    const laptop = new LocalStorageRepository(memoryStore());
    await laptop.saveGame(game);
    await laptop.saveGame({ ...game, id: 'only-on-laptop' });
    await laptop.replaceDrillsForGame(game.id, [drill('d1')]);
    await laptop.addAttempt({ drillId: 'd1', at: 5, correct: false });
    await laptop.saveSettings({ ...(await laptop.getSettings()), usernames: { chunkmonkey420: 2 } });

    const phone = new LocalStorageRepository(memoryStore());
    await phone.saveGame({ ...game, id: 'only-on-phone' });
    await phone.addAttempt({ drillId: 'd1', at: 5, correct: false });
    await phone.saveSettings({ ...(await phone.getSettings()), usernames: { chunkmonkey420: 1, other: 1 } });

    const summary = await phone.importAll(await laptop.exportAll());
    expect(summary).toMatchObject({ gamesAdded: 2, gamesUpdated: 0, gamesKept: 0, drills: 1, attempts: 0 });
    expect((await phone.listGames()).map((g) => g.id).sort()).toEqual([game.id, 'only-on-laptop', 'only-on-phone']);
    expect(await phone.listAttempts()).toHaveLength(1); // duplicate attempt not doubled
    expect((await phone.getSettings()).usernames).toEqual({ chunkmonkey420: 2, other: 1 });

    // Importing the same backup again changes nothing.
    expect(await phone.importAll(await laptop.exportAll())).toMatchObject({ gamesAdded: 0, gamesKept: 2, drills: 0, attempts: 0 });
  });

  it('keeps the newer analysis of a game that exists on both devices', async () => {
    const a = new LocalStorageRepository(memoryStore());
    const b = new LocalStorageRepository(memoryStore());
    const newer = { ...game, analysis: { ...game.analysis!, analyzedAt: 2000 }, report: { ...game.report!, headline: 'newer' } };
    await a.saveGame({ ...game, analysis: { ...game.analysis!, analyzedAt: 1000 } });
    await b.saveGame(newer);
    expect((await a.importAll(await b.exportAll())).gamesUpdated).toBe(1);
    expect((await a.getGame(game.id))?.report?.headline).toBe('newer');
  });

  it('rejects files that are not backups', async () => {
    const r = new LocalStorageRepository(memoryStore());
    await expect(r.importAll('not json')).rejects.toThrow(/valid JSON/);
    await expect(r.importAll('{"hello":1}')).rejects.toThrow(/Chess Coach backup/);
  });
});
