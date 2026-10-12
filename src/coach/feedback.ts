// "This seems wrong" notes: stored on the game, exported as one Markdown
// document (PGN + each flagged statement) that can be pasted to whoever
// improves the coach.
import type { CoachFeedback, FeedbackWhere, StoredGame } from '../domain/types';

export const WHERE_LABEL: Record<FeedbackWhere, string> = {
  headline: 'Headline',
  story: 'Game story',
  did_well: 'What you did well',
  hurt: 'What hurt you',
  recurring: 'Recurring pattern',
  focus: 'Focus for next game',
  note: 'Smaller notes',
  moment: 'Guided review',
  drill: 'Drill',
};

export function feedbackCount(games: StoredGame[]): number {
  return games.reduce((n, g) => n + (g.feedback?.length ?? 0), 0);
}

export function sameTarget(a: Pick<CoachFeedback, 'where' | 'quote'>, b: Pick<CoachFeedback, 'where' | 'quote'>): boolean {
  return a.where === b.where && a.quote === b.quote;
}

/** Union of two feedback lists (by id), oldest first. */
export function mergeFeedback(a: CoachFeedback[] = [], b: CoachFeedback[] = []): CoachFeedback[] | undefined {
  const byId = new Map<string, CoachFeedback>();
  for (const f of [...a, ...b]) byId.set(f.id, f);
  const out = [...byId.values()].sort((x, y) => x.createdAt - y.createdAt);
  return out.length ? out : undefined;
}

function moveRef(g: StoredGame, ply?: number): string {
  if (!ply) return '';
  const p = g.plies[ply - 1];
  return p ? ` (move ${p.moveNumber}${p.color === 'w' ? '.' : '...'}${p.san})` : '';
}

/** Markdown with every flagged statement, grouped by game, including the PGN so the game can be re-analysed. */
export function feedbackReport(games: StoredGame[], appVersion?: number): string {
  const flagged = games.filter((g) => g.feedback?.length).sort((a, b) => a.importedAt - b.importedAt);
  const lines: string[] = [`# Chess coach feedback`, ``, `${feedbackCount(flagged)} flagged statement(s) from ${flagged.length} game(s)${appVersion ? ` · report version ${appVersion}` : ''}.`];
  for (const g of flagged) {
    lines.push(
      ``,
      `## ${g.headers.white} vs ${g.headers.black} (${g.headers.result})${g.headers.date ? ` · ${g.headers.date}` : ''}`,
      ``,
      `I played ${g.userColor === 'w' ? 'White' : 'Black'}.`,
      ``,
    );
    for (const f of g.feedback!) {
      lines.push(`- **${WHERE_LABEL[f.where]}**${moveRef(g, f.ply)}: "${f.quote.replace(/\s+/g, ' ').trim()}"`);
      lines.push(f.note.trim() ? `  - My note: ${f.note.trim().replace(/\n+/g, ' ')}` : `  - (no note)`);
    }
    lines.push(``, '```pgn', g.pgn.trim(), '```');
  }
  return lines.join('\n') + '\n';
}
