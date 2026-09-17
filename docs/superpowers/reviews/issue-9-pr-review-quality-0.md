# PR #27 — code quality review, pass 0

Branch `fix/9-artifact-paths`, diff against `6008bce`. Scope: code quality only — whether the
change is written the way this codebase is already written. Completeness against issue #9 and the
spec was settled in `docs/superpowers/reviews/issue-9-pr-review-intent-0.md` (CLEAR) and is not
re-litigated here.

Verified locally: `bun test` — 368 pass, 0 fail, 33 files; `bun run typecheck` — clean.

## What holds up

- The adoption branch in `gatherSignals` reuses the existing shape rather than inventing one:
  `src/supervisor/tasks.ts:237-270` keeps the `return base` early-exit ladder every other case in
  that switch uses, and writing `task.pr` on discovery at `src/supervisor/tasks.ts:226` is the
  precedent for mutating the task inside a signal gatherer, so `task.artifacts[slot] = adopted`
  is not a new liberty.
- `console.error('[pipeline] …')` at `src/supervisor/tasks.ts:198-201` matches the log prefix and
  the `console.error` channel used throughout `src/supervisor/main.ts:161,219,233`.
- No dead code, no commented-out code, and — importantly for this repo — no comment in the diff
  paraphrases the line under it. Every new comment states a non-obvious *why* (the `-z` quoting
  note at `src/supervisor/deliver.ts:140`, "Stale is not missing" at `src/supervisor/tasks.ts:242`,
  "Recorded, not merely accepted" at `src/supervisor/tasks.ts:266`). That is the house standard
  set by `src/lib/predicates.ts:12-15,38-41`.
- Error handling in the new `git()` runner degrades to a non-ok result instead of throwing, which
  is exactly the contract `Gh.run` (`src/lib/gh.ts:30-42`) and `Herdr` (`src/lib/herdr.ts:32-37`)
  hold for the same reason.
- The tests are designed, not decorative. Each one pins a specific decision in the diff rather
  than the happy path: the fixture in `test/helpers/git-worktree.ts:24-39` builds a *real* linked
  worktree so the mtime precondition that motivates the whole change is actually present;
  `test/deliver.test.ts:308-317` sets `diff.renames=false` in the fixture repo, which is the only
  way the `-c diff.renames=true` pin at `src/supervisor/deliver.ts:121` can be proven to do
  anything; `test/tasks.test.ts:393-407` proves stale-is-not-missing;
  `test/tasks.test.ts:409-433` drives three ticks to prove the log fires once. The negative
  assertion style in `test/cli-commands.test.ts:331` has precedent
  (`test/prompts.test.ts:56`, `test/table.test.ts:75-76`, `test/status.test.ts:113-116`).

## MAJOR — `ambiguityLog` introduces a second mechanism for cross-tick dedup state

`src/supervisor/tasks.ts:32-37` adds `ambiguityLog?: Set<string>` as the only optional field on
`TaskDeps`, backed by a module-level mutable default at `src/supervisor/tasks.ts:192` and resolved
at `src/supervisor/tasks.ts:260` with `deps.ambiguityLog ?? defaultAmbiguityLog`.

This repo already has this exact concern solved one way. Every piece of state that must survive a
tick lives in `main()`'s loop scope and is passed explicitly: `const probed = new Set<string>()`
and `const attempts = new Map<string, number>()` at `src/supervisor/main.ts:107-109`, handed to
`sendProbes(…, probed, …)` at `src/supervisor/main.ts:238-239,254-255` and to `stallCandidates`
via its declared `alreadyProbed: Set<string>` parameter (`src/supervisor/stall.ts:29`). Nothing in
`src/supervisor/stall.ts` keeps a module-level fallback; the owner is `main()`, always.

Two consequences, not just an aesthetic mismatch:

- `src/supervisor/main.ts:176-193` builds `TaskDeps` without `ambiguityLog`, so the production
  path runs on the module global while every test runs on an injected set. The wired path is
  therefore the one path no test exercises — the same class of gap recorded for this repo as
  "DI hides wiring bugs" (unit tests with fakes missing live-only wiring).
