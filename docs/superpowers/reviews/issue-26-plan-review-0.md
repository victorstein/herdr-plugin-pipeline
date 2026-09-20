# Adversarial review — issue #26 implementation plan, pass 0

Reviewed `docs/superpowers/plans/2026-09-19-issue-26-plan.md` against
`docs/superpowers/specs/2026-09-19-issue-26-design.md`, the four spec reviews (in particular the
CLEAR `issue-26-spec-review-1.md`), `.claude/agents/plugin-dev.md`, and the tree at `492c450`.
Baseline re-measured here rather than taken from the plan:

    $ bun test          → 503 pass, 0 fail, 1265 expect() calls, 34 files, 8.85s
    $ bun run typecheck → tsc --noEmit, exit 0

Both match the plan's stated baseline (`plan:14`).

## What I checked and could not break

- **The code is executable.** I lifted steps 1–3's `src/lib/verdict-path.ts` verbatim into a scratch
  file, pointed it at a copy of `src/lib/types.ts` carrying step 2's `verdict_seq` fields, and ran
  `tsc` with this repo's flags (`strict`, **`noUncheckedIndexedAccess`**, `bundler` resolution):
  exit 0. The structural `VerdictRecord` genuinely accepts both records —
  `Partial<Record<TaskPhase, number>>` is a mapped type, so it gets an implicit index signature and is
  assignable to `Record<string, number | undefined>`; had `verdict_seq` been declared on an interface
  of its own this would not have compiled. `record.artifacts.verdicts[k]` is `string | undefined`
  under `noUncheckedIndexedAccess` and the `?? null` absorbs it.
- **Every quoted "replace X with Y" applies at HEAD.** `deliver.ts:90-95` is exactly the six lines the
  plan deletes (docblock + four comment lines + `const REVIEWS_DIR`), `:97-115` is exactly
  `artifactPathFor` + `absoluteArtifactPath`, `:180` is the `REVIEWS_DIR` prefix filter that keeps
  compiling off the new import, `:247`/`:248` are the `pluginRoot`/`verdictPath` lines step 6 inserts
  between, `tasks.ts:7` already imports `taskRow`, `deliver.ts:5` already imports `runRow`,
  `cli.ts:13` is the `./lib/phases` import, `cli.ts:323`/`:357`/`:369`/`:373` are the four cmdRewind
  anchors, `machine.ts:5` is `HasPasses`, and `prompts/escalate.md:17` is byte-for-byte
  `which resets the pass count for that phase.`
- **The fixtures have the right shape.** Step 1's `mkTask` covers every required field of the current
  `Task` (`types.ts:60-97`) and omits only the optional `stall`. `newRun`'s input bag
  (`ledger.ts:13-19`) matches. `test/cli-commands.test.ts` really does export `repoDir` (`:15`, `:22`),
  `runWithTasks` (`:49`) and an `mkTask` defaulting `issue: 1` (`:38`), and `Run`/`Task`/`mkdirSync`/
  `writeFileSync`/`join`/`saveRun`/`listRuns` are all already imported there (`:1-12`).
- **Each red test is red, and for the stated reason.** Step 2's import of a non-existent export fails
  the module load; step 3's `reserveVerdict` likewise; step 4's second new test fails because today's
  `artifactPathFor` honours any recorded key (`deliver.ts:102`, `:106`); step 5's and step 6's first
  assertions fail on `verdict_seq === undefined`; step 7's first test fails on both the `result.text`
  and the `artifactPathFor` assertions. I traced each probe by hand — the exhaustion test's 64 seeded
  values really do fill candidates `-0` … `-63` from `seq = 0`, and the fallback records the floor.
- **No existing test acquires a reservation side effect that breaks it.** `promptForTaskPhase` has
  exactly one production caller (`tasks.ts:175`), guarded by `if (task.phase === cameFrom) continue`
  at `:173`, so one transition is one reservation. `test/tasks.test.ts:301-312` reads
  `absoluteArtifactPath` *before* the render, but `checkout_path` is `/r/.worktrees/feat-x`, which does
  not exist, so the probe takes ordinal 0 and the pre-read and post-reserve paths agree — it stays
  green by the same coincidence the CLEAR review identified. `test/tasks.test.ts:375-390` now
  transitions `spec → spec-review` and reserves, but asserts only on `artifacts.spec`/`.research`.
  `grep -rn "verdicts" test/` turns up no assertion that a reservation could move. `test/tick.test.ts`
  never reaches `advanceTasks`. `stall.ts:203` reads through `absoluteArtifactPath` and never reserves.
