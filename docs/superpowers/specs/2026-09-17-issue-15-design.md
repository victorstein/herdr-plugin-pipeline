# Design — issue #15: re-probe, escalate, and stop talking to dead panes

Pass 0. No review exists for this issue yet (`ls docs/superpowers/reviews/` holds only the
2026-09-13 and 2026-09-15 design reviews), so nothing below is a revision.

Builds on `docs/superpowers/research/2026-09-17-issue-15-research.md`. Every claim about current
behaviour is cited to `file:line` in this worktree at `f872bdc`; the research note carries the
version and baseline evidence (bun 1.3.14, herdr 0.9.0, `bun test` → 351 pass / 0 fail,
`tsc --noEmit` clean).

## Scope boundary

`gh issue view 15` (re-read 2026-09-17, after the orchestrator's edit) fixes the holdings:

- **Held by this task:** `src/supervisor/main.ts`, `prompts/stall-probe.md`, and by extension the
  stall machinery in `src/supervisor/stall.ts`.
- **Not held:** `src/lib/phases.ts` — that is #19 ("ci, merge, close and teardown are not
  stallable"). **No row in `TASK_ROWS` or `RUN_ROWS` changes here.** Which rows are probe-eligible
  stays exactly as `phases.ts:89-141` defines it.
- **Not held:** the artifact *path derivation* — #9 owns `src/cli.ts:88-92` and the question of
  where artifacts live. This spec **calls** `absoluteArtifactPath` (`deliver.ts:97-102`); it does
  not change what that function returns.
- `src/cli.ts` is edited here only at `:177-194` (`cmdRewind`). #9's hunk is `:88-92`. Different
  hunks, but flagged so the merge is expected.

---

## Problem

Three defects, all verified in this worktree.

### P1 — one probe per phase entry, ever

`taskStallKey` is `${run_id}:${task_id}:${phase}:${phase_entered_at}` (`stall.ts:62-64`), and
`taskStallCandidates` skips any key in `alreadyProbed` (`stall.ts:83`); the run-level equivalent
skips at `stall.ts:45`. `sendProbes` adds the key on a successful send (`stall.ts:101`). The set
backing `alreadyProbed` is a bare `Set<string>` created inside `main()` (`main.ts:109`) and never
persisted — `saveRun` serialises the `Run` only (`ledger.ts:44-46`) and `Task` has no probe field
(`types.ts:44-80`).

So: one probe, then silence. There is no counter, no second probe, no escalation. On the berean-os
run of 2026-09-16 that cost 13 hours of five workers sitting on uncommitted work.

`prompts/stall-probe.md:7` states the defect to the agent as if it were a feature: *"it will not
ask again for this phase."*

### P2 — the supervisor never stops talking to a dead orchestrator pane

`main.ts:229-235`: on a failed delivery the per-pane failure count is incremented and, once
`shouldRetry` (`deliver.ts:78-81`) returns false, the supervisor logs "giving up" and then calls
`attempts.delete(delivery.paneId)` (`main.ts:234`). Deleting resets the count to zero, so the next
tick starts at 1 again. "Giving up" is a five-tick cycle repeated forever at `TICK_MS` (1000ms,
`config.ts:23`) — consistent with the 33 further deliveries the issue reports.

`rebindOrchestrator` does run every tick (`main.ts:170`) and re-points a run when it can
disambiguate, but it deliberately keeps a stale pane id when it cannot (`orchestrator.ts:30`,
`:38-41`). `formatStatus` names the condition (`status.ts:99-102`) but is only reached from the CLI
and action paths (`cli.ts:278`, `actions/status.ts:12`), never from the supervisor.

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

**P3b, found while verifying P3 and in scope because it lives in the same two files.** The
run-level branch is wrong too, differently. `artifactPathFor(run, null)` has no null return — it
falls through to `join('docs/superpowers/reviews', \`${run.run_id}-${key}.md\`)` for *any* run phase
(`deliver.ts:92-93`). For `branch-review` that is right. For `dispatch` and `execute` — both
`stallable` (`phases.ts:55`, `:56-59`) and both awaiting something that is not a file — it invents
`docs/superpowers/reviews/<run_id>-dispatch-0.md` and tells the orchestrator nothing has appeared
there. The `?? 'the expected artifact'` fallback at `main.ts:247` is therefore dead code.

---

## Goal

1. A stalled run or task is probed repeatedly on a fixed cadence, and after a bounded number of
   unanswered probes is moved to `escalated` and surfaced in `hpipe status` as needing a human.
2. The supervisor stops re-delivering into a pane it has already given up on.
3. Every stall probe names the actual thing the phase is waiting for, or says plainly that what it
   waits for is not a file.

## Non-goals

- **NG1 — a richer liveness signal.** #15's third direction ("uncommitted changes in the worktree
  distinguish idle-with-work from idle-with-nothing"). Not done; see **A14**.
- **NG2 — making `ci`/`merge`/`close`/`teardown`/`escalated` stallable.** That is #19 and requires
  `phases.ts`, which this task does not hold.
- **NG3 — changing where artifacts live.** That is #9.
- **NG4 — an out-of-band channel to a human when the orchestrator pane is dead.** See **A17**.
- **NG5 — persisting the delivery-retry budget.** See **A12**.

---

## Assumptions

Every behavioural choice, labelled, so the review can attack each one on its own. Rationale follows
inline in the sections that use them.

| # | Assumption |
| --- | --- |
| A1 | Escalation reuses the existing `escalated` phase; no new phase is introduced. |
| A2 | The probe interval is **constant**, not an exponential backoff, despite the issue's wording. |
| A3 | `STALL_PROBE_MAX` defaults to `3`. |
| A4 | The probe counter is persisted on the run/task record, replacing the in-process `probed` set. |
| A5 | The counter is an **optional** field read through an accessor; `schema_version` stays `2`. |
| A6 | The counter increments only on a probe that herdr accepted. |
| A7 | Escalation is held while a live `agent status` read on the actor's pane returns `working`. |
| A8 | Probes are **not** held on `working` — today's behaviour is preserved. |
| A9 | The escalation prompt is delivered to the orchestrator pane, never to the worker's. |
| A10 | A new `prompts/stall-escalate.md`, rather than parameterising `prompts/escalate.md`. |
| A11 | Delivery give-up becomes sticky per pane, cleared by a later successful send to that pane. |
| A12 | Give-up state stays in-process and is not persisted. |
| A13 | `{{artifact_path}}` becomes `{{awaiting}}`, composed at the call site for both levels. |
| A14 | No git-dirty liveness signal; the escalation carries the worker's pane tail instead. |
| A15 | `hpipe status` gains a warning line for every task sitting in `escalated`. |
| A16 | `stallKey`, `taskStallKey` and the `alreadyProbed` parameter are deleted. |
| A17 | Run escalation is best-effort: if the orchestrator pane is unreachable, nothing is delivered. |

---

## Architecture

### Modelled on

`delivery_attempts` — named as the nearest existing example in the research note (§4) and the
pattern this work mirrors field for field:

| `delivery_attempts` | this work |
| --- | --- |
| persisted counter on `Task` (`types.ts:78`), initialised at `cli.ts:95` | `stall_probes` on `Task` and `Run` |
| cap from config, `PROMPT_RETRY_MAX: 5` (`config.ts:13`, `:31`) | `STALL_PROBE_MAX: 3` |
| plumbed through a `Deps` interface (`main.ts:198-202`, `tasks.ts:244-248`) | `StallDeps`, same shape |
| checked, incremented, reset (`tasks.ts:260`, `:277`, `:282`) | same three sites |
| surfaced in `hpipe status` (`status.ts:29-36`) | **A15** |
| cleared by `hpipe rewind` (`cli.ts:179`) | same line |
| documented for the operator (`test/integration/smoke.md:281`) | same section |

The escalation transition itself is modelled on `advanceLoopingRow` (`machine.ts:113-127`):
bump a monotone counter, and at the cap call `enterTaskPhase(run, task, 'escalated', …)`.

The effectful half is modelled on `sendProbes` (`stall.ts:97-103`) and `AnswerDeps`
(`tasks.ts:244-248`): `stall.ts` stays free of `Herdr` and `Gh` imports and takes its side effects
as injected callbacks, so it remains unit-testable exactly as it is today.

### A1 — escalation reuses the existing `escalated` phase

`escalated` already means "stopped on purpose, a human must act, resume with `hpipe rewind`". It
carries `returnsTo: 'escalated_from'` (`phases.ts:130-131`), `enterTaskPhase` stamps
`escalated_from` (`machine.ts:92`), `cmdRewind` clears it (`cli.ts:181`), and `hpipe release`
accepts it as a legitimate target (`cli.ts:207-211`). Inventing a `stalled` phase would duplicate
all of that and would require `phases.ts`, which **NG2** forbids.

Three consequences, all pre-existing and all accepted:

- `escalated` holds its files (`phases.ts:131`). For a stall this is **correct**: the worktree
  holds uncommitted work — that is the whole premise of the issue — so releasing its file
  reservation would let a sibling be dispatched onto overlapping paths. The comment at
  `phases.ts:133-136` already argues exactly this.
- `escalated` is in `TERMINAL_BAD` (`gating.ts:6-8`), so dependents gate to `blocked-on-failure`.
  Recoverable: `cmdRewind` sets `task.phase` directly (`cli.ts:177`).
- Nothing tears an escalated task's worktree down — `runTeardown` only acts on `phase === 'teardown'`
  (`teardown.ts:25`). The human's `hpipe release` is the escape (`status.ts:47-52`).

A run reaching `escalated` stops being advanced at all: the row is `releasesPane: true`
(`phases.ts:70-71`) and `pickOneAdvance` skips such runs (`tick.ts:106-115`). That is the intended
"stop and wait for a human".

### A2, A3 — constant interval, `STALL_PROBE_MAX = 3`

The issue says "re-probe on a backoff". This spec does **not** back off, and that divergence is the
single most attackable choice here.

With a constant interval the nth probe is due at `phase_entered_at + n × threshold`, which means
**no timestamp needs storing** — the schedule is derived from `phase_entered_at`, already persisted
(`types.ts:56`, `:94`), plus the counter. One field instead of two, and self-healing across a
supervisor restart.

Arithmetic, at the shipped defaults (`TASK_STALL_MINUTES: 45`, `STALL_MINUTES: 15`,
`config.ts:26-27`) and `STALL_PROBE_MAX = 3`:

| | probe 1 | probe 2 | probe 3 | escalate |
| --- | --- | --- | --- | --- |
| task | 45m | 90m | 135m | **180m (3h)** |
| run | 15m | 30m | 45m | **60m (1h)** |

Geometric backoff at factor 2 from the same base gives 45 / 135 / 315 / **675m ≈ 11.25h** to
escalate a task. The incident this issue exists to prevent lasted 13 hours. An 11.25-hour
escalation is not a fix. Backoff exists to avoid hammering a busy actor, and the interval is
already 45 minutes; the predictability of `N × threshold` is worth more here than the saved turns.
Two numbers tune it instead of three.

### A4, A5 — the counter is persisted, and optional

`Run` and `Task` each gain:

```ts
/** Stall probes herdr has accepted for the CURRENT phase entry. Reset on every phase entry. */
stall_probes?: number
```

Optional, and read through an accessor, exactly as `counterFor(record, phase)` returns
`record.passes[phase] ?? 0` (`machine.ts:7-9`):

```ts
export function stallProbesFor(record: { stall_probes?: number }): number {
  return record.stall_probes ?? 0
}
```

`readJson` does no validation (`store.ts:5-13`), so a run already on disk simply deserialises
without the key and reads `0`. **`schema_version` stays `2`** (`ledger.ts:38`) — bumping it would
make every in-flight run un-advanceable via `isCurrentSchemaRun` (`main.ts:30-32`) and force the
human to `hpipe abort`, which is a disproportionate price for a counter whose absent value is
unambiguously zero.

Optional rather than required is also what keeps the diff honest: 13 test files construct `Task`
object literals (`grep -rn "delivery_attempts: 0" test/ | wc -l` → 13), and a required field would
turn a behavioural change into a 13-file mechanical edit that hides it.

**Reset points** — the counter is scoped to one phase entry, so it resets wherever
`phase_entered_at` is set:

- `enterRunPhase` (`machine.ts:45-51`) and `enterTaskPhase` (`machine.ts:90-96`) — the two places
  that own a phase entry.
- `cmdRewind`, which sets `phase_entered_at` directly and bypasses both (`cli.ts:180`, `:186`).
  It already resets `passes` and `delivery_attempts` on the same lines (`cli.ts:178-179`); this
  joins them.

### A6 — increment only on an accepted send

`sendProbes` already documents why (`stall.ts:92-96`): marking a probe the send failed on would
drop it silently and for good. The same rule now guards escalation — a probe herdr rejected must
not count toward the cap, because the agent never saw it. `test/stall.test.ts:153-163` pins the
existing behaviour and extends to the counter.

Consequence, preserved not introduced: while sends keep failing, the record stays due and is
retried every tick. That is today's behaviour (the key is only added on `ok`, `stall.ts:101`) and
is what **P2**'s fix bounds at the delivery layer rather than here.

### A7, A8 — escalation is held while the actor is mid-turn

A worker legitimately deep in `implement` for three hours must not be escalated. Before escalating,
the supervisor reads the actor's live status and holds if it is `working`:

```ts
if ((await deps.agentStatus(candidate.paneId)) === 'working') continue  // hold; consume nothing
```

`Herdr.agentStatus` returns `'unknown'` on any failure (`herdr.ts:68-71`), so an unreachable pane
escalates rather than hanging — which is the right default. The check is a **live** read rather
than the cached `task.agent_status` (`types.ts:53`) because `tasks.ts:17-21` documents that the
cached value is the badge/wake cache and can be stale by a whole turn. It costs one extra herdr
call per record per phase entry, only at the moment of escalation.

This is a narrow guard, not a solution. An agent that answers a probe returns to idle within one
turn, so **answering a probe does not stop the clock** — only producing the phase's signal does.
The probe prompt must therefore not claim otherwise (see **A13**).

`isAgentReady` (`machine.ts:30-32`) is deliberately **not** reused: it is `idle || done`, which
would exclude `blocked`, and a blocked agent is exactly the one that needs a human. The gate is
`!== 'working'`, not `isAgentReady`.

**A8:** probes themselves are ungated. Probing a working actor is what happens today and the prompt
tells it to ignore the probe; adding a gate there would change behaviour this issue is not about.

### A9, A10 — the escalation prompt, and where it goes

`advanceTasks` only emits a prompt for a transition **it** made (`tasks.ts:163-170`), and
`advanceTask` has no `escalated` case (`machine.ts:191-192` → `default: return null`), so
`gatherSignals` returns `null` for an escalated task (`tasks.ts:239-240`) and the loop `continue`s
at `:161`. A task moved to `escalated` by the stall block — which runs *after* `advanceTasks` in
the tick (`main.ts:176` vs `:238`) — would therefore **never** get an escalation prompt at all.

So the stall block renders and sends its own, exactly as it already does for `stall-probe`
(`main.ts:242-250`). Because it is not routed through `promptForTaskPhase`, no "why did this
escalate" field is needed on the record.

**A9 — to the orchestrator.** `taskRow('escalated').actor === 'human'` (`phases.ts:130`), and
`actorPane` maps a non-worker actor to `run.orchestrator_pane` (`tasks.ts:105-111`), so existing
task escalations already land there; `announceDecisions` targets the same pane (`tasks.ts:294`,
`:307`). Sending a "you have stopped" message to the stalled worker would be pointless.

**A10 — a separate prompt file.** `prompts/escalate.md` is written for the review-pass case: "This
phase hit {{pass}} review passes without clearing" and "Do not start another pass" (`escalate.md:3`,
`:5`). Neither sentence is true of a stall. Parameterising it would mean threading a reason through
`promptForTaskPhase` (`tasks.ts:78-86`) and `promptForRunPhase` (`deliver.ts:181-187`) and onto the
record, for no gain — the stall block renders directly. `prompts/stall-escalate.md` must be added
to `ALL` in `test/prompts.test.ts:10-14` or the "no orphan prompt files" test fails (`:21-24`), and
must not contain the literal string `hpipe` (`:68-76`).

