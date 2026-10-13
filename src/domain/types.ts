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
  /** Link to the game on the site it was played on (Chess.com and Lichess PGNs include it). */
  link?: string;
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
  | 'calculation'
  | 'gave_back_material'
  | 'unnecessary_complications'
  | 'hunting_material'
  | 'allowed_counterplay'
  | 'pawn_structure'
  | 'passive_piece'
  | 'stranded_piece';

export type StrengthId =
  | 'castled_early'
  | 'developed_pieces'
  | 'center_control'
  | 'no_hanging'
  | 'opened_vs_king'
  | 'punished_mistake'
  | 'converted_advantage'
  | 'won_free_material'
  | 'simplified_when_ahead'
  | 'defensive_resource'
  | 'passed_pawn'
  | 'neutralized_counterplay'
  | 'rook_open_file'
  | 'found_tactic';

/**
 * How sure the coach is that a finding is real and instructive. Low-confidence
 * findings are kept for transparency but never reach the main summary,
 * teaching moments, focus, or cross-game pattern counts.
 */
export type Confidence = 'high' | 'medium' | 'low';

/** Practical situation before a move, from the user's point of view. */
export interface PlyContext {
  ply: number;
  /** Material balance in pawns (user POV). */
  material: number;
  /** Engine evaluation in centipawns (user POV). */
  cp: number;
  ahead: boolean;
  farAhead: boolean;
  behind: boolean;
  kingPressure: boolean;
  attackingKing: boolean;
  endgame: boolean;
  race: boolean;
}

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
  /**
   * How much the move actually cost in practical terms. Equals winDrop, except
   * when already clearly ahead: then win% barely moves (+8 -> +5 is still
   * "winning"), so the centipawn/material loss is used instead.
   */
  practicalDrop?: number;
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
  /** Defaults to 'medium' for data saved before confidence existed. */
  confidence?: Confidence;
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

/** 1 refutation · 2 missed tactic · 3 big swing · 4 recurring habit · 5 positional · 6 small inaccuracy. */
export type MomentPriority = 1 | 2 | 3 | 4 | 5 | 6;
export type LessonQuestion = 'predict_reply' | 'find' | 'cleaner';

export interface TeachingMoment {
  id: string;
  ply: number;
  kind: 'mistake' | 'good_idea';
  /** 'lesson': one of the 1–2 interactive questions per game; 'note': a short explanation with an optional Explore. */
  tier?: 'lesson' | 'note';
  priority?: MomentPriority;
  /** For lessons: which question to ask first. */
  question?: LessonQuestion;
  /** The opponent's strongest reply to the move played (for "predict the reply"). */
  refutationUci?: string;
  refutationSan?: string;
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
    /** Centipawns (mover) of the best move in that position; optional for older saves. */
    betterBestCp?: number;
  };
  explanation?: MoveExplanation;
  /** For good_idea moments: multiple choice "why is this good?" */
  choice?: { prompt: string; options: string[]; correct: number; explanation: string };
}

/** Three-part explanation of a move, from board facts (see analysis/explain.ts). */
export interface MoveExplanation {
  ply: number;
  /** A mistake caused a concrete problem; a missed opportunity didn't, but something better was there. */
  kind: 'mistake' | 'missed_opportunity';
  /** What the move does, without the move: "attacks the loose queen on e6". */
  intent?: string;
  /** "it lets Black start checking your king with Qg4+". */
  problem?: string;
  /** "exd6 wins the bishop on d6" — only when the reason is reliable. */
  better?: string;
  betterSan?: string;
  betterPly: number;
  /** A few moves of the engine line, only when they make the reason concrete. */
  support?: string[];
  purposes: string[];
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
  /** Why the better move is better, in plain words (when it can be said reliably). */
  why?: string;
}

// ---------------------------------------------------------------- report ---

export interface ReportItem {
  text: string;
  plies?: number[];
  /** The positions worth a board diagram, in order (≤4). Falls back to `plies` for older reports. */
  keyPlies?: number[];
  category?: CategoryId | StrengthId;
}

