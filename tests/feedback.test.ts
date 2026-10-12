import { describe, expect, it } from 'vitest';
import { feedbackCount, feedbackReport, mergeFeedback } from '../src/coach/feedback';
import { LocalStorageRepository, memoryStore } from '../src/storage/repository';
import type { CoachFeedback } from '../src/domain/types';
import { fixtureGame } from './helpers';

const note = (id: string, createdAt: number, extra: Partial<CoachFeedback> = {}): CoachFeedback => ({
  id,
  where: 'hurt',
  quote: '29.g4 put the pawn on g4 where it could be taken (fxg4).',
  note: 'g4 was a pawn sacrifice to open the g-file',
  ply: 57,
  createdAt,
  ...extra,
});

describe('"this seems wrong" feedback', () => {
  it('exports flagged statements with the move, the note and the PGN', () => {
    const { game } = fixtureGame('chaotic-game');
    const md = feedbackReport([{ ...game, feedback: [note('a', 1), note('b', 2, { where: 'focus', quote: 'Look for checks', note: '', ply: undefined })] }], 5);
    expect(md).toMatch(/2 flagged statement\(s\) from 1 game\(s\) · report version 5/);
    expect(md).toMatch(/I played White\./);
    expect(md).toMatch(/- \*\*What hurt you\*\* \(move 29\.g4\): "29\.g4 put the pawn/);
    expect(md).toMatch(/My note: g4 was a pawn sacrifice/);
    expect(md).toMatch(/\*\*Focus for next game\*\*: "Look for checks"\n  - \(no note\)/);
    expect(md).toMatch(/```pgn\n1\. e4 d5/);
  });

  it('merges notes from two devices without losing any', async () => {
    expect(mergeFeedback([note('a', 1)], [note('a', 1), note('b', 2)])!.map((f) => f.id)).toEqual(['a', 'b']);
    expect(mergeFeedback([], [])).toBeUndefined();

    const { game } = fixtureGame('chaotic-game');
    const laptop = new LocalStorageRepository(memoryStore());
    const phone = new LocalStorageRepository(memoryStore());
    await laptop.saveGame({ ...game, feedback: [note('a', 1)] });
    await phone.saveGame({ ...game, feedback: [note('b', 2)] });
    // Same freshness: the phone keeps its own game but gains the laptop's note.
    await phone.importAll(await laptop.exportAll());
    const g = await phone.getGame(game.id);
    expect(g!.feedback!.map((f) => f.id)).toEqual(['a', 'b']);
    expect(feedbackCount([g!])).toBe(2);
  });
});
