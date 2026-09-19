# PR review (quality) — issue #19, pass 0

Target: PR #47, branch `fix/19-last-mile-stallable`, `b31c3bb..HEAD`.
Against: `.claude/agents/plugin-dev.md`, the surrounding code in `src/supervisor/stall.ts` and
`src/lib/phases.ts`, and the sibling tests in `test/`.

Stage 2 only: **is this written the way this codebase is already written?** Intent, scope and
completeness are settled at `docs/superpowers/reviews/issue-19-pr-review-intent-0.md` (CLEAR) and
are not reopened here.

## What I ran

In the worktree, read-only: `bun run typecheck` → `tsc --noEmit`, no output, exit 0. `bun test` →
**504 pass / 0 fail, 1263 expect() calls, 34 files**. `git status --porcelain` empty afterwards. The
checkout's `src/cli.ts` was never executed and nothing was written to the ledger. So the tree I
reviewed is the tree that is green.

I also resolved every `file:line` the PR adds, since this repo leans on them as load-bearing
documentation. Thirteen of the fourteen are correct against the shipped tree:

| Citation | Points at | |
| --- | --- | --- |
| `ci.ts:12` | `if (task.phase !== 'ci' \|\| task.pr === null) continue` | ✅ |
| `gh.ts:19` | `if (rows.some((r) => r.bucket === 'cancel')) return 'fail'` | ✅ |
| `tasks.ts:137` | `await runTeardown([run], deps.removeWorktree)`, above the loop | ✅ |
| `tasks.ts:278` | `if (task.pr === null) return base` in the `merge` arm | ✅ |
| `machine.ts:165-171` | the whole `case 'merge'` | ✅ |
| `machine.ts:167` | the `mergedAtMs <= phase_entered_at` guard | ✅ |
| `machine.ts:168` | `task.merged_at_ms = s.mergedAtMs` — the only writer | ✅ |
| `machine.ts:178-181` | the `closedByMerge` conjunction | ✅ |
| `table.test.ts:33` | `const hasPane = row.actor === 'orchestrator' \|\| row.actor === 'worker'` | ✅ |
| `tick.ts:237-248` | `pickOneAdvance`, and it does have three skips | ✅ |
| `tick.ts:59-64` | the `WakeLine.task` docblock stating the null arm is unreachable | ✅ |
| `stall.ts:83` | `if (row.stallWhen && !row.stallWhen(run)) continue` | ✅ |
| `phases.ts:39` | the `stallWhen` signature, which is run-shaped | ✅ |
| `stall.ts:227-229` | the middle of the new `merge` branch | ❌ — MINOR 1 |

---

## MINOR 1 — a citation this PR's own diff invalidated

**Where.** `test/stall.test.ts:733-734`:

```ts
  // Must not contradict ladderFor's "clears when whatever it is waiting for
  // arrives" (stall.ts:227-229), which every probe renders beneath the clause.
```

**Problem.** `ladderFor` is at `src/supervisor/stall.ts:304`, and the quoted sentence is at `:306-307`.
`stall.ts:227-229` lands inside the `merge` branch this PR adds — a reader following it finds prose
about an unmerged PR and no ladder at all.

This is not carelessness, it is a foreseeable consequence: the citation was correct against the base
(`git show b31c3bb:src/supervisor/stall.ts` puts `ladderFor` at `:226` and the sentence at `:228-229`),
it was written into `plan:425` at that time, and the same PR then inserted 84 lines above it. The
plan review could not have caught it; stage 2 is where it surfaces. The three prose citations the spec
and plan carry (`spec:624`, `:732`, `:840`) are documents describing the old tree and are fine — only
the one that ships inside the code is wrong.

**Concrete fix.** One token, inside a declared file:

```ts
  // arrives" (stall.ts:306-307), which every probe renders beneath the clause.
```

---

## MINOR 2 — the null-PR case is written out twice in the source and twice again in the tests

