# herdr-pl-2 research — board stage record, unstage before close, keep staged panes

Branch `feat/board-stage-record`, at `8514924` (release 2.3.0). Everything below was read from this
checkout on 2026-11-13; line numbers are current, and several differ from the brief's (noted).

## Installed versions

| Tool | Command | Output |
|---|---|---|
| bun | `bun --version` | `1.3.14` |
| TypeScript | `bunx tsc --version` | `Version 5.9.3` (`package.json`: `"typescript": "^5.6.0"`) |
| @types/bun | `node_modules/@types/bun/package.json` | `1.4.2` (`package.json`: `"latest"`) |
| herdr | `herdr --version` | `herdr 0.9.1` |

`.claude/pipeline-bootstrap` is `bun install`; `node_modules/.bin/tsc` is present. No runtime
dependencies.

## Who owns the behaviour

| Concern | File | Today |
|---|---|---|
| Board registry | `src/lib/boards.ts` | `BoardRecord` (`:10-16`) is `{ pane_id, shell_pid, opened_at_ms, cleared? }`. All writes go through `updateBoards` (`:51-61`), a read-modify-write under `withFileLock`, because the supervisor and each board process both write `boards.<session>.json`. No `staged` field, no unstage. |
| Nearest writer to copy | `src/board/data.ts:28-36` | `recordCleared(stateDir, session, slug, runId, taskId)` → `updateBoards`, returns `false` and writes nothing when `boards[slug]` is absent. `recordStaged` mirrors it exactly. |
| Board's own record | `src/board.ts:56-58` | `boards[slug] = { ...boards[slug], pane_id, shell_pid, opened_at_ms }` — the spread keeps any `staged` (and `cleared`) the record already has. |
| New board record | `src/supervisor/boards.ts:30` | `openBoard` builds `{ pane_id: null, shell_pid: null, opened_at_ms, ...(expected?.cleared && { cleared }) }`: only `cleared` is carried, so `staged` is already dropped without any change. A test must pin that. |
| Board closes in sync | `src/supervisor/boards.ts:96` and `:104` | `:96` closes a recorded board whose slug is no longer wanted (no live run / no store); `:104` closes a listed board that `isLive` says is not live, before `openBoard`. (Brief says `:89`/`:96`; the design spec says `:97`/`:105`.) A board whose pane is not listed is not closed at all — it falls through to delete (`:97-99`) or reopen (`:105`). |
| Ghost-board close | `src/supervisor/boards.ts:90-92` | Closes renamed `Board: …` panes no record names. Not in the brief's list; a ghost has no record, hence no `staged` to undo. |
| "Open board" action | `src/actions/board.ts:39-40` | Reads the record, `paneClose(recorded.pane_id)` if set, then `openBoard(…, recorded)`. `OpenBoardActionDeps` (`:10-20`) has no unstage dep. Wiring at `:52-70`. |
| Supervisor wiring | `src/supervisor/main.ts:510-518` | `'board upkeep'` calls `syncBoards(await syncRuns(), { stateDir, session, pluginId, workspaceId, now, hasStore, herdr })` inside `eachIsolated`. `herdr` there is the CLI-backed `src/lib/herdr.ts` `Herdr` class, not the kit socket client. |
| Stray-pane clearing | `src/startup.ts:138-151`, call at `:211` | Lists panes of the **pipeline workspace only** and closes every pane that is not labelled `Pipeline supervisor`, not labelled plain `Board`, and not in `keep`. `keep` today is `recordedBoardPanes(await readBoards(...))`. |
| Teardown | `src/supervisor/teardown.ts:168-229` | For a `teardown` task: `keep_worktree` → done; else `deps.removeWorktree(workspace_id)` (`:186`), then the checkout fallback `deps.removeCheckout` (`:214`) when the workspace is `gone` or unrecorded. `TeardownDeps` is at `:34-40` (brief: `:33`). `releaseWorkerPane` is imported from `src/lib/unstarted.ts:257-264` (moves `pane_id` to `last_pane_id`, sets `agent_status: 'unknown'`). |
| Teardown wiring | `src/supervisor/main.ts:373-374` | `removeWorktree`/`removeCheckout` passed inside the `advanceTasks` deps; `TaskDeps extends TeardownDeps` (`src/supervisor/tasks.ts:42`). |
| Pane rebinding | `src/supervisor/tick.ts:343-384`, `:503-512` | `PaneAbsence.reconcile` remembers each bound pane's terminal id; a bound pane missing from `pane list` whose terminal is listed under another pane id is emitted as `pane.moved` on the **first** miss (`:369-370`), not after two. `applyEvents` then sets `task.pane_id = event.pane_id` (`:509`). Bound = `pane_id` of non-`FINISHED` tasks of every run (`:356-359`). |
| Kit stage | `src/kit/stage.ts` | `Staged` (`:4-12`), `Host` (`:15-19`), `stageAgent`, `unstage` (`:80-98`), `reconcile`. Vendored by `scripts/sync-kit.ts`, which `rmSync`s and re-copies `src/kit` and `test/kit` from herdr-pasture — edits there are lost. |
| Kit client | `src/kit/herdr.ts:12-14`, `:32`, `:73-75` | `Herdr` is just `{ call(method, params) }`; `createClient()` talks JSON over `HERDR_SOCKET_PATH`; `readSnapshot` calls `session.snapshot`. Only `src/board/ui.ts:2` uses it in pipeline code today. |
| `FINISHED`, `runIsDriven` | `src/supervisor/teardown.ts:16-18`, `src/lib/ledger.ts:319-325` | `FINISHED` = terminal task phases. `runIsDriven(run)` = the run phase's row does not set `releasesPane` (`src/lib/phases.ts:149-150`: `escalated` and `done`). |

