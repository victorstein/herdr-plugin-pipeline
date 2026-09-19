# Adversarial spec review — issue #19, pass 0

Target: `docs/superpowers/specs/2026-09-18-issue-19-design.md` at `f5639af`, reviewed against
`gh issue view 19`, `docs/superpowers/research/2026-09-18-issue-19-research.md`, the cited text of
#13 / #14 / #15 / #21 / #24 / #25 / #32, and `docs/superpowers/specs/2026-09-17-issue-15-design.md`.
No prior review exists (`ls docs/superpowers/reviews/ | grep 19` → nothing), so spec:3-4 is accurate
and this is pass 0.

## Baseline, re-verified independently in this worktree

```
$ bun test          → 454 pass, 0 fail, 1072 expect() calls, 34 files [8.32s]
$ bun run typecheck → $ tsc --noEmit   (no output, exit 0)
```

spec:16-17 is accurate (it attributes the baseline to `839dde1`; it still holds at `f5639af`).

## Computed values, recomputed against the real table rather than read

The spec's two pinned sets and its measured simulation were re-derived by mutating `TASK_ROWS` in
memory and driving the shipped `taskStallCandidates` + `applyStalls`, from a script under the
session scratchpad (the worktree was not touched):

```
stallable sorted: ["blocked-on-decision","blocked-on-files","ci","close","escalated","implement",
                   "merge","plan","plan-review","pr-review-intent","pr-review-quality","research",
                   "spec","spec-review","teardown"]     count: 15
probeOnly:  ["dispatch","execute","blocked-on-files","ci","merge","close","teardown",
             "blocked-on-decision","escalated"]          9
escalating: ["branch-review","research","spec","spec-review","plan","plan-review","implement",
             "pr-review-intent","pr-review-quality"]     9
total stallable: 18

probes over a 4h57m merge park: 6 at minutes [ 45, 90, 135, 180, 225, 270 ]
final phase: merge stall state: {"at":0,"run_at":0,"last_probe_at":16200000,"probes":6,"holds":0}
```

Every one of those matches spec:485-491, spec:497-498, spec:501 and spec:255-256 **exactly**,
including the stall-state JSON byte for byte. No off-by-one, no mis-sort, no arithmetic error.

## The design was applied end to end before review

`phases.ts`, `stall.ts` (all four A6 branches verbatim from spec:289-349), the two pinned sets and
the A9 guard were applied to a scratch copy of the tree. Result: `tsc --noEmit` clean, **455 pass /
0 fail**, and every clause in spec:512-535 renders as promised with no `{{` (including the two
`pr === null` deadlock sentences, the `<phase>` fallback, and `blocked-on-decision` still returning
`'an answer to the open decision'` after the reorder). The design is implementable as written and
the A6 ordering argument holds. Every `file:line` I spot-checked in `phases.ts`, `stall.ts`,
`main.ts`, `tick.ts`, `tasks.ts`, `ci.ts`, `teardown.ts`, `machine.ts`, `gating.ts`, `status.ts`,
`render.ts`, `gh.ts`, `config.ts`, `herdr.ts`, the four test files, `smoke.md` and the three quoted
prompts resolved to what the spec says is there.

The findings below are what survived that.

---

## BLOCKER 1 — A10 is wrong on both halves: `smoke.md` is outside this task's declared holdings, *and* §4c is not the only site that goes stale

**Claim.** spec:44 lists `test/integration/smoke.md` in the Files table as "§4c only (`:351-364`)".
spec:577-579: *"**Only §4c is edited** — the recovery table (`:530-534`) needs no change… No
ownership ruling covers `smoke.md` in this batch and #21's declared files do not include it."*

**Problem, part 1 — the boundary argument checks the wrong side of the gate.** The spec establishes
only that the *sibling* does not hold `smoke.md`. It never states that **this task does not hold it
either**. Read from the live ledger, not from a summary:

```
/Volumes/stein/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/
  herdr-plugin-pipeline-20260918-fix-run-resolution-and-the-last-mile-v0qh.json

t1 #21 plan         files = ["src/cli.ts","src/lib/ledger.ts","test/cli.test.ts",
                             "test/cli-commands.test.ts","test/cli-argv.test.ts","test/ledger.test.ts"]
t2 #19 spec-review  files = ["src/lib/phases.ts","src/supervisor/stall.ts",
                             "test/phases.test.ts","test/stall.test.ts"]
```

Four declared files; the spec's table names six. `.claude/agents/plugin-dev.md:9-10` states the rule
this repo runs on — *"`--files` on the task, not the surface, is what keeps you off a sibling's
files"* — and #25's issue text records the limitation precisely: *"the file lock protects only files
someone thought to claim."* (spec:33-35 also misstates #21's holdings: `test/ledger.test.ts` is in
them and is not listed.)

