// Shared loading for the ground-truth suite (tests/truth): the games as the app stores them, and
// the cached engine output for each one.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PositionEval, StoredGame } from '../../src/domain/types.ts';
import { parsePgn } from '../../src/chess/pgn.ts';

export const TRUTH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'truth');

export interface TruthMoment {
  id: string;
  game: string;
  my_color: 'white' | 'black';
  move_number: number;
  played: string;
  ply: number;
  fen_before: string;
  kind: 'mistake' | 'missed_opportunity';
  primary_label: string;
  secondary_labels: string[];
  mechanism: string;
  expected_lesson: string;
  must_not_label: string[];
  confidence: string;
  split: 'tune' | 'holdout';
}
export interface TruthGame {
  game: string;
  my_color: 'white' | 'black';
  result: string;
  movetext: string;
  expected_summary?: { story: string[]; must_not_flag: string[] };
}
export interface CleanGame {
  game: string;
  my_color: 'white' | 'black';
  note: string;
  must_not_lesson: string[];
}
export interface GroundTruth {
  label_definitions: Record<string, string>;
  moments: TruthMoment[];
  clean_games: CleanGame[];
  games: TruthGame[];
}

export const loadTruth = (): GroundTruth => JSON.parse(readFileSync(join(TRUTH_DIR, 'ground-truth.json'), 'utf8'));

/** "White vs Black" → a file-safe name for the game's cached engine output. */
export const gameSlug = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, '_');
export const positionsPath = (name: string) => join(TRUTH_DIR, 'positions', `${gameSlug(name)}.json`);

export function storedGame(g: TruthGame): StoredGame {
  const [white, black] = g.game.split(' vs ');
  const parsed = parsePgn(`[White "${white}"]\n[Black "${black}"]\n[Result "${g.result}"]\n\n${g.movetext}\n`);
  const userColor = g.my_color === 'white' ? 'w' : 'b';
  return {
    id: gameSlug(g.game),
    importedAt: Date.UTC(2026, 9, 28),
    pgn: parsed.pgn,
    headers: parsed.headers,
    userColor,
    userName: userColor === 'w' ? parsed.headers.white : parsed.headers.black,
    opponentName: userColor === 'w' ? parsed.headers.black : parsed.headers.white,
    plies: parsed.plies,
    status: 'imported',
    findings: [],
    moments: [],
    drillIds: [],
    completedMomentIds: [],
  };
}

export function cachedPositions(name: string): PositionEval[] | undefined {
  const p = positionsPath(name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
}
