# Adversarial review — issue #15 design, pass 0

Target: `docs/superpowers/specs/2026-09-17-issue-15-design.md` (639 lines, at `0504b17`).
Against: `gh issue view 15`, `docs/superpowers/research/2026-09-17-issue-15-research.md`,
and the code in this worktree.

Baseline re-verified here, not taken on trust:

```
$ bun test        → 351 pass, 0 fail, 767 expect() calls, 33 files [6.25s]
$ bun run typecheck → tsc --noEmit, no output, exit 0
$ bun --version   → 1.3.14      $ herdr --version → herdr 0.9.0
$ ls docs/superpowers/reviews/ → 2026-09-13-design-adversarial-{1,2,3}.md,
                                 2026-09-15-worker-owned-adversarial-{1,2}.md
```

The research note's §1–§4 citations all resolve. The spec's `file:line` citations are, with two
exceptions noted in MINOR 2 and MINOR 4, accurate — `phases.ts:54-59`, `:64`, `:70-71`, `:92-131`;
`stall.ts:12-14`, `:22-26`, `:62-64`, `:83`, `:92-103`; `machine.ts:7-9`, `:30-32`, `:45-51`,
`:90-96`, `:113-127`; `deliver.ts:78-81`, `:84-102`; `cli.ts:177-194`; `herdr.ts:68-71`, `:77-82`;
`tick.ts:105-112` were each re-read. P3 and P3b are correctly diagnosed: `artifactPathFor(run,
null)` (`deliver.ts:92-93`) has no null return path, so `absoluteArtifactPath(run, null)` cannot be
null and `main.ts:247`'s `?? 'the expected artifact'` is indeed dead. The problem statement is
sound. The remedy is where this falls down.

---

## BLOCKER 1 — the persisted counter is never persisted, so the ladder never advances and the probe becomes a 1 Hz loop

**Claim.** A4 (spec:117): "The probe counter is persisted on the run/task record, replacing the
in-process `probed` set." A5 (spec:213-236) builds the whole no-timestamp scheduling argument on
that counter surviving a tick, and Error handling (spec:530) says a rejected probe "stays due and is
retried next tick", implying an accepted one does not.

**Problem.** Nothing in the design writes the counter to the ledger on the probe path.
`applyStalls` mutates in memory only —

```
spec:478   if ((await deps.probe(c)).ok) bumpStallProbes(c.task ?? c.run)   // A6
```

— and the only save in the tick is guarded on escalation:

```
spec:498   if (anything escalated) await saveRun(stateDir, run)      // see Error handling
```

But the `Run` objects the stall block mutates are rebuilt from disk on every tick.
`main.ts:113` calls `listRuns(stateDir, session)`, which `readJson`s each file fresh
(`src/lib/ledger.ts:48-62`). The only `saveRun` that could carry a bump is `main.ts:217`, which is
*inside* the `for (const run of advancing)` loop and therefore runs **before** the stall block at
`main.ts:238-268`. There is no `saveRun` after it — the tick ends at `main.ts:268`, falls into the
`catch` at `:269-271` and sleeps.

Consequence, at the shipped defaults: `stall_probes` reads `0` on every tick, so
`stallProbesFor(record) >= probeMax` (spec:466) is never true → `action` is always `'probe'`; and
the due predicate `now - phase_entered_at >= threshold × (stallProbesFor(record) + 1)` (spec:465)
is satisfied from 45 minutes onward forever. A stalled task is therefore probed **once per
`TICK_MS`, i.e. once per second, indefinitely, and never escalates**. That is strictly worse than
the single probe #15 complains about, and it defeats Goal 1 (spec:87-89) entirely. A16
(spec:128) has already deleted the in-process `probed` set that is today's only dedupe, so there is
no fallback.

Note the design *knows* this shape is possible — it says so about failed sends at spec:248-250 —
but does not notice that the success path has the same property.

