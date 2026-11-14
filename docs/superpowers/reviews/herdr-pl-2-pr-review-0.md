Tier: heavy

# herdr-pl-2 — PR #175 review 0

Reviewed at `8f55004` against the brief (`hpipe brief --task t2`), the spec
`docs/superpowers/specs/2026-11-14-herdr-pl-2-design.md` and the plan
`docs/superpowers/plans/2026-11-14-herdr-pl-2-plan.md`.

Re-run here: `bunx tsc --noEmit` is clean. `bun test` gives 2375 pass and 1 fail. The failure is
`--help and -h print that subcommand's usage before any side effect, from anywhere`
(`test/cli-argv.test.ts:241`, a 5 s timeout on `escalate --help`). It fails the same way on a
`git archive main` copy of the tree, so it was already failing before this PR. The four touched test
files pass alone (91 pass).

## Intent

**Brief item 1, stage record.** `StagedWorker = Staged & { host: Host }` and
`BoardRecord.staged?: StagedWorker | null` are at `src/lib/boards.ts:19,23`. `recordStaged` writes
only when the slug has a record (`:81-91`). `openBoard` still builds its record from scratch plus
`cleared` (`src/supervisor/boards.ts:30`), so `staged` is dropped. A test pins that
(`test/board.test.ts` "openBoard never carries a stage…"). `runBoardPane` is unchanged and spreads
the old record, as the brief says. Met.

**Item 2, `unstageBoard`.** `src/lib/boards.ts:104-113` reads the stage and returns before any socket
call when there is none. It finds the worker by terminal id, then by pane id, hands the kit
`{ ...staged, terminalId, paneId }` under the current ids, and clears the record with
compare-and-clear. The restart test (`test/boards-stage.test.ts`, "after a herdr restart…") would
fail without the remap: the kit's `unstage` would miss on terminal id `t1` and close only the
placeholder, so the expected `HOME_MOVE` call would not happen. The test exercises the gotcha rather
than restating the code. The host-tab override (spec A6) has the same kind of test: the
"another tab" case would fail on the kit's `tab_id !== host.tabId` guard. Met.

**Item 3, unstage before every close.** Both `syncBoards` paths call `unstage` before the
listed-pane guard (`src/supervisor/boards.ts:101,110`), so a board whose pane is gone is still
unstaged before its record is deleted or replaced. "Open board" calls it before `paneClose`
(`src/actions/board.ts:43`). The supervisor wiring (`src/supervisor/main.ts:529`) and the action's
`import.meta.main` (`src/actions/board.ts:71`) log a rejection and let the close go ahead. Both test
helpers default `unstage` to a no-op. The ordering tests log `unstage` into the fake herdr's `calls`,
which makes the "before" claim observable. There is a test for each brief case: a finished run, a
dead board, a gone pane, and "Open board".

**Item 4, keep set.** `strayKeepSet` (`src/startup.ts:137-148`) unions the recorded board panes,
every `staged.paneId` and `placeholderPaneId`, and every unfinished task's pane. The PR drops the
brief's `runIsDriven` filter. The PR body (spec A17) flags this departure and gives the reason. It
matches what `PaneAbsence` binds (`src/supervisor/tick.ts:356-359`, every non-`FINISHED` task in
every run), and keeping more panes is the safe direction. Only panes in the pipeline workspace are
candidates, so in practice the wider set only spares staged or stranded workers. I accept it as
flagged; it is not silent scope drift. `taskPhaseIsTerminal` is used instead of `FINISHED`. Both
read the `terminal` flag in `TASK_ROWS`, and the plan explains the choice (`plan:845`).

**Item 5, teardown.** The optional `closeStagedWorker` (`src/supervisor/teardown.ts:45`) is called
after the `keep_worktree` branch and before both removal paths (`:190`). On `true` the task's pane
is released. The supervisor's version clears the stage under the lock, then closes the worker only
(`src/lib/boards.ts:122-136`). It never closes the placeholder. The teardown tests check the release
from inside the `removeWorktree` fake, the only place it can be told apart from `markTornDown`'s own
release. The "not staged" case and the `pane_id: null` / `keep_worktree` cases are covered. The
existing suite covers "no dep behaves as today".

**Scope.** `recordStaged`'s `expected` argument and the clear-before-close order in
`closeStagedWorker` go beyond the brief's literal text. Both come from spec review 0 MAJOR 1 and are
stated in the PR body. They are small and serve the brief's own aim of never stranding the
placeholder's workspace. The two comment corrections (`src/startup.ts`, `src/supervisor/boards.ts`)
fix claims that the PR's own live measurement disproved, in files this task touches. That is in
scope. The PR adds no keys, no UI and no `former_pane_ids` work, and makes no `src/kit/` edits.

**Plan conformance.** The code follows plan tasks 1-7 closely. That includes the
`task.pane_id === null` narrowing in the `main.ts` wiring (`plan:1050`) and one `kit` client beside
`herdr` in `main`. I found no divergence the PR does not explain.

## Quality

- Each new piece follows an existing pattern. `recordStaged` mirrors `recordCleared`
  (`src/board/data.ts:28-36`), with the same `updateBoards` shape and the same write-only-on-a-record
  rule. `BoardDeps.unstage` and `OpenBoardActionDeps.unstage` are injected like `hasStore` and
  `workspaceId`. `closeStagedWorker` is an optional `TeardownDeps` member, wired in `main.ts` beside
  `removeWorktree`/`removeCheckout`. Its failure handling (log, then return `false`) matches the
  `[pipeline] run …:` logging around it.
- `stagedPane` is one shared helper. Its comment gives the reason for the lookup order (move vs
  restart), and that reason agrees with `PaneAbsence`'s doc (`tick.ts:337-341`) and the live
  measurement in spec A5.
- The comments explain why rather than what: the JSDoc on `unstageBoard`, on `closeStagedWorker`
  and on `strayKeepSet`, the comment above the `syncBoards` loop, and the teardown test's note. None
  of them paraphrases the next line.
- The tests use real fakes rather than mocks of the code under test. `test/kit/fake-herdr.ts` and
  `test/kit/fixtures.ts` are imported, not copied. The temp-state-dir pattern is taken from
  `test/board-data.test.ts`. The race tests (a stage recorded mid-unstage, and the record checked
  from inside `pane.close`) assert behaviour that a naive version would get wrong.
- Nothing already in the repo is duplicated. Small observations that are not findings: `updateBoards`
  rewrites `boards.<session>.json` even when `closeStagedWorker` finds no stage, but that is the
  helper's existing behaviour and costs one locked write per torn-down task. The `../kit/herdr`
  import in `main.ts` sits among the `../lib/*` imports.

## Findings

1. **MINOR** — `sameStage` is exported (`src/lib/boards.ts:70`), but nothing outside `boards.ts`
   imports it (`grep -rn sameStage src test` finds only that file). The board-keys task's contract
   goes through `recordStaged(…, expected)` (spec "Contract for the board-keys task"), not through
   `sameStage`. Drop the `export` so the module offers one way to compare stages. If the board-keys
   task later needs it, it can add the export back.

No BLOCKER or MAJOR. Every brief acceptance criterion is met and every spec requirement is
implemented. The departures (A17 keep set, A22/A23 compare-and-set and clear-first) are flagged in
the PR body and the spec, and each moves toward the safer behaviour.

VERDICT: CLEAR
