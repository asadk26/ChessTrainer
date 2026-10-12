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