### A11, A12 — sticky delivery give-up (P2)

The inline block at `main.ts:223-236` is not exported and cannot be unit-tested. It is extracted
into `deliver.ts` beside `shouldRetry` (`deliver.ts:76-81`), which is the precedent for pulling
exactly this kind of predicate out of the loop:

```ts
export class DeliveryBudget {
  private readonly failures = new Map<string, number>()
  private readonly abandoned = new Set<string>()

  /** True when this pane is still worth sending to. */
  accepts(paneId: string): boolean

  /** Records the outcome. Returns 'ok' | 'retry' | 'abandoned' for the caller to log. */
  record(paneId: string, sent: { ok: boolean; code?: string }, max: number): DeliveryOutcome
}
```

`record` on success clears both maps for that pane; on failure it increments and, when
`shouldRetry` returns false, moves the pane to `abandoned` **instead of** deleting its count
(`main.ts:234` is the bug). `accepts` is consulted before each send, and "abandoned" is logged once
on the transition rather than every fifth tick.

No extra wiring is needed for recovery: `rebindOrchestrator` re-points `run.orchestrator_pane` to a
**new** pane id (`orchestrator.ts:43-60`), and a new id is not in `abandoned`, so delivery resumes
by itself.

**A12 — not persisted.** The map is keyed by pane id and a supervisor restart may well face a
different pane topology; re-arming delivery after a restart is correct. This mirrors `attempts`
being loop-local today (`main.ts:107`).

