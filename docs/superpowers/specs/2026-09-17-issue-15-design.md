# Design — issue #15: the stall ladder

Pass 2, written against the **Scope narrowed — 2026-09-17** ruling in `gh issue view 15`. Two
features that grew during the pass-1 revision have left this issue: dead/unreachable pane detection
is **#24**, `DeliveryBudget` is **#25**. What remains is the ladder, which the ruling records as
having survived two adversarial reviews clean.

Builds on `docs/superpowers/research/2026-09-17-issue-15-research.md` — **with one correction: that
note's "dead-orchestrator half" paragraph claims the `attempts.delete` reset is "consistent with 33
further deliveries into a dead pane". That claim is superseded and wrong** (see *Superseded
premises*). Nothing in this spec rests on it, and the retry-budget work it belongs to is now #25.

Baseline re-verified in this worktree: `bun test` → 351 pass / 0 fail, `bun run typecheck` clean.

---

## What changed from pass 1

| Pass-1 finding | Disposition |
| --- | --- |
| **BLOCKER 1** — A19 froze the whole run instead of the dead recipient | **Moot.** A19 is deleted; direction 2 is **#24**. |
| **BLOCKER 2** — `DeliveryBudget` placed in `deliver.ts`, held by t1/#9 | **Moot.** A11/A12 deleted; the retry budget is **#25**. `src/supervisor/deliver.ts` is now import-only. |
| **MAJOR 3** — `StallDeps.accepts` with no `record` | **Moot** with #25. |
| **MAJOR 4** — the gate suppressed the escalation *transition*, not just its prompt | **Structural lesson kept.** The budget half is moot, but **A22** now states the rule the finding was really about: the `escalated` transition and its `persist` are unconditional; only the *send* is ever gated. |
| **MAJOR 5** — `livePanes.size > 0` guard only in prose | **Moot** with #24. |
| **MAJOR 6** — the reset list missed `cmdResume` (`cli.ts:317`) | **Accepted, fixed.** Named in the ruling's in-scope list. See **A23** and the *ruling conflict* note. |
| **MINOR 7** — A22's "ledger before every send" is false on the probe path | **Accepted, fixed.** A22 reworded to what the code actually does. |
| **MINOR 8** — A6 and A20 contradict; the reason string counts holds as probes | **Accepted, fixed** by **A24**: holds get their own counter, so A6 stays literally true and the reason string is truthful. |
| **MINOR 9** — "probe N of 3" is false for A18-excluded rows | **Accepted, fixed** by **A25**: the ladder sentence is composed at the call site, like `{{awaiting}}`. |
| **MINOR 10** — the `worktree` row contradicts the "falls through" sentence, and misreads `teardown` | **Accepted, fixed.** `worktree` is keyed on signal **and** record; the false sentence is deleted. |
| **MINOR 11** — `main.ts:113` vs `:114`; incomplete file list; research note carries a withdrawn claim | **Accepted, all three fixed.** `listRuns` is `main.ts:114` (`:113` is `drain`). The file list below is complete. The note is marked superseded above. |

Everything the pass-1 review listed under *"What is right, and should survive another revision"* is
carried forward unchanged and not re-derived: the **A4/A22** persist fix, **A18** and its signal
table, **A21**'s stallable sets, **A7/A20**'s actor-pane fix, **A13**'s `hpipeCommand` fix, the
P3/P3b diagnoses, and the live-verification section.

---

## Scope

**In scope**, per the ruling, and nothing else:

1. **P1 — the ladder.** Re-probe instead of one-probe-then-silence; persist the counter so it
   survives the per-tick `listRuns` re-read (`ledger.ts:48-62`); escalate at a cap.
2. **A18** — escalation narrowed to `signal` ∈ `artifact`/`verdict`/`pr`.
3. **P3** — the task probe's discarded `artifact_path` (`main.ts:262-264`).
4. `prompts/stall-probe.md`, including `:7`'s *"it will not ask again for this phase."*
5. Resetting the counter where `phase_entered_at` is bypassed — `cmdRewind` **and** `cmdResume`.

