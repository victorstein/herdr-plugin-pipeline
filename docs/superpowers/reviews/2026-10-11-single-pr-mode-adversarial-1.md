# Review: single-PR batch mode design (pass 1)

The design has one blocker: tasks land without the landing gate the owner now requires. Once one task lands, a
sibling lands without ever having been built against it, through `gh api …/merges`, an endpoint that nothing can
make conditional on the batch head. Four more gaps need design changes:
- landing detection is blinded by a single deleted branch;
- a rewind drops an already-landed change from the release notes, which is #23 again;
- the owner's fix-task route for red final CI cannot run as written;
- a new CLI beside an old supervisor strands the run silently, even though the CLI can tell.

**Setup**
- The design was read from `feat/single-pr-mode:docs/superpowers/specs/2026-10-11-single-pr-mode-design.md`.
- The code was read at `bb48694`, exported to the scratch dir. Baseline: `bun test` gave `1420 pass, 0 fail`.
- The owner decisions were checked as given. One changed mid-review: **the landing gate is now YES**. A task may land
  only when `origin/<batch>` is an ancestor of its head.
- Probes:
  - scratch git repos (git 2.54.0, a bare `origin` and two clones);
  - one `bun test` against `advanceRun` (`probes/rewind-execute.test.ts`).

  Nothing touched GitHub or the repo checkout.

**Evidence from outside the repo**
- **release-please `README.md`, "How can I fix release notes?"**
  - The override block replaces the merged commit's message.
  - "The next time Release Please runs, it will use that override section". So editing the body after the merge
    works.
  - "This feature will not work with plain merges … We recommend using squash-merge instead".
  - The README's own example block holds three messages, one per line.
  - It does not say whether the run that the squash merge itself triggers reads the body. The design's verify #2
    stands.
- **GitHub REST, "Merge a branch"**
  - `head` "can be a branch name or a commit SHA1".
  - 201 is a merge commit, 204 already merged, 404 a missing ref, 409 a conflict, 422 validation.
  - It takes only `base`, `head` and `commit_message`. It has **no expected-base precondition** and doesn't say
    whether it ever fast-forwards.

## What holds up

- **Every `file:line` the design cites resolves to what it claims.** This was checked at `bb48694` across
  `phases.ts`, `machine.ts`, `tasks.ts`, `ci.ts`, `gh.ts`, `dispatch-base.ts`, `deliver.ts`, `teardown.ts`,
  `ledger.ts`, `held.ts`, `beads-sync.ts`, `bead-desired.ts`, `status.ts`, `awaiting.ts`, `stall.ts`, `tick.ts`,
  `cli.ts` and the prompts. `cmdStart` is `cli.ts:195-235`, not `-244`.
- **The fixed owner decisions are implemented.**
  - **Mode per run.** `Run.batch` can't be changed after start. §1 makes the case well.
  - **No per-task PR or CI.** `ci` gets `modes: ['per-task']` and `nextPhase` skips it. `rewind` must refuse it,
    because `ciTransitions` skips `pr === null` (`ci.ts:20`).
  - **The bead closes on landing.** `desiredBead` (`bead-desired.ts:111-113`) and `recordBeadClosed`
    (`beads-sync.ts:134-137`) both key on `merged_at_ms`. `hasLanded` and `landedTaskCount` work unchanged
    (`ledger.ts:308-309`, `deliver.ts:320`).
- **The schema split is right.**
  - Every driver filters on `SCHEMA_VERSION` (`main.ts:227,448`, `ledger.ts:321,373`, `held.ts:94`).
  - `beadHolds` reads every schema (`held.ts:67-81`), so even rolled-back code still treats a v4 task's bead as held.
  - v3 routing is untouched, because `modes` only ever removes rows from a single-PR run.
- **The `nextPhase` call-site list is complete** (`machine.ts:177,195,204`, `tier-prompt.ts:36`, `tick.ts:187`).
  - The `LOOP_END` change is required. With `ci` skipped, `phaseLoop` would walk to `done` and throw "the table runs
    out" (`phases.ts:204`).