**Where.** `src/supervisor/stall.ts:220-226` and `:240-246`; `test/stall.test.ts:726-737` and
`:752-761`.

**Problem, source.** The two `Awaiting` literals are identical but for one clause fragment:

```ts
    short: 'a PR number this task never recorded',
    clause: 'This phase is waiting for a PR number that was never recorded for this task, ' +
      `so CI is never polled for it. The rewind is what produces one: \`${hpipe} rewind ` +
      `${run.run_id} implement --task ${task.task_id}\`.`,
```

versus `so no merge is ever seen.` in the `merged` arm. Everything else — the `short`, the opening
sentence, and the whole rewind command including `run.run_id`, the literal `implement` and the
`--task` flag — is duplicated verbatim. That command is the one thing in the clause a reader will
paste, and it is now maintained in two places with nothing tying them together. The file already
establishes the idiom for exactly this: `sentence()` at `:167-168` is a local closure that exists
so a repeated phrasing is written once.

**Problem, tests.** `test/stall.test.ts:726-737` and `:752-761` have byte-identical bodies apart from
`phase: 'ci'` vs `phase: 'merge'` and one comment. The file's established shape for "same assertions,
several phases" is the labelled `for (const phase of [...] as const)` loop — used at `:536`, and four
more times by this PR at `:634`, `:644`, `:680` and `phases.test.ts:70`. Two copy-pasted tests is a
second way to say the same thing, in a file that had already settled on the first.

**Concrete fix.** In `stall.ts`, beside `sentence()`:

```ts
  const missingPr = (consequence: string): Awaiting => ({
    short: 'a PR number this task never recorded',
    clause: 'This phase is waiting for a PR number that was never recorded for this task, ' +
      `${consequence} The rewind is what produces one: \`${hpipe} rewind ` +
      `${run.run_id} implement --task ${task?.task_id}\`.`,
  })
```

called as `missingPr('so CI is never polled for it.')` and `missingPr('so no merge is ever seen.')`.
In the test, fold the two into one loop over `['ci', 'merge'] as const` with the existing label idiom.
Both are inside declared files and neither changes a rendered string.

---

## MINOR 3 — two assertions inside phase loops do not say which phase failed

**Where.** `test/stall.test.ts:638` and `:656`.

**Problem.** Both sit inside `for (const phase of ['ci', 'merge', 'close', 'teardown', 'escalated'])`,
and both are unlabelled while their immediate neighbours in the same loop body are labelled:

```ts
    expect(out, `${phase} produced no candidate`).toHaveLength(1)
    expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)                       // :638 — unlabelled
    expect(out[0]?.escalatable, `${phase} must not be escalatable`).toBe(false)
```

```ts
    expect(task.phase, `${phase} left its row`).toBe(phase)
    expect(stallStateFor(run, task).probes).toBeGreaterThan(3)           // :656 — unlabelled
```

If `:638` fails the output is `expected "w7:p1" to be "w1:p1"` with no indication that it was the
`escalated` row — and `escalated` is precisely the row whose `probeTarget` is the thing under test, so
this is the assertion most likely to fail and the one that hides the most. `:656` fails as
`expected 0 to be greater than 3` with five candidates for the culprit. The repo's convention is
already unambiguous here: `table.test.ts:34-35`, `phases.test.ts:71` and `stall.test.ts:545` all label,
and so do the three labelled assertions surrounding these two.

**Concrete fix.** Add the message argument the neighbours already carry:

```ts
    expect(out[0]?.paneId, `${phase} is not probed via the orchestrator`).toBe(ORCHESTRATOR_PANE)
```
```ts
    expect(stallStateFor(run, task).probes, `${phase} stopped probing`).toBeGreaterThan(3)
```

---

## MINOR 4 — a load-bearing line that reads as redundant carries no *why*

**Where.** `test/stall.test.ts:663-664`:

```ts
  const run = runWithTask({ phase: 'merge', phase_entered_at: 0, pr: 42 })
  run.phase_entered_at = 0
