# Adversarial review — issue #15 design, pass 1

Target: `docs/superpowers/specs/2026-09-17-issue-15-design.md` (677 lines, at `437f45a`).
Against: `gh issue view 15`, `docs/superpowers/research/2026-09-17-issue-15-research.md`,
`docs/superpowers/reviews/issue-15-spec-review-0.md`, the live ledger, and the code in this worktree.

Baseline re-verified here, not taken on trust:

```
$ bun test          → 351 pass, 0 fail, 767 expect() calls, 33 files [6.83s]
$ bun run typecheck → tsc --noEmit, no output, exit 0
$ bun --version     → 1.3.14        $ herdr --version → herdr 0.9.0
$ herdr pane list --help → "Usage: herdr pane list [OPTIONS] / --workspace <WORKSPACE_ID>"
$ herdr pane list   → panes across w1, w2, w3, w4 — the list IS global, so A19's
                      `livePanes` premise holds
```

**Pass-0 dispositions, checked one by one.** BLOCKER 2 (A18) is genuinely fixed and correctly
evidenced — every signal in the A18 table resolves (`phases.ts:92`, `:94`, `:96`, `:99`, `:101`,
`:105`, `:109`, `:111`, `:114`, `:126`, `:54`, `:56`, `:64`). MAJOR 7 really does fall out of A18.
MAJOR 8 is fixed and its new numbers are right (`grep -c '^test(' test/stall.test.ts` → `20`;
`grep -o 'new Set(' test/stall.test.ts | wc -l` → `18`), and **A21's asserted stallable sets are
exactly correct** against `TASK_ROWS`/`RUN_ROWS`. MINOR 9 (`11` files / `13` lines), MINOR 10
(`src/lib/orchestrator.ts` throughout — `grep -n 'orchestrator\.ts'` shows six hits, all correct)
and MINOR 12 (`cli.ts:184-187` has no `delivery_attempts` line) are all fixed. BLOCKER 1's fix is
real **on the success path** and the regression test named for it is the right one.

Three dispositions did not survive verification: BLOCKER 3's fix over-shoots into a new freeze
(BLOCKER 1 below), MAJOR 6's fix is half-applied (MAJOR 3), and MINOR 11's fix contradicts its own
table (MINOR 4). And the pass-1 spec introduces a scope violation the pass-0 spec did not have
(BLOCKER 2).

---

## BLOCKER 1 — A19 does not stop delivering into a dead pane; it stops the entire run, including the ladder this issue exists to add

**Claim.** Goal 2 (spec:143-145): "the supervisor stops sending to it — digests, probes,
escalations and decision announcements alike — and says so once." A19 step 3 (spec:282-284): a run
whose `orchestrator_pane` is not in `livePanes` is `continue`d — "no `evaluateRun`, no
`advanceTasks`, no `deliverPendingAnswers`, no `announceDecisions`, no digest. It is also filtered
out of the two `applyStalls` inputs." Justified at spec:288-289: "Suppressing the whole run rather
than each send site is what makes this cheap and total."

**Problem.** The `continue` is placed in a loop body that is not a send site. It is the run's entire
engine. Everything below it in `main.ts:169-217` is skipped, and almost none of it targets the
orchestrator pane:

- `advanceTasks` (`main.ts:176-193`) — the whole task state machine. Worker-owned rows
  (`research`, `spec`, `spec-review`, `plan`, `plan-review`, `implement`, both PR reviews) advance
  with no orchestrator involvement whatsoever.
- `taskPrompts` → `addPending(prompt.paneId, …)` (`main.ts:213-215`) — prompts addressed to
  **worker** panes, delivered at `main.ts:223`. A19 drops them.
- `deliverPendingAnswers` (`main.ts:203`) — sends to `task.pane_id`, not the orchestrator
  (`tasks.ts:259`, `:275`).
- `refreshBadges`, and the run's own `saveRun` (`main.ts:210`, `:217`), so `ciTransitions`
  mutations made earlier this tick (`main.ts:138-141`) are also discarded.
