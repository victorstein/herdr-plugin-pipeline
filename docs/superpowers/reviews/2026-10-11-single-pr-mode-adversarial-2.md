# Review: single-PR batch mode design (pass 2)

Pass 2 closes the blocker and all four majors. The landing gate is now sound:
- a recorded `land_sha`;
- a non-force push as the gate;
- a single-flight slot;
- a mechanical clean/dirty sync test.

Every gate claim I probed holds against real git. Three new majors come from the same move, landing a recorded sha instead of
the branch:
- The check does not test what lands. CLEAR reviews fix findings inline after `submit`, and nothing re-checks them.
- Commits pushed after the reviewed head are dropped with no report, and the `done` notice's clean-up then deletes them.
- The slot turns one stuck or paneless sync into a run-wide stall of up to five hours, with every waiting task exempt from
  probes.

None of them needs an owner decision.

**Setup**
- The design was read from `feat/single-pr-mode:docs/superpowers/specs/2026-10-11-single-pr-mode-design.md` at `421bee1`. Below it
  is cited as `design:<line>`.
- The code at `bb48694` was exported to the scratch dir. Baseline: `bun test` gave `1420 pass, 0 fail`.
- The owner decisions were checked as given. Two pending answers were assumed: the orchestrator lands, and
  `.claude/pipeline-check` is optional.
- Probes ran on git 2.54.0, in `single-pr-review2/probes/`. Nothing touched GitHub or the repo checkout.
  - `walk.sh` is the design's clean-sync predicate (`design:292-300`), implemented as specified. `scenarios.sh` runs 17 cases
    through it, and `crisscross.sh` and `attr/` add more.
  - `push.sh` checks the non-force push: an origin, the orchestrator's `repo_root`, a linked worktree, another clone and a
    `--single-branch` clone. A second probe races two pushes from one base, behind a `pre-receive` that sleeps 3 s.

## Pass-1 findings

| # | Status | Evidence |
|---|---|---|
| B1 no landing gate | **Closed** | `land_sha` (`design:221-231`). The non-force push (`design:262-276`); probe P1/P2/P4 refused, P3 landed, and a race of two pushes refused the loser server-side as `[remote rejected] (incorrect old value provided)`. `land-queue`/`sync` and the slot (`design:233-260`). The walk agrees with git in every case below. `pipeline-check` is run by `submit` (`design:332-336`). The `anyWorker` fallback is at `design:344-361`. New problems: M1–M3 |
| M1 branch-keyed landing, one all-or-nothing fetch | **Closed** | (a) A batch-only refspec, plus `fetch_error` (`design:395-407`). (b) The explicit refspec in `fetchBase` (`design:171-177`). (c) `land_sha`, never re-read. The residue is M2 here: what `land_sha` leaves behind is dropped silently |
| M2 rewind drops a landed line | **Closed** | `landed` is append-only (`design:608`, `758-759`), with dedupe on the last `land_sha` (`design:410-412`) and lines in landing order (`design:497-500`). Residue: m5 |
| M3 fix-task route cannot run | **Closed** | Registration in `branch-review`/`ship*` moves the run to `execute` and reopens intake (`design:539-553`). The one-repair budget is stated (`design:522-526`). Residue: m4, since a task *rewind* in a ship phase reopens nothing |
| M4 new CLI, old supervisor | **Closed** | `schemas` is written at claim (`main.ts:161-168` → `claimPid`, `pidfile.ts:33-35`). `start` refuses on `live` without 4, and `status` flags the run. Nothing rewrites the pid file after the claim (`writePid` has no caller), so the field cannot be lost mid-life. The CLI is always the installed copy |
| m1 checkout path, abort text | Closed | `design:134`, `450-458`, `729-735` |
| m2 squash prerequisites | Closed | `design:124-127`, `720` |
| m3 release check optional | Closed | The squash body carries the lines (`design:563-567`), and smoke step 9 is pass/fail. Residue: m6 (quoting) |
| m4 title validation | Closed | `design:374` |
| m5 reviewer diff freshness | Closed | `design:792` |
| m6 sync push defeats re-entry check | **Partly** | `design:378` tests "is a merge", not "is a clean merge". See m3 |
| m7 mode-blind text | Closed | `design:693-705`. The `missingPr` branches (`stall.ts:326-352`) are replaced by `design:717` |
| m8 teardown guard overstated | Closed as worded | The `done` notice's unconditional `git push origin --delete` (`design:725`) reopens the hazard. See M2 |
| m9 stray PRs | Closed at `submit` | — |
| m10 test plan | Closed | New gaps in m8 |