- **The adoption change is needed.**
  - The fork point is `merge-base HEAD <mainlines>` (`deliver.ts:223`). Against `origin/<default>` alone, that is the
    batch's base, so sibling docs already on the batch read as this task's additions.
  - `mergeAddedDocsArgs` subtracts only docs that a merge brought in on HEAD's first-parent chain
    (`deliver.ts:265-270`). A fast-forward landing (B1's fix) puts none there.
- **Building the override block from the ledger is right**, not from first-parent subjects, and so is squash-merging
  the final PR. Both match the README.
- **`ship-ci` reuses the head-pinned CI read** (`gh.ts:91-105`) and the settle reset (`ci.ts:25-27`). That is the #16
  fix, carried over correctly.
- **`submit` refuses a head the batch already contains.** That is what stops the `merge` level firing on entry.

## Findings

### B1 — BLOCKER: tasks land without the landing gate

**What the design does.**
- Open question 3 recommends no gate.
- The landing command is `gh api repos/{owner}/{repo}/merges -f base=<batch> -f head=<branch>` (§3). It merges
  whatever the branch is.
- `merge` has "no head rule because there is no CI" (§3 table).
- No step after the reviews brings the batch head in or re-tests.
- A 409 is resolved by the orchestrator, and that resolution lands with no review (§3, "Residual risk").

**Why prose cannot add the gate on top of this.**
- The merges endpoint has no expected-base parameter.
- A fetch-then-check-then-merge has a window, and the supervisor's own refs are up to `CI_POLL_SECONDS` (30 s,
  `config.ts:37`) old.
- Only a fast-forward-only ref update enforces "contains the batch head" atomically, on the server. And under the
  gate every legal landing *is* a fast-forward.

**Probed in a scratch repo.**
1. t1 and t2 were cut from the batch base `B0`, and t1 was landed.
2. `git push origin <t2>:refs/heads/batch/x` was refused with `! [rejected] … (non-fast-forward)`.
   `merge-base --is-ancestor origin/batch/x t2` reported stale.
3. After `git merge origin/batch/x` in t2 and a push, the same plain push landed it (`e5e904a..704c8b2`).

**What the design must add.**

1. **A `sync` task row.**
   - It has `modes: ['single-pr']`, `actor: 'worker'` and `holdsFiles: true`, and it is stallable.
   - It sits between the last PR-review row and `merge`.
   - The design rejects new task rows because of "new rows into every v3 reader" (Rejected). That reason doesn't apply
     here: v3 readers never load a v4 run, and `modes` keeps the row off per-task routes. The cost is one new bead
     label, on v4 runs only.
   - `table.test.ts` needs the row's prompt and its `onBlocker` subset rule.
2. **The stale predicate.**
   - It is `git merge-base --is-ancestor refs/remotes/origin/<batch> <task.land_sha>`, with `land_sha` as in M1.
   - It is evaluated on refs fetched by the same poll.
   - It only decides whom to prompt. The push in item 3 is the gate.
3. **The landing command is the gate.**
   - Use `git push origin <land_sha>:refs/heads/<batch>` with no force. The alternative is
     `gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/<batch> -f sha=<land_sha> -F force=false`.
   - The prompt says that a non-fast-forward rejection means "stale: end your turn".
   - `merge` gains a level: not landed and not up to date → `sync`. The landing itself goes through the ledger's
     recorded sha, never the branch.
4. **Who syncs: the worker.**
   - It has the bootstrapped checkout, and the context to resolve a conflict in its own diff.
   - The orchestrator is one serial pane that already lands, decides and dispatches.
   - Consequence: `workerStillNeeded` (`tick.ts:179-196`) becomes true through `sync`, so a pane lost there would fail
     a reviewed task (`tick.ts:213`). Specify the fallback instead: the sync prompt goes to the orchestrator, which
     runs it in the task's checkout through a subagent.
   - This also falsifies §5's line that "a worker is no longer needed once its task is past the reviews".
