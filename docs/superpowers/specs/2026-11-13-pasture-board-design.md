# Pipeline board: pasture's kanban in place of bv

Date: 2026-11-13 · Status: approved design, revised after adversarial review

## Problem

The per-repo "Board" tab runs `bv`, a beads viewer.

- It shows only the four bd statuses (open, in_progress, blocked, closed). The pipeline phase is
  squeezed into a card label of about 22 characters.
- The 2026-10-11 live-run notes record two complaints: the board was hard to find, and a blocked card
  **never said what it was waiting on**.
- bv's licence rider forbids use by or for Anthropic, and agents are told never to run it.

The user built "pasture", a herdr TUI kanban of agents with animated Clawd sprites, tinted columns
and a stage pane. It lives at `~/Documents/development/personal/herdr-pasture`, and its spec is
`docs/superpowers/specs/2026-11-13-pasture-design.md` there. This board brings that experience to
the pipeline.

## Decisions (approved by the user 2026-11-13)

| Question | Decision |
|---|---|
| Columns | Pasture's four: **Needs you · Working · Done · Idle/queued**. What a task is doing is shown by its **animation**, not by more columns. |
| Animations | **One scene per working phase**, 12 in all. |
| Stage | `enter` stages the task's **worker** under the board. **The orchestrator is never moved**; it can only be peeked at (see "Why the orchestrator is not staged"). |
| Scope | **One board per repo**, as today's bv tab, with the same supervisor lifecycle. |
| Sharing pasture's engine | **Vendor a copy** into `src/kit/` and `test/kit/` with a sync script. There is no shared package, and the plugin stays installable on its own. |

## Delivery: four plans, in this order

1. **Pasture kit refactor** (in the herdr-pasture repo). This makes the shared code plugin-neutral.
   See "Vendored kit".
2. **Phase scenes art**: the Aseprite proposal sheet, the user's approval, then the scenes as code.
3. **Read-only board** (this repo).
   - Replaces bv with columns, cards, scenes, peek and details.
   - Moves no panes and needs no supervisor change.
4. **Worker staging** (this repo): `enter`, plus the supervisor changes listed under "Stage".

Each plan ships working software on its own. Plan 3 can be released before plan 4.

## Board pane and layout

- The existing `[[panes]] id="board"` (placement `tab`) and its lifecycle stay as they are.
  - That lifecycle is the registry `lib/boards.ts`, `syncBoards` in `supervisor/boards.ts`, the
    "Open board" action, and the startup sparing.
  - `src/board.ts` stops launching bv and runs the new board instead.
- A repo has at most one unfinished run (`runForRepo`, `lib/ledger.ts`), so the board shows that run.
  When there is none, it shows the last finished run until its Done cards are cleared, and otherwise
  shows an empty board saying `no run in this repo`.
- **Header (row 1):** run title · run phase · mode (per-task / single PR) · batch PR and CI · landing
  slot holder and queue length · `orchestrator ✓`, or `orchestrator gone` in red.
