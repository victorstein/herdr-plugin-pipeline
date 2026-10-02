# Adversarial review: Beads as the issue store, pass 2

Spec: `docs/superpowers/specs/2026-10-02-beads-issue-store-design.md` (branch
`docs/beads-issue-store-spec`, pass 2 at `ed8e0a6`, written against `31e6b2d`). Pass 1:
`docs/superpowers/reviews/2026-10-02-beads-issue-store-adversarial-1.md`.

The fixed decisions are taken as given. This pass checks each pass-1 resolution against the code
and against beads v1.3.1 / beads_viewer v0.25.2 sources. It then looks for defects that pass 2's
new machinery introduces: the bead outbox, the single `hpipe` actor, `hpipe escalate`, the
releases, the bare close row, the per-slug board, and the lock.

## What holds up

- **The close-guard analysis (pass-1 BLOCKER 1) is right for beads hpipe creates.**
  - `AssigneeMatches` passes when the assignee is empty or canonically equals the actor
    (`internal/validation/issue.go:165-175`). With one actor `hpipe`, claim and close agree.
  - The open-blocker check counts only `blocks`, `waits-for` and `conditional-blocks`
    (`internal/storage/issueops/dependency_queries.go:936`). So `discovered-from` never blocks a
    close.
  - The open-children check counts only `parent-child` (`issueops/close.go:193-206`).
- **Every bd flag the spec names exists in 1.3.1.**
  - `update --claim`, `-s` with `blocked`/`in_progress`/`open` (`cmd/bd/update.go:150-154,978,993`).
  - `unclaim` (`cmd/bd/unclaim.go:13`) and `reopen` (`cmd/bd/reopen.go:16`).
  - `close --reason-file` (`close.go:491`), `comments add --file` (`comments.go:300`), and
    `create --deps discovered-from:<id>` (`create.go:936`).
  - `show --include-comments` puts full comment bodies into the JSON `comments` array
    (`show.go:309`, `internal/types/types.go:1154`).
  - `bd version` prints `bd version X.Y.Z (…)`, and `--json` gives `{"version": …}`
    (`cmd/bd/version.go:43-63`). Both are parseable.
  - Re-adding a dep of the same type is idempotent (`dependencies.go:266`). Reopening an open
    issue is an exit-0 no-op (`reopen.go:64`).
- **The herdr surface exists.** `herdr plugin pane open` takes `--workspace`, `--cwd`, `--env`
  and `--no-focus`. `herdr pane rename <PANE_ID> [LABEL]` exists. `HERDR_PANE_ID` is already
  read from the env by the CLI (`src/cli.ts:1140`).
- **bv env opt-outs are real.** `BV_NO_UPDATE_CHECK` and `BV_NO_GITIGNORE` are in
  `internal/env/env.go:168,180`.
- **Removing the actor from the close row does fix pass-1 MINOR 2's evaluation gate.** Orchestrator
  rows are skipped while it is busy (`src/supervisor/tasks.ts:242`). An actor-less row is evaluated
  every tick.
- **Decision 4's direction is sound.** An in-ledger outbox drained by the supervisor matches how
  `run.outbox` already works (`main.ts:371-375`).

## Findings

### MAJOR 1: Release ops fail deterministically and wedge the task's outbox for good

**Claim (§5, §8).** "Label, status, dep, claim, unclaim, reopen and close are idempotent in bd."
A failed op "stop[s] that task's queue for this tick". On `failed`/`orphaned`/abort, the spec
enqueues `unclaim`, `setStatus(open)` and `labels(+hpipe:outcome=…)`.

**Problem.** `bd unclaim` is not idempotent, and it refuses three states the spec routinely sends
it:

- **Closed:** "cannot unclaim closed issue" (`internal/storage/issueops/unclaim.go:46-48`).
- **Unassigned:** "issue %s is not assigned" (`unclaim.go:52-53`).
- **Any status but `open`/`in_progress`:** the UPDATE is `WHERE … status IN ('open','in_progress')`
  (`unclaim.go:83`). A `blocked` bead falls through to "no matching row" (`unclaim.go:100,106`).

Each concrete trigger:

1. **A crash or stale save between a successful `unclaim` and the drain's ledger save.** The retry
   hits "not assigned". This is exactly the window §5's idempotency paragraph claims to close.
