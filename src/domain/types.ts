// Core domain types. Everything here is plain JSON-serialisable data so it can
// live in localStorage today and in Postgres/Supabase rows later.

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export interface GameHeaders {
  white: string;
  black: string;
  whiteElo?: number;
  blackElo?: number;
  result: string;
  date?: string;
  event?: string;
  site?: string;
  timeControl?: string;
  termination?: string;
}

/** One half-move of a game, with the board before and after it. */
export interface PlyRecord {
  /** 1-based half-move index. Ply 1 is White's first move. */
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  from: string;
  to: string;
  piece: PieceType;
  captured?: PieceType;
  promotion?: PieceType;
  fenBefore: string;
  fenAfter: string;
  /** Remaining clock (seconds) after the move, if the PGN had %clk comments. */
  clockSeconds?: number;
}

export interface ParsedGame {
  headers: GameHeaders;
  startFen: string;
  plies: PlyRecord[];
  pgn: string;
}

// ---------------------------------------------------------------- engine ---

/** Engine score from the point of view of the side to move. */
export type Score = { type: 'cp'; value: number } | { type: 'mate'; value: number };

export interface EngineLine {
  /** Principal variation in UCI notation. */
  pv: string[];
  score: Score;
  depth: number;
}

export interface PositionEval {
  fen: string;
  depth: number;
  /** MultiPV lines, best first. Empty for game-over positions. */
  lines: EngineLine[];
  /** Set for checkmate/stalemate positions so no engine call is needed. */
  terminal?: 'checkmate' | 'stalemate' | 'draw';
}

// -------------------------------------------------------------- analysis ---

export type CategoryId =
  | 'blunder'
  | 'missed_threat'
  | 'tactical_blindness'
  | 'inefficient_moves'
  | 'premature_attack'
  | 'pointless_check'
  | 'development'
  | 'king_safety'
  | 'early_queen'
  | 'central_tension'
  | 'premature_capture'
  | 'missed_king_attack'
  | 'poor_trade'
  | 'failure_to_simplify'
  | 'time_management'
  | 'endgame'
  | 'calculation';

export type StrengthId =
  | 'castled_early'
  | 'developed_pieces'
  | 'center_control'
  | 'no_hanging'
  | 'opened_vs_king'
  | 'punished_mistake'
  | 'converted_advantage';

/** Engine facts about one half-move, from the mover's point of view. */
export interface MoveEval {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  /** Centipawns, mover POV (mates mapped to ±10000-ish). */
  cpBefore: number;
  cpAfter: number;
  /** Expected score 0..100 from mover POV. */
  winBefore: number;
  winAfter: number;
  /** winBefore - winAfter, never negative. */
  winDrop: number;
  bestUci?: string;
  bestSan?: string;
  /** Engine's best line from the position before the move (SAN). */
  bestLineSan: string[];
  /** Engine's expected continuation after the played move (SAN). */
  replyLineSan: string[];
  replyLineUci: string[];
  isBest: boolean;
  /** Material balance (mover POV, pawns) before the move. */
  materialBefore: number;
  /** Material balance (mover POV) after the engine's reply line plays out a few plies. */
  materialAfterReply: number;
  /** Material balance (mover POV) after the engine's best line from the position before the move. */
  materialAfterBest: number;
  mateThreatAgainst?: boolean;
}

export interface Finding {
  kind: 'weakness' | 'strength';
  category: CategoryId | StrengthId;
  /** Ply of the move this finding is about (0 = game-level). */
  ply: number;
  /** 1 = soft observation, 2 = notable, 3 = serious. */
  severity: 1 | 2 | 3;
  /** Short deterministic description, safe to show as-is. */
  evidence: string;
  /** Other plies that belong to the same episode (e.g. the retreat). */
  relatedPlies?: number[];
  /** Structured facts used by templates and the LLM prompt. */
  facts: Record<string, string | number | boolean | string[] | undefined>;
}

export interface Arrow {
  from: string;
  to: string;
  color: 'played' | 'best' | 'reply' | 'threat' | 'guess';
}

export interface BoardMarkup {
  arrows: Arrow[];
  highlights: { square: string; tone: 'danger' | 'good' | 'focus' }[];
}

export type MomentStepKind = 'intro' | 'predict' | 'find_better' | 'reveal' | 'why_good' | 'lesson';

export interface SequenceFrame {
  fen: string;
  san: string;
  from: string;
  to: string;
  caption: string;
}

