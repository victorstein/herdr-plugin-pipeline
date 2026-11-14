# herdr-pl-4 design — board: enter stages a worker, tab focuses, z zooms

Bead `herdr-pl-4`, task `t4`. Branch `feat/board-staging`, base `cad73da`.
Research: `docs/superpowers/research/2026-11-14-herdr-pl-4-research.md`.
Parent design: `docs/superpowers/specs/2026-11-13-pasture-board-design.md` ("Keys", "Stage (plan 4)",
"Board pane and layout").
Review: `docs/superpowers/reviews/herdr-pl-4-spec-review-0.md` (CLEAR, 3 MAJOR, 4 MINOR — all applied;
see "Changes after review 0").

**Modelled on:** pasture's board, `~/Documents/development/personal/herdr-pasture/src/board.ts`
(`stage` `:101-109`, `focusStage`/`zoomStage` `:181-191`, reconcile in `refresh` `:70-85`, the
stale-board quit `:66`, keys `:253-257`). The kit both boards run on is identical (`diff -r` of the
two `src/kit` prints nothing). The new helpers module follows `src/board/data.ts` (small exported
functions the UI calls), and its tests follow `test/boards-stage.test.ts` (temp state dir plus
`test/kit/fake-herdr.ts`).

## Problem

The board shows every task's worker but cannot bring one to you. Plan 4's persistence and supervisor
half has landed (#175): `BoardRecord.staged`, `recordStaged` and `unstageBoard`
(`src/lib/boards.ts:19-23, 81-113`), and every supervisor close path already unstages
(`src/supervisor/boards.ts:101,110`, `src/actions/board.ts:43`). What is missing is the board side:
nothing ever stages, the board never reconciles a stage, and the `placeholder` pane the kit opens
(`PIPELINE.placeholderEntrypoint`, `src/board/ui.ts:22`) is not declared in `herdr-plugin.toml`
(panes at `:89-115` are `supervisor`, `board`, `peek`, `details`), so `stageAgent`'s
`plugin.pane.open` (`src/kit/stage.ts:122-130`) would fail.

## Goal

- `enter` on a task card moves that task's worker under the board (board keeps the top 25%,
  `STAGE_RATIO`, `src/kit/stage.ts:31,134`), leaving an "On stage" placeholder in its home tab.
- `tab` focuses the staged pane; `z` toggles its zoom.
- Every refresh reconciles the recorded stage with what herdr shows.
- Quitting the board sends the staged worker home.
- The manifest, keys line and README describe it.

## Non-goals

- **Staging the orchestrator** (parent spec "Why the orchestrator is not staged").
- **`layout.set_split_ratio` on startup.** The parent spec ("Board pane and layout") says a board that
  starts and finds a stage recorded re-applies 0.25. See A11: this design undoes such a stage instead,
  so there is never a recorded stage to resize. `grep -rn set_split_ratio src` finds no use today.
- **Any change to `src/kit/`, `src/lib/boards.ts`, the supervisor, or the ledger.** No schema or
  `phases.ts` change; runs on disk are unaffected.
- **Editing `skills/herdr-pipeline/`.** It lists no board keys (A13).
- A status message for `tab`/`z` with nothing staged (A9).
- **Pasture refusing pipeline-bound panes** (parent spec "Rules", `pasture-board-design.md:271-276`,
  and its plan-4 test list `:373`). That half lives in the herdr-pasture repo; at `ec34957` pasture's
  `stage()` (`board.ts:101-109`) stages any terminal. **Known gap**, reported to the orchestrator
  rather than filed here. This board's half of the rule is A17.
- **`openBoard` dropping `staged` after a failed unstage** (review 0 MINOR 2): `openBoard` writes a
  fresh record without `staged` (`src/supervisor/boards.ts:32-36`) even when the unstage before it
  failed and was swallowed (`src/actions/board.ts:71-72`), stranding the worker. That is #175's code;
  filed with `hpipe discover`.

## Architecture

