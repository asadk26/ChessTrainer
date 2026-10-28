import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PositionEval, StoredGame } from '../src/domain/types';
import { parsePgn } from '../src/chess/pgn';
import { SAMPLE_PGN } from '../src/fixtures/sampleGame';

const here = dirname(fileURLToPath(import.meta.url));

/** Stockfish 17.1 lite, depth 12, MultiPV 3 output for the sample game (recorded once). */
export function samplePositions(): PositionEval[] {
  return JSON.parse(readFileSync(join(here, 'fixtures', 'sample-positions.json'), 'utf8'));
}

export function storedFromPgn(pgn: string, userColor: 'w' | 'b', id = 'g1', importedAt = Date.UTC(2026, 9, 12)): StoredGame {
  const g = parsePgn(pgn);
  return {
    id,
    importedAt,
    pgn: g.pgn,
    headers: g.headers,
    userColor,
    userName: userColor === 'w' ? g.headers.white : g.headers.black,
    opponentName: userColor === 'w' ? g.headers.black : g.headers.white,
    plies: g.plies,
    status: 'imported',
    findings: [],
    moments: [],
    drillIds: [],
    completedMomentIds: [],
  };
}

export const sampleStored = (id = 'g1', importedAt?: number) => storedFromPgn(SAMPLE_PGN, 'w', id, importedAt);

export function fixtureGame(name: 'winning-game' | 'knight-trip-game' | 'kingside-storm-game' | 'chaotic-game' | 'black-win-game' | 'queen-blunder-game' | 'queen-hunt-game' | 'resign-win-game' | 'draw-game' | 'sicilian-win-game' | 'atayan-game' | 'josedang-game' | 'harrison-game' | 'aditya-game' | 'halfmast-game' | 'blundering-game' | 'jnhbleachie-game' | 'abhi-game', id: string = name, importedAt = Date.UTC(2026, 9, 20)) {
  const color = ['knight-trip-game', 'black-win-game', 'queen-blunder-game', 'queen-hunt-game', 'resign-win-game', 'draw-game', 'harrison-game', 'halfmast-game', 'blundering-game', 'jnhbleachie-game', 'abhi-game'].includes(name) ? 'b' : 'w';
  return {
    game: storedFromPgn(readFileSync(join(here, 'fixtures', `${name}.pgn`), 'utf8'), color, id, importedAt),
    positions: JSON.parse(readFileSync(join(here, 'fixtures', `${name}-positions.json`), 'utf8')) as PositionEval[],
  };
}