- **`promptForRunPhase`'s second caller stays unreachable, so no key is burned twice.**
  `main.ts:184` captures `runPhaseBefore` *after* `evaluateRun` mutated `run.phase` at `:182`, so
  `:215`'s comparison is always true and `:217` never fires — including on the `branch-review →
  branch-review` self-loop, where `before` and `after` are the same phase anyway.
- **The declared deviation holds.** I enumerated every row in `src/lib/phases.ts`. The task rows with
  no `artifact` and `signal !== 'verdict'` are `queued`, `blocked-on-files`, `implement`, `ci`,
  `merge`, `close`, `teardown`, `blocked-on-decision`, `escalated`, `failed`, `orphaned`,
  `blocked-on-failure`, `done`; the run rows are `intake`, `dispatch`, `execute`, `escalated`, `done`.
  All three reservation sites (steps 5, 6, 7) guard on `signal === 'verdict'`, so `verdict_seq[phase]`
  can never be non-zero for any of them, `verdictFor` always returns `null`, and the `??` fallback
  yields exactly spec C3's "today's derivation". Omitting the early return is behaviour-preserving.
  (One caveat is unstated — see MINOR 4.)
- **`prompts/escalate.md` can absorb step 8's text.** `{{phase}}` is in the var bag at both render
  sites (`tasks.ts:88-93`, `deliver.ts:261-265`), so `render()` will not throw at `render.ts:11`, and
  `test/prompts.test.ts` asserts nothing about that file's body (`:10-14`, `:118-126`). Step 6's
  `dispatch` claim also checks out: `prompts/dispatch.md`'s only tokens are `{{hpipe}}`,
  `{{repo_root}}` and `{{run_id}}`, and `renderPrompt` injects `hpipe` at `render.ts:46`.
- **Nothing an earlier review killed is reintroduced.** The read side is one dictionary lookup
  (`plan:184-188`); there is no `recordedVerdict`, no "highest recorded", no map scan when
  `verdict_seq` is absent — A1's explicit trap. `reserveVerdict` takes `(run, task, phase)` and derives
  prefix and base internally, which is spec-review-1 MINOR 1's fix, and step 4's `??` branches call
  `verdictFilename(verdictPrefix(...))` rather than spelling a filename inline, which is the other
  half of it. Step 4 rewrites `test/deliver.test.ts:156-161` instead of claiming it stays green, which
  is spec-review-1 MAJOR 1.

Eight findings, none of them a BLOCKER.

---

## MAJOR 1 — the spec's entire live-verification runbook maps to no step, on a change the surface guide says must have one

**Claim.** `plan:718-797` is titled "Step 9 — verify, then open the PR" and enumerates the whole
verification: `bun test`, `bun run typecheck`, `git diff --stat main...HEAD -- src/ prompts/ test/`,
push, PR. The PR body's Verification section (`plan:783-788`) lists exactly two lines, both gates.

**Problem.** The spec devotes a section to live verification (`spec:504-521`), opens it with *"required
by `.claude/agents/plugin-dev.md` because this changes delivery"*, and lists five numbered checks — of
which the review that cleared the spec promoted step 3 to *"the primary check"* and demoted the
fully-automatic case to step 1 (`spec:393`, `issue-26-spec-review-1.md` MAJOR 2's fix 2). The plan
contains the words "live", "herdr session" and "smoke" **zero times**:

    $ grep -in "live verif\|herdr session\|smoke\|integration" docs/superpowers/plans/2026-09-19-issue-26-plan.md
    (no output)

An implementer executing this plan literally runs two gates and opens a PR. The five checks — and
specifically check 4 (*"answer a decision raised at `spec-review` and confirm `verdict_seq` does not
move"*, which the spec calls *"pass-1 BLOCKER 1, the thing the ruling exists to prevent"*) — are never
performed and never recorded anywhere a reviewer or the merger would see them.

**Evidence.** `.claude/agents/plugin-dev.md`, "Where the behaviour is actually proven":

    If your change touches startup, gating, delivery or pane I/O, say in your plan how it would be
    verified against a real herdr session, and treat a difference between the runbook and what you
    observe as a finding rather than a test to make pass.

This change edits `promptForTaskPhase` and `promptForRunPhase`, the two prompt-render sites, and
`{{verdict_path}}` is what an agent is told to write — that is delivery. The guide names the *plan* as
the place this is said. The repo's own per-project memory records the cost: *"unit tests with fakes
missed two live-only startup/gating Criticals"*. The spec anticipated the objection that the runbook
cannot be executed pre-merge (*"The installed plugin is pinned to a GitHub commit … so this is not
live until the release lands. After it does:"*, `spec:505-507`) — which is a reason to schedule it,
not to drop it.

**Concrete fix.** Add a step 10 ("after the release lands") that copies `spec:508-521` verbatim as a
checklist, states the `.claude/agents/plugin-dev.md` rule that a divergence is a finding rather than a
test to make pass, and adds a line to the PR body's Verification section saying the runbook is
outstanding and why (`herdr plugin list` is pinned). If the runbook is meant to live in
`test/integration/smoke.md` — the guide calls that file *"a hand-run live runbook the unit suite cannot
replace"* — say so and add `test/integration/smoke.md` to step 9's expected-file list, which currently
forbids it (see MINOR 3).

---

## MAJOR 2 — step 7 ships the run-level `cmdRewind` reservation with no test at all

**Claim.** `plan:667-673`, step 7 item 5:

    5. At the end of the `else` branch, after its `run.history.push({...'manual rewind'})` line:

    ```ts
        if (runRow(run.phase).signal === 'verdict') {
          reserved = reserveVerdict(run, null, run.phase)
        }
    ```

**Problem.** Step 7's two tests (`plan:609-637`) both pass `taskId: 't1'` and therefore both exercise
the `isTask` branch at `src/cli.ts:323-357`. Nothing in the plan ever calls `cmdRewind` with
`taskId: null`. Item 5 is new production code in the `else` branch, added with no red test, no green
assertion, and no coverage of any kind — which breaks the plan's own opening rule (`plan:9-10`,
*"Every step is one TDD cycle — write the test, run it and watch it fail"*).

This is not a hypothetical branch. `run.phase = 'branch-review'` is the only run-level verdict row
(`phases.ts:64-66`), the run-level `escalated` row hands the human
`{{hpipe}} rewind {{run_id}} {{phase}}` with `{{phase}}` = `run.escalated_from`
(`deliver.ts:261-265`, `machine.ts` run-side twin of `:92`), and spec C3's site table lists the
`cmdRewind` guard as *"both, per branch"* (`spec:234`). It is also the branch where the base is
`run.repo_root` rather than a worktree, so a probe that resolved the wrong base would go unnoticed.

**Evidence.** `plan:609` and `plan:627` — both tests:

    const run = runWithTasks([{ task_id: 't1', phase: 'spec-review', checkout_path: repoDir }])
    …
    await cmdRewind(ctx(), { runId: run.run_id, phase: 'spec-review', taskId: 't1' })

`runWithTasks` (`test/cli-commands.test.ts:49-53`) builds a run at `repoRoot: '/r'`, so even the run
record in these fixtures never reaches item 5.

**Concrete fix.** Add a third test to step 7, written before item 5 and watched to fail:

```ts
test('a rewind onto branch-review reserves against the repo root under the run id', async () => {
  const occupant = 'docs/superpowers/reviews/'  // + `${run.run_id}-branch-review-0.md`
  const run = runWithTasks([])
  run.repo_root = repoDir
  run.phase = 'done'
  mkdirSync(join(repoDir, 'docs', 'superpowers', 'reviews'), { recursive: true })
  writeFileSync(join(repoDir, occupant + `${run.run_id}-branch-review-0.md`), 'VERDICT: CLEAR\n')
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'branch-review', taskId: null })
  expect(result.text).toContain(`${run.run_id}-branch-review-1.md`)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id) as Run
  expect(artifactPathFor(saved, null)).toBe(`${occupant}${run.run_id}-branch-review-1.md`)
})
```

The occupant-on-disk seed is what makes it fail for the right reason rather than incidentally.

---

## MAJOR 3 — nothing in the plan pins C1's load-bearing "`verdict_seq` never regresses" against the one function that clears counters

**Claim.** The spec's `src/cli.ts` test list (`spec:493-495`) names four things, one of which is
*"leaves `verdict_seq` untouched by the counter reset"*. Step 7's second test (`plan:627-637`) is the
only place `verdict_seq` is asserted after a rewind:

    const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
    expect(saved?.tasks[0]?.verdict_seq).toBeUndefined()

**Problem.** That fixture starts with `verdict_seq` absent, so the assertion is satisfied by
*two different* implementations: one that does not reserve on a producer row (the intended meaning),
and one that reserves nowhere but *clears* `verdict_seq` alongside `task.passes = {}`. The test cannot
tell them apart. No test anywhere in the plan starts from a non-zero `verdict_seq` and runs
`cmdRewind` — step 7's first test goes from absent to 1, step 3's tests never touch `cmdRewind`, and
steps 5/6 never touch it either.

C1 is the whole design: *"**Never regresses**, because nothing decrements or clears it — including
`cmdRewind`, which clears `passes` and leaves `verdict_seq` alone"* (`spec:154-155`). The property is
true at HEAD only because `src/cli.ts:353` and `:360` happen to say `passes` and not `verdict_seq`.
A future editor tidying "clear the counters on a rewind" into one line would regress the key, re-issue
a spent key, and reintroduce issue #26 exactly — with a fully green suite.

**Evidence.** `src/cli.ts:352-356` and `:359-362` are the only lines a regression would touch:

    352:    task.phase = input.phase as TaskPhase
    353:    task.passes = {}
    …
    359:    run.phase = input.phase as RunPhase
    360:    run.passes = {}

and `test/cli-commands.test.ts:228-239` (*"rewind clears the whole counter map rather than spending a
pass"*) is the test that would be edited alongside such a change — it asserts `passes` toEqual `{}`
and says nothing about `verdict_seq`.

**Concrete fix.** Add to step 7 a test that seeds the counter and asserts survival, e.g.

```ts
test('a rewind clears the pass counters and leaves verdict_seq alone', async () => {
  const run = runWithTasks([{
    task_id: 't1', phase: 'escalated', checkout_path: repoDir,
    passes: { 'spec-review': 2 }, verdict_seq: { 'spec-review': 2 },
    artifacts: { research: null, spec: null, plan: null,
      verdicts: { 'spec-review-0': 'a.md', 'spec-review-1': 'b.md' } },
  }])
  await saveRun(dir, run)
  await cmdRewind(ctx(), { runId: run.run_id, phase: 'spec', taskId: 't1' })

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.passes).toEqual({})
  expect(saved?.tasks[0]?.verdict_seq).toEqual({ 'spec-review': 2 })
})
```

`spec` is an artifact row so nothing reserves, which isolates the one property being pinned. It is red
against a hypothetical `verdict_seq = {}` and green against the plan's code, which is the right shape
for a regression guard even though it is green on first run.

---

## MINOR 1 — step 3's import instructions, applied literally, break the build

`plan:201-209` says *"Extend the `node:fs`/`node:path` imports and add `reserveVerdict` and
`tempDir`"*, then shows a block headed `// add to the existing imports at the top of the file`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupFixtures, tempDir } from './helpers/git-worktree'
```

Three problems. There are no `node:fs`/`node:path` imports to *extend* — step 1 created the file
without them (`plan:33-37`). The third line is a *replacement* for step 1's
`import { cleanupFixtures } from './helpers/git-worktree'`, but the header says "add", and adding it
yields a duplicate `cleanupFixtures` binding, which is a `SyntaxError` at module load, not a useful
red. And `reserveVerdict` is named only in the prose — the block does not show the amended
`../src/lib/verdict-path` import line, so the one import the step actually needs is the one the
implementer has to infer. Fix: show the file's full amended import block, as steps 1 and 4 do.

## MINOR 2 — the plan disagrees with itself about which step first uses `reserveVerdict`

`plan:426-428`: *"(`reserveVerdict` is unused until step 7; add it now so the import is touched once.
If `bun run typecheck` objects to the unused name, add it in step 7 instead …)"*. `plan:589-590`:
*"`runRow` is already imported at `src/supervisor/deliver.ts:5`, and `reserveVerdict` came in at step
4."* Step 6, not step 7, is the first consumer — it is the step that inserts
`reserveVerdict(run, null, run.phase)` into `promptForRunPhase` (`plan:586`). The escape hatch is also
unnecessary: `tsconfig.json` sets `strict` and `noUncheckedIndexedAccess` and no `noUnusedLocals`, so
the unused import is fine, exactly as the plan predicts. Fix: change "step 7" to "step 6" in both
sentences of `plan:426-428`.

## MINOR 3 — C5 corrects one of two copies of the same false sentence, and step 9 forbids fixing the other

Step 8 replaces `prompts/escalate.md:17` because it says rewind *"resets the pass count for that
phase"* while `src/cli.ts:353` clears the whole map. `test/integration/smoke.md:547` says the same
thing about the same command:

    | A phase burned through `MAX_PASSES` (2) and escalated | … then `hpipe rewind <run_id> <phase>
    [--task <id>]`, which resets that phase's pass count. |

and neither `:544` nor `:547-548` mentions the new reserved-path line `cmdRewind` will now print. The
spec's C5 names only two corrections and its non-goals (`spec:132-136`) do not claim `smoke.md`, so
this is a gap rather than a violation — but `plan:733-738` lists the expected diff and ends
**"Nothing else."**, which actively instructs an implementer who notices it to revert the fix. Fix:
either add `test/integration/smoke.md` to step 8 and to step 9's expected list, or say in step 9 that
it is deliberately deferred.

## MINOR 4 — the deviation is sound, but its stated reason is not the whole reason

`plan:17-22` justifies omitting spec C3's `signal !== 'verdict'` early return with *"`verdictFor`
returns `null` for any row nothing has reserved for, so the `??` fallback already produces exactly
that derivation"*. That half is right and I verified it row by row. But spec C3's "today's derivation"
for a non-verdict row is `task.artifacts.verdicts[key] ?? join(...)` (`deliver.ts:101-103`), and the
plan's fallback is `verdictFilename(...)` with **no map lookup at all** — so for a non-verdict row
carrying a recorded key, today's code returns the recorded value and the plan's returns the derived
one. *"Behaviour is identical"* is true only given A1's premise that no record on disk has such an
entry (`spec:343-345`: the only writes are the `{}` initialisers at `src/cli.ts:229` and
`src/lib/ledger.ts:35`). This is precisely the class of unexamined "identical" claim the spec warns
about at `:481-486`. Fix: add the second clause and cite A1 — one sentence, no code change.

## MINOR 5 — step 8 declines a test the repo already has a pattern for

`plan:694-697`: *"No test: `test/prompts.test.ts` pins the declared prompt set (`:12`) and
`stall-escalate.md`'s variables (`:118-122`), and asserts nothing about this file's body."* That is
accurate — I confirmed it — but the conclusion does not follow, because `test/prompts.test.ts` is
itself the file that establishes how to pin a corrected prompt sentence, twice, and both times for
exactly this class of correction:

    test/prompts.test.ts:124   expect(text).not.toContain('review passes')
    test/prompts.test.ts:125   expect(text).not.toContain('{{pass}}')
    test/prompts.test.ts:134   expect(text).not.toContain('appeared at')

Step 8 is the one step in a nine-step plan that opens with *"Every step is one TDD cycle"* and has no
test. Fix: a two-line red test in `test/prompts.test.ts` —
`expect(text).not.toContain('resets the pass count')` plus
`expect(text).toContain('clears every pass counter')` against `prompts/escalate.md` — which is red
before the edit and green after, and which stops the corrected sentence drifting back.

---

None of the three MAJORs reverses a decision, changes scope, or needs a judgment the implementer
cannot make: MAJOR 1 is a step 10 copied out of the spec, MAJOR 2 is one test written before code that
is already specified, MAJOR 3 is one test added. The plan's central mechanics — the module, the key,
the probe, the three guarded sites, the edit anchors, the red-test sequencing and the intermediate
commit points — are correct, and I could not construct a sequence in which an implementer following it
literally produces something the spec did not ask for.

VERDICT: CLEAR
