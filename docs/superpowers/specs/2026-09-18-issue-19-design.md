# Design — issue #19: the last mile is not stallable

Pass 0. No review exists for this issue yet (`ls docs/superpowers/reviews/ | grep 19` → nothing), so
there is no *What changed* section.

Builds on `docs/superpowers/research/2026-09-18-issue-19-research.md`. Every claim below about
current behaviour is either a `file:line` verified in this worktree today or the quoted output of a
script run against the shipped code; where the research note already established something, this
spec cites the note's section rather than repeating the evidence.

**Modelled on `docs/superpowers/specs/2026-09-17-issue-15-design.md`** — the immediately preceding
design for this same subsystem, which built the ladder this issue widens. Its section order, its
labelled-assumption table, its failure table and its "live verification is not optional" clause are
reproduced here deliberately. Where this spec departs from it, the departure is named.

Baseline re-verified on this branch at `839dde1`: `bun test` → **454 pass / 0 fail**, 34 files;
`bun run typecheck` → clean.

---

## Scope

**In scope:** `stallable` on the five last-mile rows; the `probeTarget` each needs to satisfy
`table.test.ts:30-37`; the `stallAwaiting` branches those rows require; the two pinned-set tests;
a guard for the dead `stallWhen` field; `test/integration/smoke.md` §4c.

