// Compare where two lines lead, in practical chess terms. Each line is played a
// few moves forward and the resulting positions are compared on concrete,
// checkable features (material, king safety, activity, pawns, files, loose
// pieces, queen trades). A feature is only mentioned when the difference is
// clear and still holds at the end of the shown lines; the lines are cut at the
// shortest length that shows it. If nothing clear shows up, we say so.
import { Chess } from 'chess.js';
import type { Color, PieceType, SequenceFrame } from '../domain/types';
import {
  COLOR_NAME,
  PIECE_NAME,
  checksAvailable,
  fileStatus,
  hasQueen,
  isLoose,
  kingZoneAttacks,
  materialBalance,
  materialPhrase,
  mobility,
  other,
  passTurn,
  passedPawns,
  pawnWeaknesses,
  playLine,
  relativeRank,
  undevelopedMinors,
} from '../chess/board';
import { MATE_CP } from './evaluation';
import { EQUAL_BAND, gapBetween } from './moveQuality';
import { BAND_LABEL, bandOf } from './evalBand';
import { lineToPoint, type LinePoint } from './linePoint';

const lineSans = (fs: SequenceFrame[]) => fs.map((f) => f.san).join(' ');

export interface CompareInput {
  /** Position before the decision. */
  fen: string;
  /** Side making the decision (the player whose move is being reviewed). */
  mover: Color;
  /** The better line: first move plus the engine's continuation. */
  preferred: { ucis: string[]; cp: number };
  /** The other line: the game move (or the player's try) plus what followed. */
  other: { ucis: string[]; cp: number };
  /** Longest stretch we'll show (plies). */
  maxPlies?: number;
}

export interface Reason {
  key: string;
  /** Clause about the preferred line, e.g. "creates a passed pawn on d3". */
  forPreferred?: string;
  /** Clause about the other line, e.g. "White gets checks against your king". */
  forOther?: string;
  /** Which line the feature favours. */
  favors: 'preferred' | 'other';
}

