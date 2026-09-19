# Design — issue #19: the last mile is not stallable

Revision after **pass 0**'s spec review
(`docs/superpowers/reviews/issue-19-spec-review-0.md`, VERDICT: BLOCKER — 1 BLOCKER / 3 MAJORs /
6 MINORs) and the **Ownership ruling — `test/integration/smoke.md`, 2026-09-19** now at the bottom of
`gh issue view 19`. Every finding is accepted; nothing is partially applied. What changed and why is
the next section.

Builds on `docs/superpowers/research/2026-09-18-issue-19-research.md`.

**Modelled on `docs/superpowers/specs/2026-09-17-issue-15-design.md`** — the immediately preceding
design for this same subsystem, which built the ladder this issue widens. Its opening *What changed*
table, section order, labelled-assumption table, failure table and "live verification is not
optional" clause are reproduced deliberately. Departures are named.

Baseline re-verified at `4d133b4`: `bun test` → **454 pass / 0 fail**, 34 files; `bun run typecheck`
→ clean. The reviewer re-ran both independently and got the same (review `:9-17`).

---

## What changed, by finding

| Finding | Disposition |
| --- | --- |
| **BLOCKER 1** — A10 checked only the *sibling's* side of the file gate, and `smoke.md:199-204` is a second stale site the spec missed | **Accepted, fixed per the ruling, option (b).** `smoke.md` is this task's for this batch. Both sites are covered (**A10**), and the out-of-declaration position is stated outright with #37 as the reason the gate cannot catch it (**A16**). |
| **MAJOR 1** — a fourth test must fail before the change; the spec named three | **Accepted.** `test/stall.test.ts:109-114` added to the must-fail list with its exact new value. Verified: its loop contains four of the five rows **A1** changes. |
| **MAJOR 2** — P4's "two ways" misses `pickOneAdvance`'s third skip, so the proposed `teardown` clause asserts a diagnosis it cannot support | **Accepted.** P4 now enumerates all three skips; the clause is rewritten to a statement true of every case. This was the spec committing its own **P2**. |
| **MAJOR 3** — `test/table.test.ts` is also outside the declared holdings | **Accepted.** The ruling directs the same treatment as `smoke.md`: keep it, declare it (**A16**). The guard stays in `table.test.ts`, which is where this repo keeps `PhaseRow` invariants. |
| **MINOR 1** — P1 overstated the `hpipe status` gap; the research note had it right | **Accepted.** P1 restated: no case for `ci`/`merge`/`close`/`teardown`; the `escalated` case exists (`status.ts:21-27`) but is pull-only. |
| **MINOR 2** — the A14 characterisation test cannot be written as described | **Accepted.** `taskRow` throws on an unknown phase (`phases.ts:147`) and after **A6** no task signal reaches the fallback, so the test moves to the run level (`intake`, signal `registration`). |
| **MINOR 3** — the two-ladders-at-once precondition is wrong | **Accepted.** `SETTLED` includes `escalated` (`teardown.ts:12-15`), so `branch-review` is the other case. Error table corrected. |
| **MINOR 4** — the deadlock clauses name no exit, though **A12** promises one | **Accepted.** Both now render `rewind … implement --task …` and are composed as full `Awaiting` literals rather than through `sentence()`. |
| **MINOR 5** — the ordering-invariant test is vacuous on a non-escalatable row | **Accepted.** Re-specified against `implement` driven through `applyStalls` past the cap. |
| **MINOR 6** — wrong cite, `#15's spec :48` for `:46` | **Accepted.** Corrected here; the research note carries the same slip at `research:186` and is left as the historical record. |
| — | **Also corrected per the ruling:** #21's holdings include `test/ledger.test.ts`, which the pass-0 Files section omitted. |

**What the review confirmed, and what is therefore not re-litigated.** The reviewer re-derived both
pinned sets, the probe-only ordering and the 4h57m simulation from the real table and got
15 / 9 / 9 / 18 and `[45, 90, 135, 180, 225, 270]` with the stall-state JSON byte-identical
(review `:20-38`); it then applied the whole design to a scratch tree and got **455 pass / 0 fail**,
`tsc --noEmit` clean, with every **A6** clause rendering as promised (review `:41-52`). **A2** was
attacked and held. Those numbers are carried forward unchanged.

---

## Scope

**In scope:** `stallable` on the five last-mile rows; the `probeTarget` each needs to satisfy
`table.test.ts:30-37`; the `stallAwaiting` branches those rows require; the pinned-set tests; a guard
for the dead `stallWhen` field; both stale sites in `test/integration/smoke.md`.