- And `reachable` (spec:524) removes the run from **both** `applyStalls` calls, so its tasks get no
  probe and can never reach `escalated` — the ⚠ line of **A15** never renders.

Today, a run whose orchestrator pane is gone keeps working: `rebindOrchestrator` fails to resolve
and deliberately keeps the stale id (`src/lib/orchestrator.ts:30`, `:38-41`, `:52`), the tasks keep
advancing, workers keep getting prompted, and only the orchestrator-addressed digest fails. After
A19, nothing moves. The realistic trigger is the incident's own shape: the orchestrator pane exits
overnight, `resolveOrchestrator` sees zero agent panes and returns `null` (`orchestrator.ts:23-31`),
the stale id stays, and every worker in that run is frozen silently — no probe, no escalation, no
status warning beyond the one `formatStatus` already printed before this change (`status.ts:99-102`).
The single log line goes to the supervisor pane, which is the pane nobody was watching for 13 hours.

That is a *new* way to produce exactly the failure #15 was filed about, created by the fix for it.
It also contradicts the issue's own wording of direction 2 — "Notice a dead orchestrator pane and
**stop delivering into it**" — and Goal 1, which A19 disables precisely for the runs that need it
most.

**Fix.** Suppress by *recipient*, not by run. Keep the `continue` out of the advancing loop; instead
(a) filter `pending` before `deliveriesFor`, dropping entries whose `paneId` is not in `livePanes`;
(b) guard the `announceDecisions` send and the run-level probe/escalation sends the same way — both
target `run.orchestrator_pane` (`tasks.ts:294`, `:307`; **A9**); (c) leave `advanceTasks`,
`deliverPendingAnswers` and the **task** stall ladder running, so worker rows keep moving and a
stalled worker still escalates into the ledger where `hpipe status` shows it. That is still "total"
for the four senders #15 names, and it costs the run nothing. If the whole-run freeze is genuinely
wanted, it is a behaviour reversal that needs the human, not a paragraph inside A19.

---

## BLOCKER 2 — A11 moves the retry loop into `src/supervisor/deliver.ts`, which the live ledger shows is held by the sibling task (#9), and which this spec's own Scope boundary declares untouched

**Claim.** Scope boundary (spec:54-55): "**Not held, not touched:** artifact-path *derivation* — #9
owns `src/cli.ts:88-92`. This spec calls `absoluteArtifactPath` (`deliver.ts:97-102`); it does not
change what it returns." A23 (spec:57-62, :387-400) enumerates the unheld files edited under the
orchestrator's ruling as exactly four: `src/cli.ts`, `src/lib/types.ts`, `src/lib/machine.ts`,
`test/cli-commands.test.ts`. A11 (spec:330): "`main.ts:223-236` is **extracted into `deliver.ts`**
beside `shouldRetry`", with its tests in `test/deliver.test.ts` (spec:591).

**Problem.** `deliver.ts` is not merely unheld — it is declared by the task running right now beside
this one. From the live ledger,
`/Volumes/stein/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/herdr-plugin-pipeline-20260917-bug-fixing-and-enhancements-qc13.json`:

```
t1 #9  spec-review  files= ['src/cli.ts', 'src/lib/worker-prompt.ts', 'src/supervisor/tasks.ts',
                            'src/supervisor/deliver.ts', 'prompts/worker-brief.md']
t2 #15 spec-review  files= ['src/supervisor/stall.ts', 'src/supervisor/main.ts',
                            'prompts/stall-probe.md', 'src/lib/status.ts']
```

`herdr pane list` confirms #9's worker is live in `w3:p1`
(`cwd=/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-9-artifact-paths`,
`agent_status: working`). #9's issue body names `src/supervisor/deliver.ts:90,93` as one of the two
hardcoded-path sites it is there to change, so both tasks would be editing that file concurrently.

