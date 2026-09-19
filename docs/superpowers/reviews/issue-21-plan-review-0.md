# Adversarial plan review 0 — `docs/superpowers/plans/2026-09-18-issue-21-plan.md`

Reviewed against `docs/superpowers/specs/2026-09-18-issue-21-design.md` (pass 1) at `728a7a3`.

**Method.** Every code block in steps 1–6 and 12 was transcribed into a scratch copy of the repo at
`HEAD` (outside this worktree, under the session scratchpad), together with the call-site migration
step 5 part D mandates. The result compiles — `tsc --noEmit` is silent under `strict` +
`noUncheckedIndexedAccess` — and the full suite runs. The plan's new tests were then run against the
**unmodified** `src/` to check the "**Failing test**" claim of each step, since `bun test` strips
types rather than checking them and will happily execute a test whose call sites carry fields the
current signature does not declare. Three of them pass against the unfixed source; that is MAJOR 1.

What holds up, stated plainly so the findings are not read as a rejection of the whole: `resolveRun`,
`phaseState`, `RunQuery`/`RunResolution` and `resolveFailure` typecheck as written, with no `any` and
no cast beyond the two the plan already flags. The `--run` branch's ordering (terminal → phase) gives
exactly the refusals the spec's table demands. Step 6's `repoContext` derivation is correct and its
test genuinely fails before it and passes after — measured, both directions. Steps 7, 8, 9 and 15
each begin with a test that really does fail. Every spec component C1–C7 is mapped to a step. No step
leaves the tree uncompilable.

---

## MAJOR 1 — three of the plan's "reproduced" regression tests pass against the unfixed source, including the one for #21 itself

**Claim.** Step 5's first test is labelled "Issue #21, reproduced" (plan:376), step 11's asserts
`dispatch --done` "closes the live run, not a finished one that sorts first" (plan:967), and step 10's
asserts `release` clears "the live run reservation, not a finished run with the same task id"
(plan:900). Each step instructs the implementer to run it and see it fail (plan:412, plan:921,
plan:984).

**Problem.** Run against `src/` at `HEAD`, with no fix applied at all, step 5's #21 test and step 11's
test **pass**, and step 10's test is a coin flip. Step 11 therefore has *no* failing test — it is a
pure refactor with a guard nothing exercises — and #21, the issue this branch is named after, ships
with a vacuous regression test.

**Evidence.** All three transcribed verbatim into the scratch copy and run against unmodified `src/`:

    PROBE sort order: [ "clicmd-repo-aUH0La-20260919-zzz-mine-13su", "r-20260919-aaa-other-dw3c" ]
     24 pass
     0 fail

The three causes are distinct:

- **Step 5 (plan:377-379).** `newRun` prefixes `run_id` with the *basename of `repoRoot`*
  (`src/lib/ledger.ts:22`, `:25`), and `listRuns` sorts by filename (`src/lib/ledger.ts:57`). The
  foreign run is seeded `repoRoot: '/r'` → `r-…`; the caller's run is seeded `repoRoot: repoDir` →
  `clicmd-repo-…`. `c` < `r`, so the caller's run already sorts **first** and the pre-fix
  first-match lookup picks it anyway. The comment "the other repo wins today" is measurably false.
- **Step 11 (plan:967-981).** `cmdDispatchDone` already filters on phase when `--run` is absent
  (`src/cli.ts:173`), which the spec's own table records ("phase, when `--run` is absent. No repo." —
  spec:102). A terminal run is therefore already skipped today. The gap this step closes is the
  **repo** filter, and the test exercises the terminal filter instead.
- **Step 10 (plan:901-907).** `runWithTasks` (`test/cli-commands.test.ts:47-51`) calls `newRun` with
  `title: 'a'`; the test assigns `done.title = 'aaa finished'` *after* construction, so the slug
  baked into `run_id` stays `a` for both and the sort falls through to the random 4-char suffix
  (`src/lib/ledger.ts:21`). Measured over 15 pre-fix runs of that test alone: **7 pass, 8 fail**.

