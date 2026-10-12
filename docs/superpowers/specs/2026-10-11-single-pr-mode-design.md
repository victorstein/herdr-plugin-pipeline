# Single-PR batch mode — design

Pass 1, not yet reviewed. Written against `bb48694`, the `fix/live-run-bugs` tip, which carries the
head-SHA CI fix for finding #16 that this design reuses.

A run can now ship as **one PR**. `hpipe start --single-pr` gives the run a **batch branch** cut from
origin's default branch. Each task branches from the batch branch and is reviewed on its branch diff,
with no PR of its own. A task **completes when the orchestrator merges its branch into the batch
branch**. Once the last task has landed, the branch review runs. Then the orchestrator opens one PR
from the batch branch to the default branch. CI runs on that PR alone, and its squash merge ships as
one release whose notes list every task. The orchestrator picks the mode per run. Today's
PR-per-task mode stays the default and does not change.

**Why.** Finding #23 (`docs/superpowers/notes/2026-10-11-berean-os-live-run.md:328-338`). A 7-task
berean-os batch shipped as six releases, v1.29.10–v1.29.15. #257 and #258 merged about 40 s apart.
The back-to-back merges raced release-please, so #258 is in none of the six release notes. The owner
wants each batch to ship as one release. The workaround that worked by hand was "stack every task's
PR onto one integration branch, merge once with a `BEGIN_COMMIT_OVERRIDE` block". Asked how a task
should land, the owner chose: merge into a batch branch, with no per-task PR and no per-task CI.

**On-disk format change.** `phases.ts` gains three run phases and a per-row `modes` filter. A
single-PR run carries a new `Run.batch` object, and its tasks a `Task.submission`. A single-PR run is
written as **`schema_version: 4`**. Per-task runs stay at **3**, and the new code reads both (§5).
So every v3 run in flight carries on across the upgrade, and rolling back leaves v3 runs readable.
An older supervisor or CLI ignores a v4 run rather than driving it as a per-task run. **After
upgrading, restart the supervisor before the first `--single-pr` start.** An old supervisor beside
a new CLI would leave the new run silently unadvanced.

## Evidence

| Fact | Source |
|---|---|
| release-please replaces a merged PR's commit message with the lines between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` in the PR body. One block can hold several messages, one per line. The body can be edited after merging, and the next run reads it | release-please `README.md`, "How can I fix release notes?" |
| The override "will not work with plain merges". The README recommends squash merges | same section; "What if my PR contains multiple fixes or features?" |
| GitHub's merge endpoint, `POST /repos/{owner}/{repo}/merges`, takes `base`, `head` and `commit_message`. It answers 201 with the merge commit, 204 when already merged, 404 when a branch is missing, and 409 on a conflict | GitHub REST docs, "Merge a branch" |
| The CI result is tied to the PR head. It stays pending while any workflow run on that head is unfinished, and for 60 s after a new head appears | `src/lib/gh.ts:85-105`, `src/supervisor/ci.ts:6-36` |
| `merge` is a level, and a head that moves after CI passed sends the task back to `ci` | `src/lib/machine.ts:227-241` |
| The pipeline fetches the dispatch base itself because "an instruction can be skipped and this cannot". The base is a commit, so a new branch tracks nothing | `src/lib/dispatch-base.ts:5-15` |
| A dependent waits for its dependency's `done`, and its base must contain the dependency's `merge_commit` (an ancestry check) | `src/lib/gating.ts:7`, `src/lib/dispatch-base.ts:189-246` |
| Every tier passes through at least one PR-review row, and each review row commits and pushes its verdict to the task branch | `src/lib/phases.ts:138-146`, `prompts/pr-review.md:19-22` |
| The file lock is held from `implement` to `done` | `src/lib/phases.ts:133-164`, `src/lib/gating.ts:129-135` |
| Adoption measures what a branch added against origin's default branch only | `src/supervisor/deliver.ts:255-261` |
| The supervisor, run resolution and bead claimants all skip runs whose `schema_version` they do not know | `src/supervisor/main.ts:224-227,447-449`, `src/lib/ledger.ts:317-321,373`, `src/lib/held.ts:94` |
| `prForBranch` lists open PRs by head branch | `src/lib/gh.ts:78-83` |

## Decisions

