# Adversarial review — issue #26 design, pass 0

Reviewed `docs/superpowers/specs/2026-09-19-issue-26-design.md` against `gh issue view 26`, the
research note at `docs/superpowers/research/2026-09-19-issue-26-research.md`, and the tree at
`0937146`. Baseline re-measured here, not taken from the spec:

    $ bun test          → 503 pass, 0 fail, 1265 expect() calls, 34 files, 8.99s
    $ bun run typecheck → tsc --noEmit, exit 0

**What holds up.** The C3 arithmetic is sound for every sequence I could trace on a record that
carries `phase_entries`, and the back-compat floor really is byte-identical to today when the field
is absent — I traced the normal loop, the `BLOCKER` loop, rewind-to-producer, escalate-then-rewind,
and the run-level `branch-review` self-loop (`src/lib/phases.ts:64-66`), and none of them collides or
moves the path backwards. **A11 is correct and the research note was wrong**: all four cited tests
survive C3 unchanged, because every `mkTask`/`mkRun` literal in the suite omits `phase_entries`
(`test/deliver.test.ts:14-25`, `test/cli-commands.test.ts:35-47`) so `entriesFor` reads 0 and
`Math.max(-1, counterFor(…))` collapses to today's expression. `grep -rn "\.phase = " src/` does
return exactly the six sites C2 names, `grep -l "passes: {}" test/*.ts | wc -l` does return 12, and
every prompt and `verdict_path` citation I checked is accurate at HEAD. The `run.history` rejection
is correctly evidenced (`src/actions/claim.ts:32`, `src/lib/orchestrator.ts:56-59`).

The findings below are about the two places the design asserts coverage it does not have.

---

## BLOCKER 1 — the design contradicts itself about C4, and the one live case it cites is uncovered

**Claim.** Spec `:166-169`: *"C4 cannot run where no prompt is rendered — a rewind straight onto a
review row re-enters no phase, so `advanceTask` never fires and no prompt is produced."* Spec
`:199-202`, about that same command: *"On a legacy run both counters read 0, `n = 0`, the default is
occupied, and **C4 redirects to `…-1.md` and records it**."*

