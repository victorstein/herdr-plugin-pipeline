Tier: heavy

# herdr-pl-4 PR review 0 — PR #178, `feat/board-staging`

Reviewed against the brief (`hpipe brief --task t4`), the spec
(`docs/superpowers/specs/2026-11-14-herdr-pl-4-design.md`), the plan
(`docs/superpowers/plans/2026-11-14-herdr-pl-4-plan.md`) and pasture's `src/board.ts`. Code diff is
against `origin/main` (merge base `cad73da`; `origin/main` has since gained only the 2.4.0 release
commit, and `git merge-tree` merges cleanly).

Verification run here: `bunx tsc --noEmit` clean. `bun test` passed 2410/0 on two of three full runs.
The first run had one failure that did not repeat, and `test/board-stage.test.ts` plus
`test/board-view.test.ts` passed 5 out of 5 runs on their own. The failure is most likely the known
load-sensitive test filed as `t1/x2` ("cli-argv --help test times out under load"), not this PR.

## Intent

**Brief items:**

1. **`enter`**: done.
   - `src/board/ui.ts:212` accepts both `\r` and `\n`.
   - `stageWorker` (`ui.ts:158-173`) builds the host from the snapshot with `boardHost`, picks the pane
     with `workerFor`, and calls `stageCard`.
   - `stageCard` calls `stageAgent(herdr, freshSnapshot, host, identity, current, terminalId)`
     (`src/board/stage.ts:62`) and records `{ ...staged, host }`.
   - A run card, an unbound task and a gone pane give `no worker to stage`, and so does the
     orchestrator's pane (`stage.ts:21`). `StageError` text reaches the status line through `serial`'s
     catch.
   - The record is written with a guarded `updateBoards` rather than `recordStaged`. That departs from
     the brief's wording, but spec review 0 (MINOR 1) asked for it and the spec explains why
     (`recordStaged` only checks that a record exists). A completed move is undone if the record was
     replaced meanwhile. This is stricter than the brief, not a cut.
