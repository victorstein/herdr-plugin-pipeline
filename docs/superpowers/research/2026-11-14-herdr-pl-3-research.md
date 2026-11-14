# herdr-pl-3 research — pane guards follow moved worker panes

Bead `herdr-pl-3`, task `t3`. Branch `fix/moved-pane-guards`, base `8514924` (v2.3.0).

## Installed versions

| Tool | Command | Output |
|---|---|---|
| bun | `bun --version` | `1.3.14` |
| TypeScript | `bunx tsc --version` | `Version 5.9.3` |
| herdr | `herdr --version` | `herdr 0.9.1` |

`package.json` has no runtime dependencies; dev only `@types/bun: latest`, `typescript: ^5.6.0`.
Scripts: `test` = `bun test`, `typecheck` = `tsc --noEmit`.

## How a pane move reaches the ledger today

Two sources produce a `pane.moved` event with `pane_id` (new) and `previous_pane_id` (old):

1. herdr's own event, through the hook `src/hooks/pane-moved.ts:2` → `toQueuedEvent`, which copies
   `previous_pane_id` off the payload (`src/hooks/_hook.ts:44-46`; test `test/hook.test.ts:113-121`).
2. The supervisor's own `pane list` reconcile, `PaneAbsence.reconcile`
   (`src/supervisor/tick.ts:337-370`): a bound pane missing from the list whose `terminal_id` is now
   on another pane is reported as `pane.moved` (`tick.ts:370`).

Both land in `applyEvents`, which rebinds the task (`src/supervisor/tick.ts:503-511`):

```ts
if (event.kind === 'pane.moved') {
  const found = ... findTask(runs, (t) => t.pane_id === event.previous_pane_id)
  // herdr also sends it for a move within a workspace, which keeps the id.
  if (found && event.pane_id !== undefined && event.pane_id !== event.previous_pane_id) {
    found.task.pane_id = event.pane_id
    changed = true
  }
  continue
}
```

The old id is overwritten and kept nowhere. `findTask` (`tick.ts:440-446`) returns the first run
whose task matches. Introduced by `8f3c4cc` (#103); its PR body records herdr 0.9.0 renaming a
cross-workspace move (`w3:p2` → `w5:p2`) with the same `terminal_id` and no `pane.closed`. The
memory note `tools/herdr/pane-move-cross-tab-semantics` confirms the rename on herdr 0.9.1.

The worker's `HERDR_PANE_ID` is fixed in its process environment when the agent starts, so after a
move the caller of `hpipe` still reports the old id. The CLI reads it at every guarded call site:
`src/cli.ts:3431, 3517, 3527, 3539, 3574` (`callerPane: process.env.HERDR_PANE_ID || null`) and
`src/cli.ts:3623` (`resume`).

## The three guards (current control flow)

1. **`paneRefusal`** (`src/cli.ts:2390-2402`). Called by `holdRefusal` for `hpipe hold` and the
   `--before-merge` recording path (`cli.ts:2421`), and by `confirm` (`cli.ts:2694-2696`). It walks
   every driven run in the session (`runIsDriven`) and refuses if a task with a non-terminal phase
   has `t.pane_id === pane`:
   `` `${pane} is ${worker.task_id}'s worker pane in ${run.run_id}: ${why}` ``.
2. **Tier lowering** (`src/cli.ts:2930`): `isLowering(from, to) && input.callerPane !== null &&
   pipelinePanes(run).has(input.callerPane)` → `'lowering a tier needs a human; run this from your
   own pane'`. `pipelinePanes` (`src/lib/tiers.ts:67-75`) adds `run.orchestrator_pane`, and for every
   task (no phase filter) `pane_id` and `last_pane_id`. Its doc comment already names this hole: "a
   pane herdr renamed on a move ... still carries an id this set no longer holds."
3. **`resume`** (`src/cli.ts:3110-3121`): refuses if a non-terminal task has
   `task.pane_id === input.callerPane`, with
   `` `${callerPane} is ${worker.task_id}'s worker pane: a run is resumed by the orchestrator or the human, never by its workers. Stop, and end your turn` ``.

So after `w3:p2` → `w5:p2`, a call carrying `HERDR_PANE_ID=w3:p2` matches no `pane_id` in any of the
three and is let through.

## Other `pane_id ===` comparisons, and why they are out of scope

`grep -n "pane_id === " src -r` also hits `cli.ts:1092`/`1114` (`brief` hand-over: the pane id is an
argument naming a live pane to bind, not the caller), `dispatch-steps.ts:349, 371, 449` (dispatch
binding against a live `pane list`), `unstarted.ts:235`, `board/ui.ts`, `kit/stage.ts`,
`orchestrator.ts`. None identify the caller by `HERDR_PANE_ID`, so none have this hole.

## Nearest existing example: `last_pane_id`

The same shape of change was made for a released pane:

- `Task.last_pane_id?: string` (`src/lib/types.ts:269-273`), documented as optional because older
  ledgers lack it.
- Written in one place, `releaseWorkerPane` (`src/lib/unstarted.ts:257-258`).
- Read by `pipelinePanes` (`tiers.ts:72`) and tested in `test/tiers.test.ts:60-75`, which asserts the
  set includes `last_pane_id`.

An optional field needs no `schema_version` bump: `last_pane_id` was added without one, and
`isCurrentSchemaRun` (`src/lib/ledger.ts:31-32`) only compares the version number.

## Existing tests to extend

- `test/tick.test.ts:1120-1126` (move keeping the id changes nothing) and `1138-1147` (move rebinds
  `pane_id`). `mkRun`/`mkTask` helpers; `applyEvents([run], [event], 'personal', new Set())`.
- `test/tiers.test.ts:60-75` (`pipelinePanes` with `last_pane_id`).
- `resume` refusal: `test/cli-commands.test.ts:347-356` asserts the exact text for `w3:p1`.
- Before-merge refusal: the tests are in **`test/before-merge-cli.test.ts`**, not
  `cli-commands.test.ts` as the acceptance says — `hold` refusal at `:151-162`, `confirm` from a
  worker pane at `:251`, and the "finished task or undriven run is no worker" case at `:164`. The
  former-pane test for the before-merge check belongs beside them.

## Risk the spec must weigh: a former id reused by someone else

The source disagrees with itself on whether herdr reuses ids. `8f3c4cc`'s PR body says "Pane ids
survive a server restart and are not reused." But `paneRefusal`'s comment (`cli.ts:2391-2393`) says
"herdr reuses workspace ids, so such a record may now name the orchestrator's pane or the human's",
`resume`'s comment (`cli.ts:3114`) says "herdr reuses ids", and `before-merge-cli.test.ts:164` is
named for it. Not verified live here.

If ids are reused, a moved-away `w3:p2` may later name a human's or the orchestrator's pane, and the
former-id match would refuse them. Both `paneRefusal` and `resume` already limit the match to
non-terminal tasks in driven runs, so the window is the life of the worker, the same window that
already applies to `pane_id`. `pipelinePanes` has no phase filter and already carries the same
exposure for `last_pane_id`. A move back to the original workspace can also give the pane a
former id again, which `pane_id === pane || former_pane_ids.includes(pane)` handles.

## Scope and tier

All changes stay in `src/lib/types.ts`, `src/supervisor/tick.ts`, `src/lib/tiers.ts`, `src/cli.ts`
and their tests: one surface (`plugin`), an optional ledger field, no `schema_version` change, no
`phases.ts` change, no prompt change. `standard` stays the right tier.
