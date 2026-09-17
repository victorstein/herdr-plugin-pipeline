# The orchestrator digest's content — design (#13)

**Date:** 2026-09-17
**Issue:** #13 — the orchestrator digest carries no phase, no age, and no next action
**Research:** `docs/superpowers/research/2026-09-17-issue-13-research.md` (commit `2caa714`)
**Status:** Design **v2**. Pass 0 returned `VERDICT: BLOCKER` (1 blocker / 1 major / 6 minors) —
`docs/superpowers/reviews/issue-13-spec-review-0.md`. **All eight findings applied**; see the
disposition table below.
**Declared file set** (`t2.files` in the live run ledger): `src/supervisor/tick.ts`,
`src/supervisor/deliver.ts`, `prompts/digest.md`. One source file outside it — **A11**.
**Modelled on:** `docs/superpowers/specs/2026-09-17-issue-9-design.md` for the document shape, and
commit `0aa1dbf` ("make the stall probe's sentences true of what it names") for the change itself:
agent-facing text composed in TypeScript from the phase row, keyed on a table, with the template
reduced to what it can honestly carry.

> **Pass 0's blocker was right, and it was a contradiction inside v1's own text.** v1 built its
> whole case on a worked line — `t3 … [merge 41m] agent:done — YOUR move` — that the mechanism can
> never produce. A digest line exists only where `applyEvents` pushed a `WakeLine`, and all three
> producers are herdr events about the **worker's** pane (`src/supervisor/tick.ts:64`, `:75`,
> `:88`). v1's own §Non-goals said so two pages earlier: *"a task parked in `merge` emits no event."*
> Both sentences cannot be true.
>
> The failure is worth naming because it is the one this repo's review history keeps recording:
> **v1 improved every line the digest already carried and never asked which lines it fails to
> carry.** Rungs 1–6 make an existing line honest; they cannot make a missing line appear, and the
> missing ones are precisely the ones with a `YOUR move` in them. That is why *"every digest was
> followed by `hpipe status`"* — the orchestrator was asking about tasks that were **not in the
> digest**.
>
> **v2 does not repair the worked example. It adds the missing lines** (§C3), bounded to the rows
> where the orchestrator actually has a move.

## What changed from v1, by finding

| Finding | Disposition |
|---|---|
| **BLOCKER 1** — the headline case is unreachable; A9's justification rests on it | **Accepted, option 1 of three.** New §C3: a bounded footer over non-terminal `actor === 'orchestrator'` rows. Occupancy measured before committing to it (**A9**). Scope note in §Resolution below |
| **MAJOR 1** — the blocked tail stays gated on `task.agent_status`, the stale cache the spec indicts | **Accepted in full.** Gate is now `line.event === 'agent:blocked'`. §C1 wiring, **A12**, test T10 |
| **MINOR 1** — A4 settles the format and silently chooses a third un-shared `ageMinutes` | **Accepted.** **A4** now states the duplication choice and its reason outright |
| **MINOR 2** — rung 3 is not "copied from `status.ts`"; the divergence is why `describeWake` takes `hpipe` | **Accepted.** §C2 rewritten; the `status.ts:25` literal is named as a latent defect for #14 |
| **MINOR 3** — A11 miscounts files outside the declared set and contradicts its own precedent | **Accepted.** One source file; tests follow the surface per the issue-9 convention |
| **MINOR 4** — rung 1 restates the phase box in the word the issue was filed over | **Accepted.** Clause is now `nothing for you — this task is finished`; T4 widened |
| **MINOR 5** — §Error handling claims totality, then tables an input that throws | **Accepted.** Totality claim dropped; the throw's unreachability and the lost `saveRun` are stated; `phases.ts:145-149` corrected |
| **MINOR 6** — two §Problem evidence sentences overstate the ledger | **Accepted, and it was worse than reported.** Applied in `2caa714` before this revision: 4 tasks diverge, not 2 or 3, and the transition/digest inference is replaced. See §Ledger drift |

### Resolution of BLOCKER 1 without a human answer, and why