export interface CardRow {
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

export interface LineComparison {
  /** Short side-by-side facts for each line (only rows that differ, plus evaluation). */
  card: { preferred: CardRow[]; other: CardRow[] };
  /** Where each line makes its point. */
  points: { preferred: LinePoint; other: LinePoint };
  preferredSan: string;
  otherSan: string;
  /** Frames actually worth showing — the shortest stretch that demonstrates the difference. */
  preferredFrames: SequenceFrame[];
  otherFrames: SequenceFrame[];
  reasons: Reason[];
  /** Whether at least one clear, stable feature explains the difference. */
  clear: boolean;
  summary: string;
  /** One clause on why the preferred move is better ("it leaves you a pawn better off"), when clear. */
  why?: string;
}

interface Snap {
  material: number;
  ourKingHeat: number;
  oppKingHeat: number;
  oppChecks: number;
  undeveloped: number;
  ourMob: number;
  oppMob: number;
  oppQueenMob: number;
  ourWeak: string[];
  oppWeak: string[];
  ourPassed: string[];
  oppPassed: string[];
  ourRooksOpen: number;
  /** Pieces that can be taken next move (the side to move can capture them). */
  ourHanging: { square: string; type: PieceType }[];
  oppHanging: { square: string; type: PieceType }[];
  queensOn: boolean;
  /** Piece counts by type, for "you give up your queen for a knight". */
  ours: Record<PieceType, number>;
  theirs: Record<PieceType, number>;
}

const count = (list: { type: PieceType }[]) => {
  const c: Record<PieceType, number> = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
  for (const p of list) c[p.type]++;
  return c;
};

function pieces(fen: string, color: Color) {
  const c = new Chess(fen);
  const out: { square: string; type: PieceType }[] = [];
  for (const row of c.board()) for (const p of row) if (p && p.color === color) out.push({ square: p.square, type: p.type as PieceType });
  return out;
}

function pieceSquares(fen: string, color: Color, type: PieceType): string[] {
  return pieces(fen, color).filter((p) => p.type === type).map((p) => p.square);
}

function hanging(fen: string, color: Color) {
  // Only pieces the opponent could actually take now, i.e. when it's their move.
  const turn = fen.split(' ')[1] as Color;
  if (turn === color) return [];
  return pieces(fen, color).filter((p) => p.type !== 'k' && p.type !== 'p' && isLoose(fen, p.square));
}

function snapshot(fen: string, us: Color): Snap {
  const them = other(us);
  const mine = pieces(fen, us);
  const theirs = pieces(fen, them);
  const mob = (list: typeof mine) => list.filter((p) => p.type !== 'p' && p.type !== 'k').reduce((n, p) => n + mobility(fen, p.square), 0);
  const turn = fen.split(' ')[1] as Color;
  const asThem = turn === them ? fen : passTurn(fen);
  const weak = (c: Color) => {
    const w = pawnWeaknesses(fen, c);
    return [...new Set([...w.doubled, ...w.isolated])];
  };
  const rooksOpen = mine.filter((p) => p.type === 'r' && fileStatus(fen, p.square[0], us) !== 'closed').length;
  const q = theirs.find((p) => p.type === 'q');
  return {
    material: materialBalance(fen, us),
    ourKingHeat: kingZoneAttacks(fen, us),
    oppKingHeat: kingZoneAttacks(fen, them),
    oppChecks: asThem ? checksAvailable(asThem) : 0,
    undeveloped: undevelopedMinors(fen, us).length,
    ourMob: mob(mine),
    oppMob: mob(theirs),
    oppQueenMob: q ? mobility(fen, q.square) : 0,
    ourWeak: weak(us),
    oppWeak: weak(them),
    ourPassed: passedPawns(fen, us),
    oppPassed: passedPawns(fen, them),
    ourRooksOpen: rooksOpen,
    ourHanging: hanging(fen, us),
    oppHanging: hanging(fen, them),
    queensOn: hasQueen(fen, 'w') && hasQueen(fen, 'b'),
    ours: count(mine),
    theirs: count(theirs),
  };
}

type Counts = Record<PieceType, number>;
const TYPES: PieceType[] = ['q', 'r', 'b', 'n', 'p'];

/** What each side lost over a line, with like-for-like trades cancelled (a knight for a knight is no loss). */
function netLosses(start: Snap, end: Snap): { ours: Counts; theirs: Counts } {
  const ours = {} as Counts;
  const theirs = {} as Counts;
  for (const t of [...TYPES, 'k'] as PieceType[]) {
    const lo = Math.max(0, start.ours[t] - end.ours[t]);
    const lt = Math.max(0, start.theirs[t] - end.theirs[t]);
    const m = Math.min(lo, lt);
    ours[t] = lo - m;
    theirs[t] = lt - m;
  }
  // A bishop for a knight is an even trade too.
  for (const [x, y] of [['b', 'n'], ['n', 'b']] as [PieceType, PieceType][]) {
    const m = Math.min(ours[x], theirs[y]);
    ours[x] -= m;
    theirs[y] -= m;
  }
  return { ours, theirs };
}

/** "queen", "bishop and a pawn": the positive part of a - b. */
function describe(a: Counts, b: Counts): string[] {
  const out: string[] = [];
  for (const t of TYPES) {
    const n = a[t] - b[t];
    if (n <= 0) continue;
    if (t === 'p') out.push(n === 1 ? 'pawn' : `${n} pawns`);
    else for (let i = 0; i < n; i++) out.push(PIECE_NAME[t]);
  }
  return out;
}

const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
/** "knight" → "a knight", "2 pawns" stays. */
const a11 = (s: string) => (/^\d/.test(s) ? s : `a${/^[aeiou]/.test(s) ? 'n' : ''} ${s}`);

/** Feature differences between the end of the preferred line (a) and the other line (b). */
interface DiffCtx {
  us: Color;
  opening: boolean;
  ahead: boolean;
  prefSan: string;
  otherSan: string;
  /** Centipawn gap between the lines (preferred minus other, mover's view). */
  cpGap: number;
  /** Squares of our pawns at the end of the preferred line. */
  ourPawnsA: string[];
  /** The starting position, for counting what each line gives up. */
  start: Snap;
  /** Exact "what changed" wording for the other line's material, when compared at its point. */
  materialTextOther?: string;
  /** The next move in each line after the compared position, if any (to confirm a piece really falls). */
  nextA?: SequenceFrame;
  nextB?: SequenceFrame;
}

function diffs(a: Snap, b: Snap, ctx: DiffCtx): Reason[] {
  const opp = COLOR_NAME[other(ctx.us)];
  const out: Reason[] = [];
  const dm = a.material - b.material;
  // Material only counts when the evaluation agrees; otherwise it's a sacrifice with compensation.
  if (Math.abs(dm) >= 1 && Math.sign(ctx.cpGap) === Math.sign(dm) && Math.abs(ctx.cpGap) >= 40 * Math.abs(dm)) {
    if (dm > 0) {
      const la = netLosses(ctx.start, a);
      const lb = netLosses(ctx.start, b);
      const gave = describe(lb.ours, la.ours);
      const got = describe(lb.theirs, la.theirs);
      const onlyPawns = gave.every((g) => /pawn/.test(g)) && got.every((g) => /pawn/.test(g));
      out.push(
        ctx.materialTextOther && /wins your/.test(ctx.materialTextOther)
          ? { key: 'material', favors: 'preferred', forOther: ctx.materialTextOther }
          : gave.length && !onlyPawns
          ? { key: 'material', favors: 'preferred', forOther: `you give up your ${joinAnd(gave)}${got.length ? ` for ${a11(joinAnd(got))}` : ''}` }
          : { key: 'material', favors: 'preferred', forPreferred: `leaves you ${materialPhrase(dm)} better off`, forOther: `you're ${materialPhrase(dm)} worse off` },
      );
    } else {
      out.push({ key: 'material', favors: 'other', forOther: `you're ${materialPhrase(-dm)} better off` });
    }
  }
  const newPassed = a.ourPassed.filter((s) => !b.ourPassed.includes(s));
  const lostPassed = b.ourPassed.filter((s) => !a.ourPassed.includes(s));
  if (newPassed.length > lostPassed.length) {
    const best = [...newPassed].sort((x, y) => relativeRank(y, ctx.us) - relativeRank(x, ctx.us))[0];
    out.push({ key: 'our_passed', favors: 'preferred', forPreferred: `gives you a passed pawn on ${best}` });
  }
  const oppNew = b.oppPassed.filter((s) => !a.oppPassed.includes(s));
  if (oppNew.length && oppNew.length > a.oppPassed.filter((s) => !b.oppPassed.includes(s)).length) {
    out.push({ key: 'opp_passed', favors: 'preferred', forOther: `${opp} gets a passed pawn on ${oppNew[0]}` });
  }
  if (b.oppChecks - a.oppChecks >= 2 || b.ourKingHeat - a.ourKingHeat >= 3) {
    out.push({
      key: 'our_king',
      favors: 'preferred',
      forPreferred: 'keeps your king safer',
      forOther: b.oppChecks - a.oppChecks >= 2 ? `${opp} gets checks against your king` : `${opp}'s pieces get closer to your king`,
    });
  } else if (a.oppChecks - b.oppChecks >= 2 || a.ourKingHeat - b.ourKingHeat >= 3) {
    out.push({ key: 'our_king', favors: 'other', forOther: 'your king is a bit safer', forPreferred: `lets ${opp} get closer to your king` });
  }
  if (a.oppKingHeat - b.oppKingHeat >= 3) out.push({ key: 'opp_king', favors: 'preferred', forPreferred: `keeps more pressure on ${opp}'s king` });
  else if (b.oppKingHeat - a.oppKingHeat >= 3) out.push({ key: 'opp_king', favors: 'other', forOther: `you keep more pressure on ${opp}'s king` });
  const big = (x: number, y: number) => x - y >= Math.max(7, Math.round(0.25 * Math.max(x, y)));
  if (b.oppQueenMob - a.oppQueenMob >= 5) out.push({ key: 'opp_queen', favors: 'preferred', forPreferred: `takes squares away from ${opp}'s queen`, forOther: `${opp}'s queen gets more room` });
  else if (big(b.oppMob, a.oppMob)) out.push({ key: 'opp_activity', favors: 'preferred', forPreferred: `restricts ${opp}'s pieces`, forOther: `${opp}'s pieces get more freedom` });
  else if (big(a.oppMob, b.oppMob)) out.push({ key: 'opp_activity', favors: 'other', forOther: `${opp}'s pieces have fewer squares` });
  if (big(a.ourMob, b.ourMob)) out.push({ key: 'our_activity', favors: 'preferred', forPreferred: 'makes your pieces more active', forOther: 'your pieces are more passive' });
  else if (big(b.ourMob, a.ourMob)) out.push({ key: 'our_activity', favors: 'other', forOther: 'your pieces are more active' });
  if (ctx.opening && b.undeveloped - a.undeveloped >= 1) out.push({ key: 'development', favors: 'preferred', forPreferred: 'gets another piece developed', forOther: 'you are a piece behind in development' });
  // Only pawns that are still there in both lines; a pawn captured in one line isn't "weak" in the other.
  const newWeak = b.ourWeak.filter((s) => !a.ourWeak.includes(s) && ctx.ourPawnsA.includes(s));
  if (newWeak.length && newWeak.length > a.ourWeak.filter((s) => !b.ourWeak.includes(s)).length)
    out.push({ key: 'our_structure', favors: 'preferred', forOther: `you're left with a weak pawn on ${newWeak[0]}` });
  const oppDoubledA = a.oppWeak.filter((s) => !b.oppWeak.includes(s));
  if (oppDoubledA.length >= 2 && oppDoubledA.every((s) => s[0] === oppDoubledA[0][0]))
    out.push({ key: 'opp_structure', favors: 'preferred', forPreferred: `leaves ${opp} with doubled pawns on the ${oppDoubledA[0][0]}-file` });
  if (a.ourRooksOpen > b.ourRooksOpen) out.push({ key: 'files', favors: 'preferred', forPreferred: 'gets a rook onto an open file' });
  // A piece only "hangs" if the line's next move actually takes it.
  const hangA = a.oppHanging.find((h) => ctx.nextA?.to === h.square);
  if (hangA && !b.oppHanging.some((h) => h.square === hangA.square))
    out.push({ key: 'opp_hanging', favors: 'preferred', forPreferred: `wins ${opp}'s ${PIECE_NAME[hangA.type]} on ${hangA.square}` });
  const hangB = b.ourHanging.find((h) => ctx.nextB?.to === h.square);
  if (hangB && !a.ourHanging.some((h) => h.square === hangB.square))
    out.push({ key: 'our_hanging', favors: 'preferred', forOther: `your ${PIECE_NAME[hangB.type]} on ${hangB.square} is lost` });
  const traded = (x: Snap) => x.ours.q === 0 && x.theirs.q === 0;
  if (a.queensOn !== b.queensOn && (traded(a) || traded(b)) && (a.queensOn || b.queensOn)) {
    // Trading queens is good when you're ahead, and usually not when you need play.
    const tradeIn = a.queensOn ? 'other' : 'preferred';
    const good = ctx.ahead ? tradeIn : tradeIn === 'preferred' ? 'other' : 'preferred';
    out.push({
      key: 'queens',
      favors: good,
      forPreferred: tradeIn === 'preferred' ? `trades queens${ctx.ahead ? ', which makes your lead easier to use' : ''}` : 'keeps the queens on',
      forOther: tradeIn === 'other' ? 'the queens come off' : ctx.ahead ? `the queens stay on, which keeps ${opp}'s counterplay alive` : 'the queens stay on',
    });
  }
  return out;
}

/** Cut a line after `k` plies, but don't stop in the middle of an exchange. */
function settle(frames: SequenceFrame[], k: number): number {
  let n = Math.min(k, frames.length);
  while (n < frames.length && n > 0 && frames[n - 1].san.includes('x') && frames[n].to === frames[n - 1].to && frames[n].san.includes('x')) n++;
  return n;
}

function bucket(cp: number): string {
  return BAND_LABEL[bandOf(cp)].toLowerCase();
}

function evalSentence(prefSan: string, otherSan: string, prefCp: number, otherCp: number): { text: string; same: boolean } {
  const a = bucket(prefCp);
  const b = bucket(otherCp);
  const state = (s: string) => (s === 'equal' ? 'the position stays balanced' : `you're ${s}`);
  if (a === b) return { text: a === 'equal' ? `Both ${prefSan} and ${otherSan} keep the position balanced` : `Both ${prefSan} and ${otherSan} keep you ${a}`, same: true };
  return { text: `After ${prefSan} ${state(a)}; after ${otherSan} ${state(b)}`, same: false };
}

function compareCore(input: CompareInput, cuts?: { a: number; b: number; materialTextOther?: string }): Omit<LineComparison, 'card' | 'points'> | undefined {
  const { fen, mover } = input;
  const maxPlies = Math.max(input.maxPlies ?? 8, cuts?.a ?? 0, cuts?.b ?? 0);
  const prefFrames = playLine(fen, input.preferred.ucis, maxPlies);
  const otherFrames = playLine(fen, input.other.ucis, maxPlies);
  if (!prefFrames.length || !otherFrames.length) return undefined;
  const prefSan = prefFrames[0].san;
  const otherSan = otherFrames[0].san;
  const opening = Number(fen.split(' ')[5] ?? '1') <= 15;
  const ahead = input.preferred.cp >= 150;
  const start = snapshot(fen, mover);
  const base = { us: mover, opening, ahead, prefSan, otherSan, cpGap: input.preferred.cp - input.other.cp, start };
  const at = (frames: SequenceFrame[], n: number) => (n === 0 ? fen : frames[n - 1].fen);
  const ourPawns = (f: string) => pieceSquares(f, mover, 'p');
  const cmp = (na: number, nb: number, materialTextOther?: string) =>
    diffs(snapshot(at(prefFrames, na), mover), snapshot(at(otherFrames, nb), mover), {
      ...base,
      nextA: prefFrames[na],
      nextB: otherFrames[nb],
      ourPawnsA: ourPawns(at(prefFrames, na)),
      materialTextOther,
    });

  // A forced mate needs no positional explanation.
  const mateIn = (cp: number) => (cp >= MATE_CP - 1000 ? Math.max(1, Math.round((MATE_CP - cp) / 10)) : 0);
  const mA = mateIn(input.preferred.cp) <= 5 ? mateIn(input.preferred.cp) : 0;
  if (mA && !mateIn(input.other.cp)) {
    const ev = evalSentence(prefSan, otherSan, input.preferred.cp, input.other.cp);
    const after = ev.text.split('; ')[1] ?? `after ${otherSan} the game goes on`;
    const mateLine = prefFrames.slice(0, Math.min(prefFrames.length, mA * 2 - 1));
    return {
      preferredSan: prefSan,
      otherSan,
      preferredFrames: mateLine,
      otherFrames: otherFrames.slice(0, 2),
      reasons: [{ key: 'mate', favors: 'preferred', forPreferred: mA === 1 ? 'is checkmate' : `forces checkmate in ${mA}` }],
      clear: true,
      summary: `${prefSan} ${mA === 1 ? 'is checkmate on the spot' : `forces checkmate in ${mA} (${lineSans(mateLine)})`}; ${after.replace(/^after/, 'after')}. Checks first — mate beats any material.`,
    };
  }

  // Feature differences at the end of everything we'd show: the reference for stability.
  const endA = settle(prefFrames, maxPlies);
  const endB = settle(otherFrames, maxPlies);
  const final = cmp(endA, endB);
  const stable = (r: Reason) => final.some((f) => f.key === r.key && f.favors === r.favors);
  const evalPrefers = input.preferred.cp >= input.other.cp;

  // Shortest stretch (after the reply, so the position has settled) that shows a clear reason.
  let chosen: { a: number; b: number; reasons: Reason[] } | undefined;
  // First choice: where each line makes its point (material settles, mate, queens off…).
  if (cuts) {
    const a = settle(prefFrames, cuts.a);
    const b = settle(otherFrames, cuts.b);
    const rs = cmp(a, b, b === cuts.b ? cuts.materialTextOther : undefined).filter(stable);
    if (rs.some((r) => r.favors === (evalPrefers ? 'preferred' : 'other'))) chosen = { a, b, reasons: rs };
  }
  for (const k of [2, 4, 6, 8].filter((x) => x <= maxPlies && !chosen)) {
    const a = settle(prefFrames, k);
    const b = settle(otherFrames, k);
    const rs = cmp(a, b).filter(stable);
    if (rs.some((r) => r.favors === (evalPrefers ? 'preferred' : 'other'))) {
      chosen = { a, b, reasons: rs };
      break;
    }
    if (a >= prefFrames.length && b >= otherFrames.length) break;
  }

  // Within the "equally good" band the evaluations are noise: describe both the same way.
  const gap = gapBetween(input.preferred.cp, input.other.cp);
  const ev = evalSentence(prefSan, otherSan, input.preferred.cp, gap < EQUAL_BAND ? input.preferred.cp : input.other.cp);
  if (!chosen && gap < 6) {
    const n = Math.min(4, prefFrames.length);
    const summary =
      gap < EQUAL_BAND
        ? `${otherSan} is as good as ${prefSan} — ${ev.text.replace(/^Both [^ ]+ and [^ ]+ /, 'both ')}. Pick the one whose plan you understand.`
        : `${ev.text}. ${prefSan} is a little more precise, but the difference doesn't show up in anything concrete within a few moves — both are fine.`;
    return { preferredSan: prefSan, otherSan, preferredFrames: prefFrames.slice(0, n), otherFrames: otherFrames.slice(0, Math.min(4, otherFrames.length)), reasons: [], clear: false, summary };
  }
  if (!chosen) {
    const n = Math.min(4, prefFrames.length);
    const summary = ev.same
      ? `${ev.text}. The difference doesn't show up in anything concrete — material, king safety, activity or pawns — within a few moves, so treat it as a small detail.`
      : `${ev.text}. The reason isn't visible in simple features (material, king safety, activity, pawns) within a few moves — Stockfish sees it deeper, so take the evaluation on trust here.`;
    return { preferredSan: prefSan, otherSan, preferredFrames: prefFrames.slice(0, n), otherFrames: otherFrames.slice(0, Math.min(4, otherFrames.length)), reasons: [], clear: false, summary };
  }

  const pro = chosen.reasons.filter((r) => r.favors === 'preferred');
  const con = chosen.reasons.filter((r) => r.favors === 'other');
  const aClauses = pro.filter((r) => r.forPreferred).slice(0, 2).map((r) => r.forPreferred!);
  const bClause = pro.find((r) => r.forOther && !aClauses.includes(r.forPreferred ?? ''))?.forOther;
  void con;
  // Stockfish's line deliberately gives up material: say so, it's part of the lesson.
  const endSnapA = snapshot(at(prefFrames, chosen.a), mover);
  const endSnapB = snapshot(at(otherFrames, chosen.b), mover);
  let sacrifice: string | undefined;
  const finalA = snapshot(at(prefFrames, endA), mover);
  const finalB = snapshot(at(otherFrames, endB), mover);
  if (endSnapB.material - endSnapA.material >= 2 && finalB.material - finalA.material >= 2 && input.preferred.cp > input.other.cp) {
    const la = netLosses(start, endSnapA);
    const lb = netLosses(start, endSnapB);
    const gave = describe(la.ours, lb.ours);
    if (gave.length) sacrifice = `${prefSan} gives up ${a11(joinAnd(gave))} on purpose — and it's worth it.`;
  }

  let summary = ev.text;
  const parts: string[] = [];
  if (aClauses.length) parts.push(`${prefSan} ${joinAnd(aClauses)}`);
  if (bClause) parts.push(`after ${otherSan} ${bClause}`);
  summary += ev.same ? `, but ${parts.join(', while ')}.` : `: ${parts.join(', while ')}.`;
  if (sacrifice) summary += ` ${sacrifice}`;
  return {
    preferredSan: prefSan,
    otherSan,
    preferredFrames: prefFrames.slice(0, chosen.a),
    otherFrames: otherFrames.slice(0, chosen.b),
    reasons: chosen.reasons,
    clear: true,
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
    why: aClauses.length ? `it ${aClauses[0]}` : bClause ? `after ${otherSan} ${bClause}` : undefined,
  };
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function pointRow(p: LinePoint): CardRow | undefined {
  if (p.kind === 'quiet') return undefined;
  const bad = /^(White|Black) (wins|mates|promotes|gets)/.test(p.text);
  const good = /^(you|[A-Z][a-z]+\d?[+#]? is checkmate)/.test(p.text) || /is checkmate$/.test(p.text);
  return { text: cap(p.text), tone: bad ? 'bad' : good ? 'good' : 'neutral' };
}

/**
 * Compare two lines from the same position. Each line is first walked to the point
 * where it shows something (linePoint); the comparison is made there when that's
 * enough to explain the difference, otherwise at the shortest stretch that does.
 */
export function compareLines(input: CompareInput): LineComparison | undefined {
  const max = input.maxPlies ?? 10;
  const pa = lineToPoint(input.fen, input.preferred.ucis, input.mover, max);
  const pb = lineToPoint(input.fen, input.other.ucis, input.mover, max);
  const core = compareCore({ ...input, maxPlies: Math.max(8, input.maxPlies ?? 8) }, { a: pa.frames.length, b: pb.frames.length, materialTextOther: pb.kind === 'material' ? pb.text : undefined });
  if (!core) return undefined;
  // Show each line up to its point when it has one; otherwise what the comparison needed.
  const preferredFrames = pa.kind !== 'quiet' && pa.frames.length >= core.preferredFrames.length ? pa.frames : core.preferredFrames;
  const otherFrames = pb.kind !== 'quiet' && pb.frames.length >= core.otherFrames.length ? pb.frames : core.otherFrames;
  const gap = gapBetween(input.preferred.cp, input.other.cp);
  const otherCp = gap < EQUAL_BAND ? input.preferred.cp : input.other.cp;
  const evalRow = (cp: number): CardRow => ({ text: BAND_LABEL[bandOf(cp)], tone: 'neutral' });
  const pref: CardRow[] = [evalRow(input.preferred.cp)];
  const oth: CardRow[] = [evalRow(otherCp)];
  const pr = pointRow(pa);
  const or = pointRow(pb);
  if (pr && !(or && or.text === pr.text)) pref.push(pr);
  if (or && !(pr && or.text === pr.text)) oth.push(or);
  for (const r of core.reasons) {
    if (r.key === 'material' && (pr || or)) continue; // the point rows already say it
    if (r.favors === 'preferred') {
      if (r.forPreferred) pref.push({ text: cap(r.forPreferred), tone: 'good' });
      if (r.forOther) oth.push({ text: cap(r.forOther), tone: 'bad' });
    } else if (r.forOther) oth.push({ text: cap(r.forOther), tone: 'good' });
  }
  return { ...core, preferredFrames, otherFrames, points: { preferred: pa, other: pb }, card: { preferred: pref.slice(0, 4), other: oth.slice(0, 4) } };
}