## What holds up

**The clean-sync walk is right.** `scenarios.sh` and `crisscross.sh` drove `walk.sh` through these cases:

| Case | Result |
|---|---|
| One honest merge | CLEAN |
| Two honest merges | CLEAN |
| Both sides make an identical change | CLEAN |
| `-X theirs` with no conflict | CLEAN |
| Criss-cross with agreeing inner resolutions | CLEAN, and `git merge` agrees |
| Extra commit after the merge | DIRTY |
| Extra commit before the merge | DIRTY |
| Evil (amended) merge | DIRTY |
| Hand-resolved conflict | DIRTY |
| Conflict resolved exactly to the batch side | DIRTY |
| Conflict markers committed | DIRTY |
| `-X theirs` over a real conflict | DIRTY |
| `-s ours` | DIRTY |
| Rebase | DIRTY |
| Unrelated commit through a side merge | DIRTY |
| Merging from "batch + 1 commit" | DIRTY |
| Reverse merge, with the batch as first parent | DIRTY |
| Criss-cross with disagreeing inner resolutions | DIRTY, conflict in both tools |

- Every conflict, whatever its resolution, is dirty only because the walk checks `merge-tree`'s exit code. The design does check it (`design:297`), and it must stay.
- `merge-tree` honours `.gitattributes` `merge=union` and config-declared drivers exactly as `git merge` does (`attr/`).
- It reads dirty only when the driver is missing from the environment `submit` runs in, which is conservative.
- No sequence of parents lets a non-batch line through. Every first-parent step's second parent must be on the batch, and its tree
  must equal the automatic merge.

**The push gate holds with stale local refs.**
- The client checks ancestry against the *advertised* remote head, not the tracking ref.
- The server compare-and-swaps the old value. In the race probe the loser got
  `cannot lock ref … is at 78bf1db but expected b4dfb02`.
- A successful push from a normal clone updates `refs/remotes/origin/<batch>` on its own (P3). A `--single-branch` clone writes
  no tracking ref (P6), so the supervisor sees the landing on the next 30 s poll.

**The slot is crash-safe.** It is derived from phases on every tick, so a supervisor crash, a lost save or a rewind can leave at
worst two holders. `design:254` is right that this costs one refused push, never a wrong landing.

**The new rows fit every row-keyed reader.**
- **Gating.** `isInFlight` (`gating.ts:129-135`) works unchanged.
- **Beads.** `PHASE_LABELS` (`bead-desired.ts:21`) and `desiredBead` (`:104-139`) give `in_progress`, then `closed` on
  `merged_at_ms`.
- **Teardown and pane checks.** `FINISHED` (`teardown.ts:16-18`), `awaitsWorktree` (`deliver.ts:296-299`) and `unstartedWorker`
  (`unstarted.ts:28-33`) are all correct. `land-queue` has no actor, so a pane lost there is not flagged, which is right.
- **`table.test.ts`.** Every assertion holds for the new rows: the counter on `ship-ci`, an exit on every non-terminal row, and a
  probe target on `land-queue`.

**The schema split still holds.**
- Every reader goes through `isCurrentSchemaRun` (`main.ts:227,448`, `ledger.ts:321,373`, `status.ts:404,418`), except
  `held.ts:94`, which the design names.