**Out:** `hpipe status` (**#14**, which claims *"PRs parked in `merge` awaiting a human"* verbatim);
widening `ESCALATING_SIGNALS` (**NG1**); bounding probe sends (**#25**); the undeliverable-probe rung
(**#32**); the digest footer (**#13**, shipped).

### Files

The sibling task in this batch (#21) holds `src/cli.ts`, `src/lib/ledger.ts` and the cli tests
(`test/cli.test.ts`, `test/cli-argv.test.ts`, `test/cli-commands.test.ts`). **None of them appears
below.**

| File | Change | Basis |
| --- | --- | --- |
| `src/lib/phases.ts` | five rows gain `stallable`, three gain `probeTarget` | routed here by #15's spec `:48`, `:138` and by #13's Scope ruling |
| `src/supervisor/stall.ts` | `stallAwaiting` gains four branches | required by **P2** below |
| `test/phases.test.ts` | the two pinned sets | `:49` is named *"widening it belongs to #19"* |
| `test/table.test.ts` | one new structural guard | **A9** |
| `test/stall.test.ts` | new coverage | — |
| `test/integration/smoke.md` | §4c only (`:351-364`) | **A10** |

**Never edited:** `src/cli.ts`, `src/lib/ledger.ts`, `src/lib/status.ts` (#14),
`src/supervisor/tick.ts` (#13, shipped), `src/lib/machine.ts`, `src/lib/config.ts`, `prompts/*`.

---

## Problem

### P1 — five rows are unreachable by the ladder, and they are the ones that wait on people

`taskStallCandidates` gates on one boolean — `if (!row.stallable) continue` (`stall.ts:101`) — and
`ci`, `merge`, `close`, `teardown` (`phases.ts:118-124`) and the task `escalated` row
(`phases.ts:130-131`) do not carry it. A task that reaches `merge` therefore produces no probe, no
escalation, and a `hpipe status` line identical to every other (`status.ts:130-141` prints
`task_id branch #issue [phase] agent_status` and `taskWarnings:17-67` has no case for any of these
five).

Measured on the berean-os run of 2026-09-16 and quoted in #13's Scope ruling: t3 sat in `merge` for
**4h57m**, of which **3h55m (79%)** fell inside a zero-transition window; two such windows covered
**86%** of the run's 20h02m span. #13's footer (`tick.ts:119-139`) reports parked tasks only on ticks
that already emit a digest — `tick.ts:113-117` says so in the code — which on that run was about one
hour of the 4h57m. The ruling names this issue as where the remaining gap closes.

### P2 — three of the five have nothing true to say, and one has something false to say

Executed against the shipped `stallAwaiting` (research §4, verbatim output):

```
ci      → "This phase is waiting for whatever clears ci."
merge   → "This phase is waiting for whatever clears merge."
close   → "This phase is waiting for whatever clears close."
escalated → "This phase is waiting for an answer to the open decision."
```

The first three are the `:218` fallback. The fourth is the `:204` `manual` branch, which
`escalated` shares with `blocked-on-decision` — an escalated task would be probed about a decision
it never asked. The comment at `stall.ts:154-158` claims *"Keyed on `row.signal` … so #19 making
more rows stallable needs no change here."* **That claim is false and this issue disproves it.**

### P3 — two of the five can never clear at all, and nothing says so

- `ciTransitions` skips a `ci` row whose `task.pr === null` (`ci.ts:12`), so CI is never polled and
  the row cannot advance.
- `gatherSignals`' `merge` case returns `base` when `task.pr === null` (`tasks.ts:278`), so
  `s.merged` is never true and `machine.ts:165-171` never fires.

Both are permanent deadlocks that today look exactly like a slow CI run or an unhurried human.

### P4 — a parked `teardown` is the only visible trace of a throwing tick

`runTeardown` (`teardown.ts:17-41`) is unconditional and exits the row to `done` or `orphaned` on its
first pass, and it is called *first* in `advanceTasks` (`tasks.ts:137`). `Herdr`'s methods are
documented never to throw (`herdr.ts:32-33`). So a task sitting in `teardown` past a threshold means
the run's per-tick block threw before reaching it — `rebindOrchestrator` (`main.ts:179`) or
`evaluateRun` (`main.ts:182`) — and was swallowed by the per-run `catch` at `main.ts:243-245`, whose
only output is a `console.error` into the supervisor's own pane. Nothing routes that anywhere.

The two ways a `teardown` can sit *without* a fault both already produce no candidate, so the row is
self-consistent: a run with no `orchestrator_pane` is skipped by `pickOneAdvance` (`tick.ts:241-243`)
**and** yields `paneId === null` in `probePaneFor`, which `candidateFor:56` rejects; a run in a
`releasesPane` phase is skipped by `pickOneAdvance` **and** by the A26 guard (`stall.ts:98`).

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
dependent to `blocked-on-failure`.

**Non-goals.**

- **NG1 — no row becomes escalatable.** `ESCALATING_SIGNALS` (`stall.ts:22`) is untouched. See **A2**.
- **NG2 — no `hpipe status` change.** #14 owns it and names the `merge` case explicitly; it also
  carries the batch-2 ruling to move `ageMinutes`/`actionFor` into `src/lib/`, which this issue must
  not pre-empt.
- **NG3 — no digest/footer change.** `parkedFooter`'s predicate is *whose move is it*
  (`tick.ts:126-129`): `merge`, `close` and `escalated` already qualify; `ci` and `teardown` are
  nobody's move, so the footer is right to omit them and the ladder is the correct channel for them.
- **NG4 — no new config knob.** See **A8**.
- **NG5 — no bound on probe count for these rows.** See **A7**; **#25** owns bounding sends.
- **NG6 — `queued` stays unstallable.** A `queued` task behind a broken dependency is moved to
  `blocked-on-failure` by `gateStatus`/`advanceTasks` (`gating.ts:34-38`, `tasks.ts:141-146`); behind
  a live one it is correctly waiting, and after this change the holder's own row is what speaks.
- **NG7 — `stallWhen` is not plumbed into `taskStallCandidates`.** See **A9**.
- **NG8 — no schema change.** `schema_version` stays `2`; see **Ledger drift**.

---

## Assumptions

Every behavioural decision, labelled for attack. **A2, A5 and A7 are the three most attackable** and
are argued at length below.

| # | Assumption |
| --- | --- |
| A1 | All five rows — `ci`, `merge`, `close`, `teardown`, task `escalated` — become `stallable: true`. |
| A2 | **`ESCALATING_SIGNALS` is not widened.** All five stay probe-only, forever. |
| A3 | `ci`, `teardown` and `escalated` also carry `probeTarget: 'orchestrator'`; `merge` and `close` do not. |
| A4 | The probe cadence is `TASK_STALL_MINUTES` (45), unchanged and shared with every other task row. |
| A5 | The task `escalated` row is stallable, and its probe is addressed to the orchestrator as the human's relay. |
| A6 | `stallAwaiting` gains a `row.actor === 'human'` branch placed **before** the `manual` branch, and three signal branches (`ci`, `merged`, `closed`). |
| A7 | The standing nudge stays **unbounded** — no cap on `probes` for a non-escalatable row. |
| A8 | No new config key. |
| A9 | `stallWhen` is left dead and guarded by a table test asserting no task row carries one. |
| A10 | `test/integration/smoke.md` §4c is updated in this change; no other section is touched. |
| A11 | `prompts/stall-probe.md` is **not** edited; all new wording lands in `stallAwaiting`'s clause. |
| A12 | A clause names a concrete command where one exists, rendering `hpipe` from the already-rendered argument. |
| A13 | The `pr === null` deadlocks (**P3**) are reported by the clause, not fixed. |
| A14 | The `:218` fallback branch is kept, and its test becomes a characterisation test. |
| A15 | `holdsFiles` is unchanged on all five rows. |

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

**A1** is the whole of the issue's first Direction: the five rows named in the title and body of #19
gain `stallable: true`, and nothing else about them moves.

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
  // past the threshold is a tick throwing before it — a fault whose only other
  // trace is a console.error in the supervisor's own pane.
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
`close`, whose actor does resolve, would be noise.

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

**This is the whole reason the brief's "blast radius" concern does not bite.** `merge` and `close`
wait on a human by design; escalating them would move a correctly-parked task into `TERMINAL_BAD`
and break its dependents — which #15's spec `:693` already rejected in general terms. `escalated`
would escalate to itself. `ci` waits on GitHub. `teardown` waits on the supervisor. None of the five
has an actor who could answer a threat.

Measured, driving the real `taskStallCandidates` + `applyStalls` minute-by-minute across t3's actual
4h57m park with `merge` flipped stallable, at shipped defaults (research §4):

```
probes over a 4h57m merge park: 6 at minutes [ 45, 90, 135, 180, 225, 270 ]
final phase: merge stall state: {"at":0,"run_at":0,"last_probe_at":16200000,"probes":6,"holds":0}
```

Six nudges, no escalation, the task still in `merge`. That is the complete behavioural delta.

### A5 — why the escalated row is probed, and why the orchestrator is the right recipient

The objection is real: an escalated task waits on a person, and probing the orchestrator nags an
agent that cannot resolve it. Three facts answer it.

1. **It is the only push channel that row has in the window that matters.** `hpipe status` is
   pull-only. #13's footer rides digests, and a run whose only live task is escalated generates no
   pane events, so it produces no digests at all — the 3h55m zero-transition case exactly.
2. **The run-level ladder does not cover it.** `execute`'s `stallWhen` requires `!intake_closed`
   (`phases.ts:58-59`); with intake closed and one task escalated among live siblings the run is not
   a candidate, and once every task is settled `advanceRun` moves the run out of `execute` entirely
   (`machine.ts:68-73`). There is no window in which the run speaks for the task.
3. **An escalated run's tasks are still excluded.** A26 (`stall.ts:98`) skips every task of a run in
   a `releasesPane` phase, and run `escalated` is one (`phases.ts:70-71`). #15's spec `:293` states
   the rule: *"an escalated run's tasks must not be escalated out from under the human."* This change
   does not touch it.

The orchestrator is the recipient because `probePaneFor` has nowhere else to send it and because the
orchestrator is the pipeline's relay to the human everywhere else — `escalate.md` and
`stall-escalate.md` are both addressed there, and `stall-escalate.md:6-10` asks it to *"Summarise for
the human."* The clause (**A6**) asks it to do that again, and re-prints the rewind command.

### A6 — `stallAwaiting`, the four new branches

`stallAwaiting` keeps its signature (`stall.ts:161`) and its total-function shape. The
human-owned branch goes **first**, because `escalated` and `blocked-on-decision` share
`signal: 'manual'` and order is the only thing that separates them.

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
    if (task.pr === null) return sentence('a PR number this task never recorded, so CI is never polled')
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
    if (task.pr === null) return sentence('a PR number this task never recorded, so no merge is ever seen')
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

and the existing `worktree` task branch gains one sentence, keeping its `short` byte-identical so
`test/stall.test.ts:304` still passes:

```ts
      ? { short: 'its worktree to be removed',
          clause: "This phase is waiting for this task's worktree to be removed. Teardown is " +
            'unconditional and runs first in every tick, so a task still here means the tick is ' +
            "throwing before it — check the supervisor pane's log." }
```

Three properties of these branches, each deliberate:

- **The commands are the ones the phase prompts already print.** `gh issue view {{issue}} --json
  closed,state` is `close.md:5`; *"Merging is yours, not the plugin's; nothing merges
  automatically"* is `merge.md:9`; `gh pr checks <pr>` is the call `Gh.prChecks` makes
  (`gh.ts:63-64`). A probe that contradicted the phase prompt would be worse than the fallback.
- **`hpipe` is interpolated, never literal — A12.** `stallAwaiting` documents that its `hpipe`
  argument arrives already rendered because `render` never re-scans replacement text
  (`stall.ts:156-159`, `render.ts:8-14`); the `gate` branch already does exactly this
  (`stall.ts:212-216`). `test/prompts.test.ts:68-76` scans prompt *files* for a literal `hpipe`, so
  a clause composed in TypeScript is outside it — which is why **A11** keeps the wording here.
- **The `actor === 'human'` branch cannot fire on the escalation path.** `escalate` renders the text
  **before** the transition (`stall.ts:293-299`, contracted at `StallDeps:239-243`), so
  `task.phase` is still the pre-escalation phase when `main.ts:289` calls `stallAwaiting` for
  `awaiting_short`. Verified by reading both call sites; a test pins it.

**A6 contradicts a shipped comment.** `stall.ts:154-158` must be corrected in the same hunk — the
"needs no change here" sentence is now false, and leaving it would mislead the next reader precisely
where this issue found the bug.

### A9 — the dead `stallWhen`, guarded rather than plumbed

None of the five rows needs a "healthy while it waits" condition: `ci`, `merge` and `close` are
parked or they are not, and **P4** shows `teardown`'s two benign cases are already excluded twice
over by `probePaneFor` and by A26. So this issue does not need the mechanism, and #15's precedent —
*"a second knob for a bound with no reason to differ"* (`:696`) — argues against building one
speculatively.

But leaving a declared field that is silently ignored on half the table is the trap this issue's
research walked into. The cheap, honest guard is a structural test beside the others in
`table.test.ts`, which already holds exactly this kind of invariant:

```ts
test('no task row carries a stallWhen — taskStallCandidates never reads one', () => {
  // stallCandidates consults it (stall.ts:83); taskStallCandidates does not
  // (:99-104), and its declared parameter is run-shaped (phases.ts:39). A task
  // row given one today would be silently ignored, so make that fail loudly.
  expect(TASK_ROWS.filter((r) => r.stallWhen).map((r) => r.phase)).toEqual([])
})
```

This is the one piece of the change that is not strictly required by the issue. It is called out
here so a reviewer can cut it on its own.

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

**Persisted shape.** `StallState` is written to the `Task`, exactly as for the ten rows already
stallable. No new field.

**A15 — file gating is untouched.** All five rows keep `holdsFiles: true`, so `isInFlight`
(`gating.ts:23-29`) and `releasableFromFiles` behave identically; a probe is a prompt, and nothing
on the stall path reads or writes `holdsFiles`. A parked `merge` holds its files exactly as long as
it did before, which is what `status.ts:46-63`'s release advice assumes.

### Config

None. **A8.** **A4** keeps these five rows on the same `TASK_STALL_MINUTES: 45` cadence as every
other task row rather than giving a parked row its own: `TASK_STALL_MINUTES` and
`STALL_PROBE_MAX: 3` (`config.ts:28-29`) are reused unchanged;
`STALL_PROBE_MAX` is read only on the escalate path, so for these five rows it affects nothing but
the `ladderFor` sentence, which does not quote it for a non-escalatable row (`stall.ts:227-229`).

### Ledger drift

`stallable`, `probeTarget` and `stallWhen` are read at tick time and never serialised —
`grep -rn "stallable\|probeTarget\|stallWhen" src` returns only `phases.ts`'s declarations and
`stall.ts:14`, `:82-83`, `:101`. `schema_version` stays `2`, and a run already on disk picks the new
behaviour up on the next tick with no migration. **The self-hosting hazard still applies:** this
is a `phases.ts` change, and the installed plugin is a GitHub install pinned to a tag, so the running
supervisor keeps the old table until the release lands.

---

## Error handling

| Failure | Behaviour | Why |
| --- | --- | --- |
| `run.orchestrator_pane` is `null` on a parked `merge`/`ci`/`teardown`/`escalated` | No candidate at all (`stall.ts:56`) | `probePaneFor` has no fallback for these rows; a run with no pane is also skipped by `pickOneAdvance` (`tick.ts:241-243`), so the whole run is dark and **#24**/#14 own that, not the ladder |
| `agentPrompt` rejects the probe | No bump, no persist, still due next tick — retried every tick, unbounded | Unchanged behaviour (`stall.ts:264`); **#32** owns whether an undeliverable probe should be a rung, **#25** whether it should be bounded. Widening the set adds five rows to that population and changes neither defect |
| A parked row is probed forever | By design (**A7**) | `ladderFor:227-229` says so in the probe itself |
| `task.pr === null` in `ci` or `merge` | Clause names the permanent deadlock (**A13**) | **P3**; fixing the deadlock is a machine change this issue does not own |
| `task.escalated_from` is `null` on an escalated task | Clause renders `<phase>` | Same placeholder `status.ts:25` and `tick.ts:37` already use |
| Run is `escalated` or `done` | None of its tasks produce candidates | A26 (`stall.ts:98`), unchanged |
| A task advances out of `merge` in the same tick | `phase_entered_at` re-stamped before `stallStateFor` reads it; not due for a full threshold | The pre-existing race #15 documents; ordering above |
| Supervisor restarts with a task hours into `merge` | Exactly one probe, then paced from `last_probe_at` | A29 of #15, unchanged — this is why widening the set cannot produce a burst |
| Both the run's `execute` ladder and a task's `escalated` ladder are due | Two prompts to the same pane, 15m and 45m cadences | Possible only while intake is open (`phases.ts:58-59`); accepted as noise, not suppressed — suppression would need cross-record state the ladder does not have |
| `stallAwaiting` reaches a signal with no branch | `whatever clears <phase>` (`stall.ts:218`) | Kept (**A14**); after this change only `registration` can reach it, and no `registration` row is stallable |

---

## Testing strategy

Baseline to hold: **454 pass / 0 fail**, `tsc --noEmit` clean. TDD throughout — each pinned-set test
is edited to its new value *first*, watched to fail, then `phases.ts` is changed.

### Tests that must fail before the change

- `test/phases.test.ts:49-56` — named *"the stallable set is exactly what #15 assumed — widening it
  belongs to #19"*. Renamed and updated. New values, computed from the table:

```ts
  expect(TASK_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort()).toEqual([
    'blocked-on-decision', 'blocked-on-files', 'ci', 'close', 'escalated', 'implement',
    'merge', 'plan', 'plan-review', 'pr-review-intent', 'pr-review-quality', 'research',
    'spec', 'spec-review', 'teardown',
  ])                                                    // 10 → 15
  expect(RUN_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort())
    .toEqual(['branch-review', 'dispatch', 'execute'])  // unchanged — the run table is untouched
```

- `test/phases.test.ts:58-62` — the probe-only set, in table order, 4 → 9:

```ts
  expect(probeOnly).toEqual(['dispatch', 'execute', 'blocked-on-files', 'ci', 'merge',
    'close', 'teardown', 'blocked-on-decision', 'escalated'])
```

  Nine probe-only against nine escalating, eighteen stallable rows in total. The escalating list is
  unchanged, which is **A2** expressed as an assertion.

- `test/stall.test.ts:307-315` — *"an unrecognised signal falls back to naming the phase"* uses `ci`
  as its example, and `ci` is recognised after **A6**. Rewritten against a synthetic row, and
  labelled a characterisation test: after this change no *reachable* row hits `:218`. The precedent
  for keeping a defensive branch covered that way is `tick.ts:59-64`, which documents the identical
  situation for `describeWake`'s null-task arm.

### New coverage in `test/stall.test.ts`

- **Candidates.** Each of the five rows, aged past 45m, yields exactly one candidate whose `paneId`
  is the orchestrator pane — the shape of `test/stall.test.ts:54-58`, extended to five rows.
- **A2, the safety property, stated directly.** For each of the five: drive `applyStalls` well past
  `probeMax` and assert `action` is never `'escalate'`, the phase never becomes `'escalated'`, and
  `escalatable` is `false`. This is the test that would catch someone widening
  `ESCALATING_SIGNALS` later.
- **The measured regression.** The 4h57m `merge` park, replayed minute-by-minute with an injected
  clock: exactly 6 probes at 45-minute spacing, no escalation, phase still `merge`. The script in
  research §4 becomes this test verbatim.
- **A6 clauses**, per branch: `merge` names the PR number, the branch and *"nothing merges
  automatically"*; `close` names `gh issue view <n> --json closed,state`; `ci` names
  `gh pr checks <pr>`; `teardown`'s `short` is unchanged while its clause gains the diagnostic.
- **A6/P2's false sentence, as a regression.** An escalated task's clause contains neither
  `open decision` nor `an answer to`, does contain `rewind`, and renders the run id and
  `--task <id>`; a `blocked-on-decision` task still returns `'an answer to the open decision'`
  (pinning `test/stall.test.ts:303` against the reordering).
- **A12.** A clause built with `'bun run /p/src/cli.ts'` contains that string and no `{{`, mirroring
  the `gate` assertion at `:287-290`.
- **A13.** A `ci` row and a `merge` row with `pr === null` each return the deadlock sentence, not the
  PR-number sentence.
- **A6's ordering invariant.** `stallAwaiting` called with a task still in `merge` (the state
  `escalate` renders in, `stall.ts:293-295`) returns the merge clause, not the human-owned one.
- **A26 still holds for the new rows.** A task in `merge` inside a run whose phase is `done` or
  `escalated` yields no candidate.

### `test/table.test.ts`

The **A9** guard, plus the existing `:30-37` probe-target test now covering three more rows with no
edit — which is the point of **A3**.

### Unchanged by construction

`test/machine-task.test.ts`, `test/teardown.test.ts`, `test/ci.test.ts`, `test/tasks.test.ts`,
`test/tick.test.ts`, `test/status.test.ts` — none asserts anything about `stallable`
(`grep -rn "stallable" test/` hits only `phases.test.ts`, `table.test.ts`, `stall.test.ts`), and no
transition, prompt or status line changes. `test/prompts.test.ts` is untouched because **A11** edits
no prompt file. If any of these does fail, that is a finding, not a test to patch.

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
7. A `ci` row whose PR was deleted: the probe reports the deadlock rather than a slow CI run
   (**A13**).

Treat any difference between this and `smoke.md` as a finding rather than a test to make pass.

### Operator docs — A10

`test/integration/smoke.md` §4c (`:351-364`) enumerates the probe-only rows by name at `:359-361`
and goes stale the moment the table changes. The paragraph is rewritten to the new nine and to say
why the last mile is probed but never escalated. **Only §4c is edited** — the recovery table
(`:530-534`) needs no change, since no new escalation path exists. No ownership ruling covers
`smoke.md` in this batch and #21's declared files do not include it.

---

## Rejected alternatives

- **A distinct "parked, awaiting human" treatment in `status`/the digest** — the issue's second
  Direction. Rejected as **not this issue's**: #14 claims *"PRs parked in `merge` awaiting a human"*
  verbatim and additionally owns moving `ageMinutes`/`actionFor` into `src/lib/`. Doing it here would
  write a fourth copy of the age arithmetic into a file #14 is about to restructure.
- **Making `merge` and `close` escalatable** so a park eventually ends in `escalated`. Rejected: they
  wait on a human by design, `escalated` is in `TERMINAL_BAD` (`gating.ts:6-8`), and escalation would
  cascade every dependent to `blocked-on-failure` for the crime of a slow human. #15's spec `:693`
  already rejected this in general.
- **A cap on the standing nudge** (stop probing after N). Rejected as **A7**: `blocked-on-decision`
  has been probe-only and unbounded since #15 in exactly this shape, and a row that stops nudging is
  a row back in the silence this issue exists to end. Wrong-but-loud beats right-but-quiet here.
- **A longer interval for parked rows** — a second threshold. Rejected as **A8**, on #15's own
  reasoning about `STALL_HOLD_MAX` (`:696`): a second knob for a bound with no reason to differ.
- **Plumbing `stallWhen` into `taskStallCandidates`.** Rejected as **A9/NG7**: no row here needs it,
  its parameter is run-shaped, and a mechanism built for no caller is the speculation the guard test
  replaces at a twentieth of the cost.
- **Rewriting `prompts/stall-probe.md`** to address a parked row directly. Rejected as **A11**:
  #15 deliberately made `{{awaiting}}` a whole paragraph *"so the template asserts nothing about its
  shape"* (`stall.ts:148-149`), and the nine worker rows' wording was settled over three review
  rounds. The clause is the designed extension point.
- **Matching `escalated` by phase name rather than `row.actor === 'human'`** in **A6**.
  `tick.ts:126-128` chooses the opposite for `parkedFooter`, reasoning that *"a future human-owned
  row has to opt in here instead of inheriting this"* — correct there, because the footer is an
  opt-in list of who to bother. Here the question is what sentence describes the wait, and
  *"waits on the human"* is true of any human-owned row by construction. The divergence is
  deliberate and is named so a reviewer can overturn it.
- **Fixing the `pr === null` deadlocks** (**P3**) in `machine.ts`/`ci.ts`. Rejected as scope: this
  issue makes them audible (**A13**); making them impossible is a separate change to files this
  issue otherwise never touches.
- **Bumping `schema_version`.** Nothing is serialised; it would strand every in-flight run behind
  `hpipe abort` (`main.ts:32-34`).

---

## Open decisions

None. The one choice that could have gone to `hpipe decide` — whether the `status`/digest half of
the issue's Directions belongs here — is answered by #14's issue text naming the `merge` case as its
own, so it is a reading of an existing ruling rather than a new call.