| File | Change |
|---|---|
| `src/board/stage.ts` (new) | `NO_WORKER`, `boardHost`, `workerFor`, `syncStage`, `stageCard`, `unstageOwn` |
| `src/board/ui.ts` | holds `staged`; calls `syncStage` in `refresh`; `enter`/`tab`/`z` in `onKey`; async `quit` |
| `src/board/view.ts:9` | `KEYS` |
| `herdr-plugin.toml` | `[[panes]] id = "placeholder"` |
| `README.md:481-491` | key table rows; the "read-only" paragraph |

`src/board/stage.ts` takes everything it needs as arguments (herdr client, state dir, session, slug,
snapshot, host, identity), so it is testable with `fakeHerdr` and a temp dir, and `ui.ts` stays the
untested wiring it is today (research "Tests to model on"). It imports `Identity`'s type, not
`PIPELINE`: `ui.ts` passes `PIPELINE` in, which avoids a `ui.ts` ↔ `stage.ts` import cycle and lets
the live harness pass another identity (see "Live check").

### `src/board/stage.ts`

```ts
export const NO_WORKER = 'no worker to stage'
export const ELSEWHERE = 'that worker is on another stage'

/** The board's own pane as the kit's host, or null when the board does not know its pane. */
export function boardHost(snap: Snapshot, boardPaneId: string | undefined): Host | null

/** The pane to stage for a card, or the status-line text saying why there is none. */
export function workerFor(run: Run | null, snap: Snapshot, host: Host, cardId: string): PaneInfo | string

/** Reconcile on refresh. Returns the stage this board now holds. */
export async function syncStage(herdr, snap, host, stateDir, session, slug): Promise<StagedWorker | null>

/** Stage one worker under this board and record it. Throws StageError with a status-line message. */
export async function stageCard(herdr, host, identity, stateDir, session, slug, terminalId): Promise<StagedWorker>

/** Quit: undo the recorded stage only if this board made it. */
export async function unstageOwn(herdr, stateDir, session, slug, boardPaneId): Promise<void>
```

- `boardHost`: finds `p.pane_id === boardPaneId` in `snap.panes` and returns
  `{ workspaceId: p.workspace_id, tabId: p.tab_id, boardPaneId }`; `null` when `boardPaneId` is
  undefined or the pane is not in the snapshot. Same lookup as `visible()` (`src/board/ui.ts:102-107`).
- `workerFor`, in order:
  1. `task = run.tasks.find(t => t.task_id === cardId)` — none (a run card, `run:<id>`) → `NO_WORKER`;
  2. `pane = snap.panes.find(p => p.pane_id === task.pane_id)` — none → `NO_WORKER` (as `peekWorker`,
     `src/board/ui.ts:122-130`);
  3. `pane.pane_id === run.orchestrator_pane` → `NO_WORKER` (A6);
  4. the pane is neither in its task's workspace (`pane.workspace_id === task.workspace_id`,
     `src/lib/types.ts:267`) nor in the board's tab (`pane.tab_id === host.tabId`) → `ELSEWHERE` (A17);
  5. otherwise the pane. A pane already under this board passes, so the kit answers it
     (`stageAgent` returns the current stage, or throws "already under the board", `:101,104`).

## Data and control flow

### Refresh (every throttled refresh and the 2 s poll, `src/board/ui.ts:46-84, 202`)

1. `refresh` reads the snapshot and builds the board as today.
2. **Last**, in both the run and the no-run branch, it computes `host = boardHost(current,
   process.env.HERDR_PANE_ID)` and, when `host` is not null, `staged = await syncStage(herdr, current,
   host, …)` — **with the snapshot `refresh` already read, never a fresh one** (A3, A4, A18).