**Problem, part 2 — §4c is not the only stale site, and the one the spec missed names #19 by
number.** `test/integration/smoke.md:199-204`, added to `main` by the batch-2 branch review in
`6605241`:

```
- **A digest may end with an `also waiting on you:` footer** listing tasks that produced no event at
  all — a task parked in `merge`, `close` or `blocked-on-decision` emits nothing, so the footer is
  the only thing that reports it. … note
  that a task parked in an orchestrator-owned row is reported **only** on ticks that already produce
  a digest; a genuinely quiet window shows nothing. That residual gap is issue #19, not a defect
  here.
```

The moment this change ships, *"the footer is the only thing that reports it"* and *"a genuinely
quiet window shows nothing"* are both false, and *"that residual gap is issue #19"* points an
operator at a closed issue. This is the identical defect class the spec correctly identifies at
`:359-361`, in the same file, missed.

**Why this is a BLOCKER and not an inline MAJOR.** The two halves are coupled: the fix for part 2
requires owning the file that part 1 shows is not declared, and this repo has already escalated the
`smoke.md` ownership question to a human once. #13's ruling resolved the identical situation the
other way: *"**#13:** do not edit `test/integration/smoke.md`. If your change leaves the digest prose
at `:164-165` stale, record that in your Non-goals naming this ruling… The staleness #13 leaves
behind is not being dropped — it is deferred to this run's `branch-review` phase."* That is exactly
what `6605241` then did. The spec dismisses the precedent in one clause (*"No ownership ruling covers
`smoke.md` in this batch"*) without engaging the mechanism the ruling established, and half-applies
the alternative. Which way this goes is a scope call the human has made before.

**Concrete fix — pick one and say so:**

- **(a) Defer, per #13's precedent.** Drop `smoke.md` from the Files table, add it to **Never
  edited**, and add a Non-goal naming both stale sites — `:359-361` *and* `:199-204` — for repair at
  `branch-review`. This keeps the change inside the four declared files.
- **(b) Own it.** Keep the edit, but say in the spec that `smoke.md` is **outside this task's
  declared `files`**, cite #25's "protects only files someone thought to claim" as the reason the
  gate will not catch it, confirm no sibling holds it, and extend A10 to cover `:199-204` as well as
  §4c.

Either is defensible; the spec currently does neither.

---

## MAJOR 1 — a fourth test must fail before the change, and the spec's must-fail list names three

**Claim.** spec:479-508 enumerates the tests that must fail first: `phases.test.ts:49-56`,
`phases.test.ts:58-62`, `stall.test.ts:307-315`. spec:544-548 then asserts everything else is
*"Unchanged by construction"*, closing with *"If any of these does fail, that is a finding, not a
test to patch."*

**Problem.** There is a fourth. `test/stall.test.ts:109-114`:

```ts
test('a task phase whose row is not stallable is never probed', () => {
  for (const phase of ['queued', 'ci', 'merge', 'close', 'teardown', 'done'] as const) {
    const run = runWithTasks([mkTask({ phase })])
    expect(taskStallCandidates([run], NOW, 45, 3)).toHaveLength(0)
  }
})
```

Four of the five rows A1 makes stallable are in that loop. Applying A1 to a scratch copy of the tree
produces exactly four failures, not three:

```
(fail) the stallable set is exactly what #15 assumed — widening it belongs to #19
(fail) exactly the four probe-only rows are outside the escalating signals
(fail) a task phase whose row is not stallable is never probed     ← not in the spec
(fail) an unrecognised signal falls back to naming the phase
```

The spec's own `grep -rn "stallable" test/` (spec:546) does hit this file — it just stops at three
named tests inside it. The consequence is not cosmetic: the "that is a finding, not a test to patch"
rule means an implementer following the spec literally is told to treat a legitimately-expected
failure as a defect.

**Concrete fix.** Add a fourth bullet to spec:479-508: `test/stall.test.ts:109-114` narrows to the
rows that stay unstallable — `['queued', 'done']` (optionally plus `'failed'`, `'orphaned'`,
`'blocked-on-failure'`, which it never covered). Verified: with that edit plus the three the spec
names plus the A9 guard, the suite is **455 pass / 0 fail**, `tsc --noEmit` clean.

---

## MAJOR 2 — P4's "two ways" is not exhaustive, and the third way makes the new `teardown` clause say something false

**Claim.** spec:102-105: *"The two ways a `teardown` can sit without a fault both already produce no
candidate, so the row is self-consistent"* — no `orchestrator_pane`, and a `releasesPane` run. On
that basis A6 ships (spec:345-348):

> `'unconditional and runs first in every tick, so a task still here means the tick is '` +
> `"throwing before it — check the supervisor pane's log."`

**Problem.** `pickOneAdvance` has **three** skips, not two (`src/supervisor/tick.ts:237-248`):

```ts
for (const run of runs) {
  if (runRow(run.phase).releasesPane === true) continue   // :241
  const pane = run.orchestrator_pane
  if (!pane || seen.has(pane)) continue                   // :243
  seen.add(pane)
```

The spec cites `:241-243` but reads only two of the three conditions. `seen.has(pane)` — a second run
whose orchestrator pane is already claimed by an earlier run in the same tick — is skipped from
`advancing` (`main.ts:147`), so `advanceTasks` and therefore `runTeardown` (`main.ts:185` →
`tasks.ts:137`) never run for it. Unlike the other two, that run has a **non-null**
`orchestrator_pane` and a **non-`releasesPane`** phase, so it passes A26 (`stall.ts:98`) and
`candidateFor:56` and **does** produce a candidate. Nothing is throwing; the probe would tell the
orchestrator it is.

Reachable: `cmdStart` refuses a second run only per `repo_key` (`src/cli.ts:30-34`), so two live runs
in different repos started from the same pane share an `orchestrator_pane` — the state
`pickOneAdvance`'s own docstring is written about, and the multi-run-per-session world #21 was filed
over. It is uncommon, not hypothetical.

This is precisely the defect the spec makes P2 out of ("one has something false to say"): a probe
that asserts a diagnosis it cannot support is worse than the `:218` fallback it replaces.

**Concrete fix.** Either complete P4's enumeration and soften the clause to something true of all
three cases — e.g. *"Teardown is unconditional and runs first in every tick, so a task still here
means this run is not being advanced: check the supervisor pane's log, and check whether another run
holds this orchestrator pane"* — or keep the strong sentence and add the third case to P4 with the
reason it cannot occur (I could not construct one).

---

## MAJOR 3 — `test/table.test.ts` is also outside the declared holdings, and the spec already offers the cheapest fix

**Claim.** spec:42 puts `test/table.test.ts` in the Files table for the A9 guard; spec:392-393 says
*"This is the one piece of the change that is not strictly required by the issue. It is called out
here so a reviewer can cut it on its own."*

**Problem.** Same evidence as BLOCKER 1: t2's declared `files` are `["src/lib/phases.ts",
"src/supervisor/stall.ts", "test/phases.test.ts", "test/stall.test.ts"]`. `test/table.test.ts` is not
among them. Unlike `smoke.md` this needs no ruling, because the spec itself marks the guard as
optional and the guard's subject is a `TASK_ROWS` invariant.

**Concrete fix.** Move the A9 guard into `test/phases.test.ts` — which *is* declared, already imports
`TASK_ROWS`, and already houses the two `TASK_ROWS`-shaped pinned sets the guard sits beside
conceptually — or cut it, as spec:392-393 invites. Verified: the guard passes unchanged from
`phases.test.ts` (it needs only the existing `TASK_ROWS` import).

---

## MINOR 1 — P1 overstates the `hpipe status` gap, and its own research note has it right

spec:59-60: *"`taskWarnings:17-67` has no case for any of these five."* False for one of the five:
`src/lib/status.ts:21-27` emits `⚠ <task> escalated from <phase> … needs a human; hpipe rewind …`
for exactly the task `escalated` row. The research note states it correctly (research:39: *"Covers
`escalated`, open decisions, undelivered answers, `blocked-on-files` — and **nothing** for
`ci`/`merge`/`close`/`teardown`"*), so the spec regressed its own evidence. The same sentence's
*"a line identical to every other"* is also loose: `status.ts:138-139` appends `PR #n` and `ci:<b>`,
which a parked `merge` line carries. Neither changes a decision — A5's push-vs-pull argument
survives, since the warning is pull-only — but the Problem section should not overclaim.
**Fix:** restate as "no case for `ci`/`merge`/`close`/`teardown`; the `escalated` case exists but is
pull-only".