| Question | Decision |
|---|---|
| How the mode is chosen | `hpipe start "<title>" --single-pr [--batch-branch <name>]`. Without the flag the run is per-task, as today |
| Where it is recorded | `Run.batch`. A run is single-PR exactly when this field is present. `start`, `status` and `show` print it |
| Can it change after start | No. There is no command for it. Abort and start again, which costs nothing before the first dispatch |
| Batch branch name | `--batch-branch`, or `batch/<run id without its repo prefix>` by default |
| Who creates the batch branch, and from what | The CLI, during `start`. It pushes the freshly fetched default-branch commit as the new branch, with no local checkout. Every task base depends on that branch, so creating it is not left to the orchestrator |
| A task's `base:` | The freshly fetched head of `origin/<batch>`. Dependencies need nothing new |
| How `implement` ends | `hpipe submit --task tN --title "<conventional title>"`. It is the worker's equivalent of opening the PR |
| Reviews | The same rows and tiers, run on `git diff origin/<batch>...origin/<branch>` |
| Per-task CI | None. The `ci` row is per-task only |
| Landing | The orchestrator merges the branch into the batch branch with GitHub's merge API: a merge commit, never a squash. The supervisor sees the landing once the branch head is an ancestor of `origin/<batch>` |
| When a task is complete | When it lands. Its bead closes "landed on `<batch>`", the file lock goes at `done`, and the worktree is torn down, all as after a PR merge today |
| Run end | `branch-review` (when 2 or more tasks landed) → `ship` → `ship-ci` → `ship-merge` → `done` |
| Final PR | The orchestrator opens it, with a body the plugin renders: one override line per landed task. The orchestrator squash-merges it |
| Red CI on the final PR | The run goes back to `ship` with the failure. No task is chosen automatically |
| Schema | Single-PR runs are `schema_version: 4`, per-task runs stay at 3, and the new code reads both |

## 1. Choosing the mode

`--single-pr` takes no value: add it to `VALUELESS_FLAGS` (`src/cli.ts:1491`). `--batch-branch`
takes one. The title is the positionals left once these and `--prefix` are removed
(`src/cli.ts:1579`). `USAGE.start` (`src/cli.ts:1455`) names both flags. `--batch-branch` without
`--single-pr` is refused.

`cmdStart` (`src/cli.ts:195-244`) adds one step between the Beads setup and `saveRun`. Any failure in
it leaves nothing saved:

1. Check that `origin` exists; single-PR mode needs a remote to open a PR on. Find and fetch the
   default branch with the code dispatch already uses (`fetchBase`, `dispatch-base.ts:159-185`). A
   fetch error refuses the start: a stale base would put work that is already on the default branch
   into the batch PR.
2. Name the branch. Check it with `git check-ref-format --branch`, and refuse the default branch's
   own name.
3. Run `git ls-remote --heads origin <name>`:
   - No such branch: create it with `git push origin <commit>:refs/heads/<name>`.
   - The branch exists at exactly that commit: adopt it. This is a retry of a `start` whose save
     failed.
   - The branch exists at any other commit: refuse, and say why.

   Both network calls get the 15 s budget and `networkEnv` that dispatch uses
   (`dispatch-base.ts:27,71-77`).
4. Record `run.batch` (§5) and write the run as `schema_version: 4`.

It prints `batch: <name> at <sha8> (origin/<default> as just fetched) — this run ships as one PR
into <default>` above the intake prompt. `intake.md` gains a `{{mode_note}}` paragraph that is empty
for a per-task run. For a single-PR run it says three things:

- Tasks land on the batch branch.
- `--files` still serializes overlapping work.
- Nothing reaches the default branch until the final PR merges.

**Why the mode never changes.** A task dispatched per-task was cut from the default branch, and its
prompts open PRs into it. Each task in a single-PR run was cut from the batch branch, so it carries
its siblings' commits. Either switch would leave tasks already dispatched under the old rules.

## 2. The batch branch as every task's base

- `freshDispatchBase(repoRoot, merges, now)` (`dispatch-base.ts:205-220`) gains a `branch` argument,
  set to the batch branch for a single-PR run and null otherwise. It fetches that branch instead of
  the default one, and its cache (`:187`) is keyed by repo **and** branch. It is called from
  `tasks.ts:215`, `cli.ts:565`, `cli.ts:658` and `main.ts:340`. The `base:` line already names the
  ref, `origin/batch/… as just fetched`, so `dispatch.md:17-25` holds as written.
- `dependencyMerges` (`dispatch-base.ts:239-246`) does not change. In a single-PR run a task's
  `merge_commit` is the batch head on which its landing was seen (§3). That head contains the
  dependency, so the ancestry check still forces a fresh fetch whenever the cached base lacks it.
- `hpipe task --branch` refuses the batch branch's name and the default branch's name.
- **Adoption.** `mainlineRefs` (`deliver.ts:255-261`) adds the local and remote-tracking refs of the
  batch branch. Without them, every sibling doc already merged into the batch branch reads as this
  branch's own addition, and a stray research or spec file is adopted or reported as ambiguous.
  `adoptableArtifacts` (`deliver.ts:208`) therefore takes the run's batch branch as an argument.

## 3. The task's path

| Row | Per-task (unchanged) | Single-PR |
|---|---|---|
| `queued` … `plan-review` | — | Unchanged, apart from the adoption refs in §2 |
| `blocked-on-files` | — | Unchanged |
| `implement` | Clears once the worker is idle, a PR is open, and its head has moved past `head_sha_at_entry` (`machine.ts:199-206`, `tasks.ts:313-326`) | Clears once the worker is idle and a `submission` recorded at or after phase entry has a head different from `head_sha_at_entry`. The prompt adds a sync step at the start and ends with `hpipe submit` |
| `pr-review`, `-intent`, `-quality` | Reviews `gh pr diff <pr>` | Reviews `git diff origin/<batch>...origin/<branch>`. The tiers are the same. A send-back reads the branch head with `git ls-remote` instead of the PR head (`tasks.ts:427-439`) |
| `ci` | Waits for CI on the PR head | **Skipped**: the row carries `modes: ['per-task']` |
| `merge` | The orchestrator merges the PR. The row is a level on "PR merged", and a moved head sends the task back to `ci` | The orchestrator lands the branch on the batch branch. The row is a level on ancestry (below), with no head rule because there is no CI. Prompt: `merge-batch.md` |
| `close` | The bead closes after the merge is recorded | The same, with a close reason naming the batch branch |
| `teardown` | Removes a checkout that is pushed to `origin/<branch>` or to the PR head | Also accepts a head contained in `origin/<batch>` |
| `blocked-on-decision`, `escalated`, terminal rows | — | Unchanged |

