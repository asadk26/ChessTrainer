import { Chess } from 'chess.js';
import type { GameHeaders, ParsedGame, PieceType, PlyRecord } from '../domain/types';

export class PgnError extends Error {}

/**
 * Normalise PGN text pasted from websites, chats or word processors:
 * smart quotes, non-breaking spaces, Windows newlines, stray BOMs.
 */
export function normalizePgn(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[–—]/g, '-')
    .replace(/0-0-0/g, 'O-O-O')
    .replace(/(^|[^-\d])0-0(?![-\d])/g, '$1O-O')
    .trim();
}

function parseHeaderBlock(pgn: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*\[(\w+)\s+"([^"]*)"\s*\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn))) out[m[1]] = m[2];
  return out;
}

function toInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseClock(comment: string | undefined): number | undefined {
  if (!comment) return undefined;
  const m = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/.exec(comment);
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parsePgn(raw: string): ParsedGame {
  const pgn = normalizePgn(raw);
  if (!pgn) throw new PgnError('The PGN is empty.');

  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch (e) {
    throw new PgnError(`Could not read the moves in this PGN: ${(e as Error).message}`);
  }

  // chess.js fills unknown headers with "?" placeholders; treat those as missing.
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...parseHeaderBlock(pgn), ...(chess.getHeaders() as Record<string, string>) })) {
    if (v && v.trim() && !/^[?.\s-]*$/.test(v)) tags[k] = v;
  }
  const history = chess.history({ verbose: true });
  if (history.length === 0) throw new PgnError('No moves were found in this PGN.');

  const clockByFen = new Map<string, number>();
  for (const { fen, comment } of chess.getComments()) {
    const c = parseClock(comment);
    if (c !== undefined) clockByFen.set(fen, c);
  }

  const startFen = history[0].before;
  const plies: PlyRecord[] = history.map((mv, i) => ({
    ply: i + 1,
    moveNumber: 0, // filled in below
    color: mv.color,
    san: mv.san,
    uci: mv.from + mv.to + (mv.promotion ?? ''),
    from: mv.from,
    to: mv.to,
    piece: mv.piece as PieceType,
    captured: mv.captured as PieceType | undefined,
    promotion: mv.promotion as PieceType | undefined,
    fenBefore: mv.before,
    fenAfter: mv.after,
    clockSeconds: clockByFen.get(mv.after),
  }));
  // Correct move numbers for games that start from a custom FEN.
  const startMoveNo = parseInt(startFen.split(' ')[5] ?? '1', 10) || 1;
  const blackFirst = startFen.split(' ')[1] === 'b';
  plies.forEach((p, i) => {
    const offset = blackFirst ? i + 1 : i;
    p.moveNumber = startMoveNo + Math.floor(offset / 2);
  });

  let result = tags.Result ?? '*';
  if (result === '*') {
    const m = /(1-0|0-1|1\/2-1\/2)\s*$/.exec(pgn);
    if (m) result = m[1];
  }

  const headers: GameHeaders = {
    white: tags.White?.trim() || 'White',
    black: tags.Black?.trim() || 'Black',
    whiteElo: toInt(tags.WhiteElo),
    blackElo: toInt(tags.BlackElo),
    result,
    date: tags.Date && !tags.Date.includes('?') ? tags.Date : tags.UTCDate,
    event: tags.Event,
    site: tags.Site,
    timeControl: tags.TimeControl,
    termination: tags.Termination,
    link: tags.Link,
  };

  return { headers, startFen, plies, pgn };
}

/** Human-readable move label, e.g. "11.Nb5" or "11...Rb7". */
export function moveLabel(p: Pick<PlyRecord, 'moveNumber' | 'color' | 'san'>): string {
  return p.color === 'w' ? `${p.moveNumber}.${p.san}` : `${p.moveNumber}...${p.san}`;
}
