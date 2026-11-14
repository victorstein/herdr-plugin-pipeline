Tier: heavy

# herdr-pl-4 spec review 0 — board: enter stages a worker, tab focuses, z zooms

Reviewed: `docs/superpowers/specs/2026-11-14-herdr-pl-4-design.md` at `3b0e793`, against the brief
(`hpipe brief --task t4`), the research note, the parent spec
(`docs/superpowers/specs/2026-11-13-pasture-board-design.md`), the code on this branch, pasture at
`ec34957`, the installed plugin, and live `herdr` 0.9.1 output.

## Verified and holding

- The kit is byte-identical to pasture's: `diff -r ~/…/herdr-pasture/src/kit src/kit` prints nothing.
- Every citation in Problem, Goal and Architecture checks out: `PIPELINE` at `src/board/ui.ts:22`,
  manifest panes at `herdr-plugin.toml:89-115`, the close-path unstages at
  `src/supervisor/boards.ts:101,110` and `src/actions/board.ts:43`, `STAGE_RATIO` at
  `src/kit/stage.ts:31,134`, the README table at `README.md:481-488` and the read-only sentence at
  `:490`. `skills/herdr-pipeline/` names the board only at `SKILL.md:164` (A13 holds).
- A2 holds: `\r\n` splits into two keys (`src/board/keys.ts:11`); the second runs after the first on
  `serial`, reads the recorded stage, and `stageAgent` returns early (`src/kit/stage.ts:101`).
- A5's `expected` guard is safe against teardown's `closeStagedWorker`, **as long as `syncStage`
  keeps using the snapshot `refresh` read before it reads the record**. The supervisor clears the
  record (`src/lib/boards.ts:125-131`) and then closes the pane. A board that read the snapshot
  first cannot see the worker gone while it still reads a stage. A fresh snapshot taken inside
  `syncStage` would break this. Keep that ordering in the plan.
- A10: kit calls time out after 10 s (`src/kit/herdr.ts:32`) and `withFileLock` is bounded
  (`src/lib/store.ts:185-189`). I also probed Bun: a `stdout.write` after an `EPIPE` does not throw,
  so `.finally(() => { out(…); process.exit(0) })` still exits.

## Findings

### MAJOR 1 — `tab`/`z` right after `enter` act on the worker's pre-move pane id

**Claim.** `enter` → `stageCard` → `requestRefresh()` (spec `:120-121`); `tab`/`z` "as pasture"
look the staged pane up in `snap` by terminal id (`:145-147`).

**Problem.** `snap` is the snapshot from before the move. The worker keeps its terminal id but gets a
new pane id. Here is how `tab` goes wrong:

- `tab` pressed during the stage queues behind it on `serial`.
- `stageWorker`'s `requestRefresh()` then queues its refresh behind the `tab`.
- So `tab` finds the worker in the stale `snap` and sends `pane.focus` with an id that no longer
  exists.
- The user gets a red `pane_not_found: …` on the status line and no focus. `z` fails the same way.

Pasture avoids this by re-reading `snap` at the end of `stage` (pasture `board.ts:108`). The research
note records that step (`research:105-106`), but the spec dropped it.

**Evidence.**
- `src/board/ui.ts:191` dispatches every key of one stdin chunk synchronously.
- herdr 0.9.1 delivers `send-keys … enter tab` as one chunk `…\n\t` (`test/board-keys.test.ts:11-12`).
- A move renames the pane (`w3:p2` → `w5:p2`, `src/supervisor/tick.ts:337-338`). The kit returns
  the new id (`src/kit/stage.ts:43`).
- herdr refuses a stale id: `herdr pane get wZZ:p999` →
  `{"error":{"code":"pane_not_found",…}}`.
- `ui.ts` has no tests (spec `:57-60`), so no unit test catches this. A scripted live check that sends
  `enter tab` would fail on it every time.

**Fix.**
- In `stageWorker`, after `stageCard` returns, set `snap = await readSnapshot(herdr)` before
  `requestRefresh()`, as pasture does at `board.ts:108`.
- Add to live-check step 1: "`send-keys … enter tab` in one call stages the worker and focuses it."

### MAJOR 2 — the live check cannot run as written: herdr serves the installed 2.2.3 plugin, not this branch