**A17 — the honest limitation.** When the orchestrator pane is dead, the orchestrator pane is also
the only channel this plugin has to a human. A run whose probes and escalations cannot be delivered
will not increment `stall_probes` (**A6**) and will not escalate. The recovery is out-of-band and
already exists and already reads correctly: `formatStatus` prints the gone-pane warning and tells
the human to run `claim` (`status.ts:99-102`), fed live panes from both entry points
(`cli.ts:278`, `actions/status.ts:12`). Adding a second channel (herdr workspace badges via
`workspaceReportTokens`, `herdr.ts:106-113`) is **NG4** — badges are per-task-workspace
(`deliver.ts:192-201`) and a run with a dead orchestrator may have no workspace at all.

### A13 — `{{awaiting}}` replaces `{{artifact_path}}` (P3, P3b)

One helper serves both levels, and it is the only new path-shaped code:

```ts
// stall.ts — imports absoluteArtifactPath from './deliver'; does not change it.
export function stallAwaiting(run: Run, task: Task | null): string
```

| record | row | returns |
| --- | --- | --- |
| task | `signal === 'artifact'` (`research`/`spec`/`plan`, `phases.ts:92-100`) | `absoluteArtifactPath(run, task)` |
| task | `signal === 'verdict'` (the four review rows, `phases.ts:96-116`) | `absoluteArtifactPath(run, task)` — the verdict path, `deliver.ts:88-90` |
| task | `signal === 'pr'` (`implement`, `phases.ts:109`) | `a pushed PR for <branch> (#<issue>)` |
| task | `blocked-on-files` (`signal: 'files'`, `phases.ts:105`) | `another task to release the files this one declared` |
| task | `blocked-on-decision` (`signal: 'manual'`, `phases.ts:126`) | `an answer to the open decision` |
| run | `branch-review` (`signal: 'verdict'`, `phases.ts:64`) | `absoluteArtifactPath(run, null)` |
| run | `dispatch` (`signal: 'worktree'`, `phases.ts:54`) | `a worktree adopted for a dispatched task` |
| run | `execute` (`signal: 'gate'`, `phases.ts:56`) | `hpipe dispatch --done to close intake` — rendered via `{{hpipe}}` |
| either | anything else | `whatever clears <phase>` |