**Concrete fix.**

- Step 5: seed the foreign run so it sorts first — `repoRoot: '/aaa'` (giving `aaa-…`) instead of
  `'/r'` — and keep `repoKey: '/repos/aaa'`. Re-run against unfixed `src/` and confirm it fails with
  the task landing in the foreign run.
- Step 11: replace the fixture with the defect the step actually closes — a **live** run in a second
  repo (`repoKey: '/repos/aaa'`, `repoRoot: '/aaa'`) that sorts first, plus the caller's live run —
  and assert `intake_closed` lands on the caller's. Keep the terminal case only as a second
  assertion if desired.
- Step 10: pass the titles to `newRun` rather than assigning them afterwards, so the slug (and hence
  the sort) is deterministic. `runWithTasks` takes no title argument, so construct the two runs with
  `newRun(...)` + `run.tasks = […].map(mkTask)` inline, as step 8's decide fixtures already do
  correctly (plan:741-747).
- Add a line to the plan's TDD preamble: `bun test` does **not** typecheck, so a new call site's
  extra fields never make a test fail — only an assertion can.

---

## MAJOR 2 — step 17's "prove the new tests bite" check cannot run: by step 17 the tree is clean and `git stash push` saves nothing

**Claim.** Step 17 item 2 (plan:1326-1329): "`git stash push -u -m "issue-21-bite-check"`, capture the
sha with `git stash list --format='%H %gs'`, confirm the new tests fail against the old `src/`, then
`git stash apply <sha>` and drop the entry by tag."

**Problem.** Every step 1–16 ends with "**Commit.**" (plan:178, 231, 296, … 1311), so at step 17 the
working tree is clean and there is nothing to stash. Worse, the plan's own preamble warns the stash
stack is shared across worktrees (plan:1328-1329) — so `git stash list` at that moment returns
*another session's* entries, and `git stash apply <sha>` against the first one applies a stranger's
work. And even if there were changes, a whole-tree stash removes the new **tests** along with the new
`src/`, so "the new tests fail against the old `src/`" is not what would be measured.

This matters more than a normal verification nit: this bite check is the only thing in the plan that
would have caught MAJOR 1, and as written it is a no-op.

**Evidence.** Simulated in this worktree at `728a7a3` (clean, as it will be at step 17):

    $ git status --porcelain      # (no output)
    $ git stash push -u -m 'probe-noop'
    No local changes to save
    $ git stash list --format='%gd %gs'   # (no entry created)

**Concrete fix.** Replace item 2 with a check that works from a clean tree and touches only `src/`:

    git switch --detach
    git checkout bd04775 -- src/ prompts/     # the base commit's implementation, new tests kept
    bun test                                   # expect the new tests to fail, and name which
    git checkout HEAD -- src/ prompts/
    git switch -

No stash, no shared stack, and the tests stay at their new revision, which is what "the new tests
fail against the old `src/`" means. Name in the plan the minimum set expected to fail — after MAJOR 1
is fixed, at least one per step from 5 through 15.

---

## MAJOR 3 — the spec's mandatory argv test 16 has no step, and two further mandated assertions are dropped

**Claim.** The plan's step map (plan:37-55) covers C1–C7, and step 17 claims "3 in
`test/cli-argv.test.ts`" (plan:1323).

**Problem.** The plan adds **two** `test/cli-argv.test.ts` tests, not three: step 6's worktree test
(plan:527) and step 12's outside-a-repo test (plan:1029). Spec testing item **16** —
"`hpipe decide --task t1` from a second fixture repo does not reach the first repo's run"
(spec:566) — is in no step. The spec does not treat it as optional: "`.claude/agents/plugin-dev.md`
records that DI-faked unit tests 'have passed clean over real defects twice', which is why 15–17 are
**mandatory rather than optional**" (spec:570-571). It is also the only end-to-end proof that the
command **workers** actually type resolves across repo boundaries, which is #21's shape.