**Claim.** Live check `:281-289` runs in a throwaway herdr session:
1. `enter` opens the "On stage" placeholder.
2. "Open board" sends the worker home.
3. Teardown leaves no pane.

**Problem.** The plugin registry is global, so a scratch session gets the GitHub install, not this
checkout:
- **Step 1 fails before any move.** `plugin.pane.open {stein.pipeline, placeholder}` is checked
  against the installed manifest, which declares no `placeholder`. The spec's own Problem section
  says this call fails (`:20-23`).
- **Step 2 runs the old action.** "Open board" runs the installed action, which does not unstage. It
  then opens the installed read-only board, which does not reconcile.
- **Step 3 runs the old supervisor.** Teardown runs the installed supervisor, which has no
  `closeStagedWorker`.

So all three steps test 2.2.3, and a correct branch fails them. The repo's guide says the install is
pinned to a tag and not linked to a checkout on purpose. `herdr plugin link` on this worktree is
global too: it would also swap the plugin under the live `herdr-plugin` session that is driving this
run.

**Evidence.**
- `~/.config/herdr/plugins.json` registers one `stein.pipeline` with `plugin_root
  …/plugins/github/stein.pipeline-f39fb4f3495d`, `version 2.2.3`, panes
  `['board', 'details', 'peek', 'supervisor']`.
- `herdr session list` shows every session's directory under the shared `~/.config/herdr`.
- `docs/superpowers/plans/2026-11-14-herdr-pl-2-plan.md:1115`: "plugins are global".
- In the install, `grep -c "closeStagedWorker\|unstageBoard" src/lib/boards.ts` → `0`, and
  `src/actions/board.ts` has no `unstage`.
- `.claude/agents/plugin-dev.md:42-44`.

