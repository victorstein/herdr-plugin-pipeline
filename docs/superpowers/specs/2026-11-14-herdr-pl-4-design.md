# herdr-pl-4 design — board: enter stages a worker, tab focuses, z zooms

Bead `herdr-pl-4`, task `t4`. Branch `feat/board-staging`, base `cad73da`.
Research: `docs/superpowers/research/2026-11-14-herdr-pl-4-research.md`.
Parent design: `docs/superpowers/specs/2026-11-13-pasture-board-design.md` ("Keys", "Stage (plan 4)",
"Board pane and layout").

**Modelled on:** pasture's board, `~/Documents/development/personal/herdr-pasture/src/board.ts`
(`stage` `:101-109`, `focusStage`/`zoomStage` `:181-191`, reconcile in `refresh` `:70-85`, keys
`:253-257`). The kit both boards run on is identical (`diff -r` of the two `src/kit` prints nothing).
The new pure/IO helpers module follows `src/board/data.ts` (small exported functions the UI calls),
and its tests follow `test/boards-stage.test.ts` (temp state dir plus `test/kit/fake-herdr.ts`).

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

## Architecture

Three files change behaviour, one is new:

| File | Change |
|---|---|
| `src/board/stage.ts` (new) | `NO_WORKER`, `boardHost`, `workerFor`, `syncStage`, `stageCard`, `unstageOwn` |
| `src/board/ui.ts` | holds `staged`; calls `syncStage` in `refresh`; `enter`/`tab`/`z` in `onKey`; async `quit` |
| `src/board/view.ts:9` | `KEYS` |
| `herdr-plugin.toml` | `[[panes]] id = "placeholder"` |
| `README.md:481-491` | key table rows; the "read-only" paragraph |

`src/board/stage.ts` takes everything it needs as arguments (herdr client, state dir, session, slug,
snapshot, host, identity), so it is testable with `fakeHerdr` and a temp dir, and `ui.ts` stays the
untested wiring it is today (research "Tests to model on"). It imports `PIPELINE`'s type, not the
value: `ui.ts` passes `PIPELINE` in, which avoids a `ui.ts` ↔ `stage.ts` import cycle.

### `src/board/stage.ts`