## MINOR 2 — the characterisation test A14 proposes cannot be written as described

spec:505: *"Rewritten against a synthetic row."* `stallAwaiting` (`stall.ts:161-162`) takes
`(run, task, hpipe)` and derives the row itself via `taskRow(task.phase)`; there is no row seam, and
`taskRow` **throws** on an unknown phase (`phases.ts:147`). After A6 no task phase reaches `:218`
either — every `TASK_ROWS` signal has a branch. **Fix:** write it at the run level, which is the only
reachable `:218` producer and is what the spec's own "only `registration` can reach it" (spec:470)
implies: `stallAwaiting(runAt('intake', LONG_AGO), null, 'hp')` → `whatever clears intake`. Verified
green.

## MINOR 3 — the two-ladders-at-once row's precondition is wrong

spec:469: *"Possible only while intake is open (`phases.ts:58-59`)."* Not only. `SETTLED`
(`teardown.ts:12-15`) includes `escalated`, `tasksAllTerminal` is computed from it
(`deliver.ts:193`), and `machine.ts:69-72` therefore moves a run with an escalated task to
`branch-review` once intake **is** closed. `branch-review` is stallable at `STALL_MINUTES` (15) and
is not `releasesPane`, so A26 does not skip its tasks: run ladder at 15m plus task `escalated` ladder
at 45m, both into `run.orchestrator_pane`, with intake closed. The accepted-as-noise ruling is
unaffected; the stated precondition is not. **Fix:** add the `branch-review` case to that row.

