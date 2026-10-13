// Training diagnosis: what weakness did this game reveal that deserves practice AWAY
// from this exact position? Deterministic and explainable: every signal is a fact
// from Stockfish's consistent-depth evaluations and the board, so the same game always
// gives the same diagnosis, and the coach (AI) only chooses among and explains it.
//
// The key distinction: an error in the opening phase, made while development was
// unfinished (pieces at home, king uncastled, a piece doing a defensive job), is an
// OPENING-UNDERSTANDING problem — train the opening structure. The same kind of error
// with development complete is a one-off BLUNDER-CHECK problem — train the check.
import { Chess } from 'chess.js';
import type { Color, DrillFormat, GradedMove, PositionEval, StoredGame, TrainingCategory, TrainingDrill, TrainingLesson, TrainingSignal } from '../domain/types';
import { COLOR_NAME, PIECE_NAME, attackedEnemyPieces, attackersOf, materialBalance, nonPawnMaterial, other, pieceAt, uciToSan, undevelopedMinors } from '../chess/board';
import { moveLabel } from '../chess/pgn';
import { lineToPoint } from '../analysis/linePoint';
import { rankCandidates } from '../analysis/moveQuality';
import { verdictOf } from '../analysis/engineReview';
import { scoreToCp, winPercent } from '../analysis/evaluation';
import { betaSeries, evaluationShifts, fmtEval, type Series } from '../coach/betaCoach';

/** Opening window: the first 12 moves each, while the game is still in the balance. */
const OPENING_MOVES = 12;
const cap = (c: number) => Math.max(-1500, Math.min(1500, c));
const fenAt = (game: StoredGame, i: number) => (i === 0 ? game.plies[0].fenBefore : game.plies[i - 1].fenAfter);
export const gameLabel = (g: StoredGame) => `${g.headers.white} vs ${g.headers.black}${g.headers.date ? ` (${g.headers.date})` : ''}`;

export interface Instance {
  category: TrainingCategory;
  ply: number;
  /** How much it cost (centipawns, positive = loss for the student), for ranking. */
  cost: number;
  signals: TrainingSignal[];
  /** For opening/blunder: the square whose defender walked away. */
  duty?: { piece: string; from: string; square: string; behind?: string };
  /** Opening instances: development was behind for the move number. */
  lagging?: boolean;
}

export interface Diagnosis {
  priority: TrainingCategory;
  scores: { category: TrainingCategory; score: number; reason: string }[];
  instances: Instance[];
  /** First 3–4 moves of the game, for naming and matching the opening. */
  openingKey: string;
  openingName: string;
}

// ------------------------------------------------------------- helpers ---

/** Student's development at a position: minors at home, castled (from the moves), rooks connected. */
export function development(game: StoredGame, i: number, color: Color) {
  const fen = fenAt(game, i);
  const castled = game.plies.slice(0, i).some((p) => p.color === color && p.san.startsWith('O-O'));
  const rank = color === 'w' ? '1' : '8';
  const board = new Chess(fen).board()[color === 'w' ? 7 : 0];
  const rooks = board.map((sq, f) => (sq && sq.color === color && sq.type === 'r' ? f : -1)).filter((f) => f >= 0);
  const connected = rooks.length === 2 && board.slice(rooks[0] + 1, rooks[1]).every((sq) => !sq);
  void rank;
  return { undeveloped: undevelopedMinors(fen, color), castled, connected };
}

/**
 * Did the student's move at `ply` take a piece off a defensive job? The square it guarded
 * is the one the opponent's best reply (or actual reply) captures on.
 */
export function abandonedDuty(game: StoredGame, s: Series, ply: number): Instance['duty'] {
  const p = game.plies[ply - 1];
  const replies = [s.positions[ply]?.lines[0]?.pv[0], game.plies[ply]?.uci].filter(Boolean) as string[];
  for (const r of replies) {
    const target = r.slice(2, 4);
    const victim = pieceAt(p.fenAfter, target);
    if (!victim || victim.color !== p.color) continue;
    const guardedBefore = attackersOf(p.fenBefore, target, p.color).includes(p.from);
    const guardsAfter = attackersOf(p.fenAfter, target, p.color).includes(p.to);
    if (!guardedBefore || guardsAfter) continue;
    // What the capturing piece then hits behind it (e.g. the rook on a1 after Bxb2).
    const c = new Chess(p.fenAfter);
    let behind: string | undefined;
    try {
      c.move({ from: r.slice(0, 2), to: target, promotion: 'q' });
      const hit = attackedEnemyPieces(c.fen(), target).find((h) => h.type === 'r' || h.type === 'q');
      if (hit) behind = `the ${PIECE_NAME[hit.type]} on ${hit.square}`;
    } catch {
      /* not a legal capture in this line */
    }
    const mover = pieceAt(p.fenBefore, p.from);
    return { piece: mover ? PIECE_NAME[mover.type] : 'piece', from: p.from, square: target, behind };
  }
  return undefined;
}

