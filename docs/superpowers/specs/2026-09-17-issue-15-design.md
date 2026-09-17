# Design — issue #15: re-probe, escalate, and stop talking to panes that cannot answer

Pass 1. Revises the pass-0 spec against
`docs/superpowers/reviews/issue-15-spec-review-0.md` (VERDICT: BLOCKER, 3 BLOCKERs / 5 MAJORs /
4 MINORs). Every finding is dispositioned in **Revision log** below; nothing was silently dropped.

Builds on `docs/superpowers/research/2026-09-17-issue-15-research.md`. Every claim about current
behaviour is cited to `file:line` in this worktree; the research note carries the version and
baseline evidence (bun 1.3.14, herdr 0.9.0, `bun test` → 351 pass / 0 fail, `tsc --noEmit` clean).

---

## Revision log — pass 1

| Finding | Disposition |
| --- | --- |
| **BLOCKER 1** — the "persisted" counter is never persisted; probes become a 1 Hz loop that never escalates | **Accepted, fixed.** `StallDeps` gains `persist`; every accepted probe and every escalation writes the run. **A4** rewritten, **A22** added, regression test added. The reviewer was right and this was the design's worst defect: strictly worse than the behaviour #15 complains about. |
| **BLOCKER 2** — the ladder escalates `blocked-on-files` and `blocked-on-decision`, which are waiting correctly | **Accepted, fixed.** New **A18**: escalation is narrowed to rows whose completion signal is produced by the actor being probed (`signal` ∈ `artifact`/`verdict`/`pr`). Probing is unchanged for every stallable row. Resolved here rather than via `hpipe decide` — see **Why this was not a `decide`**. |
| **BLOCKER 3** — P2's causal story fails arithmetic, and the issue's direction 2 is unimplemented | **Accepted, both halves fixed.** The causal claim is withdrawn and replaced with what the numbers actually support (**P2** rewritten). Direction 2 is now implemented, inside `src/supervisor/main.ts` alone — new **A19**. The old **NG4**/**A17** "accepted limitation" is deleted. |
| **MAJOR 4** — `{{hpipe}}` inside an `{{awaiting}}` value never renders | **Accepted, fixed.** `stallAwaiting` takes the rendered command; **A13** amended; a "no `{{` survives" test added. |
| **MAJOR 5** — A7 reads the wrong pane; cost claim off by four orders of magnitude | **Accepted, fixed.** **A7** now reads the row actor's own pane, not `probePaneFor`'s. The cost is fixed structurally by **A20** (a hold consumes a slot), not by memoisation, so the corrected claim is one status read per `threshold` per held candidate. |
| **MAJOR 6** — probes, escalations and `announceDecisions` bypass `DeliveryBudget` | **Accepted for the two send sites this task owns** (**A11** amended: the budget is passed into `StallDeps`). `announceDecisions` (`tasks.ts:293-309`) is a pre-existing unbounded retry in a file this task does not own; **NG6** records it as out of scope with a pointer. **A19** covers it for the gone-pane case, which is the case #15 names. |
| **MAJOR 7** — run `dispatch` escalates a healthy run at 60m | **Accepted, fixed** — and fixed by **A18** alone: `dispatch`'s signal is `worktree` and `execute`'s is `gate` (`phases.ts:54`, `:56`), so neither is escalation-eligible. Verified below. |
| **MAJOR 8** — A16's blast radius understated; `table.test.ts` mis-cited as the NG2 guard | **Accepted, fixed.** True blast radius stated; the NG2 guard is replaced with a real one (**A21**). |
| **MINOR 9** — "13 test files" miscounts | **Accepted.** 11 files, 13 lines: `grep -rl "delivery_attempts: 0" test/ \| wc -l` → `11`; `grep -rn … \| wc -l` → `13`. |
| **MINOR 10** — `orchestrator.ts` cited under the wrong directory | **Accepted.** It is `src/lib/orchestrator.ts` throughout. |
| **MINOR 11** — "switch on `row.signal`" contradicts the table | **Accepted.** The **A13** table is now genuinely keyed on `row.signal`, with the run/task split expressed as which record the path is resolved against. |
| **MINOR 12** — `cmdRewind`'s run branch has no `delivery_attempts` to sit beside | **Accepted.** `cli.ts:184-187` has no `delivery_attempts` line; the run-side reset is justified on its own terms. |

**Why BLOCKER 2 and BLOCKER 3 were resolved here and not via `hpipe decide`.** The reviewer marked
both as needing the human. Both dissolved once a narrower implementation was found, so there is no
open question left to put to anyone:

- BLOCKER 2 asked which rows `escalated` applies to. `stallWhen` (`phases.ts:32-39`) is the repo's
  existing precedent for "probe-eligible is not the same question as X-eligible", so narrowing by
  signal is an established pattern, not an invention, and it needs no `phases.ts` change.
- BLOCKER 3 offered a choice between implementing direction 2 and getting agreement to ship half of
  #15. A third option exists that the pass-0 spec missed: the gone-pane fact can be computed and
  acted on entirely within `src/supervisor/main.ts`, which this task holds, by calling
  `herdr.paneList()` once per tick exactly as `cli.ts:278` and `actions/status.ts:12` already do.
  Implementing it is therefore neither a scope widening nor a partial ship.

---

## Scope boundary

`gh issue view 15` (re-read after the orchestrator's edit) plus the orchestrator's ruling of
2026-09-17 fix the holdings.

- **Held by this task:** `src/supervisor/main.ts`, `prompts/stall-probe.md`, and the stall
  machinery in `src/supervisor/stall.ts`.
- **Not held, not touched:** `src/lib/phases.ts` — that is #19. **No row in `TASK_ROWS` or
  `RUN_ROWS` changes here**, and **A21** is the test that proves it.
- **Not held, not touched:** artifact-path *derivation* — #9 owns `src/cli.ts:88-92`. This spec
  calls `absoluteArtifactPath` (`deliver.ts:97-102`); it does not change what it returns.
- **Unheld files this task nonetheless edits, under the orchestrator's ruling:** `src/cli.ts`
  (`cmdRewind`, `:177-194`), `src/lib/types.ts`, `src/lib/machine.ts`,
  `test/cli-commands.test.ts`. The pass-0 spec argued these were safe because the hunks are far
  apart. **That reasoning is withdrawn** — distance between hunks is about the odds of a textual
  conflict, not about ownership, and it is the reasoning that produced a broken file lock on the
  run these issues came from. The ruling replaces it (**A23**).
- `src/lib/types.ts` is the real collision risk, not `src/cli.ts`: **A5** adds a field to `Task`,
  and #9's subject is the `artifacts` shape on that same interface.

---

## Problem

Three defects, all verified in this worktree.

### P1 — one probe per phase entry, ever

`taskStallKey` is `${run_id}:${task_id}:${phase}:${phase_entered_at}` (`stall.ts:62-64`) and
`taskStallCandidates` skips any key in `alreadyProbed` (`stall.ts:83`); the run-level equivalent
skips at `stall.ts:45`. `sendProbes` adds the key on a successful send (`stall.ts:101`). The set
backing `alreadyProbed` is a bare `Set<string>` created inside `main()` (`main.ts:109`), never
persisted — `saveRun` serialises the `Run` only (`ledger.ts:44-46`) and `Task` has no probe field
(`types.ts:44-80`).

One probe, then silence. `prompts/stall-probe.md:7` states it to the agent as a feature: *"it will
not ask again for this phase."*

### P2 — the supervisor keeps talking to a pane that cannot answer

**The pass-0 causal claim is withdrawn.** It said `main.ts:234` was "consistent with the 33 further
deliveries the issue reports". It is not, and the reviewer's arithmetic is correct:

- `TICK_MS` defaults to `1000` (`config.ts:23`). A five-tick failure cycle repeated across the
  incident's 13 hours is ≈46,800 attempts and ≈9,360 `giving up` log lines, not 33.
- A delivery is only attempted when the tick produced text: `addPending` returns early on
  `text.length === 0 && eventLines.length === 0` (`main.ts:159`) and `deliveriesFor` re-checks the
  same condition (`deliver.ts:51`). In a fully stalled run most ticks enqueue nothing.

33 deliveries across 13 hours is ~1 per 24 minutes — the signature of 33 **successful**,
event-driven digests into a pane that was **alive** while the agent inside it was rate-limited.
That reframes the whole issue and is worth stating plainly: **the incident's orchestrator pane was
not dead.** `herdr agent prompt` against a live pane succeeds, so a delivery-failure budget would
not have fired once. What would have helped is the task-level ladder (**P1**), because a
rate-limited agent reports something other than `working` and therefore escalates under **A7**.

Two real defects remain under this heading, and they are different from each other:

- **P2a — the retry budget resets itself.** `main.ts:229-235`: once `shouldRetry`
  (`deliver.ts:78-81`) returns false, the supervisor logs "giving up" and then calls
  `attempts.delete(delivery.paneId)` (`main.ts:234`), resetting the count to zero so the next tick
  starts at 1. Genuine bug, fixed here, but **not** the incident's cause.
- **P2b — the gone-pane fact is computed every tick and thrown away.** This is #15's direction 2 as
  written. `rebindOrchestrator` calls `herdr.paneList()` (`src/lib/orchestrator.ts:46-48`) and,
  when it cannot resolve a replacement, deliberately keeps the stale id
  (`src/lib/orchestrator.ts:30`, `:38-41`). Its return value is discarded at `main.ts:170`.
  `formatStatus` names the condition (`src/lib/status.ts:99-102`) but is reached only from
  `cli.ts:278` and `actions/status.ts:12`, never from the supervisor.

### P3 — the task-level probe throws the artifact path away

The run-level probe resolves a real path (`main.ts:241`, `:247`). The task-level probe twenty-one
lines later substitutes a sentence (`main.ts:262-264`):

```ts
artifact_path: taskRow(candidate.task.phase).signal === 'pr'
  ? `a PR for ${branch}`
  : `whatever clears ${candidate.task.phase} for ${branch}`,
```

`prompts/stall-probe.md:3-10` renders that under "nothing has appeared at:" and then says "If you
finished but wrote the file somewhere else, move it to the path above" — where the path above is a
sentence. `absoluteArtifactPath(run, task)` already handles the task case by joining
`task.checkout_path ?? run.repo_root` (`deliver.ts:100-101`).

**P3b.** The run-level branch is wrong differently. `artifactPathFor(run, null)` has no null return
— it falls through to `join('docs/superpowers/reviews', \`${run.run_id}-${key}.md\`)` for any run
phase (`deliver.ts:92-93`). Right for `branch-review`; for `dispatch` and `execute` it invents
`docs/superpowers/reviews/<run_id>-dispatch-0.md`. The `?? 'the expected artifact'` fallback at
`main.ts:247` is dead code.

---

## Goal

1. A stalled run or task is probed repeatedly on a fixed cadence and, **where escalation is
   meaningful** (**A18**), is moved to `escalated` after a bounded number of unanswered probes and
   surfaced in `hpipe status` as needing a human.
2. When a run's orchestrator pane is confirmed absent from herdr's live pane list and cannot be
   rebound, the supervisor stops sending to it — digests, probes, escalations and decision
   announcements alike — and says so once.
3. Every stall probe names the actual thing the phase is waiting for, or says plainly that what it
   waits for is not a file.

## Non-goals

- **NG1 — a richer liveness signal.** #15's third direction. See **A14**.
- **NG2 — making `ci`/`merge`/`close`/`teardown`/`escalated` stallable.** That is #19 and needs
  `phases.ts`. **A21** is the guard.
- **NG3 — changing where artifacts live.** That is #9.
- **NG5 — persisting the delivery-retry budget.** See **A12**.
- **NG6 — bounding `announceDecisions`.** `tasks.ts:293-309` stamps `prompted_at` only on success
  (`:308`), so a failing send retries every tick with no cap of any kind — unlike its sibling
  `deliverPendingAnswers`, which is bounded by the persisted `delivery_attempts` (`tasks.ts:260`).
  Real defect, raised by MAJOR 6, in a file this task does not hold. **A19** removes the gone-pane
  case, which is the case #15 describes; the live-pane-failing-send case wants its own issue. Not
  fixed here, and named so the next reader does not mistake it for handled.

---

## Assumptions

| # | Assumption | Δ |
| --- | --- | --- |
| A1 | Escalation reuses the existing `escalated` phase; no new phase. | — |
| A2 | The probe interval is **constant**, not exponential backoff. | — |
| A3 | `STALL_PROBE_MAX` defaults to `3`. | — |
| A4 | The counter is persisted **on every accepted probe**, via an injected `persist`. | **rewritten (B1)** |
| A5 | The counter is an optional field read through an accessor; `schema_version` stays `2`. | — |
| A6 | The counter increments only on a probe herdr accepted. | — |
| A7 | Escalation is held while the **row actor's own pane** reports `working`. | **amended (M5)** |
| A8 | Probes are not held on `working`. | — |
| A9 | The escalation prompt is delivered to the orchestrator pane. | — |
| A10 | A new `prompts/stall-escalate.md`, not a parameterised `escalate.md`. | — |
| A11 | Delivery give-up is sticky per pane, and **the budget also guards probes and escalations**. | **amended (M6)** |
| A12 | Give-up state stays in-process. | — |
| A13 | `{{awaiting}}` replaces `{{artifact_path}}`, keyed on `row.signal`, **with the rendered `hpipe` passed in**. | **amended (M4, M11)** |
| A14 | No git-dirty liveness; the escalation carries the worker's pane tail. | — |
| A15 | `hpipe status` gains a warning line per escalated task. | — |
| A16 | `stallKey`, `taskStallKey` and `alreadyProbed` are deleted. | — |
| **A18** | **Escalation is narrowed to rows whose signal the probed actor itself produces.** | **new (B2, M7)** |
| **A19** | **A run whose orchestrator pane is gone and unrebindable is skipped entirely for the tick.** | **new (B3)** |
| **A20** | **A held escalation consumes a counter slot, so re-checks happen once per `threshold`.** | **new (M5)** |
| **A21** | **A test pins the exact set of stallable phases, as the real NG2 guard.** | **new (M8)** |
| **A22** | **The ledger write precedes every send, on the probe path as well as the escalation path.** | **new (B1)** |
| **A23** | **Unheld files are edited only under the orchestrator's ruling; a rebase conflict is a stop.** | **new (ruling)** |

*(A17 is deleted — it accepted the dead-orchestrator gap that **A19** now closes.)*

---

## Architecture

### Modelled on

`delivery_attempts` — the nearest existing example, named in the research note §4:

| `delivery_attempts` | this work |
| --- | --- |
| persisted counter on `Task` (`types.ts:78`), initialised at `cli.ts:95` | `stall_probes` on `Task` and `Run` |
| cap from config, `PROMPT_RETRY_MAX: 5` (`config.ts:13`, `:31`) | `STALL_PROBE_MAX: 3` |
| plumbed through a `Deps` interface (`main.ts:198-202`, `tasks.ts:244-248`) | `StallDeps` |
| checked, incremented, reset (`tasks.ts:260`, `:277`, `:282`) | same three sites |
| **written to the ledger by the caller that owns the loop** (`main.ts:217`) | **A4/A22** |
| surfaced in `hpipe status` (`status.ts:29-36`) | **A15** |
| cleared by `hpipe rewind` (`cli.ts:179`) | same line |
| documented for the operator (`test/integration/smoke.md:281`) | same section |

The escalation transition is modelled on `advanceLoopingRow` (`machine.ts:113-127`). The injected-
callback shape is modelled on `sendProbes` (`stall.ts:97-103`) and `AnswerDeps` (`tasks.ts:244-248`),
which keeps `stall.ts` free of `Herdr` and `Gh` imports.

### A4, A22 — the counter is actually persisted (BLOCKER 1)

The pass-0 design bumped the counter in memory and saved only on escalation. That does not survive
a tick: `main.ts:113` calls `listRuns`, which `readJson`s every run fresh
(`ledger.ts:48-62`), and the only `saveRun` in the loop is `main.ts:217` — *inside* the
`for (const run of advancing)` block, which runs before the stall block at `main.ts:238-268`. The
tick then ends. So the counter would have read `0` on every tick: `action` never becomes
`'escalate'`, the due predicate stays satisfied from `threshold` onward, and a stalled task is
probed **once per `TICK_MS`** — once per second — forever. With **A16** having deleted the
in-process set, there would have been no fallback. Strictly worse than the defect #15 reports.

`StallDeps` therefore carries a `persist`, and **A22** orders it:

```ts
persist: (run: Run) => Promise<void>   // saveRun(stateDir, run)
```

called **after the mutation and before the next candidate**, on the probe path as well as the
escalation path. Ledger-first mirrors `main.ts:132-136`: a crash loses a prompt, never a state
transition.

This is the finding the pass-1 test plan is built around: **bump, re-load through `listRuns`, and
assert no candidate is produced until `2 × threshold`.** A test that only inspects the in-memory
object cannot catch it, which is exactly why pass 0 shipped it.

### A18 — escalation is narrowed to actor-produced signals (BLOCKER 2, MAJOR 7)

`stallable` means "worth a nudge". It does not mean "worth killing the task". The pass-0 design
promoted one to the other without re-reading the rows, and the consequences are severe because
`escalated` is in `TERMINAL_BAD` (`gating.ts:6-8`), so dependents gate to `blocked-on-failure`
(`gating.ts:34-38`), and is `holdsFiles: true` (`phases.ts:131`).

A candidate is escalation-eligible only when `row.signal` ∈ `{'artifact', 'verdict', 'pr'}` — the
signals the probed actor produces by its own action. Every other stallable row is probed exactly as
today and never escalated. Verified against `phases.ts`:

| row | signal | escalates? | why |
| --- | --- | --- | --- |
| task `research`/`spec`/`plan` | `artifact` (`:92`, `:94`, `:99`) | **yes** | the worker writes the file |
| task `spec-review`/`plan-review`/`pr-review-intent`/`pr-review-quality` | `verdict` (`:96`, `:101`, `:111`, `:114`) | **yes** | the worker writes the verdict |
| task `implement` | `pr` (`:109`) | **yes** | the worker pushes the PR |
| run `branch-review` | `verdict` (`:64`) | **yes** | the orchestrator writes the verdict |
| task `blocked-on-files` | `files` (`:105`) | no | clears when a **sibling** releases (`machine.ts:186-189`); a sibling legitimately in `implement` >3h is ordinary |
| task `blocked-on-decision` | `manual` (`:126`) | no | waits on a **human**; escalating a sleeping human's queue cascades dependents to `blocked-on-failure` |
| run `dispatch` | `worktree` (`:54`) | no | **this alone fixes MAJOR 7** — `dispatch` has no `stallWhen`, so it would otherwise escalate a healthy run at 60m |
| run `execute` | `gate` (`:56`) | no | clears on `intake_closed` + all tasks terminal (`machine.ts:68-73`), neither of which the probed orchestrator produces by working |

The human-visible half of Goal 1 is not lost for the excluded rows: `formatStatus` already renders
the open-decision age and question (`status.ts:21-26`) and the files-blocked holder with its escape
hatch (`status.ts:38-55`).

The precedent for "eligible for one thing, not another" is `stallWhen` (`phases.ts:32-39`), which
exists because *"`execute` is probed 15 minutes into every run … which is the false alarm v4's
third review round removed"*. **A18** is the same lesson applied one level up, and needs no
`phases.ts` change because it reads `row.signal`, which is already there.

### A19 — act on the gone-pane fact (BLOCKER 3, direction 2)

The supervisor computes liveness every tick and discards it. **A19** consumes it, entirely within
`src/supervisor/main.ts`:

1. Once per tick, before the advancing loop, `const livePanes = new Set((await herdr.paneList()).map((p) => p.pane_id))`
   — the same one-liner as `cli.ts:278` and `actions/status.ts:12`.
2. `rebindOrchestrator` keeps its existing per-run call (`main.ts:170`) and its existing return
   value, which is still discarded; **`src/lib/orchestrator.ts` is not modified.**
3. After the rebind has had its chance, a run whose `orchestrator_pane` is non-null and **not** in
   `livePanes` is `continue`d: no `evaluateRun`, no `advanceTasks`, no `deliverPendingAnswers`, no
   `announceDecisions`, no digest. It is also filtered out of the two `applyStalls` inputs.
4. The condition is logged **once per run per transition into it**, not once per tick, using an
   in-process `Set<string>` of run ids cleared when the pane reappears.

Suppressing the whole run rather than each send site is what makes this cheap and total — it covers
all four senders, including the `announceDecisions` gap of **NG6**, for the case #15 names. The
recovery path is unchanged and already correct: `formatStatus` prints the gone-pane warning and
tells the human to run `claim` (`status.ts:99-102`).

**Cost:** one extra `herdr pane list` per tick. `rebindOrchestrator` already issues one per
advancing run (`src/lib/orchestrator.ts:47`), so this is additive but bounded and constant.

**Deliberate non-extension:** this does **not** try to detect a live pane holding a wedged agent —
the incident's actual shape (**P2**). That case is the task ladder's job, via **A7**.

### A7, A20 — the hold reads the right pane, at the right rate (MAJOR 5)

Pass 0 gated on `c.paneId`, which is `probePaneFor`'s result and collapses a paneless worker onto
the orchestrator (`stall.ts:24`, pinned by `test/stall.test.ts:146-151`). Gating a worker's
escalation on an unrelated agent's status is wrong, and it contradicted **A14**, which reads
`task.pane_id`. Both now use one pane:

```ts
// the pane of the actor that OWNS the row — not the pane the probe is routed to.
function actorPaneFor(run: Run, row: PhaseRow<string>, task: Task | null): string | null {
  return row.actor === 'worker' ? (task?.pane_id ?? null) : run.orchestrator_pane
}
```

`null` means the owning actor has no pane at all, which for an escalation-eligible row means the
worker is gone — escalate without a gate. `Herdr.agentStatus` returns `'unknown'` on any failure
(`herdr.ts:68-71`), so an unreachable pane escalates rather than hanging.

The gate is `!== 'working'`, deliberately **not** `isAgentReady` (`machine.ts:30-32`), which is
`idle || done` and would exclude `blocked` — and a blocked agent is precisely the one that needs a
human.

**A20 fixes the cost, structurally.** Pass 0 claimed "one extra herdr call per record per phase
entry"; a held candidate stays due and would have been re-read every tick — ≈36,000 calls for a
worker held ten hours. Instead, **a hold increments `stall_probes` without sending**. The next
evaluation is then one `threshold` later by the same due formula, the action stays `escalate`
(the counter only rises), and the cost is **one status read per `threshold` per held candidate** —
at the defaults, one per 45 minutes. No memoisation needed, and the corrected sentence is now true.

### A11 — the budget guards every send this task owns (MAJOR 6)

`main.ts:223-236` is extracted into `deliver.ts` beside `shouldRetry` (`deliver.ts:76-81`), which
is the precedent for pulling this kind of predicate out of an untestable loop:

```ts
export class DeliveryBudget {
  accepts(paneId: string): boolean
  record(paneId: string, sent: { ok: boolean; code?: string }, max: number): 'ok' | 'retry' | 'abandoned'
}
```

`record` on success clears the pane; on failure it increments and, when `shouldRetry` returns
false, moves the pane to `abandoned` **instead of deleting its count** — `main.ts:234` is the bug.
`accepts` is consulted before each send and "abandoned" is logged once on the transition.

Amended per MAJOR 6: **the same budget instance is passed into `StallDeps`**, so probe and
escalation sends check `accepts` too. Pass 0 left both calling `herdr.agentPrompt` directly
(`main.ts:251`, `:267`), which would have left a dead pane receiving an unbounded probe stream.

Recovery needs no wiring: `rebindOrchestrator` re-points to a **new** pane id
(`src/lib/orchestrator.ts:43-60`), and a new id is not in `abandoned`.

### A13 — `{{awaiting}}`, keyed on `row.signal` (P3, P3b, MAJOR 4, MINOR 11)

```ts
export function stallAwaiting(run: Run, task: Task | null, hpipe: string): string
```

Keyed on `row.signal`; the record the path resolves against is `task` when one is present and the
run otherwise, which is the whole of the run/task split:

| `row.signal` | returns |
| --- | --- |
| `artifact` | `absoluteArtifactPath(run, task)` |
| `verdict` | `absoluteArtifactPath(run, task)` — the verdict path (`deliver.ts:88-93`) |
| `pr` | `a pushed PR for <branch> (#<issue>)` |
| `files` | `another task to release the files this one declared` |
| `worktree` | `a worktree adopted for a dispatched task` |
| `gate` | `<hpipe> dispatch --done to close intake` |
| `manual` | `an answer to the open decision` |
| anything else | `whatever clears <phase>` |

Keying on signal rather than phase means #19 making four more rows stallable requires no change
here — `ci`, `merged`, `closed` and `worktree` fall through to the default until #19 names them.

**MAJOR 4's fix is the `hpipe` parameter.** Pass 0 wrote `{{hpipe}}` into the `gate` string and
claimed `render` would catch a miss. It would not: `render` is a single `String.replace` pass whose
replacement text is never re-scanned, and its throw inspects only placeholders present in the
*template* (`render.ts:8-14`). A `{{hpipe}}` arriving inside a **value** ships verbatim.
`test/prompts.test.ts:68-76` cannot catch it either — it reads only `prompts/*.md`. So the caller
passes `hpipeCommand(pluginRoot)` (`render.ts:28-38`); `pluginRoot` is already in scope at both
sites (`main.ts:97`).

`prompts/stall-probe.md` is rewritten: `{{artifact_path}}` → `{{awaiting}}`, the framing becomes
signal-neutral, and **`:7`'s "it will not ask again for this phase" is deleted**, replaced by
`This is probe {{probe}} of {{probe_max}}.` The prompt must not claim that *answering* stops the
clock — under **A7** an agent that answers returns to idle within a turn, so only producing the
signal does.

### A1, A2, A3, A5, A6, A8, A9, A10, A12, A14, A15 — unchanged

Carried from pass 0; the reviewer confirmed A2, A5, A10 and A16's substance. In brief:

- **A1** reuses `escalated`: it already carries `returnsTo: 'escalated_from'`
  (`phases.ts:130-131`), `enterTaskPhase` stamps it (`machine.ts:92`), `cmdRewind` clears it
  (`cli.ts:181`), `hpipe release` accepts it (`cli.ts:207-211`).
- **A2/A3**: constant interval; the nth probe is due at `phase_entered_at + n × threshold`, so no
  timestamp is stored. Task: 45 / 90 / 135m, escalate at **180m**. Run: 15 / 30 / 45m, escalate at
  **60m** — but only for `branch-review` now (**A18**). Geometric backoff at factor 2 gives 675m
  ≈ 11.25h against a 13h incident, which is not a fix.
- **A5**: `stall_probes?: number`, read via `stallProbesFor(record) => record.stall_probes ?? 0`,
  mirroring `counterFor` (`machine.ts:7-9`). `readJson` does no validation (`store.ts:5-13`), so an
  older run reads `0`. No `schema_version` bump — `isCurrentSchemaRun` is a hard `=== 2`
  (`main.ts:30-32`) and bumping strands every in-flight run behind `hpipe abort`. Optional also
  keeps the diff honest: **11 files / 13 lines** construct `Task` literals (MINOR 9).
- **A14**: on escalating a task with a non-null `pane_id`, attach `BLOCKED_TAIL_LINES` (default 8,
  `config.ts:32`) of its pane via `Herdr.paneRead` (`herdr.ts:77-82`), mirroring `main.ts:124-129`.
- **A15**: `taskWarnings` (`status.ts:17-59`) gains, mirroring `status.ts:21-26`:
  `⚠ t3 escalated from implement 47m ago — needs a human; \`hpipe rewind …\` resumes it`, using
  `ageMinutes` (`status.ts:12-14`) and `escalated_from` (`types.ts:57`). Fires for every escalated
  task, including ones escalated by `advanceLoopingRow` (`machine.ts:122`).

### A23 — unheld files (the orchestrator's ruling)

`src/cli.ts`, `src/lib/types.ts`, `src/lib/machine.ts` and `test/cli-commands.test.ts` are edited
here although unheld. The ruling, recorded so implementation cannot quietly drift from it:

1. **The `cmdRewind` change stays**, because dropping it leaves a rewound task carrying a stale
   `stall_probes`. `cmdRewind` sets `phase_entered_at = Date.now()` directly (`cli.ts:180`,
   `:186`), bypassing `enterTaskPhase`; without a reset the counter would already be at or past
   `STALL_PROBE_MAX`, so the ladder would escalate on the first due tick instead of re-arming.
   (MINOR 12: the task branch resets `passes` and `delivery_attempts` at `cli.ts:178-179`; the run
   branch at `:184-187` has no `delivery_attempts` line, so the run-side reset stands on this
   reason alone.)
2. **t1's PR (#9) merges first.** Before opening this one: rebase on `main`, re-run `bun test` and
   `bun run typecheck`, and state in the PR body that both were re-run post-rebase.
3. **A real conflict in any of those four files is a stop** — `hpipe decide`, not a hand
   resolution.

---

## Data and control flow

### The record

```ts
// types.ts — on both Run and Task
/** Stall probes sent, plus escalation holds. Reset on every phase entry. */
stall_probes?: number
```

Reset wherever `phase_entered_at` is set: `enterRunPhase` (`machine.ts:45-51`), `enterTaskPhase`
(`machine.ts:90-96`), and `cmdRewind` (`cli.ts:177-194`), which bypasses both.

### Config

`STALL_PROBE_MAX: number` into `Config` (`config.ts:4-20`), `3` into `DEFAULTS` (`:22-38`), the key
into `NUMERIC` (`:40-44`) — identical to `PROMPT_RETRY_MAX`.

### `stall.ts` — classification (pure)

```ts
export type StallAction = 'probe' | 'escalate'
export interface StallCandidate {
  run: Run; task: Task | null
  action: StallAction
  probe: number          // 1-based
  minutes: number
  paneId: string         // where the probe is SENT   (probePaneFor)
  actorPaneId: string | null  // whose status gates escalation (actorPaneFor)
}
export function stallCandidates(runs, now, thresholdMinutes, probeMax): StallCandidate[]
export function taskStallCandidates(runs, now, thresholdMinutes, probeMax): StallCandidate[]
```

Per record — steps 1-3 unchanged from today:

1. `row.stallable` (`stall.ts:35` run, `:74` task). **No `phases.ts` change.**
2. `row.stallWhen` for run rows (`stall.ts:36`).
3. `probePaneFor` (`stall.ts:22-26`), including the worker→orchestrator fallback.
4. **Due:** `now - phase_entered_at >= thresholdMinutes × (stallProbesFor(record) + 1)` minutes.
5. **Action:** `'escalate'` when `stallProbesFor(record) >= probeMax` **and** `row.signal` ∈
   `{'artifact','verdict','pr'}` (**A18**); otherwise `'probe'`.

Note step 5's consequence: an excluded row at the cap produces `'probe'` forever, on a 45-minute
cadence. That is intended — it is a nudge, and `hpipe status` carries the standing warning.

### `stall.ts` — application (injected effects)

```ts
export interface StallDeps {
  accepts: (paneId: string) => boolean                        // A11
  probe: (c: StallCandidate) => Promise<{ ok: boolean; code?: string }>
  escalate: (c: StallCandidate) => Promise<void>
  agentStatus: (paneId: string) => Promise<AgentStatus>
  persist: (run: Run) => Promise<void>                        // A4 / A22
}