2. **`hpipe abort` releases "every unfinished task".** That includes `queued` tasks, and
   `research` tasks still `awaiting_brief`. Neither was ever claimed, because the claim happens in
   `dispatch` (`src/cli.ts:505-545`). Result: "not assigned".
3. **`orphaned` is post-merge.** Its only producer is a teardown failure after `close`
   (`src/supervisor/teardown.ts:186`, `src/lib/phases.ts:174-179`). By then the bead is closed:
   "cannot unclaim closed issue". Releasing it is also wrong in intent. It would re-offer merged
   work to `hpipe next` if it ever succeeded.
4. **A task fails while its bead is `blocked`.** Two cases:
   - An escalated decision whose task then fails some way other than pane death.
   - `hpipe answer --by orchestrator` after `hpipe escalate`. §6 un-blocks only on `--by human`
     and `abandonDecisions`.

   Either way: "no matching row".
5. **`depAdd` can fail too.** A different-type edge between the same pair gives
   `DependencyTypeConflictError` (`dependencies.go:279`), and a cycle refuses at
   `dependencies.go:245`. Both are plausible on `--bead` adoption.

**Why it wedges.** The queue is FIFO and stops on failure, with no attempt cap, poison handling
or surfacing for any op but `close`. So a failing head op:

- retries every tick forever. That costs one `bd` spawn under the lock, even on `done` runs the
  drain now visits.
- blocks every later op for that task. If it sits ahead of a `close` (case 5, or an escalation
  op), the close never runs. `bead_close_failures` stays 0, so the stall clause (§8) says "waiting
  on the Beads close" indefinitely and never offers `hpipe close`.

`hpipe close --force` has a related gap. It sets `bead_closed_at_ms`, but the spec never says it
settles the pending `close` op. The drain keeps re-running it without `--force`. A re-close of a
closed bead still runs the open-children check (`close.go:141-150`). So if children were the
reason, that op fails forever too.

**Fix.**
- Make `release` one compound op that reads state first. If the bead is closed, it is done. If it
  is `blocked`, set it `open` first. If the assignee is `hpipe`, unclaim. If it is unassigned, it
  is done.
- Treat "already in the target state" as success for every kind.
- Drop `orphaned` from the release list. It is merged and closed.
- Un-block on any answer to an escalated decision, not just `--by human`.
- Give non-close ops an attempt cap that parks the op and surfaces it in `hpipe status`, so it
  cannot block the queue forever.
- Have `hpipe close` mark the pending close op done.
- Correct the §5 idempotency sentence.

### MAJOR 2: Released beads stay "held" forever, so the release does nothing for `hpipe next`

**Claim (§4, §8).** Adoption refuses a bead "held by any run file in any session
(`$STATE/runs/*/`)". `hpipe next` "drops recommendations whose ID any run file in any session
holds". The release exists "so `hpipe next` can recommend it again".

**Problem.** Run files are never deleted. They live at `runs/<session>/<run_id>.json`, and
`listRuns` reads them all (`src/lib/ledger.ts:7-9,153-165`). A failed task's run file keeps its
`bead` field forever, so:

- every released bead is filtered out of `next` for good;
- it is refused by `--bead` for good;
- the same applies to `blocked-on-failure` tasks' beads, which were never started.

As written, pass-1 MAJOR 7's resolution is inert, and the backlog silently loses the work. The
spec never defines "holds".

**Fix.** Define it: a bead is held only by a task that is not in a terminal phase, in a run whose
`phase !== 'done'`. Or define it as "and its release op has not completed". Use the same predicate
in `--bead`, `next` and the §12 tests.

### MAJOR 3: Appending ops "after the save, outside `retryingOnStale`" reopens the crash window the outbox was meant to close

**Claim (Decision 4, §4, §6).** "After the ledger save lands, the command appends ops." "All of
these append after the command's ledger save, outside `retryingOnStale`."

**Problem.** The outbox is in the ledger (`Task.bead_ops`), so an append is a second
read-modify-write save of the run file. That save races the supervisor's 1 s saves like any
other, and nothing in the spec retries it.

- A crash or unlanded save between the two saves loses the ops for good:
  - registration: the `hpipe:run=` label and the `blocks` edges;
  - `escalate`: `escalated_at` is saved but the bead is never blocked;
  - `abort`: the release ops (pass-1 MAJOR 7 again).