## Findings

### M1 — MAJOR: `.claude/pipeline-check` does not check what lands

**What the design does.**
- The check runs inside `submit`, on `submission.head_sha` (`design:332-334`).
- What lands is `land_sha`: the branch head at the last CLEAR, read with `ls-remote` (`design:223-227`).
- The design asserts that "every landed tree has passed the check, apart from the reviewers' verdict commits, which only add
  review files" (`design:341-342`).

**That is false: code reaches `land_sha` after the check.**
1. **Reviews that CLEAR fix findings inline.** Every review prompt ends "Otherwise `CLEAR`, with MAJORs and MINORs fixed inline"
   (`pr-review.md:64`, `pr-review-intent.md:52`, `pr-review-quality.md:51`). The code already records CLEAR reviews editing
   (`tasks.ts:258-262`).
2. **Pushes during review.** #16's first form was a commit "pushed during pr-review" (`notes/…berean-os-live-run.md:236-238`).
3. **Pushes after `submit` and before idle.** The `implement` edge only asks that the submitted head differ from
   `head_sha_at_entry` (`design:194`).
4. **Untracked files.** `submit` tests cleanliness with `--untracked-files=no` (`design:375`). A file the subagent created but
   never `git add`ed is present for the check and absent from the pushed tree.

**Why per-task mode never had this.** Its `ci` row sat after the last review (`phases.ts:145,152`) and caught all four.

**Failure.**
1. A heavy-tier quality reviewer fixes a MAJOR inline: it renames a helper and misses a caller in a test. It CLEARs.
2. `land_sha` includes the fix. The task is up to date, so it goes `land-queue → merge` with no `sync` and no check, and it lands.
3. The next sibling's `submit` fails its check on that test. Its worker repairs another task's code, so its sync is dirty and
   that repair is reviewed as the wrong task.
4. If nothing syncs after it, the final PR goes red and spends the run's only repair (`design:522-526`).

**Fix.**
- Make "checked" part of `land-queue`'s routing. Up to date *and* checked goes to `merge`. Anything else goes to `sync`.
- "Checked" means `land_sha == submission.head_sha`, or a diff between them that touches only `docs/superpowers/reviews/`.
- In `sync` with nothing to merge, `HEAD == land_sha`. The walk is then trivially clean, and `submit` runs the check on exactly
  what lands. No new row and no new edge are needed.
- Refuse untracked, non-ignored files in `submit` (`--untracked-files=normal`), or run the check in a detached
  `git worktree add` of `HEAD`.
- Correct `design:341-342`.

### M2 — MAJOR: commits pushed after the reviewed head are dropped with no report, then deleted

**What the design does.**
- "A push to the branch after its review changes nothing that lands" (`design:230-231`), and `merge-batch.md` says "push this
  sha and no other".
- The `merge` level reads only `land_sha`.
- Teardown's normal path checks nothing (`herdr.ts:208`).
- The `done` notice prints `git push origin --delete <task branches>` for every task (`design:725`).

