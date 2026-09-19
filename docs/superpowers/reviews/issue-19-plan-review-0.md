# Plan review — issue #19, pass 0

Target: `docs/superpowers/plans/2026-09-18-issue-19-plan.md`
Against: `docs/superpowers/specs/2026-09-18-issue-19-design.md` (CLEAR at pass 1),
`docs/superpowers/reviews/issue-19-spec-review-0.md`, `docs/superpowers/reviews/issue-19-spec-review-1.md`,
`.claude/agents/plugin-dev.md`, `.claude/skills/conventional-pr-titles/SKILL.md`.

## What I reproduced before reviewing

Every number the plan claims at `plan:842-858` was re-derived independently, in a throwaway copy of
`HEAD` (`git archive HEAD | tar -x`, `node_modules` symlinked) outside the worktree. The worktree was
never dirtied and the checkout's `src/cli.ts` was never run against live state.

| Plan's claim | Cite | Measured |
| --- | --- | --- |
| Baseline 454 pass / 0 fail, 34 files | `plan:16`, `plan:850` | **454 pass / 0 fail, 34 files** ✅ |
| Steps 1 + 2a + 2b + 2c → 453 pass / 3 fail | `plan:851` | **453 pass / 3 fail** ✅ |
| …and exactly the three tests named at `plan:157-160` | `plan:154-161` | exactly those three ✅ |
| After 2d (`phases.ts`) → 456 / 0 | `plan:852` | **456 pass / 0 fail**, `tsc --noEmit` clean ✅ |
| Counterfactual: 2b un-narrowed + 2d → that loop test fails | `plan:853` | fails, 54 pass / 1 fail ✅ |
| After steps 1–9 → 469 / 0, typecheck clean | `plan:854` | **469 pass / 0 fail**, clean ✅ |
| Step 12's clause script: five clauses, no `{{`, no fallback | `plan:855` | all five render, byte-identical to `plan:862-880` modulo the two placeholders noted in MINOR 3 ✅ |

I also checked every RED sub-step: 4a → 1 fail, 5a → 2 fail, 6a → 2 fail, 7a → 1 fail, 8a → 1 fail.
All match. Each numbered step's commit point leaves the suite green. Every cited line in the plan
(`phases.ts:39`, `:118-124`, `:130-131`; `stall.ts:83`, `:99-104`, `:101`, `:154-159`, `:164-165`;
`phases.test.ts:49-63`; `stall.test.ts:109-114`, `:303`, `:304`, `:307-315`; `table.test.ts:4`;
`smoke.md:199-204`, `:359-361`) resolves to exactly the text the plan quotes. The plan touches
exactly the six files it declares at `plan:31-37` and nothing else.

**The plan's validation section is honest.** That is worth saying plainly, because it is the thing I
was told to distrust and it held under a full re-execution. The findings below are gaps, not
fabrications.

---

## MAJOR 1 — the `close` clause is false in the one `close` deadlock the spec itself documents, and the plan ships it as a forever-repeating sentence

**Claim.** Step 7 (`plan:536-575`) treats `close` as the one last-mile row with no deadlock case: a
single unconditional branch, one test, no null/edge arm. `plan:536` opens the step with no
preamble at all, in contrast to `plan:390-395` (`ci`) and `plan:461-467` (`merge`), which each open by
enumerating the states the row can be in.