- The rule is inconsistent anyway. §6 has `abandonDecisions` append ops. That function runs
  inside `rewind`, which is wrapped in `retryingOnStale` (`src/cli.ts:719,787`). It also runs in
  the supervisor's event application, which is re-applied on a stale save (`tick.ts:204,212`,
  `main.ts:220-227`).
- `id = <task_id>-o<n>` assigned "at append" can collide. The CLI and a supervisor effect can
  both compute `n` from the same `bead_ops.length`. The comment-dedupe marker keys on that id, so
  the second comment would be silently skipped.

The memo pass-1 MAJOR 5 asked for is unnecessary here. Appending in the *same* save as the state
change is atomic, and a stale retry re-reads the fresh copy and appends once.

**Fix.** Append ops inside the command's own mutation, in the same `saveRun`, and in supervisor
effects (`saveOrReapply`). Derive the op id from a monotone per-task counter stored on the task,
not from the array length.

### MAJOR 4: Synchronous claims race asynchronous releases, and some live paths never re-claim

**Claim (§8).** "`hpipe abort` → the same ops for every unfinished task. `hpipe resume` → `claim`
(synchronous, as at dispatch) for tasks past `research`."

**Problems.**

- **Order inversion on resume.** Abort enqueues `unclaim`. If `resume` runs before the drain
  (supervisor try-lock skipped, or within the same second), its synchronous claim is an
  idempotent no-op (`issueops/claim.go:147-149`). The drain then unclaims a bead whose task is
  running again. The same inversion happens when a human rewinds a `failed` task to `research`
  and re-dispatches before the failed-release ops drain.
- **Wrong predicate on resume.** "Past `research`" excludes tasks that are in `research` with a
  worker already briefed. A task enters `research` at registration (`src/cli.ts:507-510,530-536`).
  It also includes tasks that were never dispatched, whose claim belongs to `dispatch`.
- **Rewind into `failed` enqueues no release.** `hpipe rewind --task tN failed` is the documented
  way to abandon an escalated task (`src/lib/gating.ts:8-12`). Rewind bypasses `enterTaskPhase`
  (`src/cli.ts:743-745`). §8 lists rewind only for "into `PHASES_BEFORE_A_PR` after a merge". So
  the abandon path leaves the bead claimed for good.
- **Rewind out of `failed` into a post-dispatch phase never re-claims.** The rework then runs on an
  `open`, unassigned bead.
- **The outcome label sticks.** `hpipe:outcome=<phase>` is never removed on re-claim, so a
  resumed bead keeps showing `outcome=failed`. For abort, "<phase>" is undefined.

**Fix.**
- When a command makes a task live again (`resume`, rewind out of a terminal phase, `dispatch`),
  mark that task's pending release ops `superseded` in the same save. Then claim, and remove
  `hpipe:outcome=*`.
- Use "the task has been briefed" (`pane_id !== null` or no `awaiting_brief`) as the resume
  predicate.
- Enqueue the release on any entry into `failed`, including through `rewind`.

### MAJOR 5: The drain blocks the serial tick and starves the CLI's 10 s lock wait

**Claim (§2, §5).** The supervisor try-locks, "so the serial tick loop (`main.ts:196-483`) never
blocks on Beads". "One locked hold per project per tick covers all its ops plus one export."

**Problem.** The try-lock removes the *wait* but not the *work*. The drain runs every pending op
serially inside the tick, under one hold. Pass 1 measured about 0.4-0.7 s per `bd` spawn, and
each spawn may take up to 30 s before it is killed. An ordinary intake adds up quickly:

- each `hpipe task` enqueues a label plus one `depAdd` per `--depends-on`;
- every phase change enqueues a label swap.

So 6 tasks registered back to back is about 15-20 spawns, roughly 8-12 s in one tick. That has
two effects:

- **The tick stalls.** Deliveries, confirmation windows and the 2 s idle-read bound
  (`main.ts:44`) all wait behind it.
- **The CLI times out.** The orchestrator's concurrent `hpipe task` or `dispatch` waits 10 s and
  fails with "Beads is busy, retry", during intake, in front of the agent.

§2 also says each public write method exports after its command. That contradicts "one export
per hold" unless the drain uses unexporting internals, which the spec does not name.

**Fix.**
- Give each hold a time budget (e.g. 2 s) and leave the remainder for the next tick.
- Release the lock between ops, so the CLI's wait is bounded by one op rather than a whole
  queue.