- The comment at `src/supervisor/tasks.ts:189-191` ("Ownership differs too — `alreadyProbed` is
  threaded from main.ts, while this is a module default…") documents the divergence rather than
  removing it. A comment explaining why this one is different from its sibling is the signal that
  it should not be.

Fix inline, mechanically: make `ambiguityLog: Set<string>` required, declare it next to `probed`
at `src/supervisor/main.ts:109`, pass it in the `advanceTasks` deps literal, and delete
`defaultAmbiguityLog` together with the paragraph defending it. `deps()` in
`test/tasks.test.ts:32-44` gains one line and the existing ambiguity test keeps working unchanged.
No decision is reversed and no scope changes.

## MINOR — `logAmbiguous` hand-rolls a key that `taskStallKey` already produces

`src/supervisor/tasks.ts:195` builds `${task.task_id}:${task.phase}:${task.phase_entered_at}`.
`taskStallKey` at `src/supervisor/stall.ts:62-64` builds
`${run.run_id}:${task.task_id}:${task.phase}:${task.phase_entered_at}` and is already exported.
`gatherSignals` has `run` in scope (`src/supervisor/tasks.ts:204`), so dropping `run_id` bought
nothing and cost the caveat at `src/supervisor/tasks.ts:186-188` explaining which collisions are
"tolerable". Either pass `run` through and call `taskStallKey(run, task)`, or at minimum include
`run.run_id` — both make three lines of comment unnecessary. (Reusing a stall-named helper for a
log dedup is a slight naming stretch; including `run_id` inline is the smaller change and is
equally acceptable.)

## MINOR — the `git()` runner diverges from the mirror it cites, and sits away from its siblings

`src/supervisor/deliver.ts:112-130`:

- The comment claims it "Mirrors Gh.run in ../lib/gh.ts", but it returns `text: ''` on a throw
  where `Gh.run` returns `String(error)` (`src/lib/gh.ts:40`), and it uses `stderr: 'ignore'`
  where `Gh.run` uses `'pipe'`. Both choices are defensible here; the claim of mirroring is what
  is inaccurate.
- The copied rationale is half wrong for this call site. The helper passes no `cwd` — it uses
  `git -C checkoutPath` — so "a cwd that doesn't exist" cannot throw here; git exits non-zero
  instead, which is what actually makes `test/deliver.test.ts:271-273` pass. Only the
  missing-binary half of the comment is live. Trim it to what applies.
- Placement: the other two process runners in this repo are classes in `src/lib/`
  (`src/lib/gh.ts`, `src/lib/herdr.ts`). This one is a free function inside a supervisor module
  whose subject is digests and deliveries. `src/cli.ts:346` and `src/actions/claim.ts:14` each
  already hand-roll `git rev-parse --show-toplevel`, so `src/lib/git.ts` was the sibling-shaped
  home and would have absorbed those two as well. Not worth a refactor in this PR, but the third
  copy of "spawn git inline" is the point at which the pattern should be named.

## MINOR — the two new module constants in `deliver.ts` sit awkwardly beside existing literals

- `REVIEWS_PREFIX` (`src/supervisor/deliver.ts:110`) is the fourth spelling of the same directory
  in the codebase and the third in this one file: `src/supervisor/deliver.ts:90` and
  `src/supervisor/deliver.ts:93` both `join('docs/superpowers/reviews', …)` twenty lines above it
  (with `src/cli.ts:89-91` doing the same for the other three dirs). Introducing the constant is
  an improvement; leaving the two literals directly above it is the inconsistency. Either use it
  at `:90`/`:93` or accept the file's existing literal style.
- `ARTIFACT_BASE_REF` (`src/supervisor/deliver.ts:105`) is `export`ed but has no consumer outside
  its own module (`grep -rn ARTIFACT_BASE_REF src/ test/` → three hits, all in `deliver.ts`).
  `REVIEWS_PREFIX`, added in the same commit for the same kind of purpose, is not exported. Drop
  the `export` or reference it from `test/deliver.test.ts:275-285`, which currently hardcodes
  `--initial-branch=trunk` to mean "not the base ref".

## MINOR — the null-checkout condition is gated twice

`src/supervisor/deliver.ts:142-148` takes `checkoutPath: string | null` and returns `[]` on null,
and `src/supervisor/tasks.ts:250` already returns before calling when `checkout === null`. From
the sole production caller the callee's branch is unreachable; it is kept alive only by the direct
unit test at `test/deliver.test.ts:267-269`, while the caller's gate has its own test at
`test/tasks.test.ts:435-446`. The defensive reading is legitimate — `absoluteArtifactPath`
(`src/supervisor/deliver.ts:100`) does fall back to `run.repo_root`, so a future caller could
plausibly do the same — but then the guard belongs in one place. Narrowing the parameter to
`string` and letting the caller's existing check be the single gate is the smaller surface.

## MINOR — comment volume around `defaultAmbiguityLog`, and new line-number citations

- Nine comment lines (`src/supervisor/tasks.ts:183-191`) precede a one-line `new Set<string>()`,
  and the last three restate the JSDoc already on `TaskDeps.ambiguityLog`
  (`src/supervisor/tasks.ts:32-37`). The same rationale in two places is the drift case this
  repo's convention warns about; keep it on the interface, where a caller reads it. Most of this
  block disappears if the MAJOR above is fixed.
- The diff introduces line-number citations in comments: `(src/supervisor/stall.ts:62-64)` at
  `src/supervisor/tasks.ts:185` and `(read at :89 and :93, written nowhere)` at
  `src/supervisor/deliver.ts:108`. `git grep` over the merge-base finds no precedent for this in
  `src/` — existing comments name symbols and files instead (`src/supervisor/tasks.ts:41`,
  `src/lib/predicates.ts:24-25`). This PR alone shifted `deliver.ts` by ~60 lines; cite
  `taskStallKey` and `artifactPathFor` by name so the reference survives the next edit.

## MINOR — test hook placement and a now-duplicated fixture builder

- `afterEach(cleanupFixtures)` is registered mid-file at `test/tasks.test.ts:313` and
  `test/deliver.test.ts:253`, after ~300 lines of existing tests. Every other test file in the
  repo registers hooks immediately after the imports (`test/rebind.test.ts:12-13`,
  `test/pidfile.test.ts:8-9`, `test/store.test.ts:8-9`, `test/cli-commands.test.ts:16-27`,
  `test/startup.test.ts`). Behaviour is the same — bun applies a module-scope hook to every test
  in the file — but mid-file placement reads as if it were scoped to the tests below it. Move
  both to the top.
- `test/tasks.test.ts` now holds two temp-worktree constructors: the pre-existing
  `worktreeWith` (`test/tasks.test.ts:248-253`, which `mkdtempSync`es and never cleans up) and
  the imported `repoWithWorktree`. The leak predates this PR, but the new helper exports
  `tempDir` (`test/helpers/git-worktree.ts:12-16`), so pointing `worktreeWith` at it is a
  one-line change that collapses the two ways back into one.

VERDICT: CLEAR
BLOCKERS: 0
MAJORS: 1