The task phase set does not change. No task row is added or renamed, so bead phase labels
(`bead-desired.ts:21`) and the board look the same in both modes. `pr-review` keeps its name in a run
that has no PRs (see Rejected).

### `hpipe submit`

`hpipe submit --task tN --title "<conventional title>" [--run <id>]`. The worker runs it from its own
worktree at the end of `implement`, where a per-task worker would open the PR. It refuses in each of
these cases:

| Refuses when | Because |
|---|---|
| The run is per-task | — |
| The task is not in `implement` | — |
| The title is not one line matching `^[a-z]+(\([^()\s]+\))?!?: \S` | It becomes a release-note line, and a non-conventional line is silently dropped, which is #23 again |
| `git ls-remote origin refs/heads/<branch>` differs from the checkout's `HEAD` | The work is not pushed: "push first" |
| The pushed head equals `head_sha_at_entry` | "nothing pushed since the review sent it back" |
| The pushed head is already an ancestor of the freshly fetched `origin/<batch>` | "nothing to land: `<branch>` has no commit that `<batch>` lacks". Without this, the `merge` level below would fire the moment the task entered it |

On success it records `task.submission = { title, head_sha, at }` under `retryOnStaleRun`. The
`implement` edge reads only the ledger, with no git or gh call per tick. A submission older than the
phase entry is ignored, so a re-entry needs a new submit. Re-submitting replaces the title.

### Landing detection

The CI poller runs every `CI_POLL_SECONDS` (`main.ts:270-273`). For each single-PR run that has a
task in `merge`, it also runs one `git fetch origin` with refspecs for `<batch>` and each such task's
branch, through an extended `fetchFromOrigin` (`dispatch-base.ts:226-231`).

`gatherSignals` for `merge` (`tasks.ts:388-396`) then reads only local refs. It is landed when
`git merge-base --is-ancestor refs/remotes/origin/<branch> refs/remotes/origin/<batch>` holds. It
then returns `merged: true`, `mergedAtMs: now` and `mergeCommit: <batch head>`. The row stays a level
and gated on the orchestrator being idle (`tasks.ts:234-239`), as today.

The level cannot fire early, for three reasons:

- `submit` refuses a head the batch branch already contains. Every review after it pushes a verdict
  commit on top (`pr-review.md:19-22`). So a head that has passed review has a commit the batch
  branch lacks until it lands. The one exception is a force-push of the task branch back to an older,
  contained commit, which no prompt asks for.
- If the orchestrator lands an older head and the worker has pushed since, the current head is not
  contained, so the task waits for a second landing. That is correct: the newer commits were never
  landed.
- `bead_closed_at_ms` and the dependency base go by this landing, never by the clock. An observed
  timestamp is enough (`beads-sync.ts:134-136`).

### Merging, conflicts and the file lock

`merge-batch.md` gives the orchestrator one command, rendered in full with the title shell-quoted
(`unstarted.ts:86`):

    gh api repos/{owner}/{repo}/merges -f base=<batch> -f head=<branch> \
      -f commit_message='<submission title>

    Refs <bead>'

This merges on GitHub, so no checkout of the batch branch is needed. It always makes a merge commit,
which keeps the ancestry the landing check reads. The other responses:

- **204** (already merged): the task has landed.
- **409** (conflict): in the task's checkout (it still exists: teardown comes after landing), run
  `git fetch origin <batch> && git merge origin/<batch>`. Resolve, re-run the bootstrap and the
  tests, push the branch, and run the merge again.

The prompt forbids squashing into, rebasing or force-pushing the batch branch. A squash cannot be
detected, and a rewritten batch branch breaks every later base.

**Sync before implementing.** In a single-PR run, `implement.md` starts with
`{{sync_step}}`: `git fetch origin <batch> && git merge --no-edit origin/<batch>`, then re-run the
bootstrap if the merge changed what it builds, then push. The lock serializes overlapping tasks from
`implement` to `done`. So the merged batch head holds everything an overlapping sibling landed, no
overlapping sibling can land while this task implements, and this task's landing is conflict-free on
its declared files. A 409 is left only where `--files` was wrong.

Two side effects:

- With no `ci` row, the lock is held for review and landing only. This shortens #18's serialisation
  without changing lock semantics.
- Per-task mode has the same stale-checkout gap: a worker released from `blocked-on-files`
  re-reads files that the sibling's merge has not reached (`implement.md:38-41`). That is out of
  scope here; see Out of scope.