**Out of scope, moved:** dead/unreachable pane detection → **#24**; `DeliveryBudget` and the
`main.ts:234` reset bug → **#25**; `phases.ts` → **#19**; artifact-path *derivation* → **#9**;
`announceDecisions`' unbounded retry (`tasks.ts:293-309`) → unfiled, named here so it is not
mistaken for handled.

**Dropped from pass 0/1 to honour "this and nothing else":** the escalation pane tail (old A14). It
used `Herdr.paneRead` (`herdr.ts:77-82`) mirroring `main.ts:124-129` and drew no review finding, but
it is not in the in-scope list. The escalation prompt ships without it. Trivially restorable if the
orchestrator wants it back.

### Files

| File | Basis |
| --- | --- |
| `src/supervisor/stall.ts` | held (ledger) |
| `src/supervisor/main.ts` | held (ledger) |
| `prompts/stall-probe.md` | held (ledger) |
| `src/lib/status.ts` | held (ledger) — **A15** |
| `src/cli.ts` | A23 ruling — `cmdRewind` **and** `cmdResume` (see conflict below) |
| `src/lib/types.ts` | A23 ruling |
| `src/lib/machine.ts` | A23 ruling |
| `test/cli-commands.test.ts` | A23 ruling |
| `src/lib/config.ts` | unheld by any task — `STALL_PROBE_MAX` |
| `prompts/stall-escalate.md` | new |
| `test/stall.test.ts`, `test/phases.test.ts`, `test/status.test.ts`, `test/config.test.ts`, `test/machine-run.test.ts`, `test/machine-task.test.ts`, `test/prompts.test.ts`, `test/integration/smoke.md` | unheld by any task |

**`src/supervisor/deliver.ts` is imported and never edited** — `absoluteArtifactPath`
(`deliver.ts:97-102`) and `artifactPathFor` (`:84-94`) are read-only dependencies. Pass 1's
extraction into that file is withdrawn.

**`src/lib/phases.ts` is not touched.** **A21** is the test that proves it.

> **Ruling conflict, flagged not resolved.** The ruling's *Files this task holds* line says
> `src/cli.ts` (**`cmdRewind` only**), but its in-scope list mandates resetting the counter at
> **`cmdResume`**, which is in the same file (`cli.ts:304-319`, restamp at `:317`). The two cannot
> both hold. This spec implements **both** resets, because `cmdRewind` alone leaves exactly the
> defect MAJOR 6 found: a run aborted out of `branch-review` at the cap resumes and escalates 60
> minutes later with no probe, and `escalated` is `releasesPane: true` (`phases.ts:70-71`) so
> `pickOneAdvance` skips it (`tick.ts:106-115`) until a human rewinds. If the orchestrator meant the
> narrower file line, say so and the `cmdResume` reset becomes its own issue — but shipping the
> counter without it is shipping a known bug.

---

## Problem

### P1 — one probe per phase entry, ever

`taskStallKey` is `${run_id}:${task_id}:${phase}:${phase_entered_at}` (`stall.ts:62-64`);
`taskStallCandidates` skips any key in `alreadyProbed` (`stall.ts:83`), the run-level equivalent at
`stall.ts:45`. `sendProbes` adds the key on a successful send (`stall.ts:101`). The backing set is a
bare `Set<string>` in `main()` (`main.ts:109`), never persisted — `saveRun` serialises the `Run`
only (`ledger.ts:44-46`) and `Task` has no probe field (`types.ts:44-80`). One probe, then silence.

`prompts/stall-probe.md:7` states it to the agent as a feature: *"it will not ask again for this
phase."*

### P3 — the task probe discards the artifact path