**Fix.** Persist on the probe path. Either give `StallDeps` a `persist: (run: Run) => Promise<void>`
and call it after any accepted probe, or have `applyStalls` return the mutated `Run`s and change
spec:498 to `for (const run of touched) await saveRun(stateDir, run)`. Then add the regression test
the design is missing: bump, re-load the run through `listRuns`, and assert it produces **no**
candidate until `2 × threshold`.

---

## BLOCKER 2 — the ladder escalates `blocked-on-files` and `blocked-on-decision`, which are waiting correctly, and A7 cannot hold either

**Claim.** The classification applies `action: 'escalate'` to every candidate once the counter caps
(spec:466), and the A13 table explicitly enumerates `blocked-on-files` and `blocked-on-decision` as
probe targets (spec:358-359). A7 (spec:119) is offered as the guard against escalating an actor
that is legitimately busy.

**Problem.** `stallable` was chosen as "worth a nudge", not "worth killing the task", and the design
promotes it to the latter without re-examining the rows.

- `blocked-on-files` is `stallable: true, probeTarget: 'orchestrator', holdsFiles: false`
  (`src/lib/phases.ts:105-106`). It clears only when a *sibling* releases the files:
  `case 'blocked-on-files': if (!s.filesClear) return null` (`src/lib/machine.ts:186-189`). A
  sibling legitimately in `implement` for more than three hours is ordinary, not a stall — and it
  forces the waiter to `escalated`, which is in `TERMINAL_BAD` (`src/lib/gating.ts:6-8`), so every
  dependent gates to `blocked-on-failure` (`gating.ts:34-38`); and `escalated` is
  `holdsFiles: true` (`phases.ts:131`), so the waiter now blocks *other* siblings too. A task that
  was correctly parked becomes a cascading failure.
- `blocked-on-decision` is `stallable: true, holdsFiles: 'inherit'` (`phases.ts:126-129`). It waits
  on a human answer. Escalating it at three hours is the overnight case this very issue is about —
  and the response cascades every dependent to `blocked-on-failure` for the crime of the human
  being asleep.

A7 cannot protect either, because the pane it reads is not the actor it means. `probePaneFor`
routes both rows to `run.orchestrator_pane` (`src/supervisor/stall.ts:23-25`), which
`test/stall.test.ts:128-138` pins:

```
test('a task stranded in blocked-on-files is probed via the orchestrator', …)
  expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
test('a task waiting in blocked-on-decision is probed via the orchestrator', …)
  expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
```

So `deps.agentStatus(c.paneId)` (spec:481) reads the orchestrator's status, which says nothing
about whether the file-holding sibling is working or whether the human has answered.

This is the same false-alarm class the repo already paid for once — `stallWhen` exists on `execute`
precisely because "`execute` is probed 15 minutes into every run … which is the false alarm v4's
third review round removed" (`phases.ts:32-38`). The design has no `escalateWhen` analogue and does
not consider that probe-eligibility and escalation-eligibility are different questions.