**Out:** `hpipe status` (**#14**, which claims *"PRs parked in `merge` awaiting a human"* verbatim);
widening `ESCALATING_SIGNALS` (**NG1**); bounding probe sends (**#25**); the undeliverable-probe rung
(**#32**); the digest footer (**#13**, shipped); amending a task's holdings (**#37**).

### Files, and the two that are outside this task's declared holdings

Read from the live ledger rather than from any summary —
`~/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/herdr-plugin-pipeline-20260918-fix-run-resolution-and-the-last-mile-v0qh.json`:

```
t1 #21 plan-review  files = ["src/cli.ts","src/lib/ledger.ts","test/cli.test.ts",
                             "test/cli-commands.test.ts","test/cli-argv.test.ts","test/ledger.test.ts"]
t2 #19 spec         files = ["src/lib/phases.ts","src/supervisor/stall.ts",
                             "test/phases.test.ts","test/stall.test.ts"]
```

| File | Change | Declared by t2? |
| --- | --- | --- |
| `src/lib/phases.ts` | five rows gain `stallable`, three gain `probeTarget` | **yes** |
| `src/supervisor/stall.ts` | `stallAwaiting` gains four branches; the false comment at `:154-158` is corrected | **yes** |
| `test/phases.test.ts` | the two pinned sets | **yes** |
| `test/stall.test.ts` | new coverage; two existing tests narrowed | **yes** |
| `test/integration/smoke.md` | two stale sites (**A10**) | **no — see A16** |
| `test/table.test.ts` | the **A9** guard | **no — see A16** |

**Never edited:** `src/cli.ts`, `src/lib/ledger.ts`, `test/ledger.test.ts` and the cli tests (all
t1's); `src/lib/status.ts` (#14); `src/supervisor/tick.ts` (#13, shipped); `src/lib/machine.ts`;
`src/lib/config.ts`; `prompts/*`.

---

## Problem

### P1 — five rows are unreachable by the ladder, and they are the ones that wait on people

`taskStallCandidates` gates on one boolean — `if (!row.stallable) continue` (`stall.ts:101`) — and
`ci`, `merge`, `close`, `teardown` (`phases.ts:118-124`) and the task `escalated` row
(`phases.ts:130-131`) do not carry it. A task that reaches `merge` therefore produces no probe and no
escalation.

**Corrected per MINOR 1.** `taskWarnings` (`status.ts:17-67`) has no case for `ci`, `merge`, `close`
or `teardown`; it *does* warn on an escalated task (`status.ts:21-27`). That warning is **pull-only**
— it appears when a human runs `hpipe status`, which is exactly what a quiet window means nobody is
doing. The parked line itself carries `PR #n` and `ci:<bucket>` when set (`status.ts:138-139`), so it
is not literally identical to every other line; what it lacks is any indication that it has stopped.

Measured on the berean-os run of 2026-09-16 and quoted in #13's Scope ruling: t3 sat in `merge` for
**4h57m**, of which **3h55m (79%)** fell inside a zero-transition window; two such windows covered
**86%** of the run's 20h02m span. #13's footer (`tick.ts:119-139`) reports parked tasks only on ticks
that already emit a digest — `tick.ts:113-117` says so in the code — which on that run was about one
hour of the 4h57m. The ruling names this issue as where the remaining gap closes.

### P2 — three of the five have nothing true to say, and one has something false to say

Executed against the shipped `stallAwaiting` (research §4, verbatim output):

```
ci        → "This phase is waiting for whatever clears ci."
merge     → "This phase is waiting for whatever clears merge."
close     → "This phase is waiting for whatever clears close."
escalated → "This phase is waiting for an answer to the open decision."
```

The first three are the `:218` fallback. The fourth is the `:204` `manual` branch, which `escalated`
shares with `blocked-on-decision` — an escalated task would be probed about a decision it never
asked. The comment at `stall.ts:154-158` claims *"Keyed on `row.signal` … so #19 making more rows
stallable needs no change here."* **That claim is false and this issue disproves it.**

### P3 — two of the five can never clear at all, and nothing says so

- `ciTransitions` skips a `ci` row whose `task.pr === null` (`ci.ts:12`), so CI is never polled and
  the row cannot advance.
- `gatherSignals`' `merge` case returns `base` when `task.pr === null` (`tasks.ts:278`), so
  `s.merged` is never true and `machine.ts:165-171` never fires.

Both are permanent deadlocks that today look exactly like a slow CI run or an unhurried human.

### P4 — a parked `teardown` means the run is not being advanced

**Rewritten per MAJOR 2. The pass-0 text claimed two causes; there are three, and the third is the
one that makes the strong claim false.**

`runTeardown` (`teardown.ts:17-41`) is unconditional and exits the row to `done` or `orphaned` on its
first pass, and it is called *first* in `advanceTasks` (`tasks.ts:137`). `Herdr`'s methods are
documented never to throw (`herdr.ts:32-33`). So a task sitting in `teardown` means `advanceTasks`
is not reaching that run. `pickOneAdvance` (`tick.ts:237-248`) has **three** skips:

| Skip | Line | Produces a stall candidate? |
| --- | --- | --- |
| `runRow(run.phase).releasesPane === true` | `:241` | **No** — A26 rejects it too (`stall.ts:98`) |
| `!pane` | `:243` | **No** — `probePaneFor` yields `null`, `candidateFor:56` rejects it |
| `seen.has(pane)` — a second run whose orchestrator pane an earlier run already claimed this tick | `:243` | **Yes** |

Plus a fourth cause outside `pickOneAdvance`: the per-run `try` at `main.ts:178-245` throwing before
`advanceTasks` (`:185`) — `rebindOrchestrator` (`:179`) or `evaluateRun` (`:182`) — swallowed by the
`catch` at `:243-245`, whose only output is a `console.error` into the supervisor's own pane.

The third skip is reachable: `cmdStart` refuses a second run only per `repo_key`
(`activeRunForRepo`, `cli.ts:30-34`), so two live runs in different repos started from the same pane
share an `orchestrator_pane`. Such a run has a non-null pane and a non-`releasesPane` phase, so it
passes A26 and `candidateFor:56` and **does** produce a candidate while nothing is throwing.

A clause asserting *"the tick is throwing before it"* would therefore be a probe stating a diagnosis
it cannot support — the same defect this spec makes **P2** out of. **A6**'s clause says only that the
run is not being advanced, and names both things to check.

### P5 — `stallWhen` is declared on the table but dead at the task level

`stallCandidates` consults it (`stall.ts:83`); `taskStallCandidates` does not (`:99-104`). Proved by
forcing `stallWhen: () => false` onto `implement` and still getting a candidate (research §5). Its
declared parameter is run-shaped (`phases.ts:39`) with no task argument. This issue does not need it
— but it is the obvious thing for the next person to reach for on exactly these rows, and it would
fail silently.

---

## Goal / Non-goals

**Goal.** No task phase can hold a run at the last mile without something being said on a schedule.
Every one of the five rows is probed every `TASK_STALL_MINUTES`, in the orchestrator's pane, with a
sentence that names what is actually being waited on and — where there is one — the command that
resolves it. No row gains the ability to escalate, so no correctly-parked task can cascade a
dependent to `blocked-on-failure`. The runbook describes the ladder that then exists.

**Non-goals.**

- **NG1 — no row becomes escalatable.** `ESCALATING_SIGNALS` (`stall.ts:22`) is untouched. See **A2**.
- **NG2 — no `hpipe status` change.** #14 owns it and names the `merge` case explicitly; it also
  carries the batch-2 ruling to move `ageMinutes`/`actionFor` into `src/lib/`, which this issue must
  not pre-empt. MINOR 1's `escalated` warning stays exactly as it is.
- **NG3 — no digest/footer change.** `parkedFooter`'s predicate is *whose move is it*
  (`tick.ts:126-129`): `merge`, `close` and `escalated` already qualify; `ci` and `teardown` are
  nobody's move, so the footer is right to omit them and the ladder is the correct channel for them.
  Only the runbook's *description* of the footer changes (**A10**).
- **NG4 — no new config knob.** See **A8**.
- **NG5 — no bound on probe count for these rows.** See **A7**; **#25** owns bounding sends.
- **NG6 — `queued` stays unstallable.** A `queued` task behind a broken dependency is moved to
  `blocked-on-failure` (`gating.ts:34-38`, `tasks.ts:141-146`); behind a live one it is correctly
  waiting, and after this change the holder's own row is what speaks.
- **NG7 — `stallWhen` is not plumbed into `taskStallCandidates`.** See **A9**.
- **NG8 — no schema change.** `schema_version` stays `2`; see **Ledger drift**.
- **NG9 — the `pr === null` deadlocks (P3) are reported, not fixed.** See **A13**.
- **NG10 — #37 is not fixed here.** This change is its third consecutive occurrence and says so
  (**A16**), but amending a task's holdings is that issue's work.

---

## Assumptions

Every behavioural decision, labelled for attack. **A2, A5, A7 and A16** are the load-bearing ones.

| # | Assumption |
| --- | --- |
| A1 | All five rows — `ci`, `merge`, `close`, `teardown`, task `escalated` — become `stallable: true`. |
| A2 | **`ESCALATING_SIGNALS` is not widened.** All five stay probe-only, forever. |
| A3 | `ci`, `teardown` and `escalated` also carry `probeTarget: 'orchestrator'`; `merge` and `close` do not. |
| A4 | The probe cadence is `TASK_STALL_MINUTES` (45), unchanged and shared with every other task row. |
| A5 | The task `escalated` row is stallable, and its probe is addressed to the orchestrator as the human's relay. |
| A6 | `stallAwaiting` gains a `row.actor === 'human'` branch placed **before** the `manual` branch, and three signal branches (`ci`, `merged`, `closed`); the `worktree` task clause is corrected per MAJOR 2. |
| A7 | The standing nudge stays **unbounded** — no cap on `probes` for a non-escalatable row. |
| A8 | No new config key. |
| A9 | `stallWhen` is left dead and guarded by a test in `table.test.ts` asserting no task row carries one. |
| A10 | **Both** stale sites in `test/integration/smoke.md` are rewritten: §4c `:359-361` and the footer bullet `:199-204`. No other section is touched. |
| A11 | `prompts/stall-probe.md` is **not** edited; all new wording lands in `stallAwaiting`'s clause. |
| A12 | A clause names a concrete command wherever one exists, rendering `hpipe` from the already-rendered argument. |
| A13 | The `pr === null` deadlocks (**P3**) are reported by the clause — including their exit — not fixed. |
| A14 | The `:218` fallback branch is kept; its test becomes a **run-level** characterisation test. |
| A15 | `holdsFiles` is unchanged on all five rows. |
| **A16** | **`test/integration/smoke.md` and `test/table.test.ts` are edited although both are outside t2's declared `files`.** Declared openly, not widened silently. |

### A16 — editing two files the gate does not cover

Per the **Ownership ruling of 2026-09-19** on `gh issue view 19`: *"`test/integration/smoke.md`
belongs to #19 for this batch. Take it, and cover both stale sites."*

- **Neither file is declared by t2.** Its `files` are exactly `src/lib/phases.ts`,
  `src/supervisor/stall.ts`, `test/phases.test.ts`, `test/stall.test.ts` — quoted from the live
  ledger in the Files section above.
- **Neither file is held by the sibling.** t1 (#21) holds `src/cli.ts`, `src/lib/ledger.ts`,
  `test/cli.test.ts`, `test/cli-commands.test.ts`, `test/cli-argv.test.ts` and
  `test/ledger.test.ts` — confirmed from the same ledger read. Nothing in #21's brief goes near the
  runbook or the phase-table invariants.
- **The gate cannot catch this, and that is #37.** `filesOverlap` is a prefix check over
  `task.files` (`gating.ts:19-21`), and `task.files` is whatever the orchestrator typed at
  `hpipe task --files` during intake. #37's title states the consequence exactly — *"The file lock
  only protects files declared at intake, before the work that discovers them"* — and its body:
  *"Every file a design discovers later is unprotected, and the gate cannot know it is missing."*
  Neither of these files could have been predicted at registration, because which runbook prose goes
  stale is a finding of the research and of pass 0's review.
- **Why the opposite call to #13's ruling last batch is right.** That ruling deferred `smoke.md`
  precisely because the file was **contested** — #10 held it and was editing it in the same batch,
  and *"a single owner is also the only resolution that actually removes the race."* There is no
  race here. The reasoning that produced deferral does not apply, and the ruling says so.
- **This is #37's third consecutive occurrence.** Recorded, not fixed (**NG10**).

---

## Architecture

### Modelled on

**`blocked-on-files` (`phases.ts:105-106`)** is the structural template and the file to name: the one
shipped row with no actor, a non-escalating signal, `stallable: true` **plus**
`probeTarget: 'orchestrator'`, probed forever and never escalated. Its full obligation set is what a
new probe-only row has to satisfy, and all four parts exist today:

1. the row (`phases.ts:105-106`);
2. a dedicated `stallAwaiting` branch rather than the fallback (`stall.ts:198-203`);
3. membership in both pinned sets (`phases.test.ts:51`, `:62`);
4. a `table.test.ts:30-37` probe target.

**`blocked-on-decision` (`phases.ts:126-129`)** is the behavioural template for **A5** and **A7**: a
row that waits on a *human*, is stallable, is probe-only, and is nudged without bound. It shipped in
#15 and survived three review rounds in that shape.

**`execute` (`phases.ts:56-59`)** is cited only to be declined: it is the sole `stallWhen` user, and
**A9** explains why none of these rows takes one.

### A1, A3 — the rows

**A1** is the issue's first Direction: the five rows named in #19 gain `stallable: true`, and nothing
else about them moves.

```ts
  // #19. Each waits on something outside the pipeline — GitHub, or a person — and
  // none of their signals is escalatable, so each is nudged forever and can never
  // cascade a dependent. t3 sat in `merge` for 4h57m emitting nothing.
  // Measured on a live run.
  { phase: 'ci', signal: 'ci', onClear: 'merge', onBlocker: 'implement',
    counter: 'ci', prompt: 'ci-red', stallable: true, probeTarget: 'orchestrator',
    holdsFiles: true },
  { phase: 'merge', actor: 'orchestrator', signal: 'merged',
    onClear: 'close', prompt: 'merge', stallable: true, holdsFiles: true },
  { phase: 'close', actor: 'orchestrator', signal: 'closed',
    onClear: 'teardown', prompt: 'close', stallable: true, holdsFiles: true },
  // Teardown is unconditional and runs first (tasks.ts:137), so a task still here
  // past the threshold means this run is not being advanced at all.
  { phase: 'teardown', signal: 'worktree', onClear: 'done',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: true },
```

and, further down the table:

```ts
  // probeTarget because a human owns no pane: table.test.ts:33 counts only
  // `orchestrator` and `worker` as resolving to one.
  { phase: 'escalated', actor: 'human', signal: 'manual',
    returnsTo: 'escalated_from', prompt: 'escalate',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: true },
```

**A3's asymmetry is not cosmetic.** `probePaneFor` (`stall.ts:13-17`) returns
`run.orchestrator_pane` for all five regardless — research §4 F3 measured `probePane=w1:p1` for every
one — so `probeTarget` changes no behaviour. It exists because `table.test.ts:33` computes
`hasPane = row.actor === 'orchestrator' || row.actor === 'worker'`, which is false for `ci` and
`teardown` (no actor) and for `escalated` (`actor: 'human'`), and `phases.ts:40` declares the field
*"Required when `actor` resolves to no pane and the row is stallable."* Adding it to `merge` or
`close`, whose actor does resolve, would be noise. The reviewer confirmed the whole suite is green
with `probeTarget` on exactly these three (review `:301-304`).

### A2 — nothing becomes escalatable, and this is what makes the change safe

`ESCALATING_SIGNALS` is `{artifact, verdict, pr}` (`stall.ts:22`). The five rows carry `ci`,
`merged`, `closed`, `worktree` and `manual`. So `escalatable` is `false` for all five
(`candidateFor:63`), `action` is `'probe'` unconditionally (`:67`), and `applyStalls` never reaches
`escalate` (`:263-268`). Consequences, in full:

- no `enterTaskPhase(…, 'escalated')`, so no new `TERMINAL_BAD` member (`gating.ts:6-8`) and no
  dependent cascaded to `blocked-on-failure` (`gating.ts:34-38`);
- no interaction with the deferral gate (`stall.ts:271-279`) — it is only read on the escalate path;
- `ladderFor` returns the standing-nudge sentence (`:227-229`), so no probe promises a bound it does
  not have.

**This is why the brief's "blast radius" concern does not bite.** `merge` and `close` wait on a human
by design; escalating them would move a correctly-parked task into `TERMINAL_BAD` and break its
dependents — which #15's spec `:693` already rejected in general terms. `escalated` would escalate to
itself. `ci` waits on GitHub. `teardown` waits on the supervisor. None of the five has an actor who
could answer a threat.

Measured, driving the real `taskStallCandidates` + `applyStalls` minute-by-minute across t3's actual
4h57m park with `merge` flipped stallable, at shipped defaults (research §4; reproduced
independently by the reviewer, review `:33-36`):

```
probes over a 4h57m merge park: 6 at minutes [ 45, 90, 135, 180, 225, 270 ]
final phase: merge stall state: {"at":0,"run_at":0,"last_probe_at":16200000,"probes":6,"holds":0}
```

Six nudges, no escalation, the task still in `merge`. That is the complete behavioural delta.

### A5 — why the escalated row is probed, and why the orchestrator is the right recipient

The objection is real: an escalated task waits on a person, and probing the orchestrator nags an
agent that cannot resolve it. Three facts answer it.

1. **It is the only push channel that row has in the window that matters.** `hpipe status` is
   pull-only — including its `escalated` warning (MINOR 1). #13's footer rides digests, and a run
   whose only live task is escalated generates no pane events, so it produces no digests at all —
   the 3h55m zero-transition case exactly.
2. **The run-level ladder does not reliably cover it.** With intake open, `execute`'s `stallWhen`
   (`phases.ts:58-59`) needs *every* task settled; with a live sibling it is false. With intake
   closed and all tasks settled, `advanceRun` moves the run out of `execute` (`machine.ts:68-73`).
   Neither state is a dependable substitute for the task's own ladder.
3. **An escalated run's tasks are still excluded.** A26 (`stall.ts:98`) skips every task of a run in
   a `releasesPane` phase, and run `escalated` is one (`phases.ts:70-71`). #15's spec `:293` states
   the rule: *"an escalated run's tasks must not be escalated out from under the human."* Untouched.

The orchestrator is the recipient because `probePaneFor` has nowhere else to send it and because the
orchestrator is the pipeline's relay to the human everywhere else — `escalate.md` and
`stall-escalate.md` are both addressed there, and `stall-escalate.md:6-10` asks it to *"Summarise for
the human."* The clause (**A6**) asks it to do that again, and re-prints the rewind command.

### A6 — `stallAwaiting`, the new branches

`stallAwaiting` keeps its signature (`stall.ts:161`) and its total-function shape. The human-owned
branch goes **first**, because `escalated` and `blocked-on-decision` share `signal: 'manual'` and
order is the only thing that separates them.

```ts
  // A human-owned row waits on a person, not on the pane being probed. Checked
  // before the `manual` branch, which `blocked-on-decision` shares with it and
  // which would otherwise tell an escalated task it is waiting for an answer to a
  // decision it never asked.
  if (row.actor === 'human') {
    const from = (task ? task.escalated_from : run.escalated_from) ?? '<phase>'
    const flag = task ? ` --task ${task.task_id}` : ''
    return {
      short: 'a human to act on the escalation',
      clause: 'This phase is escalated and waits on the human, not on you. If they have not been ' +
        'told, tell them now; once they have decided, ' +
        `\`${hpipe} rewind ${run.run_id} ${from}${flag}\` resumes it.`,
    }
  }
```

```ts
  if (row.signal === 'ci' && task) {
    // `ciTransitions` skips a `ci` row with no PR (ci.ts:12), so that row is never
    // polled and cannot clear — a different fault from a slow CI run, and the
    // probe is the only thing that will ever say so.
    if (task.pr === null) {
      return {
        short: 'a PR number this task never recorded',
        clause: 'This phase can never clear on its own: no PR number was recorded for this task, ' +
          `so CI is never polled for it. \`${hpipe} rewind ${run.run_id} implement ` +
          `--task ${task.task_id}\` sends it back to the row that produces one.`,
      }
    }
    return {
      short: `CI on PR #${task.pr}`,
      clause: `This phase is waiting for CI to report on PR #${task.pr}. Check it with ` +
        `\`gh pr checks ${task.pr}\` — a run that is queued, cancelled or was never triggered ` +
        'reports no conclusion, and this phase waits on it forever.',
    }
  }

  if (row.signal === 'merged' && task) {
    // `gatherSignals` returns early on a null PR (tasks.ts:278), so `merged` is
    // never true and machine.ts:165-171 never fires.
    if (task.pr === null) {
      return {
        short: 'a PR number this task never recorded',
        clause: 'This phase can never clear on its own: no PR number was recorded for this task, ' +
          `so no merge is ever seen. \`${hpipe} rewind ${run.run_id} implement ` +
          `--task ${task.task_id}\` sends it back to the row that produces one.`,
      }
    }
    return {
      short: `PR #${task.pr} to be merged`,
      clause: `This phase is waiting for you to merge PR #${task.pr} (${task.branch}). ` +
        "Merging is yours, not the plugin's; nothing merges automatically.",
    }
  }

  if (row.signal === 'closed' && task) {
    return {
      short: `issue #${task.issue} to close`,
      clause: `This phase is waiting for issue #${task.issue} to close. Check it with ` +
        `\`gh issue view ${task.issue} --json closed,state\`; if the PR body used a phrase ` +
        'GitHub does not treat as a closing keyword, close it by hand.',
    }
  }
```

and the existing `worktree` task branch — **rewritten per MAJOR 2**, keeping its `short`
byte-identical so `test/stall.test.ts:304` still passes:

```ts
      ? { short: 'its worktree to be removed',
          clause: "This phase is waiting for this task's worktree to be removed. Teardown is " +
            'unconditional and runs first in every tick, so a task still here means this run is ' +
            "not being advanced — check the supervisor pane's log, and check whether another run " +
            'already holds this orchestrator pane.' }
```

Four properties of these branches, each deliberate:

- **The commands are the ones the phase prompts already print.** `gh issue view {{issue}} --json
  closed,state` is `close.md:5`; *"Merging is yours, not the plugin's; nothing merges
  automatically"* is `merge.md:9`; `gh pr checks <pr>` is the call `Gh.prChecks` makes
  (`gh.ts:63-64`); the `rewind` shape matches `status.ts:25`, `tick.ts:38` and
  `stall-escalate.md:14`. A probe that contradicted the phase prompt would be worse than the
  fallback.
- **Every clause names an exit where one exists — A12, and MINOR 4's fix.** The two deadlock clauses
  are composed as full `Awaiting` literals rather than through `sentence()`, both because the helper
  produced awkward prose and because a dead-end sentence repeated every 45 minutes forever is the
  silence this issue exists to end, wearing different words.
- **`hpipe` is interpolated, never literal.** `stallAwaiting` documents that its `hpipe` argument
  arrives already rendered because `render` never re-scans replacement text (`stall.ts:156-159`,
  `render.ts:8-14`); the `gate` branch already does exactly this (`stall.ts:212-216`).
  `test/prompts.test.ts:68-76` scans prompt *files* for a literal `hpipe`, so a clause composed in
  TypeScript is outside it — which is why **A11** keeps the wording here.
- **The `actor === 'human'` branch cannot fire on the escalation path.** `escalate` renders the text
  **before** the transition (`stall.ts:293-299`, contracted at `StallDeps:239-243`), so `task.phase`
  is still the pre-escalation phase when `main.ts:289` calls `stallAwaiting` for `awaiting_short`.
  MINOR 5 re-specifies the test that proves it.

**A6 contradicts a shipped comment.** `stall.ts:154-158` is corrected in the same hunk — the "needs
no change here" sentence is now false, and leaving it would mislead the next reader precisely where
this issue found the bug.

### A9 — the dead `stallWhen`, guarded rather than plumbed

None of the five rows needs a "healthy while it waits" condition: `ci`, `merge` and `close` are
parked or they are not, and **P4** shows every benign `teardown` cause is either already excluded or
is a genuine fault worth a probe. So this issue does not need the mechanism, and #15's precedent —
*"a second knob for a bound with no reason to differ"* (`:696`) — argues against building one
speculatively.

But leaving a declared field that is silently ignored on half the table is the trap this issue's
research walked into. The guard goes in `table.test.ts`, which already holds exactly this kind of
`PhaseRow` invariant (`:8-37`):

```ts
test('no task row carries a stallWhen — taskStallCandidates never reads one', () => {
  // stallCandidates consults it (stall.ts:83); taskStallCandidates does not
  // (:99-104), and its declared parameter is run-shaped (phases.ts:39). A task
  // row given one today would be silently ignored, so make that fail loudly.
  expect(TASK_ROWS.filter((r) => r.stallWhen).map((r) => r.phase)).toEqual([])
})
```

`table.test.ts` is outside t2's declared holdings; **A16** covers that.

### A10 — the runbook, both sites

**Site 1 — §4c `:359-361`**, the probe-only enumeration, which this change takes from four rows to
nine. The surrounding paragraph at `:353-357` (cadence, last-probe anchoring, the escalating list) is
unaffected and stays: the escalating set does not move.

**Site 2 — the footer bullet `:199-204`**, added to `main` by the batch-2 branch review in `6605241`.
It currently asserts three things this change falsifies:

> …a task parked in `merge`, `close` or `blocked-on-decision` emits nothing, so **the footer is the
> only thing that reports it**. … a task parked in an orchestrator-owned row is reported **only** on
> ticks that already produce a digest; **a genuinely quiet window shows nothing. That residual gap is
> issue #19**, not a defect here.

After this change the footer is no longer the only reporter, a quiet window does not show nothing,
and #19 is closed. Per the ruling, it is rewritten to state what the operator should then verify: the
footer still rides digests as before, **and** a task parked in `ci`, `merge`, `close`, `teardown` or
`escalated` is probed in the orchestrator pane on its own `TASK_STALL_MINUTES` schedule, with a
clause naming what it waits for, and is never escalated by that probe.

No other section is touched. The recovery table (`:530-534`) needs no change, since no new escalation
path exists.

---

## Data and control flow

Nothing in `stall.ts`'s control flow changes. The five rows simply stop being rejected at
`stall.ts:101`, and then travel the existing path:

```
taskStallCandidates(runs, now, TASK_STALL_MINUTES, probeMax)     stall.ts:90-107
  ├─ skip run if runRow(run.phase).releasesPane        (A26)           :98
  ├─ per task: if (!row.stallable) continue            ← the only line these rows change
  └─ candidateFor                                                      :51-74
       ├─ paneId = probePaneFor(...)   → run.orchestrator_pane for all five, :55
       │    └─ null ⇒ no candidate                                     :56
       ├─ due: now - state.last_probe_at >= threshold × 60_000         :61
       ├─ escalatable = ESCALATING_SIGNALS.has(row.signal) → FALSE     :63  (A2)
       └─ action = 'probe'                                             :67

applyStalls                                                            :257-283
  └─ action === 'probe' → deps.probe(c) → on ok: bumpStall('probes') → persist
                                                                       :263-268
     (the escalate arm at :271-281 is unreachable for these rows)
```

`main.ts` is untouched. `deps.probe` (`main.ts:271-283`) already renders `stall-probe` with
`phase: \`${task.phase} (${task.task_id}, ${task.branch})\``, `minutes`, `awaiting.clause` and
`ladderFor(c, probeMax)`; all four resolve for the new rows without a new variable, which is what
**A11** buys.

**Ordering within a tick is unchanged and matters.** `advanceTasks` (`main.ts:185`) and the two
`saveRun` sites (`:140`, `:242`) precede the stall block (`:310-315`), and `listRuns` (`:115`)
re-reads every run from disk each tick (`ledger.ts:48-62`) — so a task that advances out of `merge`
this tick has its `phase_entered_at` re-stamped before `stallStateFor` (`stall.ts:115-125`) reads it,
and the ladder re-arms rather than probing a row that has already moved.

**A run starved by `pickOneAdvance`'s third skip is still probed** (**P4**), and that is wanted: the
probe is the only indication its tasks are not being advanced. The clause no longer guesses why.

**Persisted shape.** `StallState` is written to the `Task`, exactly as for the ten rows already
stallable. No new field.

**A15 — file gating is untouched.** All five rows keep `holdsFiles: true`, so `isInFlight`
(`gating.ts:23-29`) and `releasableFromFiles` behave identically; nothing on the stall path reads or
writes `holdsFiles`. A parked `merge` holds its files exactly as long as it did before, which is what
`status.ts:46-63`'s release advice assumes.

### Config

None. **A8.** **A4** keeps these five rows on the same `TASK_STALL_MINUTES: 45` cadence as every
other task row rather than giving a parked row its own; `STALL_PROBE_MAX: 3` (`config.ts:28-29`) is
reused unchanged and is read only on the escalate path, so for these five it affects nothing but the
`ladderFor` sentence, which does not quote it for a non-escalatable row (`stall.ts:227-229`).

### Ledger drift

`stallable`, `probeTarget` and `stallWhen` are read at tick time and never serialised —
`grep -rn "stallable\|probeTarget\|stallWhen" src` returns only `phases.ts`'s declarations and
`stall.ts:14`, `:82-83`, `:101`. `schema_version` stays `2`, and a run already on disk picks the new
behaviour up on the next tick with no migration. **The self-hosting hazard still applies:** this is a
`phases.ts` change, and the installed plugin is a GitHub install pinned to a tag, so the running
supervisor keeps the old table until the release lands.

---

## Error handling

| Failure | Behaviour | Why |
| --- | --- | --- |
| `run.orchestrator_pane` is `null` on a parked row | No candidate at all (`stall.ts:56`) | `probePaneFor` has no fallback for these rows; such a run is also skipped by `pickOneAdvance` (`tick.ts:243`), so the whole run is dark and **#24**/#14 own that, not the ladder |
| `agentPrompt` rejects the probe | No bump, no persist, still due next tick — retried every tick, unbounded | Unchanged behaviour (`stall.ts:264`); **#32** owns whether an undeliverable probe should be a rung, **#25** whether it should be bounded. Widening the set adds five rows to that population and changes neither defect |
| A parked row is probed forever | By design (**A7**) | `ladderFor:227-229` says so in the probe itself |
| `task.pr === null` in `ci` or `merge` | Clause names the permanent deadlock **and its exit** (**A13**, MINOR 4) | **P3** |
| `task.escalated_from` is `null` on an escalated task | Clause renders `<phase>` | The same placeholder `status.ts:25` and `tick.ts:37` already use |
| Run is `escalated` or `done` | None of its tasks produce candidates | A26 (`stall.ts:98`), unchanged |
| A run is starved by `seen.has(pane)` (`tick.ts:243`) | Its tasks are probed although nothing advances them | Wanted (**P4**); the `teardown` clause states the fact and names both causes rather than diagnosing one |
| A task advances out of `merge` in the same tick | `phase_entered_at` re-stamped before `stallStateFor` reads it; not due for a full threshold | The pre-existing race #15 documents |
| Supervisor restarts with a task hours into `merge` | Exactly one probe, then paced from `last_probe_at` | A29 of #15, unchanged — this is why widening the set cannot produce a burst |
| Run ladder and task ladder both due on one pane | Two prompts, 15m and 45m cadences. Reachable **two** ways, not one (MINOR 3): `execute` with intake open, and `branch-review` — `SETTLED` includes `escalated` (`teardown.ts:12-15`), `tasksAllTerminal` is built from it (`deliver.ts:193`), so `machine.ts:69-72` advances a run holding an escalated task into `branch-review`, which is stallable and not `releasesPane` | Accepted as noise; suppression would need cross-record state the ladder does not have |
| `stallAwaiting` reaches a signal with no branch | `whatever clears <phase>` (`stall.ts:218`) | Kept (**A14**); after this change no *task* signal reaches it, and the only reachable producer is a run row with `signal: 'registration'` |

---

## Testing strategy

Baseline to hold: **454 pass / 0 fail**, `tsc --noEmit` clean. TDD throughout — each pinned test is
edited to its new value *first*, watched to fail, then `phases.ts` is changed. The reviewer's scratch
application of this design reached **455 pass / 0 fail** (review `:41-52`), which is the number to
land on plus whatever the new tests below add.

### The four tests that must fail before the change

**MAJOR 1's fix: the pass-0 list named three. There are four.** Verified by the reviewer against a
scratch tree (review `:133-140`).

1. `test/phases.test.ts:49-56` — named *"the stallable set is exactly what #15 assumed — widening it
   belongs to #19"*. Renamed and updated:

```ts
  expect(TASK_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort()).toEqual([
    'blocked-on-decision', 'blocked-on-files', 'ci', 'close', 'escalated', 'implement',
    'merge', 'plan', 'plan-review', 'pr-review-intent', 'pr-review-quality', 'research',
    'spec', 'spec-review', 'teardown',
  ])                                                    // 10 → 15
  expect(RUN_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort())
    .toEqual(['branch-review', 'dispatch', 'execute'])  // unchanged — the run table is untouched
```

2. `test/phases.test.ts:58-62` — the probe-only set, in table order, 4 → 9:

```ts
  expect(probeOnly).toEqual(['dispatch', 'execute', 'blocked-on-files', 'ci', 'merge',
    'close', 'teardown', 'blocked-on-decision', 'escalated'])
```

   Nine probe-only against nine escalating, eighteen stallable rows in total. The escalating list is
   unchanged, which is **A2** expressed as an assertion.

3. `test/stall.test.ts:109-114` — *"a task phase whose row is not stallable is never probed"* loops
   over `['queued', 'ci', 'merge', 'close', 'teardown', 'done']`; four of those five are now
   stallable. Narrowed to the rows that stay unstallable, and widened to the ones it never covered:

```ts
  for (const phase of ['queued', 'done', 'failed', 'orphaned', 'blocked-on-failure'] as const) {
```

4. `test/stall.test.ts:307-315` — *"an unrecognised signal falls back to naming the phase"* uses `ci`
   as its example, and `ci` is recognised after **A6**. **MINOR 2's fix:** it cannot be rewritten
   "against a synthetic row" as pass 0 claimed — `stallAwaiting` derives the row itself
   (`stall.ts:162`) and `taskRow` throws on an unknown phase (`phases.ts:147`). It moves to the run
   level, the only reachable producer: `stallAwaiting(runAt('intake', LONG_AGO), null, 'hp')` →
   `whatever clears intake`. Labelled a characterisation test, the way `tick.ts:59-64` labels the
   identical situation for `describeWake`'s null-task arm.

### New coverage in `test/stall.test.ts`

- **Candidates.** Each of the five rows, aged past 45m, yields exactly one candidate whose `paneId`
  is the orchestrator pane — the shape of `test/stall.test.ts:54-58`, extended to five rows.
- **A2, the safety property, stated directly.** For each of the five: drive `applyStalls` well past
  `probeMax` and assert `action` is never `'escalate'`, the phase never becomes `'escalated'`, and
  `escalatable` is `false`. This is the test that would catch someone widening `ESCALATING_SIGNALS`
  later.
- **The measured regression.** The 4h57m `merge` park, replayed minute-by-minute with an injected
  clock: exactly 6 probes at 45-minute spacing, no escalation, phase still `merge`.
- **A6 clauses**, per branch: `merge` names the PR number, the branch and *"nothing merges
  automatically"*; `close` names `gh issue view <n> --json closed,state`; `ci` names
  `gh pr checks <pr>`; `teardown`'s `short` is unchanged while its clause names **both** causes and
  asserts neither — specifically, it does not contain `throwing`.
- **A6/P2's false sentence, as a regression.** An escalated task's clause contains neither
  `open decision` nor `an answer to`, does contain `rewind`, and renders the run id and
  `--task <id>`; a `blocked-on-decision` task still returns `'an answer to the open decision'`
  (pinning `test/stall.test.ts:303`).
- **A12/A13, MINOR 4.** A `ci` row and a `merge` row with `pr === null` each return the deadlock
  sentence **and** a `rewind … implement --task …` exit, built with `'bun run /p/src/cli.ts'` and
  containing no `{{` — mirroring the `gate` assertion at `:287-290`.
- **MINOR 5 — the ordering invariant, non-vacuously.** Pass 0 asserted it on `merge`, which
  `escalate` never renders for (**A2**), making it vacuous. Re-specified on an **escalatable** row:
  drive an `implement` task through `applyStalls` past `probeMax` with a recording fake, and assert
  the `from` handed to `escalationText` is `implement` and the `awaiting_short` it renders is the
  `pr` row's, not `'a human to act on the escalation'` — i.e. the text describes the phase being
  left, not `escalated`.
- **A26 still holds for the new rows.** A task in `merge` inside a run whose phase is `done` or
  `escalated` yields no candidate.

### `test/table.test.ts`

The **A9** guard. The existing `:30-37` probe-target test covers three more rows with no edit, which
is the point of **A3**.

### Unchanged by construction

`test/machine-task.test.ts`, `test/teardown.test.ts`, `test/ci.test.ts`, `test/tasks.test.ts`,
`test/tick.test.ts`, `test/status.test.ts`, `test/prompts.test.ts` — no transition, prompt or status
line changes, and **A11** edits no prompt file. The pass-0 spec said "if any of these does fail, that
is a finding, not a test to patch" while its own must-fail list was short by one; the list above is
now exhaustive against a verified scratch application, so that rule can be applied literally.

### Live verification — not optional

`.claude/agents/plugin-dev.md` records that DI with fakes has passed clean over real defects twice.
The unit suite cannot see delivery, and every probe here is a delivery. With
`TASK_STALL_MINUTES=1` in `config.env`:

1. Park a task in `merge` with a real open PR. Confirm a probe arrives in the **orchestrator's** pane
   at ~1m, that it names the PR number and the branch, and that it contains no `{{`.
2. Let it run past `STALL_PROBE_MAX × TASK_STALL_MINUTES` and **confirm no escalation** — the task is
   still `merge`, `hpipe status` shows no ⚠, and no dependent moved to `blocked-on-failure`. This is
   **A2** and it is the one that must be seen live.
3. Read the run JSON off disk between probes: `stall.probes` climbs and `stall.last_probe_at`
   advances, with `phase` unchanged. This is what a fake-backed test cannot show.
4. Merge the PR and confirm the ladder re-arms rather than probing `close` immediately — one full
   `TASK_STALL_MINUTES` after the transition.
5. A task in `escalated`: the probe names the rewind command with the right `--task` flag and the
   right origin phase, and says nothing about an open decision (**P2**).
6. `hpipe abort` the run, wait past the threshold: **no probe for any of the five** (A26).
7. A `ci` row whose PR was deleted: the probe reports the deadlock **and its rewind exit** (**A13**).
8. Walk both rewritten `smoke.md` sites against what the run actually produced (**A10**) — the
   runbook is the only place a live observation gets written down, which is exactly why `6605241`
   had to repair it for #13.

Treat any difference between this and `smoke.md` as a finding rather than a test to make pass.

---

## Rejected alternatives

- **Deferring `smoke.md` to `branch-review` per #13's ruling** — the reviewer's option (a), and the
  one this spec was leaning toward before the ruling. Overruled on 2026-09-19: #13's deferral existed
  to remove a race between two tasks holding the same file, and nobody contests it now. Recorded
  because a later reader will find #13's ruling first and needs to know why this went the other way.
- **A distinct "parked, awaiting human" treatment in `status`/the digest** — the issue's second
  Direction. Rejected as **not this issue's**: #14 claims *"PRs parked in `merge` awaiting a human"*
  verbatim and owns moving `ageMinutes`/`actionFor` into `src/lib/`. Doing it here would write a
  fourth copy of the age arithmetic into a file #14 is about to restructure.
- **Making `merge` and `close` escalatable.** Rejected: they wait on a human by design, `escalated`
  is in `TERMINAL_BAD` (`gating.ts:6-8`), and escalation would cascade every dependent to
  `blocked-on-failure` for the crime of a slow human. #15's spec `:693` already rejected this.
- **A cap on the standing nudge.** Rejected as **A7**: `blocked-on-decision` has been probe-only and
  unbounded since #15 in exactly this shape, and a row that stops nudging is a row back in the
  silence this issue exists to end.
- **A longer interval for parked rows** — a second threshold. Rejected as **A8**, on #15's own
  reasoning about `STALL_HOLD_MAX` (`:696`): a second knob for a bound with no reason to differ.
- **Plumbing `stallWhen` into `taskStallCandidates`.** Rejected as **A9/NG7**: no row here needs it,
  its parameter is run-shaped, and a mechanism built for no caller is speculation the guard test
  replaces at a twentieth of the cost.
- **Moving the A9 guard into `test/phases.test.ts`** to stay inside the declared holdings — the
  reviewer's MAJOR 3 fix. Rejected in favour of the ruling's treatment: `table.test.ts` is where this
  repo keeps `PhaseRow` structural invariants (`:8-37`), and **A16** declares the gap for both files
  rather than shuffling one of them to dodge it.
- **Keeping the strong `teardown` clause** and adding the third skip to P4 as impossible. Rejected:
  it is reachable (`cli.ts:30-34` guards per `repo_key` only), and no argument closes it.
- **Rewriting `prompts/stall-probe.md`.** Rejected as **A11**: #15 deliberately made `{{awaiting}}` a
  whole paragraph *"so the template asserts nothing about its shape"* (`stall.ts:148-149`), and the
  nine worker rows' wording was settled over three review rounds. The clause is the designed
  extension point.
- **Matching `escalated` by phase name rather than `row.actor === 'human'`.** `tick.ts:126-128`
  chooses the opposite for `parkedFooter`, reasoning that *"a future human-owned row has to opt in
  here instead of inheriting this"* — correct there, because the footer is an opt-in list of who to
  bother. Here the question is what sentence describes the wait, and *"waits on the human"* is true
  of any human-owned row by construction. The divergence is deliberate.
- **Fixing the `pr === null` deadlocks in `machine.ts`/`ci.ts`.** Rejected as scope (**NG9**): this
  issue makes them audible; making them impossible touches files this issue otherwise never opens.
- **Bumping `schema_version`.** Nothing is serialised; it would strand every in-flight run behind
  `hpipe abort` (`main.ts:32-34`).

---

## Open decisions

None. BLOCKER 1 was the only one, and the Ownership ruling of 2026-09-19 settled it — including the
instruction to declare rather than silently widen, which is **A16**. The reviewer was right to
escalate it rather than pick a side.