2. **`tab` / `z`**: `ui.ts:175-185` is a line-for-line copy of pasture's `stagedPane`, `focusStage`
   and `zoomStage`. After staging, the snapshot is read again (`ui.ts:171`, as pasture's `stage` does),
   so `enter tab` sent in one chunk focuses the moved pane.
3. **Reconcile on every refresh**: done in `syncStage` (`stage.ts:32-47`). It is called last in
   `refresh` and in both the run and no-run branches (`ui.ts:54-57`).
   - A stage left by an earlier board is undone with `unstageBoard`.
   - Otherwise the kit's `reconcile` runs, and the result is written back only when the JSON differs,
     with `expected` set so a stage the supervisor cleared is not brought back.
   - A board whose record names another pane touches nothing (A12), which goes beyond the brief and is
     justified in the spec.
4. **Quit**: `q`, ctrl+c, stdin `end`/`error`, SIGHUP, and now stdout `error`, all go through
   `quit()`. It runs `unstageOwn` on `serial`, ignores errors, then exits (`ui.ts:188-199`).
   - The PR reports, with a measurement, that on a pane close herdr's SIGTERM arrives before the
     unstage finishes.
   - The supervisor's `syncBoards` (`src/supervisor/boards.ts:110`) and the next board's first refresh
     recover that case. It is filed as `t4/x2`. This is a disclosed limit of herdr, not something the
     PR silently drops.
5. **Manifest**: the `placeholder` pane in `herdr-plugin.toml` is identical to pasture's. It is
   asserted in `test/prompts.test.ts`.
6. **Keys line**: `src/board/view.ts:10`.
   - The PR drops the arrow glyphs and shortens `orchestrator` to `orch` to make room. The README
     still documents arrows.
   - At 120 columns with a typical summary, `x clear` is cut. The spec (A14) and the PR body both say
     so, and the stage keys come right after `move` so they survive down to about 80 columns.
   - This is an acceptable, disclosed reading of "short enough for the board's bottom row".
7. **README / skill**: the README key table and the paragraph that called the board read-only are
   updated. `skills/herdr-pipeline/` lists no board keys: the only board mention is `SKILL.md:164`, a
   recovery row. So leaving it unchanged is correct, not a scope cut.

**Acceptance criteria:**

- **Unit tests for the extracted pure parts** (`test/board-stage.test.ts`, 17 tests):
  - `boardHost`;
  - `workerFor`: run card, unbound task, gone pane, no run, orchestrator, and a worker on another
    stage or under this board;
  - `syncStage`, `stageCard` and `unstageOwn`.
- **25/75 split**: asserted (`STAGE_MOVE`, `ratio: 0.25`).
- **The first worker goes home first**: asserted by call order (`board-stage.test.ts:198-206`).
- **Manifest, keys and README**: done.
- **tsc and tests**: green.

**Spec and plan:** `ui.ts` matches plan Task 7 step for step. The helpers match spec "Architecture"
and A1–A19. The new guard that refuses a worker on another stage (`ELSEWHERE`, A17) comes from the
parent spec's "one stager owns pipeline panes" rule, which spec review 0 MAJOR 3 asked for. It is in
scope, not an expansion.

**Live check:** the PR states what it covered and what it did not.
- The supervisor's rebind was not run live, because no branch supervisor ran in the scratch session.
- The placeholder came from pasture's identical kit file, because herdr's plugin registry is global.

The PR explains both, and both follow from the plan's own Task 9. They do not count against it.

**Tests vs implementation:** the tests drive the real record file and the kit's fake herdr, and assert
outcomes: the order of moves, the record's contents, and that nothing is written for an unchanged
stage (checked through the file's inode). They include the race cases: a record replaced while the
worker moves, and the supervisor clearing the stage while the board reconciles. They do not restate
the code.

No silent scope reduction, and no expansion beyond the brief and parent spec. The scope departures
are listed in the PR body.

## Quality

- **Mirrors existing patterns:**
  - Focus, zoom, the stage re-read and the reconcile compare are pasture's, as the brief asked.
  - `src/board/stage.ts` follows `src/board/data.ts`: small exported functions taking explicit
    arguments, imported by the UI.
  - The tests follow `test/boards-stage.test.ts`: a temp state dir and `fakeHerdr`.
  - Errors take the board's established route: thrown `StageError`/`HerdrError` text lands in
    `message` through `serial`, and refusals are plain status strings as `peekWorker` does.
- **No `src/kit/` edits**, and no change to `src/lib/boards.ts`.
- **The `buildFor` extraction** is a straight move of the old `refresh` body, so the reconcile can run
  in both branches. Behaviour is unchanged.
- **Comments** are why-comments: replaced boards, the snapshot reasoning, `\n` from herdr, and keys cut
  from the right. None restates the next line. No dead or commented-out code.
- **Small duplication:** `workerFor`'s task→pane lookup (`stage.ts:19-20`) repeats `peekWorker`'s
  (`ui.ts:128-129`), and `boardHost` repeats the self-lookup in `visible()`. The messages and
  semantics differ, and the lines are trivial. Not worth a finding.
- **Naming** is consistent with nearby code. `ui.ts`'s `stagedPane` shares a name with a private
  helper in `src/lib/boards.ts`, but that helper is module-private and the name matches pasture's.

## Findings

1. **MINOR**: the doc comment on `syncStage` covers only one direction of the race it defends against.
   - **The comment**: `src/board/stage.ts:27-31` says the caller's older snapshot "can never show the
     worker gone while the record still holds it". That is true.
   - **The opposite case**: the snapshot can show the worker still under the board after `unstageBoard`
     (Open board, `syncBoards`) or `closeStagedWorker` (teardown) has already cleared the record. That
     happens when those run between `refresh`'s `readSnapshot` (`ui.ts:50`) and `syncStage`'s
     `readBoards` (`stage.ts:35`).
   - **What happens then**: `recorded` is `null`, so `reconcile` sees the departed worker as the
     single stray under the board and adopts it, with its home set to the pipeline workspace and no
     placeholder (`src/kit/stage.ts:69-72,153`). `recordStaged(…, expected = null)` accepts the write
     (`stage.ts:45`, `src/lib/boards.ts:87`).
   - **Why it is harmless today**: the next refresh drops the adopted stage, because the pane is no
     longer under the board. Open board's `openBoard` overwrites the record anyway.
   - **Why it matters**: the comment reads as if the `expected` guard closes the race in both
     directions, and a later change that trusts that could turn the transient adoption into a real
     move.
   - **Fix**: widen the comment to name the reverse case and why it heals itself. No code change is
     needed.

VERDICT: CLEAR