Two smaller mandated assertions are also dropped:

- Item **8b** (spec:541-543) requires that `cmdRelease` with `--run <terminal id>` succeeds, and that
  `cmdDecide`'s failure message does **not** name `rewind` or `resume` (MAJOR 3 of the spec review).
  The plan pins the `--run` escape for `cmdBrief` (plan:655-657) and `cmdAnswer` (plan:846-851) but
  not `cmdRelease`, and nowhere asserts the absent recovery.
- Item **17** (spec:567-568) requires the outside-a-repo command to fail *and* to **succeed when
  `--run` is supplied**. Step 12's test (plan:1029-1040) asserts only the failure half — so the
  documented escape from outside a repo is never executed.

**Evidence.** `grep -c` over the plan's step bodies: `test/cli-argv.test.ts` appears as a target in
steps 6 and 12 only (plan:44, plan:50). No step body contains a second fixture repo. No step body
contains `not.toContain('rewind')` or a `cmdRelease(… runId: <id>)` call.

**Concrete fix.**

- Add to step 12 (same file, same fixture shape) the item-16 test: build a second `fixture()`, run
  `hpipe start` in it, register a task there, then run `hpipe decide --task t1` from the *first*
  repo and assert it refuses rather than filing onto the second repo's run. `fixture()` is already
  reusable as-is (`test/cli-argv.test.ts:20-35`); `started()` is not, so call `fixture()` twice.
