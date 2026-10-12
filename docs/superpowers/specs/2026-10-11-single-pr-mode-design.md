# Single-PR batch mode — design

Pass 3: pass 2 plus "After the pass-2 review" at the end, which holds where the two disagree. Pass 2. Written against `bb48694`, the `fix/live-run-bugs` tip, which carries the head-SHA CI fix for
finding #16 that this design reuses. It records the owner's decisions on pass 1's open questions and
answers every finding of `docs/superpowers/reviews/2026-10-11-single-pr-mode-adversarial-1.md`
(traced in "Review findings → this design" at the end).

A run can now ship as **one PR**. `hpipe start --single-pr` gives the run a **batch branch** cut from
origin's default branch. Each task branches from the batch branch and is reviewed on its branch diff,
with no PR of its own. A task **lands** when the orchestrator fast-forwards the batch branch to the
task's reviewed head. It may land only when that head already contains the batch head: a task that
falls behind merges the batch in, re-runs the repo's check, and lands that. Once the last task has
landed, the branch review runs. Then the orchestrator opens one PR from the batch branch to the
default branch. CI runs on that PR alone, and its squash merge ships as one release whose notes list
every landing. The orchestrator picks the mode per run. Today's PR-per-task mode stays the default,
and the only change it sees is one fetch fix (§2).

**Why.** Finding #23 (`docs/superpowers/notes/2026-10-11-berean-os-live-run.md:328-338`). A 7-task
berean-os batch shipped as six releases, v1.29.10–v1.29.15. #257 and #258 merged about 40 s apart.
The back-to-back merges raced release-please, so #258 is in none of the six release notes. The owner
wants each batch to ship as one release. The workaround that worked by hand was "stack every task's
PR onto one integration branch, merge once with a `BEGIN_COMMIT_OVERRIDE` block".

**On-disk format change.** `phases.ts` gains three run phases (`ship`, `ship-ci`, `ship-merge`), two
task phases (`land-queue`, `sync`), and two row fields (`modes`, `anyWorker`). A single-PR run carries
`Run.batch`, and its tasks carry `submission`, `land_sha` and `landed`. A single-PR run is written as
**`schema_version: 4`**. Per-task runs stay at **3**, and the new code reads both (§5). So every v3
run in flight carries on across the upgrade, and rolling back leaves v3 runs readable. Older code
ignores a v4 run rather than driving it as a per-task run. The supervisor's pid file gains `schemas`,
and `hpipe start --single-pr` refuses while this session's live supervisor lacks 4 (§1). That closes
the "silently unadvanced" window pass 1 only documented.

## Evidence

| Fact | Source |
|---|---|
| release-please replaces a merged PR's commit message with the lines between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` in the PR body. One block holds several messages, one per line. "The next time Release Please runs, it will use that override section", so a body edited after the merge still counts | release-please `README.md`, "How can I fix release notes?" |
| The override "will not work with plain merges". The README recommends squash merges | same section |
| One commit can carry several changes: extra conventional messages at the bottom of its body are each an entry | release-please `README.md`, "What if my PR contains multiple fixes or features?" |
| GitHub's merge endpoint, `POST /repos/{owner}/{repo}/merges`, takes only `base`, `head` and `commit_message`. It has no expected-base precondition | GitHub REST docs, "Merge a branch"; the review's B1 |
| A non-force `git push origin <sha>:refs/heads/<batch>` is refused as `non-fast-forward` unless `<sha>` contains the remote head, and goes through once it does | Probed in scratch repos (git 2.54.0), by the review and again for this pass |
| `git fetch origin a b c` fails as a whole, and updates nothing, when one named ref is missing. `git fetch origin <name>` with no destination writes only `FETCH_HEAD` when the remote's fetch refspec does not cover `<name>` | The review's probes (M1) |
| A first-parent walk tells an automatic merge of the batch from anything else. An honest sync passes, with one merge or two. An extra commit fails (one parent), an edit amended into the merge fails (its tree differs from `git merge-tree --write-tree` of its parents), and a hand-resolved conflict fails (`merge-tree` exits 1). `git show --remerge-diff <merge>` prints the resolution | Probed for this pass (git 2.54.0); the review's B1.6 probe agrees |
| A run rewound into `execute`, with intake closed and every task landed, leaves for `branch-review` on the next tick. The rewind writes only the phase (`cli.ts:959-968`). `execute` reads `intake_closed` (`machine.ts:78`), and a `gate` row waits on no idle (`deliver.ts:348-349`) | The review's `advanceRun` probe (M3) |
| `MAX_PASSES` is 2 (`config.ts:31`), and a run rewind zeroes `passes` (`cli.ts:961`) | |
| `cmdStatus` already reads the supervisor's pid file (`cli.ts:1347`). `SupervisorPid` has no capability field (`types.ts:314-321`). The pid file is claimed at `main.ts:161-168` | |
| The CI result is tied to the PR head. It stays pending while any workflow run on that head is unfinished, and for 60 s after a new head appears | `src/lib/gh.ts:85-105`, `src/supervisor/ci.ts:6-36` |
| The pipeline fetches the dispatch base itself because "an instruction can be skipped and this cannot". The base is a commit, so a new branch tracks nothing | `src/lib/dispatch-base.ts:5-15` |
| A dependent waits for its dependency's `done`, and its base must contain the dependency's `merge_commit` (an ancestry check) | `src/lib/gating.ts:7`, `src/lib/dispatch-base.ts:189-246` |
| Every tier passes through at least one PR-review row, and each review row commits and pushes its verdict to the task branch | `src/lib/phases.ts:138-146`, `prompts/pr-review.md:19-22` |
| The file lock is held from `implement` to `done`, so two overlapping tasks are never both past `blocked-on-files` | `src/lib/phases.ts:133-164`, `src/lib/gating.ts:129-135,170-181` |
| A pane lost while the task's route still reaches a worker row fails the task | `src/supervisor/tick.ts:179-219` |
| A `blocked-on-files` task is not probed while its holders are live: the holder has its own ladder (#22) | `src/supervisor/stall.ts:115-118,137` |
| The normal teardown is `herdr worktree remove --force`, which checks nothing. `isPushed` guards only the fallback for a workspace herdr has forgotten | `src/lib/herdr.ts:208`, `src/supervisor/teardown.ts:176-214` |
| Adoption measures what a branch added against origin's default branch only | `src/supervisor/deliver.ts:255-261` |
| The supervisor, run resolution and bead claimants all skip runs whose `schema_version` they do not know | `src/supervisor/main.ts:224-227,447-449`, `src/lib/ledger.ts:317-322,373`, `src/lib/held.ts:94` |
| `prForBranch` lists open PRs by head branch | `src/lib/gh.ts:78-83` |

## Decisions

### The owner's decisions

These are final. Pass 1's three open questions are closed by 3, 4 and 5.

| # | Decision | Where |
|---|---|---|
| 1 | The mode is per run, chosen by the orchestrator. Per-task PR mode stays the default | §1 |
| 2 | Tasks land by merging into a batch branch, with no per-task PR. CI runs once, on the single final PR to the default branch, which ships as one release | §3, §4 |
| 3 | A task's bead closes when the task lands on the batch branch | §3 |
| 4 | Red CI on the final PR: by default the orchestrator patches small fixes on the batch branch through a subagent. Bigger defects go through a new fix task, so the fix-task route must work | §4 |
| 5 | Landing gate: **yes**. A task may land only when its branch already contains the current batch head. When another task lands first, the waiting ones sync (merge the batch in), re-test and push before landing | §3 |

### Design decisions

| Question | Decision |
|---|---|
| How the mode is chosen | `hpipe start "<title>" --single-pr [--batch-branch <name>]`. Without the flag the run is per-task, as today |
| Where it is recorded | `Run.batch`. A run is single-PR exactly when this field is present. `start`, `status` and `show` print it |
| Can it change after start | No. There is no command for it. Abort and start again, which costs nothing before the first dispatch |
| Batch branch name | `--batch-branch`, or `batch/<run id without its repo prefix>` by default |
| Who creates the batch branch | The CLI, during `start`. It pushes the freshly fetched default-branch commit. `start` refuses beside a live supervisor that lacks schema 4, when the repo does not allow squash merges, and when the name exists at another commit |
| A task's `base:` | The freshly fetched head of `origin/<batch>` |
| How `implement` ends | `hpipe submit --task tN --title "<conventional title>"`, the worker's equivalent of opening the PR. It refuses work that is uncommitted, unpushed or already on the batch. It also refuses a title outside the repo's release types, and a branch with an open PR. It runs `.claude/pipeline-check` |
| Reviews | The same rows and tiers, on a freshly fetched `git diff origin/<batch>...origin/<branch>` |
| Per-task CI | None. The `ci` row is per-task only |
| What lands | `task.land_sha`: the branch head when the last review cleared. Only a clean sync advances it. The branch tip is never landed |
| How a task lands | The orchestrator runs `git push origin <land_sha>:refs/heads/<batch>` with no force. GitHub refuses any push that is not a fast-forward, and that refusal is the gate |
| When a task must sync | When `land_sha` does not contain `origin/<batch>`. The worker merges the batch in, pushes, and runs `hpipe submit`, which runs the check |
| How many tasks land at once | One. A landing slot is held through `sync` and `merge`. The other tasks wait in `land-queue`, oldest first, unprompted and unprobed |
| A sync that is not a clean merge | Back through the tier's reviews. Clean means every commit since `land_sha` is a two-parent merge of a batch commit, whose tree equals `git merge-tree --write-tree` of its parents |
| The re-test | `.claude/pipeline-check`, an executable the repo declares beside `.claude/pipeline-bootstrap`, run by `hpipe submit`. With none declared, it falls back to prose and `status` says landings are unverified |
| When a task is complete | When `land_sha` is on `origin/<batch>`. Its bead closes "landed on `<batch>`". The file lock goes at `done`, and the worktree is torn down |
| Release lines | Each landing appends `{ title, land_sha, at }` to `task.landed`, which no rewind clears |
| Run end | `branch-review` (when 2 or more tasks landed) → `ship` → `ship-ci` → `ship-merge` → `done` |
| Final PR | The orchestrator opens it, with a body the plugin renders: one override line per landing. It is squash-merged with a commit message, also rendered by the plugin, that carries the same lines |
| Red CI on the final PR | The orchestrator patches it by default. A bigger defect becomes a fix task registered into the run, which moves the run back to `execute` (§4) |
| Schema | Single-PR runs are `schema_version: 4`, per-task runs stay at 3, and the new code reads both |

## 1. Choosing the mode

`--single-pr` takes no value: add it to `VALUELESS_FLAGS` (`src/cli.ts:1491`). `--batch-branch` takes
one. The identifier check skips `start` (`cli.ts:1545`), so a missing `--batch-branch` value is caught
the way `--prefix` is (`cli.ts:1573-1577`). The title is what is left once `--single-pr`,
`--batch-branch <name>` and `--prefix <prefix>` are removed (`cli.ts:1579`). `USAGE.start`
(`cli.ts:1456`) names both flags. `--batch-branch` without `--single-pr` is refused.

`cmdStart` (`src/cli.ts:195-235`) runs these steps after the one-run-per-repo check (`:200-205`).
Steps 1–5 only read, and they come before the Beads setup (`:207-213`), so a refusal there leaves no
store behind. Any failure leaves no run saved:

1. **The supervisor can drive it** (M4). Read `supervisorState(stateDir, session)`
   (`pidfile.ts:59-71`). If it is `live` and its `schemas` lacks 4, refuse with "the supervisor of
   session `<s>` (pid `<n>`) predates single-PR runs and would never advance this one: close its
   `Pipeline supervisor` pane and run the plugin's `supervisor` action, then start again".
   The README gives the same restart step (`README.md:280-281`). A supervisor that predates this
   change writes no `schemas`, which reads as `[3]`. `none` or `stale` passes: the next supervisor
   started is the installed one, and `status` already prints "nothing will advance until a
   supervisor is running".
2. **origin and the default branch.** Check that `origin` exists. Find and fetch the default branch
   with dispatch's own code (`fetchBase`, `dispatch-base.ts:159-185`, with the explicit refspec of
   §2). A fetch error refuses the start: a stale base would put work that is already on the default
   branch into the batch PR.