**Fix (needs the human's call).** Escalate only rows whose completion signal is produced by the
actor being probed — `signal` in `{'artifact', 'verdict', 'pr'}`. Keep probing `blocked-on-files`
and `blocked-on-decision` unchanged and surface them through A15-style warnings instead;
`status.ts:21-26` and `:38-55` already render both conditions, so the human-visible half of Goal 1
is available without a destructive transition. This is a scope decision, not an inline edit: it
changes which rows the issue's "mark the task escalated" applies to.

---

## BLOCKER 3 — P2's causal story does not survive arithmetic, and the issue's actual direction 2 is not implemented

**Claim.** spec:47-53: "Deleting resets the count to zero, so the next tick starts at 1 again.
'Giving up' is a five-tick cycle repeated forever at `TICK_MS` (1000ms, `config.ts:23`) —
**consistent with the 33 further deliveries the issue reports**." Goal 2 (spec:90) is then restated
as "The supervisor stops re-delivering into a pane it has already given up on."

**Problem.** It is not consistent, by two independent measures.

1. *Rate.* `TICK_MS` defaults to `1000` (`src/lib/config.ts:23`). The incident ran 13 hours ≈
   46,800 ticks. A five-tick failure cycle repeated forever would produce ≈ 46,800 send attempts
   and ≈ 9,360 `[pipeline] giving up on delivery to …` lines, not 33 deliveries.
2. *Trigger.* A delivery is only attempted when that tick produced text. `addPending` returns early
   on `if (text.length === 0 && eventLines.length === 0)` (`src/supervisor/main.ts:159`) and
   `deliveriesFor` re-checks the same condition (`src/supervisor/deliver.ts:51`). In a fully
   stalled run `nextPrompt` is `''`, no task transitions, and `wake` is empty on ticks where no
   event drained — so most ticks enqueue nothing and the reset bug is never even exercised.

33 deliveries over 13 hours is ~1 per 24 minutes: the signature of 33 *successful*, event-driven
digests into a pane that was alive while the agent inside it was rate-limited. `herdr agent prompt`
against a live pane succeeds; `DeliveryBudget` (spec:A11) only ever sees failures, so it would not
have fired once during the incident and would not have prevented it.

Meanwhile the issue's direction 2 asks for something the design declines: "Notice a dead
orchestrator pane and stop delivering into it (`formatStatus` already detects the gone-pane case at
`src/lib/status.ts:99`; the supervisor does not act on it)." The design does not act on it either —
NG4 and A17 (spec:100, :123, and the A17 paragraph) accept a dead orchestrator as an unaddressed
limitation. The liveness fact is already in hand: `rebindOrchestrator` calls `herdr.paneList()`
every tick (`src/lib/orchestrator.ts:46-48`) and, when it cannot resolve a replacement, keeps the
stale id on purpose (`orchestrator.ts:39-42`, `:52-53`). Nothing consumes that "the recorded pane is
not in the live list" fact in the supervisor.

**Fix.** Keep the `attempts.delete` correction — `main.ts:234` is a genuine bug — but stop citing it
as the incident's cause, because the numbers say it is not. Then implement direction 2 with the
signal the issue names: when `rebindOrchestrator` finds `run.orchestrator_pane` absent from
`paneList()` **and** cannot resolve a replacement, record that on the run, suppress deliveries and
probes for it, and surface it in `hpipe status` the way `status.ts:99-102` already words it. If
that is genuinely out of scope for this task, say so explicitly and get the human to agree to
shipping #15 with half of it unfixed — do not restate the goal so that the unaddressed half
disappears.

---

## MAJOR 4 — A13's `{{hpipe}}` inside the `{{awaiting}}` value never renders

**Claim.** spec:362: run `execute` → `` `hpipe dispatch --done to close intake` — rendered via
`{{hpipe}}` ``. Reassured at spec:372-374: "`render` throws on any placeholder no caller resolves
(`render.ts:11`), so a missed one fails loudly at delivery rather than shipping through."

**Problem.** `render` is a single `String.replace` pass with a function replacer:

```ts
// src/lib/render.ts:8-14
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`unresolved template placeholder: ${name}`)
    return value
  })
}
```

Replacement text produced by the callback is **not** re-scanned. A `{{hpipe}}` that arrives inside
the value of `awaiting` is therefore emitted verbatim, and the throw at `:11` does not fire because
it only inspects placeholders present in the *template*. The orchestrator would receive:

```
    {{hpipe}} dispatch --done to close intake
```

`test/prompts.test.ts:68-76` ("no prompt hardcodes the hpipe binary") reads only `prompts/*.md`, so
a string living in `src/supervisor/stall.ts` escapes it in both directions — neither the literal
`hpipe` nor the unrendered `{{hpipe}}` is caught.

**Fix.** Give the helper the rendered command: `stallAwaiting(run, task, hpipe: string)`, called
with `hpipeCommand(pluginRoot)` (`render.ts:28-38`) — `pluginRoot` is already in scope at both call
sites. Or drop the binary from that sentence. Add a test asserting the fully rendered stall-probe
text contains no `{{`.

---

## MAJOR 5 — A7 reads the wrong pane, and its cost claim is off by four orders of magnitude

**Claim.** A7 (spec:119): "held while a live `agent status` read on **the actor's pane** returns
`working`". spec:264-265: "It costs one extra herdr call per record per phase entry, only at the
moment of escalation."

**Problem, two parts.**

*Wrong pane.* `c.paneId` is `probePaneFor`'s result, which collapses a paneless worker onto the
orchestrator: `if (row.actor === 'worker') return taskPane ?? run.orchestrator_pane`
(`src/supervisor/stall.ts:24`), pinned by `test/stall.test.ts:146-151` ("a worker row with no pane
falls back to the orchestrator"). A worker whose dispatch prompt never landed — one of the cases
the fallback comment at `stall.ts:16-21` was written for — would have its escalation gated on an
unrelated agent's status. The spec is internally inconsistent here too: A14 (spec:391) reads
`task.pane_id` for the tail while A7 (spec:481) reads `c.paneId` for the guard, two different panes
for the same "actor".

*Cost.* A held candidate consumes nothing (`continue`, spec:481), stays due, and is re-evaluated on
the next tick — at `TICK_MS = 1000`, that is one `herdr agent get` **per second per held
candidate**, not one per phase entry. A worker legitimately working ten hours past the three-hour
cap costs ≈ 36,000 calls. The tick already has a batched, settled status reader for exactly this
(`makeSettledIdleReader`, `main.ts:145-147`) and the stall path bypasses it.

**Fix.** Gate on the actor's own pane (`task.pane_id ?? c.paneId`, or apply the guard only when the
candidate's pane belongs to the row's actor), and route the read through the tick's `liveIdle` /
settled reader or memoise per pane per tick. Correct the cost sentence to match.

---

## MAJOR 6 — Goal 2 is not achieved: the three highest-frequency channels bypass `DeliveryBudget`

**Claim.** A11 (spec:123, and the A11 section): "`accepts` is consulted before each send." A6's
consequence, spec:248-250: "while sends keep failing, the record stays due and is retried every
tick. That is today's behaviour … and is what **P2**'s fix bounds at the delivery layer rather than
here."

**Problem.** P2's fix does not bound it, because the probe path never enters the delivery layer.
Probes call herdr directly today — `return herdr.agentPrompt(candidate.paneId, text)`
(`main.ts:251`, `:267`) — and the design keeps that: "`probe` renders `stall-probe` … and calls
`herdr.agentPrompt`" (spec:501-503). The escalation send is the same (spec:504-507). Neither passes
through `deliveriesFor` or `DeliveryBudget`, so after this change a dead pane still receives an
unbounded 1 Hz probe stream.

A third channel is worse and is not mentioned at all: `announceDecisions`
(`src/supervisor/tasks.ts:293-309`) sends straight to `run.orchestrator_pane` with **no cap of any
kind** — `decision.prompted_at` is stamped only on success, so a failing send retries every tick
forever. `deliverPendingAnswers` (`tasks.ts:258-287`) is the only sibling that is bounded, by the
persisted `delivery_attempts`.

**Fix.** Pass the budget into `StallDeps` and check `budget.accepts(paneId)` before the probe and
escalation sends; give `announceDecisions` the same guard or a persisted attempt counter. Then
Goal 2 (spec:90) is actually true of the supervisor rather than of one of four send sites.

---

## MAJOR 7 — run `dispatch` now escalates a healthy run at 60 minutes, and freezes its tasks silently

**Claim.** A2/A3 (spec:114-115) apply one `STALL_PROBE_MAX` to both levels; the table at spec:190
gives run escalation at 60 minutes. The consequence for `dispatch` is never examined.

**Problem.** `dispatch` is unconditionally `stallable: true` with no `stallWhen`
(`src/lib/phases.ts:54-55`), unlike `execute`, whose `stallWhen` exists specifically because this
class of row generated false alarms (`phases.ts:32-38`, `:56-59`). Today a slow dispatch costs one
nudge at 15 minutes. Under this design the run is moved to `escalated` at 60 minutes — a row with
`releasesPane: true` (`phases.ts:70-71`), so `pickOneAdvance` skips it forever
(`src/supervisor/tick.ts:105-112`) and only `hpipe rewind` restarts it. An orchestrator taking an
hour to register and adopt worktrees for a six-task batch — the size of the run this issue was
found on — loses the run. A7 does not help: it holds only while the orchestrator reads `working`,
and an orchestrator waiting on a human reads `idle`.

The freeze is also silent for the tasks. The stall block iterates `runs`, not `advancing`
(`main.ts:238`, `:254`), so once the run is escalated its tasks stop being advanced by
`advanceTasks` but keep being probed and will themselves be escalated at their own cap — with no
status line explaining that the *run*, not the task, stopped.

**Fix.** Either exempt run `dispatch` from escalation inside `stall.ts` (it is held by this task;
`phases.ts` is not, so no NG2 violation), or give the run level its own cap so the run cannot
escalate out from under tasks that are still moving (run 60m vs task 180m as specified is exactly
that inversion). Add a status warning naming an escalated run, not only an escalated task, to A15.

---

## MAJOR 8 — the test plan understates A16's blast radius and mis-cites `table.test.ts` as the NG2 guard

**Claim.** spec:565: "three existing tests reference the deleted key format (`:66`, `:72`, `:124`)
and are rewritten". spec:570-571: "every existing pane-resolution test (`:128-151`, `:165-175`)
still passes unchanged — the `probePaneFor` contract is untouched". spec:598-599: "`test/table.test.ts`
— unchanged and must stay green; it is the guard that **NG2** was honoured (no row gained or lost
`stallable`)."

**Problem.**

*Blast radius.* A16 deletes the `alreadyProbed` parameter, and the new signature's fourth argument
is `probeMax: number` (spec:459-460). Every existing call passes a `Set`:

```
$ grep -c "new Set()" test/stall.test.ts                                   → 15
$ grep -c "stallCandidates(\|taskStallCandidates(" test/stall.test.ts      → 24
$ grep -c "^test(" test/stall.test.ts                                      → 20
```

`new Set()` is not assignable to `number`, so every one of those call sites is a compile error —
including `:128-151` and `:165-175`. `:165-175` additionally calls `sendProbes`, which A16 deletes.
"Still passes unchanged" is false for the entire file; the honest statement is that all 20 tests
are rewritten.

*Wrong guard.* `test/table.test.ts` contains exactly one assertion touching `stallable`:

```
test/table.test.ts:30-35
  test('every stallable row resolves to a pane or names a probe target', () => {
    … if (!row.stallable) continue
    expect(hasPane || row.probeTarget !== undefined, …).toBe(true)
```

It iterates only rows that *are* stallable and asserts a pane is reachable. It stays green if a row
gains `stallable` (as long as it has an actor pane or a `probeTarget`) and stays green if a row
loses it. It is not a guard that "no row gained or lost `stallable`".

**Fix.** State that `test/stall.test.ts` is rewritten wholesale. If NG2 is to be guarded by a test,
add an explicit assertion of the stallable phase sets to `table.test.ts` — e.g. compare
`TASK_ROWS.filter(r => r.stallable).map(r => r.phase)` against a literal list — and cite that as the
guard.

---

## MINOR 9 — A5's "13 test files" miscounts its own evidence

spec:228-230 argues for an optional field because "13 test files construct `Task` object literals
(`grep -rn "delivery_attempts: 0" test/ | wc -l` → 13)". `grep -rn … | wc -l` counts matching
*lines*, not files:

```
$ grep -rln "delivery_attempts: 0" test/ | wc -l   → 11
$ grep -rn  "delivery_attempts: 0" test/ | wc -l   → 13
```

11 files, 13 literals. The conclusion is unaffected; the number cited as evidence is wrong. Fix the
sentence or the command.

---

## MINOR 10 — `orchestrator.ts` citations do not resolve as written

The A11/A17 paragraphs and the research note cite `orchestrator.ts:30`, `:38-41`, `:43-60`, `:47`
alongside `deliver.ts`, `stall.ts`, `tasks.ts` and `main.ts`, all of which live in
`src/supervisor/`. There is no `src/supervisor/orchestrator.ts`; the file is `src/lib/orchestrator.ts`
(`ls src/supervisor` → `ci.ts deliver.ts main.ts stall.ts tasks.ts teardown.ts tick.ts`). The line
numbers are right once the path is corrected (`:30` is the `agentPanes.length !== 1` bail, `:43` is
`rebindOrchestrator`, `:47` is the `paneList()` read). Qualify the path.

---

## MINOR 11 — A13's "switch on `row.signal`" is not what the table describes

spec:365-367: "This is a `switch` on `row.signal`, not on the phase name, so **NG2**/#19 making four
more rows stallable does not require touching it — those rows' signals (`ci`, `merged`, `closed`,
`worktree`) fall through to the default." But the table at spec:361 maps run `dispatch`, whose
signal *is* `worktree` (`phases.ts:54`), to "a worktree adopted for a dispatched task". A switch on
signal alone would hand a stallable task `teardown` (`signal: 'worktree'`, `phases.ts:124`) that
same sentence when #19 lands. The table's first column already distinguishes run from task, so the
implementation is fine; the prose describing it is not.

