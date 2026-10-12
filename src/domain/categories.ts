import type { CategoryId, StrengthId, ThemeId } from './types';

export interface CategoryMeta {
  label: string;
  /** How much this category matters for a ~700–1100 player (0..1). */
  weight: number;
  theme: ThemeId;
}

export const CATEGORIES: Record<CategoryId, CategoryMeta> = {
  blunder: { label: 'Outright blunders (hanging pieces)', weight: 1, theme: 'loose_pieces' },
  missed_threat: { label: 'Missed opponent threats', weight: 0.95, theme: 'opponent_threats' },
  tactical_blindness: { label: 'Missed simple tactics', weight: 0.8, theme: 'tactics' },
  calculation: { label: "Not checking the opponent's best reply", weight: 0.8, theme: 'opponent_threats' },
  premature_attack: { label: 'Active-looking moves without a follow-up', weight: 0.7, theme: 'active_without_followup' },
  pointless_check: { label: 'Pointless forcing moves', weight: 0.6, theme: 'active_without_followup' },
  inefficient_moves: { label: 'Inefficient piece moves (lost tempi)', weight: 0.6, theme: 'active_without_followup' },
  development: { label: 'Development problems', weight: 0.6, theme: 'opening_development' },
  early_queen: { label: 'Early / unnecessary queen moves', weight: 0.5, theme: 'opening_development' },
  king_safety: { label: 'King safety', weight: 0.75, theme: 'king_safety' },
  central_tension: { label: 'Releasing central tension', weight: 0.25, theme: 'center' },
  premature_capture: { label: 'Premature captures', weight: 0.45, theme: 'trades' },
  poor_trade: { label: 'Poor trades', weight: 0.45, theme: 'trades' },
  missed_king_attack: { label: 'Missed chances against an exposed king', weight: 0.6, theme: 'tactics' },
  failure_to_simplify: { label: 'Not simplifying when ahead', weight: 0.5, theme: 'conversion' },
  time_management: { label: 'Time management', weight: 0.5, theme: 'clock' },
  endgame: { label: 'Endgame technique', weight: 0.5, theme: 'endgame' },
};

export const STRENGTHS: Record<StrengthId, { label: string; phrase: string }> = {
  castled_early: { label: 'King safety', phrase: 'You castled early and kept your king safe.' },
  developed_pieces: { label: 'Development', phrase: 'You got your minor pieces out quickly.' },
  center_control: { label: 'Central control', phrase: 'You claimed the center with your pawns right away.' },
  no_hanging: { label: 'No hanging pieces', phrase: 'You did not leave pieces hanging.' },
  opened_vs_king: { label: 'Attacking the uncastled king', phrase: 'You tried to open lines while the enemy king was stuck in the center.' },
  punished_mistake: { label: 'Punishing mistakes', phrase: 'When your opponent slipped, you took what was offered.' },
  converted_advantage: { label: 'Converting advantages', phrase: 'You converted your advantage into a win.' },
};

export interface ThemeMeta {
  label: string;
  /** One specific, behavioural focus for the next game. */
  focusTitle: string;
  focusDetail: string;
  /** Short clause used inside the summary headline. */
  clause: string;
}

export const THEMES: Record<ThemeId, ThemeMeta> = {
  active_without_followup: {
    label: 'Active-looking moves without a follow-up',
    focusTitle: "Before an attacking or forcing move, name your opponent's most obvious reply.",
    focusDetail:
      'Checks, attacks on pieces and knight jumps feel productive. Before you play one, say the opponent\'s simplest answer out loud. If that answer leaves your piece with nothing to do — or makes it retreat — play a developing or improving move instead.',
    clause: 'you spent several tempi on moves that looked active without producing a lasting benefit',
  },
  loose_pieces: {
    label: 'Leaving pieces unprotected',
    focusTitle: 'Before you let go of a piece, check whether it can simply be taken.',
    focusDetail:
      'Do a two-second blunder check on every move: for the square you are moving to, and for the piece you are moving away from — what can now be captured for free?',
    clause: 'pieces were left unprotected and your opponent could simply take them',
  },
  opponent_threats: {
    label: "Missing the opponent's threats",
    focusTitle: 'After every opponent move, ask: "What does that move attack?"',
    focusDetail:
      'Before thinking about your own plans, spend a moment on your opponent\'s last move. What does it attack now? What does it threaten next move?',
    clause: "you sometimes moved on with your own plan before checking what your opponent's move threatened",
  },
  tactics: {
    label: 'Missed tactical chances',
    focusTitle: 'Look for checks, captures and attacks on every move — for both sides.',
    focusDetail:
      'Your opponent will leave things loose at this level. Each move, scan for checks, captures and attacks on undefended pieces before settling on a quiet move.',
    clause: 'there were chances to win material that went unnoticed',
  },
  opening_development: {
    label: 'Opening development',
    focusTitle: 'Develop a new piece with each move in the first ten moves.',
    focusDetail:
      'Knights and bishops first, castle, then connect the rooks. Move a piece twice (or the queen early) only when it wins something concrete.',
    clause: 'your development was slower than it should have been',
  },
  king_safety: {
    label: 'King safety',
    focusTitle: 'Castle before move 10, and keep the pawns in front of your king.',
    focusDetail: 'Before opening the position or pushing pawns near your king, make sure your own king is tucked away.',
    clause: 'your king ended up exposed',
  },
  center: {
    label: 'Central decisions',
    focusTitle: 'When pawns face each other in the center, ask who benefits from the exchange.',
    focusDetail: 'Keeping tension is often stronger than capturing. Capture when it gains something: a tempo, an open file for you, or development.',
    clause: 'you released central tension a bit early',
  },
  trades: {
    label: 'Captures and trades',
    focusTitle: 'Before capturing, ask what the trade does for you.',
    focusDetail: 'A capture should win material, remove a key defender, or help your development. If it only helps your opponent develop, keep the tension.',
    clause: 'some captures helped your opponent more than you',
  },
  conversion: {
    label: 'Converting when ahead',
    focusTitle: 'When you are ahead in material, trade pieces and keep everything protected.',
    focusDetail: 'Simplify into an easy position. Every trade makes your extra material count for more.',
    clause: 'you did not simplify when you were ahead',
  },
  clock: {
    label: 'Time management',
    focusTitle: 'Spend your time in the critical moments, not on routine moves.',
    focusDetail: 'Play the opening quickly with principles, save time for positions with captures, checks and threats.',
    clause: 'the clock became a problem',
  },
  endgame: {
    label: 'Endgame technique',
    focusTitle: 'In the endgame, activate your king and push passed pawns.',
    focusDetail: 'Once queens are off, the king becomes a fighting piece. Bring it toward the center.',
    clause: 'the endgame slipped away',
  },
};

export function categoryLabel(id: CategoryId | StrengthId): string {
  if (id in CATEGORIES) return CATEGORIES[id as CategoryId].label;
  if (id in STRENGTHS) return STRENGTHS[id as StrengthId].label;
  return id;
}

export function isWeakness(id: CategoryId | StrengthId): id is CategoryId {
  return id in CATEGORIES;
}