3. `syncStage`:
   1. `record = (await readBoards(stateDir, session))[slug]`.
   2. If `record?.pane_id !== host.boardPaneId` — no record yet, or this board has been replaced —
      return `null` and touch nothing (A12).
   3. `recorded = record.staged ?? null`. If `recorded` and `recorded.host.boardPaneId !==
      host.boardPaneId` — a stage left by an earlier board in this record — `await
      unstageBoard(herdr, stateDir, session, slug)` and return `null` (A11).
   4. Otherwise `kept = await reconcile(herdr, snap, host, recorded)` (`src/kit/stage.ts:150-156`):
      keeps the stage if its pane is still in the board's tab (by terminal id, else pane id after a
      herdr restart), otherwise closes the placeholder and drops it; adopts a single stray agent under
      the board; evicts the rest to new tabs.
   5. `next = kept ? { ...kept, host } : null`.
   6. If `JSON.stringify(next) !== JSON.stringify(recorded)`, `await recordStaged(stateDir, session,
      slug, next, recorded)` — with `expected = recorded`, so a stage the supervisor cleared
      meanwhile is not written back (`src/lib/boards.ts:75-91`). The result is ignored; the next
      refresh rereads (A5).
   7. Return `next`.

### `enter` (`\r` or `\n`, A2)

`onKey` → `serial(() => stageWorker(card)).then(draw)` where `stageWorker` in `ui.ts`:

1. `host = snap && boardHost(snap, process.env.HERDR_PANE_ID)`; null →
   `message = 'this board does not know its pane'`, return (A7).
2. `worker = workerFor(run, snap, host, card.id)`; a string → `message = worker`, return.
3. `staged = await stageCard(herdr, host, PIPELINE, stateDir, session, slug, worker.terminal_id)`.
4. `snap = await readSnapshot(herdr)` — as pasture (`board.ts:108`), so a `tab` or `z` queued behind
   the stage on `serial` finds the worker under its new pane id (A19); then `requestRefresh()` so the
   board and the supervisor's rebind show up.

`stageCard`:

1. `record = (await readBoards(...))[slug]`. No record → `throw new StageError('this board is not
   recorded yet')` (text as the `x` message, `src/board/ui.ts:171`); `record.pane_id !==
   host.boardPaneId` → `throw new StageError('this board has been replaced')`. Both before anything
   moves (A8, A12).
2. `current = record.staged ?? null`; if it belongs to another board
   (`current.host.boardPaneId !== host.boardPaneId`), `await unstageBoard(...)` and `current = null`.
3. `fresh = await readSnapshot(herdr)` (pasture `board.ts:102`).
4. `staged = await stageAgent(herdr, fresh, host, identity, current, terminalId)`
   (`src/kit/stage.ts:100-148`). It returns `current` untouched for the same terminal, throws
   `StageError` for a gone agent or one already under the board, and **unstages `current` first**
   when staging a different worker (`:106-110`) — the "sends the first worker home" acceptance.
5. `next = { ...staged, host }`, written with `updateBoards` (`src/lib/boards.ts:58-68`) **only if the
   record still names this board** (`boards[slug]?.pane_id === host.boardPaneId`). If not — the
   supervisor deleted or replaced this board while the move ran — undo with the kit's
   `unstage(herdr, await readSnapshot(herdr), host, next)` and throw `StageError('this board has
   been replaced')` (A8, A12). `recordStaged` is not used here because it checks only that a record
   exists, and `openBoard`'s replacement record (`src/supervisor/boards.ts:32-36`) would accept a
   stale board's stage.
6. Return `next`.

Errors from `stageCard` reject into `serial`'s catch, which sets `message` to the error text
(`src/board/ui.ts:44`); `StageError` messages are written for the status line
(`src/kit/stage.ts:42,103,104`).

### `tab` and `z`

As pasture (`board.ts:181-191`): find the staged pane in `snap` by `staged.terminalId`; if found,
`pane.focus { pane_id }` or `pane.zoom { pane_id, mode: 'toggle' }` through `serial`. Nothing staged or
pane gone → no call, no message (A9). Because `enter` re-reads `snap` before it finishes (step 4),
`enter tab` in one chunk focuses the new pane.

### Quit (`q`, ctrl+c, stdin `end`/`error`, SIGHUP — `src/board/ui.ts:153-181`)

