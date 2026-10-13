// Experimental training: the diagnosis decides what weakness a game revealed (from
// Stockfish's consistent evaluations and the board), lessons get only useful drills, and
// opening weaknesses get an opening lesson built from the student's own opening.
// Three regression games: the Sicilian win (opening development), the draw (a strategic
// decision), and a win where the opening was fine but the lesson is conversion.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coachFromPositions } from '../src/analysis/pipeline';
import { buildLessons, diagnose } from '../src/training/diagnosis';
import { buildOpeningLine } from '../src/training/opening';
import { assemblePlan } from '../src/training/plan';
import { lichessGroups, toExplorer } from '../src/training/lichessClient';
import { proxyLichess } from '../server/lichessProxy';
import type { PositionEval, StoredGame } from '../src/domain/types';
import { fixtureGame } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const NAMES = ['draw-game', 'sicilian-win-game', 'winning-game', 'queen-blunder-game', 'black-win-game', 'queen-hunt-game', 'resign-win-game', 'knight-trip-game', 'chaotic-game', 'kingside-storm-game'] as const;
const all: StoredGame[] = NAMES.map((n, i) => {
  const { game, positions } = fixtureGame(n, n, Date.UTC(2026, 9, 1 + i));
  const g: StoredGame = { ...coachFromPositions(game, positions, []).game, status: 'analyzed' };
  const f = join(here, 'fixtures', `${n}-beta-eval.json`);
  return existsSync(f) ? { ...g, aiCoachEval: JSON.parse(readFileSync(f, 'utf8')) } : g;
});
const byId = (id: string) => all.find((g) => g.id === id)!;
const recorded: Record<string, PositionEval> = JSON.parse(readFileSync(join(here, 'fixtures', 'sicilian-win-game-opening-positions.json'), 'utf8'));
const replay = async (fen: string) => {
  const p = recorded[fen];
  if (!p) throw new Error(`no recorded analysis for ${fen}`);
  return p;
};

describe('the Sicilian win: an opening-development weakness, not a one-off puzzle', () => {
  const game = byId('sicilian-win-game');
  const diag = diagnose(game, all)!;
  const lessons = buildLessons(game, all, diag);

  it('picks opening development, with the evidence that makes it an opening problem', () => {
    expect(diag.priority).toBe('opening_development');
    expect(diag.openingName).toBe('Sicilian Defence');
    const kinds = diag.instances.find((i) => i.category === 'opening_development')!.signals.map((s) => s.kind);
    expect(kinds).toEqual(['early_drift', 'early_error', 'development_lag', 'defensive_duty']);
    const text = lessons[0].signals.map((s) => s.text).join(' ');
    expect(text).toMatch(/2\.e5 \(-0\.7\)/);
    expect(text).toMatch(/Nb1, Bc1 still at home/);
    expect(text).toMatch(/bishop on c1 was the guard of b2, with the rook on a1 behind it/);
  });

  it('trains the structure: an opening lesson, the 11.Bf4 decision, and what Black takes — plus the same problem from another game', () => {
    expect(lessons).toHaveLength(1);
    const d = lessons[0].drafts;
    expect(d.map((x) => [x.format, x.source])).toEqual([
      ['opening_lesson', 'this_game'],
      ['strategic_choice', 'this_game'],
      ['predict_threat', 'derived'],
      ['strategic_choice', 'other_game'],
    ]);
    const choice = d[1];
    expect(choice.ply).toBe(21);
    expect(choice.options!.map((o) => `${o.san}:${o.quality}`)).toEqual(expect.arrayContaining(['Na3:best', 'Bf4:blunder']));
    expect(d[2].graded[0].san).toBe('Bxb2');
  });

  it('builds the opening line from your own opening, leaving it only where your move was unsound', async () => {
    const line = await buildOpeningLine(game, { analyse: replay });
    expect(line.steps.slice(0, 2).map((s) => s.move.san)).toEqual(['e4', 'c5']);
    expect(line.deviation).toEqual({ ply: 3, played: 'e5', recommended: 'Nc3' });
    for (const s of line.steps.filter((x) => x.side === 'yours')) {
      // Every recommended move is one Stockfish rates good or better: no engine-only tricks, no unsound moves.
      expect(s.acceptable!.map((a) => a.uci)).toContain(s.move.uci);
      expect(['best', 'equal', 'good']).toContain(s.acceptable!.find((a) => a.uci === s.move.uci)!.quality);
    }
    const sans = line.steps.map((s) => s.move.san);
    expect(sans).toContain('O-O');
    expect(line.endReason).toMatch(/castled and your pieces are out/);
    expect(line.steps.find((s) => s.ply === 3)!.inGame).toEqual({ san: 'e5', quality: 'inaccuracy' });
  });
});

describe('the draw: a strategic decision, not an opening problem', () => {
  const game = byId('draw-game');
  const diag = diagnose(game, all)!;
  const lessons = buildLessons(game, all, diag);
  it('picks the …e4 decision and replays it with the choice at the decision', () => {
    expect(diag.priority).toBe('strategic_decision');
    const replayDrill = lessons[0].drafts[0];
    expect(replayDrill).toMatchObject({ format: 'replay_sequence', ply: 38 });
    expect(replayDrill.sequence!.decisionPly).toBe(38);
    expect(replayDrill.options!.map((o) => o.san)).toEqual(expect.arrayContaining(['Rfe8', 'e4']));
    expect(lessons.map((l) => l.category)).toEqual(['strategic_decision', 'blunder_check']);
    expect(lessons.flatMap((l) => l.drafts).some((x) => x.format === 'opening_lesson')).toBe(false);
  });
});