Nothing protects against it. `filesOverlap` is a declared-intent prefix check (`gating.ts:16-21`)
run against `task.files`, and `deliver.ts` is absent from #15's list — which is why both tasks are
in flight simultaneously. So the gate that is supposed to serialise them has been defeated by a
file the design added after the holdings were declared. This is the *precise* failure A23 was
written to stop: "distance between hunks is about the odds of a textual conflict, not about
ownership, and it is the reasoning that produced a broken file lock on the run these issues came
from" (spec:59-61). The spec disavows the reasoning and then relies on it.

Two smaller corrections fall out of the same ledger read: `src/lib/status.ts` **is** held by this
task and the Scope boundary omits it from the held list (spec:50-51); and `#9 owns src/cli.ts:88-92`
understates #9's holdings, which are five whole files.

**Fix.** Put `DeliveryBudget` in a file this task holds — `src/supervisor/main.ts` or
`src/supervisor/stall.ts` — importing `shouldRetry` from `deliver.ts` without modifying it, and put
its tests in `test/stall.test.ts` or a new `test/delivery-budget.test.ts`. `deliver.ts` then stays
read-only for this task, as spec:55 already promises. If the extraction into `deliver.ts` is worth
keeping, it needs the orchestrator to extend the A23 ruling to a file a live sibling holds, and
sequencing behind #9's merge — that is the human's call, not an inline edit.

---

## MAJOR 3 — `StallDeps` gets `accepts` but no `record`, so nothing ever feeds the budget from the probe path; the bound the error table promises cannot occur

**Claim.** A11 as amended (spec:344-346): "the same budget instance is passed into `StallDeps`, so
probe and escalation sends check `accepts` too. Pass 0 left both calling `herdr.agentPrompt`
directly, which would have left a dead pane receiving an unbounded probe stream." Error handling
(spec:542): "`agentPrompt` rejects a probe … and keeps rejecting | `DeliveryBudget` abandons the
pane after `PROMPT_RETRY_MAX` | **A11** — pass 0 left this unbounded (MAJOR 6)."

**Problem.** `accepts` only ever returns `false` for a pane that `record` has moved to `abandoned`
(spec:335-341). The interface has no `record`:

```
spec:479-485
export interface StallDeps {
  accepts: (paneId: string) => boolean
  probe: (c: StallCandidate) => Promise<{ ok: boolean; code?: string }>
  escalate: (c: StallCandidate) => Promise<void>
  agentStatus: (paneId: string) => Promise<AgentStatus>
  persist: (run: Run) => Promise<void>
}
```

and `applyStalls` discards the `code` it asks for (spec:492-497) — a failed probe takes the
`continue` with nothing recorded anywhere. The only `record` call in the design is in the deliveries
loop (spec:523), and the design's own P2 argument is that a stalled run produces **no deliveries**:
`addPending` returns early on `text.length === 0 && eventLines.length === 0` (`main.ts:159`) and
`deliveriesFor` re-checks it (`deliver.ts:53`) — quoted by the spec itself at spec:90-92. So for a
live-but-unpromptable pane (`agent_blocked`, `unparseable` — both in `RETRYABLE`,
`deliver.ts:76`), the budget stays empty forever, `accepts` stays `true` forever, the counter is
never bumped (A6) so the candidate stays due, and the probe is re-sent **every tick — once per
second, indefinitely**. That is BLOCKER 1 of pass 0 reappearing on the failure path, and it is the
case MAJOR 6 was raised about. A19 does not cover it: this pane is *in* `paneList`.

**Fix.** Add `record: (paneId: string, sent: { ok: boolean; code?: string }) => void` to
`StallDeps` and call it after every probe and escalation send, or state explicitly that the `probe`
and `escalate` callbacks in `main.ts` call `budget.record` themselves and give `escalate` a result
type that can carry the failure. Then add the test: a probe that keeps failing stops being sent
after `PROMPT_RETRY_MAX`.

---

## MAJOR 4 — the budget gate suppresses the escalation *state transition*, not just its prompt, and checks the wrong pane

**Claim.** spec:490: `if (!deps.accepts(c.paneId)) continue   // A11`, placed at the top of the
loop, before the action switch. A9 (spec:534-535): the escalation prompt is "send to
`run.orchestrator_pane`".