```ts
let quitting = false
function quit(): void {
  if (quitting) return
  quitting = true
  void serial(() => unstageOwn(herdr, stateDir, session, slug, process.env.HERDR_PANE_ID ?? '').catch(() => {}))
    .finally(() => { out(deleteAllImages() + '\x1b[2J\x1b[?25h'); process.exit(0) })
}
```

- `quit` no longer returns `never`; `onKey` returns right after calling it and ignores keys once
  `quitting` is set.
- It runs on `serial`, so it waits for a stage or refresh already in flight instead of racing it (A10).
- `unstageOwn` reads the record and calls `unstageBoard` only when `record.pane_id === boardPaneId`
  and `record.staged?.host.boardPaneId === boardPaneId` (A12).
- `stdout` `error` (`:180`) also goes through `quit`, so the stage is still undone; a `stdout.write`
  after `EPIPE` does not throw in Bun (review 0, "Verified and holding"), so the exit still happens.

## Assumptions (each a decision the review can attack)

- **A1. Helpers live in a new `src/board/stage.ts`.** `ui.ts` has no tests and starts the process loop;
  extracting puts every stage decision under test. Alternative rejected: growing `data.ts`, which is
  about the ledger and the board registry's `cleared`, not herdr.
- **A2. `enter` is `\r` or `\n`.** herdr 0.9.1 forwards Enter as `\n`
  (`test/board-keys.test.ts:11-12`); a raw terminal sends `\r`. A `\r\n` chunk splits into two keys
  (`src/board/keys.ts:11`); the second is a no-op because it runs after the first on `serial`, reads
  the recorded stage, and `stageAgent` returns early for the same terminal (`src/kit/stage.ts:101`).
- **A3. Reconcile runs last in `refresh`.** If it throws (a refused evict), the board has already been
  rebuilt and only the status line shows the error; placing it first would freeze the board on every
  failing refresh. The no-run branch (`src/board/ui.ts:51-54`) must not skip it.
- **A4. No host, no stage.** Without `HERDR_PANE_ID`, or with the board pane absent from the snapshot,
  the board never reconciles, stages, or unstages on quit. Pasture falls back to stored ids
  (`board.ts:22-26`); this board has no stored host of its own other than the record, and acting on a
  guessed tab could move panes that are not its own.
- **A5. Write back only on change, guarded by `expected`.** Mirrors pasture's JSON compare
  (`board.ts:78`), plus `recordStaged`'s `expected` so the board never resurrects a stage the
  supervisor's `closeStagedWorker` (`src/lib/boards.ts:122-136`) or `syncBoards` cleared.
- **A6. Staging only `task.pane_id`, with an orchestrator-pane guard.** Cards are tasks or the run card
  (`src/board/model.ts:81-107`); the orchestrator sits on `run.orchestrator_pane`, never on a task. The
  guard costs one comparison and makes "never stage the orchestrator" a tested property.
- **A7. A board that cannot find its own pane says so** (`this board does not know its pane`) instead
  of silently doing nothing. New message text; no existing one fits.
- **A8. Staging requires this board's record, checked before and after the move.** Without it the
  stage could not be persisted, so the supervisor's close paths and the restart keep set
  (`src/startup.ts:140-142`) would not know about it, and a later reconcile would `adopt` the worker
  with its home set to the pipeline workspace (`src/kit/stage.ts:69-72`), losing its placeholder. The
  pre-check refuses early; the post-check undoes a move whose record disappeared or was replaced
  mid-flight.
- **A9. `tab`/`z` with nothing staged do nothing**, as pasture. The keys line already says what they do.
- **A10. Quit waits on `serial` with no extra timeout.** A herdr call times out after 10 s
  (`src/kit/herdr.ts:32`) and the board file lock is bounded (`src/lib/store.ts:185-189`), so a hung
  herdr delays exit by at most the in-flight calls. Not waiting risks a quit landing mid-stage and
  leaving the worker staged with no record. No hard-exit timer is added; none exists in either board.