The run-level probe resolves a real path (`main.ts:241`, `:247`); the task-level probe substitutes a
sentence (`main.ts:262-264`), which `prompts/stall-probe.md:3-10` renders under "nothing has
appeared at:" before telling the worker to "move it to the path above". `absoluteArtifactPath(run,
task)` already handles the task case (`deliver.ts:100-101`).

**P3b.** `artifactPathFor(run, null)` has no null return — it falls through to
`join('docs/superpowers/reviews', …)` for any run phase (`deliver.ts:92-93`), so `dispatch` and
`execute` are told nothing appeared at an invented review path, and `main.ts:247`'s
`?? 'the expected artifact'` is dead code. P3b is **not a scope addition**: the ruling mandates
replacing the prompt's placeholder, which forces both call sites to change, and the signal-keyed
helper P3 needs answers both. Passing the bogus path on knowingly, through a field being redesigned
in this same change, would be a deliberate regression.

---

## Goal / Non-goals

**Goal.** A stalled run or task is probed repeatedly on a fixed cadence and, where escalation is
meaningful (**A18**), moved to `escalated` after a bounded number of unanswered probes and surfaced
in `hpipe status`. Every probe names what the phase is actually waiting for.

**Non-goals.** **NG1** richer liveness (git-dirty) — #15 direction 3, declined; the ladder decides
the same either way. **NG2** widening `stallable` — #19. **NG3** artifact-path derivation — #9.
**NG4** dead-pane detection — #24. **NG5** delivery retry budget — #25.

---

## Assumptions

| # | Assumption | Δ |
| --- | --- | --- |
| A1 | Escalation reuses the existing `escalated` phase. | — |
| A2 | Constant probe interval, not exponential backoff. | — |
| A3 | `STALL_PROBE_MAX` defaults to `3`. | — |
| A4 | The counter is persisted on every accepted probe, via an injected `persist`. | — |
| A5 | Counters are optional fields read through an accessor; `schema_version` stays `2`. | — |
| A6 | `stall_probes` increments **only** on a probe herdr accepted. | literally true again (M8) |
| A7 | Escalation is held while the **row actor's own pane** reports `working`. | — |
| A8 | Probes are not held on `working`. | — |
| A9 | The escalation prompt goes to the orchestrator pane. | — |
| A10 | A new `prompts/stall-escalate.md`. | — |
| A13 | `{{awaiting}}`, keyed on signal **and record**, with the rendered `hpipe` passed in. | amended (M10) |
| A15 | `hpipe status` gains a warning line per escalated task. | — |
| A16 | `stallKey`, `taskStallKey` and `alreadyProbed` are deleted. | — |
| A18 | Escalation only for `signal` ∈ `artifact`/`verdict`/`pr`. | — |
| A20 | A held escalation consumes a slot, so re-checks happen once per `threshold`. | now via `stall_holds` |
| A21 | A test pins the exact stallable sets — the real NG2 guard. | — |
| A22 | The `escalated` transition and its `persist` are unconditional; only sends are gated. | rewritten (M4, M7) |
| A23 | Counter reset at `cmdRewind` **and** `cmdResume`; unheld files per the ruling. | amended (M6) |
| **A24** | **Holds are counted separately from probes.** | new (M8) |
| **A25** | **The ladder sentence is composed at the call site, not templated as a bare ratio.** | new (M9) |

*Deleted: A11, A12 (→#25), A14 (dropped), A17, A19 (→#24).*

---

## Architecture

**Modelled on `delivery_attempts`**, the nearest existing example (research note §4): a persisted
counter on the record (`types.ts:78`, initialised `cli.ts:95`), a config cap (`PROMPT_RETRY_MAX`,
`config.ts:13`, `:31`), plumbed through a `Deps` interface (`tasks.ts:244-248`), checked/
incremented/reset (`tasks.ts:260`, `:277`, `:282`), surfaced in `hpipe status` (`status.ts:29-36`),
cleared by `hpipe rewind` (`cli.ts:179`), documented for the operator (`smoke.md:281`). The
escalation transition is modelled on `advanceLoopingRow` (`machine.ts:113-127`); the injected-
callback shape on `sendProbes` (`stall.ts:97-103`) and `AnswerDeps` (`tasks.ts:244-248`), which
keeps `stall.ts` free of `Herdr`/`Gh` imports.

### A4, A22 — the counter is persisted, and the transition is unconditional

The pass-0 design bumped in memory and saved only on escalation, which does not survive a tick:
`main.ts:114` calls `listRuns`, which `readJson`s each run fresh (`ledger.ts:48-62`), and the only
`saveRun` in the loop (`main.ts:217`) runs *before* the stall block (`main.ts:238-268`). The counter
would have read `0` forever — probing once per `TICK_MS` and never escalating. `StallDeps` therefore
carries `persist: (run: Run) => Promise<void>`. One `saveRun(c.run)` carries a task bump, because the
candidate's `task` is the same object inside `c.run.tasks` (`stall.ts:71-86`) and `saveRun`
serialises the whole `Run` including `tasks` (`ledger.ts:44-46`).

**A22, rewritten.** Pass 1 said "the ledger write precedes every send", which MINOR 7 showed is
false on the probe path and must be: **A6** makes the bump conditional on the send succeeding, so the
probe path is *send → bump → persist*. The rule that actually matters, and what MAJOR 4 was about:

> The `escalated` transition and its `persist` happen **unconditionally**. Only the *send* of
> `stall-escalate` may be skipped or fail. A failed escalation send costs a prompt, never the
> transition — which is what makes `hpipe status` (**A15**) the reliable surface.

### A18 — escalation narrowed to actor-produced signals

`stallable` means "worth a nudge", not "worth killing the task", and `escalated` is in `TERMINAL_BAD`
(`gating.ts:6-8`) so dependents gate to `blocked-on-failure` (`gating.ts:34-38`), and is
`holdsFiles: true` (`phases.ts:131`). Escalation is therefore restricted to `row.signal` ∈
`{'artifact','verdict','pr'}`. Verified executably against `phases.ts`:

```
escalating: branch-review, research, spec, spec-review, plan, plan-review,
            implement, pr-review-intent, pr-review-quality