**Problem.** `close` has a permanent deadlock of exactly the shape pass 1's MAJOR 1 forced into the
`merge` clause, and in that state the plan's clause is false in both of its sentences. The spec knows
the state exists — it names it at `spec:164-166` (*"rewinding to `close` leaves `merged_at_ms === null`
with `issue_closed_at_entry === false`, so `machine.ts:178-182`'s `closedByMerge` is unsatisfiable
too"*) — and states at `spec:167` that **"Making it audible is this issue's job."** The `close` clause
does the opposite of making it audible: it tells the operator the issue is not closed and to go close
it, every 45 minutes, forever, while the issue is closed.

**Evidence.**

- The transition (`src/lib/machine.ts:173-184`) needs `s.issueClosed` **and**
  (`task.issue_closed_at_entry` **or** `closedByMerge`), where
  `closedByMerge = task.merged_at_ms !== null && s.closedAtMs !== undefined && s.closedAtMs >= task.merged_at_ms`
  (`machine.ts:178-181`).
- `task.merged_at_ms` is written in exactly one place, the `merge → close` edge
  (`machine.ts:168`). A task placed in `close` any other way has `merged_at_ms === null`.
- `cmdRewind` sets `task.phase = input.phase as TaskPhase` with no validation
  (`src/cli.ts:203`), re-stamps `phase_entered_at` (`:206`) and touches neither `merged_at_ms` nor
  `issue_closed_at_entry`. So `hpipe rewind <run> close --task tN` from any phase before `merge`
  produces the state. This is the same route pass 1 accepted for `merge` (`spec:156-160`) and it is
  row 1 of the runbook's own recovery table (`smoke.md:530`).
- Executed against the plan's own applied tree, with the issue genuinely closed a day ago:

  ```
  advanceTask(run, task{phase:'close', merged_at_ms:null, issue_closed_at_entry:false},
              {issueClosed:true, closedAtMs:<yesterday>})  →  null
  stallAwaiting(...).clause →
    "This phase is waiting for issue #7 to close. Check it with `gh issue view 7 --json
     closed,state`; if the PR body used a phrase GitHub does not treat as a closing keyword,
     close it by hand."
  ```

  The row never advances; the probe instructs an action that is already done and cannot be repeated.
  `gh issue view 7 --json closed,state` returns `closed: true`, so the clause actively misdirects.
- This is the defect the spec makes **P2** out of (`spec:121-135`) and the exact rule pass 1 applied
  to `merge`: *"a clause asserting the first would be false in the second"* (`spec:470-472`,
  `spec:726-729`). Nothing in the spec, NG9 or NG11 exempts `close`; NG11 (`spec:237-242`) declines to
  **fix** the machine, while `spec:167` assigns making it **audible** to this issue.

**Concrete fix.** In step 7b, make the `closed` branch mirror the `merged` branch's second sentence
rather than the single-state form, and pin it in 7a. Both files are declared, so this is inside the
plan's own holdings:

```ts
  if (row.signal === 'closed' && task) {
    // Not "the issue is still open": `closedByMerge` needs `merged_at_ms`, which only
    // the merge edge writes (machine.ts:168). A task rewound into `close` from before
    // `merge` has none, so a closed issue never satisfies machine.ts:178-182.
    return {
      short: `issue #${task.issue} to close`,
      clause: `This phase is waiting for issue #${task.issue} to close. Check it with ` +
        `\`gh issue view ${task.issue} --json closed,state\`; if the PR body used a phrase ` +
        'GitHub does not treat as a closing keyword, close it by hand. If it is already ' +
        'closed, this phase cannot see it: it only counts a close it can tie to this ' +
        "task's recorded merge, so say so rather than waiting.",
    }
  }
```

and in 7a add, beside the existing assertions:

```ts
  expect(a.clause).toContain('already')
  expect(a.clause).not.toContain('never clear')