**Residual risk, stated.** A conflict resolution made during `merge` lands without review or CI
until the final PR. Per-task mode has the same exposure: a rebase at merge re-runs only CI. The
prompt has the orchestrator run the tests in the task's checkout before it retries.

### What "complete" means for a task

| | Single-PR |
|---|---|
| Bead | Closed at landing. `merged_at_ms` makes the desired status `closed` (`bead-desired.ts:111-113`). `closeReason` (`beads-sync.ts:63-65`) becomes `landed on <batch> (<sha8>); ships with the batch PR into <default>` |
| File lock | Released at `done`, after `close` and `teardown`, as today |
| Worktree | Torn down by the `teardown` row. `isPushed` (`teardown.ts:139-150`) also accepts a head contained in `origin/<batch>`, because no PR head exists and the orchestrator may have deleted the task branch |
| Dependents | Gate on `done` as today (`gating.ts:7`), and are cut from a batch head that contains the landing |
| The code on the default branch | Only once the final PR merges. `status` and the run's `done` notice say so (§6) |

## 4. The run's end

| Row | Actor | Signal | onClear | onBlocker | Modes | Notes |
|---|---|---|---|---|---|---|
| `execute` | — | gate | `branch-review` | — | both | When exactly 1 task landed, it goes to the row after `branch-review` for its mode: `done` per-task, `ship` single-PR (`machine.ts:80`). When 0 landed it escalates, as today |
| `branch-review` | orchestrator | verdict | `ship`, then mode-filtered (`done` per-task) | itself | both | Single-PR prompt variant below |
| `ship` (new) | orchestrator | pr | `ship-ci` | — | single-PR | Prompt `ship.md`, or `ship-ci-red.md` on re-entry from `ship-ci`, as `implement` picks `ci-red` (`tasks.ts:142-150`). Stallable |
| `ship-ci` (new) | — | ci | `ship-merge` | `ship` | single-PR | `counter: 'ship-ci'`; the probe target is the orchestrator. Stallable |
| `ship-merge` (new) | orchestrator | merged | `done` | — | single-PR | A head that moves after CI passed goes back to `ship-ci`, the `machine.ts:236-240` rule. Stallable |
| `escalated`, `done` | | | | | both | `done`'s notice is extended (§6) |

`branch-review`'s static `onClear` becomes `ship`. A new `nextRunPhase(mode, row)` skips rows outside
the run's mode, exactly as `nextPhase` skips tiers (`phases.ts:199-205`). So a per-task run still
goes `branch-review → done`.

**`branch-review` in a single-PR run.** `{{scope}}` replaces `branch-review.md:7-10`: review
`git diff origin/<default>...origin/<batch>`, which is exactly what the final PR will carry, rather
than the run's merged PRs. The line "you patch the branch directly" (`branch-review.md:53-54`) names
the batch checkout (below).

**The batch checkout.** Patching the batch branch and running its combined tests needs a checkout,
and the orchestrator's own checkout is the user's working copy. So the single-PR prompts name a path
the plugin owns: `$HERDR_PLUGIN_STATE_DIR/checkouts/<run_id>`. The first prompt that needs it
creates it with `git -C <repo_root> worktree add <path> <batch>` and runs the bootstrap there. Later
prompts run `git -C <path> pull --ff-only`. The `done` notice prints `git -C <repo_root> worktree
remove <path>`.

### `ship`: open the final PR

`ship.md` asks the orchestrator to:

1. In the batch checkout, pull, bootstrap, and run the repo's tests and typecheck. This is the one
   local run of the combined tree, and it catches interaction failures before CI does. If anything is
   red, dispatch a subagent with `model: {{implement_model}}` to fix it, verify, commit and push.
2. If `origin/<default>` has moved and `git merge-tree --write-tree origin/<default> origin/<batch>`
   reports conflicts, merge `origin/<default>` into the batch branch, resolve, test and push.
3. Run `gh pr create --base <default> --head <batch> --title "<title>" --body-file <body>`.

The title must be conventional for PR-title lint. Release-please ignores the title once the override
is present. The prompt suggests one: the strongest type among the submitted titles (`feat` > `fix` >
`perf` > `refactor` > the rest, with `!` when any title has it), then the run's title in lower case.

The body file is `$STATE/runs/<session>/<run_id>.batch-pr.md`, beside the `.discoveries/` directory.
It is rewritten every time the `ship` prompt renders:

    <run title>: one PR for run <run_id>

    | Task | Bead | Change |
    |---|---|---|
    | t1 | berean-o-1 | fix(reader): close the menu without re-rendering |
    …
    Not in this PR: t5 (berean-o-5) stopped at failed.        ← only when some task did not land

    Refs berean-o-1, berean-o-2, …

    BEGIN_COMMIT_OVERRIDE
    fix(reader): close the menu without re-rendering
    …
    END_COMMIT_OVERRIDE

The lines are each landed task's `submission.title`, in landing order (`merged_at_ms`). The prompt
says not to edit the block, except to add one line for a user-visible change the orchestrator made
itself in step 1 or 2, or at `branch-review`.

The `ship` row clears like `implement`. The orchestrator must be idle. `prForBranch(<batch>)`
(`gh.ts:78-83`) must find the PR, which is recorded as `run.batch.pr`. And the PR head
(`prView`) must differ from `run.batch.head_sha_at_entry`, which is null on first entry.

