# herdr-pl-2 — board stage record, unstage before close, keep staged panes

Bead `herdr-pl-2`. Plan 4 items 1–4 of `docs/superpowers/specs/2026-11-13-pasture-board-design.md`
("Stage (plan 4)", `:219-279`), the persistence and supervisor side only. Research:
`docs/superpowers/research/2026-11-14-herdr-pl-2-research.md`. Line numbers are at `8514924`.

## Problem

The pipeline board will stage a task's worker pane under itself with the kit's `stageAgent`
(`src/kit/stage.ts:100-148`): a placeholder holds the worker's spot in its worktree workspace and
`pane.move` carries the worker into the board's tab in the pipeline workspace. Nothing in the
pipeline is ready for a staged worker:

1. **No record.** `BoardRecord` (`src/lib/boards.ts:10-16`) has nowhere to keep the `Staged` value, so
   no process other than the board that staged it can ever undo the stage.
2. **Board closes strand the worker.** `syncBoards` closes boards at `src/supervisor/boards.ts:96`
   (slug no longer wanted) and `:104` (board not live), and replaces the record via `openBoard`
   (`:105`); "Open board" closes the recorded board at `src/actions/board.ts:40`. None of them moves
   the worker home first, so the worker is left in a tab with no board and its placeholder is left
   in the worktree forever.
3. **A herdr restart kills the worker.** `clearStrayPanes` (`src/startup.ts:138-151`, called at
   `:211`) closes every pane in the pipeline workspace that is not the supervisor, a plain `Board`,
   or a recorded board pane. A staged worker is none of those; it is closed, and the supervisor's
   `PaneAbsence` (`src/supervisor/tick.ts:343-384`) then fails its task through `losePane`
   (`:283-308`).
4. **Teardown leaves the worker running.** `removeWorktree` closes only the panes inside the
   worktree's workspace; a staged worker is in the pipeline workspace, so `runTeardown`
   (`src/supervisor/teardown.ts:168-229`) finishes the task with its worker still alive under the board.

## Goal

A staged worker is recorded per repo board, moved home before any board close, survives a herdr
restart, and is closed when its task is torn down — with every herdr effect behind an injected dep
so the existing fake-herdr tests keep working.

## Non-goals

- The board's stage/unstage keys and UI, and the call to `recordStaged` that writes a stage (the
  sibling board-keys task, which depends on this one).
- `former_pane_ids` and the pane-identity guards (spec item 5, a separate task).
- Pasture refusing to stage a pipeline pane.
- `layout.set_split_ratio` on board start.
- The board process unstaging itself on exit (spec item 2, "best effort") — not in the brief.
- Any change under `src/kit/` or `test/kit/` (`scripts/sync-kit.ts:6-10` deletes and re-copies them).

## Architecture

```
src/lib/boards.ts        StagedWorker, BoardRecord.staged, recordStaged,
                         unstageBoard, closeStagedWorker  (kit socket client)
src/supervisor/boards.ts BoardDeps.unstage; called on both close/replace paths
src/actions/board.ts     OpenBoardActionDeps.unstage; called before the close
src/startup.ts           strayKeepSet(boards, runs) → clearStrayPanes keep set
src/supervisor/teardown.ts TeardownDeps.closeStagedWorker?; called before removal
src/supervisor/main.ts   wires unstage + closeStagedWorker to the lib functions, logs failures
```

The two lib functions take the kit's `Herdr` (`src/kit/herdr.ts:12-14`, `{ call }`), because the
kit's `unstage` takes a kit `Herdr` and a `Snapshot`. Production builds one with `createClient()`
(`:32`); tests pass an object with `call`, as `test/kit/fake-herdr.ts` does. The CLI-backed
`src/lib/herdr.ts` `Herdr` the supervisor already holds is not used for these.

### Modelled on

- `recordStaged` ← `recordCleared` (`src/board/data.ts:28-36`): `updateBoards`, write only when the
  slug has a record, return whether it wrote.