- **A11. A stage recorded by another board pane, in a record that names this board, is undone, not
  adopted.** Brief step 3. `runBoardPane` keeps the old record's fields when it records itself
  (`src/board.ts:57`), so a board started by a path that did not unstage first (the supervisor's
  close paths and "Open board" do, `src/supervisor/boards.ts:101,110`, `src/actions/board.ts:43`)
  inherits the old board's `staged`. It is not a net for a failed unstage before "Open board": that
  path's `openBoard` writes a record without `staged` (`src/supervisor/boards.ts:32-36`), so the worker
  is stranded there — a #175 gap filed with `hpipe discover` (Non-goals). This is also why the startup
  split-ratio step is dropped.
- **A12. A replaced board acts on nothing.** A board whose record names another pane — "Open board"
  replaced it, and its `paneClose` result is ignored (`src/actions/board.ts:44`), so the old board can
  live until the supervisor's next tick — neither reconciles, stages, nor unstages on quit. Otherwise
  it would undo the newer board's stage. Pasture quits outright in that case (`board.ts:66`); this
  board keeps running, because its pane is the supervisor's to close (`src/supervisor/boards.ts:89-93`
  closes renamed boards no record names).
- **A13. No skill change.** `grep -rn -i board skills/herdr-pipeline/` finds only `SKILL.md:164`, the
  missing-tab recovery row; brief item 7 applies only "wherever" keys are listed.
