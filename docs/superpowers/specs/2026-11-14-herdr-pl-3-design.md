# herdr-pl-3 design: pane guards follow moved worker panes

Bead `herdr-pl-3`, task `t3`, tier `standard`. Research:
`docs/superpowers/research/2026-11-14-herdr-pl-3-research.md`.

## Problem

When herdr moves a pane to another workspace, it gives the pane a new id (`w3:p2` → `w5:p2`) and
keeps its `terminal_id` (`8f3c4cc` PR body; `src/supervisor/tick.ts:337-339`). The supervisor
follows the move. On `pane.moved` it overwrites `task.pane_id` with the new id and keeps the old
one nowhere (`src/supervisor/tick.ts:503-511`).

The worker agent inside that pane keeps the old id in its environment. `HERDR_PANE_ID` was set when
the process started, and the CLI reads it on every guarded call (`src/cli.ts:3431, 3517, 3527,
3539, 3574, 3623`). Three guards identify a worker by comparing that value with `task.pane_id`, so
a moved worker gets past all three:

| Guard | Where | Current match |
|---|---|---|
| `paneRefusal` (used by `hold` and `--before-merge` through `holdRefusal`, and by `confirm`) | `src/cli.ts:2395-2402`, callers `:2421`, `:2694` | `t.pane_id === pane && !taskPhaseIsTerminal(t.phase)` over every driven run |
| tier lowering | `src/cli.ts:2930`, set from `pipelinePanes` `src/lib/tiers.ts:67-75` | orchestrator pane, each task's `pane_id` and `last_pane_id` |
| `resume` | `src/cli.ts:3110-3121` | `task.pane_id === callerPane && !taskPhaseIsTerminal(task.phase)` |

The board's staging makes this common (spec `2026-11-13-pasture-board-design.md`, Plan 4, item 5),
but any pane moved by hand has the same hole today.

## Goal

A worker calling from any id its pane has had during this task gets the same refusal it gets
from its current id, from all three guards.

## Non-goals

- Any guard other than the three. `brief` (`cli.ts:1092, 1114`) and dispatch
  (`dispatch-steps.ts:349, 371, 449`) compare against a pane id passed as an argument or read from
  a live `pane list`, not against the caller's environment (research, "Other `pane_id ===`
  comparisons").
- Making the guards authentication. `pipelinePanes`'s doc comment (`tiers.ts:61-66`) already calls
  them guards against an agent that ignores its prompts, and that does not change.
- Rewriting the worker's `HERDR_PANE_ID`. A running process's environment cannot be changed from
  outside.
- Changing how a move is detected (`PaneAbsence.reconcile`, `tick.ts:343-375`) or which task it
  matches (`tick.ts:506`).
- A `schema_version` bump or a `phases.ts` change (A1).

## Architecture

The work follows `last_pane_id`. It is the same kind of record: an optional `Task` field
(`src/lib/types.ts:269-273`) holding a pane id the task no longer has. It is written in one helper
in `src/lib/unstarted.ts:257-258` and read by `pipelinePanes` (`tiers.ts:72`). Files modelled on:
`src/lib/types.ts` (the field and its doc comment), `src/lib/unstarted.ts` (`bindWorkerPane` and
`releaseWorkerPane`, the task-pane helpers), and `test/tiers.test.ts:60-75` (the test).

### 1. `Task.former_pane_ids?: string[]` — `src/lib/types.ts`

The field sits after `last_pane_id`. Its doc comment says what it holds (the ids herdr gave this
task's live pane before a move renamed it) and why it is optional (ledgers written before this
change lack it), in the same form as `last_pane_id`'s comment.

### 2. Record the old id on a move — `src/supervisor/tick.ts:503-511`

Inside the existing branch, where `pane_id` is rebound (`event.pane_id !== event.previous_pane_id`),
the handler first appends `event.previous_pane_id` to `former_pane_ids`, unless the list already
holds it. A move that keeps the id goes nowhere near this branch and still changes nothing
(`tick.ts:508`; test `tick.test.ts:1120-1126`).

### 3. One predicate — `holdsPane(task, pane)` in `src/lib/unstarted.ts`

```ts
export function holdsPane(task: Task, pane: string): boolean {
  return task.pane_id === pane || (task.former_pane_ids?.includes(pane) ?? false)
}
```

It sits beside `bindWorkerPane` and `releaseWorkerPane`. `cli.ts` already imports from
`./lib/unstarted` (`cli.ts:73`).

### 4. The guards use it

- `paneRefusal` (`cli.ts:2399`): `run.tasks.find((t) => holdsPane(t, pane) &&
  !taskPhaseIsTerminal(t.phase))`. The message is unchanged.
- `resume` (`cli.ts:3115-3116`): `run.tasks.find((task) => holdsPane(task, input.callerPane) &&
  !taskPhaseIsTerminal(task.phase))`. The message is unchanged. The comment at `cli.ts:3114`
  ("Only a pane a task holds now") becomes: a pane the task holds now or held before a move, and
  never a dead pane's `last_pane_id`, because herdr may reuse that id.
