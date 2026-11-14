Tier: heavy

# herdr-pl-2 plan review 0

Plan: `docs/superpowers/plans/2026-11-14-herdr-pl-2-plan.md`, read against
`docs/superpowers/specs/2026-11-14-herdr-pl-2-design.md` and the code at `HEAD` (`e8fba22`). The plan
was read, not applied or built.

## Summary

The plan is sound. Every spec requirement maps to a step, and the steps do not narrow any of them.
The new tests catch the behaviour they claim to: the restart and own-tab `unstageBoard` tests fail
without the remap and the host override (plan `:280`), and the teardown release is asserted from
inside the `removeWorktree` fake. The main.ts and "Open board" wiring is not covered by any test, but
the plan quotes it verbatim and it matches the spec's error-handling table. I found no BLOCKER and no
MAJOR. The three MINORs below are listed most consequential first.

### What was checked and holds

- **Spec coverage.** Every spec item maps to a step:
  - `recordStaged` with `expected` (A22): Task 1.
  - `unstageBoard` with the remap, own-tab host, compare-and-clear and throw-keeps-stage (A5–A8):
    Task 2.
  - `closeStagedWorker` clears first, never closes the placeholder, and counts a gone worker as
    closed (A9, A10, A23): Task 3.
  - Both `syncBoards` paths call unstage before the `listed.has` guard (A11, A12), and A4 is pinned:
    Task 4.
  - "Open board": Task 5.
  - `strayKeepSet` over every non-`FINISHED` task, without `runIsDriven` (A15–A17), and its `main`
    wiring with `isCurrentSchemaRun`: Task 6.
  - The optional teardown dep after `keep_worktree` and before both removal paths (A18–A20), and its
    wiring: Task 7.
  - The scratch-session restart measurement: Task 9.
- **Only `test/board.test.ts` builds the changed interfaces.** It is the only file that constructs
  `BoardDeps` or `OpenBoardActionDeps`. No other src or test file needs the new required `unstage`
  field (grep for `syncBoards|openBoard|BoardDeps|OpenBoardActionDeps|clearStrayPanes|BoardRecord`).
  `TeardownDeps.closeStagedWorker` is optional, so the 11 `TaskDeps` builders are unaffected.
- **The slugs match.** Teardown's `beadsSlug(taskRun.repo_key)` (plan `:1051`) is the same key that
  `syncBoards` derives (`src/supervisor/boards.ts:77`).
- **The A1 rebind applies to the whole session.** `PaneAbsence` sees moved panes in every workspace,
  because `listed` is an unscoped `herdr.paneList()` (`src/supervisor/main.ts:254`).
- **No import cycle.** No module that `src/supervisor/teardown.ts` imports leads back to
  `src/startup.ts`. Only `src/actions/*.ts` and `src/supervisor/main.ts` import it.
- **The scratch session stays isolated.** `sessionKey` derives `hpl2-scratch` from the socket path
  (`src/lib/session.ts:5-16`), so the installed plugin's supervisor in the scratch session cannot
  read or drive the live session's runs. The `live.ts` helper also uses its own temp state dir.
- **The file lock is complete.** Every source and test file the steps touch is on the `FILES:` lines
  at `:11-12`. Task 9 Step 8 also edits this task's own spec, but that is set aside as a pipeline
  artifact even when declared (`src/lib/gating.ts:95-113`), so it needs no lock. Task 9 writes its
  other files outside the repo.
- **No step pushes, opens a PR or runs `hpipe submit`.**

## MINOR

### MINOR 1 — The pane-id fallback can match a pane that is not the worker, and Task 9 does not measure whether pane ids are reused

- **Claim.** `stagedPane` falls back to `staged.paneId` whenever the terminal id misses (plan
  `:301-302`). `unstageBoard` then treats any pane found in the board's workspace as the worker, in
  whatever tab it sits (plan `:317`, spec A6).