```ts
export const NO_WORKER = 'no worker to stage'

/** The board's own pane as the kit's host, or null when the board does not know its pane. */
export function boardHost(snap: Snapshot, boardPaneId: string | undefined): Host | null

/** The live pane of the task behind a card; null for a run card, an unbound task, a gone pane, or the orchestrator's pane. */
export function workerFor(run: Run | null, snap: Snapshot, cardId: string): PaneInfo | null

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
- `workerFor`: `run.tasks.find(t => t.task_id === cardId)` then
  `snap.panes.find(p => p.pane_id === task.pane_id)`, as `peekWorker` does (`src/board/ui.ts:122-130`),
  returning `null` if the pane is `run.orchestrator_pane` (A6).
- `syncStage`, `stageCard`, `unstageOwn`: see the flows below.

## Data and control flow

### Refresh (every throttled refresh and the 2 s poll, `src/board/ui.ts:46-84, 202`)

1. `refresh` reads the snapshot and builds the board as today.
2. **Last**, in both the run and the no-run branch, it computes `host = boardHost(current,
   process.env.HERDR_PANE_ID)` and, when `host` is not null, `staged = await syncStage(...)` (A3, A4).
3. `syncStage`:
   1. `recorded = (await readBoards(stateDir, session))[slug]?.staged ?? null`.
   2. If `recorded` and `recorded.host.boardPaneId !== host.boardPaneId` — a stage left by an earlier
      board — `await unstageBoard(herdr, stateDir, session, slug)` and return `null` (A11).
   3. Otherwise `kept = await reconcile(herdr, snap, host, recorded)` (`src/kit/stage.ts:150-156`):
      keeps the stage if its pane is still in the board's tab (by terminal id, else pane id after a
      herdr restart), otherwise closes the placeholder and drops it; adopts a single stray agent under
      the board; evicts the rest to new tabs.
   4. `next = kept ? { ...kept, host } : null`.
   5. If `JSON.stringify(next) !== JSON.stringify(recorded)`, `await recordStaged(stateDir, session,
      slug, next, recorded)` — with `expected = recorded`, so a stage the supervisor cleared
      meanwhile is not written back (`src/lib/boards.ts:75-91`). The result is ignored; the next
      refresh rereads (A5).
   6. Return `next`.

### `enter` (`\r` or `\n`, A2)

`onKey` → `serial(() => stageWorker(card)).then(draw)` where `stageWorker` in `ui.ts`:

1. `worker = workerFor(run, snap, card.id)`; null → `message = NO_WORKER`, return.
2. `host = snap && boardHost(snap, process.env.HERDR_PANE_ID)`; null →
   `message = 'this board does not know its pane'`, return (A7).
3. `staged = await stageCard(herdr, host, PIPELINE, stateDir, session, slug, worker.terminal_id)`,
   then `requestRefresh()` so the moved panes and the supervisor's rebind show up.

`stageCard`:

1. `record = (await readBoards(...))[slug]`; none → `throw new StageError('this board is not recorded
   yet')` before anything moves (A8). The text matches the `x` message at `src/board/ui.ts:171`.
2. `current = record.staged ?? null`; if it belongs to another board
   (`current.host.boardPaneId !== host.boardPaneId`), `await unstageBoard(...)` and `current = null`.
3. `fresh = await readSnapshot(herdr)` (pasture `board.ts:102`).
4. `staged = await stageAgent(herdr, fresh, host, identity, current, terminalId)`
   (`src/kit/stage.ts:100-148`). It returns `current` untouched for the same terminal, throws
   `StageError` for a gone agent or one already under the board, and **unstages `current` first**
   when staging a different worker (`:106-110`) — the "sends the first worker home" acceptance.
5. `next = { ...staged, host }`; `if (!(await recordStaged(stateDir, session, slug, next)))` — the
   record vanished while the move ran (the supervisor deleted or replaced this board) — undo with the
   kit's `unstage(herdr, await readSnapshot(herdr), host, next)` and throw the same `StageError` (A8).
6. Return `next`.

Errors from `stageCard` reject into `serial`'s catch, which sets `message` to the error text
(`src/board/ui.ts:44`); `StageError` messages are written for the status line
(`src/kit/stage.ts:42,103,104`).

### `tab` and `z`

As pasture (`board.ts:181-191`): find the staged pane in `snap` by `staged.terminalId`; if found,
`pane.focus { pane_id }` or `pane.zoom { pane_id, mode: 'toggle' }` through `serial`. Nothing staged or
pane gone → no call, no message (A9).

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
- `unstageOwn` reads the record and calls `unstageBoard` only when `staged.host.boardPaneId ===
  boardPaneId` (A12).
- `stdout` `error` still exits at once (`:180`): with no terminal there is nothing to draw, but it now
  goes through `quit` too so the stage is still undone. (A10.)

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
  guard costs one comparison and makes "never stage the orchestrator" a tested property, not an
  accident of the data.
- **A7. A board that cannot find its own pane says so** (`this board does not know its pane`) instead
  of silently doing nothing. New message text; no existing one fits.
- **A8. Staging requires a board record, checked before and after the move.** Without a record the
  stage could not be persisted, so the supervisor's close paths and the restart keep set
  (`src/startup.ts:140-142`) would not know about it, and a later reconcile would `adopt` the worker
  with its home set to the pipeline workspace (`src/kit/stage.ts:69-72`), losing its placeholder. The
  pre-check refuses early; the post-check undoes a move whose record disappeared mid-flight.
- **A9. `tab`/`z` with nothing staged do nothing**, as pasture. The keys line already says what they do.
- **A10. Quit waits on `serial` with no extra timeout.** A herdr call times out after 10 s
  (`src/kit/herdr.ts:32`), so a hung herdr delays exit by at most the in-flight calls. Not waiting
  risks a quit landing mid-stage and leaving the worker staged with no record. No hard-exit timer is
  added; none exists in either board today.
- **A11. A stage recorded by another board pane is undone, not adopted.** Brief step 3. In practice
  `syncBoards` and "Open board" unstage before replacing a board (`src/supervisor/boards.ts:101,110`,
  `src/actions/board.ts:43`), and `runBoardPane` keeps the old record's fields (`src/board.ts:57`), so
  this is the fallback for a stage those paths missed. It is also why the startup split-ratio step is
  dropped.
- **A12. Quit undoes only this board's stage.** When the supervisor replaces a board it unstages and
  then opens a new one; the old board's SIGHUP can arrive after the new board staged something. An
  unconditional `unstageBoard` would send the new board's worker home.
- **A13. No skill change.** `grep -rn -i board skills/herdr-pipeline/` finds only `SKILL.md:164`, the
  missing-tab recovery row; brief item 7 applies only "wherever" keys are listed.
- **A14. Keys line.** New `KEYS`:
  `'hjkl move  enter stage  tab focus  z zoom  space peek  o orch  d details  x clear'` (81 code
  points). The status line is `summary + '  ' + keys`, with `keys` cut with `…` to the room left
  (`src/kit/render.ts:167-171`); a 42-point summary leaves 76 at 120 columns, so appending the three
  keys to today's 62-point line (94) would hide all of them. Choices: drop the arrow glyphs
  (pasture's line says `hjkl move` too, `pasture src/view.ts:14`; arrows still work), shorten
  `orchestrator` to `orch`, and put the stage keys right after `move` (pasture's order) so a narrow
  pane cuts `x clear` and `d details`, not the new keys. At 120 columns with a 42-point summary the line renders as
  `… d details  x…` (computed with `fit`'s rule, `src/kit/render.ts:72-77`): only `clear` is lost.
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

## Error handling

| Situation | Result |
|---|---|
| run card, unbound task, pane gone, orchestrator pane | status `no worker to stage`, nothing called |
| board pane unknown | status `this board does not know its pane` |
| no board record (before or after the move) | `StageError('this board is not recorded yet')`; a completed move is undone |
| agent gone / already under the board / move refused | kit's `StageError` text on the status line |
| any herdr error in `enter`/`tab`/`z` | `HerdrError` text via `serial`'s catch |
| reconcile or `unstageBoard` fails in refresh | board already rebuilt; error on the status line; next refresh retries |
| unstage fails on quit | ignored; the board exits; `syncBoards` undoes a stage whose board is gone (parent spec item 2) |

## Testing strategy

TDD, failing test first, as the brief requires.

**Unit — `test/board-stage.test.ts` (new)**, temp state dir and `fakeHerdr`, modelled on
`test/boards-stage.test.ts` and its `onStage`/`withBoard` fixtures:

- `boardHost`: builds the host from the board's snapshot pane; `null` with no pane id or a pane not in
  the snapshot.
- `workerFor`: a task with a live pane → that pane; a run card (`run:<id>`) → null; a task with
  `pane_id: null` → null; a task whose pane is not in the snapshot → null; a pane equal to
  `run.orchestrator_pane` → null.
- `syncStage`:
  - a stage recorded by another board pane is unstaged (worker moved home, record `null`);
  - a kept stage with no change makes no `recordStaged` write (record bytes unchanged) and no herdr
    call;
  - a staged worker no longer under the board: placeholder closed, record set to `null`;
  - a stage the supervisor cleared between read and write is not resurrected (`expected`).
- `stageCard`:
  - records `{ ...staged, host }` and opens the placeholder entrypoint split right of the worker,
    then moves it with `split: 'down', ratio: 0.25`;
  - with a stage already recorded, the first worker's move home comes before the new worker's move
    (order of `calls`);
  - no board record → throws, and no herdr call that moves or opens a pane was made;
  - another board's recorded stage is unstaged first.
- `unstageOwn`: unstages this board's stage; leaves another board's stage alone.

**Unit — existing files**

- `test/board-view.test.ts:58` updated to the new `KEYS`.
- `test/prompts.test.ts` (where the manifest is already read, `:211-233`): the manifest declares
  `id = "placeholder"` with `command = ["bun", "run", "src/kit/placeholder.ts"]`, and that file exists.

`bunx tsc --noEmit` and `bun test` green.

**Live check** (parent spec "Plan 4 live check", steps 1, 3, 4), in a throwaway herdr session with a
fake run — never in the session running this pipeline, because the board's reconcile evicts or adopts
any agent pane under it and staging moves real panes:

1. `enter` on a card: the worker moves under the board at 25/75, an "On stage" placeholder sits in its
   tab, and the supervisor rebinds `task.pane_id` (`src/supervisor/tick.ts:503-515`). `tab` focuses
   it; `z` zooms and unzooms it; `enter` on a second card sends the first home first.
2. Reopen the board ("Open board"): the worker goes home and the placeholder closes.
3. Tear the task down while staged: no pane is left behind.

A difference between this list and what herdr does is a finding for the PR, not a test to bend.