- `BoardDeps.unstage` / `OpenBoardActionDeps.unstage` ← the existing injected `hasStore` /
  `workspaceId` deps on the same interfaces (`src/supervisor/boards.ts:15`, `src/actions/board.ts:15`).
- `TeardownDeps.closeStagedWorker` ← `removeWorktree`/`removeCheckout` (`teardown.ts:34-40`),
  wired the same way in `main.ts:373-374`.
- Lib function tests ← `test/board-data.test.ts` (temp state dir per test, `readBoards` to assert).

## Data

```ts
// src/lib/boards.ts
import type { Host, Staged } from '../kit/stage'

/** The host is kept so the stage can be undone after the board pane that made it is gone. */
export type StagedWorker = Staged & { host: Host }

export interface BoardRecord {
  pane_id: string | null
  shell_pid: number | null
  opened_at_ms: number
  cleared?: { run_id: string; tasks: string[] }
  staged?: StagedWorker | null
}
```

- **A1 — task match by pane id, not `task_id`.** Deviates from the design spec's
  `Staged & { task_id }` (`2026-11-13-pasture-board-design.md:237`). Teardown finds the stage for a
  task by `staged.paneId === task.pane_id`. `stageAgent` records the id `pane.move` returns
  (`stage.ts:134`, `:139-147`), and the supervisor rebinds `task.pane_id` to the moved id
  (`tick.ts:369-370` emits `pane.moved` on the first list that shows the terminal under a new id;
  `:503-511` rebinds). Once the supervisor has listed the moved pane, the two ids are equal.
- **A2 — additive, no migration.** `staged` is optional in `boards.<session>.json`, absent and
  `null` both mean "nothing staged". No run ledger, `schema_version` or `phases.ts` change.
- **A3 — the board keeps `staged` across its own re-record.** `runBoardPane` spreads the old record
  (`src/board.ts:57`), so no change there.
- **A4 — a new board never inherits a stage.** `openBoard` builds its record from scratch plus
  `cleared` only (`src/supervisor/boards.ts:30`), so `staged` is already dropped. Every path that
  reaches `openBoard` with a staged record unstages first (below). Pinned by a test; no code change.

## Control flow

### `recordStaged(stateDir, session, slug, staged: StagedWorker | null): Promise<boolean>`

`updateBoards`; if `boards[slug]` is absent return `false`; else set `boards[slug].staged = staged`,
return `true`. Not called in this task (the board-keys task calls it).

### Finding the staged pane (shared by both lib functions)

```ts
const stagedPane = (snap: Snapshot, staged: Staged) =>
  snap.panes.find((p) => p.terminal_id === staged.terminalId)
    ?? snap.panes.find((p) => p.pane_id === staged.paneId)
```

- **A5 — terminal id first, then pane id.** Mirrors the kit's own `keepStaged` (`stage.ts:160-162`):
  a move keeps the terminal id and renumbers the pane; a herdr restart keeps the pane id and changes
  the terminal id (`tick.ts:337-341`, measured live).

### `unstageBoard(herdr, stateDir, session, slug): Promise<void>`

1. `staged = (await readBoards(stateDir, session))[slug]?.staged`. If falsy, return — no socket call.
2. `snap = await readSnapshot(herdr)` (`src/kit/herdr.ts:73-75`).
3. Remap: `pane = stagedPane(snap, staged)`; `current = pane ? { ...staged, terminalId: pane.terminal_id, paneId: pane.pane_id } : staged`.
   Without it, the kit's `unstage` looks the worker up by terminal id only (`stage.ts:81`); after a
   restart it misses, closes the placeholder and gives up (`:83-86`), and the worker's home spot is lost.