**The measured case this hits.** In `merge`, "the orchestrator pushed a test-registration hand-off commit onto t3's branch"
(`notes:244`, `411-412`; #16, second form). Per-task mode sent that head back through `ci` and merged it (`machine.ts:236-240`).

**Failure.**
1. The orchestrator pushes the registration onto t3's branch, out of habit.
2. It then lands `land_sha`, as told.
3. t3 is recorded as landed, its bead closes, and its worktree goes. Its new test is never compiled into the batch, and nothing
   says so.
4. The clean-up command deletes the only remaining copy.

`design:426`'s "never delete unlanded work" does not hold for pushed commits.

**A related edge.**
- `land_sha` is only ever compared with `origin/<batch>`, never with the submitted work. A branch force-pushed back to a batch
  commit during review gives a `land_sha` that the batch already contains.
- `land-queue` routes that to `merge` as "already landed" (`design:244`), and the task closes with its work gone.

**Fix.**
- When a task takes the slot, and in `merge`, compare `git ls-remote origin refs/heads/<branch>` with `land_sha`. One gh-free
  call, as `withSendBackHead` already makes.
- If the head moved past `land_sha`, route to `sync`. The walk then meets the extra commit, marks the sync dirty and sends it to
  review, so the commit lands reviewed and checked.
- Require that `land_sha` contains `submission.head_sha` when it is recorded.
- Print `--delete` only for branches whose remote head is contained in `origin/<batch>`. Name the rest: "has commits that did
  not land".

### M3 — MAJOR: the slot turns one stalled sync into a run-wide stall, and silences the tasks behind it

**What the design does.**
- The queue head is the oldest task in `land-queue`, whether or not it has a worker (`design:239-240`). Pass 1 asked for "the
  oldest … with a live worker".
- Waiting tasks are never probed while a holder exists (`design:256-260`).
- `blocked-on-files` tasks behind a `land-queue` file holder are exempt too. The holder is non-terminal (`stall.ts:115-118,137`).

**So only the holder's own ladder can end a stall, at today's per-task cadence.**

**(a) A paneless head.**
- The design makes a pane lost in `land-queue` a release (`design:351-353`).
- When that task reaches the head behind the batch, it takes the slot into `sync` with no agent.
- It is overdue at once, because `adopted_at` is long past (`unstarted.ts:35-38`). It is probed at `STALL_MINUTES` = 15
  (`main.ts:519-521`) and escalated after 3. So every landing waits about 60 minutes on the orchestrator starting an agent.

**(b) A live but stuck holder.**
- `sync` probes go to the worker (`outbox.ts:109`) at `TASK_STALL_MINUTES` = 45.
- Escalation follows 3 probes, plus up to 3 holds while the pane reads `working` (`stall.ts:535-541`, `config.ts:33-34`).
- That is 180 minutes for a stuck worker that reads idle. It is 315 minutes for one that reads working, for example re-running a
  hung check inside its 10-minute Bash timeout.
- The orchestrator hears nothing until the escalation. In per-task mode the same worker blocked only its own task.

**Fix.** Correctness never rests on the slot (`design:254`), so preemption is free.
1. Take the head from the tasks that are up to date or have a live pane.
2. A `sync` holder that has not submitted within `STALL_MINUTES` while others wait yields the slot. It goes back to `land-queue`
   and keeps its `land_sha`, at the cost of one more merge later.
3. At least, the holder's probe and the status line name the waiters: "t5, t6 wait on t4's sync".

### MINOR

**m1 — Every push rejection needs the same handling, and the gate is git's, not GitHub's.**
- The probes produced three refusals:
  - `! [rejected] (fetch first)`, when the remote head is not in `repo_root`'s object store. Its hint says `git pull`, which in
    `repo_root` means the user's working copy.
  - `(non-fast-forward)`.
  - `! [remote rejected] (incorrect old value provided)`, from a lost race.
- `design:271` and the `merge` clause (`design:717`) name only the second. Say "any `rejected`: end your turn".
- "GitHub refuses any push that is not a fast-forward" (`design:87`, Verify 5) is the client's ancestry check plus the server's
  compare-and-swap. A `--force` landing is accepted unless a ruleset forbids it.
- Recommend a repo ruleset that blocks force-push and deletion on `batch/*`. That also makes §7's "unsupported" row
  server-enforced.

**m2 — A landed task rewound into `sync` is stranded.**
- `design:759` allows the rewind, restoring `land_sha` from `landed`.
- `git merge origin/<batch>` then fast-forwards, and `submit` refuses: "nothing to land" (`design:377`).
- The task sits in `sync` until `synced` escalates, about three hours later.
- Fix: let the `sync` signal treat a `land_sha` the batch already contains as landed, and go to `merge` (`design:244`'s rule).

**m3 — m6's rule is the wrong predicate.**
- An evil merge that carries a fix (S5) is refused as "nothing but merges".
- `head_sha_at_entry` can be null on a first entry, or off the first-parent chain, and the walk's end is then undefined.
- On first entry, a worker that only ran `{{sync_step}}` submits a pure merge. It passes "nothing to land", because the merge is a
  new commit, and lands an empty change with a release line.
- Fix: reuse the clean predicate for m6. Make "nothing to land" tree-based: an empty `git diff origin/<batch>...HEAD` outside
  the artifact root.

**m4 — Ship phases ignore task rewinds, and the fix-task route skips `ship`'s check.**
- **Rewinds.** Rewinding a landed task to `implement` while the run is in `ship-ci` is M2's own scenario, and the natural reaction
  to red CI. It reopens nothing.
  - `ship-merge` can still squash-merge.
  - The run then reaches `done`, which `releasesPane`, so it is no longer driven, and the task is stranded or lands on a shipped
    batch.
  - Fix: a task rewind into a non-finished phase moves a single-PR run in `ship*` back to `execute`, as registration does.
- **Registration in `ship-merge`.** It should refuse when `prView(batch.pr).merged`. Otherwise the fix lands after the squash, and
  `ship` opens a second PR from a branch already shipped.
- **The fix-task route.** `ship` clears on the first idle tick (`design:537`, because `head_sha_at_entry` is kept). So `ship.md`
  step 1, the only local run of the combined tree, is skipped before the run's last CI attempt.

**m5 — "Landed" is read from three different fields.** Take a task that landed, was rewound and then failed:
- its code is in the final PR;
- `merged_at_ms` is cleared (`cli.ts:947-951`);
- `UNLANDED_MEANING.failed` tells branch-review "its work never merged" (`deliver.ts:373`);
- the body's "Not in this PR" line (`design:488`) is right only if "never landed" means `landed.length === 0`.

Say which field each reader uses.

**m6 — Titles are rendered into single quotes.**
- `--subject '<first landed title>'` (`design:561`) and `--title '<title>'` (`design:471`) break on `fix: don't …`, which the
  title pattern accepts. That is #5's class (`notes:412`).
- Render both through `shellQuoted` (`unstarted.ts:86-88`).

**m7 — Implementation notes the design should state.**
- **The paneless `sync` queue.** It must run before `tasks.ts:231`'s `continue`. The transition's own prompt has
  `paneId: null`, which `main.ts:309` drops.
- **The `land-queue` clause.** "Can only mean the run is not being advanced" (`design:259`) also hides a failing git read (exit
  ≠ 0/1 skips the tick) and `fetch_error`, so name both.
- **A dirty-sync review spends the task's monotone review counter.** A task that already took one BLOCKER escalates on the first
  BLOCKER against its conflict resolution. Say so in the skill.

**m8 — Test plan gaps.**
- **Unit tests:**
  - M1: an inline-fix CLEAR routes to `sync`, and a re-check runs.
  - M2: a moved branch head routes to `sync`; the `--delete` list is filtered; a `land_sha` that lacks the submitted head is
    refused.
  - M3: head selection skips a paneless task, and a holder yields the slot.
  - m2: a landed task rewound to `sync`.
  - m4: a task rewind during `ship-ci`, and registration after the PR merged.
- **Real-git `submit` cases.** Add the probed walk cases to the five planned. They are cheap and already pass:
  - criss-cross, both variants;
  - `-X theirs` over a conflict;
  - `-s ours`;
  - the reverse merge;
  - the side-branch commit;
  - `merge=union`.
- **Smoke.** Two #16-shaped steps in single-PR mode:
  - a reviewer's inline fix, which must be checked before landing;
  - an orchestrator hand-off push while the task is in `merge`, which must land reviewed and not vanish.

VERDICT: CLEAR
BLOCKERS: 0
MAJORS: 3