- Extend step 12's test with the success half: the same command plus `--run <that run's id>` from
  the non-repo cwd, asserting exit 0. The run id is available from `hpipe start`'s stdout.
- Extend step 10's new test with a `--run <done.run_id>` call asserting `ok === true` and that
  `done`'s `t1.files` is then cleared.
- Add to step 8's first test: `expect(result.text).not.toContain('rewind')` and
  `.not.toContain('resume')`.
- Correct step 17's arithmetic while you are there — see MINOR 2.

---

## MINOR 1 — three of C7's documentation edits are missing from step 16

Spec C7 (spec:345-353) lists, beyond what step 16 does: the `hpipe decide`/`answer` passages in
`test/integration/smoke.md` at `:266-270` and `:297-301` gaining "a one-line note that these now
resolve against the caller's repo (A15)", and the README escape-hatch rows at `:99-100`. Step 16
(plan:1266-1311) edits README `:79-80`, `:89`, inserts a new row after `:99`, and rewrites smoke.md
`:134-136` and `:542-544` — but leaves the two smoke.md decide/answer passages and README `:99`
untouched. README `:99` is now incomplete: after step 14, `hpipe rewind` also abandons open decisions
on a terminal target, and the row still says only "clears retry counters, any undelivered answer,
and (rewinding to `dispatch`) worktree adoption". The smoke.md omission matters operationally —
`:264-270` instructs the operator to run `hpipe decide` **from the worker's pane**, which after
step 12 only works because of C2, and a reader hitting the refusal has nothing to go on.

**Fix.** Add the three edits to step 16, with the exact replacement prose, as the step does for its
other four.

## MINOR 2 — four citation and count errors that will cost the implementer a search each

- plan:503 — "the **28** existing `cmdTask` call sites". There are **20**: 12 in `test/cli.test.ts`
  and 8 in `test/cli-commands.test.ts` (`grep -c 'cmdTask('`). The line lists that follow
  (plan:508-511) are correct; only the total is wrong. 28 is the new-test count.
- plan:813-814 — "the **seven** existing `cmdDecide` call sites (`test/decide.test.ts` lines 99, 107,
  110, 123, 136, 156, 168, 178, 194)". Nine line numbers for seven sites, and `:156` and `:178` are
  `cmdAnswer` calls, not `cmdDecide`. The real set is 99, 107, 110, 123, 136, 168, 194.
- plan:1322-1323 — the breakdown "11 in `test/cli-commands.test.ts` … 3 in `test/cli-argv.test.ts`"
  is 12 and 2 respectively (steps 5, 7, 10, 11, 13, 14, 15 add 2+2+1+1+2+3+1 = 12; steps 6 and 12
  add 1 each). The grand total of 28 and every intermediate count (466, 467, 469, 472, 473, 474,
  475, 476, 478, 481, 482) are correct.
- plan:412 — "`bun test test/cli-commands.test.ts` # **fails to typecheck** / rejects the extra
  fields". `bun test` strips types and never typechecks; extra object-literal fields are silently
  accepted at runtime. The step's test does fail, but via its *second* case (the ambiguity
  assertion), not the one stated.

## MINOR 3 — the failure sentence is ungrammatical, and step 16 writes it into the smoke doc

`resolveFailure` composes `fail(\`found no ${scope}\`)` (plan:467) where `scope` begins with
`phraseFor(...)` → `"a run in intake, dispatch or execute"` or `"a live run"` (plan:426-431). The
rendered text is therefore "**found no a run in intake, dispatch or execute** for … in session …" —
measured verbatim from the scratch build:

    found no a run in intake, dispatch or execute for /private/var/.../T/wt-1789810987007 in session argv-fixture

Step 16 then pins that string into `test/integration/smoke.md` (plan:1294). This is the message the
operator reads at exactly the moment they are already confused.

**Fix.** Drop the article: make `phraseFor` return `"live run"` / `"run in intake, dispatch or
execute"` and have the two call sites supply their own article — `found no ${scope}` becomes
`found no ${scope}`, with `scope` starting `"run in …"`, and the `wrong-phase` branch reads
`this needs a ${phraseFor(...)}`. Update step 16's smoke.md text to match.

## MINOR 4 — step 6's worktree fixture leaks into the system tmpdir on every test run

Step 6 creates the worktree at `join(f.repo, '..', \`wt-${Date.now()}\`)` (plan:532), which resolves
to `<tmpdir>/wt-<ms>` — a sibling of the fixture repo, not a path registered in the helper's
`created[]` array (`test/helpers/git-worktree.ts:5`, `:12-16`). `cleanupFixtures` (`:49-51`) only
removes what `tempDir` created, so every run of the suite leaves a directory behind permanently.
Confirmed in the scratch build: the path in the measured failure output above,
`/private/var/folders/.../T/wt-1789810987007`, survives `afterEach`.

**Fix.** `const worktree = join(tempDir('hpipe-argv-wt-'), 'wt')` — the shape `repoWithWorktree`
already uses (`test/helpers/git-worktree.ts:36`), which registers the parent for cleanup.

## MINOR 5 — step 13's validation branches on `input.taskId === null`, but `cmdRewind` branches on truthiness

Step 13 selects the row table with `input.taskId === null ? RUN_ROWS : TASK_ROWS` (plan:1112), while
the code it guards selects its branch with `if (input.taskId)` (`src/cli.ts:191`). For
`input.taskId === ''` the two disagree: the phase is validated against `TASK_ROWS` and then written
to `run.phase`. `flag(rest, 'task')` can return `''` (`src/cli.ts:361-364`), so `hpipe rewind <run>
done --task ""` reaches it. Harmless today, but it is the exact class of mismatch C5b exists to
close.

**Fix.** Use the same predicate in both places: `const isTask = Boolean(input.taskId)` computed once,
above the validation, and `if (isTask)` at `:191`.

---

**Verdict rationale.** No BLOCKER: every code block compiles as written, no step leaves the tree
broken, and all seven spec components map to steps. The three MAJORs are test-coverage and
verification defects, each with a mechanical fix stated above — none reverses a decision, changes
scope, or needs a call only the human can make. MAJOR 1 and MAJOR 2 compound, though: the bite check
that would have exposed the vacuous tests is itself inoperative, so fix MAJOR 2 first and let the
repaired check confirm MAJOR 1.

VERDICT: CLEAR