**Fix.** Rewrite the live check as a worker-run harness, modelled on pl-2's Task 9
(`pl-2-plan.md:1096-1140`):
- A scratch `herdr --session`, a `HERDR_SOCKET_PATH` guard, and a temp state dir.
- This branch's board started from the worktree in a scratch pane (`HERDR_SOCKET_PATH=$S
  HERDR_PLUGIN_STATE_DIR=$tmp HPIPE_BEADS_SLUG=<fake> bun run src/board.ts`).
- Reopen and teardown driven through this branch's `openBoardAction` / `unstageBoard` /
  `closeStagedWorker` from a helper script, not the installed action and supervisor.
- Say how the binding is checked when no branch supervisor is running.

The placeholder entrypoint needs this manifest registered, and that is global. Raise it with
`hpipe decide`. Recommendation: a time-boxed `herdr plugin link` of the worktree, with
`herdr plugin install` of the pinned tag restored right after, done while the live run is idle.
Otherwise the `enter` step moves to a post-release check. Do not leave the tester to find this out.

### MAJOR 3 — the parent spec's "one stager owns pipeline panes" rule has no owner, and `enter` makes it reachable

**Claim.** The parent spec's Rules (`pasture-board-design.md:271-276`) say pasture refuses to stage a
pipeline-bound pane. Without that, pasture's reconcile closes the pipeline board's placeholder, and
the worker's home spot is lost. Its plan-4 tests list "pasture refusing a pipeline-bound pane"
(`:373`). This spec never mentions the rule.

**Problem.**
- **Pasture has no such refusal at `ec34957`.** `grep -n pipeline src/*.ts` in herdr-pasture finds
  only display flags, and `stage()` (`board.ts:101-109`) stages any terminal. No task in this run
  owns the refusal: `hpipe status` lists only t1–t4.
- **Worker X is already staged under pasture, and the user presses `enter` on X's card.**
  1. `stageAgent` opens the pipeline placeholder inside pasture's tab and moves X under this board.
  2. Pasture's next reconcile sees its stage gone and closes its placeholder in X's worktree
     (`src/kit/stage.ts:163-165`), so X's real home is gone.
  3. A later unstage puts X back into pasture's tab, and pasture adopts it (`:153`).
- **Pasture stages a pipeline-staged X.** The mirror image happens, and this board ends up adopting X.
- **Teardown then misses X.** It closes a worker outside its workspace only through
  `closeStagedWorker` (`src/supervisor/teardown.ts:190`), which needs this board's record. An X that
  pasture adopted survives the worktree removal as a stray agent.

**Fix.**
- **Pipeline half, cheap, inside `stageCard`.** Refuse a worker whose pane is neither in its task's
  workspace (`task.workspace_id`, kept by `tick.ts:465`) nor under this board, with a status message
  such as `that worker is on another stage`. Add one unit test for it.
- **Pasture half.** It lives in another repo, so it is not an `hpipe discover`. Tell the orchestrator,
  and record it under Non-goals as a known gap with the parent-spec reference.
- If you would rather not add the guard, raise it with `hpipe decide`. Recommendation: add the guard
  and ship.

### MINOR 1 — the stale-board guard checks the wrong field

**Claim.**
- `syncStage` and `stageCard` treat a stage whose `host.boardPaneId` is another pane as "left by an
  earlier board" (`:100-101`, `:127-128`, A11).
- `stageCard`'s write-back returns false when "the supervisor deleted or replaced this board"
  (`:134-136`).

**Problem.**
- **The foreign stage can be newer.** On a board that has been replaced, the foreign stage belongs to
  the newer board. "Open board" ignores the result of its `paneClose` (`src/actions/board.ts:44`), and
  a ghost board lives until the supervisor's next tick. Pasture quits as soon as its record names
  another pane (pasture `board.ts:66`). This spec has no such check, so a stale board undoes the newer
  board's stage.
- **A replaced record is not a missing one.** `openBoard` writes a fresh placeholder record
  (`src/supervisor/boards.ts:32-36`). `recordStaged` therefore returns `true` and writes the stale
  board's stage into the new record. The new board's A11 path then undoes it, so this self-heals, but
  the stated rationale is wrong.

**Fix.**
- Act only when `record.pane_id === host.boardPaneId`. Otherwise return `null` and leave the stage
  alone.
- Do the post-move write with `updateBoards` under that same guard in `src/board/stage.ts`. That
  needs no `lib/boards.ts` change.

### MINOR 2 — two recovery claims are wrong

- **The error table, `:244`.** It says "`syncBoards` undoes a stage whose board is gone" when the
  unstage on quit fails. After `q` or ctrl-c the pane is not gone:
  - The board command ends in `exec "${SHELL}"` (`herdr-plugin.toml:99`), which keeps the recorded
    `shell_pid` (`src/board.ts:14-15,57`).
  - So `isLive` returns true (`src/supervisor/boards.ts:66-69`) and nothing unstages.
  - The stage stays until "Open board", the run ends, or teardown.
- **A11, `:204-208`.** It calls itself the fallback "for a stage those paths missed". But
  `openBoard`'s placeholder record drops `staged` (`src/supervisor/boards.ts:32`). If the unstage
  before a reopen fails (its errors are swallowed, `src/actions/board.ts:71-72`), the worker is left
  in the old board's tab with no record, and no board will ever reconcile it.

**Fix.** Correct both texts. File the `openBoard` gap with `hpipe discover`: a failed unstage
followed by a reopen strands the worker and its placeholder. That is #175's code, not this PR's.

### MINOR 3 — the post-move undo path has no test

The error table promises that a completed move is undone when the record disappears mid-stage
(`:240`, `stageCard` step 5). The testing strategy only tests the pre-check: no record, no herdr call
(`:269`).

**Fix.** Add a `stageCard` case in which the fake's `pane.move` handler deletes the record. Assert
that the move home comes before the placeholder close, and that the `StageError` text is the
expected one.

### MINOR 4 — A14's width arithmetic is off

A14 says a 42-point summary "leaves 76 at 120 columns" and the line renders `… d details  x…`, losing
only `clear`. The status line has width `cols - 1` (`src/kit/render.ts:165`), so the room is
`119 - 42 - 2 = 75`.

Rendered with the kit's own `fit`:

```
120 room 75 "hjkl move  enter stage  tab focus  z zoom  space peek  o orch  d details  …"
```

`x clear` is lost entirely. The ordering choice is still right: the new keys survive down to 80
columns (`"hjkl move  enter stage  tab focus …"`).

**Fix.** Correct the numbers and the rendered text, so the plan and the tester do not check for an
`x…` that never appears.

VERDICT: CLEAR