---

## MINOR 12 — the `cmdRewind` test has no run-side counterpart to sit beside

spec:589-591: "`cmdRewind` resets `stall_probes` for both a task and a run, asserted beside the
existing `delivery_attempts` assertion." `delivery_attempts` is a `Task` field only
(`src/lib/types.ts:78`), and `cmdRewind`'s run branch resets `passes`, `phase_entered_at` and
`escalated_from` but never `delivery_attempts` (`src/cli.ts:184-194`). There is no existing run-side
assertion to place the new one next to. Reword, and make sure the run-side reset is actually added
at `cli.ts:185-187`.

---

## What is right, and should survive a revision

Not padding — these are load-bearing and were checked:

- P1, P3 and P3b are all real and correctly cited. `absoluteArtifactPath(run, null)` genuinely
  cannot return null (`deliver.ts:92-93` ends in a `join`), so `main.ts:247`'s fallback is dead and
  `dispatch`/`execute` probes genuinely name an invented `docs/superpowers/reviews/` path.
- A1's reuse of `escalated` is well argued, and the three consequences listed are each verifiable
  (`phases.ts:130-131`, `gating.ts:6-8`, `teardown.ts:25`) — the objection in BLOCKER 2 is about
  *which rows* reach it, not about the phase choice.
- A2's rejection of exponential backoff is correct and well evidenced: 11.25 h to escalate against a
  13 h incident is not a fix.
- A5's refusal to bump `schema_version` is right; `isCurrentSchemaRun` is a hard `=== 2`
  (`main.ts:30-32`) and `readJson` does no validation (`store.ts:5-13`), so an absent optional field
  reads 0 cleanly.
- A10's reasons for a separate `stall-escalate.md` check out, including the two
  `test/prompts.test.ts` constraints (`:10-14`, `:21-24`, `:68-76`).
- A16's argument for deleting the keys is right in substance; only its stated test cost is wrong.
- The "Live verification — not optional" section is exactly the right instinct for this repo.

---

VERDICT: BLOCKER
BLOCKERS: 3
MAJORS: 5