5. **Races.**
   - Every landing makes every other task that has already synced stale again.
   - If k tasks reach `sync` together and all sync freely, that is k(k−1)/2 syncs and test runs. Each one is a worker
     turn spent from #13's usage budget.
   - Make landing single-flight. Only the oldest task in `sync` with a live worker is prompted. The others wait
     unprompted, which costs k−1 syncs in total.
   - Waiting tasks must be exempt from stall probes while the queue head moves, exactly as `blocked-on-files` is
     behind a live holder (`stall.ts:115-118,137`). Otherwise this is #22 again.
   - The token passes when the head leaves `sync`/`merge` for anything but `close`, so one escalated task can't stop
     every landing.
6. **Re-review only a sync that isn't a clean merge.** The supervisor can decide this mechanically.
   - Every commit from `land_sha` back to the reviewed head must be a two-parent merge whose tree equals
     `git merge-tree --write-tree <p1> <p2>`.
   - Probed:
     - an honest sync matched;
     - an edit amended into the sync merge differed;
     - a hand-resolved conflict made `merge-tree` exit 1.
   - Clean → re-test only. Dirty → the tier's first PR-review row, with its verdict reserved and counted.
   - The file lock means two overlapping tasks are never both past `blocked-on-files` (`gating.ts:129-135`,
     `phases.ts:133-164`). So a dirty sync means `--files` was wrong, or a shared file (#18).
   - `ship.md` already relies on `merge-tree --write-tree`, so the git floor (2.38) is already assumed.
7. **Where the re-test command comes from.** Nothing in the plugin names one.
   - The only repo hook is `.claude/pipeline-bootstrap` (`bootstrap.ts:5`).
   - "Run the tests and the typecheck" is prose (`implement.md:21`, `ci-red.md:23`).
   - With no per-task CI, the sync re-test is the only check a landed tree gets before the final PR. So the Rejected
     row against `.claude/pipeline-check` no longer holds.
   - Add that file beside the bootstrap.
   - `hpipe submit --synced` (the worker's attestation that records the new `land_sha`) runs it itself, in the
     worktree, and refuses on a non-zero exit. That is a CLI process, not the serial tick.
   - When a repo declares no such file, fall back to the prose, and have `status` say the landing is unverified.

**What the gate makes moot.**
- In `merge-batch.md`: the 409 bullet, the `commit_message` and its shell quoting (`unstarted.ts:86`), and the 204
  case.
- The "Residual risk" paragraph.
- Verify #1, whether the endpoint fast-forwards.
- Smoke step 3 ("force a 409").
- The skill's "on 409" row.
- Open question 3.

### M1 — MAJOR: landing is keyed on a branch ref, read through one all-or-nothing fetch

**(a) One missing branch blinds the whole run.**
- §3 runs one `git fetch` with a refspec for `<batch>` and every task branch in `merge`.
- Probed: a second clone landed t1 and deleted t3. Then `git fetch --quiet origin batch/x t1 t3` failed with
  `fatal: couldn't find remote ref t3`, exit 128. `origin/batch/x` was not updated, and t1 was not seen as landed.
  Explicit `+src:dst` refspecs fail the same way.
- `fetchFromOrigin` returns `void` and discards the exit code (`dispatch-base.ts:226-231`).
- The design expects task branches to be deleted: teardown must cope with "the orchestrator may have deleted the task
  branch" (§3), and the `done` notice prints `git push origin --delete` (§6).
- So one deletion while any sibling is in `merge` stops landing detection for the whole run, silently. Meanwhile the
  probe keeps telling the orchestrator to land a branch it already landed.

**(b) A narrow clone never gets the tracking ref.**
- `git fetch origin <name>` with no destination updates `refs/remotes/origin/<name>` only when the remote's fetch
  refspec covers it.
- Probed in a `--single-branch` clone: only `FETCH_HEAD` was written.
- `fetchBase` uses the same form (`dispatch-base.ts:171`). It would then print `base: … as just fetched` for a stale
  local commit, or for none (`dispatch-base.ts:176-184`).
- Teardown already uses the explicit form (`teardown.ts:143`).

**(c) Whatever is on the branch lands.**
- The level reads `origin/<branch>`, so anything pushed after the last review lands unreviewed and un-CI'd.
- A force-push back to a contained commit fires a false landing, which the design concedes.
- Per-task mode at least sent a head pushed after CI back through CI (`machine.ts:236-240`).

**Fix.**
- Record `task.land_sha`. It is the branch head when the last review clears, read with `git ls-remote`, and it
  advances only through a clean sync (B1.6).
- Fetch only `+refs/heads/<batch>:refs/remotes/origin/<batch>`.
- Test `land_sha` ⊂ `origin/<batch>`. Landing never needs the task branch.
- Use the explicit refspec in `fetchBase` too.

### M2 — MAJOR: a rewind drops an already-landed change from the release notes (#23 again)

**What the design says.**
- The override lines are "each landed task's `submission.title`" (§4).
- Rewinding to `implement` or earlier "also deletes `submission`" (§7), and "Re-submitting replaces the title" (§3).
- Yet "a rewind cannot take work off the batch branch" (§7).

**Failure, path 1.**
1. t2 lands `feat(reader): add bookmarks`.
2. `branch-review` finds a seam bug, and the human rewinds t2 to `implement`.
3. The worker submits `fix(reader): keep bookmarks on reload`.
4. The block now carries only the fix. The feature is missing from the notes, and the bump is a patch instead of a
   minor.

**Failure, path 2.** The rework turns out to be unneeded.
1. `submit` refuses ("nothing to land", §3).
2. The human rewinds t2 to `merge`.
3. The level fires, and t2 has no line at all.

**Fix.**
- When `merge` clears, append `{ title, land_sha, at }` to an append-only `task.landed`.
- Never clear it on a rewind.
- Render every entry in landing order.
- Unit-test the body across a rewind.

### M3 — MAJOR: the owner's fix-task route for red final CI cannot run as written

The owner decided that bigger fixes go through a new fix task. §4, route 3, says: "`hpipe rewind <run> execute`.
Then `hpipe task …` … then `hpipe dispatch --done`."

**Why it fails.**
- A run rewind writes the phase and nothing else (`cli.ts:959-967`).
- `intake_closed` is still true from the original `dispatch --done` (`cli.ts:806`).
- `execute` leaves on `intake_closed && tasksAllTerminal` (`machine.ts:78`). Its `gate` signal doesn't wait for an
  idle orchestrator: only artifact and verdict rows do (`deliver.ts:348-349`).
- Probed: a scratch test drove `advanceRun` with `taskSignalsFor`. A run rewound into `execute` with two landed tasks
  went to `branch-review` on its first evaluation, which is the next 1 s tick.
- The following `hpipe task` is then refused, because `branch-review` is not in `REGISTRABLE` (`cli.ts:237`).
- A rewind to `intake` would have worked: registration reopens intake (`cli.ts:531`), and `intake` waits for it. The
  design doesn't say so.

**Related.**
- A rewind zeroes `run.passes` (`cli.ts:961`).
- `MAX_PASSES` is 2 (`config.ts:31`). So the default route, the orchestrator patching, gets exactly one try before a
  second red escalates the run. Say so, or give `ship-ci` its own budget.
- Open question 2 still treats patching as undecided. The owner has decided it is the default.

**Fix.**
- Let `hpipe task` register into a single-PR run in `ship`, `ship-ci` or `ship-merge`, and move the run to `execute`
  in the same save. Or have a run rewind into `execute` set `intake_closed = false`.
- Add the route to the smoke runbook. Step 4 exercises only patching.

### M4 — MAJOR: a new CLI beside an old supervisor strands the run silently, and the CLI can tell

**The design's position.** It accepts "silently unadvanced" and adds a README line. That is the outcome `CLAUDE.md`
warns against ("makes the run silently invisible").

**Why it's the routine path.** Project memory records that installing the plugin does not restart the supervisors in
other sessions.

**The CLI can already see the supervisor.**
- `cmdStatus` already reads the supervisor's pid file through `supervisorState` (`cli.ts:1347`).
- `SupervisorPid` has no capability field yet (`types.ts:314-321`).

**Fix.**
- Write `schemas: [3, 4]` into the pid file at claim (`main.ts:160-167`).
- `start --single-pr` refuses while a live supervisor lacks 4: "restart the supervisor pane first".
- `status` flags a v4 run beside such a supervisor.
- Smoke step 6 expects the refusal instead of "ignored, not driven".

### MINOR

**m1 — The batch checkout path.**
- The plugin's own processes read `$HERDR_PLUGIN_STATE_DIR` (`cli.ts:1520`, `startup.ts:174`). Nothing shows it is set
  in the orchestrator agent's shell. If it isn't, `worktree add $HERDR_PLUGIN_STATE_DIR/checkouts/<id>` targets
  `/checkouts/<id>`. Render the absolute path.
- `hpipe abort` prints only "worktrees and branches left alone … its beads are released" (`cli.ts:1379`). Two problems
  in a single-PR run:
  - the landed beads stay closed, so the message is wrong for them;
  - the batch checkout's removal command, which the design prints only in the `done` notice, is never printed.

**m2 — Squash prerequisites.**
- Check `squashMergeAllowed` at `start --single-pr`. The override "will not work with plain merges".
- Required approvals, or "require branches to be up to date", park the run in `ship-merge`. The run keeps the repo
  meanwhile (`runForRepo`, `ledger.ts:370-383`), so no new `start` is possible. The `ship-merge` probe should say so.

**m3 — The release check is optional, and it's the point of the feature.**
- Verify #2 is still open.
- Smoke step 5 makes the release-notes check optional, "owed on the next real batch". That is the point of the
  feature (#23).
- Configure release-please on hpipe-smoke, and make "one release with N entries" a pass/fail step.
- As a fallback that doesn't depend on the PR-body lookup, the squash body can carry the same lines as footers
  (README, "multiple fixes or features").

**m4 — Title validation.** `^[a-z]+(\(…\))?!?: \S` accepts `feet: …`, and release-please drops it silently. Validate
against the known types, or against the repo's release-please `changelog-sections`.

**m5 — Reviewer diff freshness.**
- `{{diff_command}}` must first fetch `<batch>` and `<branch>` with explicit refspecs.
- A stale `origin/<batch>` moves the three-dot merge-base back, so commits the sync merged in read as this task's own.
- A "scope expansion" BLOCKER on those costs one of only two passes.

**m6 — The `{{sync_step}}` push defeats the "nothing pushed since the review" check.**
- On a BLOCKER re-entry, the sync push alone moves the head off `head_sha_at_entry`.
- So `submit`'s check (§3) passes for an unfixed branch.
- Compare first-parent commits instead, ignoring sync merges.

**m7 — Mode-blind text missing from §6/§8.**
- `taskOutcomesFor`/`UNLANDED_MEANING` render "merged" and "on the base branch" into branch-review's
  `{{task_outcomes}}` (`deliver.ts:372-412`).
- `losePane` reports "pane exited with no PR" for every single-PR task (`tick.ts:213-217`).

**m8 — The teardown guard is overstated.**
- The §3 table says teardown "also accepts a head contained in origin/<batch>". That is `isPushed`, which runs only
  on the fallback for a workspace herdr has already forgotten (`teardown.ts:191-214`).
- The normal path is `herdr worktree remove --force` (`herdr.ts:208`, `teardown.ts:176-183`), and it checks nothing.
- So "never delete unlanded work" rests entirely on the `merge` predicate. That is another reason for M1's recorded
  sha.

**m9 — Stray PRs.** A worker with a per-task habit can still open a PR from its branch into the default branch, and
that PR carries its siblings' commits. Nothing looks for one. `submit` can refuse when `prForBranch(branch)` finds one
(`gh.ts:78-83`).

**m10 — Test plan.**
- Add:
  - the deleted-branch fetch (M1);
  - the release notes across a rewind (M2);
  - route 3 (M3);
  - the version refusal (M4);
  - for B1: the single-flight queue, clean versus dirty sync, the fast-forward rejection, and the stall exemption.
- Drop smoke step 3.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 4