This is a `switch` on `row.signal`, not on the phase name, so **NG2**/#19 making four more rows
stallable does not require touching it — those rows' signals (`ci`, `merged`, `closed`,
`worktree`) fall through to the default until #19 chooses to name them.

`prompts/stall-probe.md` is rewritten: `{{artifact_path}}` → `{{awaiting}}`, the "nothing has
appeared at" framing becomes signal-neutral, "move it to the path above" becomes conditional-free
phrasing, and **`:7`'s "it will not ask again for this phase" is deleted** and replaced by the
ladder: `This is probe {{probe}} of {{probe_max}}.` New placeholders are supplied at both call
sites; `render` throws on any placeholder no caller resolves (`render.ts:11`), so a missed one
fails loudly at delivery rather than shipping through.

### A14 — pane tail instead of a git-dirty signal (NG1)

The issue's third direction asks for a liveness signal richer than "does the artifact exist".
Nothing in `src/` reads git state — the only `git` subprocesses are
`git rev-parse --show-toplevel` (`cli.ts:346`, `actions/claim.ts:14`) — so a dirty-worktree check
means a new `Git` client (it would mirror `Gh`, `gh.ts:28-40`, so it is not an invented pattern)
plus a per-record subprocess.

It is not worth it here, for two reasons. First, the escalation ladder makes the signal much less
load-bearing: a worker that is genuinely working produces its artifact or reads `working`
(**A7**); one that is not gets escalated at 3h whether its worktree is dirty or clean. Dirtiness
changes the *message*, not the *decision*. Second, a strictly better message is already available
for free: `Herdr.paneRead` (`herdr.ts:77-82`), which `main.ts:124-129` already uses to attach
`BLOCKED_TAIL_LINES` (default 8, `config.ts:32`) of a blocked worker's screen to a wake line.