describe('the conversion win: opening fine, the lesson is converting', () => {
  const game = byId('winning-game');
  const diag = diagnose(game, all)!;
  const lessons = buildLessons(game, all, diag);
  it('picks conversion, and the opening does not qualify as the weakness', () => {
    expect(diag.priority).toBe('conversion');
    expect(diag.scores.find((s) => s.category === 'opening_development')?.score ?? 0).toBeLessThan(3);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].drafts.map((x) => x.format)).toEqual(['strategic_choice', 'strategic_choice', 'predict_threat', 'strategic_choice']);
    expect(lessons[0].drafts[0].ply).toBe(45); // 23.Ba7, which gave back the whole advantage
  });
});

describe('no filler', () => {
  it('never more than a handful of drills per lesson, each a different position', () => {
    for (const g of all.slice(0, 3)) {
      for (const l of buildLessons(g, all, diagnose(g, all)!)) {
        expect(l.drafts.length).toBeLessThanOrEqual(4);
        expect(new Set(l.drafts.map((d) => `${d.fen}|${d.format}`)).size).toBe(l.drafts.length);
      }
    }
  });
});

describe('assembling the plan', () => {
  const game = byId('sicilian-win-game');
  const diag = diagnose(game, all)!;
  const lessons = buildLessons(game, all, diag);

  it('works without the AI coach (templates), saying what the game exposed', async () => {
    const line = await buildOpeningLine(game, { analyse: replay });
    const t = assemblePlan({ game, all, rating: 960, diag, lessons, line });
    expect(t.writtenBy).toBe('template');
    expect(t.priority.title).toMatch(/This game exposed an opening-development weakness in the Sicilian Defence\. Let's train the opening structure that led to it\./);
    expect(t.opening!.steps.length).toBeGreaterThan(8);
    expect(t.lessons[0].drills.every((d) => d.prompt && d.feedback.correct)).toBe(true);
  });

  it('lets the coach choose among allowed formats and drop drills, never invent them, and referees its text', async () => {
    const line = await buildOpeningLine(game, { analyse: replay });
    const [l] = lessons;
    const written = JSON.stringify({
      priority: { title: 'Your opening left pieces at home.', why: '11.Bf4 was a strong developing move.' },
      lessons: [
        {
          id: l.id,
          drills: [
            { id: l.drafts[1].id, format: 'compare_plans', prompt: 'Which move develops without giving up a defender?' },
            { id: l.drafts[2].id, format: 'tactical_puzzle', prompt: 'What does Black take now?' },
            { id: l.drafts[3].id, keep: false },
            { id: 'invented', prompt: 'A made-up drill' },
          ],
        },
      ],
      opening: { summary: 'Develop with Nc3 and Nf3, then castle. Qh5 attacks early.', steps: [{ ply: 3, idea: 'Nc3 develops and protects e4.' }] },
    });
    const t = assemblePlan({ game, all, rating: 960, diag, lessons, written, model: 'mock', line });
    const drills = t.lessons[0].drills;
    expect(drills.map((d) => d.format)).toEqual(['opening_lesson', 'compare_plans', 'predict_threat']); // tactical_puzzle not allowed there; dropped one removed
    expect(drills.some((d) => d.id === 'invented')).toBe(false);
    expect(t.priority.why).not.toMatch(/strong developing move/);
    expect(t.removed.map((r) => r.text)).toEqual(expect.arrayContaining(['11.Bf4 was a strong developing move.', 'Qh5 attacks early.']));
    expect(t.opening!.summary).toBe('Develop with Nc3 and Nf3, then castle.');
  });
});

describe('Lichess opening data', () => {
  it('maps a Chess.com rapid rating to nearby Lichess rating groups', () => {
    expect(lichessGroups(900)).toBe('1000,1200,1400');
    expect(lichessGroups(500)).toBe('0,1000');
  });

  it('turns the explorer answer into shares per move', () => {
    const e = toExplorer({ moves: [{ uci: 'g1f3', san: 'Nf3', white: 60, draws: 10, black: 30 }, { uci: 'b1c3', san: 'Nc3', white: 30, draws: 0, black: 70 }], opening: { name: 'Sicilian Defence' } });
    expect(e.moves.map((m) => [m.san, m.share])).toEqual([['Nf3', 0.5], ['Nc3', 0.5]]);
    expect(e.opening).toBe('Sicilian Defence');
  });

  it('keeps the token server-side, needs the access code when hosted, and only forwards position queries', async () => {
    const fen = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2';
    const q = new URLSearchParams({ fen, ratings: '1000,1200' });
    expect((await proxyLichess(q, {}, { hosted: false })).status).toBe(503);
    expect((await proxyLichess(q, { LICHESS_TOKEN: 'lip_x', COACH_ACCESS_TOKEN: 'code' }, { hosted: true, accessCode: 'nope' })).status).toBe(401);
    expect((await proxyLichess(new URLSearchParams({ fen: 'garbage' }), { LICHESS_TOKEN: 'lip_x' }, { hosted: false })).status).toBe(400);
    let seen: { url: string; auth: string | null } | undefined;
    const r = await proxyLichess(q, { LICHESS_TOKEN: 'lip_x', COACH_ACCESS_TOKEN: 'code' }, { hosted: true, accessCode: 'code' }, (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get('authorization') };
      return new Response('{"moves":[]}', { status: 200 });
    }) as unknown as typeof fetch);
    expect(r.status).toBe(200);
    expect(seen!.auth).toBe('Bearer lip_x');
    expect(seen!.url).toMatch(/^https:\/\/explorer\.lichess\.org\/lichess\?variant=standard&speeds=blitz%2Crapid%2Cclassical&ratings=1000%2C1200&fen=/);
    expect(r.body).not.toMatch(/lip_x/);
  });
});