```

Add one line to step 7's preamble naming `machine.ts:178-182` and `cli.ts:203` as the route, the way
steps 5 and 6 already do. If the planner would rather not widen the clause, the alternative that does
*not* need a human is to route it to NG11's follow-up issue explicitly in the plan and in the PR body
— but shipping the current sentence unremarked is not one of the options the spec leaves open.

---

## MAJOR 2 — the spec's required `rollUpBucket` sibling assertion has no step, and `cancel` is uncovered today

**Claim.** Step 5a (`plan:396-419`) implements pass 1's MAJOR 2 as a single negative assertion,
`expect(a.clause).not.toContain('cancelled')` (`plan:405`).

**Problem.** The spec asks for two assertions, not one. `spec:722-725`:

> **Pass 1 MAJOR 2, as a negative assertion.** The `ci` clause does **not** contain `cancelled` …
> **A sibling assertion pins the roll-up itself, so the clause and `gh.ts` cannot drift apart
> silently.**

There is no step for the sibling assertion, and it is not already covered: `test/gh.test.ts:12-26`
tests `fail`, `pending`, `pass`/`skipping` and the empty list, and never exercises `cancel` at all.
`grep -rn "cancel" test/` returns nothing outside the plan's own new text. So today
`rollUpBucket`'s `cancel → fail` line (`src/lib/gh.ts:19`) is entirely untested, and the whole
justification for the negative assertion — the reason the word `cancelled` must not appear in the
clause — rests on an unpinned line. Delete `gh.ts:19` and the suite stays green while the `ci` clause
silently becomes wrong.

**Evidence.** `src/lib/gh.ts:14-21`; `test/gh.test.ts:12-26`; `spec:722-725`.

**Concrete fix.** `test/gh.test.ts` is outside the plan's six files (`plan:31-37`) and must not be
taken — but `test/stall.test.ts` is declared, and the assertion belongs next to the clause it
protects anyway. Append to step 5a, and add `rollUpBucket` to the import at `test/stall.test.ts:5-8`
(`import { rollUpBucket } from '../src/lib/gh'`):

```ts
test('a cancelled check rolls up to fail, which is why the ci clause omits it — #19', () => {
  // The clause above asserts `cancelled` is not a forever-wait. That is only true
  // while gh.ts:19 maps it to `fail`; unpinned, the two drift apart in silence.
  expect(rollUpBucket([{ bucket: 'pass' }, { bucket: 'cancel' }])).toBe('fail')
})
```

The step-5 commit message and the expected count at `plan:453` shift by one (`470 pass` end state, and
`plan:856`'s "469 pass / 0 fail" becomes 470 — 471 if MAJOR 1's assertions land as separate
expectations inside the existing test, which they do, so 470).

---

## MINOR 1 — "Why three and not four" gives a reason that is measurably wrong, and contradicts the plan's own text 80 lines later

**Claim.** `plan:77-81`: *"The spec's testing section says four tests must fail before the change, and
that is true in the order the pass-1 reviewer used — `phases.ts` first, then the tests. This plan
edits the tests first, so 2b's narrowed loop goes green immediately."*

**Problem.** Measured, `phases.ts`-first does **not** produce four failures; it produces three. The
fourth (`test/stall.test.ts:307-315`, *"an unrecognised signal falls back to naming the phase"*) has
nothing to do with `phases.ts` — it fails only once `stallAwaiting` gains the `ci` branch, which in
this plan is step 5b and in the spec is part of "the change". And the drop from four to three is not
caused by 2b alone: in the tests-first order 2b **and** 2c both go green, while 2a contributes a third
new failure. The plan says exactly this, correctly, at `plan:163-164` — *"2b and 2c both pass already
… and `intake` reaches the fallback today too"* — which contradicts the rationale at `:79-80`.

**Evidence.** In the scratch tree:

| Applied | Result |
| --- | --- |
| `phases.ts` only, tests untouched | **3 fail**: the two `phases.test.ts` sets + the `stall.test.ts:109` loop |
| `phases.ts` **and** `stall.ts` (all branches), tests untouched | **4 fail**: the above + the fallback test |
| Plan's order (steps 1, 2a, 2b, 2c), no source change | **3 fail**: the three new `phases.test.ts` tests |

So the spec's list of four (`spec:664-706`) is a list of tests that fail against the *finished source
change*, not against `phases.ts` alone. The plan's stop-condition and count are right; only the
explanation is wrong, and `plan:887-891` sends a confused implementer chasing table drift.

**Concrete fix.** Replace `plan:77-81` with:

> **Why three and not four.** The spec's four (`spec:664-706`) are the tests that fail against the
> *finished* source change — `phases.ts` **and** `stall.ts`'s new branches. This step lands only the
> test edits, so two of the four are already satisfied by them: 2b's narrowed loop lists rows that are
> unstallable either way, and 2c's `intake` reaches the fallback today too. 2a replaces two tests with
> three, so three fail. Both are still load-bearing: leaving 2b un-narrowed makes it fail at 2d, and
> leaving 2c on `ci` makes it fail at 5b. Measured; see **Validation**.

Add the un-narrowed-2c counterfactual to the table at `plan:848-855` beside the 2b one.

---

## MINOR 2 — steps 5a and 6a drop the spec's `{{`-leak assertion on the two deadlock clauses

**Claim.** `spec:737-739` requires, for the `pr === null` arms: *"each return the deadlock sentence
**and** a `rewind … implement --task …` exit, built with `'bun run /p/src/cli.ts'` and containing no
`{{` — mirroring the `gate` assertion at `:287-290`."*

**Problem.** `plan:409-418` (ci) and `plan:485-492` (merge) assert the rewind and the
`bun run /p/src/cli.ts` prefix but omit `expect(a.clause).not.toContain('{{')`. Step 4a has it
(`plan:318`); these two do not. Step 12's script (`plan:753-772`) does check for `{{`, but it runs with
`pr: 42`, so the null arms are never rendered by it either. `render()` throws on an unresolved
placeholder at delivery time in front of an agent (`src/lib/render.ts:11`, `.claude/agents/plugin-dev.md:28-31`),
which is why the spec asked for it on every composed clause.

**Concrete fix.** Add `expect(a.clause).not.toContain('{{')` to the last assertion block of both
`plan:409-418` and `plan:485-492`.

---

## MINOR 3 — the "verbatim from the dry run" block is not verbatim

**Claim.** `plan:860` — *"The five rendered clauses, verbatim from the dry run, are what step 12
should print."*

**Problem.** The `escalated` line at `plan:878-879` reads
`` `<hpipe> rewind <run_id> implement --task t1` ``. The script at `plan:753-772` interpolates both,
so what it actually prints is
`` `bun run /p/src/cli.ts rewind r-<date>-<slug> implement --task t1` `` — confirmed by running it.
An implementer diffing their output against a block labelled "verbatim" will see a mismatch on the
one line the plan told them to treat as a finding (`plan:775-776`). Relatedly, `plan:836-837` says to
"replace the `bun test` / `bun run typecheck` lines in the body with the real counts", but the body
lines at `plan:819-820` carry no counts to replace.

**Concrete fix.** Either annotate `plan:878-879` as elided (`— run id and hpipe path elided`) or print
the real shape. Change `plan:836` to name the number: *"state the real pass count (`N pass / 0 fail`)
in the `bun test` bullet."*

---

## MINOR 4 — live verification is labelled "not optional" by the spec and has no step, owner or trigger

**Claim.** `spec:762-791` is headed *"Live verification — not optional"* and lists nine steps with a
`TASK_STALL_MINUTES=1` setup. `.claude/agents/plugin-dev.md:56-59` requires that a change touching
delivery *"say in your plan how it would be verified against a real herdr session"* — every probe here
is a delivery.

**Problem.** The plan schedules none of it. `plan:882-885` concedes the gap honestly and
`plan:822-824` repeats it in the PR body, but neither names when it happens, who does it, or what
unblocks it. It cannot happen pre-merge — the installed plugin is a tag-pinned GitHub install
(`spec:631-633`, `.claude/agents/plugin-dev.md:42-49`), so the running supervisor keeps the old table
until the release lands — which is precisely why it needs an explicit post-release step rather than a
sentence of regret. This is the surface whose unit suite has passed clean over real defects twice
(`.claude/agents/plugin-dev.md:55-57`).

**Concrete fix.** Add a step 13 (post-merge, not a commit) restating spec steps 1, 2, 3 and 5 with the
`TASK_STALL_MINUTES=1` `config.env` note and the instruction to file a finding rather than patch a
test on any divergence, and have the PR body at `plan:822-824` point at it by number instead of at the
design in general.

---

## Checks that passed

- **Every spec requirement maps to a step**, with the two exceptions above. A1/A3 → 2d; A2 → step 3;
  A5 → 2d + step 4; A6 → steps 4b, 5b, 6b, 7b, 8b + the docblock at 4b; A9 → step 1; A10 both sites →
  steps 10 and 11; A12/A13 → 5a/5b, 6a/6b; A14 → 2c; A15/A16 → honoured. The spec's Testing-strategy
  list maps as: candidates → step 3 test 1; A2 safety → step 3 test 2; the 4h57m regression → step 3
  test 3; per-branch clauses → steps 5–8; pass-1 MAJOR 1 negative → `plan:480-482`; MINOR 2
  consistency → `plan:417`, `plan:491`; MINOR 5 non-vacuous ordering → step 9 (correctly on
  `implement`, and it really does escalate — verified); A26 for the new rows → step 3 test 4.
- **No step contradicts a settled decision.** `ESCALATING_SIGNALS` is untouched; `prompts/*`,
  `status.ts`, `tick.ts`, `machine.ts`, `ledger.ts`, `cli.ts` and the sibling's tests are all
  untouched; `holdsFiles` is unchanged on all five rows; `schema_version` is not bumped; the recovery
  table at `smoke.md:530-534` is left alone per NG11.
- **Types and signatures stay consistent step to step.** `stallAwaiting(run, task, hpipe): Awaiting`
  keeps its signature; the `task.pr === null` early returns narrow `number | null` correctly (`tsc
  --noEmit` clean at every commit point); the helpers step 3 claims at `plan:288-290` all exist at the
  lines given; no new import is needed in `phases.test.ts` or `table.test.ts`, as claimed.
- **No placeholders in the executable text.** Every code block is complete and insertable; every
  "replace X with Y" quotes X exactly as it appears on disk, and each `old` string I searched for
  occurred exactly once.
- **The human-actor branch placement is safe.** The only other `actor: 'human'` row is the *run*
  `escalated` row (`phases.ts:70-71`), which is not stallable and `releasesPane: true`, and
  `stallAwaiting`'s only call sites are `main.ts:272` and `:289`, both inside the stall path. No
  reachable behaviour changes for it.
- **PR title and body.** `fix: probe the last mile so a parked task never stops in silence` is
  conventional per `.claude/skills/conventional-pr-titles/SKILL.md` — allowed type, imperative,
  lowercase, no trailing period — and `fix` is the right type for a patch bump. The body ends with a
  real closing keyword, `Closes #19` (`plan:829`), followed only by the session trailer, which does not
  interfere with auto-close. Its factual claims check out: `stall.ts:101` is the gate line; CI on this
  repo really is a PR-title lint plus release-please (`.github/workflows/`).
- **Self-hosting hazard respected.** No step links or runs the checkout's `src/cli.ts` against live
  state; step 12's script constructs an in-memory run via `newRun` and writes nothing.

MAJORS: 2
MINORS: 4

VERDICT: CLEAR