### `ship-ci`: CI once, on the final PR

`ciTransitions` (`ci.ts:13-36`) also polls each single-PR run in `ship-ci` with a PR. The
per-head bookkeeping moves into one helper used for both a task and a run's batch, so it has the
same three properties:

- the bucket is tied to `headSha`;
- a new head resets the 60 s settle (`CI_SETTLE_MS`, `ci.ts:11`);
- `ship-ci` is entered with `batch.ci = null`, as `machine.ts:117` does for a task.

On **fail**, the counter `ship-ci` is bumped. At `MAX_PASSES` the run escalates. Otherwise the run
goes to `ship`, with `head_sha_at_entry` set to a fresh PR-head read, which is the
`withSendBackHead` reasoning (`tasks.ts:416-426`).

### Red CI on the final PR

No task is picked automatically. By then every task is torn down with no worker, and attributing a
failure to a task by its `--files` is a guess. `ship-ci-red.md` inlines the failing checks
(`gh.ts:107-116`) and gives the orchestrator three routes:

| Failure | Route |
|---|---|
| Environmental | Push an empty commit to the batch branch. A `gh run rerun` does not move the head, as `ci-red.md:10-13` says for tasks |
| A defect fixable in place | A subagent fixes it in the batch checkout. The orchestrator verifies and pushes. The head moves, so `ship` clears back to `ship-ci` |
| A defect that needs a worker | Run `hpipe rewind <run> execute`. Then `hpipe task …` registers a fix task (it is registrable in `execute`, `cli.ts:237`), then `hpipe dispatch --done`. The fix task is cut from the batch head, is reviewed and lands. The run goes `execute → branch-review → ship`. The PR is already open, and the landing moved its head, so `ship` clears at once |

### `ship-merge`: the one merge

`ship-merge.md` says three things:

- Squash-merge the PR with `gh pr merge <n> --squash`. Squash is what makes release-please read the
  override, and a merge commit makes it read the batch's commits one by one instead.
- Leave the block alone.
- This is the last point at which any check that a decision ruled "before merge" can still be done.
  That is #17/#24; recording such checks is out of scope.

The row clears on `prView(...).merged`, and records `batch.merged_at_ms` and `batch.merge_commit`.
The run goes to `done`.

## 5. Ledger and phase table

```ts
interface Batch {
  branch: string
  /** The default branch at start: the final PR's base. */
  into: string
  base_commit: string
  pr: number | null
  head_sha_at_entry: string | null
  ci: CiBucket | null
  ci_head?: { sha: string; seen_at: number }
  merged_at_ms: number | null
  merge_commit: string | null
}
Run.batch?: Batch                                   // present ⇔ single-PR
Task.submission?: { title: string; head_sha: string; at: number }
```

A single-PR task reuses `merged_at_ms` and `merge_commit`, which mean "landed on the batch branch".
`pr` and `ci` stay null. `hasLanded` (`ledger.ts:308-309`) and `landedTaskCount` therefore work
unchanged.

**Phase table.**

- `PhaseRow` gains `modes?: readonly RunMode[]`, where `RunMode = 'per-task' | 'single-pr'` and
  `modeOf(run)` reads `run.batch`.
- `ci` gets `modes: ['per-task']`. `ship`, `ship-ci` and `ship-merge` get `modes: ['single-pr']`.
- `nextPhase(tier, from)` becomes `nextPhase({ tier, mode }, from)`. Its call sites are
  `machine.ts:177,195,204`, `tier-prompt.ts:36` and `tick.ts:187`. The last one
  (`workerStillNeeded`) therefore takes the run, and in a single-PR run a worker is no longer needed
  once its task is past the reviews.
- `phaseLoop`'s `LOOP_END = 'ci'` (`tier-prompt.ts:8`) becomes "the first row after `implement` the
  worker does not own" (`ci` or `merge`). `tierPromptVars(task)` becomes `tierPromptVars(run, task)`
  at `tasks.ts:114,578` and `worker-prompt.ts:30`.
- `rewind` refuses a phase whose row's `modes` exclude the run's mode. A single-PR task left in `ci`
  would wait forever for CI on a PR that does not exist, because `ci.ts:20` skips `pr === null`.
  Tiers only warn about this (`cli.ts:915-919`); modes must refuse.

**Schema.** `SCHEMA_VERSION = 3` stays, and `BATCH_SCHEMA_VERSION = 4` is added. `newRun` writes 4
exactly when it is given a batch. `isCurrentSchemaRun` (`ledger.ts:22-24`) accepts either.
`beadClaimants` (`held.ts:94`) gets the same treatment, so a single-PR task's bead is known as
claimed. `beadHolds` (`held.ts:67-81`) already reads every schema.

Why the batch runs and not everything:

- Bumping every run to 4 would strand every v3 run in flight behind `abort`. Earlier specs rejected
  that for that reason (`2026-09-18-issue-19-design.md:852`).
- Leaving batch runs at 3 would let an older supervisor drive one as a per-task run. Its prompts
  would have a worker cut from the batch branch open a PR into the default branch, carrying every
  sibling's commits.