export interface GameReport {
  headline: string;
  didWell: ReportItem[];
  hurt: ReportItem[];
  recurring: string;
  focus: { title: string; detail: string; theme: ThemeId };
  minorNotes: ReportItem[];
  /** One or two sentences on the shape of the game (ahead from move X, endgame, race...). */
  story?: string;
  voice: 'template' | 'llm';
  /** Report format version; older reports are re-coached (no engine needed) to pick up new fields. */
  version?: number;
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
  | 'endgame'
  | 'structure'
  | 'activity'
  | 'stranded';

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
    /** Position indices re-analysed at depth 18 because they're critical teaching moments. */
    deepPositions?: number[];
  };
  findings: Finding[];
  /** Three-part explanations keyed by ply, for credible mistakes and missed chances. */
  explanations?: Record<number, MoveExplanation>;
  moments: TeachingMoment[];
  report?: GameReport;
  drillIds: string[];
  completedMomentIds: string[];
  /** Where the game came from, when it was synced rather than pasted. */
  source?: { site: 'chesscom'; id: string; url: string; timeClass?: string };
  /** The player's own word on how the game ended, overriding the PGN result (which may be missing or copied wrong). */
  outcome?: 'win' | 'loss' | 'draw';
  /** AI-written explanations of single positions, keyed by ply, cached so revisiting costs no API call. */
  aiExplanations?: Record<number, AiExplanation>;
  /** "This seems wrong" notes the player left on the coaching. */
  feedback?: CoachFeedback[];
  /** The Beta AI Coach's whole-game review, cached until regenerated on request (older shapes are ignored). */
  aiCoach?: BetaCoachReview | { version?: undefined };
  /**
   * The Beta AI Coach's own evaluation of every position, in one pass at one depth, so
   * move-by-move changes are never an artefact of comparing different depths.
   * Kept apart from the built-in coach's analysis.
   */
  aiCoachEval?: { depth: number; positions: PositionEval[] };
  /** The AI walkthrough derived from the Beta lesson plan. */
  aiWalkthrough?: AiWalkthrough;
  /** Experimental training built from this game: priority, drills and (when needed) an opening lesson. */
  aiTraining?: TrainingPlan;
}

export type FeedbackWhere = 'headline' | 'story' | 'did_well' | 'hurt' | 'recurring' | 'focus' | 'note' | 'moment' | 'drill';

/** A player's flag on one piece of coaching, kept with the game so it survives re-coaching and export. */
export interface CoachFeedback {
  id: string;
  where: FeedbackWhere;
  /** The coaching text exactly as it was shown. */
  quote: string;
  /** The player's own words (optional). */
  note: string;
  ply?: number;
  createdAt: number;
  reportVersion?: number;
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
  /** Access code for a hosted AI coach (COACH_ACCESS_TOKEN). Never included in exports. */
  coachToken?: string;
  /** Optional Chess.com syncing (public API, no login). */
  chesscom?: ChessComSettings;
  /** Beta AI Coach tab (Gemini's own whole-game review). On unless switched off. */
  betaCoach?: boolean;
}

export type ChessComTimeClass = 'rapid' | 'blitz' | 'bullet' | 'daily';

