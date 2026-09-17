# Adversarial review — implementation plan for issue #15 (the stall ladder)

Plan: `docs/superpowers/plans/2026-09-17-issue-15-plan.md`
Spec: `docs/superpowers/specs/2026-09-17-issue-15-design.md` (CLEAR)

Baseline re-verified in this worktree before reviewing: `bun test` → **351 pass / 0 fail**;
`bun run typecheck` → silent, exit 0. `git status --porcelain` empty at start and at finish.
`tsconfig.json:13` has `"include": ["src", "test"]`, so **test files are typechecked** — a type error
in a test fails the step's own `bun run typecheck` gate.

Findings were checked by executing the plan's own logic (`stallStateFor`, `bumpStall`,
`candidateFor`, `taskStallCandidates` transcribed verbatim from plan lines 164-181, 233-252,
644-736) against the real `src/lib/phases.ts` and `src/lib/ledger.ts`, and by running the plan's
`ladderFor` snippet through this repo's own `tsc`.

---

## BLOCKER 1 — the plan's flagship P4 regression test fails against the plan's own implementation, and so do eight others

**Claim.** Step 9 asserts (plan:637) `bun test test/stall.test.ts` → fails, then after the
implementation → passes, and (plan:748) `bun test && bun run typecheck` is green.

**Problem.** Nine tests in `test/stall.test.ts` — three of them written by the plan itself, six of
them pre-existing and never mentioned by step 9 — produce **zero candidates** and fail. The cause is
the fresh-state anchor. `stallStateFor` (plan:177) returns
`last_probe_at: Math.max(record.phase_entered_at, run.phase_entered_at)`, and every one of these
tests builds its run with `runAt('execute', NOW)` (or the `runWithTasks` helper at
`test/stall.test.ts:89-93`, which does the same), so the anchor collapses onto `NOW` however old the
task is. `now - last_probe_at` is then `0`, the due check at plan:689 rejects it, and no candidate is
produced.

This is not a cosmetic test bug. The one test it kills hardest is
`'an aged record gets ONE probe, not one per tick — the P4 regression'` (plan:533-552) — the test the
spec calls *"the pass-1 blocker, expressed as the test that would have caught it"* (spec:587-591) and
the entire reason Ruling 2 exists. Written as given, it goes red before the implementation and
**stays red after it**. An implementer following the plan literally hits an unexplained red and the
two obvious "fixes" are both wrong: delete the regression test, or drop the `Math.max` and anchor on
`record.phase_entered_at` alone — which silently re-opens **P4** at the run level and is exactly what
the spec forbids (spec:231-236).

**Evidence.** Transcribing plan:164-181, 233-252 and 644-736 verbatim and running them against the
real `runRow`/`taskRow`/`newRun`:

```
STEP9-T1  'an aged record gets ONE probe…'   (plan:533)  probes = 0        plan expects 1
STEP9-T8  'the escalation gate is the row…'  (plan:624)  candidates = 0    plan expects actorPaneId 'w7:p1'
STEP10-TA 'an accepted probe bumps and…'     (plan:777)  candidates = 0    plan expects probes 1
```

and, for the pre-existing tests step 9 leaves in place after "Replace `new Set()` with `3`
throughout" (plan:526-531):

```
test/stall.test.ts:98   'a task sitting in implement past the threshold…'     len=0  expects 1
test/stall.test.ts:103  'a task that re-entered implement with an open PR…'   len=0  expects 1
test/stall.test.ts:128  'a task stranded in blocked-on-files…'                len=0  expects 1
test/stall.test.ts:135  'a task waiting in blocked-on-decision…'              pane=undefined expects 'w1:p1'
test/stall.test.ts:141  'a worker-owned artifact row…'                        pane=undefined expects 'w7:p1'
test/stall.test.ts:147  'a worker row with no pane falls back…'               pane=undefined expects 'w1:p1'
```

(`test/stall.test.ts:110`, the inside-the-threshold test, still passes — it is the only one whose
expectation is `0`.)

The tests that *do* pass are the ones that write an explicit `task.stall` literal carrying
`run_at: NOW` (plan:569-570, 582, 798, 811, 823) or that call `bumpStall` first (plan:557), because
both stamp `run_at` to match `runAt('execute', NOW)`. That is why the defect is invisible on a
skim — the plan's own passing tests hide it.

**Concrete fix.** Age the run wherever the test means "this record has been quiet for a while", and
leave alone the tests whose `stall` literals already pin `run_at: NOW`:

- plan:536 — `const run = runAt('execute', NOW)` → `const run = runAt('execute', NOW - 780 * 60_000)`
  (the 780-minute incident the comment at plan:534-535 describes belongs to the run as well as the task).
- plan:625 (the **A7** test) and plan:778 (the step-10 probe/persist test) —
  `runAt('execute', NOW)` → `runAt('execute', LONG_AGO)`.
- Add to step 9's test-migration instruction: change the helper at `test/stall.test.ts:89-93` from
  `runAt('execute', NOW)` to `runAt('execute', LONG_AGO)`. This is the single edit that repairs all
  six pre-existing tests.
- Leave plan:555, 565, 580, 779(B), 809, 821 as `runAt('execute', NOW)` — their `stall` literals
  stamp `run_at: NOW` deliberately, and ageing those runs would break them instead.

Re-running the same transcription with these three changes applied:

```
:98 len=1   :103 len=1   :110 len=0   :128 len=1   :135 pane=w1:p1   :141 pane=w7:p1   :147 pane=w1:p1
STEP9-T1 probes = 1      STEP9-T8 actorPaneId = w7:p1      STEP10-TA candidates = 1
```

---

## BLOCKER 2 — step 9's test migration misses the two `sendProbes` tests; step 10 then breaks the whole file

**Claim.** Step 9 (plan:521-531) enumerates the full migration of `test/stall.test.ts`: change the
fourth argument to `probeMax`, replace `new Set()` with `3`, and delete exactly three named tests.
Step 10 (plan:836) then deletes `sendProbes` entirely.

**Problem.** Two surviving tests are never accounted for, and one of them asserts precisely the
behaviour **A16** removes:

1. `test/stall.test.ts:153-163` `'a probe that could not be sent stays eligible on the next tick'`.
   Its closing assertion is `expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(0)` after a
   successful send. The new `stallCandidates` (plan:705-717) never consults an `alreadyProbed` set —
   `sendProbes` writes only to its own `Set`, never to `run.stall` — so the run is still due and the
   call returns **1**. Red at step 9, and unfixable without deleting or rewriting the test: it is a
   dedupe test for a dedupe the spec deletes (spec A16, spec:160).
2. `test/stall.test.ts:165-175` `'a run with no orchestrator pane is left pending, not marked probed'`.
   Behaviourally it still passes, but both tests pass `probed` — a `Set<string>` declared at
   `:155`/`:168` as `new Set<string>()`, which the instruction "replace `new Set()` with `3`" does not
   match — into the fourth parameter, now `probeMax: number`. That is a `TS2345` at `:157`, `:159`,
   `:161`, `:162`, `:170`, `:174`, so `bun run typecheck` is red at step 9 as well.

Then step 10 deletes `sendProbes`, while `test/stall.test.ts:2` still reads
`import { sendProbes, stallCandidates, taskStallCandidates } from '../src/supervisor/stall'`. That is
a `TS2305` and, at runtime, a module-resolution failure that takes **every** test in the file down,
not just those two. Step 10's instructions (plan:831-833) mention only *adding* `applyStalls` and
`type StallDeps` to that import.

**Evidence.** `src/supervisor/stall.ts:97-103` is the only definition of `sendProbes`;
`grep -rn "sendProbes" src test` returns `src/supervisor/main.ts:17,238,254` and
`test/stall.test.ts:2,157,161,170`. `src/supervisor/stall.ts:44-45` and `:82-83` are the
`alreadyProbed` lookups the new `stallCandidates`/`taskStallCandidates` drop.

**Concrete fix.** Extend step 9's deletion list from three tests to **five**, adding
`'a probe that could not be sent stays eligible on the next tick'` (`:153-163`) and
`'a run with no orchestrator pane is left pending, not marked probed'` (`:165-175`), and remove
`sendProbes` from the import at `:2` in the same step. Replace the coverage they carried, which the
spec still requires (spec:569 pins the null-pane case via `test/stall.test.ts:165-175`), with two
candidate-level tests that need no `sendProbes`:

```ts
test('a run with no orchestrator pane produces no candidate at all', () => {
  const run = runAt('branch-review', LONG_AGO)
  run.orchestrator_pane = null
  expect(stallCandidates([run], NOW, 15, 3)).toHaveLength(0)
  run.orchestrator_pane = ORCHESTRATOR_PANE
  expect(stallCandidates([run], NOW, 15, 3)).toHaveLength(1)
})
```

The "a failed send stays eligible" property is now step 10's job and is already covered by
`'an accepted probe bumps and persists; a rejected one does neither'` (plan:777) — say so in step 9
so the deletion reads as a move, not a loss.