- **A14. Keys line.** New `KEYS`:
  `'hjkl move  enter stage  tab focus  z zoom  space peek  o orch  d details  x clear'` (81 code
  points). The status line is `cols - 1` wide and is `summary + '  ' + keys`, with `keys` cut with `…`
  to the room left (`src/kit/render.ts:164-171`). With a 42-point summary at 120 columns the room is
  `119 - 42 - 2 = 75`, so today's line plus the three keys (94) would hide all of them. Choices: drop
  the arrow glyphs (pasture's line says `hjkl move` too, `pasture src/view.ts:14`; arrows still
  work), shorten `orchestrator` to `orch`, and put the stage keys right after `move` (pasture's order).
  At 120 columns it renders `hjkl move  enter stage  tab focus  z zoom  space peek  o orch  d details
  …` (`x clear` is lost); the whole line shows from 126 columns; the stage keys survive down to about
  80.
- **A15. Manifest pane exactly as pasture's** (`pasture herdr-plugin.toml:24-27`): `id = "placeholder"`,
  `title = "On stage"`, `placement = "split"`, `command = ["bun", "run", "src/kit/placeholder.ts"]`.
  The kit passes its title and stage name through `KIT_TITLE`/`KIT_STAGE` (`src/kit/stage.ts:129`,
  `src/kit/placeholder.ts:7-8`); the screen reads "is on the pipeline stage".
- **A16. README.** Add `enter`, `tab`, `z` rows to the key table (`README.md:481-488`) and replace "The
  board is read-only: it moves no pane and writes nothing to the ledger or the store"
  (`README.md:490`) with: the board writes nothing to the ledger; `enter` moves the task's worker
  under the board, leaving an "On stage" placeholder in its tab; staging another card, quitting the
  board, or the supervisor closing it sends the worker home; closing the board's tab by hand closes the
  staged worker with it, and the task fails (parent spec "Rules", known limit).
- **A17. This board refuses a worker that is on another stage.** The parent spec's "one stager owns
  pipeline panes" rule (`pasture-board-design.md:271-276`) has two halves. Without this half, `enter`
  on a worker pasture has staged would open the pipeline placeholder inside pasture's tab, pasture's
  next reconcile would close its own placeholder in the worker's worktree (`src/kit/stage.ts:163-165`),
  and the worker's home would be lost; teardown would then miss a worker pasture later adopts, since
  it closes a worker outside its workspace only through this board's record
  (`src/supervisor/teardown.ts:190`). The test is "in its task's workspace or already under this
  board", which a pipeline worker always satisfies unless something else moved it. A task with
  `workspace_id: null` and a live pane is refused too.
- **A18. `syncStage` uses `refresh`'s snapshot, read before the record.** Teardown's
  `closeStagedWorker` clears the record and then closes the pane (`src/lib/boards.ts:125-134`). A
  snapshot read before the record cannot show the worker gone while the record still holds it, so the
  `expected` write-back (A5) never races it. A fresh snapshot inside `syncStage` would.
- **A19. `enter` re-reads the snapshot before finishing.** A move renames the pane
  (`src/supervisor/tick.ts:337-338`, `src/kit/stage.ts:43`), keys of one stdin chunk dispatch
  synchronously (`src/board/ui.ts:191`), and herdr sends `send-keys … enter tab` as one chunk
  (`test/board-keys.test.ts:11-12`). Without the re-read, a `tab` queued behind the stage focuses the
  pre-move pane id and herdr answers `pane_not_found`.

## Error handling

| Situation | Result |
|---|---|
| run card, unbound task, pane gone, orchestrator pane | status `no worker to stage`, nothing called |
| worker outside its workspace and not under this board | status `that worker is on another stage` |
| board pane unknown | status `this board does not know its pane` |
| no board record before the move | `StageError('this board is not recorded yet')`, nothing moved |
| record names another pane, before or after the move | `StageError('this board has been replaced')`; a completed move is undone |
| agent gone / already under the board / move refused | kit's `StageError` text on the status line |
| any herdr error in `enter`/`tab`/`z` | `HerdrError` text via `serial`'s catch |
| reconcile or `unstageBoard` fails in refresh | board already rebuilt; error on the status line; next refresh retries |
| unstage fails on quit | ignored; the board exits. The pane drops to the user's shell with the recorded `shell_pid` (`herdr-plugin.toml:99`, `src/board.ts:14-15,57`), so `syncBoards` still judges it live (`src/supervisor/boards.ts:66-69`) and does **not** unstage. The worker stays under the shell until "Open board", the run ends, or teardown (`closeStagedWorker`) |

## Testing strategy

TDD, failing test first, as the brief requires.

**Unit — `test/board-stage.test.ts` (new)**, temp state dir and `fakeHerdr`, modelled on
`test/boards-stage.test.ts` and its `onStage`/`withBoard` fixtures:

- `boardHost`: builds the host from the board's snapshot pane; `null` with no pane id or a pane not in
  the snapshot.
- `workerFor`: a task with a live pane in its workspace → that pane; a run card (`run:<id>`) →
  `NO_WORKER`; `pane_id: null` → `NO_WORKER`; a pane not in the snapshot → `NO_WORKER`; a pane equal
  to `run.orchestrator_pane` → `NO_WORKER`; a pane in a third workspace → `ELSEWHERE`; a pane already
  under the board → the pane.
- `syncStage`:
  - a record naming another board pane: no herdr call, no write, returns `null`;
  - a stage recorded by another board pane in this board's record is unstaged (worker moved home,
    record `null`);
  - a kept stage with no change makes no write (record bytes unchanged) and no herdr call;
  - a staged worker no longer under the board: placeholder closed, record set to `null`;
  - a stage the supervisor cleared between read and write is not resurrected (`expected`).