- Fold a task's label and status changes into one `bd update`.
- Export once per hold through the unlocked helper, and say so.
- Or run the drain off the tick's critical path.

## MINOR findings

### MINOR 1: The actor-less `close` row fails `table.test.ts`

`close` stays `stallable` and loses `actor`. `test/table.test.ts:34-40` requires every stallable row
to resolve to a pane or name a `probeTarget`. Without one, the §8 "run `hpipe close`" clause also
has nobody to be delivered to. **Fix:** add `probeTarget: 'orchestrator'`, as the `ci` and
`teardown` rows have (`phases.ts:152-162`).

### MINOR 2: The close signal is not quite an edge

- **A rewind into `close` without a recorded merge waits forever.** Only the merge transition
  enqueues the close op, so none is ever enqueued. The stall clause says "waiting on the Beads
  close" with zero failures. Today's clause covers this case by pointing at a rewind into `merge`
  (`src/supervisor/stall.ts:341-352`).
- **A rewind while a close op is pending leaves that op in the queue.** If it later succeeds, it
  sets `bead_closed_at_ms` *after* the rewind reset it. The `reopen` behind it then reopens the
  bead. The rework's own close row then sees a stale non-null field and clears without this
  merge's close.

**Fix.** A rewind that resets `bead_closed_at_ms` also supersedes pending `close` ops. The stall
clause handles "no close op pending" by naming `hpipe close`.

### MINOR 3: `reopen` leaves the bead `open` but assigned

`reopen` sets status `open` and leaves the assignee alone (`issueops/reopen.go:63-67`). So a
reworked task's card sits in the "open" column while it is being worked. **Fix:** follow `reopen`
with a `claim`, which succeeds for the same actor from `open` (`claim.go:91`).

### MINOR 4: Escalation un-block paths are incomplete

These leave the bead `blocked` with `hpipe:awaiting-human`:

- `answer --by orchestrator` after `escalate`;
- a rewind out of `blocked-on-decision` to a non-terminal phase. That path does not call
  `abandonDecisions`; only terminal rewinds do (`src/cli.ts:713-726`).

When the task later fails, this feeds MAJOR 1. The ordering of `abandonDecisions`'s ops against the
`failed` release in `losePane` (`tick.ts:211-213`) is also unstated.

### MINOR 5: Adopted beads can still trip the open-children guard

`--bead` refuses beads that are closed, assigned or have open `blocks` edges. It does not refuse a
bead with open `parent-child` children, such as an epic or a human-made parent. `Bd.show` without
`--include-dependents` returns only `dependent_count` (`show.go:318-325`, `types.go:1153-1162`), so
it cannot see them. The close then refuses until `--force`. **Fix:** show with
`--include-dependents` and refuse open children, or refuse `issue_type: epic`.

### MINOR 6: `dispatch.md` is missing from the §4 prompt changes

The Evidence table names `dispatch.md`, but §4's change list does not. Lines 44 and 51-55 still say:

- `gh issue view`;
- "the issue body is the brief";
- the `issue:` header line that `hpipe task` prints.

`intake.md:30` quotes that output as `issue: #<n> (filed)`. These lines render no `{{issue}}`, so
the prompts render test will not catch them.

### MINOR 7: Board pane lifecycle details

- **The startup/tick ordering claim is false.** "Boards are opened by the supervisor's tick,
  which runs after `startup.ts` has finished `clearStrayPanes`, so the two never race." The
  supervisor is a separate process that starts when its pane opens, *before* `startup.ts` calls
  `clearStrayPanes` (`src/startup.ts:177-189`). A board opened on the first tick still carries the
  manifest title `Board`, not `Board: …`, and may not be recorded yet, so it can be closed. It
  self-heals on a later tick, but the sentence is wrong. **Fix:** spare the exact manifest title
  too.
- **After a herdr restart, a board comes back as a plain shell that keeps its label.** This is a
  verified base-spec fact (`2026-09-13` spec, row at line 183). The label exemption spares that
  ghost, and its recorded pane id still exists. So the supervisor never reopens it, and the user
  sees a dead shell until they run **Open board**. **Fix:** reap boards by pid, as
  `reapGhostPanes` does for the supervisor, or have `board.ts` record its pid and treat a pane
  whose shell pid differs as missing.
