# The orchestrator digest's content — design (#13)

**Date:** 2026-09-17
**Issue:** #13 — the orchestrator digest carries no phase, no age, and no next action
**Research:** `docs/superpowers/research/2026-09-17-issue-13-research.md` (commit `f6130ef`)
**Status:** Design v1. Pass 0 returned `VERDICT: BLOCKER` (1 blocker / 1 major / 6 minors) —
`docs/superpowers/reviews/issue-13-spec-review-0.md`. **Not yet applied**: BLOCKER 1 is a scope
call surfaced to the orchestrator via `hpipe decide`, and v2 follows the answer. The only edit
made since the review is the `test/integration/smoke.md` ownership ruling, recorded in §Non-goals.
**Declared file set** (`t2.files` in the live run ledger): `src/supervisor/tick.ts`,
`src/supervisor/deliver.ts`, `prompts/digest.md`. Two files outside it are needed — see **A11**.
**Modelled on:** `docs/superpowers/specs/2026-09-17-issue-9-design.md` for the document shape, and
commit `0aa1dbf` ("make the stall probe's sentences true of what it names") for the change itself:
agent-facing text composed in TypeScript from the phase row, keyed on a table, with the template
reduced to what it can honestly carry.

---

## Problem

Every digest line the orchestrator received on the berean-os run of 2026-09-16 was built here
(`src/supervisor/tick.ts:88-91`):