- `pipelinePanes` (`tiers.ts:67-75`) adds every `former_pane_ids` entry. It keeps the per-task
  loop and has no phase filter, exactly as for `last_pane_id`. Its doc comment drops "a pane herdr
  renamed on a move", which is no longer a gap. The orchestrator rebound by `claim` stays a known
  gap.

### 5. The list goes with the pane (review 0, M1)

`former_pane_ids` describes the pane the task holds now, so every path that unbinds or replaces that
pane deletes the field:

- `releaseWorkerPane` (`src/lib/unstarted.ts:257-262`). Every supervisor release goes through it:
  abort (`tick.ts:303`, `:326`), worker no longer needed (`tick.ts:292`), agent released
  (`tick.ts:535`), and teardown (`src/supervisor/teardown.ts:57`).
- `forget` (`src/cli.ts:3192-3200`), which sets `pane_id = null` itself.
- `bindWorkerPane` (`unstarted.ts:234-242`), when it binds a *different* pane (after its
  `pane_id === paneId` early return). Its callers are `pane.agent_detected` (`tick.ts:540`) and the
  brief hand-over (`cli.ts:1400`). A move never goes through it, because `tick.ts:508-509` assigns
  `pane_id` directly, so a move's history is never wiped by its own rebind.

## Data and control flow

```
herdr pane.moved {pane_id: w5:p2, previous_pane_id: w3:p2}      (hook, _hook.ts:44-46)
  or PaneAbsence.reconcile sees w3:p2's terminal on w5:p2        (tick.ts:370)
→ applyEvents: findTask(t.pane_id === 'w3:p2')                   (tick.ts:506)
→ ids differ: former_pane_ids ∪= ['w3:p2']; pane_id = 'w5:p2'; changed = true
→ ledger saved by the tick as today

worker in that pane, HERDR_PANE_ID=w3:p2:
  hpipe hold/confirm → paneRefusal → holdsPane(t, 'w3:p2') true → "w3:p2 is t3's worker pane in <run>: …"
  hpipe tier … lower → pipelinePanes(run).has('w3:p2') true → "lowering a tier needs a human; …"
  hpipe resume <run> → holdsPane(t, 'w3:p2') true → "w3:p2 is t3's worker pane: a run is resumed …"
```

A second move (`w5:p2` → `w6:p1`) appends `w5:p2`, giving `['w3:p2', 'w5:p2']`. The worker's
environment still says `w3:p2`, and every id the pane has had is covered.

## Assumptions (each a reviewable decision)

- **A1. No schema bump.** The field is optional and absent means empty. Precedent: `last_pane_id`
  was added without one (research, "Nearest existing example"), and `isCurrentSchemaRun` compares
  only the version number (`src/lib/ledger.ts:31-32`). An older installed CLI that reads a ledger
  holding the field ignores it. An older supervisor that rewrites the task keeps it, because the
  store writes and reads the whole object as JSON (`src/lib/store.ts:20`, `:204`), so nothing is
  lost either way.
- **A2. Kept exactly as long as the moved pane is the task's pane.** *(Changed in review 0, M1. It
  was "never cleared", which contradicted A4 and A5.)* `former_pane_ids` is deleted wherever the
  task's pane is released or replaced (Architecture §5). It survives a phase change, a rewind that
  keeps the pane, and further moves. Unlike `last_pane_id`, it does not outlive its pane, because
  its ids are used to *refuse* callers, and a dead pane's id is free to name someone else.
- **A3. Same wording, caller's id.** The refusal names the id the caller passed (`w3:p2`), not the
  task's current one. The acceptance asks for "the same wording as from its current one", and the
  caller's id is the one the caller recognises. Neither message template changes. *Known limit
  (review 0, m1):* `find` returns the first matching task. If herdr reused a moved-away id for
  another worker's live pane, the message could name the earlier task instead of the caller's own.
  The refusal itself is still correct, so this is accepted rather than fixed with a two-pass match.
- **A4. Reuse risk bounded by the pane's life.** *(Rationale changed in review 0, M1.)* herdr reuses
  workspace ids, measured on a live run (`src/supervisor/teardown.ts:48-53`). `8f3c4cc` says pane
  ids are not reused, and this design does not settle that live. If they are, a former id could
  later name a human's or the orchestrator's pane. Because the list is deleted with the pane (A2),
  a former id is only ever held while the worker that had it is still running in the moved pane.
  `paneRefusal` and `resume` also match only non-terminal tasks (`cli.ts:2398-2399`, `:3116`).
  `pipelinePanes` has no phase filter, but it too sees only live panes' former ids, and it refuses
  only a *lowering*. `last_pane_id` there already carries a wider exposure (`tiers.ts:72`).
- **A5. Former ids only for a live pane, not for a dead one.** `resume` and `paneRefusal` keep
  ignoring `last_pane_id`, as `cli.ts:3114` deliberately does. A former id belongs to a pane that is
  still alive and still holds the worker, and A2 makes that true by deleting the list with the pane.
  `last_pane_id` belongs to a pane that is gone, so its id is free to name someone else.