- **The command repeats a known bug.** It is `exec $SHELL`, which the base spec measured as a
  silent no-op when `SHELL` is unset (row at line 205). The supervisor pane uses
  `exec "${SHELL:-/bin/sh}"` (`herdr-plugin.toml:81`). Also, Bun has no `exec`: `board.ts` will
  spawn `bv` as a child, which is fine, but should be said.

### MINOR 8: `GIT_CEILING_DIRECTORIES` is applied to `bd init` only

- **The ceiling defeats the second guard.** With the ceiling set, `git rev-parse` in
  `$STATE/beads/<slug>` cannot see an enclosing repo. So the "refuse if inside a work tree" guard
  can never fire for the dotfiles case it exists for.
- **Later spawns see the enclosing repo.** Every later `Bd` spawn and the `bv` board run with
  `cwd = <slug>` and no ceiling. bd's git probes use the `git` binary (`cmd/bd/sync_git.go:20-23`),
  and bv runs history correlation over whatever repo it finds.
- **Fix:** set the ceiling on every `bd`/`bv` spawn. Run the guard *without* the ceiling, and
  refuse or warn when it finds an enclosing work tree.

### MINOR 9: Drain placement and phase sync are underspecified

- **The drain cannot sit where the spec puts it.** "After the tick's `saveOrReapply`
  (`main.ts:375`)" is inside the per-run loop over `pickOneAdvance(runs)`. That loop never
  contains `done` or human-only runs (`tick.ts:531-541`). The drain over `done` and aborted runs
  needs its own loop, and its own `saveOrReapply` with replayable effects for `done_at_ms`,
  `attempts` and `bead_closed_at_ms`.
- **Phase sync has no defined order.** It is "also" run, outside the ordered queue. The spec does
  not say whether it runs while the queue is paused, or before or after a pending `close`.

### MINOR 10: The hpipe lock duplicates bd's own fast-fail flock (YAGNI)

Embedded bd takes an exclusive `TryLock` on `embeddeddolt/.lock` for each process and fails fast
when it is held (`cmd/bd/store_factory.go:127-140`). The kernel drops that lock when the process
dies, and an orphaned `bd` child keeps holding it. So the child-pid liveness bookkeeping in §2
guards against something bd already refuses. It also adds:

- `ps` spawns on every contended check;
- a lock-file rewrite after each spawn, with a window before the child pid is recorded.

`hpipe.lock` is still useful to queue writers instead of failing them. **Fix:** keep the pidfile
lock, and drop the child-pid liveness.

### MINOR 11: Small inaccuracies

- **Two labels for one fact.** A failed task gets both `phase:failed` (§5) and
  `hpipe:outcome=failed` (§8).
- **`setStatus(open)` after `unclaim` is redundant.** `unclaim` already sets status to `open`
  (`unclaim.go:81-83`).
- **The prefix can lose its trailing hyphen.** Truncating to 8 characters can end on `-` (e.g.
  `my-repo-x` → `my-repo-`). bd trims it (`init.go:2765`), so `project.json` would record a
  different prefix from the store's. Trim before recording.

## Pass-1 findings: resolved or not

| Pass-1 | Status |
|---|---|
| BLOCKER 1 | Resolved for hpipe-made beads; adopted parents remain (MINOR 5) |
| MAJOR 1 | Resolved; `--by orchestrator` un-block gap (MINOR 4) |
| MAJOR 2 | Mostly; `dispatch.md` missed (MINOR 6) |
| MAJOR 3, 4 | Resolved |
| MAJOR 5 | **Relabelled**: the outbox moves the window to a second save (MAJOR 3) |
| MAJOR 6 | Hang bounded; the tick still blocks on Beads work (MAJOR 5) |
| MAJOR 7 | **Not resolved**: releases fail (MAJOR 1), are filtered forever (MAJOR 2), race claims or are skipped on rewind (MAJOR 4) |
| MAJOR 8 | Mostly; restart ghosts and the race claim (MINOR 7) |
| MINOR 1 | Resolved except a stale pending close (MINOR 2) |
| MINOR 2 | Partly: `probeTarget` missing (MINOR 1) |
| MINOR 3, 5, 6, 7, 8, 9, 10, 11 | Resolved (MINOR 9's scan is over-broad; see MAJOR 2) |
| MINOR 4 | Partly: ceiling scope (MINOR 8) |

VERDICT: CLEAR
BLOCKERS: 0
MAJORS: 5
MINORS: 11
