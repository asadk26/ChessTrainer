// Markdown view of a training plan (for the command line and for reviewing the experiment).
import type { StoredGame, TrainingPlan } from '../domain/types';
import { moveLabel } from '../chess/pgn';
import { CATEGORY_LABEL } from './diagnosis';

export function trainingMarkdown(t: TrainingPlan, game: StoredGame, gameOf: (id: string) => StoredGame | undefined): string {
  const at = (id: string, ply: number) => {
    const g = gameOf(id) ?? game;
    return g.plies[ply - 1] ? moveLabel(g.plies[ply - 1]) : `ply ${ply}`;
  };
  const L: string[] = [];
  L.push(`# Training: ${game.headers.white} vs ${game.headers.black}`, '');
  L.push(`**Priority: ${CATEGORY_LABEL[t.priority.category]}**`, '', t.priority.title, '', t.priority.why, '');
  L.push('Evidence (Stockfish and the board):', ...t.priority.signals.map((s) => `- ${s.text}`), '');
  L.push('Considered:', ...t.considered.map((c) => `- ${CATEGORY_LABEL[c.category]}: score ${c.score} — ${c.reason}`), '');
  for (const l of t.lessons) {
    L.push(`## Lesson: ${l.title}`, '', `*Habit:* ${l.skill}`, '');
    l.drills.forEach((d, i) => {
      const where = d.format === 'opening_lesson' ? 'the opening' : `${d.format === 'predict_threat' ? 'after' : 'before'} ${at(d.gameId, d.ply)}`;
      L.push(`### ${i + 1}. ${d.format} — ${where} (${d.source === 'other_game' ? `another game: ${d.gameLabel}` : d.source === 'derived' ? 'derived from this game' : 'this game'})`, '');
      L.push(`**Prompt:** ${d.prompt}`, '');
      if (d.format !== 'opening_lesson') {
        const opts = d.options ?? d.graded.slice(0, 5);
        L.push(`${d.options ? 'Options' : 'Stockfish grades'}: ${opts.map((o) => `${o.san} (${o.quality})`).join(', ')}`, '');
        if (d.sequence) L.push(`Replay ${at(d.gameId, d.sequence.fromPly)} … ${at(d.gameId, d.sequence.toPly)}, deciding at ${at(d.gameId, d.sequence.decisionPly)}`, '');
        L.push(`- correct: ${d.feedback.correct}`, `- reasonable: ${d.feedback.reasonable}`, `- misses: ${d.feedback.misses}`, `- explanation: ${d.explanation}`, '');
      }
    });
  }
  if (t.opening) {
    const o = t.opening;
    L.push(`## Opening lesson: ${o.title}`, '', o.summary, '', 'Principles:', ...o.principles.map((p) => `- ${p}`), '');
    if (o.deviation) L.push(`Your game left the plan at ply ${o.deviation.ply} with ${o.deviation.played}; the line plays ${o.deviation.recommended}.`, '');
    L.push('| ply | side | move | accepted (Stockfish) | in your game | at home | idea / guard duties |', '|---|---|---|---|---|---|---|');
    for (const s of o.steps)
      L.push(
        `| ${s.ply} | ${s.side} | ${s.move.san} | ${s.acceptable?.map((a) => `${a.san} (${a.quality})`).join(', ') ?? ''} | ${s.inGame ? `${s.inGame.san} (${s.inGame.quality})` : ''} | ${s.side === 'yours' ? s.undeveloped.join(' ') : ''} | ${s.idea}${s.duties.length ? ` · ${s.duties.join('; ')}` : ''} |`,
      );
    L.push('', `End: ${o.endReason}`, '', `Middlegame plan: ${o.middlegamePlan}`, '', o.lichess ? 'Lichess data: used.' : 'Lichess data: not available (Stockfish + development principles only).', '');
  }
  L.push(`Texts by: ${t.writtenBy}.`, ...(t.removed.length ? ['', 'Removed by the referee:', ...t.removed.map((r) => `- "${r.text}" — ${r.reason}`)] : []));
  return L.join('\n');
}