export async function applyStalls(candidates: StallCandidate[], deps: StallDeps): Promise<void> {
  for (const c of candidates) {
    const record = c.task ?? c.run
    if (!deps.accepts(c.paneId)) continue                     // A11

    if (c.action === 'probe') {
      if ((await deps.probe(c)).ok) {                         // A6
        bumpStallProbes(record)
        await deps.persist(c.run)                             // A22 — BLOCKER 1
      }
      continue
    }

    if (c.actorPaneId !== null && (await deps.agentStatus(c.actorPaneId)) === 'working') {
      bumpStallProbes(record)                                 // A20 — hold consumes a slot
      await deps.persist(c.run)
      continue
    }
    await deps.escalate(c)                                    // persists internally, then sends
  }
}
```

`enterTaskPhase` / `enterRunPhase` are called inside the `escalate` callback in `main.ts`, keeping
`stall.ts` free of a `machine.ts` import — the same layering as `deliverPendingAnswers`
(`tasks.ts:283`).

### One tick, end to end

```
drain → listRuns → livePanes = paneList()                    // A19 step 1
applyEvents → saveRun → CI poll → pickOneAdvance
for (run of advancing):
    rebindOrchestrator(run)                                  // unchanged, main.ts:170
    if (run.orchestrator_pane && !livePanes.has(it)): log once, continue     // A19
    … evaluateRun / advanceTasks / answers / decisions / badges / saveRun …  // unchanged
