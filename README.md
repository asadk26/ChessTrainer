# Chess Coach

A local-first personal chess coach. Paste a PGN; Stockfish (running in your browser) establishes the
facts, and a coaching layer turns them into a short, human review: what you did well, what hurt you,
whether it's a recurring habit, and **one** thing to focus on next game. Then it walks you through the
key moments on the board and gives you a few drills.

It is deliberately *not* a Game Review clone. A +0.7 → +0.3 swing is ignored. A knight that goes to b5
and comes straight back is a teaching moment even if the engine barely minds.

## Setup

```bash
npm install      # also copies the Stockfish WASM build into public/stockfish/
npm run dev      # http://localhost:5173
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview` | Serve the build (the LLM proxy works here too) |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run analyze-sample [-- file.pgn b]` | Run the full pipeline in Node with real Stockfish and print the coaching |

Requirements: Node 18+ (tested on Node 22) and a modern browser with WebAssembly + Web Workers.

### First run

Click **Try the sample game** (or Import → *Load sample game*). Analysis takes ~5–15 seconds.
Then: Summary → **Start guided review** → Drills. The dashboard fills in as you add games.

## User flow

1. **Import** – paste a PGN. Players, colours, ratings, result, date and moves are parsed (smart quotes,
   `0-0`, `%clk` comments handled). The app remembers your usernames and pre-selects "me" next time.
2. **Summary** – headline, ≤3 *did well*, ≤3 *hurt you*, recurring pattern, one focus, plus optional
   "smaller notes" for soft observations (e.g. releasing central tension). Move references are clickable.
3. **Guided review** – board on the left, coach on the right (stacked on mobile). Each teaching moment
   runs through steps such as: position before the move → what you were probably trying to do →
   *predict the opponent's reply* or *find a better move* on the board → feedback → the actual
   continuation animated with arrows → the lesson. Moves and squares in the coaching text are
   hover targets that light up on the board. A move list with ‹ › controls (and arrow keys) lets you
   browse the whole game.
4. **Drills** – 2–3 per game, varied: *find the better move*, *predict the response*, *identify the
   problem* (multiple choice), *choose the plan*. Attempts are stored; the global Drills page puts
   unsolved ones first.
5. **Dashboard** – current focus, recent strengths, recurring weaknesses with honest frequency
   language ("Possible tendency", "Has now appeared in 3 of your last 5 games", trend), recent games,
   settings (rating, engine depth, AI voice toggle), JSON export.

## Architecture

```
src/
  domain/        types.ts (all persisted shapes), categories.ts (categories, themes, focus texts)
  chess/         pgn.ts (parsing/normalising), board.ts (material, attacks, loose pieces, lines)
  engine/        uci.ts (UCI protocol, queueing), browserEngine.ts (Web Worker), types.ts (Engine interface)
  analysis/      evaluation.ts   cp/mate → win%, eval change from the mover's POV
                 analyzeGame.ts  engine over every position → MoveEval facts
                 detectors.ts    deterministic pattern detectors → Findings
                 moments.ts      significance layer → TeachingMoments
                 pipeline.ts     orchestration + history (prior games)
  coach/         templates.ts (built-in coaching voice), report.ts (summary), llmCoach.ts + llmClient.ts
  drills/        generate.ts
  profile/       identify.ts (who is "me"), profile.ts (cross-game aggregation)
  storage/       repository.ts (CoachRepository interface + localStorage implementation)
  ui/            React screens/components
server/          llm.ts (providers), coachPlugin.ts (Vite middleware), nodeEngine.ts (Stockfish for tests/CLI)
tests/           Vitest suites + recorded Stockfish output for the sample game
```

The data flow is a straight pipeline:

```
PGN → plies (FEN before/after each move)
    → Stockfish: every position, MultiPV 3            (objective facts)
    → MoveEval: eval before/after, win% drop, best line, reply line, material after lines
    → detectors: Findings (category, severity, evidence, structured facts)
    → significance layer: ≤3 mistake moments + 1 "good idea" moment
    → report (template voice) + drills
    → optional LLM rewrite of the *language only*, validated against the facts
