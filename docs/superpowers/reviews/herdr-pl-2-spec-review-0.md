Tier: heavy

# herdr-pl-2 spec review 0

Reviewed `docs/superpowers/specs/2026-11-14-herdr-pl-2-design.md` (at `e8f2b5d`) against the brief
(`hpipe brief --task t2`), the research note, and the code. `git diff 8514924 HEAD -- src test` is
empty, so the spec's "line numbers are at `8514924`" still holds. Also checked: the kit
(`src/kit/stage.ts`, `src/kit/herdr.ts`, `src/kit/throttle.ts`), pasture's board
(`herdr-pasture/src/board.ts`), which is the model the sibling board-keys task will follow, the
`pane.move` memory note, and `herdr 0.9.1` `pane move --help` / `pane split --help`.

## What holds

- Every `file:line` citation I followed matches HEAD, including `boards.ts:96`/`:104`/`:105`,
  `actions/board.ts:40`, `startup.ts:138-151`/`:211`, `tick.ts:343-384`/`:503-511`/`:283-308`,
  `teardown.ts:168-229`/`:179-184`/`:186`/`:214`, `main.ts:373-374`/`:492-494`/`:513`, `stage.ts:80-98`/`:134`/`:158-166`,
  `tasks.ts:42`, and the test helpers (`board.test.ts:51-56`, `:310-320`; `teardown.test.ts:36-39`).
- The brief's acceptance items are all covered by the testing strategy.
- A3, A4 and A13 hold. `runBoardPane` spreads the record (`src/board.ts:57`). `openBoard` copies only
  `cleared` (`src/supervisor/boards.ts:30`). `sameBoard` ignores every field except `pane_id`,
  `shell_pid` and `opened_at_ms` (`src/lib/boards.ts:37-40`).
- A11 is right and needed. Research finding 3 is correct: an unlisted board is never closed, but its
  record is still deleted or replaced.
- A5's remap does make `stage.ts:81` hit after a restart.
- A18 holds: `grep -rln -e TaskDeps -e removeWorktree test` lists 11 files.
- A21's recovery path checks out. `teardown` has no worker phase ahead, so `losePane` releases
  (`tick.ts:290-293`), and `markTornDown` releases on the removed path (`teardown.ts:55-58`).

## MAJOR 1: A9 does not hold while the board is live. Its reconcile closes the placeholder once `closeStagedWorker` closes the worker

**Claim.**
- A9 (spec `:161-164`): "never close the placeholder … `removeWorktree` closes it with the workspace."
- `closeStagedWorker` (spec `:155-159`) closes the worker first, then compare-and-clears `staged`.
- `recordStaged` (spec `:107-110`) writes without a compare.

**Problem.** Teardown is the one path where the supervisor acts on a stage while the board that owns
it is still running. The board will run the kit's stage algorithm ("This is pasture's stage
algorithm from the kit … reconciled by terminal id", `2026-11-13-pasture-board-design.md:221-225`).

The kit's `reconcile` → `keepStaged` closes the placeholder whenever the staged pane is no longer in
the host tab (`src/kit/stage.ts:158-166`). The pipeline board refreshes:
- on `pane.closed` (`src/board/ui.ts:24-25`, subscribed at `:98-99`);
- through a leading-edge throttle (`src/kit/throttle.ts`: `if (wait <= 0) return run()`);
- and on a 2 s poll (`ui.ts:205`).

Pasture's board, the model, reconciles its **in-memory** `state.staged` and writes the result back
without a compare (`herdr-pasture/src/board.ts:70`, `:78-84`).

So once the supervisor's `pane.close` lands, the board's refresh races the supervisor's
compare-and-clear and its `herdr worktree remove`. If the board wins:
1. It closes the placeholder, usually the worktree workspace's last pane.
2. herdr destroys the workspace, and `removeWorktree` reports `gone`.
3. Teardown falls back to `removeCheckoutWithGit`, which keeps a checkout that has untracked files
   (`teardown.ts:103-104`, `:129-130`).