deliveries: budget.accepts → agentPrompt → budget.record     // A11, P2a
reachable = runs.filter(r => !r.orchestrator_pane || livePanes.has(r.orchestrator_pane))   // A19
applyStalls(stallCandidates(reachable, now, STALL_MINUTES, MAX),      runDeps)
applyStalls(taskStallCandidates(reachable, now, TASK_STALL_MINUTES, MAX), taskDeps)
```

`probe` renders `stall-probe` with `{ run_id, phase, minutes, awaiting: stallAwaiting(run, task,
hpipeCommand(pluginRoot)), probe, probe_max }`.

`escalate`, in order: read the pane tail when `task.pane_id !== null` (**A14**) →
`enterTaskPhase(run, task, 'escalated', 'N stall probes unanswered')` (stamps `escalated_from`,
`machine.ts:92`, and resets `stall_probes`) → **`saveRun`** → render `stall-escalate` → send to
`run.orchestrator_pane` (**A9**). Ledger before send (**A22**).

---

## Error handling

| Failure | Behaviour | Why |
| --- | --- | --- |
| `agentPrompt` rejects a probe | Counter not incremented, nothing persisted; stays due, retried next tick | **A6**; `stall.ts:92-96` already argues it |
| …and keeps rejecting | `DeliveryBudget` abandons the pane after `PROMPT_RETRY_MAX` | **A11** — pass 0 left this unbounded (MAJOR 6) |
| `agentPrompt` rejects an escalation prompt | The transition is already persisted; the prompt is lost | **A22**. `hpipe status` shows it (**A15**) |
| `agentStatus` fails | `'unknown'` (`herdr.ts:70`), which is `!== 'working'` → escalate | Failing open beats sitting 13 hours |
| `actorPaneId` is `null` | Escalate without the gate | The owning actor has no pane; **A7** |
| `paneRead` fails | `''` (`herdr.ts:81`); escalation ships without a tail | `main.ts:126` already guards on non-empty |
| `paneList` fails | Returns `[]` (`herdr.ts:60`) → **every** run looks unreachable | **Named risk.** Guarded: **A19** suppresses only when `livePanes.size > 0`, mirroring `status.ts:99` |
| Record has no `stall_probes` | Reads `0` | **A5**; `readJson` does no validation (`store.ts:5-13`) |
| `stallAwaiting` cannot resolve a path | `whatever clears <phase>` | Same shape as today's fallback |
| Probe pane is `null` | No candidate produced (`stall.ts:38-39`, `:76-77`) | Unchanged; `test/stall.test.ts:165-175` pins it |
| `persist` throws | Caught by the tick's `try` (`main.ts:269-271`); counter lost, probe re-sent next tick | Duplicate nudge beats a lost transition |

**`paneList` returning `[]` is the one new failure mode this design introduces**, and it is why
**A19** copies `status.ts:99`'s `livePanes.size > 0` guard rather than trusting an empty list. A
herdr hiccup must not silently freeze every run.

**Race, unchanged:** `advanceTasks` runs earlier in the same tick (`main.ts:176`) and may have
reset `phase_entered_at`, so the task is not due and is not probed. Correct, and today's behaviour.

---

## Testing strategy

Baseline to hold: 351 pass / 0 fail, `tsc --noEmit` clean.

**`test/stall.test.ts` — full rewrite of the call sites, not an extension (MAJOR 8).** Pass 0
understated this. All 20 tests pass `alreadyProbed` positionally (`grep -c "new Set(" ` → `18`
occurrences), and **A16** removes that parameter in favour of `probeMax: number`, so every test in
the file changes signature. Three also assert the deleted key format (`:66`, `:72`, `:124`). New
coverage:

- probe 1 due at exactly `threshold`; probe 2 at `2 × threshold` and not at `threshold + 1m`
- **the BLOCKER 1 regression: bump → `persist` → re-load through `listRuns` → assert no candidate
  until `2 × threshold`.** An in-memory-only assertion cannot catch this and is what let pass 0 ship
- `action === 'escalate'` at `probeMax`, not at `probeMax - 1`
- **A18**: `blocked-on-files`, `blocked-on-decision`, run `dispatch` and run `execute` are still
  probed at the cap and **never** return `'escalate'`; `research`/`spec`/`plan`/the four review
  rows/`implement`/run `branch-review` do
- **A7**: the gate reads `actorPaneId`, and a paneless worker escalates rather than consulting the
  orchestrator (the inverse of `test/stall.test.ts:146-151`, which still pins probe routing)
- **A20**: a hold bumps the counter and persists, so the next check is one `threshold` later
- escalation proceeds on `idle`, `done`, `blocked`, `unknown`; holds only on `working`
- **A11**: a candidate whose pane the budget has abandoned produces no send
- `stallAwaiting` per signal, and two regressions: **a task probe never renders
  `whatever clears research`** (P3); **a run probe in `dispatch` never names a
  `docs/superpowers/reviews/` path** (P3b)
- **MAJOR 4**: the fully rendered stall-probe text contains no `{{`

**`test/deliver.test.ts`** — `DeliveryBudget`: accepts until the cap; **stops accepting after it**
(the `main.ts:234` regression); resumes after a success; a fresh pane id is accepted immediately.

**`test/main-*.test.ts` or `test/tick.test.ts`** — **A19**: a run whose `orchestrator_pane` is
absent from a non-empty `livePanes` is skipped and produces no delivery, no probe and no decision
announcement; with `livePanes` empty, nothing is suppressed.

**`test/machine-task.test.ts` / `test/machine-run.test.ts`** — `enterTaskPhase` / `enterRunPhase`
reset `stall_probes`.

**`test/cli-commands.test.ts`** — `cmdRewind` resets `stall_probes` for a task and for a run.

**`test/config.test.ts`** — `STALL_PROBE_MAX` defaults to 3 and parses (mirrors `:11-30`).

**`test/status.test.ts`** — the escalated-task warning renders with age and `escalated_from`.

**`test/prompts.test.ts`** — add `stall-escalate` to `ALL` (`:10-14`); the orphan (`:21-24`) and
no-literal-`hpipe` (`:68-76`) tests then cover it. Add: `stall-probe.md` no longer contains
`will not ask again`, and contains `{{awaiting}}`, `{{probe}}`, `{{probe_max}}`.

**`test/table.test.ts`** — unchanged, but **it is not the NG2 guard** (MAJOR 8). Its stallable test
(`:30-37`) only asserts that a stallable row can be probed; adding `stallable: true` to `merge`
would pass it. **A21** adds the real guard, to `test/phases.test.ts`:

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

**Live verification — not optional.** This repo's history is that DI with fakes hides wiring bugs,
and pass 0's BLOCKER 1 is that failure mode exactly: a design whose unit tests would all have passed
while the feature did nothing. Against a real herdr session, with `TASK_STALL_MINUTES=1`,
`STALL_PROBE_MAX=2`:

1. Probes at ~1m and ~2m with a **real absolute path**, then escalation at ~3m with a pane tail.
2. **Read the run JSON off disk between probes and confirm `stall_probes` is climbing.** This is the
   BLOCKER 1 check and it cannot be done from the unit suite.
3. `hpipe status` shows the ⚠ escalated line; `hpipe rewind … --task` clears it and re-arms.
4. Park a task in `blocked-on-decision` past the cap and confirm it is **probed and never
   escalated** (**A18**).
5. Kill the orchestrator pane mid-run: the supervisor logs suppression **once**, then goes quiet —
   no digests, no probes, no decision announcements (**A19**).

**Pre-PR gate (A23).** After #9 merges: rebase on `main`, re-run `bun test` and `bun run typecheck`,
state in the PR body that both were re-run post-rebase. A real conflict in `src/cli.ts`,
`src/lib/types.ts`, `src/lib/machine.ts` or `test/cli-commands.test.ts` is a stop and an
`hpipe decide`.

**Operator docs.** `test/integration/smoke.md` gains a stall-ladder subsection beside the
`PROMPT_RETRY_MAX` paragraph (`:281`) and a recovery-table row (`:473`).

---

## Rejected alternatives

- **A new `stalled` phase.** Needs `phases.ts` (**NG2**); duplicates `escalated`'s
  `returnsTo`/`rewind`/`release` machinery.
- **Exponential backoff.** 11.25h to escalate against a 13h incident (**A2**).
- **Escalating every stallable row.** Pass 0's position; BLOCKER 2 shows it cascades a correctly
  parked task to `blocked-on-failure` via `gating.ts:6-8`.
- **Memoising the `agentStatus` read per tick** to fix MAJOR 5's cost. Still one call per second per
  held pane. **A20** removes the repetition instead of caching it.
- **Modifying `src/lib/orchestrator.ts` to return a liveness verdict.** Cleaner, but widens the file
  set past the orchestrator's ruling; `paneList()` in `main.ts` gets the same fact from a file this
  task holds (**A19**).
- **Bumping `schema_version` to 3.** Strands every in-flight run behind `hpipe abort`
  (`main.ts:30-32`).
- **Parameterising `escalate.md` with a `{{reason}}`.** Forces a reason field onto the record to
  reach `promptForTaskPhase` (`tasks.ts:78-86`), which the stall block does not use.
- **A `Git` client for worktree dirtiness.** **A14**/**NG1** — the pane tail is cheaper and more
  informative, and reuses `main.ts:124-129`.

---

## Open decisions

None. BLOCKER 2 and BLOCKER 3 were both flagged by the reviewer as needing the human; both were
resolved by finding a narrower implementation inside the files this task already holds, as recorded
in the **Revision log**. If the human disagrees with **A18**'s exclusion list — the one place this
spec narrows #15's literal wording — that is the decision to reverse, and it is a one-line change
to the signal set.
