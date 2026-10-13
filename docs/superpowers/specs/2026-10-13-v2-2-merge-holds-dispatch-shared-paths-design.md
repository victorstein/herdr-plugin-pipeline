# v2.2: before-merge checks, one-command dispatch, shared paths — design

Pass 1. Written against `1ca25eb` (v2.1.1). The owner chose what to build on 2026-10-13, from the
berean-os notes (`docs/superpowers/notes/2026-10-11-berean-os-live-run.md`, findings #5, #17, #18
and #24) and from the tag-chip trial. All three ship together as 2.2.0.

1. **Before-merge checks** (#17, #24, and the owner wait). A check only the human can make, such as a
   device test, is recorded on the ledger. The merge it guards gets no merge command, and no stall
   probe, until the human has confirmed or waived it. A run cannot reach `done` while one is owed.
2. **One-command dispatch** (#5). `hpipe dispatch --task <id>` runs the whole `dispatch, in order:`
   block itself: worktree, bootstrap, agent start, brief. `hpipe dispatch --ready` does it for every
   task that is ready.
3. **Shared paths** (#18). A repo lists in `.claude/pipeline-shared-paths` the paths that every task
   may edit at once. Those paths never hold the file lock. A conflict on one is left to the flows that
   already exist: rebase before a per-task merge, `sync` in a single-PR run.

**On-disk format.** `phases.ts` does not change, and neither does `schema_version`. Four optional
fields are added: `Task.before_merge`, `Run.before_merge`, `Run.shared_paths` and
`SupervisorPid.capabilities`. When a field is absent the code behaves as it does today. An older
release ignores all four; what that costs on a rollback is in §5.

## Evidence

| Fact | Source |
|---|---|
| In the tag-chip trial (5 tasks, single-PR, released as berean-os 1.30.0), the run sat in `ship-merge` for about 40 minutes waiting for the owner's on-device check. The supervisor sent the orchestrator a "Still working?" probe every 5 minutes (trial config; the default is 15), and nothing could record "waiting on the owner". Measured on a live run | notes, "Status (2026-10-13)" |
| #17: t1's d1 answer made the merge wait on a device check. The orchestrator planned to merge as soon as CI passed. #24: the run reached `done` with that check never made, and nothing in status or Beads said it was still owed. Measured on a live run | notes #17, #24 |
| `ship-merge` and a task's `merge` are stallable on signal `merged`, which is not actor-produced. So they get a standing nudge that never escalates: run rows every `STALL_MINUTES` (15), task rows every `TASK_STALL_MINUTES` (45) | `phases.ts:107,143,236`, `config.ts:28-36`, `main.ts:580-586` |
| `ship-merge.md` ends: "This is the last point at which a check a decision ruled 'before merge' can still be done." The single-PR design left recording such checks out of scope | `prompts/ship-merge.md:22`, single-PR design §4 |
| A per-task `merge` is a level on "PR merged". A head that moves after CI passed sends the task back to `ci`. `ship-merge` records GitHub's merge whatever the orchestrator is doing, and then goes to `done` | `machine.ts:547-561`, `machine.ts:171-182` |
| `hpipe answer` accepts only a task in `blocked-on-decision`, records the answer, and leaves delivery to the supervisor | `cli.ts:1832-1867` |
| A bead goes `closed` as soon as `merged_at_ms` is set. An escalated decision makes it `blocked` + `hpipe:awaiting-human`. Decision comments are posted once each, keyed by a marker | `bead-desired.ts:97-157` |
| `taskStallCandidates` already exempts `blocked-on-files` with live holders (#22) and `land-queue` while the slot is held | `stall.ts:148-151` |
| A confirmation is only worth the head it was given on. The plugin already pins the merge to the head CI passed on (`--match-head-commit`) | `change-prompt.ts:177-191`, `deliver.ts:554-562` |
| The dispatch block has five lines: `worktree create`, a `#` line about the JSON, the optional bootstrap, `agent start`, and `dispatch --task --pane`. For seven tasks the orchestrator scripted a loop. It broke on zsh word-splitting, and the retry parsed the JSON with inline `python3`. Measured on a live run | `unstarted.ts:137-150`, notes #5 |
| `Herdr` has no `worktree create`/`open` and no `agent start` method. Only the orchestrator's shell runs them | `herdr.ts:72-238` |
| `worktree.created`/`worktree.opened` bind a task by branch, and only while its `workspace_id` is null. The binding lands on the supervisor's next tick, not when the CLI runs | `tick.ts:430-439` |
| Outside a herdr pane, `hpipe` silently uses the `default` session's ledger | `session.ts`, project memory |
| `submit` and `batch-check` run the repo's check under a 9-minute deadline, in its own process group, because the agent's Bash call times out at 10 | `check.ts:43-78` |
| The bootstrap "must be idempotent — it can run more than once" | `README.md:105` |
| The file lock is a plain prefix test over every in-flight task's `--files`. Plan widening only ever adds | `gating.ts:27-29,115-181`, `tasks.ts:487-501,665-670` |
| t3, t6 and t7 each needed `docs/file-formats.md` (each change appended a section), so they waited on one another's full implement → review → CI → merge. Measured on a live run | notes #18, watch log 12:00Z |
| `.claude/pipeline-always-review` is read with `git show <base>:<file>`, and a glob is cut to its prefix. Cutting widens the list, which is safe for review | `review-skip.ts:126-139`, `tasks.ts:734-742` |

## Decisions

### The owner's decisions (2026-10-13)

| # | Decision |
|---|---|
| 1 | A check a decision's answer makes, `hpipe answer … --before-merge "<check>"`, is recorded on the task. The run has its own form too. The merge does not clear while a check is owed. Status, show, the board, the digest and the merge prompts say what it waits on. Stall probes pause while only the human owes something. The done notice and `abort` list what is still owed, and a run cannot reach `done` with a check owed unless the human waives it |
| 2 | `hpipe dispatch --task <id>` with no `--pane` runs every dispatch step itself and stops at the first failure. `--ready` does every ready task. `--pane` and the printed block stay as the manual fallback. The auto-mode classifier no longer sees `herdr agent start` on its own, and the owner accepts that |
| 3 | `.claude/pipeline-shared-paths` lists paths that never hold the file lock. Conflicts on them are left to the merge/rebase and `sync` flows |

### Design decisions

| Question | Decision | Why |
|---|---|---|
| What the human is called | "the human", in every text | Status, the escalation prompts and the bead comments already say it |
| The record | `BeforeMergeCheck { id, check, recorded_at, decision?, recorded_pane, resolutions[] }` on `Task.before_merge` or `Run.before_merge`. Ids are `c1`, `c2`, … across the run | One id space, so `confirm` needs only `--check c2` |
| Recording a task check | `hpipe answer … --before-merge "<check>"` (repeatable) during a decision. `hpipe hold --task <id> --before-merge "<check>"` at any other time | A decision's answer is where most checks come from, and the owner chose that shape. A per-task merge can also need the owner's check with no decision behind it (the tag-chip wait, if that run had been per-task). This is a second way to record a task check; see Open questions |
| Recording a run check | `hpipe hold --before-merge "<check>"` in a single-PR run. Refused in a per-task run | A per-task run has no merge of its own. Gating "every merge to come" would need one confirmation per task head, which is a task check in all but name |
| Where a task check gates, per-task | That task's `merge` | It is the merge that ships the task |
| Where a task check gates, single-PR | The run's `ship-merge`, not the task's landing (§1.3) | The landing slot is one at a time. Holding it for a human would stop every landing behind it, and a device check means something only on the combined build that ships |
| What counts as confirmed | A confirmation names the head it covers. It holds only while that is still the head that merges. A waiver holds whatever the head | The plugin already refuses to merge a head CI never saw (#16). A human check is the same kind of fact |
| Who confirms | `--by human` only. `--by orchestrator` is refused, and so is a worker's pane | The point is the owner's check. The orchestrator relays the human's ruling by running the command, as `answer --by human` does today |
| Outcomes | `confirm --check cN --by human`, `… --waive "<why>"`, `… --failed "<what they saw>"` | Pass, skip and fail are the three answers a human gives. A failure needs a route, or it becomes another prose promise |
| The merge command while a check is owed | Never rendered. The gate row's prompt is `before-merge.md` | The trial's lesson: a prompt that shows the command while saying "don't" makes the wrong move one paste away |
| A merge made anyway | Recorded, because it is GitHub's fact. The step after it waits: per-task `merge → close`, single-PR `ship-merge → done` | The plugin cannot un-merge. Holding the next step keeps the record true and keeps a run from reaching `done` with a check owed |
| Stall probes | Skipped while every check owed at the gate is waiting on the human. `confirm` re-arms the ladder | #22 again otherwise: probes about a wait nobody but the human can end |
| Beads | Per-task: a task held at `merge` is `blocked` + `hpipe:awaiting-human`, with a comment per check and per ruling. Single-PR: the bead still closes at landing (owner decision 3 of single-PR), and the comments carry the check | Matches how an escalated decision already shows. Closing at landing is an owner decision this design does not reopen |
| Older supervisor beside a new CLI | `answer --before-merge` and `hold` refuse while this session's live supervisor lacks the `before-merge` capability | The same reason as single-PR's `schemas` refusal: an old supervisor would hand out the merge command anyway |
| Dispatch runs where | Only in the `hpipe` CLI, in a pane of the owning session. It refuses when `HERDR_SOCKET_PATH` and `HERDR_SESSION` are both unset. Never in the supervisor | The tick is serial and a bootstrap takes minutes. A failure in the tick has nobody to read it. Outside a pane, herdr and the ledger would both be the wrong session's |
| The time limit | A 9-minute budget for the whole command, like `CHECK_DEADLINE_MS`. The bootstrap runs in its own process group under what is left. `--ready` starts a new task only while 5 minutes remain | The orchestrator's Bash call times out at 10. Killed by that timeout, the CLI says nothing and leaves the bootstrap running |
| Resume | Every step first asks whether it is already done, from herdr, git or the ledger. A re-run carries on from the first step that is not | A stop is only useful if re-running the same command is the fix |
| Unwired bootstrap (`bin/bootstrap` with no `.claude/pipeline-bootstrap`) | Not run. The step says so and names the wiring | The plugin's contract is the declared file. Running a script the repo never declared is a guess the orchestrator made by hand on berean-os (#6) |
| Shared paths: when read | Once, at `hpipe start`, from the default branch as just fetched. Stored as `Run.shared_paths` | A list that shrank mid-run could leave two tasks past the file gate on a path that locks again. Snapshots taken per task would not be symmetric |
| Shared paths: globs | Ignored, with a warning | Cutting a glob to its prefix widens the list. That is safe for always-review but unsafe here: `docs/*.md` would share all of `docs/` |
| A declared `--files` entry under a shared prefix | Still recorded and printed, marked `(shared)`. It is just not part of the lock | The record says what the task touches, and the merge and sync notes read it |

## 1. Before-merge checks

### 1.1 The record

```ts
interface Resolution {
  as: 'confirmed' | 'waived' | 'failed'
  at: number
  /** The head the ruling covers. Null for a waiver, which covers any head. */
  head: string | null
  /** Waived: why. Failed: what the human saw. */
  note?: string
  /** HERDR_PANE_ID of the command, null outside a pane: the audit trail. */
  pane: string | null
}
interface BeforeMergeCheck {
  id: string                 // c1, c2 …, one sequence across the run's task and run checks
  check: string              // what the human checks, in the orchestrator's words
  recorded_at: number
  decision?: string          // the decision whose answer carried it
  recorded_pane: string | null
  resolutions: Resolution[]  // append-only; the last one is the ruling in force
}
Task.before_merge?: BeforeMergeCheck[]
Run.before_merge?: BeforeMergeCheck[]   // single-PR only
SupervisorPid.capabilities?: string[]   // ['before-merge', 'shared-paths']; absent reads as []
```

Nothing deletes a check or a resolution: no rewind, no abort. A check whose work never ships is
**void**, which is computed, not stored (§1.4). The next id is one more than the number of checks in
the run, which only grows.

A new pure module, `src/lib/before-merge.ts`, holds every rule below. The machine, stall, status,
`desiredBead` and the CLI all read the same functions, so they cannot disagree about what is owed.

### 1.2 Recording

```
hpipe answer --task <id> --decision <id> --answer "…" --by orchestrator|human \
             [--before-merge "<check>"]... [--run <run-id>]
hpipe hold --before-merge "<check>" [--task <id>] [--run <run-id>]
```

- `--before-merge` is free text. It joins `FREE_TEXT_FLAGS` (`cli.ts:2268`) and may be repeated:
  each occurrence is one check, and commas are never split. It is read by a new `repeatedFlag()`,
  not by `listFlag`. An empty value is refused.
- `answer --before-merge` writes the answer and the checks in **one save**, and then goes on to
  deliver the answer as today. `--by orchestrator` is allowed: who settled the decision is a
  different question from who checks the merge. The check records `decision: <id>`.
- `hold` without `--task` records a run check. It is refused in a per-task run with: "a per-task run
  has no merge of its own: hold one task's merge with `--task <id>`, or put the check on the answer to
  its decision".
- Both refuse:
  - from a pane that is a worker pane of this run ("a worker raises a decision; the orchestrator
    records the check");
  - once the merge they would hold has happened. Per-task, that is when `merged_at_ms` is set ("PR #255
    is already merged"). Single-PR, it is `batch.merged_at_ms`, which is what `shippedRefusal` reads
    (`cli.ts:404-411`);
  - on a task that is already finished;
  - beside a live supervisor whose `capabilities` lack `before-merge`. The message names its pid and
    the restart step, as `start --single-pr` does (`cli.ts:245-249`).
- **A hold recorded while its gate is already open** (the task is in `merge`, or the run in
  `ship-merge`). The merge prompt has already gone out, so the CLI does two things in the same save:
  - it replaces any undelivered prompt queued for that record's current entry with `before-merge.md`;
  - it prints "t1 is in merge now: do not run the merge command you were given; the merge prompt comes
    again once c3 is confirmed".

Output: `c3 recorded on t1: PR #255 does not merge until the human confirms: <check>`. In a single-PR
run, a task check reads `c3 recorded on t1: the batch PR does not merge until the human confirms:
<check>; t1 still lands on batch/x as usual`. A run check reads `c4 recorded: the batch PR does not
merge until …`.

### 1.3 Where a check gates

| Check | Per-task run | Single-PR run |
|---|---|---|
| On a task | That task's `merge` | The run's `ship-merge`, if the task has a landing |
| On the run | — (refused) | The run's `ship-merge` |

**Why a single-PR task check holds the batch PR and not the task's landing.**

- **The slot.** One task lands at a time (`landingSlotHolder`, `gating.ts:190-193`). A landing held
  for a human holds every landing behind it, for as long as the human takes. In the trial that was 40
  minutes.
- **What is checked.** A device check of a task branch is a check of a build that never ships. The
  batch PR's head is what ships.
- **A failure.** It still has a route. A check that fails at `ship-merge` is fixed on the batch: a
  patch, or a fix task, which registration already supports from `ship-merge` (`cli.ts:369`). The new
  head is then checked again.
- **The cost.** A task check now waits for the end of the batch even when the task landed early. A
  repo that wants the check per task should run per-task.

### 1.4 When a check is owed

The **gate head** is the head the gate row will merge:

- per-task: `task.ci_head.sha`, the head CI passed on;
- single-PR: `batch.ci_head.sha`.

A check is **binding** at its gate when it is not void:

- **Per-task.** A task check is void once its task has finished without merging: `failed`,
  `blocked-on-failure`, or `orphaned` with no merge recorded.
- **Single-PR.** A task check is void when its task has no landing (`landed` is empty) by the time
  the run reaches `ship-merge`.
- **Run checks.** Never void.

The state of a binding check comes from its last resolution:

| Last resolution | Its head equals the gate head | State |
|---|---|---|
| none | — | **waiting on the human** |
| `confirmed` | yes, or no gate head is recorded | satisfied |
| `confirmed` | no | **waiting on the human**: "confirmed on 9e06c261; the head is now 5e6f7a8b" |
| `failed` | yes | **waiting on a fix**: at `ship-merge` in a single-PR run; per-task, the task is already back in `implement` (§1.6) |
| `failed` | no | **waiting on the human**: the fix is in, so check the new head |
| `waived` | — | satisfied |

Notes on the table:

- **No gate head** happens only after a manual rewind past CI. There the human chose to skip CI, so
  the confirmation is taken as given, as `pastTheCheck` does for a rewind past `batch-check`
  (`machine.ts:189-192`).
- **Owed** means waiting on the human or waiting on a fix.
- **Gate exports.** `owedAt(run, task | null)` returns the owed checks for a task's `merge` (a task)
  or for `ship-merge` (`null`). `waitsOnlyOnTheHuman(run, task | null)` is true when there are owed
  checks and every one of them is waiting on the human.

### 1.5 The gate in the machine

No new phase. The gate rows keep their signals. What changes is the prompt the row sends, and the
step after a merge.

**Per-task `merge`** (`machine.ts:547-561`):

- PR merged and nothing owed: as today. Record `merged_at_ms` and `merge_commit`, then go to `close`.
- PR merged with a check owed:
  - Record `merged_at_ms` and `merge_commit` the first time.
  - Stay in `merge`, returning the task only when the record changed, so the save happens once.
  - The history gets no entry, because no transition happened. Status says what happened (§1.8).
- Head moved after CI passed: back to `ci`, as today. The confirmation is pinned to the old head, so
  the check is owed again when the task comes back.
- The machine reads only the ledger for this. `owedAt` takes `task.ci_head`, and no git or gh call is
  added.

Code that reads `merged_at_ms` and needs to know about the hold:

- `desiredBead` (`bead-desired.ts:141`) closes the bead only when the task is not held (§1.9).
- `waitsOnClose` (`beads-sync.ts:192`) must not count a held task. Otherwise a store failure marks it
  out of sync.
- `hasLanded` (`ledger.ts:342-343`) needs no change: it requires `done` or `orphaned`, so a held task
  never counts as landed.

**Single-PR `ship-merge`** (`machine.ts:171-182`):

- PR merged and nothing owed: as today. Record the batch merge and go to `done`.
- PR merged with a check owed: record `batch.merged_at_ms` and `batch.merge_commit` once, and stay in
  `ship-merge`. On every later tick the row first asks whether the merge is recorded, so the head
  rules below never fire on a merged PR.
- PR not merged: the head rules stay as they are.

**The prompt.** Two render sites choose between the gate's own prompt and the hold:

- `renderTaskPhasePrompt` (`tasks.ts:195-198`) for `merge`;
- `shipPrompt` (`deliver.ts:569-576`) for `ship-merge`.

When `owedAt` is non-empty they render `prompts/before-merge.md`; otherwise the gate's own prompt
(`merge.md`, `merge-batch.md` or `ship-merge.md`). So the merge command is rendered only when nothing
is owed. `merge-batch.md` (single-PR landing) never sees a hold, because single-PR checks gate
`ship-merge`, not the landing.

`before-merge.md`, to the orchestrator:

```
# Hold — {{subject}} waits on the human before it merges

{{subject_line}} is ready to merge {{green}}, but it waits on the human for:

{{checks}}                  ← one line per owed check: id, text, task, "confirmed on X; head now Y" when stale

Tell the human once, in a message of its own (never bundled with another question), what to check
and on which build: {{build}}. Then end your turn. No stall probe comes while you wait.

When they answer, record it:

    {{hpipe}} confirm --check <id> --by human                    # they checked it, and it holds
    {{hpipe}} confirm --check <id> --by human --waive "<why>"    # they chose to skip it
    {{hpipe}} confirm --check <id> --by human --failed "<what they saw>"

Do not merge, and do not ask again because a digest lists it. The merge command comes as its own
prompt once nothing is owed. {{failed_route}}
```

`{{build}}` names the head the human checks:

- per-task: `PR #255 at 9e06c261, the head CI passed on`;
- single-PR: `` `batch/x` at 1a2b3c4d: `git -C '<checkout>' pull --ff-only` in the batch checkout ``,
  with the bootstrap line from `checkoutSteps` (`batch.ts:48`).

`{{failed_route}}` is empty unless a check is waiting on a fix, in which case it names the routes in
§1.6.

`ship-merge.md:22` ("This is the last point …") is replaced by `{{before_merge}}`. That is empty for a
run with no checks, and otherwise reads: "Before merge: c2 confirmed by the human on 1a2b3c4d; c1 (t1)
waived: <why>."

### 1.6 Resolving: `hpipe confirm`

```
hpipe confirm --check <id> --by human [--waive "<why>" | --failed "<what they saw>"] [--run <run-id>]
```

The rules, in the order the command applies them:

- `--by` must be `human`. Anything else gets: "only the human confirms a before-merge check: `--by
  human` once they have made it, or `--by human --waive "<why>"` if they choose to skip it".
- It is refused from a worker pane of the run.
- `--waive` and `--failed` take text, cannot be empty, and cannot be given together.
- Each resolution records `pane: HERDR_PANE_ID`.
- **The head a confirmation covers.**
  - It is the head the pipeline is judging now: per-task `task.ci_head.sha` while the task is in `ci`
    or `merge`, single-PR `batch.ci_head.sha` while the run is in `ship-ci` or `ship-merge`.
  - Otherwise it is the branch head on origin, read with `remoteBranchHead`: the task branch per-task,
    the batch single-PR.
  - Either way the branch head is read live, and if it differs from the judged head the command is
    refused: "`batch/x` is at 5e6f7a8b, not 1a2b3c4d, the head CI passed on: a check of 1a2b3c4d does
    not cover it; wait for the next prompt". If it cannot be read, the command is refused too: it
    fails closed. `--waive` reads nothing.
  - Once the merge is recorded (a merge made while held, §1.5), the live read is skipped. The
    judged head is what merged, and GitHub may already have deleted the branch, which would read as
    "moved".
- **A confirmation before the gate is accepted**, for example while CI runs. It says so: "confirmed on
  9e06c261; t1 is in pr-review, so if its head moves before it merges, c1 is owed again".
- **When the last owed check at an open gate is satisfied**, the same save does two things:
  - it queues the gate's normal prompt for the orchestrator (`merge.md` / `ship-merge.md`), replacing an
    undelivered `before-merge.md`;
  - it re-arms that record's stall ladder (`freshLadder`, `unstarted.ts:217`), so the first merge
    probe comes a full threshold after the merge prompt and not on the next tick.

  It prints "nothing more is owed before t1 merges; its merge prompt is queued for you". When the merge
  is already recorded, nothing is queued: the next tick moves the record on (`close`, or `done`), and
  the ladder is re-armed all the same.

`--failed`:

- **Per-task, the PR not merged.** In the same save the task goes `merge → implement`:
  - `head_sha_at_entry` is set to the gate head, so `implement` waits for a new push;
  - the history reads "the human's before-merge check c1 failed: <what>";
  - a new worker prompt, `prompts/check-failed.md`, is queued. It works like `ci-red.md`: what the
    human saw, the check's text and decision, then the implementer's brief. It is rendered through
    `renderTaskPhasePrompt` with `cameFrom: 'merge'`.
  - A paneless worker is handled as `owePhasePrompt` handles one (`cli.ts:1060-1090`).
  - No counter is bumped: every lap needs a human ruling, as a rewind does.
- **Single-PR, the PR not merged.** The run stays in `ship-merge`, and the check is waiting on a fix.
  The CLI prints both routes `ship-ci-red.md` already has: a subagent's patch in the batch checkout and
  then `batch-check`, or a fix task through `hpipe task …`. Either one moves the head, so the check
  waits on the human again, on the new head.
- **Either mode, the PR already merged.** Refused: "PR #255 is already merged: the fix is a new task.
  Record this ruling with `--waive "failed on device; fixed by <task>"` so the run can finish." A
  per-task held task then closes, and the follow-up gets its own check with `hold --task`.

**How the orchestrator relays the human.** The human answers in the orchestrator's pane, or anywhere
else the orchestrator reads, and the orchestrator runs `confirm`. The human may also run it from their
own pane; `pane` records which. The plugin cannot prove that a human said it. The trust is the same as
`answer --by human` today, and a human-only channel (a herdr action) is an open question.

### 1.7 The stall ladder

- **Tasks.** `taskStallCandidates` (`stall.ts:136-162`) skips a per-task task in `merge` when
  `waitsOnlyOnTheHuman(run, task)` is true. It sits beside the `blocked-on-files` and `land-queue`
  exemptions.
- **Runs.** `stallCandidates` (`stall.ts:105-117`) skips a single-PR run in `ship-merge` when
  `waitsOnlyOnTheHuman(run, null)` is true.
- **What skipping means.** No candidate is made, so no rung is climbed and nothing is recorded. Both
  rows are standing nudges that never escalate, so no escalation path is lost.
- **A check waiting on a fix is not skipped.** That is the orchestrator's move. `shipClause`'s
  `ship-merge` case (`stall.ts:456-464`) gets a form naming the failed check and both routes.
- **When the hold lifts,** `confirm` re-arms the ladder (§1.6).
- **No reminder reaches anyone while the human holds the merge.** Status and the digest footer list the
  wait; whether a slow reminder is wanted is an open question.

### 1.8 What the orchestrator and the human see

**`hpipe status`.** The heading "waiting on the human:" is new. It sits under "waiting on you:",
uses the same line shape, and its lines are not repeated under "waiting on you".

```
t1 feat/ghost berean-o-1 [merge 34m] standard agent:idle PR #255 ci:pass — waiting on the human (c1)
  before merge: c1 (t1) the reader shows no ghost after a page turn — waiting on the human · c2 … — confirmed on 1a2b3c4d
  waiting on the human:
    c1 t1 [merge 34m] — the reader shows no ghost after a page turn (from d1), on PR #255 at 9e06c261 — once
       they answer: `hpipe confirm --check c1 --by human` (or --waive / --failed)
```

- **Clause wording.** `moveFor` (`status.ts:180-280`) gives a held task `waitsOnYou: false` and the
  clause `waiting on the human (c1)`.
- **A merge recorded while held** adds a ⚠ line: `⚠ t1: PR #255 merged before the human confirmed c1
  — it waits in merge until c1 is confirmed or waived`.
- **The run header** gets a `before merge:` line whenever the run has any check, in either mode, with
  each check and its state.
- **`shipLines`** (`status.ts:600-613`) in a held `ship-merge` replaces "YOUR move: squash-merge …"
  with the human's line. A check waiting on a fix is a "YOUR move" with the routes.
- **A run that ends with a check still owed.** This can only happen through `abort` or
  `rewind <run> done`, and `finishedRunSummary` prints `⚠ ended with c2 still owed to the human:
  <check>`.

**`hpipe show --task`.** One `before merge:` line per check, after `decision:`:

```
before merge: c1 the reader shows no ghost after a page turn (from d1) — waiting on the human
              c3 the menu closes on a long press — confirmed by the human on 9e06c261, 3m ago
```

The other states read `— waived by the human 5m ago: <why>`, `— failed on 9e06c261, 8m ago: <what>;
the human checks the next head`, and `— not needed: t5 never merged`.

**The digest.** `parkedFooter` (`tick.ts:195-212`) gets the same "waiting on the human:" block after
"also waiting on you:". It reminds the orchestrator that the merge is held on purpose, and
`before-merge.md` tells it this is no cue to ask again. A task entering `merge` held gets the hold
prompt as its digest body.

**The answer to the worker.** `answer.md` gains `{{before_merge}}`, supplied at its one render site
(`tasks.ts:890-895`). It reads: "Before this merges, the human will check: <check>. Make it
checkable: say in the PR how to check it." In a single-PR run, "the PR" becomes "an empty commit on
the branch", the same `reply_place` used elsewhere.

**The `done` notice** (`deliver.ts:646-675`, `907-917`) gains a `before merge:` line:

```
before merge: c1 (t1) confirmed by the human on 9e06c261 · c2 waived by the human: release window · c3 (t5) not needed: t5 never merged
```

**`hpipe abort`** (`cli.ts:2125-2153`) prints, without refusing: `still owed to the human: c1 (t1)
<check> — PR #255 is not merged`. A held task whose PR merged reads `— PR #255 merged before it was
confirmed`; a single-PR run reads `— the batch PR is not merged`. `resume` brings every check back as
it was.

**Prompts that teach the record.**

- `decision.md` "Either way, record the answer": "If the answer makes the merge wait on something only
  the human can check (a device test, a look at the UI), add `--before-merge "<what they check>"`:
  the merge is held until they confirm it. Not for anything you or the worker can verify — put that in
  the answer."
- `intake.md` step 0 and `ship.md` step 1: "If the user wants to check the work themselves before it
  merges, record it as soon as you know: `hpipe hold --before-merge "<check>"` (single-PR) or
  `hpipe hold --task <id> …`."

### 1.9 Beads

`desiredBead` (`bead-desired.ts:130-158`):

- **Per-task task held at `merge`.** A task is held when it is per-task, in `merge`, and has owed
  checks, merged or not. Its bead is `blocked`, assigned to `hpipe`, with labels `[merge,
  hpipe:awaiting-human]`. This is the escalated-decision row; the `closed` row now applies only when
  the task is not held.
- **Comments.** `decisionComments` becomes `taskComments` and adds two kinds, using the existing
  marker shape:
  - when a check is recorded: `[hpipe t1/c1/before-merge]` with "Before merge, the human checks:
    <check> (from d1)";
  - for each ruling: `[hpipe t1/c1/r<n>]` with "Confirmed by the human on 9e06c261", "Waived by the
    human: <why>", or "Failed on 9e06c261: <what>".
- **Single-PR task checks.** They get the same comments on a bead that closed at landing. Whether bd
  takes a comment on a closed bead is Verify 5.
- **Run checks.** They have no bead and show only in status and the notices.

## 2. One-command dispatch

### 2.1 CLI surface

```
hpipe dispatch --task <id> [--run <run-id>]                    # every step, as needed
hpipe dispatch --task <id> --pane <pane-id> [--run <run-id>]   # the brief only, as today
hpipe dispatch --ready [--run <run-id>]                         # every ready task, one after another
hpipe dispatch --done [--run <run-id>]
```

- The argv rule at `cli.ts:2315` becomes "exactly one of `--done`, `--task` and `--ready`".
- `--ready` joins `VALUELESS_FLAGS`.
- `USAGE.dispatch` lists all four forms.
- Exit 0 only when every task it set out to dispatch was dispatched.

Which tasks the one command takes:

- **(a)** A task in its briefed phase (`research`) that is owed its brief (`unbriefedWorker`,
  `unstarted.ts:51-55`). This is what the printed block dispatches. `--ready` takes these, in
  `task_id` order.
- **(b)** A task on a worker row with no pane whose phase prompt is already queued for a fresh agent:
  after a rewind (`owePhasePrompt`), or a paneless `sync` (`queueForAFreshAgent`). The command runs
  steps 1–3 and leaves the handoff to the courier, which already sends the queued entry when the agent
  is detected. `--ready` does not take these: a recovery is one deliberate command.
- **Anything else is refused,** naming why:
  - `queued`: "waiting on t1";
  - a task with a briefed worker: "its worker has the brief";
  - a row with no worker: "t4 is in merge, which needs no worker".

### 2.2 The steps

A new module, `src/lib/dispatch-steps.ts`, runs the steps over injected dependencies: herdr, git, the
bootstrap runner, the brief step and a clock. `cmdDispatchSteps` wires the real ones. Each step asks
first whether it is already done.

| # | Step | Already done when | Otherwise |
|---|---|---|---|
| 0 | **base** | — | `freshDispatchBase(repo_root, dependencyMerges(task), batch)` (`dispatch-base.ts:223`). A fetch error stops here. For a (b) task, this step and step 1's create are skipped when a checkout exists |
| 1 | **worktree** | (i) `task.workspace_id` is bound and `herdr pane list --workspace` lists it, or (ii) this command's own record (below) names a live workspace | (iii) `git worktree list --porcelain` shows a checkout on `refs/heads/<branch>`: `herdr worktree open --cwd <repo_root> --branch <branch>`. (iv) None: if `refs/heads/<branch>` exists and does not contain the base, stop ("`<branch>` already exists at 3c4d5e6f and does not contain the base 1fb8a43c: it is not this task's; rename the task's branch or delete it"). Then `herdr worktree create --cwd <repo_root> --branch <branch> --base <commit>`, reading the workspace id, `.result.root_pane.pane_id` and `.result.worktree.path` from its JSON |
| 2 | **bootstrap** | An agent is already in the root pane | `repoBootstrap(repo_root)` (`bootstrap.ts:36`). `ready`: run `./.claude/pipeline-bootstrap` from the checkout, under the budget (§2.3). Output goes to `<stateDir>/runs/<session>/<run_id>.dispatch/<task>-bootstrap.log`, and the last 40 lines are printed on failure. `none`: skipped, and a repo with an unwired script gets a hint. A script missing from the new checkout is skipped with a note, as `dispatch.md` says today. Not executable in the checkout: stop, with the `chmod +x` hint |
| 3 | **agent** | `pane list` shows an agent in the root pane (`!paneHasNoAgent`, `herdr.ts:25`) | `herdr agent start <bead> --kind claude --pane <pane> -- --dangerously-skip-permissions --effort <WORKER_EFFORT[tier]>`, the same line `startAgentCommand` prints (`unstarted.ts:107-110`), under a 90 s hpipe-side deadline. herdr returns once the agent is ready |
| 4 | **brief** | (a): the task is no longer `awaiting_brief`, or the agent reads `working` (the brief landed; the pane is recorded). (b): always, because the courier owns it | (a): `cmdDispatchTask`'s body, unchanged from the usage-limit read on (`cli.ts:950-992`): claim, render, `agentPromptConfirmed` (30 s, `--until working`), record the pane. Before sending, the input box is read (`inputBoxText(withoutFaintText(…))`, `screen.ts:20`). Text in it stops the step ("the input box of w5:p1 holds text, perhaps an earlier brief: `herdr pane read w5:p1`; if it is the brief and the agent is idle, `herdr agent send-keys w5:p1 ctrl+c`, then run this again") |

**Why step 4 reads the box.** The manual path's rule after an uncertain send is "`herdr pane read`
before retrying — a retry sends the brief twice" (`cli.ts:974-982`). A re-run that resends blindly
would break that rule. The worker cannot have finished a research phase in the seconds since, so these
three cases cover it:

- the box holds the brief: it is unsubmitted;
- the agent is working: the brief landed;
- the box is empty and the agent is idle: the brief never arrived, and sending is safe.

**The command's own record.** `<stateDir>/runs/<session>/<run_id>.dispatch/<task>.json` holds `{
workspace_id, root_pane, checkout, at }`. It is written as soon as step 1 succeeds. It covers the
second between `worktree create` and the supervisor binding the workspace on its next tick. Without
it, a re-run in that second would find the checkout in git and `worktree open` it a second time. The
ledger is not used for this: the hook already owns `workspace_id`, and two writers of one field race.

**A lock.** `<task>.lock` is created with `O_EXCL` and holds the pid. It is removed on exit, and a
lock whose pid is dead is taken over. A second `dispatch --task t1` while one runs is refused: "t1 is
being dispatched by pid 4242". The manual `--pane` form takes the same lock.

**Output.** One line per step, then a verdict:

```
t1 feat/reader-menu (berean-o-1) — standard, worker effort high
  base       1fb8a43c (origin/main as just fetched)
  worktree   created w5 at /Users/x/.herdr/worktrees/berean-os/feat-reader-menu, pane w5:p1
  bootstrap  ./.claude/pipeline-bootstrap passed in 41s (log: …/t1-bootstrap.log)
  agent      started berean-o-1 in w5:p1 (--effort high)
  brief      claimed berean-o-1; delivered to w5:p1, and the worker is working on it
dispatched t1
```

A skipped step reads `worktree   w5 at /…/feat-reader-menu exists (pane w5:p1) — skipped`. A
failure reads:

```
  bootstrap  FAILED: exit 1 after 12s; the last 40 lines of …/t1-bootstrap.log:
             …
stopped t1 at bootstrap. Fix what it names, then run `hpipe dispatch --task t1` again: it keeps the
worktree and runs the bootstrap again.
```

### 2.3 The time budget

- **One budget for the whole command:** `DISPATCH_BUDGET_MS = 9 min`. The 9 has the same reason as
  `CHECK_DEADLINE_MS`.
- **The bootstrap's deadline** is the budget left minus 2 minutes kept for steps 3–4. The bootstrap
  runs in its own process group (the `runCheck` runner, generalised to `runScript(checkout, rel,
  logPath, deadlineMs)`). At the deadline the whole group is killed and the step fails: "did not finish
  within 6m 40s and was stopped, with everything it started".
- **`--ready` starts a task** only while at least 5 minutes remain. Otherwise it stops: "dispatched t1,
  t2, t3; not started: t4–t7, to stay inside the 10-minute Bash timeout — run `hpipe dispatch --ready`
  again". Tasks already dispatched are skipped on the re-run.
- **Every prompt that names the command** says to give the Bash call a 10-minute timeout, as `sync.md`
  does for `submit`.
- **A bootstrap that never fits** (longer than about 7 minutes) is the manual block's job. The
  orchestrator runs the block's bootstrap line in the background, as any long command, then the block's
  `herdr agent start` line, then `hpipe dispatch --task <id>`. That run finds an agent in the pane, so
  it skips the bootstrap and only hands over the brief. Re-running a slow bootstrap on every resume is
  Open question 7.

### 2.4 Failures, and how to resume

| Stops at | Typical cause | What the message says | A re-run |
|---|---|---|---|
| base | origin unreachable | the fetch error | starts again |
| worktree | the branch exists at an unrelated commit; herdr refuses (`--cwd` not a repo, path taken) | the herdr code and message, or the branch refusal | starts again |
| bootstrap | exit ≠ 0, or killed at the deadline | the log tail | keeps the worktree and runs the bootstrap again |
| agent | `agent_not_ready` (a folder-trust dialog on a new path — seen once on the orchestrator's own start, `2026-09-24-live-smoke-run.md:31`); a name already taken after a rewind; the 90 s deadline | the code, and `herdr pane read <pane>` | skips worktree and bootstrap once an agent is in the pane, otherwise starts the agent again |
| brief | bd refuses the claim; usage limit; `agent_prompt_stalled`/`timeout`; text in the box | as `cmdDispatchTask` says today, plus the box case | the box rule in §2.2 decides whether it sends |

`--ready` stops at the first failure too. A bootstrap that fails one way usually fails the same way for
every task, and running it N times costs N bootstraps. The final line names what was dispatched, where
it stopped, and what was not started.

**`invalid_agent_argument`** cannot come from step 3: the brief never rides on `agent start`, and the
line carries only the bead id and fixed flags. It is still shown verbatim if herdr returns it.

### 2.5 What the orchestrator and the skill now say

- **`hpipe task`** (`cli.ts:745-772`) and the supervisor's `Dispatch tN` prompt (`tasks.ts:380-388`)
  print one new line above the block: `dispatch: hpipe dispatch --task t1 — runs the steps below and
  stops at the first failure; the block is the manual fallback`. Both keep the `base:` line, the
  block and the brief.
- **`dispatch.md`.** "When you are told a task is ready" becomes: run `hpipe dispatch --ready` (or
  `--task <id>`) with a 10-minute Bash timeout, read its step lines, and on a stop fix what it names
  and run it again. The manual block follows, under "If you must do it by hand". The facts stay with
  it, condensed: the base, never putting the brief on `agent start`, emptying the input box, `--cwd`,
  bootstrapping.
- **`intake.md` step 4.** "run the block as printed" becomes "dispatch it: `hpipe dispatch --task
  <id>` now, or register every task and then `hpipe dispatch --ready`". Its "`base:` commit is fixed
  when it is registered" becomes "when it is dispatched": the one command fetches at dispatch, which is
  later and fresher.
- **Advice texts lead with the command and keep the recipe.** `remainingDispatchSteps`,
  `startWorkerCommand`, `dispatchWorkerCommand` and `briefCommand` (`unstarted.ts:57-254`) are read by
  status, stall and rewind. The recipe stays for when the command stops.
- **SKILL.md.**
  - "Running a batch" step 3 is the one command, with the block as fallback.
  - The ground rule lists `hpipe` as the one permission dispatch needs.
  - Recovery gains "`hpipe dispatch` stopped at <step>: fix what it names, run it again".
- **README.** "Use" says `hpipe dispatch --task`/`--ready`, with `--pane` and the block described as
  the fallback. **Permissions** gains this paragraph:

  > `hpipe dispatch` runs `herdr worktree create` and `herdr agent start … --dangerously-skip-permissions`
  > itself, so allowing `hpipe` allows starting workers that skip permissions, and auto mode's classifier
  > sees only `hpipe dispatch --task t1`, never the `agent start` inside it. `herdr worktree create` and
  > `herdr agent start` are needed only for the manual fallback.

## 3. Shared paths

### 3.1 The file

`.claude/pipeline-shared-paths`, at the repo root on the default branch:

- One path prefix per line, `#` to end of line is a comment, and blank lines are skipped.
- Leading `./` and `/` are stripped, as in `alwaysReviewPrefixes`.
- A line with a glob character (`*?[{`) is **ignored**, and so is a line that comes out empty (`/`,
  `.`, which would share the whole repo). `start` warns about each one.
- Prefixes are plain prefixes, as `--files` are: `docs/file-formats` also matches
  `docs/file-formats-old/x`.

`SHARED_PATHS_REL` and `sharedPathPrefixes(text): { prefixes, ignored }` live in a new
`src/lib/shared-paths.ts`.

### 3.2 When it is read

**Once, at `hpipe start`.** `cmdStart` reads the file with `fileAt(repo_root, <commit>,
SHARED_PATHS_REL)` (`sync-walk.ts:98`):

- the commit is `freshDispatchBase(repo_root, [], null)`'s commit for a per-task run;
- for a single-PR run it is the default branch commit `planBatch` already fetched, which is the batch
  branch's base.

The result is stored:

```ts
interface SharedPaths { prefixes: string[]; ignored: string[]; commit: string | null; ref: string; read_at: number; error?: string }
Run.shared_paths?: SharedPaths    // absent: no shared paths, today's behaviour
```

- **A failed read** stores `error` and no prefixes, and `start` warns. Locking everything is today's
  behaviour, and that is the safe side.
- **A failed fetch** for a per-task run reads the stale commit and says "may be stale".
- **`start` is never refused** over this file.

**Why a snapshot.**

- **Shrinking.** If a path is removed from the list mid-run while two tasks are past the file gate
  editing it, they are now both "holding" a locking path. That breaks the invariant the single-PR
  design leans on: two overlapping tasks are never both past `blocked-on-files` (single-PR design
  §3).
- **Per-registration reads.** A list read per registration would let t1 treat a path as locking and t2
  as shared, so the overlap test would stop being symmetric.
- **Adding is safe but not offered.** Adding a path mid-run could only release waiting tasks, which is
  what sharing means. An add-only refresh is an open question.

**A file changed mid-run** takes effect at the next `start`. Status names the snapshot's commit so
that this is visible. The file itself is an ordinary path: it is not implicitly shared, and a task
declaring it locks it. `reviewCall` (`review-skip.ts:161`) adds it beside `ALWAYS_REVIEW_REL`: an edit
to it is always reviewed, because it changes how every later run locks.

### 3.3 The lock

`lockingFiles(run, task) = task.files` without every entry that starts with a shared prefix. An entry
broader than a shared prefix (`docs/` when `docs/file-formats.md` is shared) still locks: it claims the
rest of `docs/`. Every overlap test runs on locking files. Signatures change so that the type checker
finds every call site, and so the gate and the texts that describe it cannot disagree:

| Function | Change | Call sites |
|---|---|---|
| `fileHolders(task, all)` | → `fileHolders(run, task)` | `status.ts:257,417`, `bead-desired.ts:93`, `stall.ts:127`, `tick.ts:148` |
| `filesClearFor`, `releasableFromFiles(all)` | → `(run, …)`; the released-set check overlaps on locking files too | `tasks.ts:667` |
| `filesOverlap` | unchanged (pure prefixes); callers pass locking files | `cli.ts:777` (`overlapNote`) |

- **Widening.** `widenFromPlan` (`tasks.ts:487-501`) still adds shared entries to `task.files`. Its
  log line marks them: `plan widened files by docs/file-formats.md (shared, not locking)`.
- **A task with only shared entries** locks nothing, so it passes `blocked-on-files` on arrival.

### 3.4 Conflicts on a shared path

Two tasks now edit one file at once, so a conflict there is expected, not a sign that `--files` was
wrong. The existing flows resolve it. Three prompts get a `{{shared_note}}`. It is supplied once, by
`changePromptVars` (`change-prompt.ts:121`), which every task render site spreads, and by
`mergePromptVars`/`syncPromptVars`. It is empty when the task declares no shared path.

| Prompt | Note | Why |
|---|---|---|
| `implement.md` | "`docs/file-formats.md` is shared: other tasks edit it at the same time. Keep your change to it self-contained — add your own section, never reflow or reorder anyone else's — so a merge stays mechanical." | Stops conflicts before they happen |
| `merge.md` (per-task) | "This task declares the shared `docs/file-formats.md`, and t6 (merged) declares it too, so this PR may conflict there. Rebase onto the default branch and keep both sides' additions; CI runs again on the rebased head." | The merge prompt's generic rebase advice (`merge.md:5-8`) now has a named likely cause. The orchestrator resolves it, CI checks it, and no review sees it. That is per-task's existing stance on a rebase at merge |
| `sync.md` (single-PR) | "`docs/file-formats.md` is shared, so a conflict there is expected: keep both sides' additions." | The resolution makes the sync dirty, so it goes through review (single-PR §3). That cost is accepted: a review pass instead of waiting through another task's whole route |

`merge-batch.md` gets no note: a landing is a fast-forward, with nothing to resolve.

**A `merge=union` attribute** in `.gitattributes` would let git take both sides of an append-only
file with no conflict. A single-PR sync would then stay clean, and a rebase automatic. The README
suggests it for append-only files only, since union can interleave lines. Whether `git merge-tree
--write-tree` and GitHub honour it is Verify 6, and the design does not depend on it.

### 3.5 What shows

- **`start`.** `shared: docs/file-formats.md, CHANGELOG.md — from .claude/pipeline-shared-paths at
  1fb8a43c (origin/main as just fetched); never locked`, plus a `⚠` per ignored line. With no file it
  prints nothing.
- **`hpipe task`.** `files: src/reader/, docs/file-formats.md (shared)`. `overlapNote` names only
  locking overlaps.
- **`hpipe show`.** `files:      src/reader/, docs/file-formats.md (shared)`.
- **`hpipe status`.** The run header gets `shared: docs/file-formats.md (from 1fb8a43c)` when the list
  is non-empty. Blocked-on-files lines are unchanged, but are computed on locking files only.
- **Beads.** `blockerBeads` follows `fileHolders`, so no blocker edge is drawn for a shared-only
  overlap.

## 4. Testing

### Unit

| File | Covers |
|---|---|
| `before-merge.test.ts` (new) | Binding sets per mode. Void per mode: per-task `failed` and unmerged `orphaned`; single-PR no landing, including a task that landed and was then abandoned, which stays binding. Each row of the §1.4 table. A gate head absent after a rewind. `waitsOnlyOnTheHuman` with a check waiting on a fix |
| `machine-task.test.ts` | Per-task `merge`: merged and owed records the merge once and stays; then resolved goes to `close`; a moved head goes to `ci` with the check owed again on re-entry |
| `machine-ship.test.ts` | `ship-merge`: merged and owed records once and stays, and later ticks do not apply the head rules; resolved goes to `done`; a fix-task landing moves the gate head and re-owes a confirmation |
| `stall.test.ts` | No candidate for a held `merge` or `ship-merge`, however long it is open. A candidate for a check waiting on a fix, with its clause. A candidate once nothing is owed. The ladder re-armed by `confirm` probes one full threshold later |
| `cli-commands.test.ts` | `answer --before-merge`: repeated, empty refused, one save, `--by orchestrator` allowed. `hold`: task and run; refused per-task without `--task`, after the merge, from a worker pane, beside a supervisor without the capability; at an open gate it replaces the queued merge prompt. `confirm`: `--by` other than human refused; worker pane refused; the head chosen; a moved branch refused; a failed read refused; `--waive` with no head; `--failed` per-task to `implement` with `check-failed` queued and no counter; single-PR stays; after a merge refused; the last resolution queues the gate prompt and re-arms the ladder. `abort` lists what is owed |
| `status.test.ts` | Every line in §1.8. Both `files:` lines and the `shared:` header in §3.5 |
| `bead-desired.test.ts` | A held per-task task is `blocked` + awaiting-human, merged or not, with no `closed`. The comment markers. `waitsOnClose` ignores a held task |
| `deliver.test.ts`, `tasks.test.ts` | The gate prompt is `before-merge.md` while owed and the normal one after; `{{before_merge}}` in `ship-merge.md`; the done notice line |
| `prompts.test.ts` | `before-merge` and `check-failed` declared; every edited prompt renders in both modes with no unresolved token (`answer`, `merge`, `ship-merge`, `sync`, `implement`, `dispatch`, `intake`, `decision`, `ship`) |
| `dispatch-steps.test.ts` (new) | Fresh: all four steps in order. Resume from each stop. Each "already done" rule, including the record file and a bound workspace. The branch-exists refusal. The box rule (text, working, empty+idle). The (b) path skipping step 4. `--ready` order, its budget stop, stop at first failure. The lock and a stale lock. Refusal outside a herdr pane |
| `herdr.test.ts` | `worktreeCreate`/`worktreeOpen`/`agentStart` read the envelope from stdout or stderr (`herdr.ts:97-107`); the agent-start deadline |
| `cli-argv.test.ts` | The four `dispatch` forms; `--ready` with `--task` refused; free-text `--before-merge`/`--waive`/`--failed` |
| real git, temp dir | `git worktree list` detection; the existing-branch refusal; `start` reading the shared file at the fetched commit, a missing file, and an unreadable ref |
| `shared-paths.test.ts` (new) | The parser: comments, blanks, globs and empty prefixes ignored, normalisation |
| `gating.test.ts` | `lockingFiles`. Shared-only overlap does not hold; a broader prefix still does. `releasableFromFiles` with shared entries. Symmetry |
| `unstarted.test.ts`, `stall.test.ts` | Advice texts lead with `hpipe dispatch --task` and keep the recipe |

### Wiring tests

Two of the changes touch gating, so each gets a wiring test in the shape of
`single-pr-wiring.test.ts`: a real ledger in a temp state dir, the real CLI functions, and the
supervisor's real step functions (`advanceTasks`, `evaluateRun`, `stallCandidates`,
`taskStallCandidates`, `applyStalls`). Only herdr, gh and Beads are faked.

- **`before-merge-wiring.test.ts`.**
  - Per-task. A task answered with `--before-merge` reaches `merge`. The orchestrator's prompt is the
    hold. With the clock moved past three `TASK_STALL_MINUTES`, `applyStalls` sends nothing. The fake
    gh reports the PR merged, and the task stays in `merge` with its merge recorded. `cmdConfirm` queues
    nothing (the PR is merged) and the next tick goes `merge → close`.
  - Single-PR. `cmdHold` in intake. The run reaches `ship-merge` with the hold prompt.
    `cmdConfirm --failed` keeps it. A push moves the gate head, so the check waits on the human again.
    `cmdConfirm` queues `ship-merge.md`, and the merge lands the run in `done`.
- **`shared-paths-wiring.test.ts`.** `cmdStart` on a temp repo whose bare origin carries the file.
  Then three `cmdTask`s:
  - t1 and t2 share only the listed path, and both reach `implement` on the same tick;
  - t3 overlaps t1 on a locking path and waits;
  - `formatStatus` and `formatTaskDetail` agree with the gate.

Dispatch changes no gating, so its unit tests drive the step runner. The live smoke run is where herdr
proves it.

### Live smoke (`victorstein/hpipe-smoke`, a fresh `pipesmokeN` session)

New runbook sections. Set `STALL_MINUTES=2` and `TASK_STALL_MINUTES=3` in the plugin's `config.env`,
so a probe that should not come would come within minutes.

- **§11 Before-merge checks.**
  - **Old supervisor.** With the previous release's supervisor running, `hold` is refused, naming its
    pid. Restart it.
  - **Per-task.**
    - A task whose decision is answered with `--before-merge` reaches `merge`. The orchestrator gets
      the hold prompt, with no `gh pr merge` in it.
    - Status shows "waiting on the human". The bead is `blocked` + `hpipe:awaiting-human` with the
      comment.
    - No probe comes for 10 minutes.
    - `confirm` → the merge prompt within a tick. The first probe comes no sooner than one threshold
      later.
    - Push to the branch after confirming: the task goes `merge → ci`, and comes back held, with "confirmed
      on X; the head is now Y".
    - `--failed`: the worker pane gets `check-failed`, then fix, review, CI, and the hold again.
    - Merge the PR by hand while held: the task stays in `merge`, status shows the ⚠ line, and the bead
      stays open. `--waive` → `close → done`.
  - **Single-PR.**
    - `hold` at intake. `ship-merge` is held, with no probes. Confirm during `ship-ci`: it holds when CI
      passes on that head.
    - `abort` on a held throwaway run lists the check.
- **§12 One-command dispatch.**
  - Three tasks, `hpipe dispatch --ready`: four step lines each, one pane per workspace, briefs
    confirmed, every task bound within a tick.
  - A bootstrap that exits 1 stops at step 2; fix it and re-run, and the worktree is skipped.
  - A second `dispatch --task` during the first is refused by the lock.
  - Close the agent's pane between steps 3 and 4 (start it with a slow bootstrap to have time): the
    re-run starts a new agent.
  - A pre-existing branch that lacks the base is refused.
  - From a plain terminal, the command is refused.
  - With auto mode on, `hpipe dispatch` needs no separate `herdr agent start` approval. Record it.
  - Recovery (b): close a worker's pane, `rewind … implement`, then `hpipe dispatch --task`. Steps 1–3
    run, and the queued brief and prompt arrive on their own.
  - **Record:** the worktree create response JSON, verbatim (Verify 1).
- **§13 Shared paths.**
  - `.claude/pipeline-shared-paths` on `main` lists `docs/registry.md`, plus a glob line. `start`
    prints the `shared:` line and the glob warning.
  - t1 and t2 declare `docs/registry.md` with disjoint code, and both implement at once. t3 overlaps a
    locking path and waits.
  - Per-task: t2's merge prompt names the shared path and t1, and the orchestrator rebases and resolves.
  - In a single-PR run, the second landing's sync is dirty and goes back through review.
  - Editing the file mid-run changes nothing in this run.

Treat any difference from the runbook as a finding, not a test to make pass.

## 5. Rollout

**One release, 2.2.0.** Three branches, one per feature, merged in this order:

1. shared paths, which is the smallest and changes gating;
2. dispatch, which is CLI-only;
3. before-merge checks.

Each goes through its own review. The release PR is merged once, after all three. Each feature PR title
is conventional (`feat(gating): …`, `feat(dispatch): …`, `feat(merge): …`); release-please makes one
minor bump from them. Each branch updates README, SKILL.md and `test/integration/smoke.md` in the same
PR as its code.

**Upgrading** gets one paragraph. Restart the supervisor in every session with a run in flight, as for
every release. Then:

- **A new CLI beside a 2.1 supervisor.**
  - `hold` and `answer --before-merge` refuse until the supervisor is restarted (the `before-merge`
    capability).
  - `start` with a shared-paths file warns that the running supervisor will lock those paths anyway
    (the `shared-paths` capability). That is stricter, so it is safe.
  - `dispatch --task` works, since it is CLI-only. The old supervisor's `Dispatch tN` prompt just lacks
    the new line.
- **Runs started on 2.1** have no `shared_paths`, so they keep locking everything until they finish.
- **Rolling back to 2.1.**
  - The fields are ignored, not removed. A run with a check owed loses its hold: 2.1 sends the merge
    command and probes as before. Confirm or waive every owed check before rolling back, or tell the
    human that the hold is gone.
  - Shared paths lock again, which is stricter, so it is safe.

## Verify before implementing

Each needs the real tool, so the smoke run settles it.

1. The `herdr worktree create` response: where the workspace id, `root_pane.pane_id` and
   `worktree.path` sit (the plugin only ever names the last two, `unstarted.ts:114-115`).
2. `herdr worktree open --branch` on a checkout whose workspace is already open: does it return that
   workspace, or open a second one? Step 1 relies on asking the ledger and the record file first, but
   case (iii) needs the answer.
3. `herdr agent start`: its error codes for a name already in use and for a dialog, whether it has a
   `--timeout` of its own, and whether a start whose client was killed still completes.
4. Whether `herdr worktree list` exists and names each worktree's workspace. If it does, step 1's
   detection can ask herdr instead of the record file.
5. `bd comment` on a closed bead (single-PR task checks, §1.9).
6. `merge=union`: honoured by `git merge-tree --write-tree` in `repo_root`, by a local rebase, and by
   GitHub's merge or update-branch (§3.4, advice only).

## Rejected

| Alternative | Why not |
|---|---|
| A new task phase (`held`) between `ci` and `merge`, and a run phase before `done` | A change to `phases.ts`, and so to the format of runs on disk. On a rollback, `taskRow` throws inside the old supervisor's tick for every run in the session. The gate rows already carry the right signals; only their prompt and their post-merge step change |
| A single-PR task check gating the task's landing | It holds the one landing slot for a human (§1.3) |
| `--by orchestrator` for `confirm` | The check is the owner's. A check the orchestrator can make is not a before-merge check, and belongs in the answer |
| Refusing to record a merge made while held | It is GitHub's fact. Leaving it unrecorded would strand the bead's close and the dependents' bases, and status would lie |
| A slower probe while held | #22: a probe nobody but the human can answer. The footer and status are the reminder |
| A per-task run check gating every merge to come | One confirmation cannot cover several heads. It is a task check per task |
| The supervisor running the dispatch | The serial tick, minute-long bootstraps, and a failure nobody reads |
| Bootstraps in parallel under `--ready` | Contention on one machine, interleaved failures, and a budget that is harder to keep. Sequential with a budget stop is predictable, and a re-run carries on |
| Writing dispatch progress to the ledger | The worktree hook owns `workspace_id`, and a second writer of one field races it. A local record file is enough to resume |
| Re-reading shared paths every tick, or at each registration | §3.2: a list that shrinks breaks the file-gate invariant, and per-task snapshots break symmetry |
| Cutting shared-path globs to their prefix | It widens sharing (§3.1) |
| Treating a conflict on a shared path as a clean sync | The resolution is code no reviewer has seen (single-PR §3) |

## Open questions

1. **Two ways to record a task check.** `answer --before-merge` comes from a decision; `hold --task`
   covers the rest. The ask was one obvious way per scope. Keep `hold --task`, or drop it and accept
   that a check with no decision behind it can only be a run check, which means single-PR only?
2. **A reminder while held.** Nothing nudges anyone while the human holds a merge. Is a reminder
   wanted, and how often? For example, one line to the orchestrator after N hours.
3. **A human-only channel.** A herdr action ("Confirm a before-merge check") would prove the ruling came
   from the human's own UI. As designed, the plugin trusts `--by human`, as it does for answers.
4. **Single-PR task check beads.** The bead closes at landing and carries the check as a comment.
   Should it stay open until `ship-merge` instead? That would reopen single-PR owner decision 3.
5. **Withdrawing a confirmation.** If the human takes one back, nothing in this design re-owes it until
   the head moves. Is `--withdraw` needed?
6. **`--failed` per-task.** It sends the task straight to `implement` with the finding. Should the
   orchestrator choose instead, between `implement`, a decision to the worker, or waiving it into a
   follow-up task?
7. **The bootstrap on a re-run.** Steps 1–2 re-run the bootstrap until an agent is in the pane, because
   nothing records that it finished. Is that acceptable for berean-os's bootstrap? Is the 9/5-minute
   budget right? Should an unwired `bin/bootstrap` be run, as the manual block offers?
8. **Recovery (b).** The one command also starts an agent for a paneless task whose prompt is queued.
   This could be cut to keep 2.2 to the dispatch block alone.
9. **An add-only refresh of shared paths mid-run.** For example `hpipe start`'s read repeated at each
   registration, adding but never removing.

## Files this change declares

- `src/cli.ts`
- `src/lib/{types,before-merge,shared-paths,dispatch-steps,gating,machine,status,bead-desired,unstarted,herdr,check,bootstrap,change-prompt,review-skip,pidfile}.ts`
  (`before-merge`, `shared-paths` and `dispatch-steps` are new)
- `src/supervisor/{tasks,deliver,stall,tick,main,beads-sync}.ts`
- `prompts/`: `before-merge.md` and `check-failed.md` are new. Edited: `answer.md`, `merge.md`,
  `ship-merge.md`, `ship.md`, `sync.md`, `implement.md`, `decision.md`, `dispatch.md`, `intake.md`
- `README.md`, `skills/herdr-pipeline/SKILL.md`, `test/` (§4), `test/integration/smoke.md`