Version 4 makes such a run invisible to old code instead, which is the failure the README already
documents for a bumped schema.

## 6. What the orchestrator sees

**`hpipe status`.** Under the run header it prints one `ships as one PR:` line, plus a move line in
the orchestrator's rows:

| Run phase | Added line | Whose move |
|---|---|---|
| `intake` … `execute` | `ships as one PR: batch/x → main · 3 of 7 landed` | As today, per task |
| A task in `merge` | The task line: `… [merge 4m] … — YOUR move: waiting for t3-branch to be merged into batch/x` | The orchestrator |
| `branch-review` | As above | As today |
| `ship` | `… · final PR: not opened` and `YOUR move: test the batch and open its PR (the ship prompt has the command)` | The orchestrator |
| `ship-ci` | `… · PR #301 ci:pending (on 9e06c261)` | Nobody |
| `ship-merge` | `… · PR #301 ci:pass` and `YOUR move: squash-merge PR #301` | The orchestrator |
| `done` | `shipped: PR #301 squash-merged as 1a2b3c4d`, or, when aborted, `not shipped: batch/x holds 3 landed tasks (t1, t2, t4) that are not on main; their beads are closed` | — |

In a single-PR run the task line drops the `PR #`/`ci:` bits (`status.ts:451-452`).
`formatTaskDetail` (`status.ts:501-531`) prints four fields:

    pr:         none (single-PR run: lands on batch/x)
    submitted:  fix(reader): … (at 9e06c261, 12m ago)
    landed:     batch/x at 1a2b3c4d
    ci:         n/a — CI runs once, on the batch PR

**Wording.** `awaitedFor(task)` (`awaiting.ts:13-38`) becomes `awaitedFor(run, task)`. In a
single-PR run, `pr` reads "a submitted branch for <branch> (<bead>)", and `merged` reads "<branch>
to be merged into <batch>". The stall clauses at `stall.ts:326-357` gain single-PR forms (the
`merged` form carries the land command), and run-level forms for `ship`, `ship-ci` and `ship-merge`.
`ESCALATING_SIGNALS` (`stall.ts:20`) holds `pr`, so an unanswered `ship` escalates the run, as an
unanswered `branch-review` does. `ship-ci` and `ship-merge` are standing nudges, like their task
counterparts.

**`done` notice** (`deliver.ts:461-467`). It names the final PR and its squash commit. It also
prints the clean-up commands: `git push origin --delete <task branches>`, since GitHub deletes only a
PR's own head branch on merge, and the batch-checkout removal.

**Board and Beads.** No new labels, and run phases are not mirrored on beads. A task's bead goes
`closed` at landing, with the batch close reason. Discoveries are still filed at `branch-review`.

## 7. Failure, abort, resume, rewind

| Situation | What happens |
|---|---|
| `start` cannot push the batch branch | The start is refused. No run and no branch exist. A retry after a push that landed adopts the branch (§1) |
| The batch branch is force-pushed or deleted mid-run | Unsupported, and every prompt that touches it says so. Dispatch then reports `fetch failed` on its `base:` line (`dispatch-base.ts:252-260`). Landings stop being seen until the branch is restored from `refs/remotes/origin/<batch>` |
| The worker never runs `submit` | `implement` stays put. The stall probe names `hpipe submit`. `pr` escalates, as today |
| The landing is a 409 | The orchestrator resolves it in the task's checkout (§3). The task stays in `merge` until its head is on the batch branch |
| The final PR is closed unmerged | `ship-merge`'s probe says "PR #n is closed". Reopen it, or `hpipe rewind <run> ship` with `run.batch.pr` cleared, so that `prForBranch` (open PRs only) finds the next one |
| `hpipe rewind <run> <phase> --task tN` | As today, plus: rewinding to `implement` or earlier also deletes `submission`, next to `pr`/`ci` (`cli.ts:941-946`). Rewinding to `merge` or earlier still reopens the bead (`cli.ts:947-951`). A rewind cannot take work off the batch branch: rework lands on top, and reverting means a commit |
| `hpipe rewind <run> ship-ci` | Clears `batch.ci`, as a task rewind into `ci` does (`cli.ts:954`) |
| `hpipe rewind <run> execute` from a ship phase | Allowed. `batch.pr` is kept, so the open PR picks up later landings (§4) |
| `hpipe abort` | The run is parked in `done`, as today. The batch branch and any open final PR are left alone. Landed beads stay closed, and unlanded ones are released with `aborted` (`bead-desired.ts:114-116`). `status` prints the `not shipped:` line |
| `hpipe resume` | Unchanged |

## 8. Prompts, skill, README

New prompts:

| File | For |
|---|---|
| `prompts/merge-batch.md` | Landing a task |
| `prompts/ship.md` | Testing the batch and opening the final PR |
| `prompts/ship-ci-red.md` | Red CI on the final PR |
| `prompts/ship-merge.md` | Merging the final PR |
| `prompts/handoff-pr.md` | Fragment: the end of `implement` in a per-task run (today's step 4 wording) |
| `prompts/handoff-batch.md` | Fragment: the end of `implement` in a single-PR run (push, then `hpipe submit`) |

The two fragments are rendered and injected as `{{handoff}}`, the way `dispatch-registering.md`
becomes `{{registering}}` (`deliver.ts:435-436`).

Edited prompts. Each token is supplied by one spread, `changePromptVars(run, task)`, at every task
render site, so `render()` (`render.ts:11`) never meets an unresolved one:

| Prompt | Change |
|---|---|
| `implement.md` | `{{sync_step}}` at the top, `{{handoff}}` for step 4, and `{{reply_place}}` replaces "the PR body" (`:10,15`). In a single-PR run it reads "an empty commit on the branch whose message answers it" |
| `pr-review.md`, `pr-review-intent.md`, `pr-review-quality.md` | `{{subject}}` (`PR #12`, or `` `t3-branch` against `batch/x` ``) replaces `PR #{{pr}}`. `{{diff_command}}` replaces `gh pr diff {{pr}}`. "the PR's head" becomes "the branch head". A single-PR reviewer also reads `git log origin/<batch>..origin/<branch>` for the worker's replies |
| `worker-brief.md` | "not into this PR" becomes "not into this change" (`:14`). The PR-body bullet (`:73-77`) becomes `{{handoff_rule}}` |
| `branch-review.md` | `{{scope}}` (§4) |
| `intake.md` | `{{mode_note}}` (§1) |

`test/prompts.test.ts:19-23` declares the new files. `fix/effort-by-tier` and
`fix/orchestrator-guidance` edit the same review prompts and `intake.md`, so whichever lands second
rebases.

**Skill.**

- In "Running a batch", step 1 names `--single-pr`, and when to use it: the batch should ship as one
  release.
- "While it runs" gains three rows: "Ready to land tN on batch/x" (run the printed `gh api` command;
  on 409, merge the batch into the task branch in its checkout), "Ship batch/x" and "Squash-merge the
  batch PR".
- "Recovery" gains red final CI (the three routes in §4) and "never rewrite the batch branch".

**README.** A "One PR per batch" section under **Use** covers:

- the flag and the batch branch;
- `hpipe submit`;
- landing and the final PR;
- why it is a squash with an override block;
- clean-up.

Upgrading gets one paragraph: v4 runs, and restart the supervisor first.

## 9. Tests

| File | Covers |
|---|---|
| `table.test.ts` | Every tier walks `queued → ci` per-task and `queued → merge` single-PR, through `implement` and never through `ci`. Every task row a single-PR route reaches has a prompt. A row that carries `modes` is the `onBlocker` only of rows whose `modes` are a subset. `nextRunPhase` gives `done` per-task and `ship` single-PR after `branch-review` |
| `machine-task.test.ts` | `implement` clears on a fresh submission and ignores a stale one (older than the phase entry) and one equal to `head_sha_at_entry`. `merge` clears on a landing (a level), records `merge_commit`, and has no `ci_head` rule in a single-PR run |
| `machine-run.test.ts` | `execute` with 1 landed goes to `ship` (single-PR) or `done` (per-task). `branch-review` CLEAR goes to `ship`. `ship` clears on a PR whose head moved. `ship-ci` pass goes to `ship-merge`, and fail goes to `ship` with the counter, escalating at max. `ship-merge` clears on merged, and a moved head goes back to `ship-ci` |
| `ci.test.ts` | A run in `ship-ci` is polled, with the same settle and head reset as a task |
| `tasks.test.ts` | `gatherSignals` for `merge` and the send-back in a single-PR run, with injected `branchHead`/`isAncestor` |
| `dispatch-base.test.ts` | The batch branch is fetched, and the cache is keyed by branch |
| `cli-commands.test.ts` | `start --single-pr`: creates the branch, adopts an identical one, refuses a different one or the default name, and saves nothing when the push fails. `task --branch <batch>` is refused. `submit`'s refusals. `rewind` refuses a phase outside the mode and clears `submission` |
| `ledger.test.ts`, `held.test.ts` | v4 runs are read, v4 claimants are counted, and v3 behaviour is unchanged |
| `teardown.test.ts` | `isPushed` accepts containment in the batch branch |
| `status.test.ts`, `stall.test.ts` | Every line in §6 |
| `prompts.test.ts` | Every new and edited prompt renders in both modes with no unresolved token |

**Live smoke.** A new section in `test/integration/smoke.md`. This change touches startup (the push
in `start`), gating (the dispatch base) and delivery (the new prompts), and unit fakes have passed
over live-only bugs here before. So it is verified in a `pipesmokeN` herdr session against
`victorstein/hpipe-smoke`, with a just-restarted supervisor:

1. `hpipe start --single-pr "smoke batch"`. Check that the branch exists on origin and that status
   prints the `ships as one PR` line.
2. Register t1 and t3 (disjoint `--files`), and t2 (`--depends-on t1`, overlapping t1's files).
   Check:
   - every `base:` is the batch head;
   - the workers submit;
   - the reviews read the branch diff;
   - the `gh api` merge answers 201, and `git cat-file -p` on the merge commit shows two parents;
   - the landing is recorded within one poll;
   - the bead closes with the batch reason;
   - the worktree is torn down;
   - t2's base contains t1's landing, and t2's sync step merges it.
3. Force a 409 between two tasks whose declared `--files` are disjoint, and follow the resolution
   path.
4. `branch-review` reads the batch diff. `ship` writes a body with three override lines and opens
   the PR. `ship-ci` stays pending until the head's runs finish. Push a failing test to the batch
   branch once to see `ship-ci → ship → ship-ci`. Then squash-merge.
5. If hpipe-smoke runs release-please, there is one release PR listing all three entries. If it does
   not, record that the release-notes check is still owed on the next real batch.
6. With the previous release's supervisor running, start a `--single-pr` run from the new CLI.
   Expect the run to be ignored, not driven.

Treat any difference from this list as a finding, not a test to make pass.

## Verify before implementing

1. GitHub's merge endpoint makes a two-parent commit even when a fast-forward is possible, and the
   `{owner}/{repo}` placeholders resolve from the repo's cwd. If it fast-forwards, landing is still
   detected by ancestry. Only the merge-commit subject is lost, and the override lines come from the
   ledger, not from git.
2. release-please honours an override block that is in the PR body at squash time, in the release
   run that the merge triggers.
3. `gh pr list --head batch/x` finds a PR whose head branch name contains a slash.

## Rejected

| Alternative | Why not |
|---|---|
| Per-task PRs into the batch branch | It reuses the PR, CI and merge rows almost unchanged, so it is the least code. But the owner chose no per-task PR, and CI would still run once per task wherever workflows trigger on `pull_request`, which is the cost being removed |
| The supervisor auto-merges a task once its review clears | "Merging is yours, not the plugin's; nothing merges automatically" (`merge.md:13`, README). It would skip the orchestrator's conflict check and any before-merge condition (#17/#24), put a network write on the serial tick, and still need an agent for a 409 |
| The supervisor opens the final PR | A failed `gh pr create` in the tick has nobody to read it. The orchestrator already owns every GitHub-visible step, and the plugin still owns the body |
| Holding each merge until release-please settles (#23's fallback) | Still N releases. It only stops the drops |
| Closing beads only when the final PR merges | The owner defined completion as landing. It would also need a new held state for `done` tasks, so `hpipe next` does not re-offer them, and an ordered close of dependents at the end. See Open questions |
| Squash- or rebase-merging tasks into the batch branch | It loses the ancestry that landing and the dependency base (`dispatch-base.ts:189-196`) rely on |
| Building the override block from the batch branch's first-parent subjects | It depends on how the orchestrator words each merge. `submit` validates the line once, at its source |
| New task phases (`land`, `branch-diff-review`) instead of `modes` | They would put new phase labels on beads and new rows into every v3 reader. Same names with mode-aware prompts keep the task table identical across modes |
| `hpipe mode` to switch mid-run | §1 |
| A per-task local-check row, or `.claude/pipeline-check` | `implement` already makes the worker run the tests and typecheck (`implement.md:21-24`). The supervisor tick is serial. One combined local run happens in `ship` |
| Opening the final PR as a draft at start | Every landing would run CI, which the owner chose against, and a red intermediate run has no owner |
| Bumping every run to schema 4 | §5 |
| Routing a red final CI to the task whose `--files` match | That task is torn down, and the match is a guess |

## Open questions for the owner

1. **When a task's bead closes.** At landing on the batch branch (recommended), or when the final PR
   merges? At landing matches "a task completes when the orchestrator merges its branch into the
   integration branch", and keeps gating, the close guards and teardown as they are. The cost: if a
   batch is abandoned before shipping, its landed beads read as closed for work that never reached
   the default branch. `status` says so, but the board does not. If that matters, a follow-up can
   add an `hpipe:unshipped` label. bd's acceptance of a label change on a closed bead would need a
   spike first.
2. **Default for a red final CI.** Should the orchestrator patch it on the batch branch through a
   subagent (recommended for anything small), or should every fix go through a reviewed fix task?
   The design offers both and recommends patching. The second keeps every line reviewed, at the cost
   of a full research → plan → review cycle for what is usually a one-liner.
3. **Strict "up to date" landing.** Should a task land only when its branch already contains the
   batch head? Then every landed tree is a tree a worker tested. Recommended: no. It serialises
   every landing behind a fresh sync and test, while the file lock plus the sync step already make
   real conflicts rare, and the final CI covers the rest.

## Out of scope

- Before-merge conditions (#17/#24). The `ship-merge` prompt points at them, but nothing records
  them.
- Per-task mode's stale checkout at `implement` after `blocked-on-files`. The single-PR sync step
  fixes it for that mode only.
- Deleting remote task branches automatically.
- A repo with no CI. `ship-ci` would wait forever, as `ci` does today (`gh.ts:38`).

## Files this change declares

`src/cli.ts`, `src/lib/{phases,machine,types,ledger,held,dispatch-base,status,awaiting,tier-prompt,worker-prompt}.ts`,
`src/supervisor/{tasks,ci,deliver,main,stall,teardown,tick,beads-sync}.ts`, `prompts/` (the new and
edited files in §8), `README.md`, `skills/herdr-pipeline/SKILL.md`, `test/` (§9),
`test/integration/smoke.md`.