**Problem, two parts.**

*Wrong thing gated.* Escalation is two separate acts: a ledger transition to `escalated` (which is
what makes `hpipe status` show the ⚠ line of **A15**, and what Goal 1 promises a human) and a
courtesy prompt. spec:490 gates both on the send channel. So a pane the budget has abandoned — the
dead-orchestrator case — means the task is never marked escalated, never surfaces in status, and
sits silently. The design already accepts the opposite ordering everywhere else: A22 is "ledger
before send", and the error table (spec:543) says an escalation whose prompt is rejected is fine
because "the transition is already persisted; `hpipe status` shows it". spec:490 makes that row
unreachable.

*Wrong pane.* `c.paneId` is `probePaneFor`'s result — the worker's own pane for an artifact/pr/verdict
row (`stall.ts:24`, pinned by `test/stall.test.ts:141-145`). The escalation prompt is sent to
`run.orchestrator_pane`. So on the escalate branch, the budget is consulted about a pane the send
will not use, and not consulted about the pane it will. This is the same wrong-pane class as
pass-0's MAJOR 5, which the spec fixed for `agentStatus` (via `actorPaneFor`) and left in place one
line above.

**Fix.** Move the gate inside each branch: `probe` checks `accepts(c.paneId)`; `escalate` performs
the transition and `persist` unconditionally, then checks `accepts(run.orchestrator_pane)` before
rendering and sending `stall-escalate`. Add the test: an abandoned pane still produces the
`escalated` transition and the status warning, with no send.

---

## MAJOR 5 — the `livePanes.size > 0` guard exists only in prose; the pseudocode omits it in both places, so one failed `pane list` freezes every run

**Claim.** Error handling (spec:549): "`paneList` fails | Returns `[]` (`herdr.ts:60`) → **every**
run looks unreachable | **Named risk.** Guarded: **A19** suppresses only when `livePanes.size > 0`,
mirroring `status.ts:99`", reinforced at spec:554-557: "**`paneList` returning `[]` is the one new
failure mode this design introduces** … A herdr hiccup must not silently freeze every run."

**Problem.** Neither operative line carries the guard:

```
spec:521  if (run.orchestrator_pane && !livePanes.has(it)): log once, continue     // A19
spec:524  reachable = runs.filter(r => !r.orchestrator_pane || livePanes.has(r.orchestrator_pane))
```

`Herdr.paneList` swallows every failure into `[]` (`herdr.ts:56-61`: `return res.result?.panes ?? []`),
so a socket hiccup makes both predicates false for every run with a pane. An implementer following
the "One tick, end to end" block — which is the section written to be implemented — ships the
unguarded version, and the design's one named new failure mode becomes live. While the herdr socket
is down this is not a one-tick blip: it persists for as long as the call keeps failing, and under
**BLOCKER 1**'s whole-run `continue` it freezes every run in the session, probes included.

**Fix.** Put the guard in the code, once: `const panesKnown = livePanes.size > 0`, and use
`panesKnown && run.orchestrator_pane && !livePanes.has(run.orchestrator_pane)` in both places. Add
the test the spec already names ("with `livePanes` empty, nothing is suppressed", spec:596) and make
sure it exercises the pseudocode's predicate, not the prose's.

---

## MAJOR 6 — the `stall_probes` reset list is not exhaustive: `cmdResume` is a third `phase_entered_at` bypass

**Claim.** spec:440-442: "Reset wherever `phase_entered_at` is set: `enterRunPhase`
(`machine.ts:45-51`), `enterTaskPhase` (`machine.ts:90-96`), and `cmdRewind` (`cli.ts:177-194`),
which bypasses both." A23's first ruling item (spec:388-393) argues the `cmdRewind` reset is
mandatory because a record whose counter is already at the cap "would escalate on the first due tick
instead of re-arming".

**Problem.** There are four sites, not three:

```
$ grep -rn "phase_entered_at *=" src/
src/cli.ts:180        task.phase_entered_at = Date.now()   # cmdRewind, task branch
src/cli.ts:186        run.phase_entered_at  = Date.now()   # cmdRewind, run branch
src/cli.ts:317        run.phase_entered_at  = Date.now()   # cmdResume  ← not in the list
src/lib/machine.ts:49 run.phase_entered_at  = Date.now()
src/lib/machine.ts:94 task.phase_entered_at = Date.now()
```

`cmdResume` (`cli.ts:304-319`) restores an aborted run to `run.escalated_from` and restamps
`phase_entered_at` without touching any counter. A run aborted out of `branch-review` after three
unanswered probes carries `stall_probes: 3`; on resume the ladder's own arithmetic
(`now - phase_entered_at >= 15 × (3 + 1)`) fires `action: 'escalate'` 60 minutes later **without a
single probe**, and a run in `escalated` is `releasesPane: true` (`phases.ts:70-71`) so
`pickOneAdvance` skips it until a human runs `hpipe rewind`. That is A23's own argument, applied to
a site A23 did not enumerate. The `delivery_attempts` precedent does not cover it: that field is
`Task`-only (`types.ts:78`) and `cmdResume` touches only the run.

**Fix.** Add `run.stall_probes = 0` at `cli.ts:316-317`, list `cmdResume` in the reset enumeration,
and assert it in `test/cli-commands.test.ts` beside the `cmdRewind` assertions. `src/cli.ts` is
already inside the A23 ruling, so this widens nothing.

---

## MINOR 7 — A22 states an ordering the design deliberately does not follow on the probe path

A22 (spec:189, :228-233): "**The ledger write precedes every send**, on the probe path as well as
the escalation path … called **after the mutation and before the next candidate**." The code sketch
does the opposite, and must: A6 makes the bump conditional on the send having succeeded, so
spec:492-496 sends first, then bumps, then persists. The consequence is benign and already recorded
(spec:551: `persist` throws → "counter lost, probe re-sent next tick"), but A22 as worded is false
for half the paths it names, and it is a labelled assumption an implementer will try to honour.
Reword to "the ledger write precedes the **next** send, and precedes the escalation send".

## MINOR 8 — A6 and A20 contradict each other, and the escalation reason inherits the contradiction

