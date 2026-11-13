# Pipeline board: pasture's kanban in place of bv

Date: 2026-11-13 · Status: approved design

## Problem

The per-repo "Board" tab runs `bv`, a beads viewer. It shows only the four bd statuses (open,
in_progress, blocked, closed), with the pipeline phase squeezed into a card label of about 22
characters. The 2026-10-11 live-run notes record two complaints: the board was hard to find, and a
blocked card **never said what it was waiting on**. bv's licence rider also forbids use by or for
Anthropic, and agents are told never to run it.

The user built "pasture", a herdr TUI kanban of agents with animated Clawd sprites, tinted columns
and a stage pane (`~/Documents/development/personal/herdr-pasture`, spec
`docs/superpowers/specs/2026-11-13-pasture-design.md` there). This board brings that experience to
the pipeline.

## Decisions (approved by the user 2026-11-13)

| Question | Decision |
|---|---|
| Columns | Pasture's four: **Needs you · Working · Done · Idle/queued**. What a task is doing is shown by its **animation**, not by more columns. |
| Animations | **One scene per working phase**, 12 in all. |
| Enter / stage | `enter` stages the task's **worker**, `o` stages the run's **orchestrator**, space peeks at either. |
| Scope | **One board per repo**, as today's bv tab, with the same supervisor lifecycle. |
| Sharing pasture's engine | **Vendor a copy** into `src/board/kit/` with a sync script. There is no shared package, and the plugin stays installable on its own. |

## Board pane and layout

- The existing `[[panes]] id="board"` (placement `tab`) and its lifecycle stay as they are: the
  registry `lib/boards.ts`, `syncBoards` in `supervisor/boards.ts`, the "Open board" action, and the
  startup sparing.
- `src/board.ts` stops launching bv and runs the new board instead.
- Inside the board tab, the board takes the top **25%** and a **stage** pane the bottom **75%**,
  matching pasture: `pane.move` with `ratio: 0.25` is the board's share, and
  `layout.set_split_ratio` restores it after a rebuild.
- **Header (row 1):** run title · run phase · mode (per-task / single PR) · batch PR and CI · landing
  slot holder and queue · orchestrator alive/dead. When the repo has more than one active run, one
  compact segment per run, newest first, cut to fit.
