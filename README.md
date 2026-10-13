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

Requirements: Node 20+ (tested on Node 22) and a modern browser with WebAssembly + Web Workers.

### First run

Click **Try the sample game** (or Import → *Load sample game*). Analysis takes ~5–15 seconds.
Then: Summary → **Start guided review** → Drills. The dashboard fills in as you add games.

## Deploy it (use it from your iPhone without your computer)

The app is a normal static Vite site plus two optional serverless functions for the AI coach. It is set
up for **[Vercel](https://vercel.com)** (free Hobby plan, which is for personal use): it auto-detects
Vite, and its functions can hold an LLM key server-side with a 60-second timeout (Netlify's 10-second
default is too short for LLM calls).

**One-time setup (about 3 minutes):**

1. Push this repo to GitHub (already done if you're reading it there).
2. Go to [vercel.com/new](https://vercel.com/new), sign in with GitHub, and **Import** the repository.
   Vercel reads `vercel.json`: install `npm install`, build `npm run build`, output `dist/`. Don't change
   anything; click **Deploy**.
3. You get a URL like `https://chess-trainer-yourname.vercel.app`. Every push to the production branch
   redeploys automatically. Other branches get preview URLs.

That's all you need for the full app: Stockfish runs in the phone's browser, so no server does any
chess work.

**Optional, for the AI coach voice when hosted:** in Vercel → Project → Settings → Environment
Variables, add `ANTHROPIC_API_KEY` (or the `OPENAI_*` variables) **and** `COACH_ACCESS_TOKEN` (a long
random string), then redeploy. In the app, open Dashboard → Settings and enter the same access code
once. Without `COACH_ACCESS_TOKEN` the hosted AI coach stays disabled on purpose, so your deployment
can't be used as an open proxy to your API key.

**Add it to your iPhone Home Screen:** open the URL in **Safari** → Share → **Add to Home Screen**. It
launches full-screen with its own icon, like an app. (On Android/Chrome: menu → *Install app*.)

**Moving your history to the phone:** on your computer, Dashboard → Settings → **Export data
(JSON)**. AirDrop or email the file to yourself, then on the phone choose **Import data (JSON)** (on
the first screen, or in Settings). Import *merges*: it adds games you don't have, keeps the newer
analysis of games you have on both, never deletes anything, and never imports the AI access code.

> **iOS note:** the Home Screen app and Safari keep *separate* storage. Import your backup into the one
> you'll actually use (the Home Screen app is best, since iOS can clear Safari website data after weeks
> of not visiting, but doesn't do that to Home Screen apps). Export a backup now and then.

**What makes it production-safe:**

* **Stockfish:** the WASM engine is copied into `public/stockfish/` at install/build time and shipped
  as plain static files. It's the single-threaded build, so no special cross-origin isolation headers
  are needed, and any static host serves it. `vercel.json` caches it for a day. A small service worker
  (`public/sw.js`) keeps a copy so later analyses start instantly on mobile.
* **Refresh and direct links:** routes are hash-based (`/#/game/<id>/review`), so refreshing any screen
  works on any static host. `vercel.json` also rewrites unknown paths to `index.html`, and the app
  converts path-style URLs (`/game/...`) to hash routes.
* **Secrets:** browser code never reads API keys or `process.env`, and a test enforces that. Keys
  live only in Vercel environment variables (or your local `.env`). The coaching system prompt is fixed
  server-side; the browser only sends game facts.
* **PWA:** `manifest.webmanifest`, icons, `apple-touch-icon`, standalone display, safe-area padding
  for the iPhone notch. There's no offline mode beyond the cached engine yet.

**Other hosts:** `dist/` works on any static host (Netlify, Cloudflare Pages, GitHub Pages at a root
domain). You only lose the hosted AI coach, and the app falls back to built-in coaching automatically.


> **Server code conventions.** `api/` and `server/` run as plain Node ESM on Vercel (`"type": "module"`),
> so relative imports there must use explicit `.js` extensions (e.g. `'../server/coachApi.js'`).
> `tsconfig.api.json` checks them with Vercel's settings (NodeNext) as part of `npm run build`, and
> `tests/api-runtime.test.ts` compiles the functions that way and loads them with plain Node.

## AI instructor with Gemini (optional, personal use)

The chain stays: **Stockfish → structured chess facts → deterministic lesson selection → AI
explanation.** The AI never decides the chess; Stockfish remains the source of truth for best
moves, evaluations, lines and move quality.

- **What it explains:** for each game's 1–2 lessons (automatically) and for any other move on
  request ("Explain this more deeply"): what you were trying to do, what you missed, why the better
  move is better, the opponent's best reply, how the positions differ, a take-away, and a link to a
  recurring pattern when your recent games show one.
- **What it gets** (`src/coach/momentContext.ts`): FEN, your colour and rating, your move and its
  quality, Stockfish's top 2–3 candidates with short lines cut where they make their point, the
  evaluation before/after in words, what each line wins or loses, the line comparison, detected
  features (king safety, activity, development, structure), and recurring patterns from recent games.
- **Grounding:** the fixed system prompt (server-side) forbids moves or tactics not in the input
  and asks it to say "small or positional difference" when the facts don't show a clear reason.
  Answers are rejected if they mention any move that isn't in the game or Stockfish's lines.
- **Cache:** explanations are stored with the game (`aiExplanations`), so revisiting costs no API
  call; "Regenerate" makes a new one. If the engine analysis changes, the old one isn't reused.
- **Without it** nothing changes: the built-in coach and Stockfish work on their own.

Setup (Vercel → Settings → Environment Variables, or `.env.local` for local dev):

```
GEMINI_API_KEY=...              # from https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-flash-latest  # optional; Google's alias for the current Flash model
COACH_ACCESS_TOKEN=...          # required when hosted, so your deployment isn't an open proxy to your key
```

Then enter the same access code once in the app (Dashboard → Settings). The key is only read by
the server function (`/api/coach/complete`) and sent to Google in a header; it never reaches the
browser bundle.

Settings shows whether the AI is usable and has a **Test AI connection** button, which sends a fixed
tiny request through the whole chain (access code → server → Gemini) and shows the exact error if
any. "Explain this more deeply" appears under each item in *What hurt you*, in Replay on your
inaccurate moves and on note cards, and in the practice board; the lessons explain themselves.
Without the access code those places show a reminder instead.

### Beta AI Coach (experimental)

A separate **AI Coach · Beta** tab on each game (it can be switched off in Settings), shown next to the
unchanged built-in Summary and Guided Review so they can be compared. The roles are split:

- **Stockfish is the evidence and the referee.** It decides legality, evaluations, best moves,
  tactics, material and mates, and it grades every answer.
- **The model is the instructor.** It decides the story, the turning points, the pacing and the
  questions.

The tab has two views built from **one Game Lesson Plan**, so they always agree:

- **Game story:** the written review, with chapters, diagrams, lessons and practice positions.
- **Guided walkthrough:** the game replayed on the board with a coach's pacing:
  - most moves play straight through;
  - *brief* one-liners, and *explain* pauses at real decisions;
  - 2–4 *interactive* questions:
    - "find the move", "what is White threatening", or "which plan";
    - "which move is better", or "who is better here".

  Multi-move lessons pause *before* the decision and comment *after* the consequence ("Decision:
  19...e4 → Consequence: 21.Nxe4"). Answers are graded by Stockfish as correct / reasonable /
  misses the idea; several good moves count. "Explore this decision" opens the practice board, with
  the coach's labelled Stockfish lines.

**How it's built** (`src/coach/betaCoach.ts`, `src/coach/walkthrough.ts`):

1. **One consistent Stockfish pass.** Every position is evaluated once at depth 16, once per game
   (about a minute), kept apart from the built-in coach's analysis. Every move's effect therefore
   compares like with like.
   - A move is marked **engine unsure** where a second, faster pass disagrees by 1.5+ pawns, or
     where Stockfish's own first choice seems to swing the evaluation. That happens most in rook
     endings.
   - Unsure moves are kept out of the evaluation shifts, and no evaluative claim about them is allowed.
2. **Pass 1: the lesson planner** (`BETA_COACH_SYSTEM_PROMPT`). It receives:
   - the PGN, colour, level and result;
   - every half-move's evaluation and effect;
   - the evaluation shifts with their lead-up;
   - Stockfish's top 3 moves and lines around the moves that mattered;
   - the material, phase and structure timelines, and context from earlier games.

   It returns the plan: story, chapters, causal sequences, strengths, mistakes, lessons, interactive
   moments and practice positions. Nothing pre-selects the lessons. The prompt asks it to judge by
   the evaluation timeline (not by how active a move looks), separate decision from consequence,
   check *whose* move improved the evaluation, and credit strong play.
3. **Pass 2: the walkthrough writer** (`GUIDED_REVIEW_SYSTEM_PROMPT`). It receives the plan, the
   timeline and Stockfish's candidates at the plan's moments, and returns only the stops.
   - Options and suggested lines must be Stockfish's candidates (or the move played).
   - Pacing is capped: at most 12 brief, 7 explain and 4 interactive stops.
   - Every causal sequence in the plan gets a stop before its decision.
4. **Referee.** Each sentence of either pass is checked and removed when it:
   - names a move that isn't in the game, in Stockfish's lines, or legal at that point;
   - makes a material, tactic, mate, unstoppable-pawn or "losing" claim the data doesn't show;
   - praises a move that made the position worse, including small concessions inside a run going
     against you;
   - calls Stockfish's best move a mistake;
   - recommends a move Stockfish never put forward;
   - quotes an evaluation figure that doesn't match the timeline;
   - judges an engine-unsure move;
   - calls a draw "forced" when the opponent had better.

   Chapter titles are checked too. High-level judgements are left free.

Both passes are cached on the game: replaying the walkthrough makes no AI calls, and only
Regenerate or a change in the engine analysis writes them again. Gemini's reported token counts are
shown on the tab. "Show the Stockfish evidence the AI is given" shows the exact JSON sent in pass 1.

**Command line**, with your own key (in `.env.local` or the environment), or with recorded answers:

```bash
npm run beta-review -- game.pgn b --rating 900 --out beta-out
# no key needed: reuse recorded analysis and recorded model answers
npm run beta-review -- tests/fixtures/draw-game.pgn b --positions tests/fixtures/draw-game-positions.json \
  --plan-answer tests/fixtures/draw-game-mock-plan.json --walk-answer tests/fixtures/draw-game-mock-walk.json
```

This writes:
- `context.json` and `prompt.txt`: the pass-1 evidence and the exact pass-1 prompt;
- `walk-prompt.txt`: the exact pass-2 prompt;
- `review.md`: the plan;
- `walkthrough.json` and `walkthrough.md`: every move as skip / brief / explain / interactive, with
  the board position and Stockfish's evidence;
- `tokens.txt`: the token counts.

The regression game is `tests/fixtures/draw-game.pgn` (`tests/beta-coach.test.ts`,
`tests/walkthrough.test.ts`). The `draw-game-mock-*.json` answers are hand-written test fixtures,
not real model output.

### Training from your games (experimental)

AI Coach tab → **Training**. The question is "what weakness did this game reveal that deserves
practice away from this exact position?", not "what move did Stockfish dislike?".

1. **Diagnosis** (`src/training/diagnosis.ts`). This part is deterministic, from Stockfish's
   one-depth evaluations and the board, so the same game always gets the same diagnosis. Each
   game is scored for:

   | Category | What it looks for |
   |---|---|
   | Opening development | early drift, an early error, development lagging for the move number, a piece that walked off a guard duty, the same opening going wrong in earlier games |
   | Blunder check | material lost or a tactic allowed at once |
   | Missed tactic | a winning line you didn't play |
   | Strategic decision | the first quiet move that started a run against you, credited with half of what followed |
   | Conversion | giving back a winning advantage |
   | Endgame technique | only-moves you found (a strength to reinforce) |

   The top score is the priority; one more lesson is added only if it's a real case on its own.

   **Opening understanding vs one-off error:** an error in the opening while development was
   unfinished (pieces at home, king uncastled, a piece doing a guard job) is an
   opening-understanding problem, and you train the opening structure. The same kind of error with
   development complete is a blunder-check problem.
2. **Drills.** Each lesson gets only the positions that help, at most four:
   - the game position;
   - a position derived from the game's line (e.g. "what does Black take now?");
   - one position from another of your games with the same signal, when there is one.

   Formats depend on the skill: strategic choice, tactic, predict the threat, compare plans,
   replay a sequence and decide, why it worked, or the opening lesson. Stockfish grades every
   answer as correct / reasonable / misses the idea, and several good moves count.
3. **Opening trainer** (`src/training/opening.ts`). A line built from your own opening:
   - It keeps your moves while they're sound, and recommends something else only where Stockfish
     rated yours an inaccuracy or worse.
   - Among the moves Stockfish rates good or better, it prefers developing moves, castling, the
     centre and (with Lichess data) what players near your rating play.
   - It stops at a healthy, castled middlegame.

   You replay it from move 1: your moves are graded, alternatives that are fine are accepted,
   the idea, what's still at home and which piece is guarding what are explained, and you repeat
   it until the run is clean.
4. **Texts.** The AI coach (`TRAINING_SYSTEM_PROMPT`, one call per game, about 2–3k tokens in)
   chooses among the formats each position allows, may drop drills (never add them), and writes
   the questions, the graded feedback and the opening's "why". Everything is refereed against
   Stockfish. Without the AI, templates are used.

**Lichess opening data (optional).** The Lichess opening explorer now needs a free personal API
token. Create one at <https://lichess.org/account/oauth/token> (no scopes needed) and set
`LICHESS_TOKEN`; it stays server-side behind `/api/lichess`, which needs the same access code as
the AI coach when hosted. Responses are cached locally for a month. Rating groups are chosen near
your Chess.com rating plus about 350. Without a token the trainer uses Stockfish and development
principles.

From the command line: `npm run beta-review -- game.pgn w --training` writes `training.md`, plus
`training-prompt.txt` with the exact AI input.

## Lessons: the instructor loop

Each game gets at most **two interactive lessons**, chosen by learning value
(`priorityOf` in `src/analysis/moments.ts`): 1 your move had a concrete refutation (or gave
material back), 2 a missed winning tactic, 3 a major advantage swing, 4 a recurring personal
habit, 5 a positional decision, 6 a small inaccuracy. Everything else becomes a short **note**
shown as you pass the move, with an optional Explore.

A lesson (`src/ui/components/LessonRunner.tsx`):

1. **One question.** *Predict the opponent's strongest reply* whenever your move had a concrete
   refutation and the reply was a real choice (not forced by your check) — then *find a move that
   avoids it*. Otherwise *find the better move* (or *find the cleaner move* for small slips).
2. **Graded feedback** by quality band: **right** (best or equally good — other good moves are
   listed), **reasonable** (good / inaccuracy — what it misses, as a comparison), **refuted**
   (mistake or worse — the opponent's concrete answer and what it wins). Retry or reveal.
3. **The point.** Both lines are walked until something actually changes
   (`src/analysis/linePoint.ts`): mate, promotion, material changing hands once the exchange is
   over, queens off, a dangerous passed pawn — or called *quiet* if nothing does. A two-column
   comparison card shows the evaluation band and the concrete differences for each line.
4. **Take-away**, plus Explore for the full practice board.

Evaluation is shown in words with a small bar (`src/analysis/evalBand.ts`): Winning / Clearly
better / Slightly better / Equal / … and the swing ("Clearly better → Equal: this gave back most of
your advantage"). No draw percentages or decimals in the main view — Stockfish's win/draw/loss
model is calibrated on engine play, so it would be false precision here.

## Practice board and line comparison

Inside Guided Review, any of your moves that wasn't Stockfish's choice (and every teaching
moment) opens a practice board:

1. The position before the move, with the move played (orange) and Stockfish's choice (green).
2. **Move quality bands** (`src/analysis/moveQuality.ts`), from the MultiPV lines: *best*,
   *equally good* (within 2.5 win% of the top move — engine noise at these depths), *good but
   less precise* (< 6), *inaccuracy* (< 12), *mistake* (< 22), *blunder*. Moves in the equal band
   are listed as "just as good", and a move is never called wrong for not being #1.
3. Both lines, cut to the **shortest stretch that shows the difference** (with a "longer line"
   option), never stopping in the middle of an exchange.
4. **Try your own move**: Stockfish answers, you continue for up to 3 moves, then compare.
5. **Comparison in chess terms** (`src/analysis/compareLines.ts`): the end positions of the two
   lines are compared on material (what each side gave up, with like-for-like trades cancelled),
   king safety, development, piece and queen activity, pawn weaknesses, passed pawns, rooks on
   open files, pieces that actually fall, and queen trades. A feature is only mentioned when the
   difference is clear and still holds at the end of the line; material only when the evaluation
   agrees (otherwise it's a sacrifice with compensation). Forced mates are described as mates.
   When nothing concrete explains the gap, it says so instead of inventing a reason.

**Deeper analysis for critical moments.** Ordinary moves keep the fast depth-12 pass. After the
first coaching pass, the positions around each teaching moment are re-analysed at depth 18 with
three candidate moves and the game is coached again from those evaluations
(`deepenCritical` in `src/analysis/pipeline.ts`). Other positions opened in the practice board
are deepened live in the browser.

## Chess.com sync (optional)

Dashboard → **Chess.com** → enter your username → **Sync Chess.com**. No login: it uses
Chess.com's public Published-Data API.

- **What it reads.** The list of your monthly archives, then only the months that overlap the
  sync window (30 days by default, or 90). Months that have finished are read once per filter
  setting and never again; the current month is re-checked on each sync. A sync within a minute
  of the last one makes no requests. There is no background polling.
- **What it imports.** Standard chess only (no Chess960 or custom starting positions), Rapid by
  default (Blitz, Bullet and Daily can be switched on). Your side is found by matching your
  username case-insensitively. At most 10 new games per sync, Rapid first; the rest come next time.
- **Same pipeline as pasted games.** Synced games go through the same `importGame` → Stockfish →
  coaching path and the same duplicate check (`src/chess/fingerprint.ts`): the Chess.com game id
  when there is one, otherwise the exact move list (short games also need the same date). Pasting
  a game you've already synced (or syncing one you pasted) opens the existing game instead.
- **Requests.** They go through a tiny read-only proxy (`/api/chesscom`, `server/chesscomProxy.ts`)
  that only forwards the two endpoints above and sends an identifying User-Agent, as Chess.com
  asks — set `CHESSCOM_CONTACT` (an email or URL) in Vercel. Without the proxy (e.g. a static
  host) the browser calls the public API directly. Requests are serial; a 429 shows "try again
  later".
- Manual PGN import stays available as a fallback.

## User flow

1. **Import** – paste a PGN. Players, colours, ratings, result, date and moves are parsed (smart quotes,
   `0-0`, `%clk` comments handled). The app remembers your usernames and pre-selects "me" next time.
2. **Summary** – a headline and a one-line story of the game, ≤3 *did well*, ≤3 *hurt you*, recurring
   pattern, one focus, plus optional "smaller notes". Each point comes with **board diagrams** of the key
   positions (orange arrow = your move, green = the better move, with a caption). Tap a diagram to
   replay that moment.
3. **Guided review** – play through the game move by move with a horizontal move strip on top
   (swipe it, tap any move, or use ‹ › / arrow keys). The review **stops before each critical move**
   and turns it into a Guided Moment, so you meet it in the flow of the game. The question sits
   directly above the board and a clear ✓ / ✗ verdict directly below it. On phones the strip, question,
   board and verdict stay in one screen, so you never have to scroll to find out whether you were right.
   Steps: what you were probably trying to do → *predict the opponent's reply* or *find a better move*
   on the board (retry allowed) → the actual continuation animated with arrows → the lesson → continue
   the game. If you made the same kind of mistake in an earlier game, a "You've seen this before" note
   links to that position. Moves and squares in the coaching text light up on the board when you hover
   or touch them.
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
  analysis/      evaluation.ts   cp/mate → win%, eval change, practical drop (cp-based when ahead)
                 analyzeGame.ts  engine over every position → MoveEval facts
                 context.ts      per-move context: ahead/behind, king pressure, endgame, pawn race
                 detectors.ts    deterministic pattern detectors → Findings
                 moments.ts      significance layer → TeachingMoments
                 pipeline.ts     orchestration + history (prior games)
  coach/         templates.ts (built-in voice), report.ts (summary, story, recurrence), llmCoach.ts,
                 llmClient.ts, systemPrompt.ts
  drills/        generate.ts
  profile/       identify.ts (who is "me"), profile.ts (cross-game aggregation)
  storage/       repository.ts (CoachRepository interface + localStorage implementation)
  ui/            React screens/components
server/          llm.ts (providers), coachApi.ts (shared proxy logic + access token), coachPlugin.ts (Vite
                 middleware for dev/preview), nodeEngine.ts (Stockfish for tests/CLI)
api/coach/       status.ts, complete.ts — Vercel Functions wrapping server/coachApi.ts
public/          manifest.webmanifest, sw.js, icons/ (Stockfish is copied in at install time)
tests/           Vitest suites + recorded Stockfish output (Node and browser) for the test games
```

The data flow is a straight pipeline:

```
PGN → plies (FEN before/after each move)
    → Stockfish: every position, MultiPV 3            (objective facts)
    → MoveEval: eval before/after, win% drop, practical drop, best line, reply line, material after lines
    → context: far ahead? behind? king under pressure? attacking? endgame? pawn race?
    → detectors: Findings (category, severity, confidence, evidence, structured facts)
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
facts. Each produces a `Finding` with a severity (1 = soft note, 2 = notable, 3 = serious), a
**confidence** (high / medium / low), plain-English evidence, and structured facts for the templates
and the LLM.

**Practical drop, not just win%.** In balanced positions the cost of a move is measured by the drop in
win probability. But once you're clearly ahead (+3 or more, or 3+ points of material up), win% flattens:
going from +8 to +5 barely changes it, even though you've given back three pawns' worth. In those
positions the coach also measures centipawn loss (20cp ≈ 1 point), and losing a whole piece counts as
serious whatever the eval says. The exception: if the position stays crushing and no material is
lost (e.g. missing a mate-in-4 while a queen up), it isn't treated as a lesson.

**Context.** For every one of your moves the coach knows whether you were materially far ahead, behind,
under king pressure, attacking an exposed king, in an endgame, or in a pawn race. It uses settled
material, not the mid-exchange count. Context decides what's instructive: when far ahead, giving
material back and allowing counterplay matter much more than a lost tempo, and a bishop going there
and back is not the lesson.

Examples:

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
| Giving material back when ahead | Ahead by 3+, your move loses ≥2 points of material (serious if the practical drop is ≥8 or a whole piece goes) |
| Unnecessary complications | Ahead, and you hand back more than you take (e.g. an exchange sacrifice) when a simple move kept everything |
| Hunting material instead of consolidating | Ahead, grabbing pawns with the queen or a lone piece while pieces are undeveloped and/or the king is in the centre |
| Allowing avoidable counterplay | Ahead, and your move lets the opponent start checking your king or activate pieces against it (flags forced-draw situations) |
| Not trading down when ahead | Ahead with queens on, a near-best engine line trades queens (or captures a piece) and you kept everything on |
| Endgame / pawn race | A practical drop of ≥12 in an endgame; if a passed pawn exists and the better move supports it, the lesson is about the pawn |
| King safety, development, trades, clock usage | See source. Development and king safety are framed differently when you were already ahead |

**Credits** (strengths) include: castling early, development, central control, no hanging pieces,
opening lines against an uncastled king, **winning genuinely free material** (net gain compared with
before the opponent's last move, so recaptures don't count), **simplifying when ahead**, **finding a
forcing defensive resource** (the only move that holds, under pressure), **creating a dangerous passed
pawn** (and promoting it), and **neutralising counterplay** (e.g. trading queens to end an attack).

**Confidence.** *High* means engine-backed and concrete (material lost, a perpetual allowed, a missed
tactic). *Medium* means credible but softer. *Low* means a speculative pattern match: a round trip while
far ahead, a check that merely wasn't the best move, a "missed attack" with a small drop. Low-confidence
findings are stored but **never** appear in the summary, teaching moments, focus, or cross-game
pattern counts.

**Why the better move is better** (`src/analysis/movePurpose.ts`, `src/analysis/explain.ts`). For every
credible mistake the coach builds a three-part explanation from board facts:

1. *What your move was going for* — only what is visible on the board after the move (it attacks the
   loose queen on e6, it gives check, it takes the pawn on a7).
2. *What went wrong* — a concrete problem (Black wins your bishop with Qxd4; Black can start checking
   your king with Qg4+; the knight had to go back; pawns in front of your king loosened; a doubled or
   isolated pawn) → a **mistake**. If nothing concrete went wrong but a stronger move existed, it's a
   **missed chance**.
3. *Why the better move is better* — the engine move's purposes, stated in plain words: wins material
   (net of recaptures), double attack, removes the defender, moves a loose piece to safety or protects
   it, takes away a threat that already existed, gives the king an escape square so the checks run out,
   develops / castles, rook to an open or half-open file, a pawn move that opens a file or a bishop's
   diagonal, brings a passive piece into play, trades queens or pieces when ahead (only if no material is
   lost), trades off an active enemy piece, leaves the opponent without checks, pushes / creates /
   supports a passed pawn, blockades theirs. Each purpose has a confidence; only what the better move
   does *that your move didn't* is mentioned, and if nothing reliable distinguishes them, the reason is
   omitted rather than guessed. A short engine line (≤3 moves) is shown only when it makes the reason
   concrete (e.g. a fork that wins a piece two moves later).

The guided review shows the verdict with this "why", the lesson step lays out all three parts, the
moment tag says *Mistake* or *Missed chance*, and summary diagrams use them as captions.

**Positional detectors** (conservative): a pawn capture/recapture that leaves doubled or isolated pawns
when the engine's choice didn't (and it cost something), a piece with ≤2 squares for 5+ moves while the
engine repeatedly wanted to activate it, loosened king cover, passed pawns, and credit for rooks on open
files. Space/activity *comparisons* between the two sides were left out: they weren't reliable enough
to coach from.

**Significance layer** (`src/analysis/moments.ts`): `score = Σ category weight × severity × 10 ×
(1 for high confidence, 0.75 for medium) + 0.8 × practical drop (ignored below 6) + 5 × prior games with
the same category (max 3)`, counting only credible findings. Moments need a
score ≥18; the top 3 are kept plus one positive "good idea". So 11.Nb5 in the sample (engine drop ≈1%)
becomes a moment because of the round trip, while tiny engine preferences never do.

**Themes and focus**: categories roll up into themes (e.g. *active-looking moves without a follow-up*,
*converting when ahead*, *loose pieces*). A theme has **strong evidence** in a game when it has one
high-confidence finding or two credible ones. The next-game focus is chosen only from strongly evidenced
themes in *this* game. History can tip the balance between them, but can never promote a weak match.

**Honesty about patterns**: one game = "possible tendency". The report and dashboard say "appeared in
N of your last M games" only when the current game has strong evidence and earlier games had credible
findings of the same theme. If an old pattern only faintly resembles something in a new game, it is
left out, and the report notes that it "didn't clearly show up this time". Severity-1 notes never form a
pattern. The summary also opens with a short **story** of the game (e.g. "You were up a rook from move
9, but the lead shrank to a pawn by move 35…").

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

Keys are read only server-side: by the local Vite dev/preview server (`server/coachPlugin.ts`) or, when
hosted, by the Vercel Functions in `api/coach/` (see *Deploy it*). Both use `server/coachApi.ts`, which
exposes `/api/coach/status` and `/api/coach/complete`, fixes the system prompt server-side, caps prompt
size, and (when hosted) requires `COACH_ACCESS_TOKEN`. Keys are never bundled into browser code. The
Anthropic provider uses the official SDK with low effort and server-side refusal fallbacks enabled.

The LLM is **not** the chess engine. It receives structured, verified context — rating, PGN, FENs,
played/best moves, lines, evals, material changes, findings, the current weakness profile — and is asked
only to phrase the coaching. Its JSON response is validated: any text that mentions a piece move or
capture not present in the game/engine lines is discarded and the template text is kept. Low-confidence
findings are not sent to the LLM at all, and the prompt includes the per-move context. Board arrows
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
Dashboard → Settings → *Export data* downloads a JSON backup; *Import data* merges one back in (see *Deploy
it* for moving between devices). The AI access code is stored locally and excluded from exports.

## Tests

`npm test` covers PGN parsing, board-state reconstruction, evaluation-change maths, UCI parsing,
player identification, recurring-pattern aggregation, the coaching pipeline on the sample game
(using recorded Stockfish output, so it's deterministic), LLM output validation/merging, storage
round-trips and backup merging, practical drop and position context, coaching a game where you're far
ahead (from recorded Node *and* browser Stockfish output, so the conclusions are checked for engine
variance), recurring patterns not being forced onto new games, the hosted LLM proxy and Vercel
functions (access token, fixed system prompt, size limits), a check that browser code never touches
secrets, and one integration test that runs real Stockfish over the sample game.

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
* The hosted AI coach needs Vercel (or the local dev/preview server). Other static hosts fall back to
  built-in coaching.
* Data lives per browser. Moving between devices is manual (Export → Import), and on iOS the Home
  Screen app and Safari have separate storage.
* "Context" heuristics (king pressure, race) are approximations; they steer what's highlighted, not the
  engine facts.

## Recommended next improvements

1. Import directly from Chess.com/Lichess usernames (public APIs) and batch-analyze recent games.
2. IndexedDB or Supabase storage; automatic sync across devices (replacing manual export/import).
3. Spaced repetition for drills (schedule misses sooner) and drills pulled from *recurring* categories.
4. More detectors: overloaded defenders, pins/forks taxonomy, pawn-structure basics, rook activity.
5. Per-moment "ask the coach" follow-up questions via the LLM, grounded on the same facts.
6. Opening-phase summary per opening you play (without becoming an opening explorer).
7. Calibrate thresholds per rating band using a corpus of real games.