4. Host: `boardPane = snap.panes.find((p) => p.pane_id === staged.host.boardPaneId)`;
   `host = boardPane ? { ...staged.host, tabId: boardPane.tab_id } : staged.host`.
   - **A6 — the board's current tab wins when the board pane is listed.** The kit refuses to move a
     worker that is not in `host.tabId` (`stage.ts:83`). Pane ids survive a restart; that tab ids do
     is not measured anywhere in this repo or the memory note on `pane.move`. Reading the tab from
     the board pane removes the dependence when the board is still there; when it is gone, the
     stored tab is the only evidence. If the reviewer prefers the stored value always (it is what
     the kit's `keepStaged` trusts, `stage.ts:163`), this step is one line to drop.
5. `await unstage(herdr, snap, host, current)` (kit, `stage.ts:80-98`): moves the worker next to its
   placeholder and closes it; no placeholder → new tab in the home workspace or, if that is gone,
   the board's workspace; worker not under the board → closes the placeholder only.
6. Clear: `updateBoards` → `if (sameStage(boards[slug]?.staged, staged)) boards[slug]!.staged = null`,
   where `sameStage` compares `paneId` and `terminalId` against the value read in step 1.
   - **A7 — compare-and-clear.** The board process writes `staged` too; a stage written between
     steps 1 and 6 is not wiped. Same lock discipline as `updateBoards` (`src/lib/boards.ts:51-61`).
   - **A8 — a throw leaves `staged` set.** `unstage`'s `move` throws `StageError` on
     `changed: false` (`stage.ts:40-44`) and the socket client throws `HerdrError`; step 6 is not
     reached, so the next caller can retry. In practice every caller is about to close or replace the
     record (A4, `src/supervisor/boards.ts:97-99`), so the stage is lost after a failed unstage; the worker itself
     keeps running in the board's tab. Accepted: the brief says a failure is logged and the close
     goes ahead.

### `closeStagedWorker(herdr, stateDir, session, slug, paneId): Promise<boolean>`

1. `staged = boards[slug]?.staged`. If falsy or `staged.paneId !== paneId`, return `false` — no
   socket call.
2. `snap = await readSnapshot(herdr)`; `pane = stagedPane(snap, staged)`; if found,
   `await herdr.call('pane.close', { pane_id: pane.pane_id })`.
3. Compare-and-clear `staged` as in `unstageBoard` step 6. Return `true`.

- **A9 — never close the placeholder.** It may be the last pane in the worktree's workspace; herdr
  destroys a workspace with its last pane (`src/startup.ts:130-132`), `worktreeRemovalFrom` would
  then report `gone` (`teardown.ts:23-29`) and teardown would fall to the stricter
  `removeCheckoutWithGit` (`:109-133`). `removeWorktree` closes it with the workspace.
- **A10 — a worker already gone still counts as closed.** If no pane is found, the stage is cleared
  and `true` returned, so the task is released either way.

### `syncBoards` (`src/supervisor/boards.ts:75-107`)

`BoardDeps` gains `unstage: (slug: string) => Promise<void>`.

```ts
for (const [slug, board] of Object.entries(recorded)) {
  if (wanted.has(slug)) continue
  if (board.staged) await deps.unstage(slug)                       // new
  if (board.pane_id !== null && listed.has(board.pane_id) && !(await deps.herdr.paneClose(...)).ok) continue
  ...delete
}
for (const slug of wanted) {
  const board = recorded[slug]
  if (board !== undefined && await isLive(board, listed, deps)) continue
  if (board?.staged) await deps.unstage(slug)                      // new
  if (board?.pane_id != null && listed.has(board.pane_id) && !(await deps.herdr.paneClose(...)).ok) continue
  await openBoard(slug, deps, board)
}
```

- **A11 — unstage sits before the `listed.has` guard, not inside it.** Research finding 3: a board
  whose pane is not listed is never closed (`src/supervisor/boards.ts:96`, `:104`) but its record is deleted
  (`:97-99`) or replaced (`:105`), which drops `staged` all the same. Calling `unstage` ahead of the
  guard covers "a board whose pane is gone" — the spec's "a recorded stage whose board pane is gone
  is a stage to undo" (`2026-11-13-pasture-board-design.md:251-252`).
- **A12 — called only when the record has a stage.** `board.staged` is read from the registry this
  tick already loaded (`:86`). It keeps the common path free of a lock, a read and a socket
  connect, and the dep's contract simple: it is only ever called with something to undo.
  (`unstageBoard` still re-reads and returns early if the stage has since been cleared.)
- **A13 — clearing `staged` does not break the compare-and-swap.** `openBoard` and the delete both
  guard with `sameBoard` (`src/lib/boards.ts:37-40`), which compares only `pane_id`, `shell_pid` and
  `opened_at_ms`.
- **A14 — the ghost close (`src/supervisor/boards.ts:90-92`) is untouched.** A ghost has no record, so no stage.

### "Open board" (`src/actions/board.ts:23-50`)

`OpenBoardActionDeps` gains `unstage: (slug: string) => Promise<void>`. Before line 40:
`if (recorded?.staged) await deps.unstage(slug)`. Same reasoning as A11/A12.

### `clearStrayPanes` keep set (`src/startup.ts`)

```ts
export function strayKeepSet(boards: BoardRegistry, runs: readonly Run[]): Set<string>
```

Union of:
- `recordedBoardPanes(boards)` (today's set, `src/lib/boards.ts:42-44`);
- every non-null `staged.paneId` and `staged.placeholderPaneId`;
- `task.pane_id` of every task with `!FINISHED.has(task.phase)` in a run with `runIsDriven(run)`
  (`teardown.ts:16-18`, `src/lib/ledger.ts:319-325`).

`main` (`startup.ts:211`) passes
`strayKeepSet(await readBoards(stateDir, session), (await listRuns(stateDir, session)).filter(isCurrentSchemaRun))`,
the read `main.ts:492-494` does (without `REPOS_ALLOW`: keeping more panes is the safe direction).
`clearStrayPanes` itself is unchanged.

- **A15 — bound panes are kept, not just staged ones.** After a restart, pane ids survive
  (`tick.ts:339-340`), so a worker whose stage record was lost (A8) is still kept by its task binding.
- **A16 — the placeholder entry is defence only.** `clearStrayPanes` lists the pipeline workspace
  (`startup.ts:141`) and the placeholder lives in the worktree workspace (`stage.ts:122-130`), so
  today it is never a candidate. Kept because the brief asks for it and it costs one set entry.
- **A17 — `escalated` runs are not driven** (`src/lib/phases.ts:148-149`), so their tasks' bound panes are not
  kept unless staged. Matches the brief. A worker staged from an escalated run is still kept by A16's
  `staged.paneId`.

### Teardown (`src/supervisor/teardown.ts:168-229`)

`TeardownDeps` gains `closeStagedWorker?: (run: Run, task: Task) => Promise<boolean>`.

In `runTeardown`, after the `keep_worktree` branch (`:179-182`) and before `const workspaceId`
(`:184`):

```ts
if (task.pane_id !== null && await deps.closeStagedWorker?.(run, task)) releaseWorkerPane(task)
```

- **A18 — optional dep.** `TaskDeps extends TeardownDeps` (`tasks.ts:42`) and 11 test files build
  `TaskDeps`/`TeardownDeps` (research). Absent means today's behaviour exactly.
- **A19 — before both removal paths.** Placed ahead of `workspaceId`, so it runs before
  `removeWorktree` (`:186`) and before the checkout fallback (`:214`).
- **A20 — `keep_worktree` skips it.** The human asked to keep the work; the worker stays staged and
  goes home on the next board close (`unstageBoard`). Its home workspace still exists, since it was
  kept.
- **A21 — the release is not pushed as a `RunEffect`.** If the save loses to a CLI write, the task
  is still in `teardown`, bound to a closed pane. The next teardown pass gets `false` (stage already
  cleared) and proceeds; `PaneAbsence` then reports `pane.closed`, and `losePane` only releases a
  task with no worker phase ahead (`tick.ts:290-293`, `workerStillNeeded` `:263`) — `teardown` has
  none. `markTornDown` releases it on the removed path anyway (`teardown.ts:55-58`).

Supervisor wiring (`main.ts:373-374`):

```ts
closeStagedWorker: async (run, task) => {
  try {
    return await closeStagedWorker(kit, stateDir, session, beadsSlug(run.repo_key), task.pane_id!)
  } catch (error) {
    console.error(`[pipeline] run ${run.run_id}: could not close ${task.task_id}'s staged worker: ${error}`)
    return false
  }
},
```

`kit` is one `createClient()` built beside the supervisor's `herdr`.

## Error handling

| Where | Failure | Behaviour |
|---|---|---|
| `syncBoards` wiring (`main.ts:513`) | `unstageBoard` rejects | `unstage: (slug) => unstageBoard(kit, …).catch((e) => console.error(...))`: logged, the close/replace goes ahead (A8). |
| "Open board" `import.meta.main` | same | same `.catch`, `console.error`. |
| `syncBoards` itself | — | Awaits `deps.unstage`; the dep's contract is that it does not reject. A rejecting dep would still be caught by `eachIsolated` (`main.ts:106-117`, called at `:495`) and only skip that tick's board upkeep. |
| Teardown wiring | `closeStagedWorker` throws | Logged, returns `false`; teardown proceeds as today and the worker survives under the board (the problem today, no worse). |
| `recordStaged` | no record | Returns `false`, writes nothing (as `recordCleared`). |
| Socket client | herdr not answering | `HerdrError('timeout')` after 10 s (`src/kit/herdr.ts:32-41`) → as above. |

## Testing strategy

TDD, failing test first for each item.

**`test/boards-stage.test.ts`** (new; temp dir as `test/board-data.test.ts:10-12`; fake kit `Herdr`
from `test/kit/fake-herdr.ts` — imported, not edited; snapshots shaped as in `test/kit/stage.test.ts`):
- `recordStaged`: writes onto an existing record, returns `false` and writes nothing with none.
- `unstageBoard`: no record → no calls; record without `staged` → no calls; staged worker under the
  board with a placeholder → `pane.move` to the placeholder's tab split right of it, then
  `pane.close` of the placeholder, and `staged` becomes `null`; **restart**: the snapshot shows the
  worker with a new terminal id and the same pane id → it is still moved home (`pane.move` called with
  that pane id), not just a placeholder close; a stage replaced between read and clear is not wiped
  (A7); a throwing `pane.move` leaves `staged` set (A8).
- `closeStagedWorker`: no stage, or a stage of another pane → `false`, no calls; matching stage →
  `pane.close` of the worker only (never the placeholder), `staged` → `null`, `true`; worker already
  gone → no close, `staged` → `null`, `true`.

**`test/board.test.ts`** — `deps()` (`:51-56`) and `actionDeps()` (`:310-320`) gain a recording
`unstage` that pushes `unstage <slug>` into the same `calls` log, so order is asserted:
- `syncBoards` calls `unstage` before closing a finished run's board, and before closing and
  reopening a dead board; it calls it for a staged board whose pane is not listed; it does not call
  it for a record without `staged`.
- "Open board" calls `unstage` before closing the recorded board.
- `openBoard` given an `expected` record with `staged` writes a record without it.

**`test/startup.test.ts`** — `strayKeepSet`: keeps a driven run's bound worker pane, the recorded
board pane, `staged.paneId` and `staged.placeholderPaneId`; drops a finished task's pane and a bound
pane of an `escalated` run.

**`test/teardown.test.ts`** — with `removingBy` (`:36-39`) plus `closeStagedWorker`:
- a staged task: `closeStagedWorker` is called before `removeWorktree` (shared call log), and the
  task's `pane_id` is released (`last_pane_id` set, `agent_status: 'unknown'`);
- `closeStagedWorker` returning `false` leaves `pane_id` as it was;
- no `closeStagedWorker` dep: behaves exactly as today (an existing test already covers this path);
- `keep_worktree`: not called.

`bunx tsc --noEmit` and `bun test` green.

**Live verification.** Nothing stages a pane until the board-keys task lands (research finding 5), so
these paths cannot be exercised in a real herdr session from this branch alone. The plan for that
task should add a runbook step to `test/integration/smoke.md`: stage a worker, restart herdr, confirm
it survives and the board's "Open board" moves it home; merge a staged task and confirm the worker
closes and the worktree removal reports `removed`, not `gone`.