That is the outcome A9 and brief item 5 exist to prevent. Two parts of the spec make it worse:
- Closing before clearing widens the window: the record still says "staged" after the worker is gone.
- The unconditional `recordStaged` lets a board that reconciled before the clear write the stale
  stage back, and its next refresh then closes the placeholder.

**Fix (inline, within the brief):**
1. **`closeStagedWorker` clears first, then closes.** Compare-and-clear under `updateBoards`. If the
   record no longer holds that stage, return `false` without closing. Otherwise snapshot and close.
   Update the Error-handling row: a `pane.close` that throws now leaves `staged: null` with the
   worker alive, which is still "the problem today, no worse".
2. **Add a "Contract for the board-keys task" paragraph:**
   - On every refresh, the board reads `staged` from the registry, after its snapshot. `ui.ts`
     already reads the snapshot (`:50`) before the registry (`:72`).
   - It never reconciles an in-memory copy.
   - It writes a reconcile result back only if the record's `staged` still equals what it read.
     Give `recordStaged` an `expected` argument, or add a compare-and-set variant beside it.

   With snapshot-before-record on the board and clear-before-close on the supervisor, a board that
   sees the worker gone has necessarily read `staged: null`.
3. **Add a unit test.** `closeStagedWorker` has already written `staged: null` when its `pane.close`
   arrives. Assert the record from inside the fake's `pane.close` handler.

Alternative, which departs from the brief's "before `removeWorktree`" (note it inline, or raise it
with `hpipe decide`): call the close after a `removed` `removeWorktree`, using the pane id captured
before `markTornDown` releases it. The workspace close then takes the placeholder first, so no board
reconcile can strand it.

## MAJOR 2: Live verification is deferred on a false premise, and the restart premise it would test is contradicted in the repo

**Claim.**
- Spec `:321-325`: "Nothing stages a pane until the board-keys task lands … these paths cannot be
  exercised in a real herdr session from this branch alone."
- The restart story rests on "pane ids survive a restart": A5 (`:120-122`), A15 (`:224-225`), and
  `strayKeepSet` as a whole.