---

## MAJOR 1 — step 7's `as StallCandidate` cast does not compile against the step-7 `StallCandidate`

**Claim.** Plan:439-440: *"`StallCandidate` already exists (the run-level shape); step 9 replaces it
and these tests keep passing."*

**Problem.** At step 7 the exported `StallCandidate` is still
`{ run; key; minutes; paneId; taskId }` (`src/supervisor/stall.ts:4-10`). Neither
`{ probes: number; escalatable: boolean }` nor that interface is assignable to the other, so
`{ probes: 1, escalatable: true } as StallCandidate` (plan:426, 433) is `TS2352`, and passing the
result to `ladderFor(c: { probes: number; escalatable: boolean }, …)` is a second error, `TS2345`.
Step 7's gate is `bun test test/stall.test.ts → passes. bun test && bun run typecheck` (plan:462) —
so step 7 is **not green and not committable**, which contradicts plan:21.

**Evidence.** Running this repo's own `./node_modules/.bin/tsc` with `strict` and
`noUncheckedIndexedAccess` over the two shapes:

```
error TS2352: Conversion of type '{ probes: number; escalatable: boolean; }' to type
  'OldStallCandidate' may be a mistake because neither type sufficiently overlaps with the other.
error TS2345: Argument of type 'OldStallCandidate' is not assignable to parameter of type
  '{ probes: number; escalatable: boolean; }'.
```

The same check against the step-9 `StallCandidate` (plan:652-667) produces **no** error, because that
shape *is* assignable to `{ probes; escalatable }` — so the plan's claim is true of step 9 and false
of step 7, which is where the code is written.

**Concrete fix.** `ladderFor`'s parameter is already structural (plan:452). Drop the cast and the
import of `type StallCandidate` from step 7 entirely:

```ts
expect(ladderFor({ probes: 1, escalatable: true }, 3)).toBe(…)
expect(ladderFor({ probes: 8, escalatable: false }, 3)).not.toContain('of 3')
```

and delete the sentence at plan:439-440. Nothing in step 7 then depends on the `StallCandidate`
rewrite, and the tests survive step 9 unchanged for the reason the plan wanted.

---

## MAJOR 2 — step 9's `main.ts` instruction is vague, and its "leave the bodies untouched" branch is false

**Claim.** Plan:739-746: update `main.ts` "so it still compiles", change the two threshold arguments,
and *"change `taskRow(candidate.task.phase).signal === 'pr'` to `candidate.task!.phase` where the
compiler now requires it — or leave the bodies untouched if they already typecheck, since step 10
replaces them wholesale."*

**Problem.** The bodies do **not** already typecheck, and the one expression named is one of six.
Step 9 widens the task-level candidate's `task` from `Task` (`src/supervisor/stall.ts:54`) to
`Task | null` (plan:654). The second `sendProbes` callback dereferences `candidate.task` at
`src/supervisor/main.ts:257` (twice), `:260` (three times), `:262` and `:264` — every one becomes
`TS18047: 'candidate.task' is possibly 'null'`. So step 9 ends with typecheck red unless the
implementer improvises seven non-null assertions the plan never lists. This is a step that says what
to do without showing how, in the one place where the plan's own "transitional `key`" shim (plan:31-32)
is supposed to prove the tree stays committable. The shim keeps `sendProbes`'s
`C extends { key: string }` constraint satisfiable — it does **not** keep `main.ts`'s callback bodies
compiling, which is the part that actually matters.

**Evidence.** `src/supervisor/main.ts:254-268` verbatim:

```ts
      await sendProbes(
        taskStallCandidates(runs, Date.now(), config.TASK_STALL_MINUTES, probed), probed,
        async (candidate) => {
          const branch = `${candidate.task.branch} (#${candidate.task.issue})`
          …
            phase: `${candidate.task.phase} (${candidate.task.task_id}, ${candidate.task.branch})`,
            …
            artifact_path: taskRow(candidate.task.phase).signal === 'pr'
```

**Concrete fix.** Replace plan:739-746 with the exact replacement text. Since step 10 discards the
body anyway, the cheapest green form is a single local binding at the top of the callback, which is
also honest about the invariant:

```ts
        async (candidate) => {
          // Transitional: task-level candidates always carry a task; step 10 deletes this callback.
          const task = candidate.task!
          const branch = `${task.branch} (#${task.issue})`
          const text = await renderPrompt(pluginRoot, 'stall-probe', {
            run_id: candidate.run.run_id,
            phase: `${task.phase} (${task.task_id}, ${task.branch})`,
            minutes: String(candidate.minutes),
            artifact_path: taskRow(task.phase).signal === 'pr'
              ? `a PR for ${branch}`
              : `whatever clears ${task.phase} for ${branch}`,
          })
          return herdr.agentPrompt(candidate.paneId, text)
        },
```

and delete the "or leave the bodies untouched if they already typecheck" clause, which is simply
untrue.

---

## MINOR 1 — step 9's replacement span swallows `probePaneFor`, which the same sentence says to keep

Plan:639-642 says to replace *"everything in `src/supervisor/stall.ts` from `export interface
StallCandidate` down to the end of `taskStallCandidates`"*, then parenthetically *"keep
`probePaneFor`"*. `export interface StallCandidate` is `src/supervisor/stall.ts:4`, `taskStallCandidates`
ends at `:90`, and `probePaneFor` lives at `:16-26` — inside the span. An implementer taking the
range literally deletes the function the very next clause tells them to keep, and the new
`candidateFor` (plan:683) then has no `probePaneFor` to call.

**Fix.** State the span as two hunks: *"delete `:4-14` (`StallCandidate`, `stallKey`) and `:28-90`
(`stallCandidates`, `TaskStallCandidate`, `taskStallKey`, `taskStallCandidates`), keeping
`probePaneFor` at `:16-26` and `sendProbes` at `:92-103`; insert the block below in place of `:28-90`."*

---

## MINOR 2 — step 15 creates a duplicate `### 4a` heading, under the wrong parent section

Plan:1133 inserts `### 4a. The stall ladder` at `test/integration/smoke.md:281`. That file already
has `### 4a. Answered by the orchestrator, without the human` at `smoke.md:237`, and `:281` sits
inside `## 4. Decisions — one answered, one escalated` (`smoke.md:220`), between `4a` (`:237`) and
`### 4b. Escalated to the human` (`:284`). The result is two `### 4a` headings in one document and a
stall-ladder walkthrough filed under "Decisions", which is not what it documents. The recovery-table
row (plan:1152) is correctly placed — `smoke.md:470-483` is the table and the `MAX_PASSES` row is
there.

**Fix.** Give the subsection its own top-level step, e.g. insert `## 4c. The stall ladder` after the
`### 4b` block ends (before `## 5.` at `smoke.md:309`), or make it `### 4c.` and keep it inside
section 4. Either way, do not reuse `4a`.

---

## MINOR 3 — the `files` clause diverges from the spec's table, and the plan's test pins the divergence

The spec's `stallAwaiting` table (spec:368) specifies, for `signal === 'files'`:

> `This phase is waiting for another task to release the files this one declared.`

with `short` = `the files another task holds`. The plan's implementation (plan:395) is
`if (row.signal === 'files') return sentence('the files another task holds')`, whose `clause` is
therefore `This phase is waiting for the files another task holds.` — a different sentence, and a
worse one: it names the symptom rather than the exit. The step-6 test (plan:340) asserts only
`short`, so the divergence ships silently.

**Fix.** Either give `files` its own return so the clause matches the spec table —

```ts
  if (row.signal === 'files') {
    return { short: 'the files another task holds',
             clause: 'This phase is waiting for another task to release the files this one declared.' }
  }
```

— or amend spec:368 to the shorter sentence. The plan should not leave the two disagreeing.

---

## MINOR 4 — four tests the spec's testing strategy names are not mapped to any step

Every *behavioural* requirement of the spec maps to a step (checked row by row against spec:41-50,
143-171, 464-552). Four items in the spec's **Testing strategy** (spec:579-615) do not:

- **A22** — *"an escalation whose send fails still leaves the record in `escalated`"* (spec:609). Not
  in any step, and not reachable from the plan's design: `escalate` is a `StallDeps` callback and the
  real one is an anonymous literal built inside `main()` (plan:927-953), so nothing exported can
  exercise the transition-before-send ordering. Live check 4 (plan:1183) only inspects the happy path.
- **persistence round-trip** — *"bump → `persist` → re-load through `listRuns` → not due until
  `threshold` later"* (spec:594-595). The plan's step-10 test counts `persist` calls with a fake
  (plan:783-791) but never round-trips through `saveRun`/`listRuns`; the spec calls this the check
  that "without **A4** this is exactly **P4** again". Only live check 2 (plan:1177-1180) covers it.
- **`stallAwaiting` `verdict` rows and the fallback** (spec:610-611). Step 6 tests `artifact`, `pr`,
  both `worktree` cases, `gate`, `files` and `manual` — seven of the spec's nine rows. `verdict`
  (task *and* run) and the `whatever clears <phase>` fallback are untested, and `verdict` is the one
  row that shares the `absoluteArtifactPath` branch with `artifact` but a different `short`.
- **A25's second half** — *"no rendered probe contains `{{`"* (spec:615). Step 11 asserts template
  properties only; nothing renders a probe end to end.

**Fix.** Either add them, or state the exception explicitly. The cheapest additions, both trivial:
extend step 6's last test with a `spec-review` task (`verdict` → `short` is `'its review verdict'`,
clause contains the reviews path) and a non-stallable `ci` row (`signal: 'ci'` → the
`whatever clears ci` fallback); and in step 10, assert
`expect(await renderPrompt(ROOT, 'stall-probe', bag)).not.toContain('{{')`. For **A22**, the honest
answer is that it is unreachable by unit test given the `main.ts` layering the spec chose
(spec:528-529) — say so in step 10 and lean on live check 4, rather than leaving a named spec test
silently unimplemented.