- **Columns** are tinted as in pasture:

  | Column | Tint |
  |---|---|
  | Needs you | `#2f2738` |
  | Working | `#272a3e` |
  | Done | `#292e37` |
  | Idle | mantle `#181825` |

  They have untinted 1-column gaps between them, 1 cell of inner padding, and a blank row under each
  title.
  - Every board cell is written once per redraw. The screen is fully cleared only on the first draw
    and on resize (pasture's flicker fix).
- **With a worker staged (plan 4):** the board keeps the top **25%** and the stage takes the bottom
  **75%**. `pane.move`'s `ratio: 0.25` is the board's share. When a board starts and finds a stage
  already recorded, it applies `layout.set_split_ratio` with the root split at 0.25.

## Columns

**Needs you** means the *human* must act. It is **not** `waitsOnYou`. That predicate is the digest's
"YOUR move", which is addressed to the orchestrator: it is true for every routine merge and false for
a check the human owes (`lib/status.ts:376-383`).

The column for a task is decided by the first rule that matches:

0. **Finished run:** when the run's phase is `done`, every task not `done` goes to **Idle/queued**:
   red with its phase for a `TERMINAL_BAD` phase, otherwise `aborted` (for an aborted run) or the
   phase name. Nobody can act on a finished run, so nothing in it is "Needs you".
1. **Needs you**, when any of these holds:
   - a before-merge check is owed and only the human can move it: the run is driven, the human is
     asked, and `waitsOnlyOnTheHuman(run, task)` holds (`lib/before-merge.ts`). The badge is the
     first check waiting on the human.
   - `task.phase === 'escalated'`, while the phase still holds the bead (`phaseHoldsBead`)
   - `escalatedUnanswered(task) !== null` (`lib/decisions.ts:53`), also gated by `phaseHoldsBead`
   - the phase is in `TERMINAL_BAD` (`lib/gating.ts:15`): failed, orphaned or blocked-on-failure
   - the worker pane's delivery hold is `stuck_input`
   - the worker pane's delivery hold is `usage_limit` with `until == null`, meaning the reset could
     not be read

   These match the `hpipe:awaiting-human` label rules (`lib/bead-desired.ts:185-197`), plus the
   terminal-bad phases and the two holds. The label leaves those out on purpose, but the human still
   has to act on them.
2. **Done:** phase `done`. The card stays until the user clears it with `x`, or until the board moves
   on to a newer run.
3. **Idle/queued:**
   - `queued` (an unmet `depends_on` is reported only here), `blocked-on-files`, or a
     `usage_limit` hold with a known reset
   - any worker phase whose `pane_id` is null or names no live pane, with the badge `no agent`
4. **Working:** every other phase, whether the worker or the orchestrator acts.
   - When the orchestrator acts and `waitsOnYou` is true, the badge reads `orchestrator's move`.

**Run cards.** Some things the human owes belong to the run, not a task. These get one **run card**,
pinned to the top of Needs you, with its own clause:

- run phase `escalated`
- a single-PR run's owed checks (`humanOwesAtTheGate(run)` when `modeOf(run) === 'single-pr'`)
- the orchestrator pane missing from the snapshot (`orchestrator is not running`), only while the
  run is driven (`runIsDriven`)

A run card has no worker, so `enter` on it reports `no worker to stage`.

## Cards (pasture's 2-row mini layout)

- **Row 1:**
  - `▌` selection bar
  - 6-column Clawd sprite
  - `<bead id> <title>`
  - context %, from the worker pane's `ctx` token when pasture's statusline wrapper is installed
  - time in phase, from `phase_entered_at`
- **Row 2:** the phase label, plus one badge on the right. The badge is the first of these that
  applies:
  1. In Needs you, **what it waits on**, in red:
     - `answer decision <id>` for an open decision
     - the owed check's text for a before-merge check
     - `input box has text` for `stuck_input`
     - `usage limit` for an unreadable reset
     - the phase name for a terminal-bad phase
  2. In Idle/queued, why it waits: `deps: <bead>` (queued with an unmet dependency), `files: <bead>`
     for `blocked-on-files` (the bead holding the files, or `held`), the reset time for a usage
     limit, or `no agent`.
  3. In Working, `orchestrator's move` when the orchestrator acts and `waitsOnYou` is true. It
     outranks CI and PR, since it says who moves next. It is skipped for a single-PR run's landing
     phases, where `waitsOnYou` runs a synchronous `git merge-base` too slow for every poll.
  4. `ci ●` (running), `ci ✗` (failed) or `ci ✓` (passed), when CI applies.
  5. `PR #N`, when a PR exists.
  6. Otherwise the tier (`light`, `standard` or `heavy`).
- Every pipeline Clawd wears the **hard hat**.
- **No background-shell badge.** The pipeline's background detection
  (`supervisor/pane-background.ts`) reads the screen and lives only in the supervisor's memory.
  Pasture's ps-based count would be a second, disagreeing source. The column comes from the ledger's
  phase, not agent status, so a background job cannot drop a card into Done.

## Phase scenes (12, Working column only)

| Phase | Scene |
|---|---|
| research | reading a big book through a magnifying glass |
| spec | writing a scroll with a quill |
| spec-review | glasses on, reading the scroll, ✓/✗ marks popping |
| plan | pinning cards and arrows on a corkboard |
| plan-review | glasses on, ticking a clipboard checklist |
| implement | pasture's laptop scene |
| pr-review (and the retired `pr-review-intent`, `pr-review-quality`) | glasses on, scanning a sheet of red and green diff lines |
| ci | watching a progress bar fill, gears turning |
| land-queue | standing in line holding a box |
| sync | two arrows circling over the box |
| merge | sliding the box onto a conveyor where two lanes join |
| close (and `teardown`) | taping the box shut, with a small ✓ |

- Each scene has 4 frames of 40×24 art pixels, drawn with the Catppuccin Mocha palette like
  pasture's.
- The hard hat stays fully inside the canvas in every **loop** frame. Only the one-shot enter
  transitions (the Done jump and the Needs-you hop) may clip it, at their top frame.
- Other columns reuse pasture's scenes:
  - Idle/queued sleeps.
  - Done celebrates.
  - Needs you waves with the `!` bubble.
  - Pasture's one-shot transitions play when a card enters Done or Needs you.
- **Art workflow:** an Aseprite proposal sheet goes to the user for approval **before** the scenes are
  coded. It shows frame 0 of all 12 scenes, plus the full 4-frame strip for 3 of them. After that, a
  contact sheet of every frame is checked.

## Keys (board focused)

| Key | Action | Plan |
|---|---|---|
| `hjkl` / arrows | move between cards | 3 |
| `space` | peek at the task's worker | 3 |
| `o` | peek at the run's orchestrator (a raw terminal sends shift+space as a plain space) | 3 |
| `d` | details popup with `formatTaskDetail` (`hpipe show`'s task block, without the dispatch-base line) | 3 |
| `x` | clear a Done card | 3 |
| `enter` | stage the task's worker under the board | 4 |
| `tab` | focus the staged pane | 4 |
| `z` | zoom the stage | 4 |

- Pasture's `n` (new agent), `X` (close agent) and `r` (rename) are **left out**. The pipeline owns
  its workers and titles, and closing a worker would fail its task.
- Peek and details read panes and never move them.
- Status-line messages:
  - `no worker to stage` for a card with no live worker
  - `orchestrator is not running` for `o` when the orchestrator pane is gone
- **Clears** made with `x` are stored per repo in the board registry record, as `cleared: string[]`
  of task ids. They are dropped when the run changes.

## Data

- **No new CLI.** The board imports the plugin's own modules:
  - `runForRepo` (ledger), `modeOf` and `TASK_ROWS` (`lib/phases.ts`)
  - `heldForTheHuman` and `owedInRun` (`lib/before-merge.ts`)
  - `escalatedUnanswered` (`lib/decisions.ts`), `awaitedFor` (`lib/awaiting.ts`)
  - `TERMINAL_BAD` and the landing helpers (`lib/gating.ts`)
  - `waitsOnYou` (`lib/status.ts`), the delivery holds (`lib/delivery-health.ts`), and
    `readDispatchLocks`
- **The poll avoids `moveFor`.** `moveFor` runs a synchronous `git merge-base` for single-PR merge
  tasks (`lib/status.ts:399`).
  - `waitsOnYou` is computed only for Working cards whose actor is the orchestrator.
  - `formatTaskDetail` and `actionFor` are called only when `d` is pressed.
- **Old-schema runs are skipped.** `taskRow` throws on them (`lib/phases.ts:271`).
- **Delivery holds are absent when the supervisor is not running.** They are read only while its pid
  is live (`lib/delivery-health.ts:70-77`), and the board treats a missing file as "no holds".
- **Refresh:**
  - herdr events (agent status, pane lifecycle) through the kit's socket subscription, throttled to
    one refresh every 400 ms at most
  - plus a **2 s poll**, because the ledger changes without any herdr event
  - The poll reads only this repo's run, plus one snapshot. There is no `ps` call.

## Stage (plan 4)

This is pasture's stage algorithm from the kit:

- A placeholder pane holds the worker's home spot in its worktree workspace.
- `pane.move` carries the real pane under the board.
- The stage is reconciled by terminal id, or by pane id after a herdr restart.

### What already works

- The supervisor rebinds `task.pane_id` on `pane.moved` (`supervisor/tick.ts:503-511`).

### Supervisor and CLI changes required

1. **Stage record.** Each repo's stage is stored in its board registry record (`lib/boards.ts`
   `BoardRecord`):

   ```
   staged: (Staged & { task_id }) | null
   ```

   `Staged` is the kit's own record: `terminalId`, `paneId`, `homeWorkspaceId`, `homeTabId`,
   `homeTabLabel`, `placeholderPaneId` and `title`. The kit's `unstage` and `reconcile` read all of
   them.

   A single plugin-wide `state.json` (pasture's model) would let two repo boards overwrite each other.
2. **`unstageBoard(slug)` in `lib/boards.ts`.** It moves the staged pane back into its placeholder's
   spot and closes the placeholder. It is called before **every** board close:
   - `syncBoards` closing a board for a finished run (`supervisor/boards.ts:97`)
   - `syncBoards` reopening a board that is no longer live (`supervisor/boards.ts:105`)
   - the "Open board" action (`actions/board.ts:40`)

   The board process also calls it on exit, as a best effort. Finally, `syncBoards` treats a recorded
   stage whose board pane is gone as a stage to undo, which covers a board killed without warning.
3. **`clearStrayPanes` keeps bound panes.** It runs at every herdr start (`startup.ts:211`). Its keep
   set gains:
   - every pane bound to a non-terminal task of a driven run (`task.pane_id`)
   - every recorded placeholder

   Pane ids survive a herdr restart, so the binding still matches.
4. **Teardown closes the worker wherever it is.** Before the worktree is removed
   (`supervisor/teardown.ts`), the stage is undone if this task is staged. Then the supervisor
   releases the pane (`releaseWorkerPane`) and closes it by id. Removing the workspace closes only
   panes inside it.
5. **The pane-identity guards follow moves.**
   - On a rebind, `pane.moved` appends the old id to a new `task.former_pane_ids`.
   - `paneRefusal` (`cli.ts:2395`), the tier-lowering guard (`cli.ts:2930`) and `resume`
     (`cli.ts:3115`) match the caller's `HERDR_PANE_ID` against `pane_id` **or**
     `former_pane_ids`.
   - Without this, a staged worker, whose env still holds its old id, gets past them. The same is
     true today of any pane pasture moves.

### Rules

- **One stager owns pipeline panes.** Pasture refuses to stage a pane bound to a pipeline task, and
  says `stage it from the pipeline board`. Otherwise pasture's reconcile would close the pipeline
  board's placeholder (pasture `stage.ts:114-115`), and the worker's home spot would be lost.
- **Delivery holds move with the pane.** They are keyed by pane id and rebuilt by the supervisor on
  its next send. Until then, a moved pane shows no hold.
- **Known limit.** Closing the whole board tab by hand closes the staged worker with it, and the task
  then fails through `losePane`. herdr gives no hook to stop a tab close.

### Why the orchestrator is not staged

The supervisor finds the orchestrator by looking for its claimed pane only in the claimed workspace
(`lib/orchestrator.ts:12`). If that pane is not found, it falls back to the single agent pane in the
repo's primary workspace (`lib/orchestrator.ts:24-33`).

So an orchestrator moved under the board would be judged gone. Its prompts would then either go
nowhere, or be typed into another Claude the human has open in that workspace. Staging it would need
rebinding by terminal id and a rewrite of the claim. That is out of scope.

## Vendored kit (`src/kit/`, `test/kit/`)

Plan 1 (herdr-pasture, merged 2026-11-13) made pasture's kit plugin-neutral. Its
`test/kit/boundary.test.ts` fails if a kit file imports outside the kit or names pasture. What
shipped:

- **`CardView`**, which is what the renderer draws:

  ```
  { id, column, title, subtitle, badge: Span, since, ctx, scene, accessory, enteredAt }
  ```

  - `id` is a string. The pipeline uses the task id, or `run:<run_id>` for a run card.
  - The title is red in Needs you and plain text elsewhere. There is no per-card title colour.
  - The age is formatted from `since`.
  - The Clawd sweats from `ctx` 70.
- **`View` slots:** `header: Span[]` (the first span always shows, the rest only while they fit),
  `summary`, `keys`, and `titles` for per-column titles, e.g. `{ idle: '○ Idle/queued' }`.
  - The header drops later spans first, so the pipeline puts `orchestrator gone` early in it.
- **`Identity`** `{ pluginId, placeholderEntrypoint, peekEntrypoint, stageName }`, passed to
  `stageAgent(herdr, snap, host, identity, current, terminalId)` and to
  `openPeek(herdr, identity, { terminalId, title, where })`.
  - The pipeline manifest gains `placeholder` (split, `src/kit/placeholder.ts`) and `peek` (popup,
    `src/kit/peek.ts`) panes.
  - Both panes read their text from env (`KIT_TITLE`/`KIT_STAGE`, `KIT_PEEK_*`).
- **The stage is pure over `Staged`.** Persistence is the caller's: the pipeline's board registry
  (see Stage). It adopts a lone stray agent pane under the board and rehomes any others.
- **Scene registry:** `registerScene(name, frames, draw)` with the exported Clawd primitives
  (`clawd`, `zee`, `bubble`, `C`, `Rect`, `Look`).
  - The six built-ins keep their ids.
  - `imageId` rejects a frame its scene doesn't have.
  - The pipeline's 12 scenes live in `src/board/scenes.ts`, outside the kit, and are registered
    before the first draw.
- **Vendored at the same paths as pasture,** `src/kit/` and `test/kit/`, so the kit's tests run
  unchanged. Their imports are `../../src/kit/…`.
- **Sync.** `scripts/sync-kit.ts` copies pasture's `src/kit/` and `test/kit/` over this repo's and
  prints the diff. It never runs automatically.
  - The script is added to the typecheck, which excludes `scripts/` today.
- **A pasture-side kit task opens plan 3: the frame writer.**
  - Pasture's `src/board.ts` holds the flicker-free drawing loop:
    - the full clear only on the first draw and on resize
    - the `lastText` diff
    - the sent-image set
    - `imagePng` over the kit's two image-id ranges
    - the `CSI 16 t` cell-size probe
  - It moves into the kit as a small frame writer that both boards call. The pipeline must not copy
    code that depends on the kit's id encoding.

## bv removal (plan 3)

- The board no longer launches bv. The board's history catch-up (`board.ts:99`) is removed.
- `recordBeadsHistory` on every bd export (`lib/bd.ts:374`) **stays** until `hpipe next` stops using
  bv. It costs one local git commit per export.
- The `bv` checks in `lib/tools.ts` no longer gate the board.
- **Upgrade:** a running bv board keeps running until it is reopened or its run ends, because `isLive`
  checks the shell pid. The first `syncBoards` after the upgrade does not replace it. The release
  notes say to use "Open board" once.
- **Out of scope:** `hpipe next` still uses `bv --robot-triage-by-track` (`lib/bv.ts`). Replacing it
  is a separate change, and its licence makes that worthwhile.

## Testing

- **Column mapping** from ledger fixtures:
  - every Needs-you cause
  - **a routine per-task merge stays in Working** with the `orchestrator's move` badge
  - **an owed check is in Needs you**
  - the run cards: escalated run, single-PR owed check, orchestrator gone
  - Done
  - Idle/queued: holds, dependencies and `no agent`
  - the Working phases
  - old-schema runs skipped
- **Card text:** each badge and its priority, the Needs-you clauses, the phase labels, and phase →
  scene for all 12 phases, including the retired pr-review variants.
- **Kit:** its own unit tests come along with it, including the write-once render check. Pasture's
  full suite passes after plan 1.
- **Scenes:** a test that every loop frame keeps the hat's pixels inside the canvas, plus a contact
  sheet checked by eye.
- **Plan 4 unit tests:**
  - `unstageBoard` on each close path
  - `clearStrayPanes` keeping bound panes and placeholders
  - teardown closing a staged worker
  - `former_pane_ids` in the three guards
  - pasture refusing a pipeline-bound pane
- **Plan 4 live check,** in throwaway workspaces with a fake run:
  1. stage a worker, and confirm the supervisor's binding follows
  2. restart herdr with it staged, and confirm it survives and stays bound
  3. reopen the board, and confirm the worker goes home
  4. tear the task down while it is staged, and confirm no pane is left behind

## Out of scope

- Staging the orchestrator.
- Replacing `hpipe next`'s bv triage.
- A cross-repo board. It stays one board per repo.
- Editing the ledger from the board (deciding, answering, releasing). Those stay as `hpipe` commands,
  run in a worker, the orchestrator or a terminal.
- Checking `pane.move` `ratio` and `layout.set_split_ratio` on herdr 0.9.0. Plan 4 raises
  `min_herdr_version` to 0.9.1, the version pasture is verified on.