- **Problem.**
  - A terminal-id miss has two causes: a restart, which the fallback is for, or a worker that is
    gone.
  - The worker can be gone while its stage record stays, at exactly the moment `unstageBoard` runs:
    - The spec's own "known limit" is one case. Closing the board tab by hand closes the board and
      the staged worker, and a dead board never reconciles.
    - A worker closed by an abort's clean-up is another.
  - If herdr has since given that pane id to another pane in the pipeline workspace, the fallback
    takes that pane for the worker. It could be another repo's board, another repo's staged worker,
    or the supervisor. A6 then has the kit move that pane into the old worktree's placeholder tab.
  - The kit's own fallback limits the damage to the board's tab, because it only acts when
    `found.tab_id === host.tabId` (`src/kit/stage.ts:160-163`). The plan widens this to the whole
    workspace.
  - No test can show this, because it depends on how herdr numbers panes.
- **Evidence.**
  - `src/cli.ts:3114`: "herdr reuses ids, so a human's pane can carry a finished task's old one".
  - Against that, `src/supervisor/tick.ts:337-339` says a cross-workspace move keeps the pane number
    (`w3:p2` → `w5:p2`), which hints at a session-wide counter. Neither settles whether a closed
    pane's number is reused inside the long-lived pipeline workspace.
- **Fix.** Add one measurement to Task 9 Step 6, next to the restart questions:
  - In `WB`, close a pane, open a new one, and record whether it takes the closed pane's number.
  - If it does, raise it with `hpipe decide` before the PR. The likely guard is to use the pane-id
    fallback only when the terminal id is known to have changed, or only for a pane that is not a
    recorded board pane and not the supervisor.
  - If numbers are never reused, write that next to the A5 measurement.

### MINOR 2 — Task 9 Step 8 does not list the plan's own new restart comments for correction

- **Claim.** Task 9 Step 8 fixes the restart comments that the measurement proves wrong, and lists
  `src/startup.ts:135-136` and `src/supervisor/boards.ts:72-73` (plan `:1240`).
- **Problem.** The plan adds three new comments in `src/lib/boards.ts` and `src/startup.ts` that
  state the unmeasured claim as fact:
  - plan `:300`: "a herdr restart keeps the pane id and changes the terminal id";
  - plan `:305-307`: "as it does after a herdr restart";
  - plan `:849-853`: "a worker whose stage record was lost is kept too", which only holds if pane ids
    survive.

  Suppose the measurement shows that pane ids survive but terminal ids do not change. Then the first
  comment is wrong in one half, and the worker in the "survived" branch has no instruction to touch
  it.
- **Fix.** In Step 8's "Pane ids survived" bullet, also say: re-word the `stagedPane` comment and the
  `unstageBoard` doc in `src/lib/boards.ts` to match what was measured. Both files are on the
  `FILES:` line.

### MINOR 3 — Task 6 Step 4's import-cycle guard can never trip

- **Claim.** Task 6 Step 4 (plan `:885`) says: "If tsc reports an import cycle problem from
  `./supervisor/teardown` … stop and report it rather than moving `FINISHED`".
- **Problem.**
  - `tsc` never reports import cycles, so this guard cannot trip.
  - There is also no cycle (see "What was checked").
  - The import itself is avoidable. It loads a supervisor module into the herdr startup hook for one
    predicate, while `./lib/ledger` already exports the same test as `taskPhaseIsTerminal`
    (`src/lib/ledger.ts:341-342`, `TASK_ROWS` `terminal === true`). The same step imports
    `./lib/ledger` anyway, for `listRuns` and `isCurrentSchemaRun`.
- **Fix.** Delete the guard sentence. Optionally use `!taskPhaseIsTerminal(task.phase)` from
  `./lib/ledger` in place of the `FINISHED` import. It is behaviour-identical, and the spec's
  `FINISHED` reference still describes it.

VERDICT: CLEAR
