# Plan review pass 1 — issue #9, artifact path adoption

**Plan:** `docs/superpowers/plans/2026-09-17-issue-9-plan.md` (v2)
**Spec:** `docs/superpowers/specs/2026-09-17-issue-9-design.md` (v3, cleared at spec pass 1)
**Pass 0:** `docs/superpowers/reviews/issue-9-plan-review-0.md` — `VERDICT: BLOCKER`, 1 blocker /
2 majors / 3 minors, all six claimed applied by plan v2.

## Method

Same method as pass 0: I executed the plan rather than reasoning about it. Baseline re-confirmed in
this worktree — `bun test` → **351 pass / 0 fail / 33 files**, matching plan:4. The worktree was then
copied outside the repo and steps 1-9 applied **literally** — the code blocks as written, the prompt
replacement as written, the tests as written.

**Executing the plan as written: 367 pass / 0 fail / 33 files. `bun run typecheck` clean.** Exactly
the numbers plan:11-12 and plan:779 claim. The repo worktree itself was never modified.

Every step's red was then reproduced individually by deleting that step's implementation line(s)
from the finished tree — including the three the plan did **not** claim to have re-verified — and the
step-5 intermediate was rebuilt and gated. Results in §Pass-0 disposition audit and §Verified sound.

---

## Pass-0 disposition audit

The plan's dispositions table (plan:25-32) claims all six findings applied. Audited one at a time,
by breaking the finished tree:

| Pass-0 finding | Claim | Audit |
|---|---|---|
| **BLOCKER 1** — asserted phrase spans a line break; plan ends 360/1 | rewrapped, suite green | **Genuine.** The replacement at plan:758-761 puts `does not satisfy this phase's contract` contiguously on plan:761. Executed literally the suite is 367/0. Reverting only `prompts/worker-brief.md` fails exactly one test (step 9's). Provenance sentence is now scoped (plan:9-21) and every claim in it that I checked holds. |
| **MAJOR 1** — step 4's red is a `tsc` error; both guards inert | option 1: old step 4 deleted, cases folded into step 1, §On the two guards added | **Genuine.** `adoptableArtifacts` takes `string \| null` from step 1 (plan:226-228), so no widening step exists and no step has an unrunnable red. §On the two guards (plan:60-68) states plainly that the guards are not independently observable and that removing them yields no red. I confirmed that independently. Honest disclosure, correct call. |
| **MAJOR 2** — spec row T7 unmapped; the `actorIdle` cost gate unpinned | now step 6, "verified to bite" | **Genuine.** Deleting `if (!actorIdle) return base` from the finished tree: **366 pass / 1 fail**, the single failure being `the adoption scan does not run while the worker is still working`. Exactly the property spec:487 buys. (But see MINOR 1 — the plan points at the wrong test.) |
| **MINOR 1** — spec rows T2 and T4 unmapped | both in step 6; T2 uses `utimesSync` | **Genuine.** T2 is plan:509-526 with two explicit `utimesSync` calls; T4 is plan:541-551. Both pass at the step-6 intermediate and at the end. |
| **MINOR 2** — `loggedAmbiguous` is a module singleton; comment miscites `alreadyProbed` | `TaskDeps.ambiguityLog?` injectable; comment corrected | **Half genuine.** The injection is real and does what pass 0 asked: step 8's test passes its own Set (plan:621, 627-629) and is independent of module load order. The *comment* correction is still wrong — see MINOR 2 below. |
| **MINOR 3** — git fixtures leak repos and worktrees | helper owns a registry; `afterEach(cleanupFixtures)` in both files | **Genuine.** `created`/`tempDir`/`cleanupFixtures` at plan:81-92, 124-127; `afterEach(cleanupFixtures)` at plan:156 and plan:408. Every fixture entry point registers (`repoWithWorktree` registers both temp trees via `tempDir`; step 1's two bare-directory tests use `tempDir` too). |

So: one displaced pointer and one still-inaccurate comment, against four clean fixes and a
correctly-scoped provenance claim. Nothing here is cosmetic.

The new findings below are not pass-0 leftovers. The MAJOR is a spec row **neither** pass caught.

---

## MAJOR 1 — spec row T8 has no step, and the `claimed` set is provably unpinned: neutering it leaves the suite at 367/0 while disabling adoption in `spec` and `plan` entirely

**Claim.** Plan:467-470 builds the exclusion set inside `gatherSignals`:

    467         const claimed = new Set(
    468           [task.artifacts.research, task.artifacts.spec, task.artifacts.plan]
    469             .filter((path): path is string => path !== null),
    470         )

and step 3 (plan:296-321) is titled "paths already spoken for are never re-adopted".

**Problem.** Step 3 tests the *filter* — `adoptableArtifacts(worktree, claimed)` with a hand-built
Set (plan:304). Nothing tests the *construction*. Spec:488 is the row that exists for exactly this:

    spec:488   | T8 | `spec` phase, research note already recorded in `artifacts.research`
                    | Research note not re-adopted; the spec is |

No step implements it. `grep -n "spec-review" plan` and a read of every appended test confirms the
only `spec`-phase test in the plan is step 7's, whose expectation is that **nothing** is adopted.
There is no test anywhere in which adoption succeeds in a phase other than `research`.

This is not a spare test. Spec:311-313 states the reason:

> the *raw* `git diff` list is never empty in `spec` or `plan`, because the research note is always
> an added path on the branch

So in `spec` and `plan` the research note is always a candidate, and `claimed` is the only thing
that removes it. An implementer who typo'd the set, built it from `task.artifacts[slot]` alone, or
dropped it in a later refactor would produce two candidates on every `spec` and `plan` entry →
permanently ambiguous → adoption never fires in two of the design's three target phases, plus a
spurious `console.error` per phase entry. The suite would not notice.

**Evidence.** Finished tree, one edit — `claimed` replaced by `new Set<string>()`, nothing else:

    $ bun test
     367 pass
     0 fail
    Ran 367 tests across 33 files.

Zero failures. This is the same shape of hole pass 0's MAJOR 2 found in the `actorIdle` guard, and
the same severity: a spec row with no step, guarding a line nothing else pins.

**Fix.** One test, sharing step 6's fixture. Verified: it passes against the plan's finished tree and
fails against the neutered-`claimed` tree.

```ts
test('in spec, the recorded research note is not re-adopted and the spec is', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/the-research.md', 'research\n')
  commitIn(worktree, 'docs/superpowers/notes/the-spec.md', 'spec\n')

  const artifacts = designArtifacts()
  artifacts.research = 'docs/superpowers/notes/the-research.md'
  const run = mkRun([mkTask({
    phase: 'spec', phase_entered_at: 0, checkout_path: worktree, artifacts,
  })])

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('spec-review')
  expect(run.tasks[0]?.artifacts.spec).toBe('docs/superpowers/notes/the-spec.md')
  expect(run.tasks[0]?.artifacts.research).toBe('docs/superpowers/notes/the-research.md')
})
```

    # against the plan's finished tree
    $ bun test test/tasks.test.ts
     36 pass / 0 fail

    # against the same tree with `claimed` neutered
    $ bun test test/tasks.test.ts
    Expected: "spec-review"
    Received: "spec"
    (fail) in spec, the recorded research note is not re-adopted and the spec is
     35 pass / 1 fail

It belongs in step 6 (it has no red against a correct step 5, like step 6's other three) or as its
own step after 5. Add it to the step-6 bullet list as a fourth "verified to bite" item, and bump
step 6's count to 364 and every later count by one, ending step 10 at **368 pass / 0 fail / 33
files**. Note also that this is the only test in the plan that exercises the `spec` row's adoption
*success* path at all, so it doubles as coverage of `taskRow('spec').artifact` resolving to the
right slot.

---

## MINOR 1 — step 6's bullet list points at the wrong test; "the first test" is its second

**Claim.** Plan:501: "deleting `if (!actorIdle) return base` fails the first test **and only** that
test".

**Problem.** The three bullets at plan:501-504 are ordered `actorIdle`, T2, T4. The three tests in
the code block immediately below are ordered T2 (plan:509), `actorIdle`/T7 (plan:528), T4
(plan:541). So bullet 1 names the second test and bullet 2 names the first. An implementer who
follows plan:501 literally, deletes the guard, and finds `adoption survives pre-existing docs being
touched after the worker commits` still green will conclude the plan's verification claim is false
when it is merely misaddressed — and pass 0's MAJOR 2 is precisely the finding this bullet exists to
answer.

**Evidence.** Finished tree, `if (!actorIdle) return base` deleted from the `research`/`spec`/`plan`
case:

    $ bun test
    (fail) the adoption scan does not run while the worker is still working [74.30ms]
     366 pass
     1 fail

One failure, and it is plan:528, not plan:509.

**Fix.** Either reorder the code block to match the bullets, or reword plan:501 to name the test:
"deleting `if (!actorIdle) return base` fails `the adoption scan does not run while the worker is
still working` and only that test". The second is smaller and survives future reordering.

---

## MINOR 2 — the `defaultAmbiguityLog` comment still misstates its precedent: the key shape does *not* mirror `taskStallKey`

**Claim.** Plan:682-684:

    682   // The KEY SHAPE mirrors stall.ts's taskStallKey (src/supervisor/stall.ts:62-64);
    683   // the ownership does not — `alreadyProbed` is a parameter threaded from main.ts,
    684   // and this is a module default that TaskDeps.ambiguityLog can replace.

**Problem.** Pass 0's MINOR 2 said the citation "is right about the *key shape*" and wrong about
ownership. The plan fixed the ownership half and promoted the key-shape half to a load-bearing
`KEY SHAPE` claim — but the key shape does not match either. `taskStallKey` carries `run_id`; the
plan's key does not:

    src/supervisor/stall.ts:62-64
      export function taskStallKey(run: Run, task: Task): string {
        return `${run.run_id}:${task.task_id}:${task.phase}:${task.phase_entered_at}`
      }

    plan:688
      const key = `${task.task_id}:${task.phase}:${task.phase_entered_at}`

`task_id` is per-run (`t1` in every run), and `defaultAmbiguityLog` is process-wide across all runs
in the supervisor loop, so the key is genuinely weaker than the one it cites. The practical risk is
small — `phase_entered_at` is a `Date.now()` millisecond and would have to collide — but the
comment is the second attempt at this sentence and is still asserting something false about a line a
reader cannot check without opening `stall.ts`.

The **code** is spec-conformant: spec:459-460 specifies `${task_id}:${phase}:${phase_entered_at}`
and makes the same over-broad "mirroring how `sendProbes` keys `alreadyProbed`" claim. So this is a
comment fix, not a behaviour change.

**Fix.** Say what is true and why the difference is deliberate:

```ts
// Process-lifetime by default, so an ambiguous candidate set is reported once
// rather than once per 1s tick for the 45 minutes before the first stall probe.
// Keyed like stall.ts's taskStallKey (src/supervisor/stall.ts:62-64) minus the
// run_id, which task_id does not subsume — two runs can both hold a `t1`, and
// only phase_entered_at separates them. TaskDeps.ambiguityLog replaces this
// default so a test does not inherit another test's keys.
```

If the run_id omission is not deliberate, the alternative is to key on it — but `gatherSignals` does
receive `run`, so that is a one-word change and the honest option if the human would rather have the
stronger key than the comment.

---

## MINOR 3 — step 8's second test sits under **Red** with no red, and is inert three times over

**Claim.** Plan:639-646 appends `adoption is skipped entirely when checkout_path is null` under step
8's **Red.** heading. Plan:649-650 accounts for only one of the two: "the first fails to compile
(`ambiguityLog` is not on `TaskDeps`), and once that is added it fails on `toHaveLength(1)`
receiving `0`."

**Problem.** The second test's red status is never stated, in a plan that is otherwise careful about
this — plan:494 labels step 6 "**These three have no red**" and plan:60-68 devotes a section to
guards that produce no red. And this one produces no red for the same reason those do: with
`checkout_path: null` the case returns `base` through the `checkout === null` guard, through
`adoptableArtifacts`'s own null guard, and through `git -C null` exiting 128 — and because
`mkRun`'s `repo_root` is `/r`, `existsSync(absolute)` is false, so the test also cannot distinguish
its subject from the absence gate.

It also does not buy what spec:486 asks for. **T6** is `checkout_path: null` **with a valid
candidate present** — the point being that the scan does not fall back to the main checkout. This
test has no candidate anywhere, because it has no repo.

**Evidence.** Finished tree with `checkout === null` removed from the `slot === undefined || checkout
=== null` guard at plan:470:

    $ bun test
     367 pass
     0 fail

**Fix.** Move the test into step 8's prose as explicitly red-free, or fold it into §On the two guards
(plan:60-68), which already owns this argument and currently discusses only `deliver.ts`'s two
guards, not `gatherSignals`'s third. If T6's "valid candidate present" is wanted literally, the
construction is `run.repo_root` pointing at a `repoWithWorktree` fixture with a committed stray doc
and `checkout_path: null`; the assertion is that `artifacts.research` is untouched. Worth one line of
prose either way — silence is what makes a reader treat it as a red that does not fire.

---

## Verified sound, and deliberately not raised as findings

So the above is not read as a verdict on the plan, here is what I ran rather than reasoned about.

- **The plan reaches its own gate.** Applied literally end to end: `bun test` → **367 pass / 0 fail
  / 33 files**, `bun run typecheck` → clean. plan:779-780's expectations are exact, and
  `test/helpers/git-worktree.ts` is indeed not matched as a test file (33, not 34).
- **Every per-step arithmetic figure is right.** 28/29/30/32 for `test/deliver.test.ts` at steps 1-4
  (24 pre-existing there), then 360, 363, 364, 366, 367 — each verified by construction, and 360
  verified directly by rebuilding the intermediate.
- **Every step's red bites, and bites exactly once.** Deleting each step's implementation line from
  the finished tree, one at a time:

      step 2  REVIEWS_PREFIX filter   → 366/1, only `excludes review verdicts…`
      step 3  claimed filter          → 366/1, only `excludes paths already recorded…`
      step 4  -c diff.renames=true    → 366/1, only `a moved doc is a rename…`
      step 6  if (!actorIdle)         → 366/1, only `the adoption scan does not run…`
      step 7  if (existsSync(absolute)) → 366/1, only `a present-but-stale canonical artifact…`
      step 8  candidates.length > 1   → 366/1, only `two candidates are ambiguous…`
      step 9  worker-brief paragraph  → 366/1, only `the brief states the path contract…`

  This includes steps 2, 3 and 4, for which plan:16 claims only that their red "follows from the
  same run" rather than having been reproduced individually. It does, and they do.
- **`-z` is load-bearing beyond the non-ASCII case the plan credits it with.** Removing it fails
  **7** tests, not one: the implementation splits on `\0`, so without `-z` the whole listing is one
  blob. The plan calls step 4's non-ASCII test "a regression guard on `-z`" (plan:357-359), which
  undersells it but is not wrong.
- **The step-5 intermediate is green and committable.** Rebuilt exactly (no `existsSync` gate, no
  `ambiguityLog`, no steps 6-9 tests, original brief): `bun test` → **360 pass / 0 fail**,
  `bun run typecheck` clean. The unused `existsSync` import survives because `noUnusedLocals` is
  absent from `tsconfig.json`, as plan:486 says. Steps 6-8 are green at their own points too, since
  removing the step-7 gate from the finished tree breaks only step 7's test — i.e. no pre-existing
  test and none of step 6's three depend on it.
- **Every insertion anchor is unique and byte-exact.** `export function taskSignalsFor(run: Run) {`,
  `async function gatherSignals(`, the `ciDetail` + `}` block, the `case 'research': case 'spec':
  case 'plan':` block (`src/supervisor/tasks.ts:202-211`, byte-identical to the quote at
  plan:438-448 and to spec:222-232), `test/deliver.test.ts:1-4`, `test/tasks.test.ts:1-2` and `:8`,
  and the replaced paragraph in `prompts/worker-brief.md:31-33` — each occurs exactly once and
  matches the plan's quote character for character.
- **The appended `cli-commands.test.ts` test compiles in place.** `dir`, `repoDir`, `ctx`, `newRun`,
  `saveRun`, `cmdTask` and `cmdBrief` are all module-scope (`test/cli-commands.test.ts:1-14`), and
  `notes: ''` is accepted (`src/cli.ts:384` defaults it to `''` anyway).
- **Types, names and signatures stay consistent step to step.** `adoptableArtifacts(string | null,
  Set<string>): Promise<string[]>` is declared once at step 1 and never changes; `slot` is
  `'research' | 'spec' | 'plan' | undefined` (`src/lib/phases.ts:16`) and is narrowed before
  indexing `task.artifacts` (`src/lib/types.ts:63-68`); `candidates[0]` is narrowed by the
  `length === 1` ternary under `noUncheckedIndexedAccess`; `join`, `taskRow` and `Task` are all
  already imported in `src/supervisor/tasks.ts:1,6,10`, so `logAmbiguous`'s signature needs no new
  import. No placeholders, no "then wire it up" step.
- **Every `file:line` I checked resolves.** `src/supervisor/deliver.ts:89,93` (verdicts read, never
  written), `src/lib/predicates.ts:10-20`, `src/lib/machine.ts:94`, `src/lib/phases.ts:97,102-103`,
  `src/lib/gh.ts:30-42` (the comment at plan:200-202 is a near-verbatim lift of gh.ts:30-32, which
  is the right precedent), `src/supervisor/main.ts:176` as the sole `advanceTasks` caller — which is
  what makes `TaskDeps.ambiguityLog` optional rather than a `t2`-file edit — `src/lib/render.ts:9`
  (the plan says `9-15`; the function is `8-14`, a one-line slip not worth a finding, and the
  no-normalisation claim it supports is correct), `src/supervisor/stall.ts:62-64` (see MINOR 2),
  `test/tasks.test.ts:254-263` and `:265-274`, `test/cli-commands.test.ts:159-176`.
- **The declared deviation from spec §C1 is still correct.** `adoptableArtifacts(): Promise<string[]>`
  in place of `adoptableArtifact(): Promise<string | null>`, declared up front at plan:51-58, with
  `isSettled` still called on the single survivor only (spec:341-343).
- **File-set discipline holds.** `src/supervisor/deliver.ts`, `src/supervisor/tasks.ts` and
  `prompts/worker-brief.md` are all in `t1.files` (spec:9-10); nothing touches `src/cli.ts`,
  `src/lib/worker-prompt.ts`, `src/lib/types.ts`, `src/lib/phases.ts`, `src/lib/machine.ts` or any
  of `t2`'s four files, and plan:807-816 says so explicitly.
- **Spec rows T1, T2, T3, T4, T5, T7, T9, T10, T11, T12, T13 all map to a step** and all pass. T5
  ("only a verdict added → no adoption") is bought by step 2's stronger unit test rather than by name
  — the exclusion itself is pinned, which entails the row. T6 is covered only nominally (MINOR 3).
  T8 is not covered at all (MAJOR 1). T9's "adoption never consulted" is guaranteed structurally by
  the early `return` in the `isFresh` branch rather than by an assertion, and
  `test/tasks.test.ts:254-263` guards the outcome; I do not think a spy is worth buying here.
- **One undeclared minor deviation, noted rather than ranked.** Spec:499 says to *extend* the
  existing `cmdBrief` test at `test/cli-commands.test.ts:304-319`; step 9 appends a separate test
  instead. Functionally equivalent and arguably cleaner, but plan:51 announces "**One** deviation
  from the spec, stated up front" and this is a second one.

MAJOR 1 is one verified test plus a count bump; the three MINORs are comment and prose edits. None
of them touches a decision the spec settled, changes scope, or needs a human call, and the plan
reaches its own gate as written — which is the thing pass 0 blocked on.

VERDICT: CLEAR
