# herdr-pl-4 research — board: enter stages a worker, tab focuses, z zooms

Bead `herdr-pl-4`, task `t4`. Branch `feat/board-staging`, base `cad73da` (the stage-persistence
task, #175, on top of v2.3.2).

## Installed versions

| Tool | Command | Output |
|---|---|---|
| bun | `bun --version` | `1.3.14` |
| TypeScript | `bunx tsc --version` | `Version 5.9.3` |
| herdr | `herdr --version` | `herdr 0.9.1` |

`package.json` has no runtime dependencies (dev only `@types/bun`, `typescript ^5.6.0`).
`herdr-plugin.toml:4` already declares `min_herdr_version = "0.9.1"`, the version the spec's "Out of
scope" says plan 4 needs, so no manifest version bump is required.

## Both dependencies are on this branch

- **Arrow-key task (#172, `e47987f`).** `src/board/keys.ts` holds `NAV` (`:3-8`) and `splitKeys`
  (`:14-16`); `src/board/ui.ts:191` feeds every split key to `onKey`.
- **Stage-persistence task (#175, `cad73da`).** `src/lib/boards.ts`:
  - `BoardRecord.staged?: StagedWorker | null` (`:19`), where `StagedWorker = Staged & { host: Host }`
    (`:23`). The spec's "Stage record" said `Staged & { task_id }`; what landed carries the `host`
    instead, so the board does not need to store the task id.
  - `recordStaged(stateDir, session, slug, staged, expected?)` (`:81-91`) returns `false` when no
    record names the board, or when `expected` is given and the stored stage is no longer it
    (`sameStage` compares `paneId` and `terminalId` only, `:70-73`).
  - `unstageBoard(herdr, stateDir, session, slug)` (`:104-113`) reads the record, finds the worker by
    terminal id then pane id, calls the kit's `unstage`, and clears the record with `expected`.

  Its other callers already exist: `syncBoards` before each close (`src/supervisor/boards.ts:101,
  110`), the "Open board" action (`src/actions/board.ts:43`), the restart keep set
  (`src/startup.ts:140-142`), and teardown's `closeStagedWorker` (`src/supervisor/main.ts:383`).

## Files that own the behaviour

| File | Role today | What this task changes |
|---|---|---|
| `src/board/ui.ts` | the board process: refresh, draw, keys, quit | `enter`/`tab`/`z`, reconcile in `refresh`, unstage on quit |
| `src/board/view.ts:9` | `KEYS` string | add the three keys |
| `herdr-plugin.toml:89-115` | panes `supervisor`, `board`, `peek`, `details` | add `placeholder` |
| `README.md:481-491` | board key table and "The board is read-only: it moves no pane" | add keys; that sentence becomes false |
| `src/kit/stage.ts` | `stageAgent`, `reconcile`, `unstage`, `StageError`, `STAGE_RATIO = 0.25` | none (brief: do not edit `src/kit/`) |
| `src/kit/placeholder.ts` | the placeholder pane's program | none; it only needs a manifest entry |

`skills/herdr-pipeline/` does not list the board's keys: `grep -rn -i board skills/herdr-pipeline/`
finds only `SKILL.md:164`, the "Board tab is gone" recovery row. Brief item 7 has nothing to change
there unless the skill gains a key list.

## Current control flow of the board (`src/board/ui.ts`)

- **Identity.** `PIPELINE` (`:22`) is `{ pluginId: 'stein.pipeline', placeholderEntrypoint:
  'placeholder', peekEntrypoint: 'peek', stageName: 'pipeline' }`. The `placeholder` entrypoint is
  named but the manifest declares no such pane, so `plugin.pane.open` for it would fail today.
- **Refresh** (`:46-71`): reads a snapshot into `snap`, resubscribes, reads the run with
  `runForSlug`, holds and dispatch locks, and rebuilds `board`. It does nothing with the stage.
  Refreshes are queued through `serial` (`:44`), a promise chain whose rejections become `message`;
  `queueRefresh` clears `message` after each refresh (`:80`).
- **Keys** (`:158-175`): `onKey` clears `message`, then `\x03`/`q` → `quit()`; `NAV`; `space` →
  `peekWorker`; `o` → `peekOrchestrator`; `d` → `openDetails`; `x` → `recordCleared`. Each async action
  goes through `serial(...).then(draw)`.
- **Finding a card's worker** (`peekWorker`, `:122-130`): `run.tasks.find(t => t.task_id ===
  card.id)`, then `snap.panes.find(p => p.pane_id === task.pane_id)`; missing either →
  `message = 'no worker to peek at'`. Run cards have id `run:<run_id>` (`src/board/model.ts:103`) and
  match no task. This is the shape the stage's "pane to stage for a card" follows.
- **Quit** (`:153-156`) is synchronous and `never`: it clears images and the screen and calls
  `process.exit(0)`. Callers: `onKey` (`:161`), `stdin` `end`/`error` (`:178-179`), `SIGHUP`
  (`:181`). `stdout` `error` exits directly (`:180`). Making the quit unstage first means it becomes
  async, and the `never` return type and the `if (key === …) quit()` fall-through in `onKey` change.
- **Own pane.** `visible()` (`:102-107`) already finds the board's pane in `snap` by
  `process.env.HERDR_PANE_ID` and reads its `workspace_id` and `tab_id` — the same lookup the
  stage's `Host` needs. The board records `HERDR_PANE_ID` as its `pane_id` at start
  (`src/board.ts:56-57`), spreading the old record, so a `staged` left by an earlier board survives
  into the new board's record with a different `host.boardPaneId`.

## The kit's stage (`src/kit/stage.ts`, identical to pasture's)

`diff -r ~/Documents/development/personal/herdr-pasture/src/kit src/kit` prints nothing.

- `stageAgent(herdr, snap, host, identity, current, terminalId)` (`:100-148`):
  - returns `current` unchanged when it is already that terminal (`:101`);
  - throws `StageError` for a gone agent or one already in the host tab (`:103-104`);
  - unstages `current` first and re-reads the snapshot (`:107-110`) — so staging a second card
    sends the first worker home;
  - evicts stray agents under the board, unzooms, opens the placeholder split right of the worker
    in its home tab (`:122-131`), and moves the worker under the board with `split: 'down', ratio:
    STAGE_RATIO` (`:134`). `pane.move`'s ratio is the board's share (`:30`), so the board keeps 25%.
  - Returns a `Staged` without `host`; the board adds it before `recordStaged`.
- `reconcile(herdr, snap, host, staged)` (`:150-156`): keeps the stage if its pane (by terminal id,
  else pane id) is still in the host tab, otherwise closes the placeholder and drops it; adopts a
  single stray agent under the board; evicts the rest to new tabs.
- `StageError` (`:33`) is the error to show on the status line. `HerdrError` (`src/kit/herdr.ts:6`)
  from a refused call also reaches `serial`'s catch and shows as `message`.

## The nearest example: pasture's board

`~/Documents/development/personal/herdr-pasture/src/board.ts` (`ec34957`):

- **Host** (`:22-26`) from `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`/`HERDR_PANE_ID` env, with stored
  fallbacks. The brief instead takes `tab_id` and `workspace_id` from the snapshot pane matching
  `HERDR_PANE_ID`, as `visible()` already does here.
- **Reconcile in `refresh`** (`:70-85`): `reconcile(herdr, current, host, state.staged)`, then writes
  state only when `JSON.stringify` of the result differs from what was stored.
- **`stage`** (`:101-109`): reads a fresh snapshot, `stageAgent(..., state.staged, terminalId)`,
  stores the result, clears `message`, re-reads `snap`.
- **`focusStage` / `zoomStage`** (`:181-191`): the staged pane is found by `terminal_id` in `snap`;
  `pane.focus { pane_id }` and `pane.zoom { pane_id, mode: 'toggle' }`; nothing when no stage.
- **Keys** (`:253-257`): `'\r'` stages, `'\t'` focuses, `'z'` zooms, each through `serial`.
- **Quit** (`:224-227`) does not unstage; pasture leaves the stage for its next board's reconcile.
  This repo's brief asks for an unstage on quit, so pasture has no example of that part.
- **Manifest** (`herdr-plugin.toml:24-27`): `id = "placeholder"`, `title = "On stage"`,
  `placement = "split"`, `command = ["bun", "run", "src/kit/placeholder.ts"]`.

## Facts that shape the design

1. **Enter arrives as `\n` from herdr.** `test/board-keys.test.ts:11-12` (from #172) records the chunk
   herdr 0.9.1 forwards for `send-keys … enter tab` as `…\n\t`. A raw local terminal sends `\r`.
   `splitKeys` splits `\r\n` into two keys, but a second `enter` on the same card is a no-op in
   `stageAgent` (`:101`) as long as it sees the stage the first one recorded — which holds because
   both run in order on `serial`.
2. **The supervisor already follows the move.** `pane.moved` rebinds `task.pane_id` and appends the
   old id to `former_pane_ids` (`src/supervisor/tick.ts:503-515`); the supervisor also detects a move
   from its own pane list by terminal id (`:337-370`). So after a stage, `task.pane_id` becomes the
   staged pane's new id within a tick, and `enter` on the same card finds the pane by its new id.
3. **The orchestrator is never a card's worker.** Cards are tasks or the run card; the orchestrator
   pane lives on `run.orchestrator_pane`, not on any task (`model.ts:81-107`). "Never stage the
   orchestrator" is satisfied by staging only `task.pane_id`; a guard against `task.pane_id ===
   run.orchestrator_pane` would be defence only.
4. **The supervisor and the board both write `staged`.** `syncBoards` unstages and deletes/replaces
   records (`supervisor/boards.ts:96-113`); teardown's `closeStagedWorker` clears `staged` before
   closing the worker (`lib/boards.ts:122-136`). That is why `recordStaged` takes `expected`: a
   reconcile write-back should pass the stage it read, so a stage the supervisor cleared meanwhile is
   not resurrected.
5. **Keys line width.** The status line is `summary + '  ' + keys`, and `keys` is cut with `…` to the
   room left (`src/kit/render.ts:167-171`). Today's `KEYS` is 62 code points; appending `  enter
   stage  tab focus  z zoom` makes it 94. A typical summary (`12 tasks · 3 need you · 5 working · 4
   done`) is 42, so at the default 120 columns only 76 fit and the new keys would be cut off. Measured
   with `bun -e` over `[...s].length`. The keys line needs shortening, not just appending.
   `test/board-view.test.ts:58` pins the exact `KEYS` string.
6. **A stage left by an earlier board.** Because `runBoardPane` spreads the old record
   (`src/board.ts:57`), a reopened board can read a `staged` whose `host.boardPaneId` is another pane.
   In practice `syncBoards` and the "Open board" action unstage before replacing a board, so this is
   the fallback for a board started some other way (brief step 3 handles it with `unstageBoard`).
7. **Spec item not in the brief.** The spec ("Board pane and layout") says a board that starts and
   finds a stage already recorded applies `layout.set_split_ratio` at 0.25. The brief instead undoes a
   stage from an earlier board, and a same-pane stage only survives a herdr restart, after which the
   supervisor replaces the board anyway (README:463-464). `grep -rn set_split_ratio src` finds no use.
   The spec phase should state that this is not done.

## Tests to model on

- `test/board-keys.test.ts`, `test/board-view.test.ts` — pure functions of `src/board/*`, plain
  `bun:test`. The pane-choosing and host-building helpers fit here.
- `test/kit/stage.test.ts` with `test/kit/fake-herdr.ts` (`fakeHerdr(handlers)`, `moved`, `opened`) —
  the fake for any test that drives `stageAgent`/`reconcile`.
- `test/boards-stage.test.ts` — `recordStaged`/`unstageBoard` against a temp state dir.
- `src/board/ui.ts` has no unit test: it starts the process loop on import of `runBoardUi`, which is
  why the brief asks for the pure parts to be extracted and tested.

## Tier

Stays `heavy`. The change is the board process, one new manifest pane, the keys line and the README;
no ledger schema, `phases.ts`, prompt or CLI contract changes. The live check is the spec's "Plan 4
live check" (steps 1, 3, 4) in a throwaway workspace.
