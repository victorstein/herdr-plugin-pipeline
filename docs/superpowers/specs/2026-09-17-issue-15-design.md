# Design — issue #15: the stall ladder

Revision after **Ruling 2 — 2026-09-17** (`gh issue view 15`) and
`docs/superpowers/reviews/issue-15-spec-review-1.md` (VERDICT: BLOCKER — 1 BLOCKER / 1 MAJOR /
5 MINORs). Every finding is accepted and fixed.

Scope is the **Scope narrowed** ruling: the ladder, and nothing else. Dead/unreachable pane
detection is **#24**; `DeliveryBudget` is **#25**.

Builds on `docs/superpowers/research/2026-09-17-issue-15-research.md`, **except that note's
"dead-orchestrator half" paragraph, which is superseded** — see *Superseded premises*.

Baseline re-verified: `bun test` → 351 pass / 0 fail; `bun run typecheck` clean.

---

## What changed

| Finding | Disposition |
| --- | --- |
| **BLOCKER 1** — the due rule compares an absolute age to a count, so a record first seen past its threshold climbs a rung per tick | **Accepted, fixed per Ruling 2.** **A29** persists `last_probe_at`; due is `now - last_probe_at >= threshold`. The `(probes + holds + 1)` multiplier is gone. Reproduced before fixing — see **P4**. |
| **MAJOR 2** — `cmdResume` never walks `run.tasks`, so a task's ladder does not re-arm across abort/resume | **Accepted, fixed with the same field**, as Ruling 2 directs. **A30**: the stall state is stamped with the **run's** phase entry as well as the record's, so `cmdResume`'s restamp (`cli.ts:317`) invalidates every task's state without `cmdResume` being edited. |
| **MINOR 3** — `applyStalls` reads `deps.probeMax`, undeclared on `StallDeps` | **Accepted.** Declared. |
| **MINOR 4** — `stall-escalate.md` uses `{{awaiting_short}}`, defined nowhere | **Accepted.** `stallAwaiting` now returns `{ clause, short }`; the escalation prompt takes `short`. |
| **MINOR 5** — `bumpStall`/`stallCountsFor` used but never defined or placed | **Accepted.** `StallState` is declared in `types.ts` (which holds only declarations — `grep -cE "^(export )?(function\|const\|class)" src/lib/types.ts` → `0`); the helpers live in `stall.ts`. Signatures given. |
| **MINOR 6** — A15's predicate unstated, and `escalated_from` is overloaded by `cmdAbort` | **Accepted.** `cmdAbort` sets `run.escalated_from = run.phase` then `run.phase = 'done'` (`cli.ts:298-299`), so the predicate is `phase === 'escalated'`, never `escalated_from !== null`. Stated. |
| **MINOR 7** — citation regressed | **Accepted.** The emptiness check is `deliver.ts:53`. |

**A2's constant interval is kept**, per Ruling 2: the defect was the anchor, not the interval.
**The parsimony argument for storing no timestamp is withdrawn and must not return** — it was
attacked in pass 0, blocked in pass 1, and overruled in Ruling 2.

Carried forward from the pass-1 review's *"What is right"*: **A26**'s run-phase guard and its
run-level asymmetry, **A13**'s template rewrite, **A27**'s bound and arithmetic, **A18**'s signal
table, **A21**'s stallable sets, **A28**'s writer enumeration, and the corrected `src/cli.ts` basis.

---

## Scope

**In scope:** the ladder (re-probe, persist, escalate at a cap); **A18**'s narrowing; **P2**'s
discarded artifact path; `prompts/stall-probe.md`; the counter resetting wherever `phase_entered_at`
is bypassed.

**Out, moved:** dead-pane detection → **#24**; `DeliveryBudget` and the `main.ts:234` reset bug →
**#25**; `phases.ts` → **#19**; artifact-path derivation → **#9**; `announceDecisions`' unbounded
retry (`tasks.ts:293-309`) → unfiled, named so it is not mistaken for handled. The escalation pane
tail (old A14) stays dropped.

### Files

