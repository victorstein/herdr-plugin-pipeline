# v2.2: before-merge checks, one-command dispatch, shared paths — design

Pass 2. Written against `1ca25eb` (v2.1.1). Pass 1 drew an adversarial review (1 BLOCKER, 6 MAJOR,
8 MINOR), and the owner answered its nine open questions. This pass folds in both, and "After the
pass-1 review" at the end maps each finding and question to what changed.

The owner chose what to build on 2026-10-13, from the berean-os notes
(`docs/superpowers/notes/2026-10-11-berean-os-live-run.md`, findings #5, #17, #18 and #24) and from
the tag-chip trial. All three ship together as 2.2.0.

1. **Before-merge checks** (#17, #24, and the owner wait). A check only the human can make, such as a
   device test, is recorded on the ledger. The merge it guards gets no merge command, and no stall
   probe, until the human has confirmed or waived it. A run cannot reach `done` while one is owed.
2. **One-command dispatch** (#5). `hpipe dispatch --task <id>` runs the whole `dispatch, in order:`
   block itself: worktree, bootstrap, agent start, brief. `hpipe dispatch --ready` does it for every
   task waiting for its brief. The orchestrator runs it in the background and ends its turn.
3. **Shared paths** (#18). A repo lists in `.claude/pipeline-shared-paths` the paths that every task
   may edit at once. Those paths never hold the file lock. A conflict on one is left to the flows that
   already exist: rebase before a per-task merge, `sync` in a single-PR run.

**On-disk format.** `phases.ts` does not change, and neither does `schema_version`. Five optional
fields are added: `Task.before_merge`, `Run.before_merge`, `Task.bootstrapped`, `Run.shared_paths` and
`SupervisorPid.capabilities`. When a field is absent the code behaves as it does today. An older
release ignores all five; what that costs on a rollback is in §5.

## Evidence

| Fact | Source |
|---|---|
| In the tag-chip trial (5 tasks, single-PR, released as berean-os 1.30.0), the run sat in `ship-merge` for about 40 minutes waiting for the owner's on-device check. The supervisor sent the orchestrator a "Still working?" probe every 5 minutes (trial config; the default is 15), and nothing could record "waiting on the owner". Measured on a live run | notes, "Status (2026-10-13)" |
| #17: t1's d1 answer made the merge wait on a device check, and the orchestrator planned to merge as soon as CI passed. #24: the run reached `done` with that check never made, and nothing in status or Beads said it was still owed. Measured on a live run | notes #17, #24 |
| `ship-merge` and a task's `merge` are stallable on signal `merged`, which is not actor-produced, so each gets a standing nudge that never escalates: run rows every `STALL_MINUTES` (15), task rows every `TASK_STALL_MINUTES` (45) | `phases.ts:107,143,236`, `config.ts:28-36`, `main.ts:580-586` |
| `ship-merge.md` ends: "This is the last point at which a check a decision ruled 'before merge' can still be done." The single-PR design left recording such checks out of scope | `prompts/ship-merge.md:22`, single-PR design §4 |
| A per-task `merge` is a level on "PR merged", and a head that moves after CI passed sends the task back to `ci`. `ship-merge` records GitHub's merge whatever the orchestrator is doing, then goes to `done` | `machine.ts:547-561`, `machine.ts:171-182` |
| `ship` records the batch PR it sees and still returns null: a fact the row records without a transition. The supervisor saves a run whose content changed, transition or not | `machine.ts:148-152`, `ledger.ts:189-196` |
| The per-task `merge` stall clause tells the orchestrator to merge the PR | `stall.ts:376-388` |
| `hpipe answer` accepts only a task in `blocked-on-decision`, records the answer, and leaves delivery to the supervisor | `cli.ts:1832-1867` |
| The CLI asks GitHub once per command, before its retried save. A gh call inside the retry outlasts a supervisor tick and loses every save | `cli.ts:384-402` (`askedOnce`) |
| `merged_at_ms` is written by the supervisor's `merge` row, which runs only while the orchestrator is idle. A PR merged mid-turn is unrecorded until then | `tasks.ts:402-407`, `machine.ts:547-555` |
| A send-back records the PR head as just read, not the head CI passed on: the worker must push past what it was sent back from | `tasks.ts:678-705` (`withSendBackHead`) |
| A bead goes `closed` as soon as `merged_at_ms` is set. An escalated decision makes it `blocked` + `hpipe:awaiting-human`. Comments are posted once each, keyed by a marker | `bead-desired.ts:97-157`, `beads-sync.ts:115-117` |
| `taskStallCandidates` already exempts `blocked-on-files` with live holders (#22), and `land-queue` while the slot is held | `stall.ts:148-151` |
| The plugin pins the merge to the head CI passed on (`--match-head-commit`) | `change-prompt.ts:177-191`, `deliver.ts:554-562` |
| The dispatch block is five lines: `worktree create`, a `#` line about the JSON, the optional bootstrap, `agent start`, and `dispatch --task --pane`. For seven tasks the orchestrator scripted a loop. It broke on zsh word-splitting, and the retry parsed the JSON with inline `python3`. Measured on a live run | `unstarted.ts:137-150`, notes #5 |
| `dispatch --task --pane` refuses the run's orchestrator pane and another task's pane, but only just before it sends the brief | `cli.ts:938-946` |
| `Herdr` has no `worktree create`/`open`/`list` and no `agent start` method; only the orchestrator's shell runs them. `herdr worktree list` exists, with a JSON shape this plugin has never read | `herdr.ts:72-238`; the pass-1 review |
| `worktree.created`/`worktree.opened` bind a task by branch, and only while its `workspace_id` is null, on the supervisor's next tick | `tick.ts:430-439` |
| `repoBootstrap` reads the primary checkout's working tree, which may be on any branch, not the new worktree | `bootstrap.ts:27-47` |
| `submit` and `batch-check` run the repo's check under a 9-minute deadline in its own process group, because the agent's foreground Bash call times out at 10 | `check.ts:43-78` |
| The bootstrap "must be idempotent — it can run more than once" | `README.md:105` |
| Outside a herdr pane, `hpipe` silently uses the `default` session's ledger | `session.ts`, project memory |
| The file lock is a plain prefix test over every in-flight task's `--files`, and plan widening only ever adds | `gating.ts:27-29,115-181`, `tasks.ts:487-501,665-670` |
| t3, t6 and t7 each needed `docs/file-formats.md` (each change appended a section), so they waited on one another's whole implement → review → CI → merge. Measured on a live run | notes #18, watch log 12:00Z |
| `.claude/pipeline-always-review` is read with `git show <base>:<file>`, and a glob is cut to its prefix. That widens the list, which is safe for review | `review-skip.ts:126-139`, `tasks.ts:734-742` |
| `git merge-tree --write-tree` honours a `merge=union` attribute only through the working tree's `.gitattributes`. Probed by the pass-1 review | the pass-1 review |

## Decisions

### The owner's decisions (2026-10-13)

| # | Decision |
|---|---|
| 1 | A check a decision's answer makes, `hpipe answer … --before-merge "<check>"`, is recorded on the task. The run has its own form too. The merge does not clear while a check is owed. Status, show, the board, the digest and the merge prompts say what it waits on. Stall probes pause while only the human owes something. The done notice and `abort` list what is still owed, and a run cannot reach `done` with a check owed unless the human waives it |
| 2 | `hpipe dispatch --task <id>` with no `--pane` runs every dispatch step itself and stops at the first failure. `--ready` does every ready task. `--pane` and the printed block stay as the manual fallback. The auto-mode classifier no longer sees `herdr agent start` on its own, and the owner accepts that |
| 3 | `.claude/pipeline-shared-paths` lists paths that never hold the file lock. Conflicts on them are left to the merge/rebase and `sync` flows |

### The owner's answers to pass 1's open questions

| # | Answer | Where |
|---|---|---|
| 1 | Keep `hold --task` beside `answer --before-merge` | §1.2 |
| 2 | No reminders while a check waits on the human. Status, show and the board show it | §1.7, §1.8 |
| 3 | Trust `--by human`. There is no herdr-action confirm | §1.6 |
| 4 | Single-PR beads still close at landing. A bead comment records the check only while the bead is open | §1.9 |
| 5 | No way to withdraw a confirmation | §1.6 |
| 6 | A per-task `--failed` sends the task back to `implement` | §1.6 |
| 7 | Dispatch runs only a wired `.claude/pipeline-bootstrap`. An unwired script is named, not run. Bootstrap success is recorded, so a re-run after a later failure does not redo it | §2.2 |
| 8 | Cut the recovery case: dispatch takes only tasks owed their brief | §2.1 |
| 9 | No mid-run refresh of shared paths | §3.2 |

### Design decisions

| Question | Decision | Why |
|---|---|---|
| What the human is called | "the human", in every text | Status, the escalation prompts and the bead comments already say it |
| The record | `BeforeMergeCheck { id, check, recorded_at, decision?, recorded_pane, resolutions[] }` on `Task.before_merge` or `Run.before_merge`. Ids `c1`, `c2`, … across the run | One id space, so `confirm` needs only `--check c2` |
| Recording a task check | `hpipe answer … --before-merge "<check>"` during a decision; `hpipe hold --task <id> --before-merge "<check>"` otherwise | Owner answer 1. A merge can need the owner's check with no decision behind it, as the tag-chip wait did |
| Recording a run check | `hpipe hold --before-merge "<check>"`, single-PR only | A per-task run has no merge of its own. A run check over every merge to come would need one confirmation per task head, which is a task check |
| Where a task check gates | Per-task: that task's `merge`. Single-PR: the run's `ship-merge`, not the task's landing (§1.3) | One landing at a time: holding one for a human stops every landing behind it, and a device check means something only on the build that ships |
| What counts as confirmed | A confirmation names the head it covers and holds only while that is the head that merges. A waiver holds whatever the head | The plugin already refuses to merge a head CI never saw (#16). A human check is the same kind of fact |
| When a ruling is accepted | Near the gate only. Per-task while the task is in `ci` or `merge`, or once its merge has happened. Single-PR while the run is in `ship-ci` or `ship-merge` (§1.6) | A ruling far from the gate is a ruling on a head that will not merge. Pass 1 accepted early confirmations, and a per-task failure accepted outside `ci`/`merge` had no exit |
| Who rules | `--by human` only, never from a worker's pane, and only from inside a herdr pane | The point is the owner's check. The orchestrator relays it as `answer --by human` does (owner answer 3) |
| The merge command while a check is owed | Never rendered. The gate row's prompt is `before-merge.md`, which first has the orchestrator make the PR mergeable (§1.5) | A prompt that shows the command while saying "don't" puts the wrong move one paste away. Asking the human to check a head that a rebase will replace wastes the check |
| A merge made anyway | Recorded, since it is GitHub's fact. The step after it waits: per-task `merge → close`, single-PR `ship-merge → done`. Rewinds and `close` that would skip the wait are refused, and per-task `execute` holds as a backstop | The plugin cannot un-merge. Holding the next step keeps the record true and stops a run from reaching `done` with a check owed |
| What the CLI believes about a merge | It asks GitHub once, before its retried save, whenever the ledger has no merge recorded and the PR exists. It fails closed when gh cannot answer | The supervisor records a merge only while the orchestrator is idle, so the ledger lags GitHub |
| Stall probes | Skipped while every check owed at the gate waits on the human. A ruling that clears the gate re-arms the ladder. Any probe that does fire never says "merge it" while a check is owed | #22 again otherwise: probes about a wait nobody but the human can end |
| Beads | Per-task: a held task is `blocked` + `hpipe:awaiting-human`, and check comments are posted while the bead is open. Single-PR: the bead still closes at landing | Owner answer 4. It matches how an escalated decision already shows |
| Older supervisor beside a new CLI | `answer --before-merge` and `hold` refuse while this session's live supervisor lacks the `before-merge` capability | An old supervisor would hand out the merge command anyway |
| Where dispatch runs | Only the `hpipe` CLI, from a pane whose `HERDR_SOCKET_PATH` equals the run's `socket_path`. Never the supervisor | The tick is serial, and a bootstrap takes minutes. A failure there has nobody to read it. Outside the right session, herdr and the ledger would be the wrong ones |
| How the orchestrator runs it | With the Bash tool's `run_in_background`, then it ends its turn. The completion notice brings the output | No 10-minute timeout to fit under, and the orchestrator stays free to take digests |
| Deadlines | 20 minutes on the bootstrap, as a safety net: SIGTERM, then SIGKILL after 10 s. 80 s on `agent start`. 30 s on the brief, as today | A hung bootstrap would hold the repo's dispatch lock for good, and nobody watches a background shell |
| Finding an existing worktree | `herdr worktree list`, matched on path and branch. If its output cannot be read, nothing is skipped | A stale record file let pass 1 start a permission-skipping agent in an unrelated pane (BLOCKER 1). Herdr's own view is the only record that is never stale |
| Before `agent start` | The target pane must be in herdr's workspace for a linked worktree at the task's checkout, on `task.branch`, and must not be any run's orchestrator pane or another task's pane | An agent that skips permissions must never start in a pane that is not the task's |
| The bootstrap | Only a wired `.claude/pipeline-bootstrap`, looked up in the new checkout. Success is recorded on `Task.bootstrapped`, keyed by workspace and checkout | Owner answer 7. The checkout is what the bootstrap runs in; the primary checkout may be on any branch |
| Concurrency | One dispatch at a time per repo, under a lock holding the pid, its start time and the bootstrap's process group | Bootstraps in worktrees of one repo share its `.git/config`, and a dead dispatch's bootstrap must not run on unseen |
| Shared paths: when read | Once, at `hpipe start`, from the default branch as just fetched, and stored as `Run.shared_paths`. No refresh mid-run (owner answer 9) | A list that shrank mid-run could leave two tasks past the file gate on a path that locks again. Per-task snapshots would not be symmetric |
| Shared paths: globs | Ignored, with a warning | Cutting a glob to its prefix widens the list. That is safe for always-review and unsafe here: `docs/*.md` would share all of `docs/` |
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
  /** HERDR_PANE_ID of the command: the audit trail. */
  pane: string
}
interface BeforeMergeCheck {
  id: string                 // c1, c2 …, one sequence across the run's task and run checks
  check: string              // what the human checks, in the orchestrator's words
  recorded_at: number
  decision?: string          // the decision whose answer carried it
  recorded_pane: string
  resolutions: Resolution[]  // append-only; the last one is the ruling in force
}
Task.before_merge?: BeforeMergeCheck[]
Run.before_merge?: BeforeMergeCheck[]   // single-PR only
SupervisorPid.capabilities?: string[]   // ['before-merge', 'shared-paths']; absent reads as []
```

Nothing deletes a check or a resolution, not a rewind and not an abort. A check whose work never
ships is **void**, and that is computed, not stored (§1.4). The next id is one more than the number of
checks in the run, which only grows.

A new pure module, `src/lib/before-merge.ts`, holds every rule below. The machine, stall, status,
`desiredBead` and the CLI all read the same functions, so they cannot disagree about what is owed.

### 1.2 Recording

```
hpipe answer --task <id> --decision <id> --answer "…" --by orchestrator|human \
             [--before-merge "<check>"]... [--run <run-id>]
hpipe hold --before-merge "<check>" [--task <id>] [--run <run-id>]
```

- **The flag.** `--before-merge` is free text. It joins `FREE_TEXT_FLAGS` (`cli.ts:2268`) and may be
  repeated: each occurrence is one check, and commas are never split. A new `repeatedFlag()` reads
  it, not `listFlag`. An empty value is refused.
- **`answer --before-merge`** writes the answer and the checks in **one save**, then delivers the
  answer as today. `--by orchestrator` is allowed, because who settled the decision is a separate
  question from who checks the merge. The check records `decision: <id>`.
- **`hold` without `--task`** records a run check. In a per-task run it is refused with: "a per-task
  run has no merge of its own: hold one task's merge with `--task <id>`".
- **`hold --task` on a single-PR task that has landed** is refused, and points at the run check:
  "t1 has landed on `batch/x`: a check of what ships is the batch's — `hpipe hold --before-merge
  "<check>"`". So a single-PR task check is always recorded while its bead is open (§1.9).
- **Both refuse:**
  - from a pane bound as a worker of any run in this session ("a worker raises a decision; the
    orchestrator records the check"), and when `HERDR_PANE_ID` is unset ("run it from a pane of this
    herdr session");
  - once the merge they would hold has happened (§1.6, "What the CLI believes about a merge");
  - on a finished task;
  - beside a live supervisor whose `capabilities` lack `before-merge`, naming its pid and the restart
    step, as `start --single-pr` does (`cli.ts:245-249`).
- **A hold recorded while its gate is already open** (the task is in `merge`, or the run in
  `ship-merge`). The gate's prompt has already gone out, so in the same save the CLI:
  - replaces any undelivered prompt queued for that record's current entry with `before-merge.md`;
  - prints "t1 is in merge now: do not run the merge command you were given; it comes again once c3
    is confirmed".

Output: `c3 recorded on t1: PR #255 does not merge until the human confirms: <check>`. A single-PR
task check reads `c3 recorded on t1: the batch PR does not merge until …; t1 still lands on batch/x
as usual`. A run check reads `c4 recorded: the batch PR does not merge until …`.

### 1.3 Where a check gates

| Check | Per-task run | Single-PR run |
|---|---|---|
| On a task | That task's `merge` | The run's `ship-merge`, if the task has a landing |
| On the run | — (refused) | The run's `ship-merge` |

**Why a single-PR task check holds the batch PR and not the task's landing.**

- **The slot.** One task lands at a time (`landingSlotHolder`, `gating.ts:190-193`). A landing held
  for a human holds every landing behind it, for as long as the human takes; in the trial that was
  40 minutes.
- **What is checked.** A device check of one task branch checks a build that never ships. The batch
  PR's head is what ships.
- **A failure.** It still has a route. A check that fails at `ship-merge` is fixed on the batch, by a
  patch or a fix task, and registration already works from `ship-merge` (`cli.ts:369`). The new head is
  then checked again.
- **The cost.** A task check waits for the end of the batch even when its task landed early. A repo
  that wants each check per task runs per-task.

### 1.4 When a check is owed

The **gate head** is the head the gate row merges: per-task `task.ci_head.sha`, the head CI passed on,
and single-PR `batch.ci_head.sha`.

A check is **binding** unless it is void:

- **Per-task task check:** void when its task is in a terminal phase **and** has no merge recorded.
  That covers a task that failed, was abandoned, or was rewound to `done` before merging. A task with a
  merge recorded is never void, whatever phase a rewind put it in.
- **Single-PR task check:** void when its task has no landing (`landed` is empty) once the run reaches
  `ship-merge`.
- **Run check:** never void.

The state of a binding check comes from its last resolution:

| Last resolution | Its head equals the gate head | State |
|---|---|---|
| none | — | **waiting on the human** |
| `confirmed` | yes, or no gate head is recorded | satisfied |
| `confirmed` | no | **waiting on the human**: "confirmed on 9e06c261; the head is now 5e6f7a8b" |
| `failed` | yes | **waiting on a fix**. This can only sit at a gate in a single-PR run; a per-task `--failed` has already sent the task to `implement` (§1.6) |
| `failed` | no | **waiting on the human**: the fix is in, so check the new head |
| `waived` | — | satisfied |

- **No gate head** happens only after a manual rewind past CI. There the human chose to skip CI, so
  the confirmation is taken as given, as `pastTheCheck` does for a rewind past `batch-check`
  (`machine.ts:189-192`).
- **Owed** means waiting on the human or waiting on a fix.
- **Exports.**
  - `owedAt(run, task | null)` gives the owed checks for a task's `merge` (task) or for `ship-merge`
    (`null`).
  - `waitsOnlyOnTheHuman(run, task | null)` is true when there are owed checks and every one waits on
    the human.
  - `heldForTheHuman(run, task)` is true for a per-task task in `merge` with owed checks, merged or
    not.

### 1.5 The gate in the machine

There is no new phase, and the gate rows keep their signals. What changes is the prompt a gate row
sends, and the step after a merge.

**Per-task `merge`** (`machine.ts:547-561`):

- **PR merged, nothing owed:** as today. Record `merged_at_ms` and `merge_commit`, then go to `close`.
- **PR merged, a check owed:** record `merged_at_ms` and `merge_commit` the first time, and return
  `null`. The supervisor saves a run whose content changed whether or not it moved
  (`ledger.ts:189-196`), as `ship` already relies on (`machine.ts:148-152`). No transition means no
  history entry and no prompt.
- **Head moved after CI passed:** back to `ci`, as today. The confirmation is pinned to the old head,
  so the check is owed again when the task comes back.
- **Reads only the ledger.** `owedAt` reads `task.ci_head`, and no git or gh call is added.

**Single-PR `ship-merge`** (`machine.ts:171-182`):

- **PR merged, nothing owed:** as today. Record the batch merge and go to `done`.
- **PR merged, a check owed:** record `batch.merged_at_ms` and `batch.merge_commit` once, and return
  `null`. Returning the run would make `evaluateRun` treat it as advanced and render the phase prompt
  again (`deliver.ts:416-424`). From then on the row checks first whether the merge is recorded, so the
  head rules never fire on a merged PR.
- **PR not merged:** the head rules stay as they are.

**What cannot skip the wait.** These are the routes by which a merged, held task could otherwise
finish:

| Route | Change |
|---|---|
| `hpipe rewind <run> close\|teardown\|done\|orphaned --task tN` | Refused while tN has an owed binding check: "t1 owes c1: confirm or `--waive` it first" |
| `hpipe close --task tN` (`cli.ts:1571-1596`) | Refused while `heldForTheHuman` |
| Per-task run `execute` → `branch-review`/`done` (`machine.ts:103-112`) | Also waits while any task with a merge recorded has an owed binding check. That backstop catches a merged task rewound to `failed` |
| `waitsOnClose` (`beads-sync.ts:192`) | A held task does not count, so a store failure cannot mark it out of sync |

`hasLanded` (`ledger.ts:342-343`) needs no change: it requires `done` or `orphaned`, so a held task
never counts as landed. A run-level `hpipe rewind <run> done` stays the human's escape. A run ended
that way, or by `abort`, says what was still owed (§1.8).

**The prompt.** `renderTaskPhasePrompt` (`tasks.ts:195-198`) for `merge` and `shipPrompt`
(`deliver.ts:569-576`) for `ship-merge` render `prompts/before-merge.md` while `owedAt` is non-empty.
Otherwise they render the gate's own prompt. So the merge command is rendered only when nothing is
owed. `merge-batch.md` (a single-PR landing) never sees a hold.

`before-merge.md`, to the orchestrator. Its tokens are prefixed `held_`, because `changePromptVars`
already supplies a `subject`:

```
# Hold — {{held_title}} waits on the human before it merges

{{held_line}} waits on the human for:

{{held_checks}}           ← one line per owed check: id, text, task, and "confirmed on X; head now Y" when stale

1. Make it mergeable first: the human should check the head that will merge, and a rebase replaces it.
   {{held_mergeable}}
2. Then tell the human once, in a message of its own (never bundled with another question), what to
   check and on which build: {{held_build}}. End your turn. No stall probe comes while you wait.
3. When they answer, record it:

       {{hpipe}} confirm --check <id> --by human                    # they checked it, and it holds
       {{hpipe}} confirm --check <id> --by human --waive "<why>"    # they chose to skip it
       {{hpipe}} confirm --check <id> --by human --failed "<what they saw>"

Do not merge, and do not ask again because a digest lists it: the merge command comes as its own
prompt once nothing is owed.{{held_failed_route}}
```

`{{held_mergeable}}` per-task carries `merge.md`'s pre-merge step:

- `gh pr view <n> --json mergeStateStatus`;
- if it is `BEHIND` or `DIRTY`, rebase onto the default branch and re-run the bootstrap in that
  checkout. The rebase pushes a new head, the task goes back to `ci`, and this prompt comes again for
  the new head, so do not ask the human until then;
- the shared-path note (§3.4) when the task declares one.

Single-PR, it carries:

- `gh pr view <n> --json mergeStateStatus`;
- `BEHIND` → `gh pr update-branch <n>`;
- `DIRTY` → the merge of `origin/<into>` from `ship.md` step 2.

Either moves the head, so the run goes back through `ship`, and the human checks the head that
reaches `ship-merge`. A `BLOCKED` on a required review can go in the same message to the human.

`{{held_build}}` names the head to check:

- per-task: `PR #255 at 9e06c261, the head CI passed on`;
- single-PR: `` `batch/x` at 1a2b3c4d `` and the pull in the batch checkout, with `checkoutSteps`'
  bootstrap line (`batch.ts:48`).

`{{held_failed_route}}` is empty unless a single-PR check is waiting on a fix (§1.6).

`ship-merge.md:22` ("This is the last point …") is replaced by `{{before_merge}}`. That is empty for a
run with no checks; otherwise it reads "Before merge: c2 confirmed by the human on 1a2b3c4d; c1 (t1)
waived: <why>."

### 1.6 Resolving: `hpipe confirm`

```
hpipe confirm --check <id> --by human [--waive "<why>" | --failed "<what they saw>"] [--run <run-id>]
```

**Who.**

- `--by` must be `human`. Anything else gets: "only the human confirms a before-merge check: `--by
  human` once they have made it, or `--by human --waive "<why>"` if they choose to skip it".
- The worker-pane and `HERDR_PANE_ID` rules from §1.2 apply.
- `--waive` and `--failed` take text, cannot be empty, and cannot be given together.
- There is no way to withdraw a ruling (owner answer 5); a later ruling replaces it.

**When.** A ruling is accepted only near the gate:

| | `confirm`, `--waive` | `--failed` | Judged head |
|---|---|---|---|
| Per-task task check | the task is in `ci` or `merge`, or its merge has happened | the task is in `ci` or `merge`, and its PR has not merged | `task.ci_head.sha` |
| Single-PR check (task or run) | the run is in `ship-ci` or `ship-merge` | the same, and the batch PR has not merged | `batch.ci_head.sha` |

- **Outside the window** the command refuses: "c1 is ruled on at the merge it holds: t1 is in
  pr-review; confirm it once t1 reaches ci", or "… once the run reaches ship-ci".
- **No `ci_head` yet** (just after entering `ci`) also refuses: "CI has not read t1's head yet: run it
  again after the next poll".
- **Why the window.** Pass 1 accepted a confirmation at any time. A ruling on a head that will not
  merge only looks like progress, and a per-task failure ruled outside `ci`/`merge` left a "waiting on
  a fix" with no exit.

**What the CLI believes about a merge.** These commands read the ledger, but `merged_at_ms` lags
GitHub (Evidence). So before their retried save they ask GitHub once, with `prView` through
`askedOnce` (`cli.ts:384-402`), whenever the ledger has no merge recorded and the PR exists:

- per-task, `task.pr`;
- single-PR, `batch.pr` (the existing `ghBatchShipped` ask).

A PR GitHub reports merged counts as merged for `hold`, `answer --before-merge` and `confirm`. A gh
failure refuses the command: "could not ask GitHub whether PR #255 has merged; run it again".

**The head a ruling covers.**

- **`confirm`:**
  - It records the judged head.
  - Unless the merge has happened, it first reads the branch head live, with `remoteBranchHead`, the
    same once-only read before the retried save: the task branch per-task, the batch single-PR. That
    head must equal the judged head. If it does not: "`batch/x` is at 5e6f7a8b, not 1a2b3c4d, the
    head CI passed on: a check of 1a2b3c4d does not cover it; wait for the next prompt". A failed read
    refuses too.
  - After a merge the read is skipped, because the judged head is what merged, and GitHub may already
    have deleted the branch.
- **`--waive`:** reads nothing, and records no head.
- **`--failed`, per-task:** reads the PR head (`prView`, once) and records that, not the gate head, as
  `withSendBackHead` does (`tasks.ts:678-705`). The worker must push past what it was sent back from.
- **`--failed`, single-PR:** requires the live batch head to equal the judged head, as `confirm` does.
  A head that moved is already a new head, and gets its own check at `ship-merge`.

**What a ruling does.**

- **`confirm` or `--waive` that leaves nothing owed at an open gate** (the task in `merge`, or the run
  in `ship-merge`). In the same save it:
  - queues the gate's normal prompt (`merge.md` / `ship-merge.md`), replacing an undelivered
    `before-merge.md`, unless the merge has already happened, when the next tick moves the record on;
  - re-arms that record's stall ladder (`freshLadder`, `unstarted.ts:217`), so the first probe comes a
    full threshold later and not on the next tick.
  It prints "nothing more is owed before t1 merges; its merge prompt is queued for you". In `ci` or
  `ship-ci` nothing is queued: entering the gate renders the normal prompt.
- **`--failed` per-task** (owner answer 6). In the same save, the task goes from `ci` or `merge` to
  `implement`:
  - `head_sha_at_entry` is set to the PR head just read;
  - the history reads "the human's before-merge check c1 failed: <what>";
  - the worker is queued a new prompt, `prompts/check-failed.md`, rendered through
    `renderTaskPhasePrompt` with `cameFrom: 'merge'`. Like `ci-red.md`, it gives what the human saw,
    the check's text and decision, then the implementer's brief;
  - a paneless worker is handled as `owePhasePrompt` handles one (`cli.ts:1060-1090`);
  - no counter is bumped: each lap needs a human ruling, as a rewind does.
- **`--failed` single-PR.** The run stays where it is, and the check waits on a fix. The CLI prints
  the two routes `ship-ci-red.md` already has: a subagent's patch in the batch checkout and then
  `batch-check`, or a fix task through `hpipe task …`. Either moves the head, after which the check
  waits on the human again.
- **`--failed` after a merge** is refused: "PR #255 has merged: the fix is a new task. Record this
  ruling with `--waive "failed on device; fixed by <task>"` so the run can finish." The follow-up
  task gets its own check with `hold --task`.

**How the orchestrator relays the human.** The human answers in the orchestrator's pane, or anywhere
the orchestrator reads, and the orchestrator runs `confirm`. The human may also run it from their own
pane in the session; `pane` records which. The plugin trusts `--by human`, as it does for answers.

### 1.7 The stall ladder

- **Tasks.** `taskStallCandidates` (`stall.ts:136-162`) skips a per-task task in `merge` when
  `waitsOnlyOnTheHuman(run, task)` is true, beside the `blocked-on-files` and `land-queue` exemptions.
- **Runs.** `stallCandidates` (`stall.ts:105-117`) skips a single-PR run in `ship-merge` on the same
  test.
- **What skipping means.** No candidate is made, so no rung is climbed and nothing is recorded. Both
  rows are standing nudges that never escalate, so no escalation path is lost.
- **A check waiting on a fix is not skipped**, because it is the orchestrator's move. `shipClause`'s
  `ship-merge` case (`stall.ts:456-464`) gets a form naming the failed check and both routes.
- **No probe that fires while a check is owed says "merge it".**
  - The per-task `merged` clause (`stall.ts:376-388`) gets a held form: "This phase waits on the
    human's check c1 before PR #255 merges: do not merge it. When they answer: `hpipe confirm …`".
  - It also gets a merged-while-held form: "PR #255 merged before the human confirmed c1. This task
    waits here until c1 is confirmed or waived; there is nothing to merge."
  - `awaitedFor`'s `merged` case (`awaiting.ts:29-33`) reads "the human's check c1 before PR #255
    merges". Status and the digest share it.
- **No reminder** goes to anyone while the human holds a merge (owner answer 2). Status, show and the
  board show the wait, and `confirm` re-arms the ladder when the hold lifts.

### 1.8 What the orchestrator and the human see

**`hpipe status`** gets a new heading, "waiting on the human:", after "waiting on you:" and in the
same line shape. Its lines are not repeated under "waiting on you".

```
t1 feat/ghost berean-o-1 [merge 34m] standard agent:idle PR #255 ci:pass — waiting on the human (c1)
  before merge: c1 (t1) the reader shows no ghost after a page turn — waiting on the human · c2 … — confirmed on 1a2b3c4d
  waiting on the human:
    c1 t1 [merge 34m] — the reader shows no ghost after a page turn (from d1), on PR #255 at 9e06c261 — once
       they answer: `hpipe confirm --check c1 --by human` (or --waive / --failed)
```

- **`moveFor`** (`status.ts:180-280`) gives a held task `waitsOnYou: false` and the clause `waiting on
  the human (c1)`.
- **A merge recorded while held** adds `⚠ t1: PR #255 merged before the human confirmed c1 — it waits
  in merge until c1 is confirmed or waived`.
- **The `execute` backstop** (§1.5) adds a run line under "waiting on the human": `run [execute] — t1
  merged with c1 owed: confirm or waive it to let the run finish`.
- **The run header** gets a `before merge:` line whenever the run has a check, in either mode, listing
  each check and its state.
- **`shipLines`** (`status.ts:600-613`) in a held `ship-merge` shows the human's line in place of
  "YOUR move: squash-merge …". A check waiting on a fix is a "YOUR move" naming the routes.
- **A run ended with a check owed** (by `abort` or `rewind <run> done`) gets a line from
  `finishedRunSummary`: `⚠ ended with c2 still owed to the human: <check>`.

**`hpipe show --task`** prints one `before merge:` line per check, after `decision:`:

```
before merge: c1 the reader shows no ghost after a page turn (from d1) — waiting on the human
              c3 the menu closes on a long press — confirmed by the human on 9e06c261, 3m ago
```

The other states read `— waived by the human 5m ago: <why>`, `— failed on 9e06c261, 8m ago: <what>;
the human checks the next head`, and `— not needed: t5 never merged`.

**The digest.** `parkedFooter` (`tick.ts:195-212`) gets the same "waiting on the human:" block after
"also waiting on you:". It shows the merge is held on purpose, and `before-merge.md` says it is no cue
to ask again. A task that enters `merge` held gets the hold prompt as its digest body.

**The answer to the worker.** `answer.md` gains `{{before_merge}}`, supplied at its one render site
(`tasks.ts:890-895`). It reads: "Before this merges, the human will check: <check>. Make it
checkable: say in the PR how to check it." In a single-PR run, "the PR" is "an empty commit on the
branch", the run's `reply_place`.

**The `done` notice** (`deliver.ts:646-675`, `907-917`) gets a `before merge:` line:

```
before merge: c1 (t1) confirmed by the human on 9e06c261 · c2 waived by the human: release window · c3 (t5) not needed: t5 never merged
```

**`hpipe abort`** (`cli.ts:2125-2153`) does not refuse, and prints:

- per-task: `still owed to the human: c1 (t1) <check> — PR #255 is not merged`, or `— PR #255 merged
  before it was confirmed`;
- single-PR: `— the batch PR is not merged`.

`resume` brings every check back as it was.

**Prompts that teach the record.**

- `decision.md`, "Either way, record the answer": "If the answer makes the merge wait on something only
  the human can check (a device test, a look at the UI), add `--before-merge "<what they check>"`:
  the merge is held until they confirm it. Not for anything you or the worker can verify — put that
  in the answer."
- `intake.md` step 0 and `ship.md` step 1: "If the user wants to check the work themselves before it
  merges, record it as soon as you know: `hpipe hold --before-merge "<check>"` (single-PR), or
  `hpipe hold --task <id> …`."

### 1.9 Beads

`desiredBead` (`bead-desired.ts:130-158`):

- **A held per-task task** (`heldForTheHuman`, merged or not) is `blocked`, assigned to `hpipe`, with
  labels `[merge, hpipe:awaiting-human]`. That is the escalated-decision row. The `closed` row applies
  only to a task that is not held.
- **Comments.** `decisionComments` becomes `taskComments`, and adds two kinds in the existing marker
  shape:
  - `[hpipe t1/c1/before-merge]` with "Before merge, the human checks: <check> (from d1)";
  - `[hpipe t1/c1/r<n>]` per ruling, with "Confirmed by the human on 9e06c261", "Waived by the human:
    <why>" or "Failed on 9e06c261: <what>".
- **Check comments go only to an open bead.** `callsFor` (`beads-sync.ts:115-117`) drops a check
  comment when the exported bead is `closed`. Comments go before the close in one pass, so a per-task
  ruling that releases the hold is still posted. A single-PR task's check is posted when it is
  recorded, which is always before landing (§1.2), and its rulings, made after the close, are not
  posted. From the close on, the run's own record is the record: status, show and the done notice
  (owner answer 4).
- **Run checks** have no bead. They show in status and the notices only.

## 2. One-command dispatch

### 2.1 CLI surface

```
hpipe dispatch --task <id> [--run <run-id>]                    # every step, as needed
hpipe dispatch --task <id> --pane <pane-id> [--run <run-id>]   # the brief only, as today
hpipe dispatch --ready [--run <run-id>]                         # every task waiting for its brief
hpipe dispatch --done [--run <run-id>]
```

- The argv rule at `cli.ts:2315` becomes "exactly one of `--done`, `--task` and `--ready`".
- `--ready` joins `VALUELESS_FLAGS`.
- `USAGE.dispatch` lists all four forms.
- Exit 0 only when every task it set out to dispatch was dispatched.

**Which tasks.** A task in its briefed phase (`research`) that is owed its brief: `unbriefedWorker`
(`unstarted.ts:51-55`) answers non-null. That is exactly what the printed block dispatches.
`--ready` takes them in `task_id` order. Anything else is refused, naming why:

- `queued`: "waiting on t1";
- briefed: "its worker has the brief";
- a later phase: today's recovery advice.

The recovery case of pass 1, a paneless task past `research`, is cut (owner answer 8).

**Where it runs.** It refuses unless `HERDR_SOCKET_PATH` is set and equals the run's `socket_path`:
"hpipe dispatch drives herdr itself: run it from a pane of session <s>". The supervisor never runs
it.

**How the orchestrator runs it.** With the Bash tool's `run_in_background`, then it ends its turn; the
completion notice brings the output. Background work never holds a phase (README, Background work),
so nothing waits on the shell, and the orchestrator can take digests meanwhile. This removes pass 1's
coupling to the 10-minute foreground timeout.

### 2.2 The steps

A new module, `src/lib/dispatch-steps.ts`, runs the steps over injected dependencies: herdr, git, the
script runner, the brief step and a clock. `cmdDispatchSteps` wires the real ones. Each step first asks
whether it is already done, and only from a source that cannot be stale: herdr, git, or the ledger.

| # | Step | Already done when | Otherwise |
|---|---|---|---|
| 0 | **base** | — | `freshDispatchBase(repo_root, dependencyMerges(task), batch)` (`dispatch-base.ts:223`). A fetch error stops here |
| 1 | **worktree** | `herdr worktree list` has an entry on `task.branch` whose path is the checkout (below), and that entry has an open workspace | See below |
| guard | **pane** | — | Checks run before step 3 (below). Any that cannot be settled stops |
| 2 | **bootstrap** | `task.bootstrapped` names this workspace and checkout, or an agent is already in the pane | See below |
| 3 | **agent** | `herdr pane list --workspace <ws>` shows an agent in the pane (`!paneHasNoAgent`, `herdr.ts:25`) | See below |
| 4 | **brief** | The task, as just re-read from the ledger, is no longer owed its brief | See below |

**Step 1, worktree.** The checkout path is `task.checkout_path` when the ledger has one. Otherwise it
is the path `git -C <repo_root> worktree list --porcelain` gives for `refs/heads/<branch>`. Then:

- **`herdr worktree list` cannot be parsed:** nothing is skipped. The command goes to `worktree
  create`, which fails on an existing checkout and stops the step with herdr's error. It fails closed.
- **Herdr lists the checkout, on the branch, with a workspace:** the step is skipped.
- **Git has the checkout but herdr has no workspace for it:** `herdr worktree open --cwd <repo_root>
  --branch <branch>`.
- **No checkout:**
  - if `refs/heads/<branch>` exists and does not contain the base, stop: "`<branch>` already exists
    at 3c4d5e6f and does not contain the base 1fb8a43c: it is not this task's; rename the task's branch
    or delete it";
  - otherwise `herdr worktree create --cwd <repo_root> --branch <branch> --base <commit>`, reading the
    workspace and pane from its JSON (Verify 1).
- **The pane:** the workspace's only pane, or the ledger's `task.pane_id` when it is in that
  workspace. Otherwise stop, and name `--pane`.

**The pane guard, before step 3.**

- The pane is in workspace W.
- W is herdr's workspace for a linked worktree whose path is the task's checkout and whose branch is
  `task.branch`, according to `herdr worktree list`, or the create/open response just made.
- That path equals `task.checkout_path` when the ledger has one.
- The pane is no run's orchestrator pane and no other task's pane in this session. These checks
  (`cli.ts:938-946`) used to run only before the brief; they now run before `agent start` too.
- Pass 1 took the workspace and pane from a record file that a forgotten or reused workspace could
  make stale. The guard is what stops an agent that skips permissions from starting in a pane that is
  not the task's (BLOCKER 1).

**Step 2, bootstrap.** The script is looked up in **the new checkout**, not through
`repoBootstrap(repo_root)`, which reads the primary checkout's tree (`bootstrap.ts:27-47`).

- `.claude/pipeline-bootstrap` executable there: run it from the checkout (§2.3). Its output goes to
  `<stateDir>/runs/<session>/<run_id>.dispatch/<task>-bootstrap.log`, and the last 40 lines are
  printed on failure. On success, `task.bootstrapped = { workspace_id, checkout, at }` is saved
  (`retryOnStaleRun`), so a re-run after a later step fails does not redo it. A new workspace (a
  re-created or re-opened worktree) does not match, so the bootstrap runs again, which the README's
  idempotence rule allows.
- Present but not executable: stop, with the `chmod +x` hint.
- Absent: skipped. When a conventional script is there (`bin/bootstrap`, …), the step says so and
  names the wiring, but does not run it (owner answer 7).

**Step 3, agent.**

- If `herdr agent get <bead>` finds an agent of that name in another pane, the step stops rather than
  loop: "an agent named berean-o-1 already runs in w3:p1 (an earlier dispatch of t1?): close it, or
  `hpipe dispatch --task t1 --pane w3:p1` to brief that one".
- Otherwise: `herdr agent start <bead> --kind claude --pane <pane> --timeout 80000 --
  --dangerously-skip-permissions --effort <WORKER_EFFORT[tier]>`. That is the line `startAgentCommand`
  prints (`unstarted.ts:107-110`), plus `--timeout`, run under `runBounded` (`spawn.ts:61`) with a
  90 s bound. herdr returns once the agent is ready.

**Step 4, brief.**

- The step re-reads the task from the ledger first. A `working` event, or an earlier run, may already
  have settled it.
- It then requires `isAgentReady` (idle or done) and a **recognised, empty** input box:
  `inputBoxText(withoutFaintText(…))` (`screen.ts:20`) returning `''`.
  - `null` means no box is on screen (a dialog or a boot screen): "not ready: `herdr pane read <pane>`".
  - Text means a brief may be sitting there unsubmitted: "the input box of w5:p1 holds text: `herdr
    pane read w5:p1`; if it is the brief, `herdr agent send-keys w5:p1 ctrl+c`, then run this again".
- An agent reading `working` already has the brief, so the pane is recorded and the step is done.
- Then it runs `cmdDispatchTask`'s body from the usage-limit read on (`cli.ts:950-992`): claim, render,
  `agentPromptConfirmed` (30 s, `--until working`), and record the pane.
- Why the box, and not memory of an earlier send: the manual path's rule after an uncertain send is
  "`herdr pane read` before retrying — a retry sends the brief twice" (`cli.ts:974-982`). A worker
  cannot finish research in the seconds since a send, so the three cases above cover it.

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

A skipped step reads `worktree   w5 at /…/feat-reader-menu exists (pane w5:p1) — skipped`. A failure
ends `stopped t1 at <step>: <why>. <how to resume>`; §2.4 lists them.

### 2.3 Locks, signals, and the one deadline

**The lock.** It lives at `<stateDir>/dispatch/<beadsSlug(repo_key)>.lock`, one per repo, so it
crosses sessions. It is created with `O_EXCL` and holds `{ pid, started_at_ms, run_id, task,
bootstrap: { pgid, started_at_ms } | null }`, and the bootstrap field is written when the script
starts.

- **A held lock** refuses a second dispatch in the repo: "t1 is being dispatched by pid 4242; wait for
  it, or use `--ready` for several". Bootstraps in worktrees of one repo share its `.git/config`, so
  even different tasks wait.
- **A lock whose pid is dead,** or whose start time (`processStartedAtMs`, `pidfile.ts:15`) differs,
  is stale.
- **Taking over a stale lock** with a recorded bootstrap:
  - if the group leader's start time matches the record, the group is provably the dead dispatch's,
    so it gets SIGTERM, then SIGKILL after 10 s;
  - if a process with that pgid exists but cannot be shown to be ours, the command refuses: "process
    group 4321 may be an earlier dispatch's bootstrap: check `ps -g 4321`, stop it, then run again";
  - otherwise the lock is taken over.
- **The manual `--pane` form** takes no lock: it runs no bootstrap.

**Signals.** SIGTERM, SIGINT and SIGHUP are trapped. The handler:

1. sends SIGTERM to the bootstrap's group, then SIGKILL after 10 s;
2. kills a running `agent start` child;
3. removes the lock;
4. prints `stopped t1 at <step>: interrupted`, and exits 128+n.

An `agent start` that herdr finishes anyway is found by step 3 on the next run. SIGKILL cannot be
trapped, which is why the lock records enough to clean up after it.

**The one deadline.** In the background the command may take as long as its tasks need, so pass 1's
overall budget and `--ready`'s "5 minutes left" rule are gone. The bootstrap keeps a deadline as a
safety net: 20 minutes, then SIGTERM to the group and SIGKILL 10 s later. Without it, a bootstrap that
hangs on a prompt for input or a stalled download would hold the repo's lock for good, and nobody
watches a background shell. When it fires, the step says so without "fix what it names": "the
bootstrap did not finish within 20 minutes and was stopped, with everything it started. If it really
takes longer, run it by hand in the background, `(cd '<checkout>' && ./.claude/pipeline-bootstrap)`,
then the block's `herdr agent start` line, then `hpipe dispatch --task t1`". That last run finds the
agent in the pane and skips step 2. A hand run writes no `bootstrapped` record (only the CLI does), so
the agent in the pane is what tells the re-run the bootstrap is done.

### 2.4 Failures, and how to resume

| Stops at | Typical cause | The message | A re-run |
|---|---|---|---|
| base | origin unreachable | the fetch error | starts again |
| worktree | the branch exists at an unrelated commit; herdr refuses (path taken, unreadable `worktree list` and a checkout that exists) | herdr's code and message, or the branch refusal | starts again |
| pane guard | the workspace is not the task's linked worktree; the pane is another task's or an orchestrator's; several panes | which check failed, and `--pane` | starts again; nothing was started |
| bootstrap | exit ≠ 0 | the log tail, "fix what it names" | runs it again (it did not succeed, so nothing was recorded) |
| bootstrap | the 20-minute deadline | the hand route (§2.3) | runs it again unless an agent is in the pane |
| agent | `agent_not_ready` (a dialog, seen once on the orchestrator's own start, `2026-09-24-live-smoke-run.md:31`); the name taken elsewhere; the 80/90 s bound | the code, and `herdr pane read <pane>` | skips worktree and bootstrap; starts the agent unless one is in the pane |
| brief | bd refuses the claim; usage limit; not ready; text in the box; `agent_prompt_stalled`/`timeout` | as `cmdDispatchTask` says today, plus the readiness and box cases | step 4's rules decide whether it sends |

`--ready` also stops at the first failure. A bootstrap that fails one way usually fails the same way
for every task. Its last line names what was dispatched, where it stopped, and what was not started.

`invalid_agent_argument` cannot come from step 3, since the brief never rides on `agent start`. It is
still shown verbatim if herdr returns it.

### 2.5 What the orchestrator and the skill now say

- **`hpipe task`** (`cli.ts:745-772`) and the supervisor's `Dispatch tN` prompt (`tasks.ts:380-388`)
  print one new line above the block: `dispatch: hpipe dispatch --task t1 (run it in the background)
  — runs the steps below and stops at the first failure; the block is the manual fallback`. Both keep
  the `base:` line, the block and the brief.
- **`dispatch.md`.** "When you are told a task is ready" now says:
  - run `hpipe dispatch --ready` (or `--task <id>`) with `run_in_background`, then end your turn;
  - read its step lines when the completion notice arrives;
  - on a stop, fix what it names and run it again;
  - only one dispatch runs per repo at a time.

  The manual block follows, under "If you must do it by hand", with its facts condensed: the base,
  never putting the brief on `agent start`, emptying the input box, `--cwd`, bootstrapping.
- **`intake.md` step 4.** "Run the block as printed" becomes "register every task, then `hpipe
  dispatch --ready` in the background". "The `base:` commit is fixed when it is registered" becomes
  "when it is dispatched", because the command fetches at dispatch.
- **Advice texts.**
  - `remainingDispatchSteps` and `briefCommand` (`unstarted.ts:57-59,194-198`) serve only the briefed
    phase, so they lead with `hpipe dispatch --task tN`.
  - `dispatchWorkerCommand` and `startWorkerCommand` (`unstarted.ts:174-188,244-254`) lead with it only
    on their briefed-phase branch (`phase === queued.onClear` with the brief owed).
  - Their other branches keep today's text: the paneless `land-queue`, and rewinds into `implement`.
- **SKILL.md.**
  - "Running a batch" step 3 is the one command in the background, with the block as fallback.
  - The ground rule names `hpipe` as the one permission dispatch needs.
  - Recovery gains "`hpipe dispatch` stopped at <step>: fix what it names, run it again".
- **README.** "Use" says `hpipe dispatch --task`/`--ready`, run in the background, with `--pane` and
  the block as the fallback. **Permissions** gains:

  > `hpipe dispatch` runs `herdr worktree create` and `herdr agent start … --dangerously-skip-permissions`
  > itself, so allowing `hpipe` allows starting workers that skip permissions, and auto mode's classifier
  > sees only `hpipe dispatch --task t1`, never the `agent start` inside it. `herdr worktree create` and
  > `herdr agent start` are needed only for the manual fallback.

## 3. Shared paths

### 3.1 The file

`.claude/pipeline-shared-paths`, at the repo root on the default branch:

- One path prefix per line. `#` starts a comment that runs to the end of the line, and blank lines
  are skipped.
- A leading `./` or `/` is stripped, as in `alwaysReviewPrefixes`.
- A line with a glob character (`*?[{`) is **ignored**, and so is one that comes out empty (`/`, `.`,
  which would share the whole repo). `start` warns about each.
- Prefixes are plain prefixes, as `--files` are, so `docs/file-formats` also matches
  `docs/file-formats-old/x`.

`SHARED_PATHS_REL` and `sharedPathPrefixes(text): { prefixes, ignored }` live in a new
`src/lib/shared-paths.ts`.

### 3.2 When it is read

**Once, at `hpipe start`.** `cmdStart` reads the file with `fileAt(repo_root, <commit>,
SHARED_PATHS_REL)` (`sync-walk.ts:98`). The commit is `freshDispatchBase(repo_root, [], null)`'s for a
per-task run. For a single-PR run it is the default-branch commit `planBatch` already fetched, which is
the batch's base.

```ts
interface SharedPaths { prefixes: string[]; ignored: string[]; commit: string | null; ref: string; read_at: number; error?: string }
Run.shared_paths?: SharedPaths    // absent: no shared paths, today's behaviour
```

- **A failed read** stores `error` and no prefixes, and `start` warns. Locking everything is today's
  behaviour, which is the safe side.
- **A failed fetch** for a per-task run reads the stale commit, and says "may be stale".
- **`start` is never refused** over this file.

**Why a snapshot, with no refresh** (owner answer 9).

- **Shrinking.** Remove a path mid-run while two tasks are past the file gate editing it, and both
  now "hold" a locking path. That breaks the invariant single-PR leans on: two overlapping tasks are
  never both past `blocked-on-files` (single-PR design §3).
- **Per-task reads.** A list read per registration would let t1 treat a path as locking and t2 as
  shared, so the overlap test would stop being symmetric.

**A file changed mid-run** takes effect at the next `start`, and status names the snapshot's commit so
that this shows. The file itself is an ordinary path: not implicitly shared, and a task declaring it
locks it. `reviewCall` (`review-skip.ts:161`) adds it beside `ALWAYS_REVIEW_REL`, so an edit to it is
always reviewed: it changes how every later run locks.

### 3.3 The lock

`lockingFiles(run, task)` is `task.files` minus every entry that starts with a shared prefix. An entry
broader than a shared prefix still locks: `docs/` claims the rest of `docs/` even when
`docs/file-formats.md` is shared. Every overlap test runs on locking files. The signatures change so
that the type checker finds every call site, and the gate and the texts describing it cannot disagree:

| Function | Change | Call sites |
|---|---|---|
| `fileHolders(task, all)` | → `fileHolders(run, task)` | `status.ts:257,417`, `bead-desired.ts:93`, `stall.ts:127`, `tick.ts:148` |
| `filesClearFor`, `releasableFromFiles(all)` | → `(run, …)`; the released-set check overlaps on locking files too | `tasks.ts:667` |
| `filesOverlap` | unchanged (pure prefixes); callers pass locking files | `cli.ts:777` (`overlapNote`) |

- **Widening.** `widenFromPlan` (`tasks.ts:487-501`) still adds shared entries to `task.files`, and
  its log line marks them: `plan widened files by docs/file-formats.md (shared, not locking)`.
- **A task whose entries are all shared** locks nothing, and passes `blocked-on-files` on arrival.

### 3.4 Conflicts on a shared path

Two tasks now edit one file at once, so a conflict there is expected, not a sign that `--files` was
wrong. The existing flows resolve it. A `{{shared_note}}` is supplied once, by `changePromptVars`
(`change-prompt.ts:121`), which every task render site spreads, and by `mergePromptVars` and
`syncPromptVars`. It is empty when the task declares no shared path.

| Prompt | Note | Why |
|---|---|---|
| `implement.md` | "`docs/file-formats.md` is shared: other tasks edit it at the same time. Keep your change to it self-contained — add your own section, never reflow or reorder anyone else's — so a merge stays mechanical." | Prevents most conflicts |
| `merge.md` (per-task), and `before-merge.md`'s mergeable step | "This task declares the shared `docs/file-formats.md`, and t6 (merged) declares it too, so this PR may conflict there. Rebase onto the default branch and keep both sides' additions; CI runs again on the rebased head. If the two additions collide in meaning — the same id, number or section — do not resolve it by hand: `hpipe rewind <run> implement --task t2`, so the worker redoes its addition on top of t6's and it is reviewed." | The generic rebase advice (`merge.md:5-8`) gets a named likely cause. A mechanical union is per-task's existing stance on a rebase at merge (CI checks it). A semantic collision is new code, so it goes back through the worker |
| `sync.md` (single-PR) | "`docs/file-formats.md` is shared, so a conflict there is expected: keep both sides' additions. If they collide in meaning — the same id, number or section — do not resolve it: raise it with `hpipe decide`, recommending that the task go back to `implement`; the orchestrator rewinds it." | Any resolution makes the sync dirty, so it is reviewed (single-PR §3). A semantic collision is better redone by the worker than patched in a merge commit |

`merge-batch.md` gets no note: a landing is a fast-forward, with nothing to resolve.

### 3.5 What shows

- **`start`:** `shared: docs/file-formats.md, CHANGELOG.md — from .claude/pipeline-shared-paths at
  1fb8a43c (origin/main as just fetched); never locked`, plus a `⚠` per ignored line. With no file,
  nothing.
- **`hpipe task`:** `files: src/reader/, docs/file-formats.md (shared)`. `overlapNote` names only
  locking overlaps.
- **`hpipe show`:** `files:      src/reader/, docs/file-formats.md (shared)`.
- **`hpipe status`:** the run header gets `shared: docs/file-formats.md (from 1fb8a43c)` when the list
  is non-empty. Blocked-on-files lines are unchanged, but are computed on locking files.
- **Beads:** `blockerBeads` follows `fileHolders`, so a shared-only overlap draws no blocker edge.

## 4. Testing

### Unit

| File | Covers |
|---|---|
| `before-merge.test.ts` (new) | Binding sets per mode. Void per mode: per-task terminal with no merge (`failed`, an unmerged `orphaned`, `done` by rewind), and a merged task rewound to `failed` that stays binding; single-PR no landing, and a task that landed then was abandoned staying binding. Each row of the §1.4 table. A gate head absent after a rewind. `waitsOnlyOnTheHuman` with a check waiting on a fix. `heldForTheHuman` |
| `machine-task.test.ts` | Per-task `merge`: merged and owed records once and returns null; then resolved goes to `close`; a moved head goes to `ci` with the check owed again on re-entry. `execute` holds while a merged task owes a check |
| `machine-ship.test.ts` | `ship-merge`: merged and owed records once and returns null, so `evaluateRun` renders no prompt; later ticks skip the head rules; resolved goes to `done`; a fix-task landing moves the gate head and re-owes a confirmation |
| `stall.test.ts` | No candidate for a held `merge` or `ship-merge`, however long open. A candidate for a single-PR check waiting on a fix, with its clause. The per-task `merged` clause's held and merged-while-held forms never contain "merge it" or `gh pr merge`. A candidate once nothing is owed. A ladder re-armed by `confirm` probes a full threshold later |
| `cli-commands.test.ts` | `answer --before-merge`: repeated, empty refused, one save, `--by orchestrator` allowed. `hold`: task and run; refused per-task without `--task`, single-PR `--task` after landing (pointing at the run check), after a merge recorded **or reported by a stubbed gh**, when gh fails, from any session run's worker pane, with `HERDR_PANE_ID` unset, beside a supervisor without the capability; at an open gate it replaces the queued merge prompt. `confirm`: the window per mode (refused in `pr-review`, `ship`, and in `ci` before a head); `--by` other than human; the live read and a moved branch; no live read after a merge; `--waive` with no head; per-task `--failed` from `ci` and from `merge` to `implement`, recording the PR head with `check-failed` queued and no counter; single-PR `--failed` stays, and is refused on a moved head; `--failed` after a merge refused; the last ruling queues the gate prompt (not after a merge) and re-arms the ladder. Every gh and git read happens once across stale retries (a counting stub, as `askedOnce`'s tests do). `rewind` to `close`/`teardown`/`done`/`orphaned` refused while owed. `close` refused while held. `abort` lists what is owed |
| `status.test.ts` | Every line in §1.8, including the `execute` backstop line. The `files:` lines and the `shared:` header in §3.5 |
| `bead-desired.test.ts`, `beads-sync.test.ts` | A held per-task task is `blocked` + awaiting-human, merged or not, never `closed`. The comment markers. `callsFor` drops a check comment on a closed bead and posts a releasing ruling before the close. `waitsOnClose` ignores a held task |
| `deliver.test.ts`, `tasks.test.ts` | The gate prompt is `before-merge.md` while owed and the normal one after. Its mergeable step per mode, and the shared-path note. `{{before_merge}}` in `ship-merge.md`. The done notice line |
| `prompts.test.ts` | `before-merge` and `check-failed` declared. Every edited prompt renders in both modes with no unresolved token (`answer`, `merge`, `ship-merge`, `sync`, `implement`, `dispatch`, `intake`, `decision`, `ship`), and `before-merge` has no token a common bag also supplies |
| `dispatch-steps.test.ts` (new) | Fresh: all steps in order. Resume from each stop. Step 1: herdr lists the checkout (skip), git only (`open`), neither (`create`), an unparseable `worktree list` (`create`, never a skip), the branch-exists refusal, several panes. The pane guard: the wrong workspace, a non-linked worktree, the wrong branch or path, an orchestrator pane, another task's pane — each stops before `agent start` is called. Step 2: run in the new checkout, `bootstrapped` recorded and honoured, a new workspace re-runs it, an unwired script not run, not executable. Step 3: the name held elsewhere stops without retrying; `--timeout 80000` passed. Step 4: re-read ledger, not ready, a `null` box, a box with text, `working` recorded. `--ready` order and stop at first failure. Refusal on a socket mismatch |
| `dispatch-lock.test.ts` (new, real processes) | The per-repo lock refuses a second dispatch; a dead pid is taken over; a provably-ours orphaned group is killed, and an unprovable live group refused. SIGTERM to a running `hpipe dispatch` kills a sleeping fake bootstrap's whole group (SIGTERM, then SIGKILL) and removes the lock. The 20-minute deadline (shortened in the test) stops it with the hand-route message, not "fix what it names" |
| `herdr.test.ts` | `worktreeCreate`/`worktreeOpen`/`worktreeList`/`agentStart` read the envelope from stdout or stderr (`herdr.ts:97-107`); `worktreeList` returns "unknown" on any shape it cannot read |
| `cli-argv.test.ts` | The four `dispatch` forms; `--ready` with `--task` refused; free-text `--before-merge`/`--waive`/`--failed` |
| real git, temp dir | `git worktree list` detection, the existing-branch refusal, and `start` reading the shared file at the fetched commit, a missing file, and an unreadable ref |
| `shared-paths.test.ts` (new) | The parser: comments, blanks, globs and empty prefixes ignored, normalisation |
| `gating.test.ts` | `lockingFiles`. A shared-only overlap does not hold; a broader prefix still does. `releasableFromFiles` with shared entries. Symmetry |
| `unstarted.test.ts`, `stall.test.ts`, `status.test.ts` | Briefed-phase advice leads with `hpipe dispatch --task`. The paneless `land-queue` and rewound-`implement` advice is unchanged |

### Wiring tests

Two of the changes touch gating, so each gets a wiring test shaped like `single-pr-wiring.test.ts`: a
real ledger in a temp state dir, the real CLI functions, and the supervisor's real step functions
(`advanceTasks`, `evaluateRun`, `stallCandidates`, `taskStallCandidates`, `applyStalls`). Only herdr,
gh and Beads are faked.

- **`before-merge-wiring.test.ts`.**
  - **Per-task.** A task answered with `--before-merge` reaches `merge`, and the orchestrator's prompt
    is the hold. With the clock moved past three `TASK_STALL_MINUTES`, `applyStalls` sends nothing.
    The fake gh reports the PR merged, and the task stays in `merge` with its merge recorded.
    `rewind … done --task` is refused. `cmdConfirm` (no live read) queues nothing, and the next tick
    goes `merge → close`.
  - **Single-PR.** `cmdHold` at intake, and the run reaches `ship-merge` with the hold prompt.
    `cmdConfirm --failed` keeps it there, and the stall probe is the fix form. A push moves the gate
    head, so the check waits on the human again. `cmdConfirm` queues `ship-merge.md`, and the merge
    lands the run in `done`.
- **`shared-paths-wiring.test.ts`.** `cmdStart` on a temp repo whose bare origin carries the file,
  then three `cmdTask`s:
  - t1 and t2 share only the listed path, and both reach `implement` on the same tick;
  - t3 overlaps t1 on a locking path, and waits;
  - `formatStatus` and `formatTaskDetail` agree with the gate.

Dispatch changes no gating, so its unit and process tests drive the step runner. The live run is where
herdr proves it.

### Live smoke (`victorstein/hpipe-smoke`, a fresh `pipesmokeN` session)

New runbook sections. Set `STALL_MINUTES=2` and `TASK_STALL_MINUTES=3` in the plugin's `config.env`, so
a probe that should not come would come within minutes.

**§11 Before-merge checks.**

- **Old supervisor.** With the previous release's supervisor running, `hold` is refused, naming its
  pid. Restart it.
- **Per-task, a decision answered with `--before-merge`:**
  - `confirm` in `pr-review` is refused.
  - At `merge`, the orchestrator gets the hold prompt, which leads with the mergeable step and has no
    `gh pr merge`.
  - Status shows "waiting on the human". The bead is `blocked` + `hpipe:awaiting-human` with the
    comment.
  - No probe comes for 10 minutes.
  - `confirm` → the merge prompt within a tick, and the first probe no sooner than one threshold
    later.
  - A push after confirming sends the task `merge → ci`, and it comes back held, with "confirmed on X;
    the head is now Y".
  - `--failed` in `merge`: the worker pane gets `check-failed`, then the fix, review, CI and the hold
    again.
  - Merge the PR by hand while held, then before the supervisor's next idle tick, `hold --task` on the
    same task: refused as merged (GitHub asked). The task stays in `merge` with the ⚠ line and an open
    bead. `rewind … done` and `close` are refused. `--waive` → `close → done`, and the waiver comment
    is on the bead before it closes.
- **Single-PR:**
  - `hold` at intake. `ship-merge` is held with no probes. Confirming during `ship-ci` holds when CI
    passes on that head.
  - A `BEHIND` batch PR: the hold prompt has `gh pr update-branch` run first, the run goes back through
    `ship`, and the human is asked about the new head.
  - `abort` on a held throwaway run lists the check.

**§12 One-command dispatch.**

- Three tasks, `hpipe dispatch --ready` with `run_in_background`, and the orchestrator ends its turn.
  The completion notice carries the step lines. One pane per workspace, briefs confirmed, every task
  bound within a tick.
- A bootstrap that exits 1 stops at step 2. Fix it and re-run, and the worktree is skipped.
- Break `agent start` after a good bootstrap (start an agent named after the bead in another pane
  first). The step stops, naming that pane. Close it and re-run: the bootstrap is skipped
  (`bootstrapped`).
- A second `dispatch --task` for another task in the repo is refused by the lock.
- `kill -TERM <hpipe pid>` during a slow bootstrap: `ps -g <pgid>` is empty within 10 s, and the lock
  is gone.
- `hpipe forget` the task's workspace, then close that workspace and re-run. Nothing starts in a pane
  that is not the task's worktree.
- A pre-existing branch that lacks the base is refused.
- From a pane of another session, the command is refused.
- With auto mode on, `hpipe dispatch` needs no separate `herdr agent start` approval. Record it.
- **Record** the `worktree create` and `worktree list` JSON, verbatim (Verify 1–2).

**§13 Shared paths.**

- `.claude/pipeline-shared-paths` on `main` lists `docs/registry.md`, plus a glob line. `start` prints
  the `shared:` line and the glob warning.
- t1 and t2 declare `docs/registry.md` with disjoint code, and both implement at once. t3 overlaps a
  locking path and waits.
- Per-task: t2's merge prompt names the shared path and t1, and the orchestrator rebases and resolves.
  Make the two additions collide (the same heading): the orchestrator rewinds t2 to `implement`, as
  the note says.
- Single-PR: the second landing's sync is dirty, and it goes back through review.
- Editing the file mid-run changes nothing in this run.

Treat any difference from the runbook as a finding, not a test to make pass.

## 5. Rollout

**One release, 2.2.0**, from three branches merged in this order:

1. shared paths, the smallest, which changes gating;
2. dispatch, which is CLI-only;
3. before-merge checks.

Each branch gets its own review. The release PR is merged once, after all three. Each feature PR title
is conventional (`feat(gating): …`, `feat(dispatch): …`, `feat(merge): …`), and release-please makes
one minor bump from them. Each branch updates README, SKILL.md and `test/integration/smoke.md` in the
same PR as its code.

**Upgrading** gets one paragraph. Restart the supervisor in every session with a run in flight, as for
every release.

- **A new CLI beside a 2.1 supervisor.**
  - `hold` and `answer --before-merge` refuse until the supervisor is restarted (the `before-merge`
    capability).
  - `start` with a shared-paths file warns that the running supervisor will lock those paths anyway
    (the `shared-paths` capability). That is stricter, so it is safe.
  - `dispatch --task` works, since it is CLI-only. The old supervisor's `Dispatch tN` prompt just lacks
    the new line.
- **Runs started on 2.1** have no `shared_paths`, and keep locking everything until they finish.
- **Rolling back to 2.1.**
  - The fields are ignored, not removed. A run with a check owed loses its hold: 2.1 sends the merge
    command and probes as before. Confirm or waive every owed check before rolling back, or tell the
    human that the hold is gone.
  - Shared paths lock again, which is stricter, so it is safe.
  - `bootstrapped` is ignored.

## Verify before implementing

Each needs the real tool, so the smoke run settles it.

1. The `herdr worktree create` response: where the workspace id, `root_pane.pane_id` and
   `worktree.path` sit. The plugin only ever names the last two (`unstarted.ts:114-115`).
2. The `herdr worktree list` JSON: does each entry carry its path, branch, workspace id and whether it
   is linked, and does it take `--cwd`? Step 1 fails closed on any shape it cannot read, so a wrong
   guess costs a refused re-run, never a wrong skip.
3. `herdr worktree open --branch` on a checkout with no workspace: its response shape.
4. `herdr agent start`: that `--timeout` is in milliseconds, and the error codes for a name in use and
   for a dialog.
5. Claude Code's background Bash: no foreground timeout, a completion notice on exit, and which signal
   reaches a background command when the session ends. The traps and the deadline cover any answer.
6. `gh pr view --json mergeStateStatus` values for a PR behind its base, a conflicting PR, and one
   blocked on a review.

## Rejected

| Alternative | Why not |
|---|---|
| A new task phase (`held`) between `ci` and `merge`, and a run phase before `done` | A change to `phases.ts`, and so to runs on disk. On a rollback, `taskRow` throws in the old supervisor's tick for every run in the session. The gate rows already carry the right signals |
| A single-PR task check gating the task's landing | It holds the one landing slot for a human (§1.3) |
| `--by orchestrator` for `confirm` | The check is the owner's. One the orchestrator can make belongs in the answer |
| Confirmations at any time (pass 1) | A ruling far from the gate covers a head that will not merge, and a per-task failure there had no exit (MAJOR 2) |
| Refusing to record a merge made while held | It is GitHub's fact. Leaving it unrecorded strands the bead's close and the dependents' bases, and status would lie |
| Reminders while held | Owner answer 2, and #22 |
| A per-task run check gating every merge to come | One confirmation cannot cover several heads |
| The supervisor running the dispatch | The serial tick, minute-long bootstraps, and a failure nobody reads |
| A dispatch record file (pass 1) | A forgotten or reused workspace makes it stale, and a stale one started an agent that skips permissions in an unrelated pane (BLOCKER 1). herdr's own list and the pane guard replace it |
| A 9-minute overall budget (pass 1) | It existed only to fit the foreground timeout. In the background, only a hung bootstrap needs a bound |
| Bootstraps in parallel under `--ready` | Contention on one machine and on one `.git/config`, and interleaved failures |
| A unique agent name per start | Status, the advice texts and `herdr agent list` all name the worker by its bead. A taken name is stopped and named instead |
| Running an unwired `bin/bootstrap` | Owner answer 7 |
| Re-reading shared paths every tick, or at each registration | §3.2 |
| Cutting shared-path globs to their prefix | It widens sharing (§3.1) |
| Recommending `merge=union` for append-only shared files (pass 1) | `git merge-tree --write-tree` honours it only through the working tree's `.gitattributes`, and where it applies it would turn a shared-path sync clean and skip the dirty-sync review |
| Treating a conflict on a shared path as a clean sync | The resolution is code no reviewer has seen (single-PR §3) |

## Open questions

1. **The bootstrap's 20-minute safety deadline** is a guess. berean-os's bootstrap has never been
   timed inside `hpipe`. A bootstrap that needs longer takes the hand route every time, and making the
   deadline configurable would need the CLI to read `config.env`, which it does not today.
2. **The per-repo dispatch lock spans sessions.** Two sessions with runs on one repo, rare but legal,
   cannot bootstrap at the same time. That is the point of the lock, but `--ready` in one session can
   then refuse the other for minutes.

## Files this change declares

- `src/cli.ts`
- `src/lib/{types,before-merge,shared-paths,dispatch-steps,gating,machine,status,awaiting,bead-desired,unstarted,herdr,check,bootstrap,change-prompt,review-skip,pidfile}.ts`
  (`before-merge`, `shared-paths` and `dispatch-steps` are new)
- `src/supervisor/{tasks,deliver,stall,tick,main,beads-sync}.ts`
- `prompts/`: `before-merge.md` and `check-failed.md` are new. Edited: `answer.md`, `merge.md`,
  `ship-merge.md`, `ship.md`, `sync.md`, `implement.md`, `decision.md`, `dispatch.md`, `intake.md`
- `README.md`, `skills/herdr-pipeline/SKILL.md`, `test/` (§4), `test/integration/smoke.md`

## After the pass-1 review

| Finding | What changed |
|---|---|
| **BLOCKER 1**: a stale dispatch record could start an agent that skips permissions in an unrelated pane | The record file is gone. Step 1 asks `herdr worktree list`, matched on path and branch, and fails closed on output it cannot read. A pane guard before `agent start` requires herdr's linked worktree at the task's checkout on `task.branch`, and runs the orchestrator-pane and other-task-pane checks there (§2.2) |
| **MAJOR 2**: a per-task "waiting on a fix" had no exit, and the merge probe said "merge it" | Rulings are accepted only near the gate: per-task in `ci` or `merge` (or after its merge), single-PR in `ship-ci` or `ship-merge`. The judged head is `ci_head`. A per-task `--failed` sends the task to `implement` at once, unmerged only. The per-task `merged` clause gets held forms that never say "merge" (§1.6, §1.7) |
| **MAJOR 3**: a per-task run could reach `done` with a check owed | Per-task void is now "terminal **and** no merge recorded". Rewinds past `merge` and `hpipe close` are refused while owed, and per-task `execute` holds while a merged task owes a check (§1.4, §1.5) |
| **MAJOR 4**: the CLI read a lagging `merged_at_ms` | Ask GitHub once, before the retried save (`askedOnce`). Fail closed. A GitHub-merged PR counts as merged for `hold`, `answer --before-merge` and `confirm` (§1.6) |
| **MAJOR 5**: the hold prompt skipped the conflict and rebase step | `before-merge.md` leads with making the PR mergeable (`mergeStateStatus`, rebase or `update-branch`, the bootstrap re-run, the shared-path note), and only then asks the human to check that head (§1.5) |
| **MAJOR 6**: a killed dispatch left its bootstrap and lock behind | Signals are trapped (bootstrap group SIGTERM then SIGKILL, lock removed). The lock is per repo and records the pid, its start time and the bootstrap's group, and a takeover kills only a provably-ours group. The orchestrator runs dispatch in the background, and a 20-minute bootstrap deadline is the safety net (§2.3) |
| **MAJOR 7**: the recovery case (b) was only half cut | Removed from §2.1, the steps, §2.5 and the tests. The advice texts lead with the command only on their briefed-phase branch (§2.5) |
| **MINOR 8**: `--failed` recorded the gate head | It records the PR head as just read, as `withSendBackHead` does (§1.6) |
| **MINOR 9**: step 4 could send to an agent not ready for it | It needs `isAgentReady` and a recognised empty box (a `null` box is a dialog), and re-reads the task first (§2.2) |
| **MINOR 10**: `agent start` had no timeout, and a taken name could loop | `--timeout 80000` inside a 90 s `runBounded`. A name held by an agent in another pane stops with that pane named (§2.2) |
| **MINOR 11**: the bootstrap was looked up in the wrong checkout; a cut printed "fix what it names" | It is looked up in the new checkout. The deadline message gives the hand route. SIGTERM comes before SIGKILL (§2.2, §2.3) |
| **MINOR 12**: network reads inside the stale retry | Every `remoteBranchHead`/`prView` read for `hold`, `answer` and `confirm` happens once, before the retried save (§1.6) |
| **MINOR 13**: comments desired on closed beads | `callsFor` drops a check comment on a closed bead. The run's record covers the rest (§1.9) |
| **MINOR 14**: the shared-path note invited resolving semantic collisions by hand | The merge note says `rewind … implement` for a collision in meaning, and the sync note says raise it with `hpipe decide` (§3.4) |
| **MINOR 15** | The hold prompt's tokens are `held_*`. The record-only tick returns null on both gates. `close` is refused while held. A single-PR `hold --task` after landing points at the run check. The worker-pane refusal covers every run's bound panes in the session and refuses without `HERDR_PANE_ID`. Dispatch requires `HERDR_SOCKET_PATH === run.socket_path` (§1.2, §1.5, §2.1) |
| Scope cuts | The `merge=union` advice and its Verify item are gone (Rejected). Pre-gate confirmations are gone except in `ci`/`ship-ci`. The record file is gone |
| Open questions 1–9 | Answered by the owner and folded in: see "The owner's answers to pass 1's open questions". Verify 5 of pass 1 (`bd comment` on a closed bead) is gone with MINOR 13 |

**Not resolved by this pass.** Two judgement calls remain as Open questions: the 20-minute bootstrap
deadline, and the cross-session lock. Six tool facts remain as Verify items, chiefly the JSON shapes
of `worktree create` and `worktree list`.
