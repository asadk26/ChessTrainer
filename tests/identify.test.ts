import { describe, expect, it } from 'vitest';
import { identifyUser, rememberUsername } from '../src/profile/identify';
import type { GameHeaders } from '../src/domain/types';

const h = (white: string, black: string): GameHeaders => ({ white, black, result: '*' });

describe('player identification', () => {
  it('returns null when there is no history', () => {
    expect(identifyUser(h('chunkmonkey420', 'mirokvp'), {})).toBeNull();
  });

  it('recognises a known username on either color, case-insensitively', () => {
    const known = rememberUsername({}, 'ChunkMonkey420');
    expect(identifyUser(h('chunkmonkey420', 'mirokvp'), known)).toEqual({ color: 'w', name: 'chunkmonkey420', confident: true });
    expect(identifyUser(h('someone', 'CHUNKMONKEY420'), known)).toEqual({ color: 'b', name: 'CHUNKMONKEY420', confident: true });
  });

  it('prefers the more frequent name if both players are known', () => {
    let known = rememberUsername({}, 'me');
    known = rememberUsername(known, 'me');
    known = rememberUsername(known, 'friend');
    expect(identifyUser(h('friend', 'me'), known)).toMatchObject({ color: 'b', confident: false });
  });

  it('never learns or matches placeholder names from PGNs without player tags', () => {
    const known = rememberUsername({}, 'White');
    expect(known).toEqual({});
    expect(identifyUser(h('White', 'Black'), { white: 5 })).toBeNull();
  });
});