---

## What is right

Worth recording, because these were attacked and held:

- **The `artifact_path` shim (plan:921-923) genuinely works.** `render` (`src/lib/render.ts:8-14`)
  replaces only placeholders found in the *template* and ignores extra bag keys, so the untouched
  `prompts/stall-probe.md:5` keeps rendering at step 10 and the new `{{awaiting}}`/`{{ladder}}` keys
  are inert until step 11 rewrites the file. The claim at plan:26-30 is accurate.
- **Every `file:line` citation in the plan checks out**: `main.ts:17`, `:9`, `:15`, `:16`, `:109`,
  `:238`, `:255`, `:268`, `:30-32`; `cli.ts:292-302`, `:298-299`, `:304-320`, `:315-317`;
  `tick.ts:109`; `ledger.ts:48-62`; `store.ts:5-13`; `render.ts:8-14`, `:46`;
  `prompts.test.ts:68-76`; `table.test.ts:30-37`. `taskRow` is used at `main.ts:262` and nowhere else,
  so step 10's "delete the import" is correct. `grep -cE "^(export )?(function|const|class)"
  src/lib/types.ts` → `0`, as plan:70 claims.
- **Step 5's pinned sets are exactly right.** Executing the two filters against `src/lib/phases.ts`
  reproduces both arrays, and the `probeOnly` ordering
  `['dispatch','execute','blocked-on-files','blocked-on-decision']` is the real `[...RUN_ROWS,
  ...TASK_ROWS]` order, not a guess.
- **File holdings are clean.** The plan touches `config.ts`, `types.ts`, `stall.ts`, `main.ts`,
  `status.ts`, the two prompts, five test files and `smoke.md`. Nothing in t1's set (`src/cli.ts`,
  `src/lib/worker-prompt.ts`, `src/supervisor/tasks.ts`, `src/supervisor/deliver.ts`,
  `prompts/worker-brief.md`) and nothing in `src/lib/phases.ts` (#19). `deliver.ts` and `machine.ts`
  are import-only, and `src/supervisor/deliver.ts:1-11` imports nothing from `stall.ts`, so step 6's
  new import introduces no cycle.
- **A30 works as designed.** Executing step 9's resume test (plan:603-622) against the transcribed
  implementation: `escalate` before the restamp, `0` candidates immediately after it, and `probe` a
  full `TASK_STALL_MINUTES` later — with `src/cli.ts` untouched, exactly as spec:265-270 promises.
- **Steps 1-4, 5, 8, 11-15 are executable as written**, with the step-7 and step-9/10 exceptions
  above. Step 2's "do not bump `schema_version`" and step 14's `phase === 'escalated'` predicate both
  carry the reasoning that makes them non-arbitrary.

---

## Summary

Steps 1-6 and 8 are sound. Step 7 does not typecheck. Step 9 is red on at least eleven tests and
eight type errors, and step 10 compounds it by deleting a symbol two surviving tests still import.
The single most damaging consequence is that the regression test for the pass-1 BLOCKER — the reason
Ruling 2 was issued — fails against the implementation it is supposed to protect, and the two
shortest paths out of that red both re-introduce **P4**. The fixes are mechanical and fully specified
above; none of them reverses a decision or changes scope, but the plan cannot be executed literally in
its current form.

VERDICT: BLOCKER
BLOCKERS: 2
MAJORS: 2