**Problem.**
- **The premise is false.** A stage can be built by hand on herdr 0.9.1:
  - `herdr pane split <worker> --direction right` makes an agent-less placeholder, which is exactly
    what `placeholderOf` accepts (`stage.ts:49-52`).
  - `herdr pane move <worker> --tab <board tab> --target-pane <board> --split down` stages the worker
    (both commands' flags appear in their `--help`).
  - A `staged` record written with this task's own `recordStaged` then drives `unstageBoard`,
    `strayKeepSet` + `clearStrayPanes`, and "Open board".

  This task changes startup (`startup.ts:211`) and pane I/O (a new socket client in the supervisor).
  `.claude/agents/plugin-dev.md` ("Where the behaviour is actually proven") requires a real-herdr
  verification plan for exactly those.
- **The repo contradicts itself on the premise.**
  - `tick.ts:339-340` and `stage.ts:161` say pane ids survive a restart.
  - `src/startup.ts:135-136` ("a ghost a herdr restart brought back under a new id") and
    `src/supervisor/boards.ts:72-73` ("herdr restores panes under new ids after a restart") say the
    opposite.

  Only the move half of `tick.ts:337-341` is marked "measured live". The memory note on `pane.move`
  cites `tick.ts` for the restart half, so it is not independent evidence. If pane ids do change,
  `strayKeepSet` keeps nothing and Problem 3 ships unfixed while every fake-herdr test passes. A6
  (tab ids across a restart) is unmeasured for the same reason.

**Fix.** Replace the Live verification paragraph with a check this task's plan runs itself. Use a
scratch herdr session, not the live one: point `HERDR_SOCKET_PATH` at it and use a temp state dir.
Stage a pane by hand as above, then write `staged` with `recordStaged`.
1. Run `unstageBoard` from a `bun -e` one-liner. Confirm the pane returns next to its placeholder and
   the placeholder closes.
2. Restage it, then `herdr session stop` and re-attach. Record whether pane ids and tab ids survived
   and terminal ids changed.
3. Run `strayKeepSet` + `clearStrayPanes` and confirm the staged pane survives. Then run
   `unstageBoard` again, which exercises the restart remap.

Write the measured answer into A5/A6, and fix whichever comment is wrong. If that comment is outside
the touched files, file it with `hpipe discover`. Keep the teardown runbook step for the board-keys
task.

## MINOR 1: The teardown tests as listed cannot tell the new release from `markTornDown`'s

**Claim.** Spec `:313-315` lists two teardown tests:
- A staged task's `pane_id` is released (`last_pane_id` set, `agent_status: 'unknown'`).
- "`closeStagedWorker` returning `false` leaves `pane_id` as it was."

**Problem.** With `removingBy(async () => 'removed')`, `markTornDown` → `unbindGoneWorkspace` →
`releaseWorkerPane` releases the pane either way (`teardown.ts:42-58`). The existing test
`teardown.test.ts:56-62` asserts exactly that end state. So the first assertion passes without the
new code, and the second fails with correct code.

**Fix.** Assert from inside the `removeWorktree` fake, which sees the state at removal time:
- staged task: `pane_id` is already `null` and `last_pane_id` is the old id;
- `false`: `pane_id` is still bound.

Or drive the `false` case with a `'failed'` removal.

## MINOR 2: A6 and the kit's tab check strand a worker that `unstageBoard` can see

**Claim.** A6 (spec `:131-138`) uses the board pane's current tab, and falls back to the stored
`host.tabId`.

**Problem.** Take a worker that is in the pipeline workspace but not in `host.tabId`. That happens
when the board pane is gone and the tab id changed across a restart (unmeasured, per A6), or when the
user moved the worker to another tab. Then:
1. The kit closes the placeholder and returns (`stage.ts:83-86`).
2. `unstageBoard` clears `staged`.
3. The worker stays in the pipeline workspace, bound to its task but no longer staged.
4. At teardown `closeStagedWorker` returns `false`, so the worker outlives its task until a herdr
   restart's `clearStrayPanes`.

**Fix.** In step 4, if the found worker pane's `workspace_id === staged.host.workspaceId`, set
`host.tabId` to the worker's own `pane.tab_id`. The pipeline workspace is never a worker's home, so
any worker found there should go home. This also removes A6's dependence on tab ids surviving a
restart.

## MINOR 3: A17 contradicts the spec's own "keeping more panes is the safe direction"

**Claim.** Spec `:221` drops `REPOS_ALLOW` because "keeping more panes is the safe direction". A17
(`:229-231`) then drops the bound panes of `escalated` runs.

**Problem.** `PaneAbsence` binds the non-`FINISHED` tasks of every run, escalated ones included
(`tick.ts:356-359`). An escalated run waits for a human `rewind` (`phases.ts:145-149`). Take a staged
worker whose record was lost (A8). A restart closes it as a stray, and `losePane` fails its
mid-flight task (`tick.ts:290-303`), which the human then finds failed after the rewind. This is
rare: it needs a failed unstage and then a restart.

**Fix.** Either keep the brief's `runIsDriven` filter and correct the rationale sentence, or key the
set on every non-`FINISHED` task as `PaneAbsence` does, noting the departure from the brief inline.

## MINOR 4: `deps()` cannot record into `calls`

**Claim.** Spec `:300-301`: `deps()` and `actionDeps()` gain a recording `unstage` that pushes into
"the same `calls` log".

**Problem.** `calls` belongs to the test file's `fakeHerdr` (`test/board.test.ts:28-48`), and
`deps(herdr, over)` never sees it (`:51-56`). The brief says the default gets a no-op.

**Fix.** Give both helpers a no-op default. The ordering tests pass
``{ unstage: async (s) => { calls.push(`unstage ${s}`) } }`` through `over`.

VERDICT: CLEAR