`src/cli.ts` **is** declared by t1 (#9). The ruling knew that and permits a `cmdRewind` hunk,
conditioned on t1 merging first and this branch rebasing; "unheld" covers only `src/lib/types.ts`,
`src/lib/machine.ts` and `test/cli-commands.test.ts`. **A28**/**A30** leave that permission unused.

| File | Basis |
| --- | --- |
| `src/supervisor/stall.ts` | held by t2 |
| `src/supervisor/main.ts` | held by t2 |
| `prompts/stall-probe.md` | held by t2 |
| `src/lib/status.ts` | held by t2 — **A15** |
| `src/lib/types.ts` | unheld per the ruling — `StallState` only |
| `src/lib/config.ts` | declared by neither task |
| `prompts/stall-escalate.md` | new |
| `test/stall.test.ts`, `test/phases.test.ts`, `test/status.test.ts`, `test/config.test.ts`, `test/prompts.test.ts`, `test/integration/smoke.md` | declared by neither task |

**Never edited:** `src/cli.ts`, `src/supervisor/tasks.ts`, `src/supervisor/deliver.ts`,
`src/lib/worker-prompt.ts`, `prompts/worker-brief.md` (t1); `src/lib/phases.ts` (#19);
`src/lib/machine.ts`. `deliver.ts` and `machine.ts` are **imported** only —
`absoluteArtifactPath` (`deliver.ts:97-102`), `enterTaskPhase`/`enterRunPhase` (`machine.ts:45-51`,
`:90-96`). **A21** proves `phases.ts` is untouched.

---

## Problem

### P1 — one probe per phase entry, ever

`taskStallKey` is `${run_id}:${task_id}:${phase}:${phase_entered_at}` (`stall.ts:62-64`);
`taskStallCandidates` skips any key in `alreadyProbed` (`stall.ts:83`), the run-level at `:45`.
`sendProbes` adds it on a successful send (`stall.ts:101`). The backing set is a bare `Set<string>`
in `main()` (`main.ts:109`), never persisted — `saveRun` serialises the `Run` only
(`ledger.ts:44-46`) and `Task` has no probe field (`types.ts:44-80`). One probe, then silence.
`prompts/stall-probe.md:7` states it as a feature: *"it will not ask again for this phase."*

### P2 — the probe cannot name what it waits for

The run-level probe resolves a path (`main.ts:241`, `:247`); the task-level probe substitutes a
sentence (`main.ts:262-264`). `prompts/stall-probe.md:3` renders it under "nothing has appeared at:"
and `:9-10` says "move it to the path above", so a worker is told to move a file to a sentence.
**P2b:** `artifactPathFor(run, null)` has no null return (`deliver.ts:92-93`), so run `dispatch` and
`execute` name an invented `docs/superpowers/reviews/…` path and `main.ts:247`'s
`?? 'the expected artifact'` is dead. **P2c:** the template *asserts* the value is a path, so fixing
the value alone leaves the assertion false for seven of nine cases, `implement` included
(`phases.ts:109`).

### P3 — nothing stops the ladder at an abandoned run

`taskStallCandidates` gates only on the **task** row (`stall.ts:73-74`) and the supervisor passes it
every run (`main.ts:255`). `cmdAbort` sets `run.phase = 'done'` and deliberately leaves tasks live
(`cli.ts:292-302`). Harmless today — one probe ever — but under a ladder an aborted run's tasks are
probed forever and escalated.

### P4 — the schedule had no memory of when the last rung was climbed

The withdrawn rule was `now - phase_entered_at >= threshold × (probes + holds + 1)`: an absolute age
compared against a count, with nothing recording *when* a rung was climbed. A record first observed
past its threshold satisfies the predicate for every rung at once, and `applyStalls` climbs one per
tick at `TICK_MS: 1000` (`config.ts:23`). Reproduced at the shipped defaults against the incident's
own 780 minutes:

```
tick 1 (1s apart): due=true probes=0 -> probe
tick 2 (1s apart): due=true probes=1 -> probe
tick 3 (1s apart): due=true probes=2 -> probe
tick 4 (1s apart): due=true probes=3 -> ESCALATE
```

Three prompts and an `escalated` transition in four seconds, cascading dependents to
`blocked-on-failure` (`gating.ts:6-8`, `:34-38`) without the worker ever getting its 45 minutes. An
**A18**-excluded `blocked-on-decision` row, whose count is unbounded by design, takes seventeen
prompts in seventeen seconds into the orchestrator pane where today it gets one, ever.

**This is the state of every record after a supervisor restart** — routine recovery per
`smoke.md:479` — **and of every record on first deployment.**

---

## Goal / Non-goals

**Goal.** A stalled run or task is probed on a fixed cadence measured from its **last probe**
(**A29**), and — where escalation is meaningful (**A18**) and the run is still live (**A26**) —
moved to `escalated` within a bounded time (**A27**) and surfaced in `hpipe status` (**A15**). Every
probe names what the phase is waiting for, in a sentence true of what it names (**A13**).

**Non-goals.** **NG1** richer liveness (git-dirty) — declined; justification under **A27**.
**NG2** widening `stallable` → #19. **NG3** artifact-path derivation → #9. **NG4** dead-pane
detection → #24. **NG5** delivery retry budget → #25.

---

## Assumptions

| # | Assumption | Δ |
| --- | --- | --- |
| A1 | Escalation reuses the existing `escalated` phase. | — |
| A2 | **Constant** probe interval, not exponential backoff. | kept (Ruling 2) |
| A3 | `STALL_PROBE_MAX` defaults to `3`, reused as the deferral cap. | — |
| A4 | Ladder state is persisted via an injected `persist`. | — |
| A5 | State lives in one optional nested field, read through an accessor; `schema_version` stays `2`. | — |
| A6 | `probes` increments only on a probe herdr accepted. | — |
| A7 | Escalation is deferred while the row actor's own pane reports `working` — boundedly. | — |
| A8 | Probes are not deferred on `working`. | — |
| A9 | The escalation prompt goes to the orchestrator pane. | — |
| A10 | A new `prompts/stall-escalate.md`, taking `short` from **A13**. | amended (M4) |
| A13 | `stallAwaiting` returns `{ clause, short }`. | amended (M4) |
| A15 | `hpipe status` warns per escalated task **and** run, keyed on `phase === 'escalated'`. | amended (M6) |
| A16 | `stallKey`, `taskStallKey` and `alreadyProbed` are deleted. | — |
| A18 | Escalation only for `signal` ∈ `artifact`/`verdict`/`pr`. | — |
| A20 | A deferral advances `last_probe_at`, so re-checks happen once per `threshold`. | re-anchored (B1) |
| A21 | A test pins the exact stallable sets — the real NG2 guard. | — |
| A22 | Once the deferral gate passes, the transition and its `persist` are unconditional. | — |
| A25 | The ladder sentence is composed at the call site. | — |
| A26 | A task candidate is skipped when its run row is `releasesPane`. | — |
| A27 | Deferrals are capped, so escalation is bounded regardless of reported status. | — |
| A28 | State is self-invalidating on the record's own phase entry. | — |
| **A29** | **`last_probe_at` is persisted; due is `now - last_probe_at >= threshold`.** | new (Ruling 2) |
| **A30** | **State is also stamped with the run's phase entry, which re-arms a task's ladder on `hpipe resume`.** | new (M2) |

*Deleted: A11, A12, A14, A17, A19, A23, A24.*

---

## Architecture

### Modelled on

`delivery_attempts` (research note §4): a persisted counter on the record (`types.ts:78`), a config
cap (`PROMPT_RETRY_MAX`, `config.ts:13`, `:31`), plumbed through a `Deps` interface
(`tasks.ts:244-248`), checked/incremented/reset (`tasks.ts:260`, `:277`, `:282`), surfaced in
`hpipe status` (`status.ts:29-36`), documented for the operator (`smoke.md:281`). The escalation
transition is modelled on `advanceLoopingRow` (`machine.ts:113-127`); the injected-callback shape on
`sendProbes` (`stall.ts:97-103`) and `AnswerDeps` (`tasks.ts:244-248`), keeping `stall.ts` free of
`Herdr`/`Gh` imports.

**A29's stored timestamp has a precedent too**, which the withdrawn design ignored: every other
edge-triggered predicate here stores the instant it fired rather than deriving it —
`decision.prompted_at` (`types.ts:41`, stamped at `tasks.ts:308`), `task.adopted_at`
(`types.ts:70`), `task.merged_at_ms` (`types.ts:71`). Deriving "when did this last happen" from a
count was the outlier.

### A5, A28, A29, A30 — the ladder state

```ts
// types.ts — declarations only; helpers live in stall.ts
export interface StallState {
  /** The record's `phase_entered_at` this state belongs to. Stale ⇒ read as fresh. */
  at: number
  /** The RUN's `phase_entered_at` this state belongs to. Stale ⇒ read as fresh. */
  run_at: number
  /** When the last rung was climbed — a sent probe or a deferral. The due anchor. */
  last_probe_at: number
  probes: number
  holds: number
}
// on both Run and Task:
stall?: StallState
```

```ts
// stall.ts
export function stallStateFor(run: Run, record: Run | Task): StallState { … }
export function bumpStall(run: Run, record: Run | Task, kind: 'probes' | 'holds', now: number): void
```

`stallStateFor` returns the stored state only when **both** stamps match; otherwise a fresh state:

```ts
const fresh = {
  at: record.phase_entered_at, run_at: run.phase_entered_at,
  last_probe_at: Math.max(record.phase_entered_at, run.phase_entered_at),
  probes: 0, holds: 0,
}
```

Three properties fall out, and they are the three defects:

- **A29 (BLOCKER 1).** Due is `now - last_probe_at >= threshold`. A 13-hour-old record with stored
  state is due **once**; the bump sets `last_probe_at = now`, so the next rung is a full `threshold`
  away. A 13-hour-old record that was never probed reads fresh, anchored at `phase_entered_at`, so
  it is due once and then paced. **The rung-per-tick burst cannot occur, because climbing a rung
  moves the anchor.** The `(probes + holds + 1)` multiplier is deleted.
- **A28.** Any code that re-stamps `record.phase_entered_at` invalidates the state without knowing it
  exists. All five writers are covered without being edited — verified exhaustive:

  ```
  $ grep -rn "phase_entered_at = " src/
  src/cli.ts:180  cmdRewind task   src/cli.ts:186  cmdRewind run
  src/cli.ts:317  cmdResume run    src/lib/machine.ts:49  enterRunPhase
  src/lib/machine.ts:94  enterTaskPhase
  ```

  (`cli.ts:85`, `ledger.ts:32` set it in creation literals; a new record has no `stall`.)
- **A30 (MAJOR 2).** `cmdResume` restamps `run.phase_entered_at` (`cli.ts:317`) but never walks
  `run.tasks` (`cli.ts:304-320`), so a task's own `phase_entered_at` is unchanged across
  abort/resume. Stamping `run_at` closes it: on resume every task's state goes stale, counters read
  zero, and `last_probe_at` re-anchors to `run.phase_entered_at` — i.e. **now** — so the recovered
  task gets a full `threshold` before its first probe rather than being escalated on the next tick.
  `cmdResume` is not edited, which matters because `src/cli.ts` is t1's.

  `run_at` also re-arms task ladders on ordinary run transitions (`dispatch`→`execute`, say). That
  is deliberate and cheap: it grants one extra `threshold` of grace at a batch boundary, and the run
  phase is otherwise stable for the whole of `execute` (`machine.ts:68-73`), which is where task
  work happens.

Nested object rather than five flat fields: `Task.artifacts` (`types.ts:63-68`) and `Run.artifacts`
(`types.ts:97`) are the precedent, and one field means one write and one staleness check. **No
`schema_version` bump** — `isCurrentSchemaRun` is a hard `=== 2` (`main.ts:30-32`); `readJson` does
no validation (`store.ts:5-13`), so older records read fresh. Optional also keeps the diff honest:
11 files / 13 lines construct `Task` literals.

### A26 — the run-phase guard (P3)

```ts
if (runRow(run.phase).releasesPane === true) continue   // mirrors tick.ts:109
```

in `taskStallCandidates`. `releasesPane` is on exactly two run rows — `escalated` (`phases.ts:71`)
and `done` (`phases.ts:72`) — the states meaning "this run is not being driven"; `pickOneAdvance`
skips them for the same reason (`tick.ts:106-115`), and `cmdAbort` parks a run in `done` with its
tasks intact (`cli.ts:292-302`). `releasesPane`, not `terminal`: `escalated` is `releasesPane` but
**not** `terminal`, and an escalated run's tasks must not be escalated out from under the human
about to `hpipe rewind` it.

`stallCandidates` (run level) needs no guard — it gates on `row.stallable`, and neither `escalated`
nor `done` is stallable (stallable run rows are exactly `dispatch`, `execute`, `branch-review`). A
test pins the asymmetry so it reads as deliberate.

### A27, A7, A3 — bounded deferral

```
action = escalate   when probes >= probeMax
defer               when action is escalate AND holds < probeMax AND actor reports 'working'
escalate anyway     when holds >= probeMax
```

A deferral advances `last_probe_at` (**A20**), so the actor is re-consulted once per `threshold`,
not once per tick. At the defaults a task escalates at **180m** when the actor is not working, and
at **315m** worst case; a run (`branch-review` only) at **60m** / **105m**. Nothing waits forever.

**NG1 rests on that bound alone.** An earlier draft claimed a rate-limited agent reports something
other than `working`; nothing in this repo or herdr 0.9.0 establishes it, so it is withdrawn and not
relied on. With deferral capped, the ladder escalates within a fixed time whatever the pane reports,
so a git-dirty signal would change the *message*, not the *decision*.

The gate reads the **row actor's own** pane, not `probePaneFor`'s — which collapses a paneless
worker onto the orchestrator (`stall.ts:24`, pinned by `test/stall.test.ts:146-151`):

```ts
function actorPaneFor(run: Run, row: PhaseRow<string>, task: Task | null): string | null {
  return row.actor === 'worker' ? (task?.pane_id ?? null) : run.orchestrator_pane
}
```

`null` → the owning actor has no pane → escalate without a gate. `Herdr.agentStatus` returns
`'unknown'` on failure (`herdr.ts:68-71`), so an unreachable pane escalates. The gate is
`!== 'working'`, deliberately not `isAgentReady` (`machine.ts:30-32`), which is `idle || done` and
would exclude `blocked` — the state that most needs a human.

### A18 — escalation narrowed to actor-produced signals

`escalated` is in `TERMINAL_BAD` (`gating.ts:6-8`), so dependents gate to `blocked-on-failure`
(`gating.ts:34-38`), and is `holdsFiles: true` (`phases.ts:131`). Escalation is restricted to
`row.signal` ∈ `{'artifact','verdict','pr'}`. Verified by executing the filter against `phases.ts`:

```
escalating: branch-review, research, spec, spec-review, plan, plan-review,
            implement, pr-review-intent, pr-review-quality