A6 is carried forward unchanged in the assumption table (spec:174): "The counter increments only on
a probe herdr accepted." A20 (spec:187, :320-326) increments it on a *hold*, with no send at all,
and the field comment concedes it (spec:436: "Stall probes sent, plus escalation holds"). The
escalation reason string then misreports: `enterTaskPhase(run, task, 'escalated', 'N stall probes
unanswered')` (spec:533) writes N into `run.history`, where N counts holds as probes — a worker held
at `working` for six hours reports probes that were never sent. Either restate A6 ("the counter
advances only on an accepted probe **or a hold**") or keep a separate hold count, and derive the
reason string from probes actually sent.

## MINOR 9 — `This is probe {{probe}} of {{probe_max}}` is false for every row A18 excludes

A13 (spec:383-384) replaces `stall-probe.md:7` with `This is probe {{probe}} of {{probe_max}}.`, and
`probe` is the 1-based `stallProbesFor(record) + 1` (spec:469-471). For an A18-excluded row the
design is explicit that the counter keeps rising and the action stays `'probe'` forever
(spec:473-474). So a task parked in `blocked-on-decision` overnight is told "This is probe 9 of 3",
and the sentence promises a bound that, for that row, does not exist. The spec makes a point of the
prompt not claiming something untrue two lines later (spec:384-386). Render the ratio only for
escalation-eligible rows, and for the rest say plainly that this is a standing nudge.

## MINOR 10 — MINOR 11's fix left the contradiction it was raised about

spec:372: "`ci`, `merged`, `closed` and **`worktree`** fall through to the default until #19 names
them." The table eleven lines above gives `worktree` its own row (spec:366): `a worktree adopted for
a dispatched task`. `worktree` is the signal of run `dispatch` (`phases.ts:54`) **and** of task
`teardown` (`phases.ts:124`), and #19 — whose body is explicit about it — will make `teardown`
stallable. A stalled `teardown` would then be told it is waiting for a worktree to be *adopted*,
when it is waiting for one to be *removed* (`runTeardown`, `teardown.ts:25`). Either key that row on
signal-plus-record (run → adopted, task → removed) or drop it to the default and delete the
sentence that claims it already is the default.

## MINOR 11 — residual citation and upstream drift

- spec:220: "`main.ts:113` calls `listRuns`" — `main.ts:113` is `drain(queueDir)`; `listRuns` is
  `main.ts:114`. (Inherited from pass 0, which made the same slip.)
- The Scope boundary omits three files the design edits that no list mentions at all:
  `src/lib/config.ts` (`STALL_PROBE_MAX`, spec:445), the new `prompts/stall-escalate.md`, and
  `test/phases.test.ts` (**A21**) — the last of which is the file #19 will have to edit to widen the
  stallable set. Nobody holds them, so there is no collision; the list simply should be complete
  after A23 made completeness the point.
- The research note this spec "builds on" still carries the causal claim P2 withdraws: "'Giving up'
  is not sticky — it is a 5-tick cycle repeated forever, which is consistent with 33 further
  deliveries into a dead pane"
  (`docs/superpowers/research/2026-09-17-issue-15-research.md`, §2, "The dead-orchestrator half").
  The spec disproves it (spec:85-97) but does not say the note is superseded, so the next reader
  starts from the disproved premise.

---

## What is right, and should survive another revision

Checked, not padding:

- **BLOCKER 1's fix is correct where it applies.** `persist` on the accepted-probe path closes the
  re-read hole: `listRuns` does `readJson` per file every tick (`ledger.ts:48-62`), `saveRun`
  serialises the whole `Run` including `tasks` (`ledger.ts:44-46`), and the candidate's `task` is
  the same object inside `c.run.tasks` (`stall.ts:71-86`), so one `saveRun(c.run)` carries a task
  bump. The named regression test (bump → persist → re-load through `listRuns`) is the right test.
- **A18 is well chosen and fully verified.** Every signal in its table resolves, `blocked-on-files`
  and `blocked-on-decision` are correctly excluded for the reasons given (`machine.ts:186-189`,
  `gating.ts:6-8`, `:34-38`, `phases.ts:131`), and MAJOR 7 genuinely dissolves: run `dispatch` is
  `worktree` and run `execute` is `gate`, so neither can escalate. The `stallWhen` precedent
  (`phases.ts:32-39`) is the right one to cite.
- **A21's assertion is exactly right.** `TASK_ROWS.filter(r => r.stallable)` is precisely the ten
  phases listed, and `RUN_ROWS` precisely the three — I compared them row by row against
  `phases.ts:89-141` and `:51-73`.
- **A7/A20's actor-pane fix is correct**, including the `'unknown'`-fails-open reasoning
  (`herdr.ts:68-70`) and the deliberate `!== 'working'` rather than `isAgentReady`
  (`machine.ts:30-32`).
- **MAJOR 4's diagnosis and fix are right.** `render` is a single `String.replace` whose replacement
  text is never re-scanned and whose throw inspects only template placeholders (`render.ts:8-14`),
  and `renderPrompt` injects `hpipe` at `render.ts:46` — so a `{{hpipe}}` arriving inside a *value*
  would indeed ship verbatim. Passing `hpipeCommand(pluginRoot)` into `stallAwaiting` fixes it.
- **P3/P3b remain correctly diagnosed**, and A19's `paneList` premise checks out: `herdr pane list`
  takes `--workspace` as an *option* and returns panes across all workspaces, so a global
  `livePanes` is sound.
- **The "Live verification — not optional" section** is again the right instinct, and step 2 (read
  the run JSON off disk between probes) is exactly the check that would have caught pass 0's
  BLOCKER 1.

VERDICT: BLOCKER
BLOCKERS: 2
MAJORS: 4