```ts
text: `${task.branch} (#${task.issue}, ${task.task_id}) ${event.agent_status}`,
```

`event.agent_status` is herdr's screen-scraped pane state (`src/lib/types.ts:5`). **No phase
predicate reads it** — `src/supervisor/tasks.ts:17-22` says so in the code: *"NOT
task.agent_status, which is the badge and wake cache and can be stale by a whole turn."* It is
written to `task.agent_status` at `src/supervisor/tick.ts:85` and consumed only by the badge
(`src/lib/badges.ts:14`), `hpipe status` (`src/lib/status.ts:136`) and this line.

The divergence is not theoretical. The berean-os ledger, still on disk at
`~/.local/state/herdr/plugins/stein.pipeline/runs/personal/berean-os-20260916-berean-os-issue-batch-ujku.json`,
has it frozen for **4 of its 6 tasks** at rest — read 2026-09-17 14:12 local, and dated because the
file is still being appended to (§Ledger drift, research note):

```
t2 fix/28-bookmark-save-budget   #28 [done]                agent_status=working
t3 fix/37-gate-screen-rotation   #37 [merge]               agent_status=done
t4 refactor/38-remove-qr-display #38 [blocked-on-decision] agent_status=done
t6 refactor/31-unused-i18n-keys  #31 [plan-review]         agent_status=done
```

`t3` is the issue's failure mode exactly: a line reading `t3 … done` for a task parked in `merge`,
unmerged — and parked there since 2026-09-16T22:47:27.752Z, ~21h at the time of this read.

The volume argument is **not** a digest-to-transition ratio: that run logged 79 transitions between
its first and its abort (20h01m) against ~50 digests, which if anything is more than one transition
per digest. It is that only the **3 run-level** transitions can reach the digest at all —
`phase_note` is composed from `evaluateRun`'s run transition
(`src/supervisor/deliver.ts:67`, `:236`) — so **all 76 task-level transitions are invisible to the
digest by construction**.

Three things the orchestrator needs are absent from the line, and all three are already on the
record:

| Missing | Where it already lives |
|---|---|
| The task's **phase** | `Task.phase` (`src/lib/types.ts:71`); printed by `hpipe status` (`src/lib/status.ts:135`) and by the badge (`src/lib/badges.ts:16`) |
| **How long** it has been there | `Task.phase_entered_at` (`src/lib/types.ts:72`) |
| Whose **move** it is | `taskRow(phase).actor` (`src/lib/phases.ts:89-141`) |

Hence the measured behaviour the issue reports: every digest was followed by `hpipe status`.

### A second defect, found while reading: the line is composed a tick too early

`applyEvents` writes the finished string at event-application time
(`src/supervisor/tick.ts:88-91`), which is `src/supervisor/main.ts:122` — **before**
`advanceTasks` runs at `src/supervisor/main.ts:177`. `findTask`
(`src/supervisor/tick.ts:17-23`) returns the live `Task` object out of `run.tasks`, and
`advanceTasks` mutates that same object, so by the time the lines are assembled at
`src/supervisor/main.ts:212` the task's phase may already have moved.

Adding the phase to the string at `tick.ts:88` would therefore print the phase the task was in
*before* this tick advanced it — reintroducing "this word does not mean what the phase is doing"
one layer down. **The fix is to stop composing at event time entirely** (§C1).

### And a third: `prompts/digest.md` is orphaned

`grep -rn "renderPrompt(" src/` lists 19 call sites; none names `digest`. `grep -rn digest src/`
returns one hit, a comment (`src/supervisor/deliver.ts:39`). The digest's layout is
`buildDigest`'s `[...].join('\n')` (`src/supervisor/deliver.ts:22-31`); the template file is a
dead duplicate. It survives because `test/prompts.test.ts:12` hand-lists `'digest'` in `ALL`, which
is exactly what the "no orphan prompt files" assertion (`test/prompts.test.ts:21-24`) checks
against — so the orphan test cannot see this orphan. Recorded twice before and never wired:
`docs/superpowers/plans/2026-09-15-worker-owned-pipeline.md:2995` and
`docs/superpowers/reviews/2026-09-13-design-adversarial-2.md:624` (MINOR 7, marked "Fixed" on the
design without the wiring landing).

This matters here because issue #13 reads that file as *"the whole template"*. It is not the
template, and a PR that fixed the digest while leaving it in place would leave the same trap for
the next reader.

## Goal

An orchestrator reading one digest line knows, without running anything: **which task**, **what
phase it is in now**, **whether that phase just changed**, **how long it has been there**, and
**whether the line is asking anything of them**. The word herdr reported is still present, but
scoped so it cannot be read as a phase completion.

## Non-goals

- **A full task roster in every digest.** Considered and declined — **A9**.
- **Changing `hpipe status`.** `src/lib/status.ts` is issue **#14**'s file ("hpipe status has no
  phase age or waiting-on-you"). Nothing in this design reads or writes it, so no decision is
  surfaced. The one place the two would collide — the age format — is settled by copying status's
  (**A4**).
- **A concrete command for each orchestrator-owned row** (`merge`, `close`,
  `blocked-on-decision`). **A7**.
- **Surfacing a `blocked-on-files` deadlock's escape hatch.** `src/lib/status.ts:46-62` composes
  it today from `filesOverlap`/`isInFlight` (`src/lib/gating.ts:19-29`); duplicating that
  predicate in `tick.ts` to save one `hpipe status` is not worth it, and the case is **already
  covered by a different working mechanism**: `blocked-on-files` is `stallable: true` with
  `probeTarget: 'orchestrator'` (`src/lib/phases.ts:105-106`), so the ladder nudges the
  orchestrator at `TASK_STALL_MINUTES` with `stallAwaiting`'s `files` clause
  (`src/supervisor/stall.ts:198-203`). #14 is the right owner.
- **Making more rows stallable.** A task parked in `merge` emits no event and `merge` has no
  `stallable` flag (`src/lib/phases.ts:120-121`), so nothing nudges it. Real gap; it is **#19**'s,
  named at `src/supervisor/stall.ts:159`.
- **Touching `src/supervisor/stall.ts`.** Reusing `stallAwaiting` was the first design and was
  dropped on evidence — §Rejected alternatives, **A8**.
- **Editing `test/integration/smoke.md`, and the prose it leaves stale.** The orchestrator's
  ownership ruling of 2026-09-17 on issue #13 assigns that file to **#10** for this batch: #10
  inserts a `files:` line that invalidates the assertion at `smoke.md:100`, which is the stronger
  claim, while this change only makes prose stale. **This task does not edit it.** The staleness is
  real and is named here rather than left unmentioned: `smoke.md:164-165` describes the orchestrator
  pane as receiving `[pipeline] run <id> …` digests, and after C2 those digests carry a phase box, an
  age and an action clause that the runbook does not describe. Per the same ruling that repair is
  **deferred to this run's `branch-review` phase**, not dropped. This is a live instance of #37 —
  the file gate serialises only what was declared at intake, and neither task could have known at
  registration that it would need this file.
- **Any schema change.** Every field this design reads is already persisted. `src/lib/types.ts`,
  `src/lib/phases.ts` and `src/lib/machine.ts` are untouched, so runs already on disk are
  unaffected (`.claude/agents/plugin-dev.md` §"The self-hosting hazard").
- **The run-level header.** `[pipeline] run <id>{{phase_note}}` (`src/supervisor/deliver.ts:24`,
  `:67`, `:236`) is correct as it stands and is labelled `run`, not task. Unchanged.

---

## Architecture

Three changes. C1 carries the design; C2 is the line's text; C3 removes the dead template.

### C1 (load-bearing) — stop composing the line at event time

`WakeLine` (`src/supervisor/tick.ts:6-10`) stops carrying a finished string and starts carrying
the *facts of the event*. Today:

```ts
export interface WakeLine {
  run: Run
  task: Task | null
  text: string
}
```

becomes:

```ts
export interface WakeLine {
  run: Run
  task: Task | null
  /** What herdr reported. NEVER a phase completion — `describeWake` scopes it. */
  event: string
  /**
   * The record's phase when this event was applied. Read at delivery time against
   * the live record, so a phase this same tick advanced renders as a transition
   * rather than as the phase the task has already left.
   */
  phaseAtEvent: string
  /** Pane tail for a `blocked` event. Attached by the driver; indented by `describeWake`. */
  detail?: string
}
```

`applyEvents` captures `phaseAtEvent` from `task.phase` **immediately after**
`const { run, task } = found` (`src/supervisor/tick.ts:56`) — before any `enterTaskPhase` call in
the same handler, so a `pane.exited` line reports `implement → failed` rather than
`failed → failed` (`src/supervisor/tick.ts:63`, `:74` both force `failed` before pushing).

This is enforced structurally, not by a test: after C1 there is no string on `WakeLine` to compose
early. `tsc` holds the contract, the way `src/lib/phases.ts:39` keeps `phases.ts` free of a
`types.ts` import to avoid a cycle rather than testing for one.

Only two readers of `WakeLine.text` exist — `src/supervisor/main.ts:128` (the blocked tail) and
`src/supervisor/main.ts:212` (the bullet) — and `test/tick.test.ts` asserts on `wake.length`
only, never on `.text`. The blast radius is those two lines.

### C2 — `describeWake`, in `src/supervisor/tick.ts`

```ts
/**
 * One digest line. Composed here, at delivery time, from the LIVE record: every
 * ~50 digests on the berean-os run of 2026-09-16 carried herdr's agent status and
 * nothing else, and every one was followed by `hpipe status`. Measured on a live run.
 */
export function describeWake(line: WakeLine, now: number, hpipe: string): string
```

Grammar:

```
<task_id> <branch> (#<issue>) [<phase-box>] <event> — <action>
```

`<phase-box>` is `${phaseAtEvent} → ${phase}` when the phase moved, and `${phase} ${age}m` when it
did not. An age on a transition would always read `0m` (both producers of a transition — this
tick's `advanceTasks`, and `applyEvents`' own `enterTaskPhase`, which stamps
`phase_entered_at = Date.now()` at `src/lib/machine.ts:94` — run within the same tick), so the
arrow replaces it (**A3**).

`<event>` is the trigger, in one of three forms, one per `wake.push` site:

| Site | Renders |
|---|---|
| `src/supervisor/tick.ts:88-92` (status change) | `agent:idle`, `agent:done`, `agent:blocked`, `agent:unknown` |
| `src/supervisor/tick.ts:75-78` (`pane.exited`) | `pane exited` / `pane exited, no PR` |
| `src/supervisor/tick.ts:64` (released) | `agent released` |

The `agent:` prefix is the whole point: `[merge 41m] agent:done` cannot be read as "merge
completed" (**A2**).

`<action>` is an **ordered ladder, first match wins**. The order is load-bearing, not cosmetic —
see the empirical table in §Rejected alternatives for what a different order produces.

| # | Condition | Renders |
|---|---|---|
| 1 | `phase === 'done'` | `done` |
| 2 | `taskRow(phase).terminal === true` (`failed`, `orphaned`, `blocked-on-failure`) | `dead end, needs a human` |
| 3 | `phase === 'escalated'` | ``needs a human: `<hpipe> rewind <run_id> <escalated_from ?? '<phase>'> --task <task_id>` `` |
| 4 | `row.actor === 'orchestrator'` (`merge`, `close`, `blocked-on-decision`) | `YOUR move` |
| 5 | `row.actor === 'worker'` (the eight producer rows) | `worker's move` |
| 6 | otherwise — no actor, non-terminal (`queued`, `blocked-on-files`, `ci`, `teardown`) | `nothing for you — the supervisor is driving` |

Rung 3's string is copied from `src/lib/status.ts:23-25`, which composes the identical rewind
invocation for the identical state; it is not invented here.

Rungs 1–6 are **exhaustive over `TASK_ROWS`** — verified by enumeration, not by reading:

```
$ bun -e 'const {TASK_ROWS}=await import("./src/lib/phases.ts"); …'
queued              actor=—           terminal=false      → rung 6
research…plan-review actor=worker     terminal=false      → rung 5   (5 rows)
blocked-on-files    actor=—           terminal=false      → rung 6
implement, pr-review-intent, pr-review-quality actor=worker  → rung 5
ci                  actor=—           terminal=false      → rung 6
merge, close        actor=orchestrator terminal=false     → rung 4
teardown            actor=—           terminal=false      → rung 6
blocked-on-decision actor=orchestrator terminal=false     → rung 4
escalated           actor=human       terminal=false      → rung 3
failed, orphaned, blocked-on-failure  terminal=true       → rung 2
done                                  terminal=true       → rung 1
```

`detail`, when present, is appended as today: `\n` then each tail line indented four spaces, so it
sits under the `- ` bullet exactly as `src/supervisor/main.ts:128` renders it now.

Worked lines, against the berean-os tasks above:

```
- t5 fix/27-atomic-store-saves (#27) [implement 12m] agent:idle — worker's move
- t5 fix/27-atomic-store-saves (#27) [research → spec] agent:idle — worker's move
- t3 fix/37-gate-screen-rotation (#37) [merge 41m] agent:done — YOUR move
- t1 fix/30-launcher-wake-refresh (#30) [ci 2m] agent:idle — nothing for you — the supervisor is driving
- t2 fix/28-bookmark-save-budget (#28) [implement → failed] pane exited, no PR — dead end, needs a human
- t6 refactor/31-unused-i18n-keys (#31) [plan-review 3m] agent:blocked — worker's move
      <8 lines of pane tail, indented>
```

The third line is the one the issue was filed over. Today it reads
`fix/37-gate-screen-rotation (#37, t3) done`.

### C3 — delete `prompts/digest.md`

Delete the file and remove `'digest'` from `ALL` in `test/prompts.test.ts:12`. That makes the
existing "no orphan prompt files" assertion (`test/prompts.test.ts:21-24`) load-bearing for this
file for the first time: with `'digest'` gone from `ALL`, re-adding the template without wiring it
fails the suite. **A5** records why deleting beats wiring.

---

## Data and control flow

Per tick, in `src/supervisor/main.ts`. Only steps marked **[C]** change.

1. `drain(queueDir)` → events (`:114`). Unchanged.
2. `applyEvents(...)` (`:122`). **[C1]** Each `wake.push` now carries `event` + `phaseAtEvent`
   instead of `text`; `phaseAtEvent` is captured before any `enterTaskPhase` in that handler.
3. Blocked-tail loop (`:124-131`). **[C1]** Writes `line.detail` instead of `line.text +=`. The
   `herdr.paneRead` call, the `BLOCKED_TAIL_LINES` slice and the trim are unchanged.
4. `saveRun` if changed (`:137`). Unchanged. Note the ordering the ledger comment at `:133-136`
   already relies on: state is persisted before delivery, so a crash between them costs the
   prompt, not the transition.
5. CI poll, `pickOneAdvance`, `makeSettledIdleReader` (`:139-152`). Unchanged.
6. **[C]** One clock and one CLI spelling per tick, hoisted above the run loop:
   `const tickNow = Date.now()` and `const hpipe = hpipeCommand(pluginRoot)` — the latter moved up
   from `:239`, where it is already computed once per tick for the stall ladder. Hoisting keeps
   the call count identical and makes every line in one digest agree on "now", the way
   `stallCandidates(runs, Date.now(), …)` (`:288`) takes one stamp for the whole sweep.
7. `evaluateRun` (`:174`) may advance the **run**; `advanceTasks` (`:177`) may advance **tasks**.
   Unchanged — and this is the step C1 exists to sit behind.
8. `deliverPendingAnswers` / `announceDecisions` (`:204-205`). Unchanged. Note for **A7**: the
   open decision's question is already pushed to the orchestrator's pane here, which is why rung 4
   does not restate it.
9. **[C2]** Line assembly (`:212`):

   ```ts
   const lines = wake.filter((w) => w.run.run_id === run.run_id)
     .map((w) => `- ${describeWake(w, tickNow, hpipe)}`)
   ```

10. `addPending` → `deliveriesFor` → `buildDigest` (`:213-224`, `src/supervisor/deliver.ts:50-74`).
    Unchanged; `deliver.ts` is not edited at all.
11. Stall ladder (`:239-292`). Unchanged apart from consuming the hoisted `hpipe` binding.

**Worked case — the transition arrow, end to end.** A worker in `research` writes its note, commits
and goes idle. herdr emits `pane.agent_status_changed{idle}`. Step 2 pushes a line with
`event: 'agent:idle'`, `phaseAtEvent: 'research'`. Step 7's `advanceTasks` finds the artifact
fresh and settled and advances the task to `spec`, stamping `phase_entered_at`. Step 9 composes
against the live record: `phaseAtEvent` (`research`) ≠ `task.phase` (`spec`), so the box renders
`[research → spec]`. The orchestrator reads "the phase completed", which is true. Today it reads
`done` and, per the issue, corrects itself to *"Research phase done, not the task."*

**The counter-case, which is the same mechanism.** The worker goes idle without writing anything.
Step 7 advances nothing. Step 9 renders `[research 34m] agent:idle — worker's move`. The arrow's
absence is the signal, and the age is what tells the orchestrator this is not progress.

---

## Error handling

`describeWake` is pure, synchronous, total, and allocates nothing beyond the string. It performs no
I/O, so it cannot fail the tick — which matters because it runs inside the `try` at
`src/supervisor/main.ts:170-221`, whose `catch` drops the whole run's prompt for that tick.

| Condition | Behaviour | Precedent / reason |
|---|---|---|
| `line.task === null` | Run-level line: `<run_id> [<run.phase> <age>m]` + event, no action rung | Defensive only; all three `wake.push` sites sit inside `const { run, task } = found` (`src/supervisor/tick.ts:56,64,75,88`), so it is unreachable today (**A10**) |
| `phase_entered_at` in the future (clock skew) | `0m`, never negative | `Math.max(0, …)`, copied from `src/lib/status.ts:13` |
| `escalated_from === null` on an `escalated` task | renders the literal `<phase>` | `src/lib/status.ts:25` does exactly this |
| An unknown phase string | `taskRow` throws (`src/lib/phases.ts:145-148`) | Unchanged from every other caller; a phase not in the table is a ledger corruption, not a digest concern |
| `detail` present but empty after trim | Not attached | The driver only sets it when `tail.trim().length > 0` (`src/supervisor/main.ts:127`) |
| `hpipeCommand` resolves to the absolute `bun run …` form | Rendered verbatim into rung 3 | `src/lib/render.ts:28-38`; already the case for the stall prompts |

One thing that is **not** handled and is stated rather than guarded: `describeWake` receives
`hpipe` already rendered, so a `{{hpipe}}` token is never re-scanned. `src/supervisor/stall.ts:157-159`
documents the identical hazard for `stallAwaiting` — `render()` never re-scans replacement text
(`src/lib/render.ts:8-14`) — but that hazard cannot reach this path at all, because the digest is
not rendered through `render()` (C3 is why).

---

## Assumptions

Each is a behavioural choice, made here so the review can attack it by name.

**A1 — The fix belongs in the line, not in a new message.** The issue's directions say *"Put the
state in the line the orchestrator already receives."* The alternative — a separate periodic status
push — is a new delivery with its own cadence, dedup and failure mode, next to a delivery path that
already reaches the right pane at the right moment. Declined.

**A2 — `agent_status` stays in the line, prefixed rather than removed.** Removing it would lose the
only answer to *"why did this line arrive?"*, and `blocked` in particular carries the pane tail
(`src/supervisor/main.ts:124-131`), which is the most actionable text in any digest. Scoping it
with `agent:` costs six characters. The attackable half: a reader who skims may still see the word
`done`. The phase box immediately to its left is the mitigation, and rung 4/5's `YOUR move` /
`worker's move` is the second.

**A3 — A transition replaces the age; it does not accompany it.** Every transition this design can
observe is stamped within the same tick — `advanceTasks` via `enterTaskPhase`
(`src/lib/machine.ts:94`), or `applyEvents`' own forced `failed`
(`src/supervisor/tick.ts:63,74`) — so the age would be `0m` in every arrow line, at a 1s tick
(`src/lib/config.ts:24`). `0m` next to an arrow is noise. The cost: the age *in the phase just
left* is not shown, and that is the one number a reader might want on a transition. Judged not
worth a second number in the box; a reviewer may disagree and it is a one-line change.

**A4 — Bare minutes, `Nm`, copied from `src/lib/status.ts:12-14`.** A 20-hour run renders `1204m`,
which is ugly. An `Xh Ym` format is nicer and is **declined anyway**, because issue **#14** is
adding phase age to `hpipe status` right now and two age formats for the same quantity, invented
independently in the same batch, is worse than one ugly one. If #14 introduces `Xh Ym`, converging
is a follow-up and a trivial one.

**A5 — `prompts/digest.md` is deleted, not wired.** Wiring means `buildDigest` calls
`renderPrompt`, which makes it `async` — it is currently pure and sync
(`src/supervisor/deliver.ts:22-31`), called from the pure sync `deliveriesFor` (`:50-74`), both
directly unit-tested (`test/deliver.test.ts:33-51`, `:53-81`). It also buys `render()`'s
throw-on-unresolved-placeholder contract (`src/lib/render.ts:11`) **at delivery time, in front of
the orchestrator** — the hazard `.claude/agents/plugin-dev.md` names explicitly. And it buys
nothing: a template cannot express `N events:` followed by a variable-length list better than
`.join('\n')`. The digest is a machine-assembled status frame, not an instruction to an agent,
which is what every other file in `prompts/` is. Deleting also repairs the orphan test (C3).
*This is the most reversible decision in the design and the one most likely to be contested.*

**A6 — Whose move it is comes from `row.actor`, not from the phase name.** `actor` is exactly the
field that means "whose pane produces this phase's completion signal"
(`src/lib/phases.ts:12`). Keying on it means a future row added to `TASK_ROWS` gets a correct
action clause with no edit here — the same property `src/supervisor/stall.ts:157-159` claims for
keying `stallAwaiting` on `row.signal` ("so #19 making more rows stallable needs no change here").

**A7 — Rung 4 says `YOUR move` and nothing more.** The concrete command for each
orchestrator-owned row lives in that row's prompt (`prompts/merge.md`, `prompts/close.md`,
`prompts/decision.md`), and for `blocked-on-decision` the question is already delivered to the
orchestrator's pane by `announceDecisions` (`src/supervisor/main.ts:205`). Restating it in the
digest duplicates text that has one owner. The phase box says *which* move. The known cost: on a
tick where the row was entered earlier, the prompt is not in this message — `promptForTaskPhase`
only renders on the entering tick (`src/supervisor/tasks.ts:171-175`) — so `YOUR move` is a
pointer with nothing local to point at. It is still true, which is the bar; claiming "the prompt is
below" would not be, and that is the `0aa1dbf` class of defect this design is modelled on avoiding.

**A8 — `stallAwaiting` is NOT reused, and `src/supervisor/stall.ts` is not touched.** It was the
first design. Evidence against it is in §Rejected alternatives: on the rows the digest would newly
send it, it returns false sentences. The redundancy argument is the second half — for every rung-6
row the phase name in the box (`[ci 2m]`, `[blocked-on-files 41m]`) already says what it is waiting
for, so "waiting for X" adds nothing that would justify widening a tested function's input domain.

**A9 — No task roster.** A roster of every non-terminal task would make the digest fully
self-sufficient and is what most literally satisfies *"if a digest never has to be followed by
`hpipe status`, it's right."* Declined on cost: with 6 tasks it multiplies every digest by ~6, and
the berean-os run delivered ~50. The measured behaviour the issue reports is the orchestrator
correcting itself about **the task the line named**, not about the others. Rungs 1–6 make that line
sufficient. Recorded as the largest deliberate gap against the issue's acceptance sentence; a
reviewer who weighs that sentence more heavily than context cost should say so, and the roster is a
bounded, additive change to `buildDigest`.

**A10 — `task: Task | null` is kept rather than tightened.** All three `wake.push` sites are inside
`const { run, task } = found` (`src/supervisor/tick.ts:56`), so `task` is never null today and the
run-level branch is unreachable. Narrowing the type to `Task` is the tidier change and is declined
because the field is also what `src/supervisor/main.ts:125` narrows on (`line.task?.agent_status`),
and a `WakeLine` for a run-level event is a plausible near-future need. One defensive branch,
labelled as such in the test table (T12).

**A11 — Two files outside the declared `--files` set are edited: `src/supervisor/main.ts` and
`test/prompts.test.ts`.** `t2.files` is
`["src/supervisor/tick.ts","src/supervisor/deliver.ts","prompts/digest.md"]`; `deliver.ts` turns
out **not** to be needed at all, and `main.ts` is, because the call site must move (§flow steps
3, 6, 9). Verified safe against the gate rather than assumed: the sibling `t1` declares
`["src/cli.ts","prompts/intake.md","prompts/dispatch.md","README.md"]` (read from the live run
ledger), and `filesOverlap` (`src/lib/gating.ts:19-21`) is a prefix test — no pair overlaps, so
`filesClearFor` (`:49-53`) cannot block either task. The precedent for declaring the overflow in
the spec rather than re-declaring the task is
`docs/superpowers/specs/2026-09-17-issue-9-design.md` §Testing strategy, which did it for test
files; this extends it to one source file and names it here so it is reviewed, not discovered.
`src/lib/status.ts` — the one file the batch brief gated — is **not** among them.

---

## Testing strategy

TDD, red first, per `prompts/worker-brief.md` §Definition of done. `describeWake` is pure and
synchronous, so every rung is directly testable; the table below is the plan's checklist.

**New tests in `test/tick.test.ts`** (which already owns `applyEvents` and imports `Run`/`Task`
fixtures, `test/tick.test.ts:1-8`):

| # | Case | Expected |
|---|---|---|
| T1 | `implement`, no transition, `agent:idle` | `t1 fix/x (#7) [implement 12m] agent:idle — worker's move` — the whole grammar, pinned once |
| T2 | `phaseAtEvent: 'research'`, task now in `spec` | box reads `[research → spec]`; **no** `m` age (**A3**) |
| T3 | `phaseAtEvent === task.phase` | box reads `[<phase> <age>m]`; no arrow |
| T4 | `phase: 'done'` | rung 1 — `done`; must **not** say "needs a human" |
| T5 | `phase: 'failed'` (and `orphaned`, `blocked-on-failure`) | rung 2 — `dead end, needs a human` |
| T6 | `phase: 'escalated'`, `escalated_from: 'implement'` | rung 3, containing `rewind <run_id> implement --task t1`; with `escalated_from: null`, the literal `<phase>` |
| T7 | `phase: 'merge'` / `'close'` / `'blocked-on-decision'` | rung 4 — `YOUR move` |
| T8 | each of the eight `actor: 'worker'` rows | rung 5 — `worker's move` |
| T9 | `phase: 'queued'` / `'blocked-on-files'` / `'ci'` / `'teardown'` | rung 6 — `nothing for you`; and **never** the string `intake` (the falsehood **A8** avoids) |
| T10 | `detail` set to three lines | appended after the action, each indented four spaces, bullet layout unchanged from `src/supervisor/main.ts:128` |
| T11 | `phase_entered_at` in the future | `0m`, never `-1m` |
| T12 | `task: null` | run-level line, no crash *(characterisation test — the branch is unreachable, **A10**)* |
| T13 | `applyEvents` on `pane.exited` for a task in `implement` | the pushed line carries `phaseAtEvent: 'implement'`, not `'failed'` — pins the capture-before-mutate ordering (§C1) |
| T14 | `applyEvents` on a status change | `wake[0].event` is `agent:done`, and `wake[0]` has no `text` property |

**Exhaustiveness guard (the test worth writing).** One test iterates **every** phase in `TASK_ROWS`
(`src/lib/phases.ts:89-141`), calls `describeWake`, and asserts the result is non-empty, contains
the phase name, and matches one of the six known action clauses. A row added to the table with a
new `actor`/`terminal` combination then fails here rather than shipping an empty clause to the
orchestrator. This is the analogue of `test/table.test.ts`'s existing per-row assertions and is the
one test that would catch the class of bug, not the instance.

**Edited tests:**

- `test/prompts.test.ts:12` — `'digest'` removed from `ALL` (C3). After this the file's own
  "no orphan prompt files" test (`:21-24`) is what enforces the deletion; verify it bites by
  restoring the file and confirming exactly that test goes red.
- `test/tick.test.ts` — the four existing tests that produce wake lines (`:71`, `:80`, `:98`,
  `:114`) **discard `applyEvents`' return value entirely** and assert only on mutated task state
  (`run.tasks[0]?.phase`, `…decisions[0]?.answered_by`); the only tests that touch `wake` at all
  are `:53-60` and `:62-69`, which assert `wake).toHaveLength(0)`. Nothing in the file reads
  `.text`. So all of them compile unchanged — and if one needs editing, C1's blast-radius claim is
  wrong and that is a finding.

**Not changed and must stay green:** `test/deliver.test.ts:33-51` and `:53-81`, which pin
`buildDigest`'s header, the `N events` count and the no-header-for-workers rule. This design does
not edit `src/supervisor/deliver.ts`, so if either needs a change something has drifted.

**Live verification, per `.claude/agents/plugin-dev.md`** (*"If your change touches startup, gating,
delivery or pane I/O, say in your plan how it would be verified against a real herdr session"*).
This change touches delivery. The unit suite proves `describeWake`'s output for a given `WakeLine`;
it **cannot** prove that `main.ts` calls it after `advanceTasks`, which is the whole of C1.
`test/integration/smoke.md:164-165` already asserts what the orchestrator pane receives and would be
the natural home for a step — **but that file is ruled to #10 for this batch and this task must not
edit it** (§Non-goals). So the live check is run and reported rather than written down as a runbook
step: drive one task through an artifact phase in a real herdr session and confirm the delivered
line carries a `→` arrow on the tick the phase advances, and a bare `[<phase> <age>m]` box on a tick
where the worker merely goes idle. The observation goes in the PR body, and a difference between it
and what the runbook says is a finding, not a test to make pass.

**Whole-suite gate:** `bun test` (414 pass / 0 fail / 33 files at `f6130ef`, recorded in the
research note) and `bun run typecheck` clean before the PR. CI in this repo runs a PR-title lint
only (#35), so both are run locally and reported in the PR body.

---

## Rejected alternatives

- **Reuse `stallAwaiting` (`src/supervisor/stall.ts:161-219`) for the action clause.** The first
  design, and the obvious one: it already maps `row.signal` to a true English sentence and was
  hardened for exactly this class of defect by `0aa1dbf`. Dropped because the digest sends it rows
  the stall ladder never does. Stallable task rows are `research`…`plan-review`,
  `blocked-on-files`, `implement`, `pr-review-{intent,quality}`, `blocked-on-decision`
  (`src/lib/phases.ts:89-141`) — signals `artifact`, `verdict`, `files`, `pr`, `manual`. The digest
  reaches every row. Probed directly rather than reasoned about:

  ```
  $ bun -e '… stallAwaiting(run, mk({phase: p}), "hp").short …'
  queued              "intake to be closed"              ← FALSE: a queued task waits on its
                                                            dependency/file gate (src/lib/gating.ts:31-47),
                                                            not on `hpipe dispatch --done`
  failed              "an answer to the open decision"   ← FALSE (same for done, orphaned,
  done                "an answer to the open decision"      blocked-on-failure — all signal:'manual')
  ci                  "whatever clears ci"               ← true but useless; pinned as the
                                                            fallback by test/stall.test.ts:307-315
  merge               "whatever clears merge"            ← ditto
  teardown            "its worktree to be removed"       ← correct
  ```

  The ladder's terminal-first ordering (rungs 1–2) neutralises four of those, but `queued` would
  have shipped a false sentence to the orchestrator — the precise failure `0aa1dbf` fixed, recreated
  by reusing its fix outside its domain. Repairing `stallAwaiting` instead (a task-aware `gate`
  branch and a `ci` branch) is four lines and was the runner-up; declined because it widens a
  tested function's contract and edits `test/stall.test.ts:307-315`'s deliberate characterisation
  of the fallback, to buy text **A8** argues is redundant with the phase box.

- **Add the phase and age at `src/supervisor/tick.ts:88-91`, leaving composition at event time.**
  The minimal-diff reading of the issue, and wrong: `advanceTasks` (`src/supervisor/main.ts:177`)
  mutates the same `Task` object afterwards, so the line would name the phase the task has already
  left. It fixes the instance and reproduces the class one layer down.

- **Wire `prompts/digest.md` through `renderPrompt`.** **A5**.

- **Put `describeWake` in `src/supervisor/deliver.ts`**, which owns the digest. Declined on
  structure: `stall.ts` imports `deliver.ts` (`src/supervisor/stall.ts:4`), so had the
  `stallAwaiting` design survived, `deliver.ts → stall.ts` would have been a cycle. `tick.ts` is
  imported only by `main.ts`, already owns `WakeLine` and the current composition, is the file the
  issue names, and has a test file. The repo already refuses a cycle by design at
  `src/lib/phases.ts:36-39`.

- **Derive "what it is waiting for" from `row.signal` with a second, digest-local map.** Correct,
  and it leaves the repo with two signal→English maps over overlapping domains. **A8**'s
  redundancy argument removes the need for either.

- **Carry a roster of all non-terminal tasks.** **A9**.

- **Read the reason a task failed out of `run.history`** (`src/lib/machine.ts:91` records
  `{from, to, why}`) for rung 2. Unnecessary: the trigger text already carries it — a `failed` task
  reached that phase through `pane exited, no PR` or `agent released`, which is the `<event>` on
  the same line.