probe-only: dispatch, execute, blocked-on-files, blocked-on-decision
```

`blocked-on-files` clears only when a *sibling* releases (`machine.ts:186-189`);
`blocked-on-decision` waits on a *human*. Run `dispatch` is `worktree` (`phases.ts:54`) and
`execute` is `gate` (`phases.ts:56`). `dispatch` and `branch-review` both lack `stallWhen` (only
`execute` has one, `phases.ts:58-59`), so **A18** is what keeps a healthy `dispatch` from escalating
at 60m; `branch-review` escalates by design, being orchestrator-owned with a `verdict` signal.

Excluded rows lose nothing human-visible: `formatStatus` renders the open-decision age and question
(`status.ts:21-26`) and the files-blocked holder with its escape hatch (`status.ts:38-55`).

### A13, A25, A10 — what the probe and the escalation say

```ts
export interface Awaiting { clause: string; short: string }
export function stallAwaiting(run: Run, task: Task | null, hpipe: string): Awaiting
```

`clause` is the whole waiting paragraph, so the template asserts nothing about its shape (**P2c**);
`short` is a noun phrase for the escalation prompt (**MINOR 4** — the old `{{awaiting_short}}` was
never defined, and `clause` cannot be substituted into a sentence).

| `signal` | record | `short` | `clause` |
| --- | --- | --- | --- |
| `artifact` | task | `its research/spec/plan artifact` | `Nothing has appeared at:\n\n    <abs path>\n\nIf you finished but wrote it elsewhere, move it exactly there — the supervisor stats that path and nothing else.` |
| `verdict` | task or run | `its review verdict` | same shape, verdict path (`deliver.ts:88-93`) |
| `pr` | task | `a pushed PR for <branch> (#<issue>)` | `This phase is waiting for a pushed PR for <branch> (#<issue>).` |
| `files` | task | `the files another task holds` | `This phase is waiting for another task to release the files this one declared.` |
| `manual` | task | `an answer to the open decision` | `This phase is waiting for an answer to the open decision.` |
| `worktree` | run (`dispatch`) | `a worktree for a dispatched task` | `This phase is waiting for a worktree to be adopted for a dispatched task.` |
| `worktree` | task (`teardown`) | `its worktree to be removed` | `This phase is waiting for this task's worktree to be removed.` |
| `gate` | run (`execute`) | `intake to be closed` | `This phase is waiting for \`<hpipe> dispatch --done\` to close intake.` |
| else | — | `whatever clears <phase>` | `This phase is waiting for whatever clears <phase>.` |

`prompts/stall-probe.md`, rewritten — it hardcodes neither "appeared at" nor "the path above":

```
# Still working? — run {{run_id}}, phase `{{phase}}`

This phase has been open {{minutes}} minutes. {{awaiting}}

{{ladder}}

If you are still working, ignore this.
If you are stuck or waiting on a human, say so now rather than waiting silently.
```

`:7`'s *"it will not ask again for this phase"* is deleted. The prompt must not claim that
*answering* stops the clock — under **A7** an agent that answers returns to idle within a turn, so
only producing the signal does.

`prompts/stall-escalate.md`, new — `escalate.md` cannot be reused: it says *"This phase hit
{{pass}} review passes without clearing"* and *"Do not start another pass"* (`escalate.md:3`, `:5`),
neither true of a stall.

```
# Escalated — run {{run_id}}, phase `{{phase}}`

This phase went {{probes}} stall probes without producing {{awaiting_short}}, and has been open
{{minutes}} minutes. The pipeline has stopped it on purpose.

Summarise for the human, in a few lines:

- what this phase was waiting for and what the worker was last doing,
- whether the work in the worktree is salvageable,
- what you recommend.

To resume after they answer:

    {{hpipe}} rewind {{run_id}} {{phase}}{{task_flag}}
```

`{{awaiting_short}}` is `Awaiting.short`; `{{probes}}` is `probes` — sent probes, never deferrals
(**A6**). Must be added to `ALL` in `test/prompts.test.ts:10-14` or the orphan test fails
(`:21-24`), and must not contain a literal `hpipe` (`:68-76`).

**`hpipe` is passed in as a rendered string**: `render` is a single `String.replace` whose
replacement text is never re-scanned and whose throw inspects only placeholders present in the
*template* (`render.ts:8-14`), while `renderPrompt` injects `hpipe` into the template bag
(`render.ts:46`). A `{{hpipe}}` inside a **value** would ship verbatim, and
`test/prompts.test.ts:68-76` cannot catch it — it reads only `prompts/*.md`. Callers pass
`hpipeCommand(pluginRoot)` (`render.ts:28-38`); `pluginRoot` is in scope at `main.ts:97`.

**A25 — the ladder sentence**, composed at the call site because a bare ratio is false for every
**A18**-excluded row:

- eligible: `This is probe 2 of 3. After 3 unanswered probes this phase is escalated to the human
  and stops moving on its own.`
- excluded: `This is a standing nudge — this phase is not escalated automatically, and clears when
  whatever it is waiting for arrives.`

### A15 — `hpipe status` (MINOR 6)

**The predicate is `phase === 'escalated'`, never `escalated_from !== null`.** `cmdAbort` sets
`run.escalated_from = run.phase` and then `run.phase = 'done'` (`cli.ts:298-299`), so keying on
`escalated_from` would print an escalation warning for every aborted run.

`taskWarnings` (`status.ts:17-59`) gains, mirroring `status.ts:21-26`:

```
  ⚠ t3 escalated from implement 47m ago — needs a human; `hpipe rewind <run> implement --task t3` resumes it
```

and `formatStatus` gains the run-level equivalent beside the schema warning (`status.ts:104-109`),
because the ladder escalates runs too. Uses `ageMinutes` (`status.ts:12-14`) and `escalated_from`
(`types.ts:57`, `:95`) for the origin phase only. Fires for every escalated record, including those
escalated by `advanceLoopingRow` (`machine.ts:122`).

---

## Data and control flow

### `stall.ts` — classification (pure)

```ts
export type StallAction = 'probe' | 'escalate'
export interface StallCandidate {
  run: Run; task: Task | null
  action: StallAction
  probes: number               // sent so far — {{ladder}} and the reason string
  escalatable: boolean         // A18
  minutes: number              // age in phase, for the prompt
  paneId: string               // where the probe is SENT      (probePaneFor)
  actorPaneId: string | null   // whose status gates deferral  (actorPaneFor)
}
export function stallCandidates(runs, now, thresholdMinutes, probeMax): StallCandidate[]
export function taskStallCandidates(runs, now, thresholdMinutes, probeMax): StallCandidate[]
```

Per record:

1. **A26** — task level only: skip when `runRow(run.phase).releasesPane === true`.
2. `row.stallable` (`stall.ts:35` run, `:74` task) — unchanged. **No `phases.ts` change.**
3. `row.stallWhen` for run rows (`stall.ts:36`) — unchanged.
4. `probePaneFor` (`stall.ts:22-26`) — unchanged, fallback included.
5. **Due (A29):** `now - stallStateFor(run, record).last_probe_at >= thresholdMinutes × 60_000`.
6. **Action:** `escalate` when `probes >= probeMax` **and** **A18** admits the row; else `probe`.

### `stall.ts` — application (injected effects)

```ts
export interface StallDeps {
  probeMax: number                                   // MINOR 3 — was read but undeclared
  now: () => number
  probe: (c: StallCandidate) => Promise<{ ok: boolean }>
  escalate: (c: StallCandidate) => Promise<void>
  agentStatus: (paneId: string) => Promise<AgentStatus>
  persist: (run: Run) => Promise<void>
}

export async function applyStalls(cs: StallCandidate[], deps: StallDeps): Promise<void> {
  for (const c of cs) {
    const record = c.task ?? c.run

    if (c.action === 'probe') {
      if ((await deps.probe(c)).ok) {                              // A6
        bumpStall(c.run, record, 'probes', deps.now())             // moves last_probe_at — A29
        await deps.persist(c.run)                                  // A4
      }
      continue
    }

    const { holds } = stallStateFor(c.run, record)
    if (holds < deps.probeMax && c.actorPaneId !== null            // A27
        && (await deps.agentStatus(c.actorPaneId)) === 'working') {
      bumpStall(c.run, record, 'holds', deps.now())                // A20 — also moves the anchor
      await deps.persist(c.run)
      continue
    }
    await deps.escalate(c)                                         // A22
  }
}
```

`enterTaskPhase`/`enterRunPhase` are called inside `escalate` in `main.ts`, keeping `stall.ts` free
of a `machine.ts` import — the layering `deliverPendingAnswers` uses (`tasks.ts:283`).

### One tick

Unchanged through `main.ts:236`; the two `applyStalls` calls replace the two `sendProbes` calls at
`main.ts:238-268`. `escalate`, in order: `enterTaskPhase(run, task, 'escalated', \`${probes} stall
probes unanswered\`)` → `saveRun` → render `stall-escalate` → send to `run.orchestrator_pane`.

**A22.** "Unconditional" governs the send, not the deferral: once the deferral gate has passed, the
transition and its `persist` happen regardless of whether the prompt can be delivered. A deferral is
a decision not to escalate **yet**; a failed send loses a prompt, never a transition — which is what
makes **A15** the reliable surface.

**Persistence.** `main.ts` has two `saveRun` sites — `:136` (post-`applyEvents`, all runs) and
`:217` (per advancing run). Both precede the stall block at `:238`, and `listRuns` (`main.ts:114`)
re-reads every run from disk each tick (`ledger.ts:48-62`), so without **A4** a bump made in the
stall block is discarded before the next tick sees it — which would restore exactly the rung-per-
tick behaviour of **P4**, since `last_probe_at` would never advance.

### Config

`STALL_PROBE_MAX: number` into `Config` (`config.ts:4-20`), `3` into `DEFAULTS` (`:22-38`), the key
into `NUMERIC` (`:40-44`) — identical to `PROMPT_RETRY_MAX`.

---

## Error handling

| Failure | Behaviour | Why |
| --- | --- | --- |
| `agentPrompt` rejects a probe | No bump, no persist; `last_probe_at` unchanged, so still due next tick | **A6**; `stall.ts:92-96`. Bounding this is **#25** |
| …and keeps rejecting | Retried every tick, unbounded | Today's behaviour, unchanged; **#25** owns it. Named, not hidden |
| `agentPrompt` rejects the escalation send | Transition already persisted; prompt lost | **A22**; `hpipe status` shows it (**A15**) |
| `agentStatus` fails | `'unknown'` (`herdr.ts:70`), `!== 'working'` → escalate | Failing open beats waiting |
| `actorPaneId` is `null` | Escalate without the gate | The owning actor has no pane (**A7**) |
| Actor reports `working` forever | Escalates at `holds >= probeMax` | **A27** |
| Record has no `stall`, or either stamp is stale | Reads fresh; anchored at `max(record, run)` phase entry | **A28**/**A30** |
| Supervisor restart with aged records | One probe each, then paced by `last_probe_at` | **A29** — the **P4** fix |
| Run is `escalated` or `done` | Its tasks produce no candidates | **A26** |
| `stallAwaiting` cannot resolve a path | `whatever clears <phase>` clause | Same shape as today's fallback |
| Probe pane is `null` | No candidate (`stall.ts:38-39`, `:76-77`) | Unchanged; `test/stall.test.ts:165-175` pins it |
| `persist` throws | Caught by the tick's `try` (`main.ts:269-271`); the bump is lost and the probe re-sent | A duplicate nudge beats a lost transition |
| Clock moves backwards | `now - last_probe_at` goes negative → not due | Degrades to silence, not to a burst |

**Race, unchanged:** `advanceTasks` runs earlier in the tick (`main.ts:176`) and may have re-stamped
`phase_entered_at`; the task's state then reads fresh and is not due for a full `threshold`.

---

## Testing strategy

Baseline to hold: 351 pass / 0 fail, `tsc --noEmit` clean.

**`test/stall.test.ts` — every call site changes.** All 20 tests pass `alreadyProbed` positionally
(`grep -c "new Set(" ` → 18) and **A16** replaces it with `probeMax`; three assert the deleted key
format (`:66`, `:72`, `:124`). New coverage:

- **P4/A29, the regression that must exist: a record whose `phase_entered_at` is 780 minutes old
  yields exactly ONE candidate, and after the bump is not due again until `threshold` later.** Drive
  four consecutive ticks one second apart and assert one probe and no escalation — the pass-1
  blocker, expressed as the test that would have caught it. The old test only built the continuous
  case, which is why it passed while the property failed.
- **A29 pacing:** probe 1 at `threshold` after entry, probe 2 at `threshold` after probe 1, not at
  `2 × threshold` after entry when the first was late.
- **persistence:** bump → `persist` → re-load through `listRuns` → not due until `threshold` later.
  Without **A4** this is exactly **P4** again.
- **A30/MAJOR 2:** apply `cmdAbort`'s mutation (`run.phase = 'done'`, `escalated_from` set, tasks
  untouched) → no candidates (**A26**); then `cmdResume`'s (`run.phase = escalated_from`,
  `run.phase_entered_at = now`, tasks still untouched) → the task's state reads fresh **and is not
  due for a full `threshold`**, rather than escalating on the next tick. Neither `cmdAbort` nor
  `cmdResume` is modified to make this pass.
- **A26:** a task in `implement` inside a run whose phase is `done` or `escalated` yields no
  candidate; and the run-level asymmetry, that `stallCandidates` needs no such guard.
- **A18:** the four excluded rows are probed at the cap and never escalate; the nine eligible do.
- **A27:** a `working` actor is deferred, `holds` increments and `probes` does not, the anchor
  moves, and **after `probeMax` deferrals it escalates anyway**; the reason string reports probes only.
- **A7:** the gate reads `actorPaneId`; a paneless worker escalates rather than consulting the
  orchestrator (inverse of `:146-151`, which still pins probe routing).
- escalation proceeds on `idle`, `done`, `blocked`, `unknown`; defers only on `working`.
- **A22:** an escalation whose send fails still leaves the record in `escalated`.
- `stallAwaiting` per signal and record, both `worktree` cases, `clause` **and** `short`; **P2** (a
  task probe never renders `whatever clears research`) and **P2b** (a run probe in `dispatch` never
  names a `docs/superpowers/reviews/` path).
- **P2c:** the rendered `pr`-row probe contains neither `appeared at` nor `path above`; likewise
  `blocked-on-decision`.
- **A25:** an excluded row's `{{ladder}}` contains no `of 3`; no rendered probe contains `{{`.

**`test/phases.test.ts` — A21, the real NG2 guard.** `table.test.ts:30-37` only asserts a stallable
row can be probed; adding `stallable: true` to `merge` would pass it. Values verified by executing
the filters:

```ts
test('the stallable set is exactly what #15 assumed — widening it belongs to #19', () => {
  expect(TASK_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort()).toEqual([
    'blocked-on-decision', 'blocked-on-files', 'implement', 'plan', 'plan-review',
    'pr-review-intent', 'pr-review-quality', 'research', 'spec', 'spec-review',
  ])
  expect(RUN_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort())
    .toEqual(['branch-review', 'dispatch', 'execute'])
})
```

**`test/status.test.ts`** — the escalated warning renders for a task and a run, and **does not
render for an aborted run**, whose `escalated_from` is set but whose phase is `done` (**MINOR 6**).

**`test/config.test.ts`** — `STALL_PROBE_MAX` defaults to 3 and parses (mirrors `:11-30`).

**`test/prompts.test.ts`** — add `stall-escalate` to `ALL` (`:10-14`); the orphan (`:21-24`) and
no-literal-`hpipe` (`:68-76`) tests then cover it. Add: `stall-probe.md` contains neither
`will not ask again`, nor `appeared at`, nor `path above`, and contains `{{awaiting}}` and
`{{ladder}}`; `stall-escalate.md` contains `{{awaiting_short}}` and `{{probes}}`.

**No `test/cli-commands.test.ts` change** — no CLI code is modified.

**Live verification — not optional.** DI with fakes hid a wiring bug here before: an earlier draft's
counter was never persisted and every unit test would still have passed. With
`TASK_STALL_MINUTES=1`, `STALL_PROBE_MAX=2`:

1. Probes at ~1m and ~2m with a **real absolute path**, then escalation at ~3m.
2. **Read the run JSON off disk between probes and confirm `stall.probes` climbs and
   `stall.last_probe_at` advances** — not reachable from the unit suite.
3. **Restart the supervisor with a record already hours past its threshold and confirm it receives
   ONE probe, not a burst** (**P4**). This is the pass-1 blocker; it is a restart, which
   `smoke.md:479` documents as routine.
4. `hpipe status` shows the ⚠ line for the task and for an escalated run, and **not** for an aborted
   run.
5. A task in `blocked-on-decision` past the cap: probed, never escalated (**A18**), `{{ladder}}`
   reads as a standing nudge (**A25**).
6. **`hpipe abort` a run with a live task, wait past the cap: no probe, no escalation. `hpipe
   resume`, then confirm the task gets a full `TASK_STALL_MINUTES` before its first probe** —
   not an immediate escalation (**A30**).
7. Hold an actor at `working` past `STALL_PROBE_MAX` deferrals: it escalates anyway (**A27**).

**Pre-PR gate.** t1 (#9) merges first; then rebase on `main`, re-run `bun test` and
`bun run typecheck`, and say in the PR body that both were re-run post-rebase. No file in t1's list
is touched, so a conflict is unlikely; a real one is a stop and an `hpipe decide`.

**Operator docs.** `smoke.md` gains a stall-ladder subsection beside the `PROMPT_RETRY_MAX`
paragraph (`:281`) and a recovery-table row (`:473`).

---

## Superseded premises

- **The no-stored-timestamp design is withdrawn** by Ruling 2 and must not return. It was named the
  most attackable choice in pass 0, blocked in pass 1 with worked arithmetic, and is **P4** here.
- **The research note's dead-orchestrator paragraph is wrong.** It calls the `attempts.delete` reset
  (`main.ts:234`) "a 5-tick cycle repeated forever, which is consistent with 33 further deliveries
  into a dead pane". At `TICK_MS` 1000 (`config.ts:23`) that is ≈46,800 attempts over 13 hours, not
  33; and a delivery is only attempted when the tick produced text (`main.ts:159`,
  `deliver.ts:53`). 33 over 13 hours is ~1 per 24 minutes — **successful** digests into a pane that
  was **alive** while the agent inside it was wedged. `main.ts:234` is a real bug; it is **#25**.
- **The claim that a rate-limited agent does not report `working`** is withdrawn — see **A27**.

## Rejected alternatives

- **Deriving the schedule from `phase_entered_at` and a count.** **P4**; overruled by Ruling 2.
- **Editing `cmdRewind`/`cmdResume` to reset the ladder**, which the ruling permits. Not rejected as
  forbidden — rejected as weaker: an enumeration of reset sites already went stale once (pass-1
  MAJOR 6 found the missing `cmdResume`), and **A28**/**A30** additionally keep `src/cli.ts` — t1's
  — out of the change set, shrinking what must survive the mandated post-merge rebase.
- **A new `stalled` phase.** Needs `phases.ts` (**NG2**); duplicates `escalated`'s machinery.
- **Exponential backoff.** 675m ≈ 11.25h against a 13h incident (**A2**, kept by Ruling 2).
- **Escalating every stallable row.** Cascades a correctly parked task to `blocked-on-failure`
  (`gating.ts:6-8`, `:34-38`).
- **Guarding on `terminal` rather than `releasesPane`.** Misses `escalated` (`phases.ts:71`).
- **A separate `STALL_HOLD_MAX`.** A second knob for a bound with no reason to differ.
- **Bumping `schema_version` to 3.** Strands every in-flight run behind `hpipe abort`
  (`main.ts:30-32`).

## Open decisions

None. Ruling 2 settled the anchor and directed MAJOR 2 to the same field; both are implemented
together, and the `src/cli.ts` permission is left unused by choice, not by necessity.