export interface ChessComSettings {
  username: string;
  /** Only games from the last N days are synced. */
  days: number;
  timeClasses: ChessComTimeClass[];
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

/** An AI instructor's explanation of one position, grounded in (and checked against) the Stockfish analysis. */
export interface AiExplanation {
  ply: number;
  tryingTo: string;
  missed: string;
  whyBetter: string;
  opponentReply: string;
  difference: string;
  takeaway: string;
  pattern: string;
  confidence: 'clear' | 'small_difference';
  model?: string;
  createdAt: number;
  /** Identifies the engine analysis it was based on; if the analysis changes, the explanation is stale. */
  grounding: string;
}

/** One chapter of the Beta AI Coach's walk through the game. */
export interface BetaChapter {
  title: string;
  /** First and last ply the chapter covers. */
  fromPly: number;
  toPly: number;
  /** The move the chapter turns on; its diagram shows the position before it. */
  anchorPly: number;
  /** opening / strategic_decision / turning_point / tactic / conversion / defence / endgame / result … */
  kind: string;
  assessment: 'well' | 'mixed' | 'poorly' | 'neutral';
  narrative: string;
  /** Stockfish facts the interpretation rests on, in words. */
  evidence: string[];
  lesson: string;
  diagram: boolean;
  explore: boolean;
  /** For a causal turning point: the decision that caused it, and where the consequence showed. */
  decisionPly?: number;
  consequencePly?: number;
}

/**
 * The Beta AI Coach (v2): the model chooses what is instructive — the game's phases
 * and turning points — from the whole game's Stockfish evidence. Concrete claims
 * the engine data contradicts are removed before it is stored (and listed in `removed`).
 */
/** Gemini's reported token counts for one call. */
export interface TokenUsage {
  input: number;
  output: number;
  /** Tokens spent "thinking" (Gemini 2.5+), billed as output. */
  thinking?: number;
}

/** A multi-move lesson: the decision that caused a shift and where its consequence showed. */
export interface TeachingSequence {
  id: string;
  startPly: number;
  endPly: number;
  decisionPly: number;
  consequencePly?: number;
  title: string;
  explanation: string;
}

export interface BetaCoachReview {
  version: 4;
  /** The game's arc in 2–3 sentences. */
  story: string;
  chapters: BetaChapter[];
  /** What this game teaches: 1–2 transferable principles. */
  lessons: string[];
  /** Positions worth revisiting: the position before the student's move at `ply`. */
  practice: { ply: number; why: string }[];
  /** The rest of the Game Lesson Plan, shared with the AI walkthrough. */
  strengths: string[];
  mistakes: string[];
  patterns: string[];
  sequences: TeachingSequence[];
  /** Moments the planner wants the student to work out for themselves. */
  interactive: { ply: number; kind: WalkInteractionKind; why: string }[];
  removed: { text: string; reason: string }[];
  model?: string;
  usage?: TokenUsage;
  createdAt: number;
  grounding: string;
}

export type WalkInteractionKind = 'find_move' | 'predict_reply' | 'choose_plan' | 'evaluate_position' | 'compare_moves';

export interface WalkInteraction {
  kind: WalkInteractionKind;
  prompt: string;
  hint?: string;
  /** choose_plan / compare_moves: each option is a real move (UCI), graded by Stockfish. */
  options?: { uci: string; san: string; label: string }[];
  /** Feedback per Stockfish grade. */
  feedback: { correct: string; reasonable: string; misses: string };
  /** The explanation shown once the student has answered. */
  reveal: string;
}

/**
 * One stop in the AI walkthrough. Moves without an event are skipped through.
 * 'before' pauses at the position before move `ply` (a decision); 'after' comments once it's played.
 */
export interface WalkEvent {
  ply: number;
  timing: 'before' | 'after';
  type: 'brief' | 'explain' | 'interactive';
  title?: string;
  narration: string;
  sequenceId?: string;
  interaction?: WalkInteraction;
  /** Lines worth trying from this position: Stockfish's candidates, with the coach's labels. */
  explore?: { uci: string; san: string; label: string }[];
  takeaway?: string;
}

/** The AI walkthrough for Guided Review: written once from the lesson plan, replayed with no AI calls. */
export interface AiWalkthrough {
  version: 1;
  events: WalkEvent[];
  removed: { text: string; reason: string }[];
  model?: string;
  usage?: TokenUsage;
  createdAt: number;
  /** The plan's createdAt plus the engine grounding: a new plan or analysis makes this stale. */
  grounding: string;
}

// -------------------------------------------------------------- training ---

/** The kind of weakness (or strength) a game revealed, as something to practise away from the game. */
export type TrainingCategory =
  | 'opening_development'
  | 'blunder_check'
  | 'missed_tactic'
  | 'strategic_decision'
  | 'conversion'
  | 'endgame_technique';

export type DrillFormat =
  | 'tactical_puzzle'
  | 'strategic_choice'
  | 'predict_threat'
  | 'compare_plans'
  | 'replay_sequence'
  | 'endgame_technique'
  | 'why_good'
  | 'opening_lesson';

/** One piece of evidence behind a training priority (from Stockfish and the board, not the model). */
export interface TrainingSignal {
  kind: string;
  ply?: number;
  text: string;
}

export interface GradedMove {
  uci: string;
  san: string;
  quality: 'best' | 'equal' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
}

export interface TrainingDrill {
  id: string;
  format: DrillFormat;
  /** Formats the position supports; the coach may pick any of them. */
  formats: DrillFormat[];
  source: 'this_game' | 'other_game' | 'derived';
  gameId: string;
  gameLabel: string;
  /** The game move this position comes before (or, for predict_threat, after). */
  ply: number;
  fen: string;
  orientation: Color;
  /** Side to move in `fen` (the side whose move is asked for). */
  toMove: Color;
  /** Stockfish's graded candidates at `fen`: best / equal / good count. */
  graded: GradedMove[];
  /** For choice formats: the moves to choose between (Stockfish-graded). */
  options?: GradedMove[];
  /** For replay_sequence: the plies played through, and where to stop and decide. */
  sequence?: { fromPly: number; toPly: number; decisionPly: number };
  /** Deterministic engine facts shown with the drill. */
  facts: string[];
  prompt: string;
  hint?: string;
  feedback: { correct: string; reasonable: string; misses: string };
  explanation: string;
}

export interface TrainingLesson {
  id: string;
  category: TrainingCategory;
  title: string;
  /** The skill being trained, as a habit. */
  skill: string;
  why: string;
  signals: TrainingSignal[];
  drills: TrainingDrill[];
}

export interface OpeningStep {
  ply: number;
  color: Color;
  /** Position before the move. */
  fen: string;
  side: 'yours' | 'theirs';
  move: { uci: string; san: string };
  /** Your moves: every move Stockfish rates good or better, graded. */
  acceptable?: GradedMove[];
  /** Your moves: Stockfish's view (for you) and, when known, how often players near your rating choose them. */
  candidates?: { uci: string; san: string; quality: GradedMove['quality']; evalForYou: string; share?: number }[];
  /** Their moves: how often players near your rating choose them. */
  popular?: { san: string; share: number }[];
  /** What happened in your game at this point, while the line still follows it. */
  inGame?: { san: string; quality: GradedMove['quality'] };
  undeveloped: string[];
  castled: boolean;
  /** "Bc1 is the only guard of b2 (attacked by the bishop on f6)". */
  duties: string[];
  idea: string;
}

export interface OpeningLesson {
  name: string;
  userColor: Color;
  steps: OpeningStep[];
  endReason: string;
  /** Where your game left the recommended plan, if it did. */
  deviation?: { ply: number; played: string; recommended: string };
  title: string;
  summary: string;
  principles: string[];
  middlegamePlan: string;
  traps: string[];
  /** Whether Lichess frequencies were available when it was built. */
  lichess: boolean;
}

export interface TrainingPlan {
  version: 1;
  priority: { category: TrainingCategory; title: string; why: string; signals: TrainingSignal[] };
  /** The other candidates the diagnosis considered, with their scores (for transparency). */
  considered: { category: TrainingCategory; score: number; reason: string }[];
  lessons: TrainingLesson[];
  opening?: OpeningLesson;
  /** 'template' when no AI wrote the texts. */
  writtenBy: string;
  usage?: TokenUsage;
  removed: { text: string; reason: string }[];
  createdAt: number;
  grounding: string;
}