## Control flow that matters

**Kit `unstage(herdr, snap, host, staged)`** (`src/kit/stage.ts:80-98`):

1. Finds the worker **only** by `paneOfTerminal(snap, staged.terminalId)` (`:81`).
2. If not found, or not in `host.tabId`, it closes the placeholder (if it is an agent-less pane with
   `placeholderPaneId`) and returns (`:83-86`). This is the brief's gotcha: after a herdr restart the
   terminal id is new, the lookup fails, and the worker's home spot is destroyed while the worker
   stays under the board. `keepStaged` (`:158-167`) shows the kit's own fallback — terminal id, then
   pane id ("After a herdr restart terminal ids change but pane ids survive", `:161`) — which
   `unstage` lacks. Remapping `{ ...staged, terminalId, paneId }` from the snapshot before the call
   makes `:81` hit.
3. Un-zooms, then `pane.move`s the worker into the placeholder's tab split right of it and closes the
   placeholder (`:88-90`); with no placeholder it moves the worker to a new tab in the home workspace
   if that still exists, else to a new tab in the board's workspace (`:91-96`). It never throws on a
   missing pane, but `move` throws `StageError` on `changed: false` (`:40-44`) and the socket client
   throws `HerdrError` — so `unstageBoard` can reject, which is why the brief has callers log and go on.
4. The `host.tabId` check (`:83`) means `unstageBoard` needs the board's **tab** as it was when staged:
   hence storing `host` in the record. If the board pane is gone, `host.tabId` still names the tab
   the worker sits in, as long as that tab survived.

**Pane id across a move.** `stageAgent` records the id `pane.move` returns (`:134`, `:139-147`), i.e.
the worker's id under the board. `tick.ts:337-339` records, measured live, that a cross-workspace
move renames the pane (`w3:p2` → `w5:p2`) and keeps the terminal id. So once the supervisor has seen
the move, `task.pane_id === staged.paneId`; the brief's teardown match relies on that.