- **A6. Matching a move stays on `pane_id`.** `tick.ts:506` keeps finding the task by
  `t.pane_id === previous_pane_id`. A `pane.moved` whose `previous_pane_id` is only a former id is a
  stale or duplicate event, and it must not rebind anything. `tick.test.ts:1213-1224` feeds exactly
  that: herdr's `pane.moved` and then the reconcile's own copy of the same move. The second one finds
  no task, so it appends nothing either.
- **A7. No duplicates; order is the order of moves.** An append that finds the id already present
  is skipped. Nothing reads the order. It is kept only because it is the natural log.
- **A8. The helper lives in `src/lib/unstarted.ts`.** That file already owns task-pane bookkeeping
  (`bindWorkerPane`, `releaseWorkerPane`, `unstarted.ts:234-262`) and is imported by both `cli.ts`
  and `tick.ts`. `pipelinePanes` reads the field directly rather than through `holdsPane`, because
  it builds a set rather than testing one pane.

## Error handling

The change adds no new failure mode. `former_pane_ids` may be absent (old ledgers), and every read
goes through `?.` or `?? []`. The append runs only where `event.previous_pane_id` is already
checked to be defined (`tick.ts:505`). The three guards keep their current null handling:
`paneRefusal` refuses a null pane (`cli.ts:2396`), and `resume` and `tier` skip the check when there
is no caller pane (`cli.ts:3115`, `:2930`).

## Testing strategy

Test-first, in the existing files. Each test fails before the code change.

- `test/tick.test.ts`, beside `:1120-1147`:
  - `pane.moved` `w3:p2` → `w5:p2` sets `pane_id` to `w5:p2` and `former_pane_ids` to `['w3:p2']`.
  - A second move `w5:p2` → `w6:p1` gives `['w3:p2', 'w5:p2']`.
  - A move that keeps the id leaves `former_pane_ids` undefined. This extends `:1120`.
  - The duplicate-event case at `:1213-1224` ends with `former_pane_ids` equal to `['w3:p2']`, not
    `['w3:p2', 'w3:p2']` (A6, A7).
- `test/tiers.test.ts`, beside `:60-75`: a task with `former_pane_ids: ['w3:p2']` puts `w3:p2` in
  `pipelinePanes`.
- `test/cli-commands.test.ts`, beside `:347-356`: `resume` from a non-terminal task's former id is
  refused with the exact text the current id gets (built from the same template, with the caller's
  id).
- Before-merge refusal from a former id. The existing guard tests are in
  `test/before-merge-cli.test.ts` (`hold` at `:151-162`, `confirm` at `:251`), not in
  `cli-commands.test.ts` as the bead's acceptance says. The new test goes beside them, so it reuses
  their fixtures (`perTaskRun`, `heldTask`, `hold`, `confirm`). It covers `hold` and `confirm` from
  `w3:p2` on a task whose `pane_id` is `w5:p2` and whose `former_pane_ids` is `['w3:p2']`, each
  refused with the same text as from `w5:p2`. This is a deliberate deviation from the acceptance's
  file name, made so the test sits with its fixtures.
- A finished task's former id does not refuse `resume` or `hold`. This guards A4's bound. It extends
  the "finished task" case at `before-merge-cli.test.ts:164`.
- Clearing (A2, review 0 M1):
  - `releaseWorkerPane` on a task with `former_pane_ids` leaves the field undefined. This test goes
    in the file that already covers `releaseWorkerPane` or `unstarted.ts`.
  - `bindWorkerPane` to a different pane deletes the field, and binding the same pane keeps it.
  - `forget` deletes the field (`cli-commands.test.ts`).
  - An aborted run whose moved worker's pane was released: `resume` from that worker's former id
    succeeds (`cli-commands.test.ts`, beside `:347-364`). This is the human-blocked case M1 names.

## Changes from review 0

Verdict CLEAR (`docs/superpowers/reviews/herdr-pl-3-spec-review-0.md`).

- **M1, accepted.** "Never cleared" contradicted A4 and A5: an abort, a not-needed worker, a release
  or `forget` leaves the task non-terminal with its pane gone, and a stale former id could then
  refuse the human's `resume`. Added Architecture §5, which deletes the list in
  `releaseWorkerPane`, `forget` and a changing `bindWorkerPane`. Rewrote A2 and A4, tightened A5,
  and added the clearing tests.
- **m1, accepted as a known limit** in A3: the message may name the wrong task in a reuse collision,
  and the refusal is still right.
- `bunx tsc --noEmit` and `bun test` green.

**Against a real herdr session** (plugin-dev guide, "Where the behaviour is actually proven"): this
touches pane-event handling, which the unit suite drives with fake events. The live check is in a
smoke session (`project-live-smoke-run-practice`). Move a running worker's pane to another workspace
with `herdr pane move`, confirm the ledger shows the new `pane_id` and the old id in
`former_pane_ids`, then run `hpipe resume <run>` from that worker's pane and see it refused. This
runs once the change is installed, not in CI. A difference from this runbook is a finding.