export interface TeachingMoment {
  id: string;
  ply: number;
  kind: 'mistake' | 'good_idea';
  category: CategoryId | StrengthId;
  categories: (CategoryId | StrengthId)[];
  significance: number;
  steps: MomentStepKind[];
  moverColor: Color;
  fenBefore: string;
  fenAfter: string;
  playedSan: string;
  playedUci: string;
  bestSan?: string;
  bestUci?: string;
  bestLineSan: string[];
  /** UCI moves accepted as "a good alternative" in the find-better step. */
  acceptableUcis: string[];
  /** Opponent's actual reply in the game. */
  opponentReplySan?: string;
  opponentReplyUci?: string;
  /** Opponent replies accepted in the predict step. */
  acceptableReplyUcis: string[];
  /** The episode as it happened (played move, reply, follow-up...). */
  sequence: SequenceFrame[];
  /** Position for the "find a better move" step (may be a later move of the same episode). */
  betterFen: string;
  betterPly: number;
  /** Engine continuation after the better move. */
  betterSequence: SequenceFrame[];
  introMarkup: BoardMarkup;
  text: MomentText;
  numbers: {
    winBefore: number;
    winAfter: number;
    cpBefore: number;
    cpAfter: number;
    /** Win% (mover) of the best move / the move played, in the find-better position. */
    betterBestWin: number;
    betterPlayedWin: number;
  };
  /** For good_idea moments: multiple choice "why is this good?" */
  choice?: { prompt: string; options: string[]; correct: number; explanation: string };
}

export interface MomentText {
  title: string;
  intent: string;
  question: string;
  predictCorrect: string;
  predictOther: string;
  reveal: string;
  betterPrompt: string;
  betterCorrect: string;
  betterOther: string;
  lesson: string;
}

// ---------------------------------------------------------------- report ---

export interface ReportItem {
  text: string;
  plies?: number[];
  category?: CategoryId | StrengthId;
}

export interface GameReport {
  headline: string;
  didWell: ReportItem[];
  hurt: ReportItem[];
  recurring: string;
  focus: { title: string; detail: string; theme: ThemeId };
  minorNotes: ReportItem[];
  voice: 'template' | 'llm';
}

export type ThemeId =
  | 'active_without_followup'
  | 'loose_pieces'
  | 'opponent_threats'
  | 'tactics'
  | 'opening_development'
  | 'king_safety'
  | 'center'
  | 'trades'
  | 'conversion'
  | 'clock'
  | 'endgame';

// ---------------------------------------------------------------- drills ---

export type DrillType = 'find_better' | 'predict_response' | 'identify_problem' | 'choose_plan';

export interface Drill {
  id: string;
  gameId: string;
  ply: number;
  type: DrillType;
  category: CategoryId | StrengthId;
  fen: string;
  orientation: Color;
  prompt: string;
  /** Move drills: accepted UCI moves. */
  acceptableUcis?: string[];
  /** Move drills: the move to show if the user gives up / gets it wrong. */
  solutionUci?: string;
  solutionSan?: string;
  /** Multiple-choice drills. */
  options?: string[];
  correctIndex?: number;
  /** Arrow shown with the question (e.g. "you want to play this"). */
  questionArrow?: Arrow;
  explanation: string;
  createdAt: number;
}

export interface DrillAttempt {
  drillId: string;
  at: number;
  correct: boolean;
}

// ----------------------------------------------------------------- games ---

export type GameStatus = 'imported' | 'analyzing' | 'analyzed' | 'error';

export interface StoredGame {
  id: string;
  importedAt: number;
  pgn: string;
  headers: GameHeaders;
  userColor: Color;
  userName: string;
  userRating?: number;
  opponentName: string;
  plies: PlyRecord[];
  status: GameStatus;
  error?: string;
  analysis?: {
    depth: number;
    engine: string;
    analyzedAt: number;
    positions: PositionEval[];
    moves: MoveEval[];
  };
  findings: Finding[];
  moments: TeachingMoment[];
  report?: GameReport;
  drillIds: string[];
  completedMomentIds: string[];
}

// --------------------------------------------------------------- profile ---

export interface PlayerSettings {
  /** username (lower-cased) -> number of imported games as that user */
  usernames: Record<string, number>;
  displayName?: string;
  rating: number;
  analysisDepth: number;
  focus?: { title: string; detail: string; theme: ThemeId; setAt: number; gameId: string };
  useLlm: boolean;
}

export type Trend = 'improving' | 'stable' | 'worsening' | 'new' | 'insufficient';

export interface CategoryStats {
  category: CategoryId;
  label: string;
  occurrences: number;
  /** Games (among the last N) in which this appeared. */
  recentGames: number;
  recentWindow: number;
  gamesWithCategory: number;
  avgSeverity: number;
  trend: Trend;
  confidence: 'possible' | 'emerging' | 'established';
  lastOccurrence?: { gameId: string; ply: number; san?: string; at: number };
  examples: { gameId: string; ply: number; san?: string; fen?: string; evidence: string }[];
}

export interface StrengthStats {
  id: StrengthId;
  label: string;
  recentGames: number;
  recentWindow: number;
}

export interface ProfileSummary {
  gamesAnalyzed: number;
  categories: CategoryStats[];
  strengths: StrengthStats[];
  improving: CategoryStats[];
}