/** Material the student loses in the engine's line after their move (pawns, positive = lost), once it settles. */
function materialLost(game: StoredGame, s: Series, ply: number): number {
  const p = game.plies[ply - 1];
  const pt = lineToPoint(p.fenBefore, [p.uci, ...(s.positions[ply]?.lines[0]?.pv ?? [])], p.color, 8);
  const end = pt.frames[pt.frames.length - 1]?.fen ?? p.fenAfter;
  return materialBalance(p.fenBefore, p.color) - materialBalance(end, p.color);
}

const OPENINGS: [string, string][] = [
  ['e4 c5', 'Sicilian Defence'],
  ['e4 e5 Nf3 Nc6 Bb5', 'Ruy Lopez'],
  ['e4 e5 Nf3 Nc6 Bc4', 'Italian Game'],
  ['e4 e5 Nf3 Nc6 Nc3', 'Three/Four Knights'],
  ['e4 e5 Nf3 Nc6 d4', 'Scotch Game'],
  ['e4 e5 Nf3 d6', 'Philidor Defence'],
  ['e4 e5 Nf3 Nf6', 'Petrov Defence'],
  ['e4 e5 Nc3', 'Vienna Game'],
  ['e4 e5 f4', "King's Gambit"],
  ['e4 e5', 'Open Game (1.e4 e5)'],
  ['e4 e6', 'French Defence'],
  ['e4 c6', 'Caro-Kann Defence'],
  ['e4 d5', 'Scandinavian Defence'],
  ['e4 Nf6', 'Alekhine Defence'],
  ['e4 d6', 'Pirc Defence'],
  ['e4 g6', 'Modern Defence'],
  ['e4 Nc6', 'Nimzowitsch Defence'],
  ['d4 d5 c4', "Queen's Gambit"],
  ['d4 d5 Bf4', 'London System'],
  ['d4 Nf6 Bf4', 'London System'],
  ['d4 d5', "Queen's Pawn Game"],
  ['d4 Nf6 c4 g6', "King's Indian / Grünfeld"],
  ['d4 Nf6 c4 e6', 'Nimzo/Queen’s Indian'],
  ['d4 Nf6', 'Indian Defence'],
  ['d4 f5', 'Dutch Defence'],
  ['c4', 'English Opening'],
  ['Nf3', 'Réti Opening'],
  ['e4', "King's Pawn Opening"],
  ['d4', "Queen's Pawn Opening"],
];

