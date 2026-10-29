# Ground truth: chunkmonkey420 key moments (v4)

`ground-truth.json` is a hand-verified test set for Passed Pawn's move analysis.
Each moment was found by Stockfish (depth 14) and its *mechanism* (why the move lost or what was missed) was checked with deeper lines (depth 18+).
These are real games from chunkmonkey420, so treat the labels as a regression suite, not training data.

## What's in it
- `moments[]`: 64 labeled moves from 55 games, each with:
  - the FEN before the move, the move played, the engine's best move, and the opponent's best reply;
  - a `kind` (mistake or missed opportunity), a `primary_label`, `secondary_labels`, and a `mechanism` written in plain words;
  - an `expected_lesson`, a `must_not_label` list (wrong generic labels), and a `confidence`;
  - a `split`: `tune` (28) or `holdout` (36).
- `clean_games[]`: 5 games with no real mistakes. The app must not invent a "you hang pieces" or "develop faster" lesson for these.
- `games[]`: the full movetext and result for every game referenced, plus `expected_summary` for Drearydoc and Atayan48.
- `label_definitions`: the taxonomy. Add labels only when a new mechanism truly doesn't fit one of these.

## How to use it
1. Write a test (e.g. `npm run truth`) that loads each game, runs the app's own analysis plus its detectors, and finds the move at `ply`.
2. Score each moment:
   - **1** if the app's primary label equals `primary_label`;
   - **0.5** if it matches one of the `secondary_labels`;
   - **0** for `unclassified`;
   - **hard fail** if the label is listed in `must_not_label`.
3. Report accuracy for `tune` and `holdout` separately, plus per-label precision and recall.
4. **Tune only on `tune`.** Look at `holdout` only to measure. If holdout accuracy is much worse than tune, the detectors are overfit (written for these games, not for the pattern).
5. No game-specific rules (no "if opponent == Drearydoc"). Every rule must describe a board pattern.
6. "Unclassified" is better than a wrong label. A summary built on the wrong root cause is the main failure to prevent.

## Notes
- Engine numbers will differ slightly from the app's engine depth. Match on ply/SAN, not on exact centipawns.
- `Sparrrowfalls 27.Qxb5` only shows up as a mistake at depth ≥ 18. If the app runs shallower, it's allowed to miss it (score 0, not a fail).
- **Correction:** in Drearydoc, **12.f3 was Stockfish's top move**. The root cause is 13.Nh3 (pawn fork after ...exf3 Rxf3 g4), then 16.Bxg4. Any earlier regression test that blamed 12.f3 for "loosening the kingside" is wrong and should be replaced by `expected_summary` here.
- **v4:** Added the Oct 29 game vs rushikeshdantakale as a tune game (it has been discussed openly, so it is not holdout). It also checks two summary rules: count material only once captures settle, and never criticize a move that is the engine's top choice at deeper depth.
- **v3:** RA_Recto 22...g6, akash-264 34.Qe2 and maladly 18...a5 were unsealed for debugging and moved to `tune`. 26 fresh `holdout` moments were added from games that hadn't been labeled before, so holdout is now larger than tune on purpose: it's the honest measure. Don't use them to design rules. Report the holdout totals only, plus per-label totals for labels with at least 3 holdout moments.
- **v2:** sir-Deniy 17...Qb6+ relabeled from `removed_defender` to `threat_ignored` (the rook was already attacked; the queen never guarded it). Ground-truth fixes like this are allowed, but only when the mechanism is verified on the board, never to make a score go up.
- Add new games as they're reviewed. Put roughly one in three into `holdout`, chosen before looking at what the app says about them.

## Running it in this repo
- `npm run truth` scores the app against this file, using the cached engine output in `positions/`. It needs no engine and gives the same result every time. Holdout shows only totals and per-label totals (labels with 3+ holdout moments).
- `npm run truth -- --verbose` also prints every tune moment's label, the app's evidence and lesson, and how it was scored.
- `npm run truth:engine` refreshes `positions/` with the app's own engine pass: depth 12 for every move, then depth 18 around the critical moments, as in the app. Run it after adding games here, or after changing the engine pass. Pass `-- --force` to redo games that already have a cache. Each game gets a fresh engine, so the cache is the same on every run.