3. **The name.** Check it with `git check-ref-format --branch`, and refuse the default branch's name.
4. **Squash merges** (m2). Run `gh repo view --json squashMergeAllowed` from `repo_root`. Refuse on
   `false`: the final PR must be squash-merged for its override block to apply, and the run would
   find that out only at its last step. A `gh` failure refuses too, with gh's error: the run cannot
   open its final PR without gh.
5. **The branch on origin.** Run `git ls-remote --heads origin <name>`. If there is no such branch,
   it is pushed in step 7. If it exists at exactly the fetched commit, adopt it: this is a retry of a
   `start` whose save failed. If it exists at any other commit, refuse, and say why.
6. Beads setup, as today.
7. Push: `git push origin <commit>:refs/heads/<name>`. It comes after the Beads setup, so a Beads
   failure leaves no branch behind.
8. Record `run.batch` (§5), including `checkout = <stateDir>/checkouts/<run_id>` as an absolute path
   (m1), and write the run as `schema_version: 4`.

The network calls share the 15 s budget and `networkEnv` that dispatch uses
(`dispatch-base.ts:27,71-77`).

Above the intake prompt it prints:

    batch: batch/x at 1fb8a43c (origin/main as just fetched) — this run ships as one PR into main
    check: .claude/pipeline-check

With no check declared, the second line reads `check: none — each landing is checked only by its
worker's own test run, and status says so`. `repoCheck(repoRoot)` reports none, ready or
not-executable, mirroring `repoBootstrap` (`bootstrap.ts:21-32`). `intake.md` gains a `{{mode_note}}`
paragraph that is empty for a per-task run. For a single-PR run it says:

- tasks land on the batch branch, one at a time, and each lands only once it contains every
  landing before it;
- `--files` still serializes overlapping work, and a wrong `--files` now costs a re-review at sync;
- nothing reaches the default branch until the final PR merges.

**The supervisor's capability** (M4). `SupervisorPid` (`types.ts:314-321`) gains
`schemas?: number[]`. `claimSupervisor` is passed `schemas: [SCHEMA_VERSION, BATCH_SCHEMA_VERSION]`
(`main.ts:161-168`), and `claimPid` writes it with the rest. `status` flags a v4 run beside a live
supervisor without 4 (§6).

**Why the mode never changes.** A task dispatched per-task was cut from the default branch, and its
prompts open PRs into it. Each task in a single-PR run was cut from the batch branch, so it carries
its siblings' commits. Either switch would leave tasks already dispatched under the old rules.

## 2. The batch branch as every task's base

- `freshDispatchBase(repoRoot, merges, now)` (`dispatch-base.ts:205-220`) gains a `branch` argument.
  It is set to the batch branch for a single-PR run and to null otherwise. It fetches that branch
  instead of the default one, and its cache (`:187`) is keyed by repo **and** branch. It is called
  from `tasks.ts:215`, `cli.ts:565`, `cli.ts:658` and `main.ts:340-346`. The `base:` line already
  names the ref, `origin/batch/… as just fetched`, so `dispatch.md` holds as written.
- **The explicit refspec, in both modes** (M1b). `fetchBase` runs
  `git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>` instead of
  `git fetch origin <branch>` (`dispatch-base.ts:171`). In a clone whose fetch refspec does not cover
  the branch, the old form wrote only `FETCH_HEAD`. Dispatch then printed "as just fetched" for a
  stale local commit, or for none (`:176-184`). This is the one change a per-task run sees.
  Teardown already uses the explicit form (`teardown.ts:143`).
- `dependencyMerges` (`dispatch-base.ts:239-246`) does not change. In a single-PR run a task's
  `merge_commit` is its `land_sha` (§3), which is on the batch branch. So the ancestry check still
  forces a fresh fetch whenever the cached base lacks it.
- `hpipe task --branch` refuses the batch branch's name and the default branch's name.
- **Adoption.** `mainlineRefs` (`deliver.ts:255-261`) adds the local and remote-tracking refs of the
  batch branch, and `adoptableArtifacts` (`deliver.ts:208`) takes the run's batch branch as an
  argument. Without these refs, every sibling doc already on the batch branch reads as this branch's
  own addition. The fork point is `merge-base HEAD <mainlines>` (`:223`), and against
  `origin/<default>` alone that is the batch's base. A fast-forward landing puts no merge on the
  first-parent chain, so `mergeAddedDocsArgs` (`:265-271`) cannot subtract those docs either.

## 3. The task's path

| Row | Per-task (unchanged) | Single-PR |
|---|---|---|
| `queued` … `plan-review` | — | Unchanged, apart from the adoption refs in §2 |
| `blocked-on-files` | — | Unchanged. The lock is now also held through `land-queue` and `sync` |
| `implement` | Clears once the worker is idle, a PR is open, and its head has moved past `head_sha_at_entry` (`machine.ts:199-206`, `tasks.ts:313-326`) | The prompt starts with `{{sync_step}}` and ends with `hpipe submit`. Clears once the worker is idle and an `implement` submission, recorded at or after phase entry, names a head other than `head_sha_at_entry`. Entering it clears `land_sha` |
| `pr-review`, `-intent`, `-quality` | Reviews `gh pr diff <pr>` | Reviews a freshly fetched `git diff origin/<batch>...origin/<branch>`, with the same tiers. A send-back reads the head with `git ls-remote` instead of the PR head (`tasks.ts:427-439`). The CLEAR that leads into `land-queue` records `land_sha` from the same read |
| `ci` | Waits for CI on the PR head | **Skipped**: `modes: ['per-task']` |
| `land-queue` (new) | **Skipped**: `modes: ['single-pr']` | Waits for the landing slot. No actor and no prompt. With the slot, a task that is landed or up to date goes to `merge`, and one that is behind goes to `sync` |
| `sync` (new) | **Skipped** | The worker merges the batch in, runs the check, pushes and runs `hpipe submit`. A clean merge sets `land_sha` to the new head and goes to `merge`. Anything else goes to the tier's first review row. `anyWorker`: a fresh agent can take it over |
| `merge` | The orchestrator merges the PR. The row is a level on "PR merged", and a moved head sends the task back to `ci` | The orchestrator pushes `land_sha` onto the batch branch as a fast-forward. The row is a level: `land_sha` on `origin/<batch>` means landed, and goes to `close`. If neither contains the other, the task goes back to `sync`. Prompt: `merge-batch.md` |
| `close` | The bead closes after the merge is recorded | The same, with a close reason naming the batch branch |
| `teardown` | Normal path: `herdr worktree remove --force`. The fallback checks the checkout is pushed | The normal path is unchanged. The fallback also accepts a HEAD contained in `origin/<batch>` (m8, below) |
| `blocked-on-decision`, `escalated`, terminal rows | — | Unchanged. A decision asked from `sync` or `merge` keeps the landing slot |

The two new rows carry `modes: ['single-pr']`, so per-task routes, bead labels and boards are
unchanged. Pass 1 rejected new task rows because of "new rows into every v3 reader". The review is
right that this reason does not hold: no v3 reader loads a v4 run, and `modes` keeps the rows off
per-task routes. The cost is two phase labels, `land-queue` and `sync`, on v4 runs' beads only.
`pr-review` keeps its name in a run that has no PRs (see Rejected).

### The landing gate

Owner decision 5, built on the review's B1. Prose cannot add the gate to a merge command:

- GitHub's merge endpoint has no expected-base parameter.
- A fetch, check, then merge has a window.
- The supervisor's own refs are up to `CI_POLL_SECONDS` (30 s, `config.ts:37`) old.

A non-force ref update is the only check that holds atomically, on the server. Under the gate every
legal landing is a fast-forward, so a fast-forward push is all landing needs.

#### What lands: `land_sha`

- It is recorded when the last review row of the task's route clears into `land-queue`. Its value is
  the branch head, read with `git ls-remote origin refs/heads/<branch>` in the same tick. A failed
  read skips the tick, as a failed PR-head read does today (`tasks.ts:433-437`). The reviewers
  pushed their verdicts onto that head (`pr-review.md:19-22`), and their diff was read from the same
  branch.
- Only a clean sync advances it (below).
- Entering `implement` by any route clears it.
- After that it is never re-read from the branch. A push to the branch after its review changes
  nothing that lands, and neither does a force-push of the branch or its deletion (M1c).

#### The slot

- `landingSlotHolder(tasks)` (`gating.ts`, pure) returns the task in `sync` or `merge`, or in
  `blocked-on-decision` asked from either. It is computed live inside the task loop, like
  `releasableFromFiles` (`tasks.ts:399-407`). So when one task takes the slot, no other takes it in
  the same tick.
- `land-queue` clears for one task only: the first in `land-queue` ordered by `phase_entered_at` and
  then `task_id`, and only while no task holds the slot. Once it holds the slot:

  | `land_sha` against `origin/<batch>` | Goes to |
  |---|---|
  | contained in it (already landed) | `merge`, which records the landing |
  | contains it (up to date) | `merge` |
  | neither (behind) | `sync` |

- The slot passes as soon as the holder leaves `sync` or `merge` for anything but a decision: `close`
  after landing, `escalated`, `failed`, or a review after a dirty sync. One escalated task cannot
  stop every landing.
- Why one at a time: every landing makes every other synced task stale again. If k tasks in line all
  synced whenever the batch moved, they would need up to k(k−1)/2 syncs, each a worker turn and a
  check run. In line, they need at most k.
- **Correctness never rests on the slot.** Only the push is the gate. A rewind that puts two tasks
  in `merge` at once costs one refused push and one sync, never a wrong landing.
- **Stall exemption** (B1.5). `land-queue` is stallable with `probeTarget: 'orchestrator'`.
  `taskStallCandidates` skips it while a slot holder exists, beside the `blocked-on-files` exemption
  (`stall.ts:137`): the holder has its own ladder, and probes about the waiting tasks would be #22
  again. It is probed only when no task holds the slot. That can only mean the run is not being
  advanced, and the clause says so (§6).

#### Landing: a fast-forward push

`merge-batch.md` renders the one command, with `repo_root` shell-quoted (`unstarted.ts:86-88`):

    git -C '<repo_root>' push origin <land_sha>:refs/heads/<batch>

The worker committed in a linked worktree of `repo_root`, which shares its object store, so the
commit is there to push. The prompt says:

- If GitHub refuses it as `non-fast-forward`, end your turn. The batch has moved, and the task goes
  back to `sync` once the next fetch shows it.
- Push this sha and no other. Commits on the branch after it were not reviewed or checked.
- Never force-push, rebase or squash the batch branch. Every later base and every landing check reads
  its ancestry.
- Landing is yours, not the plugin's, and nothing lands automatically (`merge.md:13`). See Open
  questions.

#### Sync

`sync.md`, to the worker:

1. `git fetch origin +refs/heads/<batch>:refs/remotes/origin/<batch> && git merge --no-edit origin/<batch>`.
2. On a conflict, resolve it the way `implement` works: you keep the judgment, and one subagent
   writes the resolution.
3. If the merge changed what the bootstrap builds, re-run `./.claude/pipeline-bootstrap`.
4. Push, then run `hpipe submit --task tN`. It runs the check, so give the Bash call a 10-minute
   timeout.
5. If the check fails, fix it the same way, commit, push and submit again. Any commit beyond the
   merge sends the branch back through review. That is expected, not a failure.

**Clean or dirty** (B1.6) is decided by `hpipe submit`, in a CLI process rather than the serial
tick. It walks the first-parent chain from `HEAD` back to `land_sha`. Every commit on the way must:

- have exactly two parents;
- have a second parent contained in the freshly fetched `origin/<batch>`;
- have a tree equal to `git merge-tree --write-tree <p1> <p2>`, which must exit 0.

Reaching a commit already on the batch, or the root, without meeting `land_sha` also counts as dirty,
which covers a rebase. The Evidence table gives the probe of all five cases. `git merge-tree
--write-tree` needs git 2.38, which pass 1's `ship.md` already assumed.

The supervisor's `sync` edge needs the worker idle and a `sync` submission recorded at or after phase
entry. Then:

- **Clean:** `land_sha` becomes the submitted head, and the task goes to `merge`.
- **Dirty:** the task goes to `nextPhase(route, implement row)`, which is the tier's first review row,
  with the reason "sync of `<batch>` was not a clean merge: `<first offending commit>`". The review
  is commissioned as on any entry (`reserveVerdict`). `land_sha` keeps the last reviewed head, so the
  review prompt's `{{resync_note}}` can name the range: `git log --first-parent <land_sha>..<head>`,
  and `git show --remerge-diff <merge>` for each merge in it. The CLEAR records the new `land_sha`.

There is no counter on this loop. A second dirty sync needs another task to land in between, so the
loop is bounded by the size of the batch. The review rows' own counters still bound their BLOCKERs.