probe-only: dispatch, execute, blocked-on-files, blocked-on-decision
```

`blocked-on-files` clears only when a *sibling* releases (`machine.ts:186-189`); `blocked-on-decision`
waits on a *human*. Neither is produced by the probed actor working harder. Run `dispatch` is
`worktree` (`phases.ts:54`) and run `execute` is `gate` (`phases.ts:56`), so neither can escalate —
which is also why `dispatch`, alone among run rows in having no `stallWhen`, cannot escalate a
healthy run. The precedent for "eligible for one thing, not another" is `stallWhen`
(`phases.ts:32-39`), which exists because *"`execute` is probed 15 minutes into every run … the
false alarm v4's third review round removed"*. No `phases.ts` change: `row.signal` is already there.

The excluded rows lose nothing human-visible: `formatStatus` already renders the open-decision age
and question (`status.ts:21-26`) and the files-blocked holder with its escape hatch
(`status.ts:38-55`).

### A6, A20, A24 — probes and holds are counted separately

MINOR 8: pass 1 had A6 ("increments only on an accepted probe") and A20 (increments on a hold, with
no send) contradicting each other, and the escalation reason string reported holds as probes. Two
fields resolve it:

```ts
stall_probes?: number   // probes herdr ACCEPTED for this phase entry       (A6, literally)
stall_holds?: number    // escalations deferred because the actor was working (A20)
```

- **Due:** `now - phase_entered_at >= threshold × (probes + holds + 1)` minutes.
- **Action:** `escalate` when `stall_probes >= probeMax` **and** **A18** admits the row; else `probe`.
- **Reason string:** `${stall_probes} stall probes unanswered` — probes actually sent, never holds.

**A20's purpose is cost.** A held candidate stays due; without the hold counter it would be
re-status-read every tick (`TICK_MS` 1000, `config.ts:23`) — ≈36,000 `herdr agent get` calls for a
worker held ten hours. Counting the hold pushes the next evaluation one `threshold` out, so the cost
is **one status read per `threshold` per held candidate** — at the defaults, one per 45 minutes.

### A7 — the hold reads the row actor's own pane

`probePaneFor` collapses a paneless worker onto the orchestrator (`stall.ts:24`, pinned by
`test/stall.test.ts:146-151`), so gating on it would consult an unrelated agent. Escalation gates on:

```ts
function actorPaneFor(run: Run, row: PhaseRow<string>, task: Task | null): string | null {
  return row.actor === 'worker' ? (task?.pane_id ?? null) : run.orchestrator_pane
}
```

`null` means the owning actor has no pane — for an escalation-eligible row the worker is gone, so
escalate without a gate. `Herdr.agentStatus` returns `'unknown'` on failure (`herdr.ts:68-71`), so an
unreachable pane escalates rather than hanging. The gate is `!== 'working'`, deliberately not
`isAgentReady` (`machine.ts:30-32`), which is `idle || done` and would exclude `blocked` — the state
that most needs a human.

### A13, A25 — what the probe says

`stallAwaiting(run, task, hpipe)` replaces `{{artifact_path}}` with `{{awaiting}}`, keyed on
`row.signal` **and** which record it belongs to (MINOR 10):

| `signal` | record | returns |
| --- | --- | --- |
| `artifact` | task | `absoluteArtifactPath(run, task)` |
| `verdict` | task or run | `absoluteArtifactPath(run, task)` (`deliver.ts:88-93`) |
| `pr` | task | `a pushed PR for <branch> (#<issue>)` |
| `files` | task | `another task to release the files this one declared` |
| `manual` | task | `an answer to the open decision` |
| `worktree` | **run** (`dispatch`, `phases.ts:54`) | `a worktree adopted for a dispatched task` |
| `worktree` | **task** (`teardown`, `phases.ts:124`) | `this task's worktree to be removed` |
| `gate` | run (`execute`) | `<hpipe> dispatch --done to close intake` |
| anything else | — | `whatever clears <phase>` |

The `worktree` split is MINOR 10's fix: `teardown` is not stallable today, but #19 will make it so,
and a stalled `teardown` told it awaits a worktree being *adopted* would be wrong — `runTeardown`
removes one (`teardown.ts:25`). Pass 1's sentence claiming `worktree` "falls through to the default"
contradicted its own table and is deleted.

**MAJOR 4 (pass 0) stays fixed:** `hpipe` is passed in as a rendered string. `render` is a single
`String.replace` whose replacement text is never re-scanned and whose throw inspects only
placeholders present in the *template* (`render.ts:8-14`), and `renderPrompt` injects `hpipe` into
the template bag at `render.ts:46` — so a `{{hpipe}}` arriving inside a **value** ships verbatim, and
`test/prompts.test.ts:68-76` cannot catch it because it reads only `prompts/*.md`. Callers pass
`hpipeCommand(pluginRoot)` (`render.ts:28-38`); `pluginRoot` is in scope at both sites (`main.ts:97`).

**A25 — the ladder sentence.** MINOR 9: a bare `probe {{probe}} of {{probe_max}}` is false for every
**A18**-excluded row, where the counter keeps rising and the action stays `probe` forever. Like
`{{awaiting}}`, the sentence is composed at the call site into one `{{ladder}}` placeholder:

- escalation-eligible: `This is probe 2 of 3. After 3 unanswered probes this phase is escalated to
  the human and stops moving on its own.`
- excluded: `This is a standing nudge — this phase is not escalated automatically, and clears when
  whatever it is waiting for arrives.`

`prompts/stall-probe.md:7`'s *"it will not ask again for this phase"* is deleted. The prompt must not
claim that *answering* stops the clock: under **A7** an agent that answers returns to idle within a
turn, so only producing the signal does.

### A5, A23 — fields and resets

```ts
// types.ts — on both Run and Task
stall_probes?: number
stall_holds?: number
```

Read through accessors returning `?? 0`, mirroring `counterFor` (`machine.ts:7-9`). `readJson` does
no validation (`store.ts:5-13`), so older records read `0`. **No `schema_version` bump** —
`isCurrentSchemaRun` is a hard `=== 2` (`main.ts:30-32`) and bumping strands every in-flight run
behind `hpipe abort`. Optional also keeps the diff honest: 11 files / 13 lines construct `Task`
literals (`grep -rl "delivery_attempts: 0" test/ | wc -l` → 11; `-rn … | wc -l` → 13).

Both counters reset at every one of the five `phase_entered_at` writers — verified exhaustively:

```
$ grep -rn "phase_entered_at = " src/
src/cli.ts:180   cmdRewind, task      src/lib/machine.ts:49   enterRunPhase
src/cli.ts:186   cmdRewind, run       src/lib/machine.ts:94   enterTaskPhase
src/cli.ts:317   cmdResume, run   ← MAJOR 6
```

(`cli.ts:85` and `ledger.ts:32` set it in creation literals; a new record's counters are absent and
read `0`.) `cmdRewind` already resets `passes` and `delivery_attempts` at `cli.ts:178-179`; the run
branch at `:184-187` has no `delivery_attempts` line, so its reset stands on the ladder's own
argument.

---

## Data and control flow

### `stall.ts` — classification (pure)

```ts
export type StallAction = 'probe' | 'escalate'
export interface StallCandidate {
  run: Run; task: Task | null
  action: StallAction
  probe: number                // 1-based, probes only
  escalatable: boolean         // A18 — drives A25's sentence
  minutes: number
  paneId: string               // where the probe is SENT      (probePaneFor)
  actorPaneId: string | null   // whose status gates the hold  (actorPaneFor)
}
export function stallCandidates(runs, now, thresholdMinutes, probeMax): StallCandidate[]
export function taskStallCandidates(runs, now, thresholdMinutes, probeMax): StallCandidate[]
```

Steps 1-3 unchanged from today: `row.stallable` (`stall.ts:35` run, `:74` task); `row.stallWhen`
(`stall.ts:36`); `probePaneFor` (`stall.ts:22-26`). Then the due and action rules above.

### `stall.ts` — application (injected effects)

```ts
export interface StallDeps {
  probe: (c: StallCandidate) => Promise<{ ok: boolean }>
  escalate: (c: StallCandidate) => Promise<void>
  agentStatus: (paneId: string) => Promise<AgentStatus>
  persist: (run: Run) => Promise<void>
}

export async function applyStalls(candidates: StallCandidate[], deps: StallDeps): Promise<void> {
  for (const c of candidates) {
    const record = c.task ?? c.run

    if (c.action === 'probe') {
      if ((await deps.probe(c)).ok) {            // A6 — accepted sends only
        bump(record, 'stall_probes')
        await deps.persist(c.run)                // A4
      }
      continue
    }

    if (c.actorPaneId !== null && (await deps.agentStatus(c.actorPaneId)) === 'working') {
      bump(record, 'stall_holds')                // A20 / A24 — not a probe
      await deps.persist(c.run)
      continue
    }
    await deps.escalate(c)                       // A22 — transitions + persists, THEN sends
  }
}
```

`enterTaskPhase` / `enterRunPhase` are called inside `escalate` in `main.ts`, keeping `stall.ts` free
of a `machine.ts` import — the layering `deliverPendingAnswers` already uses (`tasks.ts:283`).

### One tick

Unchanged through `main.ts:236`. Then the two `applyStalls` calls replace the two `sendProbes` calls
at `main.ts:238-268`. `probe` renders `stall-probe` with `{ run_id, phase, minutes, awaiting:
stallAwaiting(run, task, hpipeCommand(pluginRoot)), ladder }`. `escalate`, in order:
`enterTaskPhase(run, task, 'escalated', \`${stall_probes} stall probes unanswered\`)` →
`saveRun` → render `stall-escalate` → send to `run.orchestrator_pane` (**A9**).

### Config

`STALL_PROBE_MAX: number` into `Config` (`config.ts:4-20`), `3` into `DEFAULTS` (`:22-38`), the key
into `NUMERIC` (`:40-44`) — identical to `PROMPT_RETRY_MAX`. At the shipped thresholds
(`TASK_STALL_MINUTES: 45`, `STALL_MINUTES: 15`, `config.ts:26-27`): a task probes at 45/90/135m and
escalates at **180m**; a run probes at 15/30/45m and escalates at **60m**, for `branch-review` only.
Geometric backoff at factor 2 would put escalation at 675m ≈ 11.25h against a 13h incident, which is
not a fix (**A2**).

### `hpipe status` (A15)

`taskWarnings` (`status.ts:17-59`) gains, mirroring `status.ts:21-26`:

```
  ⚠ t3 escalated from implement 47m ago — needs a human; `hpipe rewind <run> implement --task t3` resumes it
```

using `ageMinutes` (`status.ts:12-14`) and `escalated_from` (`types.ts:57`). Fires for every
escalated task, including ones escalated by `advanceLoopingRow` (`machine.ts:122`).

---

## Error handling

| Failure | Behaviour | Why |
| --- | --- | --- |
| `agentPrompt` rejects a probe | No bump, no persist; stays due, retried next tick | **A6**; `stall.ts:92-96` argues it. Bounding this is **#25** |
| `agentPrompt` rejects the escalation send | Transition already persisted; prompt lost | **A22** — the rule MAJOR 4 was about. `hpipe status` shows it (**A15**) |
| `agentStatus` fails | `'unknown'` (`herdr.ts:70`), `!== 'working'` → escalate | Failing open beats sitting 13 hours |
| `actorPaneId` is `null` | Escalate without the gate | The owning actor has no pane (**A7**) |
| Record has no counters | Read `0` | **A5**; `readJson` does no validation (`store.ts:5-13`) |
| `stallAwaiting` cannot resolve a path | `whatever clears <phase>` | Same shape as today's fallback |
| Probe pane is `null` | No candidate produced (`stall.ts:38-39`, `:76-77`) | Unchanged; `test/stall.test.ts:165-175` pins it |
| `persist` throws | Caught by the tick's `try` (`main.ts:269-271`); counter lost, probe re-sent next tick | A duplicate nudge beats a lost transition |
| Held actor never stops reporting `working` | Never escalates; re-checked once per `threshold` | A live pane with a running agent. A dead one emits `pane.exited` → `failed` (`tick.ts:72-81`) |

**Race, unchanged:** `advanceTasks` runs earlier in the same tick (`main.ts:176`) and may have reset
`phase_entered_at`, so the task is not due. Correct, and today's behaviour.

---

## Testing strategy

Baseline to hold: 351 pass / 0 fail, `tsc --noEmit` clean.

**`test/stall.test.ts` — every call site changes**, not an extension. All 20 tests pass
`alreadyProbed` positionally (`grep -c "new Set(" ` → 18 occurrences) and **A16** replaces that
parameter with `probeMax: number`; three also assert the deleted key format (`:66`, `:72`, `:124`).
New coverage:

- probe 1 due at exactly `threshold`; probe 2 at `2 × threshold`, not at `threshold + 1m`
- **the persistence regression: bump → `persist` → re-load through `listRuns` → assert no candidate
  until `2 × threshold`.** An in-memory assertion cannot catch this and is what let pass 0 ship a
  design that would have done nothing
- `action === 'escalate'` at `probeMax`, not at `probeMax - 1`
- **A18**: `blocked-on-files`, `blocked-on-decision`, run `dispatch`, run `execute` are probed at the
  cap and **never** escalate; the nine escalating rows do
- **A24**: a hold bumps `stall_holds` and not `stall_probes`; the reason string counts probes only
- **A20**: after a hold the next evaluation is one `threshold` later
- **A7**: the gate reads `actorPaneId`; a paneless worker escalates rather than consulting the
  orchestrator (the inverse of `test/stall.test.ts:146-151`, which still pins probe routing)
- escalation proceeds on `idle`, `done`, `blocked`, `unknown`; holds only on `working`
- **A22**: an escalation whose send fails still leaves the record in `escalated`
- `stallAwaiting` per signal **and record**, including both `worktree` cases (MINOR 10); two
  regressions: a task probe never renders `whatever clears research` (**P3**); a run probe in
  `dispatch` never names a `docs/superpowers/reviews/` path (**P3b**)
- **A25**: an excluded row's `{{ladder}}` contains no "of 3"; the rendered stall-probe text contains
  no `{{`

**`test/machine-task.test.ts` / `test/machine-run.test.ts`** — `enterTaskPhase` / `enterRunPhase`
reset both counters.

**`test/cli-commands.test.ts`** — `cmdRewind` resets both counters for a task and for a run;
**`cmdResume` resets them** (MAJOR 6), asserted from a run carrying `stall_probes` at the cap.

**`test/config.test.ts`** — `STALL_PROBE_MAX` defaults to 3 and parses (mirrors `:11-30`).

**`test/status.test.ts`** — the escalated-task warning renders with age and `escalated_from`.

**`test/prompts.test.ts`** — add `stall-escalate` to `ALL` (`:10-14`); the orphan (`:21-24`) and
no-literal-`hpipe` (`:68-76`) tests then cover it. Add: `stall-probe.md` no longer contains
`will not ask again`, and contains `{{awaiting}}` and `{{ladder}}`.

**`test/phases.test.ts` — A21, the real NG2 guard.** `table.test.ts:30-37` only asserts a stallable
row can be probed; adding `stallable: true` to `merge` would pass it. This pins the sets exactly
(values verified by executing the filters against `phases.ts`):

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
and pass 0's BLOCKER 1 was exactly that: a design whose unit tests would all have passed while the
feature did nothing. With `TASK_STALL_MINUTES=1`, `STALL_PROBE_MAX=2`:

1. Probes at ~1m and ~2m with a **real absolute path**, then escalation at ~3m.
2. **Read the run JSON off disk between probes and confirm `stall_probes` is climbing.** The check
   that would have caught pass 0's BLOCKER 1, and not reachable from the unit suite.
3. `hpipe status` shows the ⚠ line; `hpipe rewind … --task` clears it and re-arms.
4. Park a task in `blocked-on-decision` past the cap: probed, never escalated (**A18**), and its
   `{{ladder}}` reads as a standing nudge (**A25**).
5. `hpipe abort` a run at the cap, then `hpipe resume`: it must probe again, not escalate 60 minutes
   later in silence (**MAJOR 6**).

**Pre-PR gate (A23).** After #9 merges: rebase on `main`, re-run `bun test` and `bun run typecheck`,
and state in the PR body that both were re-run post-rebase. A real conflict in `src/cli.ts`,
`src/lib/types.ts`, `src/lib/machine.ts` or `test/cli-commands.test.ts` is a stop and an
`hpipe decide`.

**Operator docs.** `smoke.md` gains a stall-ladder subsection beside the `PROMPT_RETRY_MAX`
paragraph (`:281`) and a recovery-table row (`:473`).

---

## Superseded premises

Recorded so the next reader does not start from a disproved claim:

- **The research note's dead-orchestrator paragraph is wrong.** It says the `attempts.delete` reset
  (`main.ts:234`) is "a 5-tick cycle repeated forever, which is consistent with 33 further
  deliveries into a dead pane". At `TICK_MS` 1000 (`config.ts:23`) that cycle over 13 hours is
  ≈46,800 attempts, not 33; and a delivery is only attempted when the tick produced text
  (`main.ts:159`, `deliver.ts:51`). 33 over 13 hours is ~1 per 24 minutes — the signature of
  **successful** digests into a pane that was **alive** while the agent inside it was rate-limited.
  `main.ts:234` is still a real bug; it is **#25**, and it is not the incident's cause.
- **What would have helped the incident is the ladder in this spec**, via the tasks: a rate-limited
  agent reports something other than `working`, so **A7** does not hold it and it escalates at 180m.

## Rejected alternatives

- **Self-invalidating counters** (`stall_probes_at` stamped with `phase_entered_at`, read as 0 on
  mismatch). Needs no reset sites at all and would survive a sixth `phase_entered_at` bypass. Not
  chosen: the ruling names the reset sites explicitly, and the enumeration above is now verified
  exhaustive. Worth revisiting if a fifth writer ever appears.
- **A new `stalled` phase.** Needs `phases.ts` (**NG2**); duplicates `escalated`'s
  `returnsTo`/`rewind`/`release` machinery (`phases.ts:130-131`, `cli.ts:181`, `:207-211`).
- **Exponential backoff.** 11.25h against a 13h incident (**A2**).
- **Escalating every stallable row.** Pass 0's position; cascades a correctly parked task to
  `blocked-on-failure` (`gating.ts:6-8`, `:34-38`).
- **Memoising `agentStatus` per tick** to bound **A20**'s cost — still one call per second per held
  pane. Counting the hold removes the repetition instead of caching it.
- **Bumping `schema_version` to 3.** Strands every in-flight run behind `hpipe abort`
  (`main.ts:30-32`).
- **Parameterising `escalate.md` with a `{{reason}}`.** Forces a reason field onto the record to
  reach `promptForTaskPhase` (`tasks.ts:78-86`), which the stall block does not use.

## Open decisions

One, flagged above and not resolvable here: the ruling's file line says `src/cli.ts` (`cmdRewind`
only) while its in-scope list mandates the `cmdResume` reset in that same file. This spec implements
both and explains why; the orchestrator should confirm or split it.