So: **when escalating a task whose `pane_id` is non-null, attach the last `BLOCKED_TAIL_LINES`
lines of its pane to the escalation prompt**, indented, mirroring `main.ts:126-128` exactly. The
last eight lines of a worker's screen distinguish "usage limit reached", "waiting on a permission
prompt" and "crashed" — which a boolean dirty flag cannot.

### A15 — `hpipe status` surfaces it

#15's first direction ends "surface it in `hpipe status` as needing a human". Today an escalated
task renders as an ordinary line, `[escalated]` among the other bits (`status.ts:111-121`), with no
warning. `taskWarnings` (`status.ts:17-59`) gains, mirroring the open-decision line at `:21-26`:

```
  ⚠ t3 escalated from implement 47m ago — needs a human; `hpipe rewind <run> implement --task t3` resumes it
```

using the existing `ageMinutes` helper (`status.ts:12-14`) against `phase_entered_at`, and
`task.escalated_from` (`types.ts:57`) for the origin phase. It fires for **every** escalated task,
not only stall-escalated ones — a task escalated by `advanceLoopingRow` (`machine.ts:122`) is
equally invisible today, and #19 observes the same gap from the other side.

### A16 — the keys and the set are deleted

`stallKey` (`stall.ts:12-14`), `taskStallKey` (`stall.ts:62-64`) and the `alreadyProbed` parameter
on both candidate functions exist only to back the in-process set. With **A4** they are dead.
Deleting them updates three tests that reference the key format directly
(`test/stall.test.ts:66`, `:72`, `:124`). Keeping them as unused exports would leave two ways to
express "has this been probed", which is how they would drift apart.