- **Columns:** tinted as in pasture (Needs you `#2f2738`, Working `#272a3e`, Done `#292e37`, Idle
  mantle `#181825`), with untinted 1-column gaps, 1 cell of inner padding and a blank row under each
  title.
  - Every board cell is written once per redraw, and the screen is fully cleared only on the first
    draw and on resize (see pasture's flicker fix).

## Columns

The column for a task is decided in this order:

1. **Needs you:** `waitsOnYou(run, task, now, holds, dispatches)` (`lib/status.ts`) is true. That
   covers terminal-bad phases (`failed`, `orphaned`, `blocked-on-failure`), `escalated` (task or run),
   an unanswered escalated decision, and before-merge checks owed to the human. It is the same set the
   bead label `hpipe:awaiting-human` marks.
2. **Done:** phase `done`. The card stays until the user clears it (`x`) or its run reaches `done`.
3. **Idle/queued:** `queued`, `blocked-on-files`, unmet `depends_on`, and tasks whose worker pane has
   a delivery hold (`usage_limit`, `stuck_input`).
4. **Working:** every other phase, whether the worker or the orchestrator is the actor.

The order of the overlays matters: a stalled task that waits on you is in **Needs you**.

## Cards (pasture's 2-row mini layout)

- **Row 1:** `▌` selection bar · 6-column Clawd sprite · `<bead id> <title>` · context % (the
  worker pane's `ctx` token, when pasture's statusline wrapper is installed) · time in phase (from
  `phase_entered_at`).
- **Row 2:** the phase label, plus one badge on the right, picked in this order:
  1. In Needs you, **the clause saying what it waits on**, from `actionFor`/`awaitedFor`
     (e.g. `answer decision #2`, `device test before merge`), in red.
  2. `⚙ N bg` when the worker has background shells (pasture's `jobs.ts` detection).
  3. `ci ●` (running) / `ci ✗` (failed) / `ci ✓` (passed) when CI applies.
  4. `PR #N` when a PR exists.
  5. `deps: <bead>` when waiting on a dependency, or `files: <path>` for `blocked-on-files`.
  6. Otherwise the tier (`light`, `standard`, `heavy`).
- Every pipeline Clawd wears the **hard hat**.

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

- Each scene has 4 frames, 40×24 art pixels, drawn with the Catppuccin Mocha palette like pasture's.
- The hard hat must fit in every frame. It may clip only at a jump or hop peak.
- Other columns reuse pasture's scenes: Idle/queued sleeps, Done celebrates, and Needs you waves with
  the `!` bubble. Pasture's one-shot transitions play when a card enters Done or Needs you.
- **Art workflow:** an Aseprite proposal sheet of all 12 scenes (frame 0 of each, plus the full
  4-frame strip for 3 of them) goes to the user for approval **before** the scenes are coded. After
  that, a contact sheet of every frame is checked.

## Keys (board focused)

| Key | Action |
|---|---|
| `hjkl` / arrows | move between cards |
| `enter` | stage the task's worker under the board |
| `o` | stage the run's orchestrator |
| `space` / `shift+space` | peek at the worker / the orchestrator |
| `d` | details popup showing `formatTaskDetail` (what `hpipe show` prints) |
| `tab` | focus the staged pane |
| `z` | zoom the stage |
| `x` | clear a Done card |

- Pasture's `n` (new agent) and `X` (close agent) are **left out**: the pipeline owns its workers,
  and closing one would fail its task.
- A card with no live worker (queued, done) shows `no worker to stage` in the status line.
- `o` on a run whose orchestrator pane is gone shows `orchestrator is not running`.

## Data

- **No new CLI.** The board imports the plugin's own modules: `listRuns` (ledger),
  `waitsOnYou`/`actionFor` and `formatTaskDetail` (`lib/status.ts`), `awaitedFor`
  (`lib/awaiting.ts`), `readDispatchLocks`, the delivery holds (`lib/delivery-health.ts`),
  `modeOf`/`TASK_ROWS` (`lib/phases.ts`), and the landing helpers (`lib/gating.ts`).
- **Refresh:** herdr events (agent status, pane lifecycle) through the kit's socket subscription,
  throttled to one refresh every 400 ms at most, plus a **2 s poll**, because the ledger changes
  without any herdr event.

## Stage

- This is pasture's stage algorithm from the kit. A placeholder pane holds the agent's home spot, and
  `pane.move` carries the real pane under the board.
- The stage is reconciled by terminal id, or by pane id after a herdr restart.
- The supervisor already rebinds a task on `pane.moved` (`supervisor/tick.ts`), so staging a worker
  keeps its task binding.
- A staged worker whose pane closes (task done, teardown) clears the stage and its placeholder.
- The orchestrator goes back to its tab when something else is staged.

## Vendored kit (`src/board/kit/`)

- **Copied from pasture:** the herdr socket client and subscriptions, `stage.ts`, `placeholder.ts`,
  `kitty.ts`, `png.ts`, `sprites.ts` (Clawd, accessories, transitions), `nav.ts`, `throttle.ts`, and
  the renderer.
- **Generic renderer.** The renderer is refactored **in pasture first** to draw a generic `CardView`
  (column, title, subtitle, right-hand labels with colours, sprite key, selected). Pasture and the
  pipeline then each map their own data to `CardView`, and the kit stays identical in both repos.
  Pasture's tests must stay green after the refactor.
- **Pipeline's own scenes** live outside the kit in `src/board/scenes.ts`, registered through a scene
  hook in the kit's sprites module. The kit is still a plain copy.
- **Sync:** `scripts/sync-kit.ts` copies pasture's kit over this one and prints the diff. It never
  runs automatically.

## bv removal

- The board no longer launches bv, and the beads git-history commit that fed bv's history view is
  removed.
- The `bv` checks in `lib/tools.ts` are no longer required for the board.
- **Out of scope:** `hpipe next` still uses `bv --robot-triage-by-track` (`lib/bv.ts`). Replacing it
  is a separate change, and its licence makes that worthwhile.

## Testing

- **Column mapping** from ledger fixtures: every Needs-you cause, Done, the Idle/queued cases including
  holds and dependencies, the Working phases, and the overlay order (a stalled task that waits on you →
  Needs you).
- **Card text:** each badge and its priority, the Needs-you clause, phase labels, and phase → scene for
  all 12 phases including the retired pr-review variants.
- **Kit:** its own unit tests come along with it, including the write-once render check.
- **Scenes:** an assertion that each scene keeps the hard hat inside the frame outside peaks, plus a
  contact sheet checked by eye.
- **Live check** in throwaway workspaces with a fake run: stage a worker, stage the orchestrator,
  unstage, and confirm the supervisor binding follows.
- The existing `test/board.test.ts` and `test/bv.test.ts` are updated for the board no longer using bv.

## Out of scope

- Replacing `hpipe next`'s bv triage.
- A cross-repo board. It stays one board per repo.
- Editing the ledger from the board (deciding, answering, releasing). Those stay as `hpipe` commands,
  run in the staged orchestrator or a terminal.