```

**Problem.** The second line looks like a restatement of the `phase_entered_at: 0` already passed to
`runWithTask` and invites deletion. It is not redundant: `runWithTask` builds on `runAt('execute',
LONG_AGO)`, and `stallStateFor` anchors at `Math.max(record.phase_entered_at, run.phase_entered_at)`
(`stall.ts:121`). Without it the run's `LONG_AGO` dominates, the anchor sits past the loop's whole
297-minute window, and `probesAtMinute` comes back `[]` — the test's exact assertion silently stops
testing the replay. This is the kind of constraint `.claude/agents/plugin-dev.md:32-34` reserves
comments for, and the file comments far less surprising things than this (`:59-60`, `:339-340`,
`:419-420`, `:487-490`).

**Concrete fix.**

```ts
  // stallStateFor anchors at max(task, run) (stall.ts:121), so the run's own entry has
  // to be zeroed too or the first rung is never due inside this window.
  run.phase_entered_at = 0
```

---

## MINOR 5 — `toContain('already')` is too weak to pin the caveat it is guarding

**Where.** `test/stall.test.ts:771` (and, less acutely, `:748`).

**Problem.** The `close` test is named *"does not assert it is still open"*, and its whole subject is
the already-closed deadlock the plan review's MAJOR 1 widened the clause for. The assertion that pins
it is:

```ts
  expect(a.clause).toContain('already')
```

`already` is a five-letter word that could survive any rewrite of that sentence. Delete *"If it is
already closed, this phase cannot see it"* and leave one stray `already` anywhere in the paragraph and
this stays green, while the clause goes back to the narrow form the plan review rejected. The merge
test at `:748` has the same assertion but is rescued by `toContain('postdates')` alongside it, which
is specific; the close test has no such partner — `closing keyword` pins a different sentence.

I note this was prescribed (`issue-19-plan-review-0.md`, MAJOR 1), so the fix is to strengthen it, not
to remove it.

**Concrete fix.**

```ts
  expect(a.clause).toContain('already closed, this phase cannot see it')
