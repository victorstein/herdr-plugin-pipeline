Tier: standard

# herdr-pl-3 spec review, pass 0

Reviewed: `docs/superpowers/specs/2026-11-14-herdr-pl-3-design.md` against `hpipe brief --task t3`
and `docs/superpowers/research/2026-11-14-herdr-pl-3-research.md`, on `fix/moved-pane-guards` at
`9414320`.

## What checks out

These citations were verified against the code and are correct: the rebind at
`src/supervisor/tick.ts:503-511`, the reconcile emitting `pane.moved` at `tick.ts:370`, `findTask`
at `tick.ts:440-446`, `paneRefusal` at `src/cli.ts:2395-2402` and its callers at `:2421` and `:2694`,
the tier guard at `cli.ts:2930`, `resume` at `cli.ts:3110-3121`, `pipelinePanes` at
`src/lib/tiers.ts:61-75`, `last_pane_id` at `src/lib/types.ts:269-273`, and the `HERDR_PANE_ID` reads
at `cli.ts:3431, 3517, 3527, 3539, 3574, 3623`. A1 holds: the store round-trips the whole object as
JSON (`store.ts:20`, `:204`), and nothing in `src` enumerates task keys. A6 holds. In
`tick.test.ts:1213-1224`, the reconcile's event is built while `pane_id` is still `w3:p2`, so it
arrives after herdr's event has rebound the task, finds no task, and appends nothing. A3 holds:
both templates interpolate the caller's id (`cli.ts:2400`, `:3118`). The test-file deviation for
the before-merge case is flagged in the spec and justified by where the fixtures are
(`before-merge-cli.test.ts:151-185`), so it is not a finding. `herdr pane move --help` on the
installed herdr shows `--tab`, `--split`, `--target-pane` and `--ratio`, so the live runbook's
command exists.

## MAJOR

### M1. Former ids outlive the pane, which reopens the reuse hole `resume` was written to close (A2 contradicts A5 and A4)

**Claim.** A2 says `former_pane_ids` is never cleared, "not by `releaseWorkerPane`, `bindWorkerPane`,
a rewind, or a phase change", and that this mirrors `last_pane_id`. A5 says "A former id belongs to a
pane that is still alive and still holds the worker", unlike `last_pane_id`, whose pane "is gone, so
its id is free to name someone else". A4 bounds the reuse risk to the task's life, which it calls
"the same window `pane_id` has, and inside it the worker that held the id is still running".

**Problem.** Nothing in the design ties a former id to a live pane. Once the pane dies, its former
ids are exactly what A5 says `last_pane_id` is: ids free for herdr to hand to someone else. Yet
`holdsPane` keeps matching them for as long as the task's phase is non-terminal. Several existing
paths release a pane and leave the task non-terminal:

- **Aborted run.** `losePane` → `releaseAbortedPane` → `releaseWorkerPane`, and the phase is kept
  for a resume (`tick.ts:284-288`, `:323-327`). The guard that sees this most is `resume`, and the
  person it then refuses is the human trying to resume the run. Today's code avoids this on purpose:
  `cli.ts:3114` says "Only a pane a task holds now: herdr reuses ids, so a human's pane can carry a
  finished task's old one". `test/cli-commands.test.ts:358-364` pins that behaviour for `pane_id`.
  With this spec, a worker that was staged once and then lost its pane during the abort leaves
  `w3:p1` in `former_pane_ids`. A human pane that later gets `w3:p1` is told "w3:p1 is t1's worker
  pane: … Stop, and end your turn".
- **Worker no longer needed.** `losePane` → `releaseWorkerPane` with the phase left alone, for
  example `merge` (`tick.ts:290-293`; `workerStillNeeded` returns false for `merge` in
  `tick.test.ts`). `paneRefusal` scans every driven run in the session (`cli.ts:2397-2399`), so an
  orchestrator pane whose id was reused, for example after a `claim` rebind, is refused `hold` and
  `confirm` in any run.
- **Rewind out of `failed`.** The phase becomes non-terminal again, the dead pane's former ids come
  back into play, and they now sit beside a new `pane_id` from `bindWorkerPane` (`tick.ts:540`,
  `cli.ts:1400`).
- **`hpipe forget`.** It nulls `pane_id` directly, without `releaseWorkerPane` (`cli.ts:3198`).

A4 leaves the reuse question open ("This design does not settle the reuse question live"). The
repo has a live measurement that settles it: `src/supervisor/teardown.ts:50-53` says "herdr reuses
workspace ids, so a finished task still naming its removed `w3` appeared to own the next `w3`.
Measured on a live run." The first pane of a reused `w3` is `w3:p1`. A4's window argument is wrong
even while the pane lives: a move frees the old id at once, so for the rest of the task's life
the old id names no worker. The `pane_id` window does not have that property. A2's appeal to
`last_pane_id` is also wrong. `last_pane_id` is overwritten on every release
(`unstarted.ts:258`), and it is deliberately not read by `resume` or `paneRefusal`, which are the
two guards where the difference matters.

**Evidence.** `src/supervisor/tick.ts:284-293, 323-327`; `src/lib/unstarted.ts:257-262`;
`src/cli.ts:3114-3116, 3198`; `src/supervisor/teardown.ts:50-57`;
`test/cli-commands.test.ts:358-364`; `test/before-merge-cli.test.ts:164`.

**Fix (inline).**

- Former ids die with the pane. In `releaseWorkerPane` (`unstarted.ts:257`), add
  `delete task.former_pane_ids` beside the `last_pane_id` line. That one helper covers `losePane`,
  `releaseAbortedPane`, the `released` agent path (`tick.ts:535`) and teardown
  (`teardown.ts:57`).
- Do the same in `forget` (`cli.ts:3198`).
- In `bindWorkerPane`, clear the list when the bound pane changes. A new agent pane is not the moved
  one.
- Rewrite A2, A4 and A5 to say that former ids live exactly as long as the pane they renamed.
  `pipelinePanes` then loses a dead pane's former ids, which is the same treatment `last_pane_id`'s
  predecessors already get.
- Add tests:
  - `releaseWorkerPane` clears `former_pane_ids`.
  - Extend `cli-commands.test.ts:358`: on an aborted run, a task with `pane_id: null` and
    `former_pane_ids: ['w6:p1']` does not refuse `resume` from `w6:p1`.

## MINOR

### m1. A re-used former id can make `paneRefusal` name the wrong task

**Claim.** A3 says the wording is unchanged.

**Problem.** `run.tasks.find(holdsPane…)` returns the first task that holds the id. Suppose task A
was staged on the board's pane `wB:pN`, unstaged, and the same id was then given to task B on its
next staging. Task A's former id then shadows task B's current id. The refusal is still correct, but
it names `A` instead of `B`. M1's clearing does not remove this, because task A's pane is still
alive.

**Evidence.** `cli.ts:2399`; the board stages workers into one shared board workspace and returns
them (`docs/superpowers/specs/2026-11-13-pasture-board-design.md:245-252`).

**Fix.** In `paneRefusal` and `resume`, prefer a `pane_id` match before a former-id match. One way:
`run.tasks.find((t) => t.pane_id === pane && live) ?? run.tasks.find((t) => holdsPane(t, pane) && live)`.
Alternatively, accept the misnaming and record it as a known limit in A3.

VERDICT: CLEAR