**Problem.** These cannot both be true, and `:168` is the one that matches the code. The consequence
is not cosmetic: the legacy *clear-then-rewind-onto-a-review-row* case is left fully unfixed, and it
is the exact case A1 exists to justify and the only rewind-onto-a-review-row the research note found
in the wild (`t4:spec-review` on `berean-os-20260917-…-xilp`, research `:144`, `:153-154`). So the
Goal at spec `:49-50` is not met, and **A10** (*"the floor in C3 plus the seed in C2 plus the backstop
in C4 cover every legacy case"*) is false.

**Evidence.**

1. No prompt is rendered for a task whose phase did not transition:

       src/supervisor/tasks.ts:171-178
         const cameFrom = task.phase
         if (!advanceTask(run, task, signals)) continue
         if (task.phase === cameFrom) continue
         const prompt = await promptForTaskPhase(run, task, deps, cameFrom)

   After `hpipe rewind <run> spec-review --task t1`, `task.phase` is already `spec-review`
   (`src/cli.ts:352`). `gatherSignals` calls `deps.verdictFor` (`src/supervisor/tasks.ts:270-275`),
   which returns `null` because no fresh file exists at the new path, so `advanceTask` returns `null`
   at the `spec-review` arm and the loop `continue`s. `promptForTaskPhase` — and therefore
   `reserveVerdictPath` — is never reached. `src/supervisor/tasks.ts:55` and
   `src/supervisor/deliver.ts:253` are the only two `verdict_path` render sites in the repo
   (`grep -rn "verdict_path" src/`), and neither is on this path.

2. The legacy record then collides. Trace `t4:spec-review`'s shape exactly: a task that entered
   `spec-review` once, was cleared, and advanced. `CLEAR` returns before `bumpCounter`
   (`src/lib/machine.ts:117-119`), so `passes['spec-review']` is `0` or absent, and the record
   predates the change so `phase_entries` is absent. `hpipe rewind <run> spec-review --task t4`:
   - the C2 seed is guarded by `if (spent > 0)` (spec `:120`) and does not fire;
   - C2 bumps the target → `phase_entries['spec-review'] = 1`;
   - C3 gives `n = Math.max(1 - 1, 0) = 0`, key `spec-review-0`, path `issue-4-spec-review-0.md` —
     **the file the earlier CLEAR review already occupies**;
   - `cmdRewind` re-stamps `phase_entered_at` (`src/cli.ts:355`), so `isFresh`
     (`src/lib/predicates.ts:10-20`, read at `src/supervisor/main.ts:196`) reads the occupant as
     stale and the row advances only when it is overwritten — the original defect, byte for byte.

   C4 is the only thing the spec offers for this branch, and by `:168` it does not run.

**Concrete fix.** Pick one and say which, because it is a design choice, not an edit:

- **(a)** Make `cmdRewind` itself the reservation point. It already owns the seed and the bump and it
  is the only command that can create this collision; have it call the same `reserveVerdictPath`
  logic for the target phase when `taskRow(input.phase).signal === 'verdict'`, writing the winner to
  `record.artifacts.verdicts[key]` before `saveRun` at `src/cli.ts:372`. This closes the hole for
  legacy *and* post-change records, is idempotent by the same `artifacts.verdicts` read, and gives
  `hpipe rewind`'s success text (`src/cli.ts:373`) somewhere to name the new path.
- **(b)** Drop the `if (spent > 0)` guard and seed `phase_entries[phase] ??= spent + 1` for every
  review row the record has ever occupied — but this needs a source of truth for "has occupied",
  which `passes` is not (that is precisely A1's point), so (a) is the cheaper answer.

Whichever is chosen, delete or rewrite one of spec `:166-169` / `:199-202`; as written the document
asserts both.

---

## MAJOR 1 — the C2 seed throws on exactly the legacy records it exists for, and breaks a test A11 says stays green

**Claim.** Spec `:116-121`:

    cmdRewind additionally seeds the counter for records that predate this change, immediately
    before `passes` is cleared:

        for (const [phase, spent] of Object.entries(record.passes)) {
          if (spent > 0) record.phase_entries[phase] ??= spent + 1
        }

**Problem.** On a record that predates the change, `record.phase_entries` is `undefined`, so
`record.phase_entries[phase]` throws `TypeError: Cannot read properties of undefined`. The error
table handles this for `bumpEntries` only (spec `:212`: *"Creates `{}` in place"*) and the flow table
at `:191-193` orders the seed **before** the bump, so nothing has created the map yet.

**Evidence.** `A2` makes the field optional (`Task.phase_entries?`, spec `:76`), and the suite's task
literals are hand-written, not constructor-built:

    test/cli-commands.test.ts:35-47   mkTask = (over: Partial<Task>): Task => ({ … passes: {}, … })
    test/cli-commands.test.ts:49-53   runWithTasks → run.tasks = overrides.map(mkTask)
    test/cli-commands.test.ts:228-239 cmdRewind(… phase: 'spec', taskId: 't1')

So `test/cli-commands.test.ts:228-239` — one of the four A11 claims green — drives `cmdRewind` over a
task whose `phase_entries` is `undefined` and would throw before reaching
`expect(saved?.tasks[0]?.passes).toEqual({})`. (`test/cli.test.ts:117-129` escapes only because it
builds its run with `newRun()`, which A2 says will initialise `phase_entries: {}` —
`src/lib/ledger.ts:24-41`.) The same throw hits every real legacy run on disk, which is the whole
point of the seed.

**Concrete fix.** State the initialisation in C2, not just in the `bumpEntries` row of the error
table: `record.phase_entries ??= {}` as the first line of the seed block (or make the seed call
`bumpEntries`-adjacent helper that owns the lazy init). Add the crash case to the error-handling
table as its own row, and amend A11 to say the test stays green *given* that init.

---

## MAJOR 2 — C4 is specified at a call site that fires for artifact rows too, and the error table's guard is inverted

**Claim.** Spec `:150-152`: `reserveVerdictPath` is *"called once per transition from
`promptForTaskPhase` (`src/supervisor/tasks.ts:46-60`)"*. Spec `:215`: the only guard named is
*"`absoluteArtifactPath` returns `null` (an artifact row, not a verdict row) | C4 is not called"*.

**Problem.** `src/supervisor/tasks.ts:46-60` builds `common` **before** the `switch`, so
`verdict_path` is computed for *every* task phase, including `research`, `spec`, `plan`, `implement`,
`merge` and `close`. And for a real artifact row `absoluteArtifactPath` does **not** return `null` —
it returns the artifact's own path, outside `docs/superpowers/reviews/` entirely:

    src/supervisor/deliver.ts:98-100
      const row = taskRow(task.phase)
      if (row.artifact) return task.artifacts[row.artifact]

    src/cli.ts:225-230   artifacts: { research: join('docs/superpowers/research', …),
                                      spec: join('docs/superpowers/specs', …),
                                      plan: join('docs/superpowers/plans', …), verdicts: {} }

`null` comes back only when the slot itself is `null`, which happens in test literals
(`test/deliver.test.ts:21`), not on a task `hpipe task` created. So the stated guard never fires for
the case it names, and an implementer following C4 step 1 literally (*"Compute `key` and the default
path as C3 does"*) has no key to compute for an artifact row — `artifactPathFor` returns at `:99`
before the key exists. The realistic failure is a rewind to `spec`: the spec file already exists, C4
sees an occupied path and walks to a "free ordinal" for a document that has no ordinal, handing the
worker a path under `docs/superpowers/reviews/` or a mangled one. Rewinding to `spec` is the most
common rewind in the ledger (research `:141-144`).

**Concrete fix.** Say in C4 that `reserveVerdictPath` is a no-op returning the input path unless
`taskRow(task.phase).artifact === undefined && taskRow(task.phase).signal === 'verdict'` (mirroring
`src/lib/phases.ts:96-98`, `:101-103`, `:111-116`), and replace the `:215` error-table row with the
correct condition. Note that `ci` also has no `artifact` and does reach the verdict branch today
(`taskRow('ci')`, `src/lib/phases.ts:121-123`), so a `signal === 'verdict'` test is needed, not just
an `artifact === undefined` one. The same guard is needed at `promptForRunPhase`
(`src/supervisor/deliver.ts:246-255`), which computes `verdictPath` for `intake`, `dispatch` and
`escalated` as well.

---

## MAJOR 3 — after a rewind onto a review row the watched path moves and nothing tells anyone (scope judgment)

**Claim.** Spec `:199-202` accepts that `hpipe rewind <run> spec-review --task t1` moves the ordinal
(post-change record: `n = max(1, 0) = 1` → `…-1.md`), and A8 `:255-258` deliberately keeps
`hpipe status` reporting `counterFor`, not the ordinal.

**Problem.** On that command no prompt is rendered (BLOCKER 1, evidence 1), so the new path reaches
no agent — `src/supervisor/tasks.ts:55` and `src/supervisor/deliver.ts:253` are the only carriers.
And nothing surfaces it to the human either: `grep -rn "artifactPathFor\|absoluteArtifactPath" src/lib/status.ts`
returns nothing, and `src/cli.ts:373` says only `"…; counters cleared"`. So the supervisor begins
watching `…-1.md` while `hpipe status` prints `pass 0` (`src/lib/status.ts:102-105`) and every
artefact in the tree points at `…-0.md`. Today the ordinal at least stayed where the last delivered
prompt put it. This is not the silent-overwrite bug, but it is a new silent divergence introduced on
the same command, and the live runbook at spec `:333-336` asks the operator to confirm behaviour the
design provides no mechanism for.

**Judgment needed, which is why this is here rather than in the MINORs.** Either (a) `cmdRewind`
reports the reserved path in its success text and `hpipe status` shows the ordinal, which contradicts
A8 as written and touches `src/lib/status.ts`; or (b) rewinding onto a review row re-delivers that
row's prompt, which is behaviour change in `cmdRewind` and arguably #22's scope; or (c) the spec
states explicitly that this row still requires a human to place the file and that the ordinal is
discoverable only by `ls docs/superpowers/reviews/`. Pick one and record it as an assumption — the
current text does not acknowledge the gap.

---

## MINOR 1 — C4's idempotence rationale is false

Spec `:155-157` justifies step 2 with *"`promptForRunPhase` can be reached twice for one transition,
from `evaluateRun` at `src/supervisor/deliver.ts:242` and from `src/supervisor/main.ts:215-217`."*
It cannot: `main.ts:184` captures `runPhaseBefore` **after** `evaluateRun` has already run and
mutated `run.phase` at `main.ts:182`, so `main.ts:215` evaluates `run.phase === runPhaseBefore` →
`''` for any transition `evaluateRun` made. The two sites cover disjoint transitions. Step 2 is still
worth keeping (it is what makes `artifactPathFor`'s later read agree with C4's write), so fix the
reason, not the step: *"a recorded redirect must be returned by the next read through
`artifactPathFor`, which `verdictFor` performs on every tick (`src/supervisor/main.ts:193-198`)."*

## MINOR 2 — the seed's arithmetic rationale is wrong (the value is safe, the reason is not)

Spec `:125-126`: *"`spent + 1` is the number of times the row must have been entered to spend `spent`
passes."* It is not — spending `spent` passes takes exactly `spent` entries. Trace
`src/lib/machine.ts:113-127`: entry 1 writes `-0`, `BLOCKER` bumps to 1; entry 2 writes `-1`,
`BLOCKER` bumps to 2 and escalates at `MAX_PASSES = 2` (`src/lib/config.ts:26`). Two entries, two
passes. `spent + 1` is a deliberate *upper bound* that can never undercount (a `CLEAR` consumes an
entry without a pass, so the true count can also exceed `spent`), which is the right property and the
reason the legacy example at `:195-196` skips `-2`. Say that instead; as written a reader will try to
"fix" the off-by-one and reintroduce the collision.

## MINOR 3 — "the ordinal sequence over a normal loop is 0, 1, 2" contradicts the spec's own table

Spec `:303`. `MAX_PASSES` is `2` (`src/lib/config.ts:26`) and `advanceLoopingRow` escalates on
`count >= maxPasses` (`src/lib/machine.ts:121-123`), so a normal loop produces `-0` and `-1` only —
which is what the spec's own flow table at `:183-185` shows. Either say `0, 1` or say the test raises
`maxPasses`.

## MINOR 4 — the comment C4 falsifies is not in the change set

`src/supervisor/deliver.ts:91-94` states *"nothing ever populates `artifacts.verdicts` —
`artifactPathFor` reads it and no writer exists — so the `claimed` set cannot exclude them and
`adoptableArtifacts` filters by prefix instead."* C4 makes the premise false while the conclusion
(`src/supervisor/deliver.ts:180`, pinned by `test/deliver.test.ts:287-295`) stays correct. The
research note flagged this as a required correction (research `:183-186`); the spec's Architecture,
Non-goals and C5 all omit it, and `.claude/agents/plugin-dev.md:32-34` makes stale *why* comments a
repo-level concern. Add it to C5.

## MINOR 5 — three citation slips

- Spec `:8-9` pairs *"`enterTaskPhase`/`enterRunPhase` (`src/lib/machine.ts:45-51`, `:90-96`)"* in the
  wrong order — `enterRunPhase` is `machine.ts:45`, `enterTaskPhase` is `machine.ts:90`. Corrected
  later at `:84-85`, so this is churn between drafts.
- Spec `:140-141` cites *"every `mkTask`/`mkRun` literal in the test suite, e.g.
  `test/deliver.test.ts:149-153`"*. `:149-153` is a test body; the literals are at
  `test/deliver.test.ts:14-25` (`mkTask`) and `:27-31` (`mkRun`).
- Spec `:230` cites the task constructor as `src/cli.ts:225-232`; that span is the `artifacts` object
  plus one line. The constructor is `src/cli.ts:216-233`.

## MINOR 6 — the red test cannot live where it is specified

Spec `:280-285` puts the red test in `test/deliver.test.ts` and describes it as *"a task that has
entered `spec-review` twice and **is then rewound**"*. `cmdRewind` is in `src/cli.ts` and is not
imported by `test/deliver.test.ts` (`test/deliver.test.ts:1-10`); the rewind assertions live in
`test/cli-commands.test.ts:228-239`. And "has entered twice" is only expressible through
`phase_entries`, which does not exist today, so the test cannot be *run* red against current code —
`bun run typecheck` would reject it. State it honestly: the red test is a cross-module one in
`test/cli-commands.test.ts` (rewind → `artifactPathFor`), or it is a unit test of new behaviour with
no meaningful red phase.

---

None of the MINORs blocks. BLOCKER 1 leaves the design's stated Goal unmet for the only
rewind-onto-a-review-row the research found in the wild, and MAJOR 3 needs a call the implementer
cannot make alone.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 3