---

## Data and control flow

### The record

```ts
// types.ts — on both Run and Task
stall_probes?: number
```

Written by the stall block only; read by the stall block and (indirectly, via phase) by
`formatStatus`. Reset at `machine.ts:45-51`, `machine.ts:90-96`, `cli.ts:178-187`.

### Config

`config.ts` gains `STALL_PROBE_MAX: number` in `Config` (`:4-20`), `3` in `DEFAULTS` (`:22-38`),
and the key in `NUMERIC` (`:40-44`) — three edits, identical to `PROMPT_RETRY_MAX`.

### `stall.ts` — classification (pure)

```ts
export type StallAction = 'probe' | 'escalate'

export interface StallCandidate {
  run: Run
  task: Task | null          // null at the run level
  action: StallAction
  probe: number              // 1-based: which probe this is, or MAX+1 when escalating
  minutes: number
  paneId: string
}

export function stallCandidates(runs, now, thresholdMinutes, probeMax): StallCandidate[]
export function taskStallCandidates(runs, now, thresholdMinutes, probeMax): StallCandidate[]
```

Per record, unchanged from today except the last two steps:

1. `row.stallable` — unchanged (`stall.ts:35` run, `:74` task). **No `phases.ts` change (NG2).**
2. `row.stallWhen` for run rows — unchanged (`stall.ts:36`).
3. `probePaneFor` — unchanged (`stall.ts:22-26`), including the worker→orchestrator fallback.
4. **Due:** `now - phase_entered_at >= thresholdMinutes × (stallProbesFor(record) + 1)` minutes.
5. **Action:** `stallProbesFor(record) >= probeMax ? 'escalate' : 'probe'`.

### `stall.ts` — application (injected effects)

`sendProbes` is replaced by `applyStalls`, same DI shape:

```ts
export interface StallDeps {
  probe: (c: StallCandidate) => Promise<{ ok: boolean }>
  escalate: (c: StallCandidate) => Promise<void>
  agentStatus: (paneId: string) => Promise<AgentStatus>
}

export async function applyStalls(candidates: StallCandidate[], deps: StallDeps): Promise<void> {
  for (const c of candidates) {
    if (c.action === 'probe') {
      if ((await deps.probe(c)).ok) bumpStallProbes(c.task ?? c.run)   // A6
      continue
    }
    if ((await deps.agentStatus(c.paneId)) === 'working') continue     // A7 — hold
    await deps.escalate(c)
  }
}
```

`enterRunPhase` / `enterTaskPhase` are called inside the `escalate` callback in `main.ts`, keeping
`stall.ts` free of a `machine.ts` import and matching how `deliverPendingAnswers` calls
`enterTaskPhase` at its own layer (`tasks.ts:283`).

### One tick, end to end

Unchanged up to `main.ts:236`. Then:

```
applyStalls(stallCandidates(runs, now, STALL_MINUTES, STALL_PROBE_MAX), runDeps)
applyStalls(taskStallCandidates(runs, now, TASK_STALL_MINUTES, STALL_PROBE_MAX), taskDeps)
if (anything escalated) await saveRun(stateDir, run)      // see Error handling
```

`probe` renders `stall-probe` with `{ run_id, phase, minutes, awaiting: stallAwaiting(run, task),
probe, probe_max }` and calls `herdr.agentPrompt`.

`escalate` does, in order: read the pane tail when `task.pane_id !== null` (**A14**), call
`enterTaskPhase(run, task, 'escalated', 'N stall probes unanswered')` (which stamps
`escalated_from`, `machine.ts:92`, and resets `stall_probes` per **A5**), `saveRun`, then render
`stall-escalate` and send it to `run.orchestrator_pane` (**A9**). **The ledger write precedes the
send**, mirroring `main.ts:132-136`: a crash between the two loses the prompt, not the transition,
and `hpipe status` then shows the escalated task with **A15**'s warning.

### Delivery (P2)

`main.ts:223-236` becomes:

```ts
for (const delivery of deliveriesFor(pending)) {
  if (!budget.accepts(delivery.paneId)) continue
  const outcome = budget.record(
    delivery.paneId, await herdr.agentPrompt(delivery.paneId, delivery.text),
    config.PROMPT_RETRY_MAX,
  )
  if (outcome === 'abandoned') {
    console.error(`[pipeline] abandoning delivery to ${delivery.paneId} — run \`hpipe status\``)
  }
}
```

with `const budget = new DeliveryBudget()` replacing `const attempts = new Map()` (`main.ts:107`).

---

## Error handling

| Failure | Behaviour | Why |
| --- | --- | --- |
| `agentPrompt` rejects a probe | `stall_probes` is not incremented; the record stays due and is retried next tick | **A6**; `stall.ts:92-96` already argues it |
| `agentPrompt` rejects an escalation prompt | The phase transition **has already been persisted**; the prompt is lost | Ledger-first, `main.ts:132-136`. `hpipe status` shows it (**A15**) |
| `agentStatus` call fails | Returns `'unknown'` (`herdr.ts:70`), which is `!== 'working'`, so escalation proceeds | Failing open beats sitting 13 hours |
| `paneRead` for the tail fails | Returns `''` (`herdr.ts:81`); the escalation prompt ships without a tail | `main.ts:126` already guards on `tail.trim().length > 0` |
| A record deserialised without `stall_probes` | Reads `0` via the accessor | **A5**; `readJson` does no validation (`store.ts:5-13`) |
| `stallAwaiting` cannot resolve a path | Falls through to `whatever clears <phase>` | Same shape as today's fallback, `main.ts:264` |
| A probe's pane is `null` | The candidate is never produced (`stall.ts:38-39`, `:76-77`) | Unchanged. `test/stall.test.ts:165-175` pins it |
| An escalation would target an abandoned pane | Nothing is delivered; the transition still persists | **A17** |
| `saveRun` throws inside the stall block | Caught by the tick's `try` (`main.ts:269-271`); the loop survives | Unchanged |
| Two escalations in one tick | Each calls `saveRun` for its own run; the run object is shared per tick | Matches `main.ts:217` |

**Race worth naming.** `advanceTasks` runs earlier in the same tick (`main.ts:176`) and may have
moved a task into a new phase. `taskStallCandidates` then reads the *new* `phase_entered_at`, so
the task is not due and is not probed. Correct, and it is today's behaviour — the key at
`stall.ts:63` embeds `phase_entered_at` for the same reason.

---

## Testing strategy

Unit tests are `bun test`, colocated in `test/`, and the modules under change are already covered
(`test/stall.test.ts`, 20 tests / 31 `expect()` calls). Baseline to hold: 351 pass, 0 fail,
`tsc --noEmit` clean.

**`test/stall.test.ts`** — extend; three existing tests reference the deleted key format
(`:66`, `:72`, `:124`) and are rewritten against `stall_probes`.

- probe 1 due at exactly `threshold`, not before (replaces `:60-61`, `:110-113`)
- probe 2 due at `2 × threshold` and not at `threshold + 1m`
- `action === 'escalate'` once `stall_probes === probeMax`, and not at `probeMax - 1`
- a successful probe increments; a failed one does not, and the record stays due (extends `:153-163`)
- escalation held when `agentStatus` → `'working'`; counter unchanged; escalate callback not called
- escalation proceeds on `'idle'`, `'done'`, `'blocked'` and `'unknown'` (**A7**'s `!== 'working'`,
  not `isAgentReady`)
- every existing pane-resolution test (`:128-151`, `:165-175`) still passes unchanged — the
  `probePaneFor` contract is untouched
- `stallAwaiting`: an absolute path for each artifact row and each verdict row; a non-path sentence
  for `implement`, `blocked-on-files`, `blocked-on-decision`, run `dispatch`, run `execute`; and
  **a regression test that a task probe never renders the string `whatever clears research`** (P3)
- **a regression test that a run probe in `dispatch` never names a `docs/superpowers/reviews/` path** (P3b)

**`test/machine-task.test.ts` / `test/machine-run.test.ts`** — `enterTaskPhase` and `enterRunPhase`
reset `stall_probes` to 0.

**`test/cli-commands.test.ts`** — `cmdRewind` resets `stall_probes` for both a task and a run,
asserted beside the existing `delivery_attempts` assertion.

**`test/config.test.ts`** — `STALL_PROBE_MAX` defaults to 3 and parses from `config.env`, mirroring
`:11-30`.

**`test/deliver.test.ts`** — `DeliveryBudget`: accepts until the cap; **stops accepting after it**
(the regression test for `main.ts:234`); resumes after a successful send; a fresh pane id is
accepted immediately; `shouldRetry`'s existing non-retryable codes abandon at once.

**`test/status.test.ts`** — the escalated-task warning renders with age and `escalated_from`, and
does not render for a non-escalated task.

**`test/prompts.test.ts`** — add `stall-escalate` to `ALL` (`:10-14`); the existing "no orphan
prompt files" (`:21-24`) and "no prompt hardcodes the hpipe binary" (`:68-76`) tests then cover the
new file for free. Add: `stall-probe.md` no longer contains `will not ask again`, and contains
`{{awaiting}}`, `{{probe}}`, `{{probe_max}}`.

**`test/table.test.ts`** — unchanged and must stay green; it is the guard that **NG2** was honoured
(no row gained or lost `stallable`).

**Live verification — not optional.** This repo's own history is that DI with fakes hides wiring
bugs: the previous live run surfaced startup and gating Criticals that the unit suite passed
cleanly. Before this is called done, against a real herdr session:

1. Start a run, seed a task, and set `TASK_STALL_MINUTES=1`, `STALL_PROBE_MAX=2` in `config.env`.
2. Confirm probes land at ~1m and ~2m with a **real absolute path** in the body, then an escalation
   at ~3m carrying the worker's pane tail.
3. Confirm `hpipe status` shows the ⚠ escalated line and that `hpipe rewind … --task` clears it and
   re-arms the ladder.
4. Kill the orchestrator pane mid-run and confirm the supervisor logs abandonment **once** and then
   goes quiet, rather than cycling every five ticks.

**Operator docs.** `test/integration/smoke.md` gains a stall-ladder subsection beside the existing
`PROMPT_RETRY_MAX` paragraph (`:281`) and a row in the recovery table (`:473`).

---

## Rejected alternatives

- **A new `stalled` phase.** Needs `phases.ts` (**NG2**), and duplicates `escalated`'s
  `returnsTo`/`rewind`/`release` machinery (`phases.ts:130-131`, `cli.ts:181`, `cli.ts:207-211`).
- **Exponential backoff.** 11.25 hours to escalate a task at the shipped defaults — see **A2**.
- **Keeping the in-process `probed` set and adding a separate counter.** Two sources of truth for
  "has this been probed", one of which dies on restart.
- **Bumping `schema_version` to 3.** Strands every in-flight run behind `hpipe abort`
  (`main.ts:30-32`, `status.ts:104-109`) for a field whose absent value is unambiguously 0.
- **Parameterising `escalate.md` with a `{{reason}}`.** Forces a reason field onto the record to
  reach `promptForTaskPhase` (`tasks.ts:78-86`), which the stall block does not use at all.
- **A `Git` client for worktree dirtiness.** **A14**/**NG1** — the pane tail is both cheaper and
  more informative, and reuses `main.ts:124-129`.
- **Gating probes (not just escalation) on `agent_status`.** Changes behaviour this issue is not
  about, and the prompt already tells a working actor to ignore the probe (**A8**).

---

## Open decision

None. Every pattern this work needs already exists in the repo and is named above; no `hpipe decide`
is warranted at this stage.
