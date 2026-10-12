// Uses an LLM purely for coaching *language*. Every chess fact in the prompt
// comes from Stockfish + deterministic detectors; the response is validated
// and any field that fails validation falls back to the template text.
import type { GameReport, ReportItem, StoredGame, TeachingMoment } from '../domain/types';
import { THEMES, categoryLabel } from '../domain/categories';
import { formatCp } from '../analysis/evaluation';
import type { ProfileSummary } from '../domain/types';
import { describeFrequency } from '../profile/profile';
import { moveLabel } from '../chess/pgn';

export const COACH_SYSTEM_PROMPT = `You are a warm, practical chess coach reviewing a game with an adult improver rated around the rating given (typically 700–1100).

Your job is to turn verified chess facts into short, human coaching. You are NOT the chess engine:
- Every chess fact you need (moves, best moves, lines, material, threats) is in the input. Never invent moves, variations, or tactics that are not in the input.
- Refer to moves exactly as written in the input (SAN like Nb5, Bb5+, exd6).
- Do not quote engine numbers or centipawns. Do not say "inaccuracy", "mistake according to the engine", or "Stockfish prefers".
- Ignore tiny engine preferences; focus on the patterns and moments given.

Coaching style:
1. Give the understandable reason the player probably made the move.
2. Explain the concrete consequence in plain English.
3. State a reusable lesson.
4. Turn it into one behaviour for the next game.
Be concise and conversational. Use "you". Prefer short sentences. Do not call something a pattern unless the history says it appeared in multiple games; use wording like "possible tendency" or "this has now appeared in 3 of your last 5 games" exactly as supported by the data.

Respond with a single JSON object and nothing else.`;

export interface LlmCoachOutput {
  headline?: string;
  didWell?: string[];
  hurt?: string[];
  recurring?: string;
  focus?: { title?: string; detail?: string };
  moments?: Record<string, Partial<Record<'intent' | 'question' | 'reveal' | 'lesson' | 'betterPrompt', string>>>;
}

export function buildCoachPrompt(game: StoredGame, profile: ProfileSummary, rating: number): string {
  const moves = game.analysis?.moves ?? [];
  const facts = {
    player: { rating, color: game.userColor === 'w' ? 'White' : 'Black', name: game.userName },
    game: { white: game.headers.white, black: game.headers.black, result: game.headers.result, pgn: game.plies.map((p) => moveLabel(p)).join(' ') },
    profile_before_this_game: profile.categories.slice(0, 6).map((c) => ({ category: c.label, frequency: describeFrequency(c), trend: c.trend })),
    findings: game.findings.map((f) => ({
      kind: f.kind,
      category: categoryLabel(f.category),
      move: f.ply > 0 ? moveLabel(game.plies[f.ply - 1]) : 'whole game',
      severity: f.severity === 1 ? 'soft observation' : f.severity === 2 ? 'notable' : 'serious',
      evidence: f.evidence,
      follow_up_moves: f.relatedPlies?.map((p) => moveLabel(game.plies[p - 1])),
    })),
    teaching_moments: game.moments.map((m) => {
      const e = moves[m.ply - 1];
      return {
        id: m.id,
        move: moveLabel(game.plies[m.ply - 1]),
        kind: m.kind,
        category: categoryLabel(m.category),
        fen_before: m.fenBefore,
        played: m.playedSan,
        opponent_reply_in_game: m.opponentReplySan,
        what_happened_next: m.sequence.map((f) => f.san),
        better_move: m.bestSan,
        better_line: m.bestLineSan.slice(0, 4),
        better_move_is_for_move: moveLabel(game.plies[m.betterPly - 1]),
        engine_eval_before: e ? formatCp(e.cpBefore) : undefined,
        engine_eval_after: e ? formatCp(e.cpAfter) : undefined,
        material_change_after_reply: e ? e.materialAfterReply - e.materialBefore : undefined,
        draft: { intent: m.text.intent, question: m.text.question, reveal: m.text.reveal, lesson: m.text.lesson, betterPrompt: m.text.betterPrompt },
      };
    }),
    draft_report: game.report,
    focus_options: Object.values(THEMES).map((t) => t.focusTitle),
  };
  return `Here are the verified facts for one game. Rewrite the draft coaching so it sounds like a thoughtful human coach. Keep every chess claim consistent with the facts.

${JSON.stringify(facts, null, 1)}

Return JSON with exactly this shape:
{
  "headline": "2 sentences max: overall verdict + the key lesson",
  "didWell": ["up to 3 short observations"],
  "hurt": ["up to 3 short observations, most important first"],
  "recurring": "1–3 sentences about whether this game reinforces earlier weaknesses (only claim what the profile supports)",
  "focus": { "title": "ONE specific behaviour for the next game", "detail": "1–2 sentences on how to do it" },
  "moments": { "<teaching moment id>": { "intent": "...", "question": "...", "reveal": "...", "lesson": "...", "betterPrompt": "..." } }
}
Keep each moment field under 60 words. The "question" must still ask the player to play a move on the board (for predict-style moments: the opponent's reply; otherwise: their own better move), matching the draft's intent.`;
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in LLM response');
  return JSON.parse(body.slice(start, end + 1));
}