Pass 0 ranked BLOCKER 1 a scope call for the human, and I agree it is one. It was surfaced with
`hpipe decide` and **the call misfiled it onto a different run** — it landed on
`herdr-plugin-pipeline-…-qc13`, batch 1, already `phase: done`, attaching to *that* run's `t2`
(`fix/15-stall-escalation`, #15) and dragging a torn-down task back to `blocked-on-decision`. The
sibling task's decision misfiled identically onto `qc13`'s `t1`. Neither reached this run's
ledger: `grep -c 'BLOCKER 1' …-validate-the-silent-gates-rjms.json` → `0`. This is issue **#21**
(a task binds to the first open run in the session); it is reported alongside this spec and is not
repaired here, because another run's ledger is not this task's to rewrite.

So the question stands unanswered by the mechanism — but **the issue itself answers it**:

> *"If a digest never has to be followed by `hpipe status`, it's right."*

That is the issue's own acceptance criterion, and it chooses between pass 0's three options: option 3
(accept the gap) closes #13 against it, and option 2 (block on #19) defers it to unscheduled work.
Option 1 is taken. Per the worker brief — *"Do not surface what the issue … already answers"* — this
is not re-surfaced. It is recorded here in full so the next review can overrule it on the record.

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
file is still being appended to (§Ledger drift):

```
t2 fix/28-bookmark-save-budget   #28 [done]                agent_status=working
t3 fix/37-gate-screen-rotation   #37 [merge]               agent_status=done
t4 refactor/38-remove-qr-display #38 [blocked-on-decision] agent_status=done
t6 refactor/31-unused-i18n-keys  #31 [plan-review]         agent_status=done
```

`t3` is the issue's failure mode exactly: `t3 … done` for a task parked in `merge`, unmerged — and
parked there since 2026-09-16T22:47:27.752Z, ~21h at the time of this read.

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

### The fourth thing, and the one pass 0 caught: the lines that are never sent

A digest carries a line only where `applyEvents` pushed a `WakeLine`. There are exactly three
producers, all driven by herdr pane events about the **worker's** pane:
`src/supervisor/tick.ts:64` (released), `:75` (`pane.exited`), `:88` (status changed). A task
sitting in an **orchestrator-owned** row — `merge`, `close`, `blocked-on-decision`
(`src/lib/phases.ts:120-129`) — has no worker producing events, and
`src/supervisor/tick.ts:84` drops a same-value status event without waking at all. So it emits
nothing, indefinitely.

Measured on the berean-os ledger, reconstructing each task's occupancy of those rows from
`run.history`:

```
t5 merge               22:27:17 → 22:48:24    21m
t4 merge               22:28:21 → 22:34:55     7m
t1 merge               22:37:13 → 22:39:05     2m
t3 merge               22:47:27 → (still)   ~21h      ← frozen agent_status, zero wake lines
t2 merge               23:06:39 → 23:07:33     1m
… plus five `close` intervals of 0–2m
max concurrent orchestrator-owned tasks: 2
```

t3 is not a line the run said badly. It is a line the mechanism never said.

### And the line is composed a tick too early

`applyEvents` writes the finished string at event-application time
(`src/supervisor/tick.ts:88-91`), which is `src/supervisor/main.ts:122` — **before**
`advanceTasks` runs at `src/supervisor/main.ts:177`. `findTask`
(`src/supervisor/tick.ts:17-23`) returns the live `Task` object out of `run.tasks`, and
`advanceTasks` mutates that same object, so by the time the lines are assembled at
`src/supervisor/main.ts:212` the task's phase may already have moved. Adding the phase at
`tick.ts:88` would print the phase the task was in *before* this tick advanced it — reintroducing
"this word does not mean what the phase is doing" one layer down.

### And `prompts/digest.md` is orphaned

`grep -rn "renderPrompt(" src/` lists 19 call sites; none names `digest`. `grep -rn digest src/`
returns one hit, a comment (`src/supervisor/deliver.ts:39`). The digest's layout is
`buildDigest`'s `[...].join('\n')` (`src/supervisor/deliver.ts:22-31`); the template file is a
dead duplicate. It survives because `test/prompts.test.ts:12` hand-lists `'digest'` in `ALL`, which
is exactly what the "no orphan prompt files" assertion (`test/prompts.test.ts:21-24`) checks
against — so the orphan test cannot see this orphan. Recorded twice before and never wired:
`docs/superpowers/plans/2026-09-15-worker-owned-pipeline.md:2995` and
`docs/superpowers/reviews/2026-09-13-design-adversarial-2.md:624` (MINOR 7, marked "Fixed" on the
design without the wiring landing). Issue #13 reads that file as *"the whole template"*; it is not.

## Goal

An orchestrator reading a digest knows, without running anything: for every line it carries —
**which task**, **what phase it is in now**, **whether that phase just changed**, **how long it has
been there**, and **whether the line is asking anything of them**; and, for tasks that produced no
line at all, **which of them are waiting on the orchestrator**. The word herdr reported is still
present, but scoped so it cannot be read as a phase completion.

## Non-goals

- **A full task roster.** The footer (§C3) covers `actor === 'orchestrator'` rows only — **A9**.
- **Emitting a digest that no event triggered.** §C3's footer rides digests that are already being
  sent; it never creates one. Consequence and justification in **A10**. The complete fix for a
  parked task in a silent window is **#19** (making those rows stallable), named at
  `src/supervisor/stall.ts:159`.
- **Changing `hpipe status`.** `src/lib/status.ts` is issue **#14**'s file. Nothing here reads or
  writes it, so no decision is surfaced. The age format is settled by copying status's (**A4**),
  and one latent defect found in it is handed over rather than fixed (**A13**).
- **A concrete command for each orchestrator-owned row** (`merge`, `close`). **A7**.
- **Surfacing a `blocked-on-files` deadlock's escape hatch.** `src/lib/status.ts:46-62` composes it
  from `filesOverlap`/`isInFlight` (`src/lib/gating.ts:19-29`); duplicating that predicate is not
  worth it, and the case is **already covered**: `blocked-on-files` is `stallable: true` with
  `probeTarget: 'orchestrator'` (`src/lib/phases.ts:105-106`), so the ladder nudges the
  orchestrator at `TASK_STALL_MINUTES`. #14 is the right owner.
- **Touching `src/supervisor/stall.ts`.** Reusing `stallAwaiting` was v1's first design and was
  dropped on evidence — §Rejected alternatives, **A8**.
- **Editing `test/integration/smoke.md`, and the prose it leaves stale.** The orchestrator's
  ownership ruling of 2026-09-17 on issue #13 assigns that file to **#10** for this batch: #10
  inserts a `files:` line that invalidates the assertion at `smoke.md:100`, the stronger claim,
  while this change only makes prose stale. **This task does not edit it.** The staleness is real
  and named rather than left unmentioned: `smoke.md:164-165` describes the orchestrator pane as
  receiving `[pipeline] run <id> …` digests, and after C2/C3 those carry a phase box, an age, an
  action clause and sometimes a footer that the runbook does not describe. Per the same ruling the
  repair is **deferred to this run's `branch-review` phase**, not dropped. A live instance of #37.
- **Repairing the misfiled decisions on run `qc13`.** §Resolution. Another run's ledger.
- **Any schema change.** Every field read here is already persisted. `src/lib/types.ts`,
  `src/lib/phases.ts` and `src/lib/machine.ts` are untouched, so runs already on disk are
  unaffected (`.claude/agents/plugin-dev.md` §"The self-hosting hazard").
- **The run-level header.** `[pipeline] run <id>{{phase_note}}` (`src/supervisor/deliver.ts:24`,
  `:67`, `:236`) is correct and is labelled `run`, not task. Unchanged.

---

## Architecture

Four changes. C1 and C3 carry the design; C2 is the line's text; C4 removes the dead template.

### C1 (load-bearing) — stop composing the line at event time

`WakeLine` (`src/supervisor/tick.ts:6-10`) stops carrying a finished string and starts carrying the
facts of the event:

```ts
export interface WakeLine {
  run: Run
  task: Task | null
  /** What herdr reported. NEVER a phase completion — `describeWake` scopes it. */
  event: string
  /**
   * The record's phase when this event was applied, before this tick advanced it.
   * Read at delivery time against the live record, so a phase this same tick
   * advanced renders as a transition rather than as the phase already left.
   */
  phaseAtEvent: string
  /** Pane tail for a blocked event. Attached by the driver; indented by `describeWake`. */
  detail?: string
}
```

`applyEvents` captures `phaseAtEvent` from `task.phase` **immediately after**
`const { run, task } = found` (`src/supervisor/tick.ts:56`) — before any `enterTaskPhase` in the
same handler, so a `pane.exited` line reports `implement → failed` rather than `failed → failed`
(`src/supervisor/tick.ts:63`, `:74` both force `failed` before pushing).

**[MAJOR 1]** The driver's blocked-tail loop moves off the stale cache. Today
`src/supervisor/main.ts:125` gates on `line.task?.agent_status === 'blocked'` — the very field
`src/supervisor/tasks.ts:17-22` calls *"the badge and wake cache [that] can be stale by a whole
turn"*, and which `applyEvents` overwrites on every applied status event
(`src/supervisor/tick.ts:84-85`). `drain` returns the whole queue directory in one call
(`src/lib/queue.ts:30-52`) and the default `WAKE_ON` is
`['blocked','done','idle','unknown','exited','released']` (`src/lib/config.ts:25`), so one drain can
apply `blocked` then `idle` for the same task: the `agent:blocked` line loses its tail, and in the
reverse order an `agent:idle` line carries a blocked pane's screen. After C1 the correct key is on
the line, so the gate becomes `line.event === 'agent:blocked'` (**A12**).

This is enforced structurally, not by a test: after C1 there is no string on `WakeLine` to compose
early. `tsc` holds the contract, the way `src/lib/phases.ts:36-39` keeps `phases.ts` free of a
`types.ts` import to avoid a cycle rather than testing for one. Only two readers of `WakeLine.text`
exist — `src/supervisor/main.ts:128` and `:212` — and `test/tick.test.ts` never reads `.text`.

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
did not. An age on a transition would always read `0m` — every in-tick mutator stamps
`phase_entered_at = Date.now()` in the same tick (`src/lib/machine.ts:94` via `advanceTasks`,
`deliverPendingAnswers` at `src/supervisor/tasks.ts:341`, `src/supervisor/teardown.ts:28,34`, and
`applyEvents`' own forced `failed`) — so the arrow replaces it (**A3**).

`<event>` is the trigger, one per `wake.push` site:

| Site | Renders |
|---|---|
| `src/supervisor/tick.ts:88-92` (status changed) | `agent:idle`, `agent:done`, `agent:blocked`, `agent:unknown` |
| `src/supervisor/tick.ts:75-78` (`pane.exited`) | `pane exited` / `pane exited, no PR` |
| `src/supervisor/tick.ts:64` (released) | `agent released` |

The `agent:` prefix is the point: `[merge 41m] agent:done` cannot be read as "merge completed"
(**A2**).

`<action>` is an **ordered ladder, first match wins**:

| # | Condition | Renders |
|---|---|---|
| 1 | `phase === 'done'` | `nothing for you — this task is finished` |
| 2 | `taskRow(phase).terminal === true` (`failed`, `orphaned`, `blocked-on-failure`) | `dead end, needs a human` |
| 3 | `phase === 'escalated'` | ``needs a human: `<hpipe> rewind <run_id> <escalated_from ?? '<phase>'> --task <task_id>` `` |
| 4 | `row.actor === 'orchestrator'` (`merge`, `close`, `blocked-on-decision`) | `YOUR move` |
| 5 | `row.actor === 'worker'` (the eight producer rows) | `worker's move` |
| 6 | otherwise — no actor, non-terminal (`queued`, `blocked-on-files`, `ci`, `teardown`) | `nothing for you — the supervisor is driving` |

**[MINOR 4]** Rung 1 was the bare word `done` in v1, which restated the phase box and ended the line
in the exact token the issue was filed over (`[teardown → done] agent:done — done`). It now answers
the actor question, like every other rung.

**[MINOR 2]** Rung 3 **mirrors** `src/lib/status.ts:23-25` — the same invocation and the same
`escalated_from ?? '<phase>'` fallback — but renders the CLI through `hpipeCommand(pluginRoot)`
(`src/lib/render.ts:28-38`) instead of the literal `hpipe` that `status.ts:25` hardcodes. **That
single divergence is the entire reason `describeWake` takes a third parameter and why flow step 6
hoists `hpipe`.** v1 said "copied … not invented here", which an implementer could read as licence
to drop the parameter and ship `hpipe rewind …` to an orchestrator with no `hpipe` on PATH — the
exact failure `render.ts:19-22` documents. `status.ts`'s literal is a latent defect: **A13**.

Rungs 1–6 are **exhaustive over `TASK_ROWS`**, verified by enumerating the table rather than reading
it — all 20 rows classify, and pass 0 re-ran the enumeration independently and agreed.

`detail`, when present, is appended as today: `\n` then each tail line indented four spaces, under
the `- ` bullet exactly as `src/supervisor/main.ts:128` renders it now.

Worked lines:

```
- t5 fix/27-atomic-store-saves (#27) [implement 12m] agent:idle — worker's move
- t5 fix/27-atomic-store-saves (#27) [research → spec] agent:idle — worker's move
- t1 fix/30-launcher-wake-refresh (#30) [ci 2m] agent:idle — nothing for you — the supervisor is driving
- t2 fix/28-bookmark-save-budget (#28) [implement → failed] pane exited, no PR — dead end, needs a human
- t6 refactor/31-unused-i18n-keys (#31) [plan-review 3m] agent:blocked — worker's move
      <up to BLOCKED_TAIL_LINES of pane tail, indented>
```

Note what is **not** in that list: a `merge` line. That is C3's subject.

### C3 (load-bearing, new in v2) — a bounded footer for the lines that are never sent

**[BLOCKER 1]** The digest gains a footer naming every **non-terminal** task whose row has
`actor === 'orchestrator'` and which produced **no** wake line in this digest:

```

also waiting on you:
- t3 fix/37-gate-screen-rotation (#37) [merge 41m] — YOUR move
```

Composed by a second exported function in `src/supervisor/tick.ts`, beside `describeWake` and
sharing its phase box:

```ts
/**
 * Tasks whose row the ORCHESTRATOR owns produce no herdr pane event, so they
 * never reach a digest on their own: t3 sat in `merge` for ~21h on the berean-os
 * run of 2026-09-16 and emitted zero wake lines. Measured on a live run.
 */
export function parkedFooter(
  run: Run, covered: ReadonlySet<string>, now: number, hpipe: string,
): string
```

`covered` is the set of `task_id`s that already have a line in this digest, so a task never appears
twice. It returns `''` when nothing qualifies, and the empty string is never appended.

**Wiring.** `PendingPrompt` gains `footer?: string` **mirroring `phaseNote?`**
(`src/supervisor/deliver.ts:39-40`), `DigestInput` gains `footer: string`, and `deliveriesFor`
picks it up with `group.find((p) => p.footer)?.footer ?? ''` — the identical idiom it already uses
for `phaseNote` at `src/supervisor/deliver.ts:67`. `buildDigest` appends it after `nextPrompt`.
Composition happens in `src/supervisor/main.ts`, which is the only place that has both the run and
`wake` (needed for `covered`); `deliver.ts`'s two functions stay pure string-joiners.

Why this shape rather than a full roster: **A9**. What it deliberately does not do: **A10**.

### C4 — delete `prompts/digest.md`

Delete the file and remove `'digest'` from `ALL` in `test/prompts.test.ts:12`. That makes the
existing "no orphan prompt files" assertion (`test/prompts.test.ts:21-24`) load-bearing for this
file for the first time: with `'digest'` gone from `ALL`, re-adding the template without wiring it
fails the suite. **A5** records why deleting beats wiring.

---

## Data and control flow

Per tick, in `src/supervisor/main.ts`. Only steps marked **[C]** change.

1. `drain(queueDir)` → events (`:114`). Unchanged.
2. `applyEvents(...)` (`:122`). **[C1]** Each `wake.push` carries `event` + `phaseAtEvent` instead
   of `text`; `phaseAtEvent` is captured before any `enterTaskPhase` in that handler.
3. Blocked-tail loop (`:124-131`). **[C1/MAJOR 1]** Gate becomes `line.event === 'agent:blocked'`;
   the result is written to `line.detail`. The `herdr.paneRead` call, the `BLOCKED_TAIL_LINES`
   slice and the `tail.trim().length > 0` guard (`:127`) are unchanged.
4. `saveRun` if changed (`:137`). Unchanged — state is persisted before delivery, so a crash
   between them costs the prompt, not the transition (`:133-136`).
5. CI poll, `pickOneAdvance`, `makeSettledIdleReader` (`:139-152`). Unchanged.
6. **[C]** One clock and one CLI spelling per tick, hoisted above the run loop:
   `const tickNow = Date.now()` and `const hpipe = hpipeCommand(pluginRoot)` — the latter moved up
   from `:239`, where it is already computed once per tick for the stall ladder. The call count is
   identical and every line in one digest agrees on "now", as `stallCandidates(runs, Date.now(), …)`
   (`:288`) takes one stamp for its whole sweep.
7. `evaluateRun` (`:174`) may advance the **run**; `advanceTasks` (`:177`) may advance **tasks**.
   Unchanged — and this is the step C1 exists to sit behind.
8. `deliverPendingAnswers` / `announceDecisions` (`:204-205`). Unchanged. Relevant to **A7**: the
   open decision's question is already pushed to the orchestrator's pane here, once
   (`prompted_at`), which is why rung 4 does not restate it — and why a decision left open for
   hours needs C3's footer rather than a re-prompt.
9. **[C2]** Line assembly (`:212`):

   ```ts
   const covered = new Set<string>()
   const lines = wake.filter((w) => w.run.run_id === run.run_id).map((w) => {
     if (w.task) covered.add(w.task.task_id)
     return `- ${describeWake(w, tickNow, hpipe)}`
   })
   ```

10. **[C3]** `addPending(run.orchestrator_pane, nextPrompt, lines, …)` additionally carries
    `footer: parkedFooter(run, covered, tickNow, hpipe)`.
11. `deliveriesFor` → `buildDigest` (`:224`, `src/supervisor/deliver.ts:50-74`). **[C3]** Appends
    the footer; everything else unchanged.
12. Stall ladder (`:239-292`). Unchanged apart from consuming the hoisted `hpipe`.

**Worked case — the transition arrow.** A worker in `research` writes its note, commits, goes idle.
Step 2 pushes `event: 'agent:idle'`, `phaseAtEvent: 'research'`. Step 7 advances the task to `spec`.
Step 9 composes against the live record: `phaseAtEvent` ≠ `task.phase`, so the box reads
`[research → spec]`. The orchestrator reads "the phase completed", which is true. Today it reads
`done` and, per the issue, corrects itself to *"Research phase done, not the task."*

**Worked case — the counter-case.** The worker goes idle having written nothing. Step 7 advances
nothing. Step 9 renders `[research 34m] agent:idle — worker's move`. The arrow's absence is the
signal; the age is what says this is not progress.

**Worked case — BLOCKER 1, end to end.** t3 enters `merge` at 22:47 and its worker pane goes quiet.
No event fires for t3 ever again. At 23:06 t2's worker goes idle, producing a digest. Step 9's
`covered` is `{t2}`; step 10's `parkedFooter` finds t3 non-terminal with `actor === 'orchestrator'`
and not covered, and appends `also waiting on you: - t3 … [merge 19m] — YOUR move`. Today that
digest mentions t2 only, and t3 stays invisible for the remaining ~21h.

---

## Error handling

`describeWake` and `parkedFooter` are pure, synchronous and allocate nothing beyond their strings;
they perform no I/O. **[MINOR 5]** They are *not* claimed to be total — `taskRow` throws on an
unknown phase (`src/lib/phases.ts:145-149`). That throw is unreachable at `:212`, because
`advanceTasks` already calls `taskRow(task.phase)` at `src/supervisor/tasks.ts:159` inside the same
`try` and kills the tick first. Worth stating precisely, because the `catch` at
`src/supervisor/main.ts:219` skips `saveRun` at `:218` as well as `addPending` at `:213`: a throw
there loses the tick's `advanceTasks` **transitions** from the ledger, not merely the prompt.

| Condition | Behaviour | Precedent / reason |
|---|---|---|
| `line.task === null` | Run-level line: `<run_id> [<run.phase> <age>m]` + event, no action rung | Defensive; all three `wake.push` sites sit inside `const { run, task } = found` (`src/supervisor/tick.ts:56`), so unreachable today (**A14**) |
| `phase_entered_at` in the future (clock skew) | `0m`, never negative | `Math.max(0, …)`, matching `src/lib/status.ts:13` |
| `escalated_from === null` on an `escalated` task | renders the literal `<phase>` | `src/lib/status.ts:25` does exactly this |
| `detail` present but empty after trim | not attached | driver only sets it when `tail.trim().length > 0` (`src/supervisor/main.ts:127`) |
| No task qualifies for the footer | `parkedFooter` returns `''`; nothing appended | the common case — measured max concurrent is 2, usually 0 (**A9**) |
| A footer would be the digest's only content | **no digest is sent** | `deliveriesFor` drops a pending with empty `text` and `events` (`src/supervisor/deliver.ts:53`). Deliberate — **A10** |
| `hpipeCommand` resolves to the absolute `bun run …` form | rendered verbatim into rung 3 | `src/lib/render.ts:28-38`; already true of the stall prompts |

The digest is not rendered through `render()`, so the `{{hpipe}}`-inside-a-value hazard that
`src/supervisor/stall.ts:157-159` documents for `stallAwaiting` cannot reach this path at all. C4 is
why.

---

## Assumptions

**A1 — The fix belongs in the digest, not in a new message.** The issue says *"Put the state in the
line the orchestrator already receives."* A separate periodic status push is a new delivery with its
own cadence, dedup and failure modes beside a path that already reaches the right pane at the right
moment. C3's footer rides the existing delivery for the same reason.

**A2 — `agent_status` stays, prefixed rather than removed.** Removing it loses the only answer to
*"why did this line arrive?"*, and `blocked` carries the pane tail, the most actionable text in any
digest. Scoping it with `agent:` costs six characters. Attackable half: a skimmer may still see the
word `done`. The phase box to its left and the action clause to its right are the mitigations.

**A3 — A transition replaces the age; it does not accompany it.** Every transition observable here
is stamped in the same tick (§C2's mutator list), so the age would read `0m` in every arrow line at
a 1s tick (`src/lib/config.ts:24`). The cost: the age in the phase just *left* is not shown, which
is the one number a reader might want on a transition. Judged not worth a second number; a
one-line change if a reviewer disagrees. Pass 0 verified the stamping claim against every in-tick
mutator and agreed.

**A4 — Bare minutes, `Nm`, matching `src/lib/status.ts:12-14`; and a third private copy of the
arithmetic is accepted.** **[MINOR 1]** The format question and the duplication question are
separate and v1 answered only the first. On format: a 20-hour run renders `1204m`, which is ugly,
and `Xh Ym` is declined anyway because **#14** is adding phase age to `hpipe status` in this same
batch and two independently-invented formats for one quantity is worse than one ugly one. On
duplication: there are already two implementations — `ageMinutes` at `src/lib/status.ts:12-14`
(module-private, clamped) and an inline one at `src/supervisor/stall.ts:70` (unclamped, via
`MS_PER_MINUTE`). This adds a **third**, private to `tick.ts` and clamped. Sharing would mean
either exporting from `status.ts` (#14's file, forbidden by §Non-goals) or a new neutral module
(a new file, and a new pattern for a three-line function). Converging all three belongs to whoever
lands second — most likely #14. Named so it is a choice, not an omission.

**A5 — `prompts/digest.md` is deleted, not wired.** Wiring means `buildDigest` calls `renderPrompt`
and becomes `async`; it is currently pure and sync (`src/supervisor/deliver.ts:22-31`), called from
the pure sync `deliveriesFor`, both directly unit-tested (`test/deliver.test.ts:33-51`, `:53-81`).
It also buys `render()`'s throw-on-unresolved-placeholder contract (`src/lib/render.ts:11`) **at
delivery time, in front of the orchestrator** — the hazard `.claude/agents/plugin-dev.md` names
explicitly — and buys nothing, since a template cannot express `N events:` plus a variable-length
list better than `.join('\n')`. The digest is a machine-assembled status frame, not an instruction
to an agent, which is what every other file in `prompts/` is. C3 makes this more true, not less: the
footer is conditional and list-shaped. *Still the most reversible decision here.*

**A6 — Whose move it is comes from `row.actor`.** That field means exactly "whose pane produces this
phase's completion signal" (`src/lib/phases.ts:12`). Keying on it means a row added to `TASK_ROWS`
gets a correct clause — and correct footer membership — with no edit here, the same property
`src/supervisor/stall.ts:157-159` claims for keying `stallAwaiting` on `row.signal`.

**A7 — Rung 4 and the footer say `YOUR move` and no more.** The concrete command for each
orchestrator-owned row lives in that row's prompt (`prompts/merge.md`, `prompts/close.md`,
`prompts/decision.md`), and for `blocked-on-decision` the question is delivered by
`announceDecisions` (`src/supervisor/main.ts:205`). The phase box says *which* move. Known cost: on
a tick where the row was entered earlier the prompt is not in this message —
`promptForTaskPhase` renders only on the entering tick (`src/supervisor/tasks.ts:171-175`) — so
`YOUR move` is a pointer with nothing local to point at. It is still **true**, which is the bar;
"the prompt is below" would not be, and that is the `0aa1dbf` class of defect this design is
modelled on avoiding.

**A8 — `stallAwaiting` is NOT reused and `src/supervisor/stall.ts` is untouched.** Evidence in
§Rejected alternatives: on rows the digest newly reaches it returns false sentences. Pass 0
reproduced every one from source and agreed.

**A9 — The footer covers `actor === 'orchestrator'` rows only, not a full roster.** A full roster
makes the digest self-sufficient and most literally satisfies the issue's acceptance sentence, at
~6 lines × ~50 digests. The bounded form was chosen **after measuring**, not asserted: reconstructing
occupancy from the berean-os `run.history` gives ten intervals in orchestrator-owned rows, max
concurrent **2**, and 0 for most of the run — so this costs 0–2 lines per digest. It covers exactly
the rows where the orchestrator has a move, which is what the issue asks the digest to report.
Non-orchestrator tasks that produce no event stay invisible: a worker silently stuck is the **stall
ladder's** job (`src/supervisor/stall.ts`), which probes every worker-owned row
(`src/lib/phases.ts:92-116`) and escalates — a working mechanism this design would duplicate.

**A10 — The footer never causes a delivery; it only decorates one.** `deliveriesFor` drops a pending
whose `text` and `events` are both empty (`src/supervisor/deliver.ts:53`), and this design does not
change that. So in a window where **nothing** wakes, a parked task is still unreported. Accepted,
for two reasons: the berean-os run delivered ~50 digests over 20h — roughly one per 24 minutes — so
quiet windows long enough to matter are rare; and the alternative is the supervisor emitting
unprompted digests on a 1s tick (`src/lib/config.ts:24`), which needs its own cadence and dedup
state and would spam the orchestrator once per second. The complete fix is **#19**, making those
rows stallable, which reuses the existing ladder instead of inventing a second cadence. **This is
the largest remaining gap against the issue's acceptance sentence and is stated so it is reviewed.**

**A11 — One source file outside the declared `--files` set: `src/supervisor/main.ts`.** **[MINOR 3]**
v1 said "two" while also adding fourteen cases to `test/tick.test.ts`, which is not in `t2.files`
either — naming one test file and not the other. The issue-9 convention settles it:
*"`--files` declares the implementation surface and its tests follow it"*
(`docs/superpowers/specs/2026-09-17-issue-9-design.md` §Testing strategy). So: one source file,
plus `test/tick.test.ts` and `test/prompts.test.ts` as tests following the surface. `deliver.ts` is
in the declared set and **is** now edited (C3), unlike in v1. Gate re-verified: the sibling `t1`
declares `["src/cli.ts","prompts/intake.md","prompts/dispatch.md","README.md"]`, and `filesOverlap`
(`src/lib/gating.ts:19-21`) is a prefix test — no pair overlaps. `src/lib/status.ts`, the one file
the batch brief gated, is not among them.

**A12 — The blocked tail is gated on the event, not on `task.agent_status`.** **[MAJOR 1]** The
cache is exactly what this issue exists to stop trusting, and C1 puts the right key on the line.
The behaviour change is intended and narrow: today's gate fires per *task*, the new one per *line*,
so a task that goes `blocked → idle` in one drain gets the tail on its `agent:blocked` line and not
on its `agent:idle` line. Note the tail is read from `line.task.pane_id` at delivery time, so a
pane that died between event and delivery yields an empty read and no tail — the existing
`tail.trim().length > 0` guard already covers that.

**A13 — `src/lib/status.ts:25`'s hardcoded `hpipe` is a latent defect, handed to #14, not fixed
here.** It renders `` `hpipe rewind …` `` literally, which is uninvokable for a GitHub-installed
plugin per `src/lib/render.ts:19-22`. Real, out of this task's file set, and #14 is already in that
file. Named so it is not lost.

**A14 — `task: Task | null` is kept rather than tightened.** All three `wake.push` sites are inside
`const { run, task } = found`, so the null branch is unreachable. Narrowing to `Task` is tidier and
is declined because the field is what `src/supervisor/main.ts:125` narrows on, and a run-level
`WakeLine` is a plausible near-future need. One defensive branch, labelled as such in T12.

---

## Testing strategy

TDD, red first, per `prompts/worker-brief.md` §Definition of done. Both new functions are pure and
synchronous, so every rung and every footer rule is directly testable.

**New tests in `test/tick.test.ts`** (which already owns `applyEvents` and its `Run`/`Task`
fixtures, `test/tick.test.ts:1-8`):

| # | Case | Expected |
|---|---|---|
| T1 | `implement`, no transition, `agent:idle` | `t1 fix/x (#7) [implement 12m] agent:idle — worker's move` — the whole grammar, pinned once |
| T2 | `phaseAtEvent: 'research'`, task now in `spec` | box reads `[research → spec]`; **no** `m` age (**A3**) |
| T3 | `phaseAtEvent === task.phase` | box reads `[<phase> <age>m]`; no arrow |
| T4 | `phase: 'done'` | rung 1 — answers the actor question; must **not** be the bare word `done`, and must not say "needs a human" (**MINOR 4**) |
| T5 | `phase: 'failed'`, `'orphaned'`, `'blocked-on-failure'` | rung 2 — `dead end, needs a human` |
| T6 | `phase: 'escalated'`, `escalated_from: 'implement'` | rung 3 contains `rewind <run_id> implement --task t1`; with `escalated_from: null`, the literal `<phase>`; and with `hpipe = 'bun run /p/src/cli.ts'`, **that** string and not `hpipe` (**MINOR 2**) |
| T7 | `phase: 'merge'` / `'close'` / `'blocked-on-decision'` | rung 4 — `YOUR move` |
| T8 | each of the eight `actor: 'worker'` rows | rung 5 — `worker's move` |
| T9 | `phase: 'queued'` / `'blocked-on-files'` / `'ci'` / `'teardown'` | rung 6; and **never** the string `intake` (the falsehood **A8** avoids) |
| T10 | **`applyEvents` with `blocked` then `idle` for one task in one call** | two lines; `wake[0].event === 'agent:blocked'`, `wake[1].event === 'agent:idle'`. Then the driver's gate attaches `detail` to the first and not the second (**MAJOR 1**, **A12**) |
| T11 | `phase_entered_at` in the future | `0m`, never `-1m` |
| T12 | `task: null` | run-level line, no crash *(characterisation — unreachable, **A14**)* |
| T13 | `applyEvents` on `pane.exited` for a task in `implement` | the line carries `phaseAtEvent: 'implement'`, not `'failed'` — pins capture-before-mutate (§C1) |
| T14 | `applyEvents` on a status change | `wake[0].event` is `agent:done`; `wake[0]` has no `text` property |

**New tests for `parkedFooter` (C3 / BLOCKER 1):**

| # | Case | Expected |
|---|---|---|
| T15 | run with one task in `merge`, `covered` empty | footer names it, with `[merge <age>m] — YOUR move` |
| T16 | same task, but its id is in `covered` | `''` — never listed twice |
| T17 | tasks in `research`, `ci`, `blocked-on-files` only | `''` — worker- and no-actor rows are not the footer's business (**A9**) |
| T18 | task in `done` / `failed` / `orphaned` / `blocked-on-failure` | `''` — non-terminal only |
| T19 | two tasks in `merge` and `blocked-on-decision` | both listed, stable order by `task_id` |
| T20 | run with no tasks | `''`, no crash |

**New test in `test/deliver.test.ts` (the C3 wiring seam):**

| # | Case | Expected |
|---|---|---|
| T21 | `deliveriesFor` with an orchestrator pending carrying `footer` | the footer appears in the delivered text, after `nextPrompt` |
| T22 | a **worker** pending carrying a `footer` | the footer does **not** appear — workers get no digest furniture (`src/supervisor/deliver.ts:62-70`) |
| T23 | orchestrator pending with `footer: ''` | no trailing `also waiting on you:` heading, no stray blank lines |

**Exhaustiveness guard (the test worth writing).** One test iterates **every** phase in `TASK_ROWS`
(`src/lib/phases.ts:89-141`), calls `describeWake`, and asserts the result is non-empty, contains
the phase name, and matches one of the six known action clauses; a second asserts `parkedFooter`'s
membership predicate agrees with `taskRow(phase).actor === 'orchestrator' && !terminal` for every
row. A row added with a new `actor`/`terminal` combination then fails here rather than shipping an
empty clause. This is the analogue of `test/table.test.ts`'s per-row assertions and is the test that
catches the class rather than the instance.

**Edited tests:**

- `test/prompts.test.ts:12` — `'digest'` removed from `ALL` (C4). Verify the guard bites by
  restoring the file and confirming `:21-24` alone goes red.
- `test/tick.test.ts` — the four wake-producing tests at `:71`, `:80`, `:98`, `:114` discard
  `applyEvents`' return value entirely and assert only on mutated task state; the only tests
  touching `wake` are `:53-60` and `:62-69`, both `toHaveLength(0)`. Nothing reads `.text`, so all
  compile unchanged. Pass 0 re-verified this. If one needs editing, C1's blast-radius claim is wrong
  and that is a finding.

**Unchanged and must stay green:** `test/deliver.test.ts:33-51` and `:53-81`, which pin
`buildDigest`'s header, the `N events` count and the no-header-for-workers rule. C3 adds a field; it
must not disturb them.

**Live verification, per `.claude/agents/plugin-dev.md`** (*"If your change touches startup, gating,
delivery or pane I/O, say in your plan how it would be verified against a real herdr session"*).
This change touches delivery. The unit suite proves both functions' output for given inputs; it
**cannot** prove that `main.ts` calls `describeWake` after `advanceTasks`, which is the whole of C1,
nor that `covered` is populated from the same tick's wake. `test/integration/smoke.md:164-165` would
be the natural home for a step — **but that file is ruled to #10 for this batch** (§Non-goals). So
the live check is run and reported rather than written down: drive one task through an artifact
phase in a real herdr session and confirm (a) the delivered line carries a `→` arrow on the tick the
phase advances and a bare `[<phase> <age>m]` box on a tick where the worker merely goes idle, and
(b) with a second task parked in `merge`, that task appears in the footer of a digest triggered by
the first. The observation goes in the PR body; a difference between it and the runbook is a
finding, not a test to make pass.

**Whole-suite gate:** `bun test` (414 pass / 0 fail / 33 files at `2caa714`) and `bun run typecheck`
clean before the PR. CI here runs a PR-title lint only (#35), so both are run locally and reported
in the PR body.

---

## Ledger drift

The berean-os ledger is **not frozen**, and every count taken from it in this document is dated
2026-09-17 14:12 local for that reason. It gained an 80th history entry during the writing of this
spec — `t4 done -> blocked-on-decision` at 2026-09-17T20:05:44.516Z, appended to a run aborted the
previous day. v1 cited "79 transitions" and "2 of 6 tasks"; both had moved by the time pass 0
re-verified them, and the corrected figures landed in `2caa714`. Any later pass re-reading this file
should re-date rather than trust.

---

## Rejected alternatives

- **Reuse `stallAwaiting` (`src/supervisor/stall.ts:161-219`) for the action clause.** v1's first
  design. Dropped because the digest sends it rows the stall ladder never does. Probed rather than
  reasoned about, and pass 0 reproduced every line from source:

  ```
  queued              "intake to be closed"              ← FALSE: a queued task waits on its
                                                            dependency/file gate (src/lib/gating.ts:31-47)
  failed              "an answer to the open decision"   ← FALSE (also done, orphaned,
  done                "an answer to the open decision"      blocked-on-failure — all signal:'manual')
  ci                  "whatever clears ci"               ← true but useless; pinned as the fallback
                                                            by test/stall.test.ts:307-315
  merge               "whatever clears merge"            ← ditto
  teardown            "its worktree to be removed"       ← correct
  ```

  The terminal-first ordering neutralises four, but `queued` would have shipped a false sentence —
  the precise failure `0aa1dbf` fixed, recreated by reusing its fix outside its domain. Repairing
  `stallAwaiting` instead (a task-aware `gate` branch, a `ci` branch) was the runner-up; declined
  because it widens a tested function's contract and rewrites
  `test/stall.test.ts:307-315`'s deliberate characterisation of the fallback, to buy text the phase
  box already carries.

- **A full task roster in the digest** (pass 0's option 1 at full width). **A9**.
- **Declare #19 a prerequisite and close the parked case there** (pass 0's option 2). Declined: it
  blocks #13 on unscheduled work, and the footer is 0–2 lines inside this task's existing file set.
- **Accept the gap and restate the Goal** (pass 0's option 3). Declined: it closes #13 against its
  own acceptance sentence. §Resolution.
- **Emit a digest on a timer when a task is parked.** A new cadence with its own dedup state, on a
  1s tick. **A10**; #19 reuses the ladder instead.
- **Add the phase and age at `src/supervisor/tick.ts:88-91`, leaving composition at event time.**
  The minimal-diff reading, and wrong: `advanceTasks` mutates the same `Task` afterwards, so the
  line would name the phase the task has already left.
- **Wire `prompts/digest.md` through `renderPrompt`.** **A5**.
- **Put `describeWake` in `src/supervisor/deliver.ts`.** `stall.ts` imports `deliver.ts`
  (`src/supervisor/stall.ts:4`), so had the `stallAwaiting` design survived this would have been a
  cycle. `tick.ts` is imported only by `main.ts`, already owns `WakeLine`, is the file the issue
  names, and has a test file. C3's footer is wired the other way — `deliver.ts` consumes a string
  `main.ts` composed — so no import is added there either.
- **Read the failure reason out of `run.history`** (`src/lib/machine.ts:91`) for rung 2.
  Unnecessary: a `failed` task reached that phase via `pane exited, no PR` or `agent released`,
  which is the `<event>` on the same line.