## MINOR 4 — A13's deadlock clause names no exit, though one exists and A12 requires it

A12 (spec:162) and the Goal (spec:119-123) both promise *"the command that resolves it"* where there
is one. Rendered, the two deadlock clauses are:

```
This phase is waiting for a PR number this task never recorded, so CI is never polled.
This phase is waiting for a PR number this task never recorded, so no merge is ever seen.
```

Both describe a **permanent** deadlock (P3) and name nothing to do about it, so the orchestrator
receives the same dead-end sentence every 45 minutes forever. An exit does exist — the same one the
human-owned branch already prints — `{{hpipe}} rewind <run_id> implement --task <id>`, which returns
the task to the row that produces a `pr`. **Fix:** append it to both clauses, rendering `hpipe` the
way the A6 human branch does. (The phrasing also reads awkwardly through `sentence()`: "waiting for
a PR number …, so CI is never polled". Worth composing these two as full `Awaiting` literals rather
than through the helper.)

## MINOR 5 — the ordering-invariant test does not exercise the invariant it names

spec:532-533: *"`stallAwaiting` called with a task still in `merge` (the state `escalate` renders in,
`stall.ts:293-295`) returns the merge clause, not the human-owned one."* A `merge` row has
`escalatable === false` (A2), so `escalate` never renders in that state and the assertion is vacuous
with respect to escalation. The invariant that matters is for an **escalatable** row. **Fix:** assert
it on `implement` driven through `applyStalls` past `probeMax`, checking the `from` handed to
`escalationText` and the `awaiting_short` it renders.

## MINOR 6 — a wrong line cite on #15's spec, inherited from the research note

spec:39 cites *"#15's spec `:48`"* for routing `phases.ts` here. `:48` is mid-sentence inside the
`#25` quotation. The routing is at **`:46`** — *"`phases.ts` → **#19**"*. research:186 has the same
slip. `:138` is correct.

---

## What is right, and worth saying

- **A2 is argued correctly and I could not break it.** `ESCALATING_SIGNALS` (`stall.ts:22`) excludes
  all five signals, `candidateFor:63,67` therefore never yields `'escalate'`, `applyStalls`'
  escalate arm (`:271-281`) is unreachable, and nothing enters `TERMINAL_BAD` (`gating.ts:6-8`). The
  measured 6-probe park reproduces byte-identically. The blast-radius concern genuinely does not
  bite.
- **A3's asymmetry is correct.** `table.test.ts:33` computes `hasPane` from `actor` only, which is
  false for `ci`, `teardown` and `escalated` and true for `merge` and `close`; the whole suite is
  green with `probeTarget` on exactly the three the spec names.
- **A6's ordering argument holds under test.** With the human branch first, `blocked-on-decision`
  still returns `'an answer to the open decision'` (pinning `stall.test.ts:303`) and `teardown`'s
  `short` stays byte-identical (pinning `:304`), exactly as claimed.
- **A11 is right about the prompt boundary.** `test/prompts.test.ts:68-76` scans prompt *files*, so a
  clause composed in TypeScript is outside it; `renderPrompt` injects `hpipe` centrally
  (`render.ts:40-47`), so nothing ships a `{{hpipe}}`.
- **The ledger-drift section is verifiable and verified.** `grep -rn "stallable\|probeTarget\|
  stallWhen" src` returns only `phases.ts` declarations and `stall.ts:14`, `:82-83`, `:101`. Nothing
  is serialised; `schema_version: 2` is the right call, and the self-hosting hazard is named.
- **Correcting the false comment at `stall.ts:154-158` in the same hunk** is the right instinct and
  the one that would otherwise have propagated the bug.

The design is sound. The BLOCKER is an ownership and coverage question about one file, not a defect
in the mechanism; the three MAJORs are a missed test, a non-exhaustive claim that produces one false
sentence, and a second undeclared file with a one-line home.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 3