**Why a dirty sync is reviewed and a clean one is not.** Under the file lock, two overlapping tasks
are never both past `blocked-on-files` (`gating.ts:129-135`). So a sync that is not an automatic
merge means `--files` was wrong, or a shared file (#18) was touched, and its resolution is code no
reviewer has seen. Per-task mode let a rebase at merge through with only CI after it, and here there
is no per-task CI. A clean merge holds no line that the batch's own reviews did not already judge,
so it is only re-tested.

#### The check: `.claude/pipeline-check`

The review is right that the Rejected row against it no longer holds (B1.7). With no per-task CI, the
re-test at sync is the only check a landed tree gets before the final PR, and nothing in the plugin
names a test command today: "run the tests and the typecheck" is prose (`implement.md:21`,
`ci-red.md:23`).

- It is an executable the repo declares at `.claude/pipeline-check`, beside
  `.claude/pipeline-bootstrap` (`bootstrap.ts:5`). A new `src/lib/check.ts` mirrors `bootstrap.ts`.
- `hpipe submit` runs it, from the task's checkout, at both `implement` and `sync`. The tree must be
  clean first, so the tree it passes is the pushed commit's. Its output goes to
  `<stateDir>/runs/<session>/<run_id>.checks/<task>-<sha8>.log`, and a refusal prints the last 40
  lines.
- `ship` runs it again in the batch checkout (§4).
- If the repo declares none, `submit` records `check: 'none'`. The prompts fall back to "run the tests
  and the typecheck yourself", and `status` says landings are unverified (§6).
- If the file is not executable, `submit` refuses with the `chmod +x` hint, as `bootstrapLine` does.
- It never runs in the supervisor's tick, which is serial.
- So every landed tree has passed the check, apart from the reviewers' verdict commits, which only
  add review files.

#### A worker pane lost after the reviews

The review notes that a worker-owned `sync` makes `workerStillNeeded` (`tick.ts:179-196`) true
through it, so a pane lost while waiting would fail a reviewed task (`tick.ts:213`). Instead:

- `sync` carries `anyWorker: true`. The row needs none of the lost worker's context, so a fresh agent
  in the same worktree can do it.
- `workerStillNeeded` does not stop at an `anyWorker` row. It walks on past it. A pane lost in
  `land-queue`, `sync` or `merge` is then released, not failed (`tick.ts:198-210`). A pane lost in
  `implement` or a review row still fails the task, as today.
- A task in `sync` with no pane, and nothing queued for its worker, gets its brief and the sync
  prompt queued as one outbox entry for the worker. That is the shape `owePhasePrompt` queues after a
  rewind (`cli.ts:843-846`). The entry waits until a pane is bound (`courier.ts:656-657`).
- The orchestrator is told to start an agent in the worktree, through the paths that exist for an
  unstarted worker: `unstartedWorker`, `startWorkerCommand` and `handoffPastBrief`
  (`unstarted.ts:28-33,124-131,204-214`), and the status move (`status.ts:166-171`). Their wording
  already says "its brief and sync prompt are already queued … send it nothing yourself".
- With no worker, the slot holder's ladder escalates after its probes, which passes the slot on.

### `hpipe submit`

`hpipe submit --task tN [--title "<conventional title>"] [--run <id>]`. The worker runs it from its
own worktree, where a per-task worker would open the PR. `--title` is required in `implement`. In
`sync` it is optional, and replaces the title when given. It refuses:

| Refuses when | Because |
|---|---|
| The run is per-task | — |
| The task is in neither `implement` nor `sync` | — |
| `implement` has no `--title`, or the title is not one line matching `^<type>(\([^()\s]+\))?!?: \S` | It becomes a release-note line |
| The type is not in the repo's release-please `changelog-sections` (top level, or `packages["."]`). With no config, the test is release-please's default list | m4: `feet:` passes the pattern and release-please drops it. A known type that the config hides (`chore` in this repo) passes, with a note that it will not appear in the notes |
| Tracked files are modified (`git status --porcelain --untracked-files=no`) | The check must test the pushed tree |
| `git ls-remote origin refs/heads/<branch>` differs from `HEAD` | Not pushed: "push first" |
| `HEAD` is already contained in the freshly fetched `origin/<batch>` | "nothing to land: `<branch>` has no commit that `<batch>` lacks" |
| `implement` re-entry: every commit on `HEAD`'s first-parent chain back to `head_sha_at_entry` is a merge whose second parent is on the batch | m6: the sync step's own push moved the head. "Nothing but merges of `<batch>` since the review sent it back" |
| `sync`: `HEAD` does not contain the freshly fetched `origin/<batch>` | "still behind `<batch>`: merge it and push" |
| `prForBranch(<branch>)` finds an open PR | m9: that PR would carry every sibling's commits into the default branch. "Close PR #n, then submit again" |
| The check is declared and exits non-zero, or is not executable | B1.7 |

Local refusals come first, then the network ones (one fetch, one `ls-remote`, one `gh pr list`, under
dispatch's 15 s budget), then the check, which is the slow one. On success it records
`task.submission = { kind, title, head_sha, at, check, merge? }` under `retryOnStaleRun`. The retry
re-reads the task's phase, and the check's result is memoized across retries the way `cmdTask`
memoizes its bd calls (`cli.ts:578-588`).

The `implement` edge reads only the ledger, with no git or gh call per tick. A submission older than
the phase entry is ignored, so a re-entry needs a new submit. That is also why no rewind deletes
`submission`, which pass 1 did: no edge can act on a stale one, and keeping it means a landing always
has the last submitted title to record. The release lines come from `landed`, not from
`submission` (M2).

### Landing detection and the batch fetch

- The CI poll (`main.ts:270-273`) also fetches `+refs/heads/<batch>:refs/remotes/origin/<batch>`, once
  for each single-PR run that has a task in `land-queue`, `sync` or `merge`. Task branches are never
  fetched for landing, so a deleted task branch cannot blind it (M1a). Dispatch's own fetch of the
  batch (§2) updates the same ref.
- Between landings that local ref is current. The batch moves only by landings, apart from the
  unsupported out-of-band push, and each landing is seen through this ref. So `land-queue`'s routing
  is right on the tick the slot frees.
- `fetchFromOrigin` (`dispatch-base.ts:226-231`) returns the failure reason instead of `void`. A
  failure is written to `run.batch.fetch_error = { reason, since }` when it starts, and cleared by
  the next good fetch. `status` prints it (§6).
- `gatherSignals` for `land-queue` and `merge` reads local refs only, through
  `git merge-base --is-ancestor`. Exit 0 is yes, 1 is no, and anything else skips the tick.
- **`merge`, single-PR.** The orchestrator must be idle, as today (`tasks.ts:234-239`).
  - `land_sha` contained in `origin/<batch>`: the task has landed. Record `merged_at_ms = now` and
    `merge_commit = land_sha`. Append `{ title: submission.title, land_sha, at }` to `task.landed`,
    unless the last entry has the same `land_sha`. Then go to `close`.
  - Otherwise, if `land_sha` does not contain `origin/<batch>`, go to `sync`: "`<batch>` moved to
    `<sha8>` before `<land sha8>` landed". This rule is coded in the machine, as per-task's "head
    moved" rule is (`machine.ts:236-240`).
- **It cannot fire early.** `land_sha` sits on top of reviews that each pushed a verdict commit, and
  above a head that `submit` refused if the batch already contained it. Nothing but a landing puts
  this task's commits on the batch branch.

### What "complete" means for a task

| | Single-PR |
|---|---|
| Bead | Closed at landing. `merged_at_ms` makes the desired status `closed` (`bead-desired.ts:111-113`). `closeReason` (`beads-sync.ts:63-65`) becomes `landed on <batch> (<land sha8>); ships with the batch PR into <default>` |
| File lock | Released at `done`, after `close` and `teardown`, as today |
| Worktree | Torn down by `teardown`. Its normal path, `herdr worktree remove --force` (`herdr.ts:208`, `teardown.ts:176-183`), checks nothing in either mode. So "never delete unlanded work" rests on the `merge` predicate, and that reads the recorded `land_sha` (m8). The fallback for a forgotten workspace, `isPushed` (`teardown.ts:139-150`), also accepts a HEAD contained in `origin/<batch>`, since no PR head exists. Commits made in the worktree after `land_sha` go with it, as commits pushed after a PR merged do today |
| Dependents | Gate on `done` as today (`gating.ts:7`), and are cut from a batch head that contains the landing |
| The code on the default branch | Only once the final PR merges. `status` and the run's `done` notice say so (§6) |

## 4. The run's end

| Row | Actor | Signal | onClear | onBlocker | Modes | Notes |
|---|---|---|---|---|---|---|
| `execute` | — | gate | `branch-review` | — | both | When exactly 1 task landed, it goes to the row after `branch-review` for its mode: `done` per-task, `ship` single-PR (`machine.ts:80`). When 0 landed it escalates, as today |
| `branch-review` | orchestrator | verdict | `ship`, filtered by mode (`done` per-task) | itself | both | Single-PR prompt variant below |
| `ship` (new) | orchestrator | pr | `ship-ci` | — | single-PR | Prompt `ship.md`, or `ship-ci-red.md` on re-entry from `ship-ci`, as `implement` picks `ci-red` (`tasks.ts:142-150`). Stallable |
| `ship-ci` (new) | — | ci | `ship-merge` | `ship` | single-PR | `counter: 'ship-ci'`. The probe target is the orchestrator. Stallable |
| `ship-merge` (new) | orchestrator | merged | `done` | — | single-PR | A head that moves after CI passed goes back to `ship-ci`, the `machine.ts:236-240` rule. Stallable |
| `escalated`, `done` | | | | | both | `done`'s notice is extended (§6) |

`branch-review`'s static `onClear` becomes `ship`. A new `nextRunPhase(mode, row)` skips rows outside
the run's mode, exactly as `nextPhase` skips tiers (`phases.ts:199-205`). So a per-task run still
goes `branch-review → done`.

**`branch-review` in a single-PR run.** `{{scope}}` replaces `branch-review.md:7-10`. The review reads
`git diff origin/<default>...origin/<batch>`, which is exactly what the final PR will carry, rather
than the run's merged PRs. "You patch the branch directly" (`branch-review.md:53-54`) names the batch
checkout. `{{task_outcomes}}` speaks of landings (§6, m7).

**The batch checkout** (m1). Patching the batch branch and running its combined check needs a
checkout, and the orchestrator's own checkout is the user's working copy. So the single-PR prompts
render the absolute path recorded at start, `run.batch.checkout`, and never
`$HERDR_PLUGIN_STATE_DIR`, which the orchestrator's shell may not have. One helper renders the step
for both `branch-review` and `ship`:

- if the path does not exist: `git -C '<repo_root>' fetch origin +refs/heads/<batch>:refs/remotes/origin/<batch>`,
  then `git -C '<repo_root>' worktree add --track -B <batch> '<checkout>' origin/<batch>` (probed),
  then the bootstrap there;
- otherwise: `git -C '<checkout>' pull --ff-only`.

### `ship`: open the final PR

`ship.md` asks the orchestrator to:

1. Bring the batch checkout up to date, then run `./.claude/pipeline-check` there, or the tests and
   the typecheck when none is declared. This is the one local run of the combined tree, and it
   catches interaction failures before CI does. If anything is red, dispatch a subagent with
   `model: {{implement_model}}` to fix it, then verify, commit and push.
2. If `origin/<default>` has moved and `git merge-tree --write-tree origin/<default> origin/<batch>`
   reports conflicts, merge `origin/<default>` into the batch branch, resolve, check and push.
3. With no PR yet, run `gh pr create --base <default> --head <batch> --title '<title>' --body-file '<body>'`.
   With one open, run `gh pr edit <n> --body-file '<body>'`.

The title must be conventional for PR-title lint. Once the override is present, release-please
ignores it. The prompt renders a suggestion: the strongest type among the landed titles (`feat` >
`fix` > `perf` > `refactor` > the rest, with `!` when any title has it), then the run's title in
lower case.

The body file is `$STATE/runs/<session>/<run_id>.batch-pr.md`, beside the `.discoveries/` directory,
rendered to its absolute path. It is rewritten every time `ship` or `ship-merge` renders:

    <run title>: one PR for run <run_id>

    | Task | Bead | Change |
    |---|---|---|
    | t1 | berean-o-1 | fix(reader): close the menu without re-rendering |
    …
    Not in this PR: t5 (berean-o-5) stopped at failed.        ← only when a task never landed

    Refs berean-o-1, berean-o-2, …

    BEGIN_COMMIT_OVERRIDE
    fix(reader): close the menu without re-rendering
    …
    END_COMMIT_OVERRIDE

The lines are every `landed` entry of every task, in landing order (`at`). A task landed twice (§7)
contributes both lines, and one landed twice under the same title contributes it once. A task
rewound and abandoned after it landed keeps its line, because its commits are on the batch branch
(M2). The block is the plugin's alone. A fix that deserves its own release line goes through a fix
task, whose title then lands in the block. The orchestrator's own patches are fixes to the batch's
changes, not changes of their own.

The `ship` row clears like `implement`. The orchestrator must be idle. `prForBranch(<batch>)`
(`gh.ts:78-83`) must find the PR, which is recorded as `run.batch.pr`. And the PR head (`prView`)
must differ from `run.batch.head_sha_at_entry`, which is null on first entry.

### `ship-ci`: CI once, on the final PR

`ciTransitions` (`ci.ts:13-36`) also polls each single-PR run in `ship-ci` with a PR. The per-head
bookkeeping moves into one helper used for both a task and a run's batch, so it has the same three
properties:

- the bucket is tied to `headSha`;
- a new head resets the 60 s settle (`CI_SETTLE_MS`, `ci.ts:11`);
- `ship-ci` is entered with `batch.ci = null`, as `machine.ts:117` does for a task.

On **fail**, the counter `ship-ci` is bumped, and at `MAX_PASSES` the run escalates. Otherwise the run
goes to `ship`, with `head_sha_at_entry` set to a fresh PR-head read, which is the `withSendBackHead`
reasoning (`tasks.ts:416-426`).

**The budget, stated** (M3). `MAX_PASSES` is 2 (`config.ts:31`). So the orchestrator gets one repair,
by patch or by fix task, and a second red escalates the run to the human. That is the same budget as
a task's `ci` row. An escalated run is one `hpipe rewind <run> ship` away from another try, and that
rewind zeroes the counter (`cli.ts:961`). Registering a fix task does not reset it.

### Red CI on the final PR

No task is picked automatically. By then every task is torn down with no worker, and attributing a
failure to a task by its `--files` is a guess. `ship-ci-red.md` inlines the failing checks
(`gh.ts:107-116`) and gives the orchestrator three routes, in this order:

| Failure | Route |
|---|---|
| Environmental | Push an empty commit to the batch branch. A `gh run rerun` does not move the head, as `ci-red.md:10-13` says for tasks |
| **A small defect: the default** (owner decision 4) | A subagent fixes it in the batch checkout. The orchestrator runs the check and pushes. The head moves, so `ship` clears back to `ship-ci`. "Small" means a few lines in files the failure names, adding no behaviour the release notes would mention |
| A bigger defect, or one that is itself a user-visible change | A fix task: `hpipe task …` registers it into the run (below), then `hpipe dispatch --done`. The fix task is cut from the batch head, reviewed, synced if it must be, and landed like any task. Its title joins the override block. The run goes `execute → branch-review → ship`. The PR is already open and the landing moved its head, so `ship` clears once the orchestrator is idle again |

**Registering a fix task** (M3). Pass 1's route, "rewind to `execute`, then `hpipe task`", cannot run.
The rewind leaves intake closed, so the run is back in `branch-review` on the next tick, and
`branch-review` is not registrable (`cli.ts:237`). Instead, a single-PR run is also registrable in
`branch-review`, `ship`, `ship-ci` and `ship-merge`, and registration there moves the run to
`execute` in the same save:

- `run.phase = 'execute'`, with `phase_entered_at = now` and a history entry "a fix task was
  registered";
- `intake_closed = false`, which registration already sets (`cli.ts:531`);
- `batch.pr` and `batch.head_sha_at_entry` are kept, and `batch.ci` is reset on the next entry to
  `ship-ci`.

It prints "run moved to execute: register any other fix, then `hpipe dispatch --done`". A per-task
run is registrable exactly where it is today, with today's refusal wording. `branch-review` is in the
list because a BLOCKER there that is too big to patch is the same case. A run rewind into `intake`
also works today, but it re-sends the whole intake prompt for one fix.

### `ship-merge`: the one merge

`ship-merge.md` renders two commands and says three things:

    gh pr edit <n> --body-file '<body>'
    gh pr merge <n> --squash --subject '<first landed title>' --body-file '<squash body>'

- The squash commit carries the release lines itself (m3). Its subject is the first landed title.
  Its body, `$STATE/runs/<session>/<run_id>.squash-body.md`, holds the remaining titles one per line
  and nothing else. That is the README's "multiple fixes or features" form, so the release reads the
  same lines even if release-please never finds the PR body. When it does find the body, the override
  replaces the whole message with the same set.
- Squash is what makes release-please read the override. A merge commit makes it read the batch's
  commits one by one instead. Leave the block alone.
- This is the last point at which any check that a decision ruled "before merge" can still be done.
  That is #17/#24, and recording such checks is out of scope.

The row clears on `prView(...).merged`, and records `batch.merged_at_ms` and `batch.merge_commit`.
The run goes to `done`. Its stall clause covers what GitHub may refuse (m2, §6).

## 5. Ledger and phase table

```ts
interface Batch {
  branch: string
  /** The default branch at start: the final PR's base. */
  into: string
  base_commit: string
  /** Absolute: prompts render it, and the orchestrator's shell may not know the state dir. */
  checkout: string
  pr: number | null
  head_sha_at_entry: string | null
  ci: CiBucket | null
  ci_head?: { sha: string; seen_at: number }
  merged_at_ms: number | null
  merge_commit: string | null
  fetch_error?: { reason: string; since: number } | null
}
interface Submission {
  kind: 'implement' | 'sync'
  title: string
  head_sha: string
  at: number
  check: 'passed' | 'none'
  /** sync only */
  merge?: 'clean' | 'dirty'
}
interface Landing { title: string; land_sha: string; at: number }

Run.batch?: Batch                       // present ⇔ single-PR
Task.submission?: Submission
Task.land_sha?: string | null
Task.landed?: Landing[]                 // append-only; no rewind clears it
SupervisorPid.schemas?: number[]        // absent reads as [3]
```

A single-PR task reuses `merged_at_ms` and `merge_commit` to mean "landed on the batch branch", with
`merge_commit = land_sha`. `pr` and `ci` stay null. `hasLanded` (`ledger.ts:308-309`) and
`landedTaskCount` therefore work unchanged.

**Phase table.**

- `PhaseRow` gains `modes?: readonly RunMode[]` and `anyWorker?: boolean`. `RunMode` is
  `'per-task' | 'single-pr'`, and `modeOf(run)` reads `run.batch`.
- `Signal` gains `slot` and `synced`. `RunPhase` gains `ship`, `ship-ci` and `ship-merge`.
  `TaskPhase` gains `land-queue` and `sync`.
- The task rows that change or are new:

  | Row | Definition |
  |---|---|
  | `ci` | `onClear: 'land-queue'` (was `merge`), `modes: ['per-task']`. Otherwise unchanged |
  | `land-queue` | `signal: 'slot'`, `onClear: 'sync'`, `stallable`, `probeTarget: 'orchestrator'`, `holdsFiles: true`, `modes: ['single-pr']` |
  | `sync` | `actor: 'worker'`, `signal: 'synced'`, `onClear: 'merge'`, `prompt: 'sync'`, `stallable`, `holdsFiles: true`, `anyWorker: true`, `modes: ['single-pr']` |
  | `merge` | Unchanged. Its prompt and machine case are chosen by mode |

  The run rows are as in the table in §4.
- `nextPhase(tier, from)` becomes `nextPhase({ tier, mode }, from)`. Its call sites are
  `machine.ts:177,195,204`, `tier-prompt.ts:36` and `tick.ts:187`. A per-task route walks
  `ci → merge` exactly as today, because `land-queue` and `sync` are filtered out.
- The machine's own edges sit outside the table, like `merge → ci` today: `land-queue` to `merge`
  when up to date, `sync` to the first review row on a dirty sync, and `merge` back to `sync` when
  behind.
- `workerStillNeeded(task)` becomes `workerStillNeeded(run, task)`. It walks the run's route, and it
  walks past an `anyWorker` row instead of stopping (§3).
- `phaseLoop`'s `LOOP_END` (`tier-prompt.ts:8`) becomes `merge` in both modes. With `ci` skipped,
  `phaseLoop` would otherwise walk to `done` and throw "the table runs out" (`phases.ts:204`). A
  per-task loop is unchanged, since `ci` has no actor. A single-PR loop gains the `sync` step.
  `tierPromptVars(task)` becomes `tierPromptVars(run, task)` at `tasks.ts:114,578` and
  `worker-prompt.ts:30`.
- `rewind` refuses a phase whose row's `modes` exclude the run's mode. A single-PR task left in `ci`
  would wait forever for CI on a PR that does not exist (`ci.ts:20` skips `pr === null`). Tiers only
  warn about this (`cli.ts:915-919`). Modes must refuse.
- `ESCALATING_SIGNALS` (`stall.ts:20`) gains `synced`, the worker's own work. `slot` is not
  escalating.

**Schema.** `SCHEMA_VERSION = 3` stays, and `BATCH_SCHEMA_VERSION = 4` is added. `newRun` writes 4
exactly when it is given a batch. `isCurrentSchemaRun` (`ledger.ts:22-24`) accepts either.
`beadClaimants` (`held.ts:94`) gets the same treatment, so a single-PR task's bead is known as
claimed. `beadHolds` (`held.ts:67-81`) already reads every schema. Why only the batch runs:

- Bumping every run to 4 would strand every v3 run in flight behind `abort`. Earlier specs rejected
  that for that reason (`2026-09-18-issue-19-design.md:852`).
- Leaving batch runs at 3 would let an older supervisor drive one as a per-task run. Its prompts
  would have a worker cut from the batch branch open a PR into the default branch, carrying every
  sibling's commits.

Version 4 makes such a run invisible to old code instead. And `start` refuses while this session's
supervisor is that old code (§1).

## 6. What the orchestrator sees

**`hpipe status`.** A single-PR run's header gains one `ships as one PR:` line, and up to three
warnings. Its rows read:

| Where | Added or changed line | Whose move |
|---|---|---|
| Run header, every phase | `ships as one PR: batch/x → main · 3 of 7 landed · landing: t4 (sync) · next: t5, t6` | — |
| No check declared | `⚠ no .claude/pipeline-check in this repo: each landing is checked only by its worker's own test run` | — |
| `batch.fetch_error` set | `⚠ batch/x has not fetched for 12m (<reason>): landings are not being seen` | You |
| A v4 run, with a live supervisor whose `schemas` lacks 4 | `⚠ the running supervisor (pid N) predates single-PR runs and ignores this run: close its Pipeline supervisor pane and run the plugin's supervisor action` (M4) | You |
| A task in `land-queue` | `… [land-queue 6m] … — nothing for you — waiting to land; t4 holds the landing slot (sync)`, or `— next to land` | Nobody |
| A task in `sync` | `… [sync 3m] … — worker's move: waiting for batch/x merged into t4-branch, checked and resubmitted` | The worker |
| A task in `merge` | Under "waiting on you": `YOUR move: land t4 — git -C '<repo>' push origin 9e06c261:refs/heads/batch/x` | The orchestrator |
| `ship` | `· final PR: not opened` and `YOUR move: check the batch and open its PR (the ship prompt has the commands)` | The orchestrator |
| `ship-ci` | `· PR #301 ci:pending (on 9e06c261)` | Nobody |
| `ship-merge` | `· PR #301 ci:pass` and `YOUR move: squash-merge PR #301 (the ship-merge prompt has the commands)` | The orchestrator |
| `done` | `shipped: PR #301 squash-merged as 1a2b3c4d`. When aborted: `not shipped: batch/x holds 3 landed tasks (t1, t2, t4) that are not on main; their beads are closed` | — |

In a single-PR run the task line drops the `PR #`/`ci:` bits (`status.ts:451-452`).
`formatTaskDetail` (`status.ts:501-533`) prints:

    pr:         none (single-PR run: lands on batch/x)
    submitted:  fix(reader): … (implement, at 9e06c261, 12m ago; check passed)
    land sha:   4b1d0e2a (reviewed)                  ← or "(clean sync of batch/x)", or "none"
    landed:     batch/x at 4b1d0e2a, 3m ago          ← one line per landing
    ci:         n/a — CI runs once, on the batch PR

**Wording** (m7). Every place that names a PR or a merge for a task reads the mode:

- `awaitedFor(task)` (`awaiting.ts:13-38`) becomes `awaitedFor(run, task)`. In a single-PR run, `pr`
  reads "a submission for `<branch>` (`<bead>`)". `merged` reads "`<branch>` at `<land sha8>` to
  land on `<batch>`". `slot` reads "the landing slot". `synced` reads "`<batch>` merged into
  `<branch>`, checked and resubmitted".
- `taskOutcomesFor` and `UNLANDED_MEANING` (`deliver.ts:372-412`) render branch-review's
  `{{task_outcomes}}`. They say "landed on `<batch>`" where they say "merged", and "Review what is on
  the batch branch" where they say "the base branch".
- `losePane` (`tick.ts:213-217`) says "pane exited before it submitted" or "after it submitted"
  instead of "with no PR".
- `finishedTaskNote` (`status.ts:358-371`) says "landed but left its worktree".
- `loopStep` (`tier-prompt.ts:10-23`): `implement` ends "you verify, push and run `hpipe submit`".
  The new `sync` step reads "`sync` — if the batch moves before you land: merge it in, check, push,
  submit".
- `closeReason` (`beads-sync.ts:63-65`) is as given in §3.

**Stall clauses** (`stall.ts:236-403`) gain single-PR forms:

| Row | Clause |
|---|---|
| `implement` | Waiting for a submission: push, then `hpipe submit --task tN --title "<conventional title>"`. It refuses, with the reason, until the work is committed, pushed, checked and not already on the batch |
| `land-queue` (probed only with no slot holder) | No task holds the landing slot and this one is first in line, yet it has not taken it, so this run is not being advanced. Check the supervisor pane's log, and whether another run holds this orchestrator pane |
| `sync` | Waiting for `<batch>` merged into `<branch>`, checked, pushed and submitted, with both commands. With no pane: the unstarted-worker clause, as for any worker row |
| `merge` | Waiting for you to land `<branch>`, with the push command. If it was refused as non-fast-forward, end your turn. Landing is yours, and nothing lands automatically. If it has landed, end your turn: this phase is read only while you are idle |
| `ship` (run) | Waiting for the batch PR: check the batch, open or update the PR, as the ship prompt says. `pr` escalates, as an unanswered `branch-review` does |
| `ship-ci` (run) | Waiting for CI on PR #n: `gh pr checks <n>`. A run that is queued or never triggered reports nothing, and this phase waits on it. A standing nudge |
| `ship-merge` (run) | Waiting for you to squash-merge PR #n with the rendered commands. If GitHub refuses (m2): a required review means getting it, and "branches must be up to date" means `gh pr update-branch <n>`, which moves the head back through `ship-ci`. Until PR #n merges, this run holds the repo, and no other `hpipe start` can begin here (`ledger.ts:370-383`). A standing nudge |

**`done` notice** (`deliver.ts:461-467`). It names the final PR and its squash commit, and prints the
clean-up commands:

- `git push origin --delete <task branches>`, since GitHub deletes only a PR's own head branch on
  merge;
- `git -C '<repo_root>' worktree remove '<checkout>'` and `git -C '<repo_root>' branch -D <batch>`.

**`hpipe abort`** (m1). In a single-PR run, `cli.ts:1379-1380` is wrong for the landed tasks, and
never prints the checkout removal. The message becomes: `<batch>` keeps the landed tasks (named),
whose beads stay closed, and nothing reached `<default>`. The unlanded tasks' beads are released on
the supervisor's next tick. The final PR, if open, is left open. It then prints the same clean-up
commands. `hpipe resume` puts the run back, as today.

**Board and Beads.** Two new phase labels, `land-queue` and `sync`, appear on v4 runs' beads only.
`PHASE_LABELS` (`bead-desired.ts:21`) derives them from `TASK_ROWS`. A task's bead goes `closed` at
landing, with the batch close reason. Discoveries are still filed at `branch-review`.

## 7. Failure, abort, resume, rewind

| Situation | What happens |
|---|---|
| `start` beside a supervisor without schema 4 | Refused, with the restart step (§1) |
| The repo does not allow squash merges | `start` is refused (§1) |
| `start` cannot push the batch branch | Refused after the Beads setup. No run and no branch exist. A retry after a push that landed adopts the branch (§1) |
| The batch branch is force-pushed or deleted mid-run | Unsupported, and every prompt that touches it says so. The batch fetch fails and `status` prints `fetch_error`. Dispatch reports `fetch failed` on its `base:` line (`dispatch-base.ts:252-256`). Landings stop being seen until the branch is restored from `refs/remotes/origin/<batch>` |
| A task branch is deleted on origin | Nothing breaks. Landing reads `land_sha` and the batch branch only (M1) |
| The worker never runs `submit` | `implement` stays put. The stall probe names `hpipe submit`, and `pr` escalates, as today |
| `submit` refuses | Nothing is recorded. The worker reads the reason |
| The landing push is refused as non-fast-forward | The orchestrator ends its turn. The next fetch shows the batch moved, and `merge` sends the task to `sync` |
| A rewind leaves two tasks in `sync` or `merge` | Tolerated. One push wins, and the other task goes to `sync` |
| A sync that is not a clean merge | The tier's first review row, with the remerge-diff note (§3) |
| A worker pane is lost in `land-queue`, `sync` or `merge` | The pane is released, not the task failed. A sync with no worker waits for a fresh agent, which gets the queued brief and sync prompt (§3) |
| The slot holder escalates or fails | The slot passes to the next task in line |
| The orchestrator pushes the branch tip instead of `land_sha` | Unreviewed commits land. Landing detection still reads `land_sha`, which is contained. The prompt forbids it, and policing it is out of scope |
| The final PR is closed unmerged | `ship-merge`'s probe says "PR #n is closed". Reopen it, or `hpipe rewind <run> ship`, which clears `batch.pr` so that `prForBranch` (open PRs only) finds the next one |
| `hpipe rewind <run> <phase> --task tN` | As today, plus the rules below |
| — to `implement` or earlier | Also deletes `land_sha`, beside `pr`/`ci` (`cli.ts:941-944`). `submission` is kept (§3), and so is `landed`: a rewind cannot take work off the batch branch, so its line stays (M2) |
| — to `land-queue`, `sync` or `merge` | Needs `land_sha`. With none, it is restored from the last `landed` entry. With no landing either, the rewind is refused: "no reviewed head is recorded for tN: rewind it to a review row". These rows join `PHASES_BEFORE_A_MERGE` (`cli.ts:241-243`), so the bead reopens and the landing is recorded again. A landing of the same `land_sha` adds no second line (§3) |
| — to a phase outside the run's mode | Refused (§5) |
| `hpipe rewind <run> ship-ci` | Clears `batch.ci`, as a task rewind into `ci` does (`cli.ts:954`) |
| `hpipe rewind <run> ship` | Clears `batch.pr`, which `ship` finds again if it is still open, and zeroes `passes` |
| `hpipe rewind <run> execute` | As today: intake stays closed, so with every task finished the run is back in `branch-review` on the next tick. Registering a fix task is the route back into `execute` (§4) |
| `hpipe abort` | The run is parked in `done`, as today. The batch branch, the batch checkout and any open final PR are left alone. Landed beads stay closed, and unlanded ones are released with `aborted` (`bead-desired.ts:114-116`). The message and `status` say so (§6) |
| `hpipe resume` | Unchanged |

## 8. Prompts, skill, README

New prompts:

| File | For |
|---|---|
| `prompts/sync.md` | The worker: merge the batch in, check, push, submit (§3) |
| `prompts/merge-batch.md` | The orchestrator: land with the fast-forward push (§3) |
| `prompts/ship.md` | Checking the batch and opening or updating the final PR |
| `prompts/ship-ci-red.md` | Red CI on the final PR, with the three routes |
| `prompts/ship-merge.md` | Merging the final PR |
| `prompts/handoff-pr.md` | Fragment: the end of `implement` in a per-task run (today's step 4 wording) |
| `prompts/handoff-batch.md` | Fragment: the end of `implement` in a single-PR run (push, then `hpipe submit`, with the 10-minute timeout) |

The two fragments are rendered and injected as `{{handoff}}`, the way `dispatch-registering.md`
becomes `{{registering}}` (`deliver.ts:435-436`). `render()` makes one pass, so each fragment is
rendered with its own variables first.

Edited prompts. Each token is supplied by one spread, `changePromptVars(run, task)`, at every task
render site (`tasks.ts:113-125`, `worker-prompt.ts:29-40`). So `render()` (`render.ts:11`) never
meets an unresolved one, and a per-task run renders today's text:

| Prompt | Change |
|---|---|
| `implement.md` | `{{sync_step}}` at the top: the explicit-refspec fetch and `git merge --no-edit origin/<batch>`, then the bootstrap if the merge changed what it builds, then a push. `{{handoff}}` for step 4. `{{reply_place}}` replaces "the PR body" (`:10,15`). In a single-PR run it reads "an empty commit on the branch whose message answers it" |
| `pr-review.md`, `pr-review-intent.md`, `pr-review-quality.md` | `{{subject}}` (`PR #12`, or `` `t3-branch` against `batch/x` ``) replaces `PR #{{pr}}`. `{{diff_command}}` replaces `gh pr diff {{pr}}`. In a single-PR run it first fetches both refs with explicit refspecs (m5): a stale `origin/<batch>` moves the three-dot merge-base back, and commits a sync merged in then read as this task's own. "The PR's head" becomes "the branch head". A single-PR reviewer also reads `git log origin/<batch>..origin/<branch>` for the worker's replies. `{{resync_note}}` is empty except on a review entered from a dirty sync (§3) |
| `worker-brief.md` | "not into this PR" becomes "not into this change" (`:14`). The PR-body bullet (`:73-77`) becomes `{{handoff_rule}}` |
| `branch-review.md` | `{{scope}}` and the batch checkout step (§4) |
| `intake.md` | `{{mode_note}}` (§1) |

`ci-red.md` and `merge.md` are per-task only and do not change. `test/prompts.test.ts:19-23` declares
the new files. `fix/effort-by-tier` and `fix/orchestrator-guidance` edit the same review prompts and
`intake.md`, so whichever lands second rebases.

**Skill.**

- In "Running a batch", step 1 names `--single-pr` and when to use it: the batch should ship as one
  release. It also names `.claude/pipeline-check`, and why a repo wants one before its first
  single-PR run.
- "While it runs" gains four rows:
  - "Land tN on batch/x": run the printed push. If it is refused, end the turn.
  - "tN waits in land-queue": nothing to do.
  - "Ship batch/x".
  - "Squash-merge the batch PR".
- "Recovery" gains:
  - red final CI: the three routes, and the one-repair budget;
  - a fix task registered from a ship phase;
  - "never rewrite the batch branch, and never land anything but the printed sha".

**README.** A "One PR per batch" section under **Use** covers:

- the flag, the batch branch, and the start-time refusals;
- `hpipe submit` and `.claude/pipeline-check`;
- the landing gate: one at a time, sync, and a clean versus a dirty sync;
- the final PR, and why it is a squash with an override block;
- clean-up.

Upgrading gets one paragraph: single-PR runs are v4, and `start` refuses until the supervisor has
been restarted.

## 9. Tests

| File | Covers |
|---|---|
| `table.test.ts` | For each mode and tier, the walk from `queued` reaches `merge` through `implement`. Per-task passes `ci` and never `land-queue` or `sync`. Single-PR passes `land-queue` and `sync` and never `ci`. Every row a single-PR route reaches that has an actor has a prompt. A row carrying `modes` is the `onBlocker` only of rows whose `modes` are a subset. Only `sync` carries `anyWorker`. `nextRunPhase` gives `done` per-task and `ship` single-PR after `branch-review`. `phaseLoop` is unchanged per-task, and lists `sync` single-PR |
| `gating.test.ts` | `landingSlotHolder`: `sync`, `merge`, and a decision asked from either hold it. `close`, `escalated`, `failed` and a review do not. Queue order is entry time, then id. Two tasks entering `land-queue` in one tick: one takes the slot |
| `machine-task.test.ts` | `implement` clears on a fresh `implement` submission. It ignores a stale one and one whose head equals `head_sha_at_entry`. The last review's CLEAR records `land_sha` from the head signal, and a null head skips. `land-queue`: waits without the slot; landed or up to date goes to `merge`; behind goes to `sync`. `sync`: clean sets `land_sha` and goes to `merge`; dirty goes to the tier's first review row, for each tier; a stale submission is ignored. `merge`, single-PR: landed goes to `close`, sets `merged_at_ms` and `merge_commit = land_sha`, and appends one `landed` entry; a second landing of the same `land_sha` appends nothing; behind goes to `sync`; no `ci_head` rule. Entering `implement` clears `land_sha` |
| `machine-run.test.ts` | `execute` with 1 landed goes to `ship` (single-PR) or `done` (per-task). `branch-review` CLEAR goes to `ship`. `ship` clears on a PR whose head moved. `ship-ci` pass goes to `ship-merge`. Fail goes to `ship` with the counter, and escalates at the second. `ship-merge` clears on merged, and a moved head goes back to `ship-ci` |
| `tasks.test.ts` | `gatherSignals` for `land-queue`, `merge` and the review send-back in a single-PR run, with injected `isAncestor` and `remoteBranchHead`. A failed git read skips the tick. A paneless `sync` gets its brief and prompt queued once, and not again while queued |
| `tick.test.ts` | A pane lost in `land-queue`, `sync` or `merge` releases the pane and does not fail the task. In `implement` or a review row it still fails it. `losePane`'s single-PR wording (m7) |
| `stall.test.ts` | `land-queue` is skipped while a slot holder exists, and probed with none (B1.5). `sync` escalates. Every clause in §6, including `ship-merge`'s refusals and repo hold (m2) |
| `ci.test.ts` | A run in `ship-ci` is polled, with the same settle and head reset as a task |
| `dispatch-base.test.ts` | The batch branch is fetched, and the cache is keyed by branch. On real git in a temp dir: `fetchBase` updates the tracking ref in a `--single-branch` clone (M1b), and `fetchFromOrigin` reports a missing ref |
| `supervisor` batch fetch | On real git in a temp dir: with the batch ref fetched alone, deleting a sibling's task branch does not stop a landing being seen (M1a). A failing fetch sets `fetch_error`, and a good one clears it |
| `deliver.test.ts` | `taskOutcomesFor`'s single-PR wording (m7). Adoption subtracts docs already on the batch |
| `cli-commands.test.ts` | `start --single-pr`: creates the branch, adopts an identical one, refuses a different one or the default name, and saves nothing when the push fails. It refuses beside a live supervisor without schema 4, and starts with none or a stale one (M4). It refuses when squash merges are off (m2). `task --branch <batch>` is refused. Registration into a single-PR run in `branch-review`, `ship`, `ship-ci` or `ship-merge` moves it to `execute` and reopens intake. A per-task run in `branch-review` is refused as today (M3). `submit`: every refusal in §3; the title against the repo's sections, the default list, and `feet:` (m4); the m6 re-entry rule; an open PR (m9); the check passing, failing, absent and not executable; the result memoized across a stale retry. Clean versus dirty on real git: the five probed cases (B1.6). `rewind`: refuses a phase outside the mode; clears `land_sha` going to `implement`, and keeps `submission` and `landed`; restores `land_sha` going to `merge`, or refuses; a run rewind to `ship` clears `batch.pr`, and to `ship-ci` clears `batch.ci`. `abort`'s single-PR message (m1) |
| `ledger.test.ts`, `held.test.ts` | v4 runs are read, v4 claimants are counted, and v3 behaviour is unchanged |
| `pidfile.test.ts`, `supervisor-boot.test.ts` | The claim writes `schemas: [3, 4]`, and a pid file without it reads as `[3]` |
| `teardown.test.ts` | `isPushed` accepts containment in the batch branch |
| `status.test.ts` | Every line in §6, including the M4 warning, the unverified-check line and the fetch-error line |
| `prompts.test.ts` | The new prompts are declared. Every new and edited prompt renders in both modes with no unresolved token |
| ship body (`deliver.test.ts`) | The override block across a rewind: `feat` landed, then `fix` landed, and both lines are present. A re-landing of the same `land_sha` gives one line. The not-landed line. The squash body holds every line but the first (M2, m3) |
| `check.test.ts` (new) | `repoCheck`: none, ready, not-executable |

**Live smoke.** A new section in `test/integration/smoke.md`. This change touches startup (the push
in `start`), gating (the dispatch base and the landing slot) and delivery (the new prompts and the
queued sync handover). Unit fakes have passed over live-only bugs here before. So it is verified in
a `pipesmokeN` herdr session against `victorstein/hpipe-smoke`, and release-please must be
configured there first, since step 9 is pass/fail.

0. With the previous release's supervisor still running, start a `--single-pr` run from the new CLI.
   Expect the refusal naming that supervisor (M4). Restart the supervisor pane.
1. `hpipe start --single-pr "smoke batch"`. Check that the branch exists on origin at the fetched
   default commit, that `batch:` and `check:` are printed, and that status prints the
   `ships as one PR` line.
2. Register t1 and t3 (disjoint `--files`), and t2 (`--depends-on t1`, overlapping t1's files).
   Check:
   - every `base:` is the batch head;
   - `submit` refuses an unpushed head, a `feet:` title and a branch with a PR opened by hand, then
     records;
   - the reviews read the fetched branch diff;
   - t1's landing is a fast-forward: `origin/batch/x` equals its `land_sha`;
   - the landing is recorded within one poll;
   - the bead closes with the batch reason;
   - the worktree is torn down;
   - t2's base contains t1's `land_sha`, and t2's sync step merges what landed after it was cut.
3. **The gate.** t1 and t3 run in parallel. Time them so both clear review within a minute of each
   other, holding one worker's last review back briefly if needed. Check:
   - one takes the slot, and the other waits in `land-queue` with no prompt and no stall probe;
   - before the waiting task syncs, pushing its old `land_sha` by hand is refused as
     non-fast-forward;
   - after the first lands, the second syncs cleanly, `submit` reports a clean merge and runs the
     check, and the task lands with no second review.
4. **A dirty sync.** Register t4 and t5, which both edit one file under wrongly disjoint `--files`.
   The second to land syncs with a conflict, `submit` reports a dirty merge, and the task goes
   through its tier's first review with the remerge-diff note, then lands.
5. **A deleted branch** (M1). While a task is in `merge`, delete a landed sibling's branch on origin.
   The landing is still seen.
6. **A lost pane.** Close the worker pane of a task waiting in `land-queue` that will have to sync.
   The task is not failed. When it takes the slot, status tells the orchestrator to start an agent,
   and the brief and sync prompt arrive on their own.
7. `branch-review` reads the batch diff. `ship` creates the batch checkout at the absolute path, runs
   the check there, writes a body with one override line per landing, and opens the PR. `ship-ci`
   stays pending until the head's runs finish.
8. **Red CI, both routes.**
   - Push a failing test to the batch branch: `ship-ci → ship`. Take the fix-task route (M3):
     `hpipe task …` moves the run to `execute`, then `dispatch --done`. The fix lands, and the run
     goes `execute → branch-review → ship → ship-ci`, and green.
   - With the run in `ship-merge`, push a failing test again. The moved head sends it back to
     `ship-ci`, and the second red escalates the run. `hpipe rewind <run> ship`, then patch through a
     subagent: `ship → ship-ci`, and green.
9. **The release** (m3). Squash-merge with the rendered commands. There must be exactly one release
   PR, whose notes list every landed title, the fix task's included, and nothing else. This step
   passes or fails. Then, on a throwaway PR with no override block, check that the squash body's
   extra lines alone give one entry each (Verify 2).
10. On a second, throwaway single-PR run with one landed task, `hpipe abort` names the landed task and
    prints the clean-up commands.

Treat any difference from this list as a finding, not a test to make pass.

## Verify before implementing

Each of these needs the live services, so the smoke run settles them:

1. release-please honours an override block that is in the PR body when the PR is squash-merged, in
   the release run that the merge itself triggers (smoke 9).
2. release-please reads extra conventional lines at the bottom of a squash commit's body as separate
   entries, `!` lines included, alongside whatever trailers GitHub adds (smoke 9, throwaway PR).
3. `gh pr merge --squash --subject <s> --body-file <f>` writes the commit message as given. If GitHub
   appends ` (#n)` to the subject, the entry gains a PR link and nothing breaks.
4. `gh pr list --head batch/x` finds a PR whose head branch name contains a slash.
5. GitHub refuses a non-force `git push <sha>:refs/heads/batch/x` that does not fast-forward, as a
   local bare repo does. And no branch rule on the target repos blocks direct pushes to `batch/*`.
   If one did, `start`'s own push would fail first, with GitHub's reason.
6. The default `changelog-sections` of the release-please version these repos run, for a repo with
   no config.
7. Whether a 10-minute Bash timeout covers berean-os's check run inside `hpipe submit`. If not, see
   Out of scope.

Pass 1's first item, whether GitHub's merge endpoint fast-forwards, is moot: landing no longer uses
it.

## Rejected

| Alternative | Why not |
|---|---|
| GitHub's merge endpoint for landing (pass 1) | It cannot be conditional on the batch head, so it cannot enforce the gate. It also needed a 409 path where the orchestrator resolved conflicts with no review (B1) |
| Every waiting task syncs whenever the batch moves | Up to k(k−1)/2 syncs for k tasks in line, each a worker turn and a check run |
| The orchestrator runs every sync | It is one serial pane that already lands, decides and dispatches. The worker has the bootstrapped checkout and the context to resolve its own diff |
| The orchestrator as the fallback when a worker pane is lost | One row's actor would then depend on whether a pane is alive. `actorPane`, `actorPaneFor`, `probeRecipient`, `moveFor` and `awaitedFor` all key on `row.actor`. A fresh agent in the worktree uses recovery paths that already exist |
| Re-reviewing every sync | A clean merge holds no line the batch's reviews did not judge. The walk tells clean from dirty mechanically |
| Landing a dirty sync after the check alone | Its resolution is code no reviewer has seen, and there is no per-task CI to stand in. Per-task mode accepted that only because CI ran after it |
| Fetching task branches to see a landing (pass 1) | One deleted branch fails the whole fetch, and the branch tip is not what was reviewed (M1) |
| Running the check in the supervisor's tick | The tick is serial, and a test suite takes minutes |
| A run rewind into `execute` that reopens intake | It would change every per-task rewind into `execute`. Registering a fix task is the explicit act |
| A separate budget for `ship-ci` | It would be the one row with its own setting. The budget is the same as a task's `ci`, and `status` and the skill say so |
| Per-task PRs into the batch branch | It reuses the PR, CI and merge rows almost unchanged, so it is the least code. But the owner chose no per-task PR, and CI would still run once per task wherever workflows trigger on `pull_request`, which is the cost being removed |
| The supervisor opens the final PR | A failed `gh pr create` in the tick has nobody to read it. The orchestrator already owns every GitHub-visible step, and the plugin still owns the body |
| Holding each merge until release-please settles (#23's fallback) | Still N releases. It only stops the drops |
| Closing beads only when the final PR merges | Owner decision 3 |
| Squash- or rebase-merging tasks into the batch branch | It loses the ancestry that landing and the dependency base (`dispatch-base.ts:189-196`) rely on |
| Building the override block from the batch branch's commit subjects | It depends on how each merge is worded. `submit` validates each line once, at its source |
| Renaming task rows for the single-PR route (`land` for `merge`, `branch-diff-review` for `pr-review`) | It would put new labels on beads for the same steps. New rows exist only for the two steps per-task mode lacks |
| `hpipe mode` to switch mid-run | §1 |
| Opening the final PR as a draft at start | Every landing would run CI, which the owner chose against, and a red intermediate run has no owner |
| Bumping every run to schema 4 | §5 |
| Routing a red final CI to the task whose `--files` match | That task is torn down, and the match is a guess |

## The owner's answers to pass 2's open questions

1. **Who lands: the orchestrator.** Landing stays the orchestrator's move, "merging is yours, nothing merges
   automatically". Revisit if the smoke run or the next real batch shows the slot sitting in `merge`.
2. **The check is optional.** With no `.claude/pipeline-check`, `start` warns and `status` marks landings unverified.

## Out of scope

- Before-merge conditions (#17/#24). The `ship-merge` prompt points at them, but nothing records them.
- Per-task mode's stale checkout at `implement` after `blocked-on-files`. The single-PR sync step
  fixes it for that mode only.
- Per-task mode running `.claude/pipeline-check`.
- A check longer than an agent's Bash timeout. That would need the check run in the background with
  its result recorded on the ledger (Verify 7).
- Policing a landing push of anything but `land_sha`.
- Deleting remote task branches automatically.
- Workflows that trigger on every push still run on task branches and on the batch branch. The
  pipeline waits for none of them.
- A repo with no CI. `ship-ci` would wait forever, as `ci` does today (`gh.ts:38`).

## Review findings → this design

| Finding | Answer |
|---|---|
| B1 tasks land without the landing gate | Owner decision 5. §3 "The landing gate": `land_sha`; the non-force push as the server's gate; the `land-queue` and `sync` rows; one landing at a time, with waiting tasks unprompted and unprobed; clean versus dirty by the `merge-tree` walk, so a clean sync is re-tested and a dirty one reviewed; `.claude/pipeline-check` run by `hpipe submit`; a fresh-agent fallback for a lost pane (`anyWorker`). Gone with the merge endpoint: the 409 path, `commit_message` and its quoting, the 204 case, the "Residual risk" paragraph, Verify #1, smoke "force a 409", the skill's "on 409" row, and open question 3 |
| M1 landing keyed on a branch ref, through one all-or-nothing fetch | The recorded `land_sha` (§3). A batch-only refspec, and `fetch_error` in status (§3 "Landing detection", §6). The explicit refspec in `fetchBase`, both modes (§2). The deleted-branch smoke step and test (§9) |
| M2 a rewind drops a landed line | The append-only `task.landed`, written at landing and kept by every rewind (§3, §5, §7). The body renders every entry in landing order (§4). The body is tested across a rewind (§9) |
| M3 the fix-task route cannot run | Registration into a single-PR run in `branch-review` or a ship phase moves it to `execute` and reopens intake (§4). The one-repair budget is stated (§4). Open question 2 is closed by owner decision 4. The route is in the smoke run (§9, step 8) |
| M4 a new CLI beside an old supervisor strands the run | `schemas` in the pid file. `start --single-pr` refuses (§1), `status` flags it (§6), and smoke step 0 expects the refusal |
| m1 the checkout path, and `abort` | `run.batch.checkout` is absolute and rendered (§1, §4). `abort`'s single-PR message (§6, §7) |
| m2 squash prerequisites | `start` checks `squashMergeAllowed` (§1). `ship-merge`'s clause covers approvals, `update-branch` and the repo hold (§6) |
| m3 the release check is optional | It is pass/fail in the smoke run, on a release-please-configured hpipe-smoke (§9). The squash commit carries the same lines (§4). Verify 1–2 |
| m4 title validation | Types come from the repo's `changelog-sections` or release-please's default list, and a hidden type gets a note (§3 `submit`) |
| m5 reviewer diff freshness | `{{diff_command}}` fetches both refs with explicit refspecs first (§8) |
| m6 the sync step's push defeats the re-entry check | `submit` ignores merges of batch commits when deciding whether anything was pushed (§3) |
| m7 mode-blind text | `awaitedFor`, `taskOutcomesFor`/`UNLANDED_MEANING`, `losePane`, `finishedTaskNote`, `loopStep` and `closeReason` (§6) |
| m8 the teardown guard is overstated | §3 "complete": the normal path checks nothing in either mode. The guarantee rests on `land_sha` on the batch, and the fallback is named as a fallback |
| m9 stray PRs | `submit` refuses a branch with an open PR (§3) |
| m10 the test plan | §9 has a row or smoke step for each. Smoke "force a 409" is replaced by the gate, dirty-sync, deleted-branch and lost-pane steps |
| "What holds up": `cmdStart` is `cli.ts:195-235` | Corrected (§1) |

## Files this change declares

`src/cli.ts`,
`src/lib/{phases,machine,types,ledger,held,gating,gh,dispatch-base,status,awaiting,tier-prompt,worker-prompt,check,release-title}.ts`
(`check.ts` and `release-title.ts` are new),
`src/supervisor/{tasks,ci,deliver,main,stall,teardown,tick,beads-sync}.ts`, `prompts/` (the new and
edited files in §8), `README.md`, `skills/herdr-pipeline/SKILL.md`, `test/` (§9),
`test/integration/smoke.md`.

## After the pass-2 review

`docs/superpowers/reviews/2026-10-11-single-pr-mode-adversarial-2.md` found pass 2 CLEAR, with 3 majors and 8 minors.
None needed the owner. These answers hold over §1–§9 wherever the two disagree. The implementation follows this section.

### M1: the check covers exactly what lands

- **"Checked".** `submission.check === 'passed'` (or `'none'` in a repo with no check), and one of:
  - `submission.head_sha === land_sha`;
  - `git diff --name-only <submission.head_sha> <land_sha>` lists only paths under `docs/superpowers/reviews/`, which is
    the reviewers' verdict files.
- **`land-queue` routing.** A task goes to `merge` only when it is up to date with `origin/<batch>` and checked. Anything else
  goes to `sync`, including a task that is up to date but unchecked, for example after a reviewer fixed a finding inline.
- **A sync with nothing to merge.** `git merge` reports "Already up to date", so `HEAD == land_sha`. The walk is trivially
  clean, and `submit` runs the check on exactly the tree that lands. No new row and no new edge are needed.
- **Untracked files.** `submit` refuses untracked files that are not ignored (`git status --porcelain --untracked-files=normal`).
  The check must test the pushed tree.
- §3's sentence "every landed tree has passed the check, apart from the reviewers' verdict commits" now holds, and is true
  because of this rule.

### M2: no pushed commit is dropped silently

- **When the reviewed head is recorded.** `land_sha` must contain `submission.head_sha` (`git merge-base --is-ancestor`).
  If it does not, the branch lost the submitted work during review, for example a force-push. The task goes back to
  `implement` with that reason instead of into `land-queue`.
- **When a task takes the slot, and on every `merge` tick.** `git ls-remote origin refs/heads/<branch>` is compared with
  `land_sha`.
  - If they differ, the task goes to `sync` with the reason "`<branch>` moved to `<sha8>` after its reviewed head". The walk
    then meets the extra commits, the sync is dirty, and they go to review. Whatever was pushed lands reviewed and checked.
  - A failed read skips the tick, as `withSendBackHead` does.
  - In `merge` this check comes before the landing check, so a landing already done still records as landed.
- **The `done` notice.** It prints `git push origin --delete` only for task branches whose remote head is contained in
  `origin/<batch>`. It names the rest: "`<branch>` has commits that did not land: `<sha8>`; review before deleting".

### M3: one stuck task cannot stall every landing

- **The queue head.** It is chosen only from tasks in `land-queue` that are either up to date and checked (they go straight to
  `merge`, which needs no worker) or have a live pane. A paneless task that must sync waits, and status says why: "needs an
  agent in its worktree to sync: `<start command>`". When no eligible task exists but paneless ones wait, the orchestrator's
  `land-queue` probe names the start commands.
- **Yielding.** A `sync` holder that has no `sync` submission after `STALL_MINUTES` (15) since entering `sync`, while another
  task waits in `land-queue`, gives up the slot.
  - It goes back to `land-queue` with its `land_sha` kept.
  - Its re-entry takes its `phase_entered_at`, so it goes to the back of the queue.
  - The history reason is "yielded the landing slot: no sync after 15m, t5 waiting".
- **Naming the waiters.** The holder's probe, and its status line, name them: "t5, t6 wait on this sync".

### Minors

| # | Answer |
|---|---|
| m1 | `merge-batch.md`: "If the push is refused for any reason (`rejected`, `fetch first`, `non-fast-forward`, `remote rejected`), end your turn. Never `git pull` in `<repo_root>`: it is the user's working copy." Verify 5 is reworded: the gate is git's client-side ancestry check plus the server's compare-and-swap. A `--force` push is accepted unless a ruleset forbids it. The README and `start` recommend a ruleset blocking force-push and deletion on `batch/*`, and the smoke run creates one |
| m2 | The `sync` edge first asks whether `land_sha` is already in `origin/<batch>`. If it is, the task goes to `merge`, which records the landing |
| m3 | `submit` uses the clean-sync predicate for the `implement` re-entry rule. "Nothing to land" is tree-based: an empty `git diff --name-only origin/<batch>...HEAD` outside `docs/superpowers/` |
| m4 | A task rewind into a non-finished phase, while the run is in `ship`, `ship-ci` or `ship-merge`, moves the run back to `execute`, as registration does. Registration and that rewind are refused once `batch.pr` is merged ("the batch already shipped as PR #n"). The combined check becomes mechanical: a new `hpipe batch-check` runs `.claude/pipeline-check` in the batch checkout at the fetched `origin/<batch>`, and records `batch.checked = { head_sha, at, check }`. `ship` clears only when the PR's head equals `batch.checked.head_sha`, so a fix-task landing forces a new check before CI |
| m5 | One rule per reader. `merged_at_ms` is the machine's: "landed now", and it drives `merge` and the bead. `landed.length > 0` is the record's: "its commits are on the batch", which drives the PR body, "Not in this PR", `UNLANDED_MEANING` in a single-PR run, and the abort message |
| m6 | Every rendered title goes through `shellQuoted` (`unstarted.ts:86-88`): `--title`, `--subject` and the `ship` suggestion |
| m7 | Implementation notes: the paneless `sync` queue runs before `tasks.ts:231`'s `continue`. The `land-queue` clause also names a failing git read and `fetch_error`. The skill says a dirty-sync review spends the task's review counter |
| m8 | §9 gains the unit tests and real-git `submit` cases the review lists, and two smoke steps: a reviewer's inline fix must be checked before it lands, and an orchestrator push in `merge` must land reviewed |

## Implementation notes

Where the code departs from the text above, and why.

- **A landing is always recorded, and a branch head already on the batch has not moved.** Read
  literally, `merge` sends a moved branch to `sync`, and `sync` sends a `land_sha` already on the batch to
  `merge`: a task whose head landed while its branch moved past it would bounce between the two every
  tick. The first cut read the branch head first in `merge`, which dropped the landing of a head that
  had landed, and wedged a task whose whole tip the orchestrator pushed: `sync` then had nothing to
  merge, and `submit` refused it as "nothing to land" for good. Now:
  - The branch counts as moved only when its head adds more than review verdicts to `land_sha` **and**
    `origin/<batch>` does not already contain it. A tip landed in place of `land_sha` therefore closes
    the task, its unreviewed commits on the batch as §7 accepts.
  - Whenever `land_sha` is on the batch, `merge` (and `land-queue`, meeting the same case) appends its
    `landed` line first. A branch that has not moved then closes the task. One that has goes to `sync`
    with the line already recorded, and `merged_at_ms` stays unset, so the bead stays open while the
    extra commits go through review and land as a second landing.
  - `sync` goes straight to `merge` only when `land_sha` is on the batch and the branch has not moved,
    so the two rows never bounce: a moved branch waits for the worker's sync, whose walk meets the extra
    commit, so it lands reviewed.
- **"Moved" and "checked" ignore review verdicts.** A branch head that adds only files under
  `docs/superpowers/reviews/` to `land_sha` has not moved, and a `land_sha` that adds only those to the
  submitted head is checked (the after-pass-2 rule). Both diffs run in `repo_root`'s object store; a
  diff git cannot read, for a commit pushed from another clone, counts as moved and unchecked, which
  costs a sync and never a wrong landing.
- **The tick's `ls-remote` cools down after a failure.** Landing reads one branch head per task in
  `merge`, `land-queue` and a landed `sync` on every tick, and the `done` notice one per task, each under
  the 15 s network budget. With origin unreachable that cost every run in the session 15 s per read per
  tick, so a failure answers for the repo's origin for 60 s, as a failed default-branch lookup does.
  `submit`'s reads are not cooled. The `done` notice also names a branch whose head it could not compare
  with the batch as unknown, not as "has commits that did not land".
- **Yielding, and the queue head, consider only tasks that can take the slot.** A holder yields only
  to a waiting task with a pane, or one that lands without a sync. Yielding to a paneless task that
  must sync would hand the slot to nobody and let the holder take it back at once, re-sending its sync
  prompt every window.
- **A holder whose worker is at work never yields.** M3's window counts from the sync's entry, and a
  conflict resolution plus a long check can outlast it: the yield then turned away the submit the check
  was for, after the check ran. A `sync` holder yields only with no pane, or with its worker read idle;
  one that never finishes is escalated by its own stall ladder, which passes the slot on. A `submit` from
  `land-queue` says the task waits for the slot, and that the sync prompt comes when it must sync.
- **A paneless `sync` is still evaluated.** Its prompt and brief are queued for the next agent, and its
  edge still runs with the worker read as busy, so it can yield the slot or record a landing that
  already happened. A transition into `sync` with no pane queues the same entry instead of handing
  `main.ts` a prompt with no pane to drop.
- **`hpipe task --branch` refuses the batch and default names in a single-PR run only.** The run
  records both; refusing the default name per-task would need a network lookup on every registration.
- **Phase labels are managed per mode.** The reconciler removes every managed label a bead's task does
  not want, and deriving the set from every `TASK_ROWS` phase made `sync` and `land-queue` managed in a
  per-task run too, so a human's `sync` label was stripped from any bead such a run claimed. A run now
  manages only the phase names of rows its mode enters, so a per-task run manages exactly the labels it
  did before, and §6's "on v4 runs' beads only" holds for removing the labels as well as adding them.
- **The worker brief keeps its per-task wording.** "Not into this PR" became `{{change_noun}}` rather
  than a fixed "change", so a per-task run renders exactly today's text, as the edited prompts must.
  The `handoff-pr`/`handoff-batch` fragments carry the paragraph after step 4 too, since it names the
  PR head. A single-PR review names its subject by the range, `` `batch/x...t3-branch` ``.
- **A task rewound while the run reviews or ships moves it to `execute` without reopening intake.** m4
  named the three ship phases; `branch-review` is in the set too, as it is for registration, since a run
  left there would go on to `ship` with the task in flight. The rewound task holds `execute` until it
  finishes; registration still reopens intake, as it always has. Whether the batch PR has merged is asked
  of GitHub once, before the retried save, for the reason `submit`'s checks run there.
- **The batch checkout gets the bootstrap a task worktree gets.** Creating it ends with
  `(cd '<checkout>' && ./.claude/pipeline-bootstrap)` when the repo declares one, as §4 says, and the
  pull path adds the same line "if the pull changed what it builds", as `sync.md` does. Without it,
  `batch-check` ran the check in a tree with no dependencies installed, and `ship.md` sent a subagent to
  fix a toolchain as though it were a defect.
- **The check runs under a 9-minute deadline, in its own process group.** `submit` and `batch-check`
  run inside the agent's 10-minute Bash timeout, which killed the CLI with nothing said and left a hung
  check's children running. At the deadline the whole group is killed and the refusal says the check did
  not finish, with its log's tail. Making a slow suite fit is still the repo's business.
- **`ship`'s conflict check fetches `<into>` first.** The ship steps fetch only the batch, so §4's
  `merge-tree` read an `origin/<into>` as old as its last fetch, perhaps the start, and a PR opened with
  conflicts against a moved default branch gets no CI, leaving `ship-ci` to wait for good. The step now
  renders the explicit-refspec fetch of `<into>` and the `merge-tree` as one command, in the checkout.
- **`hpipe batch-check`** refuses a batch checkout that is not at the freshly fetched batch head, or
  that holds uncommitted work, so the head it records is the tree it checked. With no check declared
  it still records the head, as `check: 'none'`, so `ship` can clear.
- **`submit`'s open-PR refusal fails closed.** `prForBranch` reads any gh failure as "no PR", so a gh
  outage let a branch with an open PR through, and that PR would carry every sibling into the default
  branch. `submit` asks through `openPrForBranch`, which tells the two apart, and refuses with gh's error
  when it cannot say.
- **Branch names are quoted where a command needs it.** `--batch-branch` is checked only by
  `git check-ref-format --branch`, which accepts `batch/it's`, `batch/$(id)` and `batch/a;b`, and m6
  quoted titles and paths but not branches. Every pasted command now passes a branch, a refspec or a
  range through `shellWord`, which quotes only a word the shell would split or run, so an ordinary name,
  and so every per-task render, reads exactly as before.
- **Small additions to the records.** `Submission.dirty_at` names the first commit the walk could not
  account for, for the review's resync note. `start` prints the ruleset recommendation as a third
  line, naming `batch/*`, or the branch itself when `--batch-branch` names one outside it. Status reads
  whether a check is declared from a task checkout or the batch checkout, since the user's working copy
  may sit on any branch, and the `land-queue` probe names the task first in line rather than telling
  every waiting task it is. `closeReason` takes the run as an optional second argument. `evaluateRun` and the run
  renders take the state dir explicitly, since `ship` and `ship-merge` write the PR body and squash
  body beside the run.
- **`ship-merge` records a merge whatever the orchestrator is doing**: the merge is GitHub's fact, as
  a task's `merge` is evaluated with no orchestrator agent. Only `ship` waits for it to be idle.
- **release-please's default sections** are read from source, not memory. With no `changelog-sections`
  configured, release-please passes none to its `conventional-changelog-conventionalcommits` preset (^6),
  whose list shows `feat`, `feature`, `fix`, `perf` and `revert` and hides `docs`, `style`, `chore`,
  `refactor`, `test`, `build` and `ci`; the writer drops any other type. release-please's own heading
  map, which names `deps` and gives `docs` a heading, only labels sections a repo configures. The first
  cut missed `feature`.