**Herdr restart today, with a worker staged.** `startup.ts:211` runs `clearStrayPanes` on the
pipeline workspace. The staged worker is a pane in that workspace (the board's tab), is labelled
neither `Pipeline supervisor` nor `Board`, and is not a recorded board pane — so it is closed, the
supervisor sees its bound pane missing twice and fails the task through `losePane`. The placeholder
lives in the worktree workspace (opened as a split of the worker before the move,
`stage.ts:122-130`), which `clearStrayPanes` never lists; keeping `placeholderPaneId` is therefore
harmless defence, not a fix for an observed close.

**Teardown today, with a worker staged.** `removeWorktree` closes only panes inside the worktree
workspace (spec, "Teardown closes the worker wherever it is"). The staged worker is in the pipeline
workspace, so it survives teardown, still running, under the board. Closing the placeholder from the
pipeline side would risk taking the workspace's last pane, and herdr destroys a workspace with its
last pane (`startup.ts:130-132`), after which `worktreeRemovalFrom` reports `gone`
(`teardown.ts:23-29`) and teardown drops to the stricter `removeCheckoutWithGit`.

## Nearest existing examples

- **Record field + writer:** `cleared` / `recordCleared` (`src/lib/boards.ts:15`,
  `src/board/data.ts:28-36`), added in `47fb5bb feat: pasture's kanban board in place of bv (#170)`.
  `openBoard` already shows the "carry selected fields onto the new record" pattern (`:30`).
- **Injected close-path deps:** `BoardDeps` (`src/supervisor/boards.ts:9-17`) and
  `OpenBoardActionDeps` (`src/actions/board.ts:10-20`); `test/board.test.ts:51-56` builds `BoardDeps`
  with `deps(herdr, over)`, and `:313` builds `OpenBoardActionDeps`. A no-op `unstage` goes in both.
- **Optional teardown dep:** `TeardownDeps` has none optional today. `test/teardown.test.ts:36-39`
  builds it with `removingBy(removeWorktree, removeCheckout)`. `TaskDeps extends TeardownDeps` is
  built in 11 test files (`grep -rln "TaskDeps\|removeWorktree" test`: background-work-wiring,
  batch-fetch, before-merge-wiring, cli-commands, landing, review-skip-git, shared-paths-wiring,
  single-pr-wiring, table, tasks, teardown) — which is why the brief makes `closeStagedWorker`
  optional.
- **Fake kit `Herdr`:** `test/kit/fake-herdr.ts` exports `fakeHerdr(handlers)` (records calls,
  throws on an unhandled method), `moved(paneId)` and `opened(paneId)`; `test/kit/stage.test.ts:88-140`
  drives `unstage` with snapshots. Usable from `test/` for the `unstageBoard` tests (it is also
  re-copied by `sync-kit.ts`, so it is imported, not edited).
- **Keep-set test:** `test/startup.test.ts:143-155` drives `clearStrayPanes` with a fake `herdr` bin
  and an explicit `keep` set; the new keep-set builder is a pure function beside it.

## Findings that shape the spec

1. `staged` on `BoardRecord` is an optional additive field in `boards.<session>.json`; not a run
   ledger change, no `schema_version`, no `phases.ts` change. No migration.
2. `openBoard` already drops `staged`; only a test is needed.
3. `syncBoards` only closes boards whose pane is **listed** (`:96`, `:104`). A board whose pane is gone
   is never closed, so "unstage before close" alone does not cover it; the brief's "also covers a
   board whose pane is gone" holds only if `unstage(slug)` is called on the `:104` path regardless of
   whether a close happens (and on the `:97-99` delete path). The spec has to say where exactly the
   call sits relative to the `listed.has(...)` guard.
4. The kit client and the CLI `Herdr` class coexist; `unstageBoard` and the supervisor's
   `closeStagedWorker` use the kit client (`createClient`) because the kit's `unstage` takes a kit
   `Herdr` and a `Snapshot`.
5. Nothing in the pipeline stages a pane yet (`stageAgent` has no caller outside `test/kit`), so
   every behaviour here is reachable only after the sibling board-keys task lands. Unit tests are the
   only proof until then; a live check belongs in that task's runbook.

## Tier

`heavy` stays. The change is one surface (`plugin`), adds an optional field to the board registry
file only, and needs no migration — nothing found warrants raising it.