```

which is the substring the accepted fix actually introduced.

---

## Checks that passed

These were looked at specifically and are not findings.

- **`sentence()` vs full `Awaiting` literals.** All four new branches build full literals and none
  calls `sentence()`. That is the file's rule, not a deviation: `sentence()` is used only where the
  clause is exactly `This phase is waiting for <short>.`, and the pre-existing branches that need more
  — `files` (`:273-278`), `worktree` (`:280-289`), `gate` (`:290-295`) and the artifact path arm
  (`:203-210`) — all write the literal out. Every new clause carries a second and third sentence, so
  none qualifies. The near-miss is `closed` (`:264-271`), whose first sentence is literally
  `This phase is waiting for ${short}.`; composing it as `` `${sentence(short).clause} Check it with…` ``
  would be novel in this file, so writing it out is the consistent choice.
- **Where `hpipe` is interpolated.** Every new use is `${hpipe}` inside a template literal in a VALUE,
  never a `{{hpipe}}` token — which is what the docblock at `:160-162` requires, and what
  `not.toContain('{{')` at `:699`, `:736` and `:760` pins. `gh pr checks` and `gh issue view` are
  correctly *not* routed through `hpipe`; they are real `gh` invocations, matching `status.ts`.
- **The rewind sentence mirrors an existing one rather than inventing a shape.** `stall.ts:174-182`
  reproduces `src/lib/status.ts:25` — the same `rewind <run> <phase> --task <id>` ordering and the same
  `?? '<phase>'` fallback for a missing `escalated_from`. That is reuse, not a second way.
- **Branch placement and ordering.** The four new branches are inserted between `pr` and `files`, which
  keeps `stallAwaiting` in the same order as `Signal` (`phases.ts:6-8`) and as the phase table itself.
  The `row.actor === 'human'` test is the one branch keyed on something other than `row.signal`, and it
  has to be first; the docblock at `:154-159` was rewritten to say so rather than leaving it as a trap.
- **The hand-rolled clock loop is not a gratuitous second idiom.** At `:644-654` (20 rounds, must never
  escalate) and `:651-655`/`:668-670` (the minute-by-minute 4h57m replay) elapsed time *is* the subject,
  and the file's usual route to escalation — seeding `task.stall = { …, probes: 3 }` and calling
  `applyStalls` once — cannot express either. The loop idiom is also pre-existing in this file at
  `:338-358`. Its third use at `:787-804` is the marginal one, since escalation there is reachable in a
  single call, but it buys not hand-constructing a `StallState` literal that could drift from
  `stallStateFor`'s shape, and it is a wash rather than a defect.
- **The `rollUpBucket` assertion's home.** `test/stall.test.ts:719-724` tests `src/lib/gh.ts`, and its
  four siblings live in `test/gh.test.ts:13-25`, which reads against the "one file per lib module"
  shape in `.claude/agents/plugin-dev.md:22`. This is a recorded decision, not an oversight:
  `issue-19-plan-review-0.md:138-141` weighed it and placed it here because `test/gh.test.ts` is
  outside this task's declared `--files` and taking it would collide with a sibling. Given that
  constraint the placement is right, and the comment at `:720-722` explains why it is there.
- **Comments carry a *why*, in both source and tests.** I read all fifteen added comments against
  `.claude/agents/plugin-dev.md:32-34`. None restates its next line. `phases.ts:118-121` records a
  measured fact and closes with `Measured on a live run.`, matching the convention exactly;
  `stall.ts:228-229`, `:238-239`, `:248-250` and `:260-263` each name a specific mechanism and the
  false sentence it rules out; `table.test.ts:79-82` and `phases.test.ts:69-70` explain why a test
  that asserts an absence is worth having. The historical register of `stall.ts:158-159`
  (*"#19 found that the hard way"*) is the established house voice, not narration —
  `stall.test.ts:339-340` (*"The pass-1 blocker"*) and `:40-41` (*"v4's third review round"*) do the
  same thing.
- **Nothing dead, nothing commented out.** No orphan symbol, no `stallAwaiting` branch made
  unreachable by the reorder (`blocked-on-decision` still lands on `manual` at `:279`, pinned at
  `:702-706`), no leftover. The `task === null` arm of the human branch is unreachable today — the run
  `escalated` row is not stallable and is `releasesPane: true` — but every other branch in the function
  handles both arms the same way, so it is symmetry, not dross.
- **Assertions are behavioural.** The new tests drive the real `taskStallCandidates`, `applyStalls` and
  `stallAwaiting` rather than re-reading the table, and the strongest of them are exact:
  `expect(probesAtMinute).toEqual([45, 90, 135, 180, 225, 270])` (`:675`) and
  `expect(seen).toEqual(['implement|a pushed PR for feat/x (#1)'])` (`:802`). The negative prose
  assertions each have a positive partner, and `sendEscalation: async () => { throw … }` (`:648`) makes
  the never-escalates claim fail loudly rather than pass by omission.
- **Fixtures are reused, not rebuilt.** Every new test goes through `runWithTask` / `runWithTasks` /
  `mkTask` / `mkDeps` and the `NOW` / `LONG_AGO` / `ORCHESTRATOR_PANE` constants. No new fixture, no
  new helper, no inlined `Task` literal.
- **`test/integration/smoke.md` matches its file's register.** Bold lead-in, `§4c` cross-reference in
  the style the file already uses at `:443` and `:468`, `TASK_STALL_MINUTES` named as the real config
  key (`config.ts:9`), and "nine rows" / "those five rows" agreeing exactly with what
  `phases.test.ts:59-65` asserts.

None of the five findings reverses a decision, changes scope, or needs a judgement only the human can
make. All are confined to the two test files already declared for this task, and none alters a string
an agent is rendered.

MAJORS: 0
MINORS: 5

VERDICT: CLEAR