- `stageCard`:
  - records `{ ...staged, host }`, opens the identity's placeholder entrypoint split right of the
    worker, then moves it with `split: 'down', ratio: 0.25`;
  - with a stage already recorded, the first worker's move home comes before the new worker's move
    (order of `calls`);
  - no record, or a record naming another pane → throws, and no herdr call that moves or opens a pane;
  - another board's recorded stage is unstaged first;
  - **the record is replaced while the move runs** (the fake's `pane.move` handler rewrites the
    record's `pane_id`): the worker is moved back next to its placeholder, the placeholder is closed
    after that move, the record is not written, and the error is `this board has been replaced`.
- `unstageOwn`: unstages this board's stage; leaves another board's stage alone; does nothing when
  the record names another pane.

**Unit — existing files**

- `test/board-view.test.ts:58` updated to the new `KEYS`.
- `test/prompts.test.ts` (where the manifest is already read, `:211-233`): the manifest declares
  `id = "placeholder"` with `command = ["bun", "run", "src/kit/placeholder.ts"]`, and that file exists.

`bunx tsc --noEmit` and `bun test` green.

### Live check

herdr's plugin registry is global (`~/.config/herdr/plugins.json`), and `stein.pipeline` there is the
GitHub install at 2.2.3, whose manifest has no `placeholder` pane and whose action and supervisor
have no `unstageBoard`/`closeStagedWorker` (review 0 MAJOR 2). A scratch herdr session therefore runs
the installed code for every plugin-mediated step, and `herdr plugin link` of this worktree would also
swap the plugin under the live session driving this run (`.claude/agents/plugin-dev.md` "The
self-hosting hazard"). So the live check is a **worker-run harness** on this branch's code, modelled
on pl-2's Task 9 (`docs/superpowers/plans/2026-11-14-herdr-pl-2-plan.md:1096-1140`):

- a scratch `herdr --session`, every call guarded by its `HERDR_SOCKET_PATH`, and a temp
  `HERDR_PLUGIN_STATE_DIR` holding a fake run and a board record;
- **the placeholder** comes from the linked pasture plugin (`stein.pasture`, `plugin_root` the pasture
  checkout in `plugins.json`), whose `placeholder` pane runs the identical `src/kit/placeholder.ts`.
  The harness calls this branch's `stageCard` with `{ ...PIPELINE, pluginId: 'stein.pasture' }`;
  `stageName` still reads `pipeline`. Opening a plugin pane starts no pasture board;
- reopen and teardown are driven through this branch's `unstageBoard` and `closeStagedWorker` from a
  helper script, not the installed action and supervisor;
- the binding is checked by running this branch's rebind on the scratch session's `pane.moved`
  (no branch supervisor runs): the moved pane's new id and the old one in `former_pane_ids`.

Steps (parent spec "Plan 4 live check" 1, 3, 4):

1. `stageCard` on a fake worker: it moves under the board pane at 25/75, the placeholder sits in its
   tab, and the rebind follows. `stageCard` on a second worker sends the first home first.
2. `unstageBoard` (what "Open board" calls): the worker goes home and the placeholder closes.
3. `closeStagedWorker` while staged: no pane is left behind.

**The board's own keys** (`enter tab z` through `ui.ts` with the `stein.pipeline` placeholder) can only
run live once this manifest is registered. Whether to time-box a `herdr plugin link` of the worktree
(restoring the pinned install right after, while the live run is idle) or to defer that step to a
post-release check is raised with `hpipe decide` at the implement phase, where it is run.

A difference between this list and what herdr does is a finding for the PR, not a test to bend.

## Changes after review 0

| Finding | Change |
|---|---|
| MAJOR 1 — `tab`/`z` after `enter` used the pre-move pane id | `enter` step 4 re-reads `snap` (A19); the harness covers it once the keys run live |
| MAJOR 2 — live check ran the installed 2.2.3 plugin | Live check rewritten as a branch-code harness with pasture's placeholder; the link question deferred to `hpipe decide` at implement |
| MAJOR 3 — "one stager owns pipeline panes" had no owner | A17 guard in `workerFor` with `ELSEWHERE` and a test; pasture's half recorded as a known gap in Non-goals and reported to the orchestrator |
| MINOR 1 — stale-board guard checked the wrong field | `syncStage`, `stageCard` and `unstageOwn` act only when `record.pane_id` is this board (A12); the post-move write uses `updateBoards` under that guard instead of `recordStaged` |
| MINOR 2 — two wrong recovery claims | Error-table quit row and A11 corrected; the `openBoard` gap filed with `hpipe discover` |
| MINOR 3 — post-move undo untested | `stageCard` test for a record replaced mid-move |
| MINOR 4 — keys width arithmetic | A14 recomputed: room 75, `x clear` lost at 120 columns |