export function openingName(game: StoredGame): { key: string; name: string } {
  const sans = game.plies.slice(0, 8).map((p) => p.san.replace(/[+#]$/, ''));
  const line = sans.join(' ');
  const hit = OPENINGS.find(([k]) => line === k || line.startsWith(`${k} `));
  return { key: sans.slice(0, 4).join(' '), name: hit?.[1] ?? 'Unusual opening' };
}

// ------------------------------------------------------------ detectors ---

const detected = new WeakMap<StoredGame, { instances: Instance[]; s: Series } | undefined>();

/** Every training-relevant moment in one game, from the student's point of view (cached per game object). */
export function detect(game: StoredGame): { instances: Instance[]; s: Series } | undefined {
  if (!detected.has(game)) detected.set(game, detectUncached(game));
  return detected.get(game);
}

function detectUncached(game: StoredGame): { instances: Instance[]; s: Series } | undefined {
  const s = betaSeries(game);
  if (!s) return undefined;
  const user = game.userColor;
  const out: Instance[] = [];
  const effect = (k: number) => cap(s.cp[k]) - cap(s.cp[k - 1]); // student POV
  const mine = game.plies.filter((p) => p.color === user && !s.unsure[p.ply]);
  const verdict = (k: number) => verdictOf(s.moves[k - 1]);
  const BAD = ['mistake', 'blunder'];

  // Opening: drift and the first serious error while the game was still in the balance.
  const inOpening = mine.filter((p) => p.moveNumber <= OPENING_MOVES + 3 && Math.abs(s.cp[p.ply - 1]) < 300);
  const firstSerious = inOpening.find((p) => BAD.includes(verdict(p.ply)));
  // The drift that led up to it (the error itself is reported separately).
  const slips = inOpening.filter(
    (p) => p.moveNumber <= OPENING_MOVES && (!firstSerious || p.ply < firstSerious.ply) && effect(p.ply) <= -30 && verdict(p.ply) !== 'best' && verdict(p.ply) !== 'equal',
  );
  const drift = inOpening.filter((p) => p.moveNumber <= OPENING_MOVES && (!firstSerious || p.ply < firstSerious.ply)).reduce((a, p) => a + Math.min(0, effect(p.ply)), 0);
  if (firstSerious || drift <= -60) {
    const at = firstSerious ?? slips[0];
    const k = at?.ply ?? inOpening[0]?.ply;
    if (k) {
      const dev = development(game, k - 1, user);
      const duty = firstSerious ? abandonedDuty(game, s, firstSerious.ply) : undefined;
      const signals: TrainingSignal[] = [];
      if (slips.length)
        signals.push({
          kind: 'early_drift',
          ply: slips[0].ply,
          text: `Early drift: ${slips.map((p) => `${moveLabel(p)} (${(effect(p.ply) / 100).toFixed(1)})`).join(', ')} — Stockfish preferred ${slips.map((p) => s.moves[p.ply - 1].bestSan).join(', ')}.`,
        });
      if (firstSerious) signals.push({ kind: 'early_error', ply: firstSerious.ply, text: `${moveLabel(firstSerious)} was a ${verdict(firstSerious.ply)} on move ${firstSerious.moveNumber} (${fmtEval(s.cp[firstSerious.ply - 1])} → ${fmtEval(s.cp[firstSerious.ply])}).` });
      // Lagging for the move number (rooks unconnected at move 9 is normal; two minors at home at move 11 isn't).
      const mn = game.plies[k - 1].moveNumber;
      const lagging = (dev.undeveloped.length >= 2 && mn >= 8) || (dev.undeveloped.length >= 1 && mn >= 10) || (!dev.castled && mn >= 10);
      if (lagging)
        signals.push({
          kind: 'development_lag',
          ply: k,
          text: `At that point: ${[dev.undeveloped.length ? `${dev.undeveloped.join(', ')} still at home` : '', !dev.castled ? 'king not castled' : '', !dev.connected ? 'rooks not connected' : ''].filter(Boolean).join('; ')}.`,
        });
      if (duty) signals.push({ kind: 'defensive_duty', ply: firstSerious!.ply, text: `The ${duty.piece} on ${duty.from} was the guard of ${duty.square}${duty.behind ? `, with ${duty.behind} behind it` : ''}; moving it let the opponent take.` });
      if (signals.length) out.push({ category: 'opening_development', ply: k, cost: -drift + (firstSerious ? -effect(firstSerious.ply) : 0), signals, duty, lagging: signals.some((x) => x.kind === 'development_lag') });
    }
  }

  for (const p of mine) {
    const k = p.ply;
    const e = effect(k);
    const v = verdict(k);
    const lost = materialLost(game, s, k);
    // Blunder check: the move lost material, or allowed a tactic, straight away.
    if (BAD.includes(v) && (lost >= 2 || e <= -200)) {
      const duty = abandonedDuty(game, s, k);
      out.push({
        category: 'blunder_check',
        ply: k,
        cost: -e,
        duty,
        signals: [
          {
            kind: lost >= 2 ? 'material_lost' : 'tactic_allowed',
            ply: k,
            text: `${moveLabel(p)} ${lost >= 2 ? `lost about ${lost} pawn${lost > 1 ? 's' : ''} of material in Stockfish's line` : 'allowed a tactic'} (${fmtEval(s.cp[k - 1])} → ${fmtEval(s.cp[k])}).${duty ? ` It took the ${duty.piece} off ${duty.square}.` : ''}`,
          },
        ],
      });
    }
    // Missed tactic: Stockfish's best line won material (or mated), and the move played didn't.
    const before = s.positions[k - 1];
    if (before?.lines[0] && !s.moves[k - 1].isBest && v !== 'equal' && v !== 'good') {
      const best = lineToPoint(p.fenBefore, before.lines[0].pv, user, 8);
      const gain = materialBalance(best.frames[best.frames.length - 1]?.fen ?? p.fenBefore, user) - materialBalance(p.fenBefore, user);
      if ((best.kind === 'mate' || (best.kind === 'material' && gain >= 2)) && e <= -80)
        out.push({ category: 'missed_tactic', ply: k, cost: -e, signals: [{ kind: 'missed_tactic', ply: k, text: `At ${moveLabel(p)}, ${s.moves[k - 1].bestSan} ${best.text} — ${p.san} missed it.` }] });
    }
    // Conversion: already winning, and the move gave a real part of it back.
    if (s.cp[k - 1] >= 300 && e <= -100 && s.cp[k] < 500)
      out.push({ category: 'conversion', ply: k, cost: -e, signals: [{ kind: 'conversion_slip', ply: k, text: `While winning (${fmtEval(s.cp[k - 1])}), ${moveLabel(p)} gave back ${(-e / 100).toFixed(1)} (${fmtEval(s.cp[k])}).` }] });
  }

  // Strategic decision: the FIRST quiet move (no capture, no tactic allowed) that started a run
  // against the student. It is credited with its own cost plus half of what followed in the run.
  const tactical = new Set(out.filter((i) => i.category === 'blunder_check').map((i) => i.ply));
  for (const sh of evaluationShifts(game, s).filter((x) => x.direction === 'against you')) {
    const own = sh.moves.filter((m) => m.ply >= sh.fromPly && game.plies[m.ply - 1].color === user && m.change < 0);
    // While already winning, giving it back is a conversion problem (counted there).
    const start = own.find((m) => m.change <= -100 && s.cp[m.ply - 1] < 300 && !tactical.has(m.ply) && !game.plies[m.ply - 1].captured && materialLost(game, s, m.ply) < 3 && game.plies[m.ply - 1].moveNumber > OPENING_MOVES);
    if (!start) continue;
    const p = game.plies[start.ply - 1];
    const rest = own.filter((m) => m.ply > start.ply).reduce((a, m) => a - m.change, 0);
    out.push({
      category: 'strategic_decision',
      ply: start.ply,
      cost: -start.change + rest / 2,
      signals: [
        {
          kind: 'quiet_turning_point',
          ply: start.ply,
          text: `${moveLabel(p)} started a run against you (${fmtEval(s.cp[start.ply - 1])} → ${fmtEval(s.cp[start.ply])}, ${fmtEval(s.cp[sh.toPly])} by ${moveLabel(game.plies[sh.toPly - 1])}) without losing material at once: a decision, not a blunder.`,
        },
      ],
    });
  }

  // Endgame technique (a strength to reinforce): moves only the student's best move held.
  for (const p of mine) {
    const k = p.ply;
    const pos = s.positions[k - 1];
    if (!s.moves[k - 1].isBest || pos.lines.length < 2 || nonPawnMaterial(p.fenBefore) > 26 || /[qQ]/.test(p.fenBefore.split(' ')[0])) continue;
    const gap = winPercent(scoreToCp(pos.lines[0].score)) - winPercent(scoreToCp(pos.lines[1].score));
    if (gap >= 10) out.push({ category: 'endgame_technique', ply: k, cost: 0, signals: [{ kind: 'only_move_found', ply: k, text: `In the ending you found ${moveLabel(p)}, the only move that held (the next best was much worse).` }] });
  }
  return { instances: out, s };
}

// ------------------------------------------------------------ diagnosis ---

const LABEL: Record<TrainingCategory, string> = {
  opening_development: 'Opening development',
  blunder_check: 'Blunder check',
  missed_tactic: 'Spotting tactics',
  strategic_decision: 'Strategic decisions',
  conversion: 'Converting an advantage',
  endgame_technique: 'Endgame technique',
};
export const CATEGORY_LABEL = LABEL;

/**
 * Score each category from the instances (this game) and earlier games with the same
 * opening, and pick the training priority. Strengths only win when nothing needs fixing.
 */
export function diagnose(game: StoredGame, all: StoredGame[]): Diagnosis | undefined {
  const d = detect(game);
  if (!d) return undefined;
  const { instances } = d;
  const { key, name } = openingName(game);
  const of = (c: TrainingCategory) => instances.filter((i) => i.category === c);
  const scores: Diagnosis['scores'] = [];

  const op = of('opening_development')[0];
  if (op) {
    const kinds = new Set(op.signals.map((x) => x.kind));
    // The same opening (as the same colour) going wrong before, in another analysed game.
    const repeats = all.filter((g) => g.id !== game.id && g.status === 'analyzed' && g.userColor === game.userColor && openingName(g).name === name && detect(g)?.instances.some((i) => i.category === 'opening_development')).length;
    const score = (kinds.has('early_error') ? 3 : 0) + Math.min(3, op.cost / 60) + (kinds.has('development_lag') ? 2 : 0) + (kinds.has('defensive_duty') ? 1 : 0) + Math.min(2, repeats);
    scores.push({ category: 'opening_development', score, reason: `${[...kinds].join(', ')}${repeats ? `; ${repeats} earlier game(s) in the ${name} went wrong in the opening too` : ''}` });
  }
  const openingPly = op?.signals.find((x) => x.kind === 'early_error')?.ply;
  // Tactics allowed while already winning are a conversion problem; counted there, not twice.
  const convPlies = new Set(of('conversion').map((i) => i.ply));
  const bl = of('blunder_check').filter((i) => i.ply !== openingPly && !convPlies.has(i.ply));
  if (bl.length) scores.push({ category: 'blunder_check', score: 2.5 + bl.length + Math.min(2, Math.max(...bl.map((i) => i.cost)) / 300), reason: `${bl.length} move(s) lost material or allowed a tactic at once` });
  const mt = of('missed_tactic');
  if (mt.length) scores.push({ category: 'missed_tactic', score: 2 + Math.min(3, mt.length), reason: `${mt.length} winning tactic(s) missed` });
  const sd = of('strategic_decision');
  if (sd.length) scores.push({ category: 'strategic_decision', score: 3 + Math.min(3, Math.max(...sd.map((i) => i.cost)) / 100), reason: `a quiet decision turned the evaluation by ${(Math.max(...sd.map((i) => i.cost)) / 100).toFixed(1)}` });
  const cv = of('conversion');
  const cvTotal = cv.reduce((a, i) => a + i.cost, 0);
  if (cv.length >= 2 || cvTotal >= 300) scores.push({ category: 'conversion', score: 2 + Math.min(4, cv.length) + Math.min(2, cvTotal / 400), reason: `${cv.length} move(s) gave back a total of ${(cvTotal / 100).toFixed(1)} while winning` });
  const eg = of('endgame_technique');
  if (eg.length) scores.push({ category: 'endgame_technique', score: 1 + Math.min(2, eg.length * 0.5), reason: `${eg.length} only-move find(s) in the ending (a strength to reinforce)` });
  scores.sort((a, b) => b.score - a.score);
  if (!scores.length) return { priority: 'endgame_technique', scores, instances, openingKey: key, openingName: name };
  return { priority: scores[0].category, scores, instances, openingKey: key, openingName: name };
}

// --------------------------------------------------------------- drills ---

function graded(pos: PositionEval | undefined, fen: string): GradedMove[] {
  if (!pos) return [];
  return rankCandidates(pos).map((r) => ({ uci: r.uci, san: uciToSan(fen, r.uci) ?? r.uci, quality: r.quality }));
}

export interface DrillDraft extends Omit<TrainingDrill, 'prompt' | 'feedback' | 'explanation' | 'hint'> {
  /** What the drill is about, for the template text and the coach. */
  about: string;
}

/** A drill at the position before the student's move `ply` in `g`. */
function decisionDrill(g: StoredGame, s: Series, ply: number, format: DrillFormat, formats: DrillFormat[], source: TrainingDrill['source'], about: string): DrillDraft | undefined {
  const p = g.plies[ply - 1];
  const pos = s.positions[ply - 1];
  const options = graded(pos, p.fenBefore);
  if (!options.length) return undefined;
  const playedGrade = options.find((o) => o.uci === p.uci) ?? { uci: p.uci, san: p.san, quality: verdictOf(s.moves[ply - 1]) };
  const choice = [...options.slice(0, 3)];
  if (!choice.some((o) => o.uci === p.uci)) choice.push(playedGrade);
  return {
    id: `${g.id}:${ply}:${format}`,
    format,
    formats,
    source,
    gameId: g.id,
    gameLabel: gameLabel(g),
    ply,
    fen: p.fenBefore,
    orientation: g.userColor,
    toMove: p.color,
    graded: options,
    options: format === 'strategic_choice' || format === 'compare_plans' ? choice : undefined,
    facts: [`Stockfish: ${options[0].san} (${fmtEval(s.cp[ply - 1])} for ${g.userColor === p.color ? 'you' : 'them'}); in the game ${moveLabel(p)} → ${fmtEval(s.cp[ply])} for you.`],
    about,
  };
}

/** "What does the opponent do now?" at the position after the student's move `ply` (derived from the game, engine-confirmed). */
function threatDrill(g: StoredGame, s: Series, ply: number, about: string): DrillDraft | undefined {
  const p = g.plies[ply - 1];
  const pos = s.positions[ply];
  const options = graded(pos, p.fenAfter);
  if (!options.length || ply >= g.plies.length) return undefined;
  return {
    id: `${g.id}:${ply}:predict_threat`,
    format: 'predict_threat',
    formats: ['predict_threat'],
    source: 'derived',
    gameId: g.id,
    gameLabel: gameLabel(g),
    ply,
    fen: p.fenAfter,
    orientation: g.userColor,
    toMove: other(p.color),
    graded: options,
    facts: [`Stockfish's reply: ${options[0].san} (${fmtEval(s.cp[ply])} for you after ${moveLabel(p)}).`],
    about,
  };
}

/** Lessons and drills for the categories worth training: only as many positions as are useful. */
export type LessonDraft = Omit<TrainingLesson, 'drills'> & { drafts: DrillDraft[] };

export function buildLessons(game: StoredGame, all: StoredGame[], diag: Diagnosis): LessonDraft[] {
  const d = detect(game)!;
  const { s } = d;
  // The priority, plus at most one more lesson that is a real case on its own — no filler.
  const chosen = diag.scores.filter((x, i) => i === 0 || (x.score >= 5 && i < 2)).slice(0, 2);
  const others = all.filter((g) => g.id !== game.id && g.status === 'analyzed' && g.analysis);
  /** One related position from another game, with the same kind of problem. */
  const related = (category: TrainingCategory, pick: (i: Instance) => boolean = () => true) => {
    for (const g of [...others].sort((a, b) => b.importedAt - a.importedAt)) {
      const od = detect(g);
      const inst = od?.instances.filter((i) => i.category === category && pick(i)).sort((a, b) => b.cost - a.cost)[0];
      if (od && inst) return { g, s: od.s, inst };
    }
    return undefined;
  };
  const lessons: LessonDraft[] = [];
  const used = new Set<number>();

  for (const { category } of chosen) {
    const inst = diag.instances.filter((i) => i.category === category).sort((a, b) => b.cost - a.cost);
    const top = inst[0];
    if (!top) continue;
    const drafts: (DrillDraft | undefined)[] = [];
    let title = LABEL[category];
    let skill = '';
    switch (category) {
      case 'opening_development': {
        const err = top.signals.find((x) => x.kind === 'early_error')?.ply;
        title = `Opening development in the ${diag.openingName}`;
        skill = 'Finish developing (and know what each piece is guarding) before starting operations.';
        drafts.push({
          id: `${game.id}:opening`,
          format: 'opening_lesson',
          formats: ['opening_lesson'],
          source: 'this_game',
          gameId: game.id,
          gameLabel: gameLabel(game),
          ply: 1,
          fen: game.plies[0].fenBefore,
          orientation: game.userColor,
          toMove: 'w',
          graded: [],
          facts: top.signals.map((x) => x.text),
          about: `the ${diag.openingName}`,
        });
        if (err) {
          drafts.push(decisionDrill(game, s, err, 'strategic_choice', ['strategic_choice', 'compare_plans'], 'this_game', top.duty ? `which move keeps the ${top.duty.piece} guarding ${top.duty.square}` : 'which move keeps development safe'));
          if (top.duty) drafts.push(threatDrill(game, s, err, `what the opponent takes once the ${top.duty.piece} leaves ${top.duty.square}`));
        }
        const r = related('opening_development', (i) => !!i.lagging || !!i.duty);
        const rply = r?.inst.signals.find((x) => x.kind === 'early_error')?.ply ?? r?.inst.ply;
        if (r && rply) drafts.push(decisionDrill(r.g, r.s, rply, 'strategic_choice', ['strategic_choice', 'tactical_puzzle'], 'other_game', 'the same opening-development problem in another game'));
        break;
      }
      case 'blunder_check': {
        const t = inst.find((i) => !used.has(i.ply) && i.ply !== diag.instances.find((x) => x.category === 'opening_development')?.signals.find((y) => y.kind === 'early_error')?.ply);
        if (!t) break;
        skill = t.duty ? 'Before moving a piece, ask what it was guarding.' : 'Before letting go of a piece, check every capture and check your opponent gets.';
        drafts.push(decisionDrill(game, s, t.ply, 'tactical_puzzle', ['tactical_puzzle', 'strategic_choice'], 'this_game', 'a safe move here'));
        drafts.push(threatDrill(game, s, t.ply, "the opponent's punishing reply"));
        const r = related('blunder_check', (i) => !!t.duty === !!i.duty);
        if (r) drafts.push(decisionDrill(r.g, r.s, r.inst.ply, 'tactical_puzzle', ['tactical_puzzle'], 'other_game', 'the same kind of slip in another game'));
        break;
      }
      case 'missed_tactic': {
        skill = 'Check forcing moves — checks, captures, threats — for yourself every move.';
        inst.slice(0, 2).forEach((i) => drafts.push(decisionDrill(game, s, i.ply, 'tactical_puzzle', ['tactical_puzzle'], 'this_game', 'the winning tactic')));
        const r = related('missed_tactic');
        if (r) drafts.push(decisionDrill(r.g, r.s, r.inst.ply, 'tactical_puzzle', ['tactical_puzzle'], 'other_game', 'a tactic from another game'));
        break;
      }
      case 'strategic_decision': {
        skill = 'In a quiet position, improve pieces before forcing the play.';
        const sh = evaluationShifts(game, s).find((x) => x.fromPly <= top.ply && x.toPly >= top.ply);
        const dd = decisionDrill(game, s, top.ply, 'replay_sequence', ['replay_sequence', 'strategic_choice', 'compare_plans'], 'this_game', 'the decision and what it led to');
        if (dd) {
          dd.sequence = { fromPly: Math.max(1, (sh?.fromPly ?? top.ply) - 2), toPly: Math.min(game.plies.length, (sh?.toPly ?? top.ply) + 1), decisionPly: top.ply };
          // The play-through stops at the decision; offer the choice there.
          const p = game.plies[top.ply - 1];
          dd.options = [...dd.graded.slice(0, 3)];
          if (!dd.options.some((o) => o.uci === p.uci)) dd.options.push({ uci: p.uci, san: p.san, quality: verdictOf(s.moves[top.ply - 1]) });
        }
        drafts.push(dd);
        const r = related('strategic_decision');
        if (r) drafts.push(decisionDrill(r.g, r.s, r.inst.ply, 'strategic_choice', ['strategic_choice'], 'other_game', 'a similar decision in another game'));
        break;
      }
      case 'conversion': {
        skill = "When you're winning, choose the move that keeps it simple: trade, defend, and remove counterplay.";
        inst.slice(0, 2).forEach((i) => drafts.push(decisionDrill(game, s, i.ply, 'strategic_choice', ['strategic_choice', 'tactical_puzzle', 'compare_plans'], 'this_game', 'the clean winning move')));
        // The biggest slip usually let the opponent back in with a tactic: see it from their side.
        if (top.cost >= 200) drafts.push(threatDrill(game, s, top.ply, 'how the opponent got back into the game'));
        const r = related('conversion');
        if (r) drafts.push(decisionDrill(r.g, r.s, r.inst.ply, 'strategic_choice', ['strategic_choice'], 'other_game', 'converting in another game'));
        break;
      }
      case 'endgame_technique': {
        skill = 'In worse endings, look for the active move that only works now.';
        inst.slice(0, 2).forEach((i) => drafts.push(decisionDrill(game, s, i.ply, 'why_good', ['why_good', 'endgame_technique'], 'this_game', 'the only move that held')));
        break;
      }
    }
    const kept = drafts.filter((x): x is DrillDraft => !!x && (x.format === 'opening_lesson' || x.graded.length > 0));
    // No filler: drop duplicates of the same position.
    const seen = new Set<string>();
    const unique = kept.filter((x) => !seen.has(`${x.fen}|${x.format}`) && seen.add(`${x.fen}|${x.format}`));
    unique.forEach((x) => x.gameId === game.id && used.add(x.ply));
    if (unique.length) lessons.push({ id: `${game.id}:${category}`, category, title, skill, why: diag.scores.find((x) => x.category === category)!.reason, signals: inst.flatMap((i) => i.signals).slice(0, 5), drafts: unique });
  }
  return lessons;
}

export { COLOR_NAME };