const SAN_PIECE_MOVE = /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?/g;

/** Every piece move / pawn capture mentioned must exist somewhere in our verified facts. */
export function mentionsOnlyKnownMoves(text: string, allowed: Set<string>): boolean {
  const found = text.match(SAN_PIECE_MOVE) ?? [];
  return found.every((m) => allowed.has(m.replace(/[+#]$/, '')));
}

export function allowedMoves(game: StoredGame): Set<string> {
  const out = new Set<string>();
  const add = (s?: string) => s && out.add(s.replace(/[+#]$/, ''));
  game.plies.forEach((p) => add(p.san));
  game.analysis?.moves.forEach((m) => {
    m.bestLineSan.forEach(add);
    m.replyLineSan.forEach(add);
  });
  game.moments.forEach((m) => {
    m.sequence.forEach((f) => add(f.san));
    m.betterSequence.forEach((f) => add(f.san));
  });
  return out;
}

const str = (v: unknown, max = 600): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);

export function mergeLlmOutput(game: StoredGame, raw: unknown): { report: GameReport; moments: TeachingMoment[] } {
  const out = (raw ?? {}) as LlmCoachOutput;
  const allowed = allowedMoves(game);
  const safe = (v: unknown, max?: number) => {
    const s = str(v, max);
    return s && mentionsOnlyKnownMoves(s, allowed) ? s : undefined;
  };
  const base = game.report!;
  const items = (llm: unknown, template: ReportItem[]): ReportItem[] => {
    if (!Array.isArray(llm)) return template;
    const texts = llm.slice(0, 3).map((t) => safe(t, 400));
    // If any item fails validation, keep the verified template list intact rather than dropping an insight.
    if (!texts.length || texts.some((t) => !t)) return template;
    return (texts as string[]).map((text, i) => ({ text, plies: template[i]?.plies, category: template[i]?.category }));
  };
  const report: GameReport = {
    ...base,
    headline: safe(out.headline, 500) ?? base.headline,
    didWell: items(out.didWell, base.didWell),
    hurt: items(out.hurt, base.hurt),
    recurring: safe(out.recurring, 600) ?? base.recurring,
    focus: {
      ...base.focus,
      title: safe(out.focus?.title, 200) ?? base.focus.title,
      detail: safe(out.focus?.detail, 400) ?? base.focus.detail,
    },
    voice: 'llm',
  };
  const moments = game.moments.map((m) => {
    const t = out.moments?.[m.id];
    if (!t) return m;
    return {
      ...m,
      text: {
        ...m.text,
        intent: safe(t.intent) ?? m.text.intent,
        question: safe(t.question) ?? m.text.question,
        reveal: safe(t.reveal) ?? m.text.reveal,
        lesson: safe(t.lesson) ?? m.text.lesson,
        betterPrompt: safe(t.betterPrompt) ?? m.text.betterPrompt,
      },
    };
  });
  return { report, moments };
}