```

## Stockfish integration

* Package: [`stockfish`](https://www.npmjs.com/package/stockfish) 17.1, **lite single-threaded WASM**
  build (~7 MB). Single-threaded means no `SharedArrayBuffer`, so no COOP/COEP headers are needed.
* `scripts/copy-stockfish.mjs` copies it to `public/stockfish/` on `postinstall`/`predev`/`prebuild`
  (that folder is git-ignored).
* `src/engine/uci.ts` speaks UCI over any line transport and queues requests; the browser uses a Web
  Worker, tests/CLI use a Node child process (`server/nodeEngine.ts`). Checkmate/stalemate positions
  are scored without calling the engine.
* Default depth 12, MultiPV 3 (configurable on the dashboard). The guided review and drills also use the
  live engine to judge moves you try that aren't in the stored candidate list.

**What the engine is used for:** evaluation before/after each move, best candidates, principal
variations, the opponent's best reply, material after short lines (to detect hanging pieces and simple
tactics), mate threats. **What it is not used for:** deciding what's worth teaching on its own.

## How coaching patterns are classified

Detectors (`src/analysis/detectors.ts`) are small, conservative rules over board geometry + engine
facts. Each produces a `Finding` with a severity (1 = soft note, 2 = notable, 3 = serious), plain-English
evidence and structured facts for the templates/LLM. Examples:

| Category | Rule (simplified) |
| --- | --- |
| Outright blunder | After your move, the engine's reply line wins ≥2 pawns of material, the loss was avoidable, and win% drops ≥12 |
| Missed opponent threat | Same, but the piece lost was *already* loose before your move |
| Missed simple tactic | The best move wins ≥2 within 3 plies (or mates in ≤3) and you lost ≥10 win% |
| Inefficient piece moves | A piece moves A→B and within your next two moves goes back to A or to a square reachable from A in one move, without winning material |
| Active move without follow-up | The above, where the first move attacked something; or an attack/check the opponent parries while a clearly better move existed |
| Pointless forcing move | A check that gains nothing and leads to the piece moving again |
| Early queen | Non-capturing queen move by move 10 with ≥2 minors undeveloped, which loses ground or gets chased |
| Releasing central tension | Pawn takes pawn in the centre, immediately recaptured — soft note unless costly |
| Opening the centre vs. uncastled king *(strength)* | A central pawn break while their king is still in the centre and yours is castled |
| Missed chance vs. exposed king | Their king is in the centre and the best move was a check or a central break |
| King safety, development, trades, failure to simplify, endgame slips, clock usage | See source |

**Significance layer** (`src/analysis/moments.ts`): `score = Σ category weight × severity × 10 +
0.8 × win% drop (ignored below 6) + 5 × prior games with the same category (max 3)`. Moments need a
score ≥18; the top 3 are kept plus one positive "good idea". So 11.Nb5 in the sample (engine drop ≈1%)
becomes a moment because of the round trip, while tiny engine preferences never do.

**Themes and focus**: categories roll up into themes (e.g. *active-looking moves without a follow-up*,
*loose pieces*, *opponent threats*). The next-game focus is the theme with the highest
weight in this game plus recurrence in your last games, mapped to one concrete behaviour.

**Honesty about patterns**: one game = "possible tendency"; the report and dashboard only say
"appeared in N of your last M games" when the data says so. Severity-1 notes never form a pattern.

## LLM provider setup (optional)

The app is fully usable without any key: coaching language comes from deterministic templates.
To add an AI coaching voice, copy `.env.example` to `.env` and set **one** of:

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-5-5        # default

# Any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio...)
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

Keys are read only by the local Vite dev/preview server (`server/coachPlugin.ts` exposes
`/api/coach/status` and `/api/coach/complete`); they are never bundled into browser code. The Anthropic
provider uses the official SDK with low effort and server-side refusal fallbacks enabled.

The LLM is **not** the chess engine. It receives structured, verified context — rating, PGN, FENs,
played/best moves, lines, evals, material changes, findings, the current weakness profile — and is asked
only to phrase the coaching. Its JSON response is validated: any text that mentions a piece move or
capture not present in the game/engine lines is discarded and the template text is kept. Board arrows
and highlights always come from the deterministic layer.

## Where data is stored

Browser `localStorage`, keys prefixed `chesscoach:v1:`:

| Key | Contents |
| --- | --- |
| `games:index`, `game:<id>` | PGN, headers, plies, engine positions/move facts, findings, teaching moments, report, completed moments |
| `drills` | Generated drills |
| `attempts` | Drill attempts (correct / incorrect, timestamp) |
| `settings` | Known usernames, rating, engine depth, AI toggle, current focus |

The player profile is *derived* (recomputed from stored findings), so it never drifts. All access goes
through the async `CoachRepository` interface; moving to IndexedDB or Supabase/Postgres means writing one
class (games → table with JSONB for findings/moments/report; drills; drill_attempts; player_settings).
Dashboard → Settings → *Export data* downloads a JSON backup.

## Tests

`npm test` covers PGN parsing, board-state reconstruction, evaluation-change maths, UCI parsing,
player identification, recurring-pattern aggregation, the coaching pipeline on the sample game
(using recorded Stockfish output, so it's deterministic), LLM output validation/merging, storage
round-trips, and one integration test that runs real Stockfish over the sample game.

## Known limitations

* Detectors are heuristics. They are tuned to avoid false positives, so some instructive moments are
  missed (e.g. positional plans, subtle king-safety issues, deep tactics).
* Intent ("what you were probably trying to do") is inferred from the board, not known.
* Lite Stockfish at depth 12 is strong enough for this rating range but not infallible; lines can differ
  slightly between Node and the browser.
* The predict-the-reply step accepts the game reply and near-best engine replies; other reasonable
  replies are marked as "possible, but…".
* localStorage is per-browser and limited to ~5 MB (roughly a few hundred analyzed games).
* Clock analysis only works when the PGN includes `%clk` comments.
* The LLM endpoint exists only when running via `npm run dev`/`npm run preview`; a static deploy of
  `dist/` falls back to built-in coaching.

## Recommended next improvements

1. Import directly from Chess.com/Lichess usernames (public APIs) and batch-analyze recent games.
2. IndexedDB or Supabase storage; sync across devices.
3. Spaced repetition for drills (schedule misses sooner) and drills pulled from *recurring* categories.
4. More detectors: overloaded defenders, pins/forks taxonomy, pawn-structure basics, rook activity.
5. Per-moment "ask the coach" follow-up questions via the LLM, grounded on the same facts.
6. Opening-phase summary per opening you play (without becoming an opening explorer).
7. Calibrate thresholds per rating band using a corpus of real games.
