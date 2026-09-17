# Design — issue #15: the stall ladder

Revision of the scope-narrowed spec, after `docs/superpowers/reviews/issue-15-spec-review-0.md`
(VERDICT: BLOCKER — 1 BLOCKER / 3 MAJORs / 5 MINORs). Every finding is accepted and fixed; the
dispositions are below.

Scope is the **Scope narrowed — 2026-09-17** ruling in `gh issue view 15`: the ladder, and nothing
else. Dead/unreachable pane detection is **#24**; `DeliveryBudget` is **#25**.

Builds on `docs/superpowers/research/2026-09-17-issue-15-research.md`, **except that note's
"dead-orchestrator half" paragraph, which is superseded** — see *Superseded premises*.

Baseline re-verified: `bun test` → 351 pass / 0 fail; `bun run typecheck` clean.

---

## What changed

| Finding | Disposition |
| --- | --- |
| **BLOCKER 1** — no run-phase guard, so tasks inside an aborted run are probed forever and escalated | **Accepted, fixed.** **A26**: task candidates whose run row is `releasesPane` are skipped, matching `pickOneAdvance` (`tick.ts:109`). |
| **MAJOR 2** — the prompt swap left the two sentences that consume the placeholder | **Accepted, fixed.** **A13** rewritten: `stallAwaiting` returns the whole waiting clause, not its object. The template no longer hardcodes "appeared at" or "the path above". |
| **MAJOR 3** — A7's hold is unbounded, and NG1's justification is falsified by it | **Accepted, fixed.** **A27**: holds are capped at `STALL_PROBE_MAX`, so escalation is bounded unconditionally. The uncited "a rate-limited agent does not report `working`" claim is withdrawn. Hold coverage added to both test tiers. |
| **MAJOR 4** — the spec recorded `src/cli.ts`'s basis as the ruling's "unheld" | **Accepted, basis corrected.** Per the orchestrator (2026-09-17): the ruling always knew `src/cli.ts` is t1's and **granted the `cmdRewind` hunk anyway**, conditioned on t1 merging first and this branch rebasing; "unheld" covers only `types.ts`, `machine.ts` and `test/cli-commands.test.ts`. The reviewer was right that the *stated basis* was wrong; it was not, as the reviewer inferred, an unpermitted edit. **A28** is kept regardless, on its own merits — see below. |
| **MINOR 5** — A22's "unconditional" contradicts its own hold branch | **Accepted.** A22 reworded to scope the word to what it actually governs. |
| **MINOR 6** — "the only `saveRun` in the loop"; there are two | **Accepted.** `main.ts:136` and `main.ts:217`; the argument needs the second one only. |
| **MINOR 7** — `dispatch` is not alone in lacking `stallWhen` | **Accepted.** `branch-review` lacks it too (verified by executing the filter). |
| **MINOR 8** — A15 surfaces escalated tasks but not escalated runs | **Accepted.** **A15** now covers both. |
| **MINOR 9** — `stall-escalate.md` named four times, specified nowhere | **Accepted.** Specified below. |

Carried forward unchanged from the reviewer's *"What is right"*: **A18** and its signal table,
**A21**'s stallable sets, **A4**'s persistence fix, **A2**/**A3**'s arithmetic, and the
live-verification section.

---

## Scope

**In scope:** the ladder (re-probe, persist, escalate at a cap); **A18**'s narrowing; **P3**'s
discarded artifact path; `prompts/stall-probe.md`; and the requirement that the counter resets
wherever `phase_entered_at` is bypassed.

**Out, moved:** dead-pane detection → **#24**; `DeliveryBudget` and the `main.ts:234` reset bug →
**#25**; `phases.ts` → **#19**; artifact-path derivation → **#9**; `announceDecisions`' unbounded
retry (`tasks.ts:293-309`) → unfiled, named so it is not mistaken for handled.

**Dropped to honour "this and nothing else":** the escalation pane tail (old A14).

### Files — with the basis stated correctly

Pass 0 recorded `src/cli.ts` as "unheld per the ruling". That basis was wrong, and the correction is
the orchestrator's (2026-09-17): the ruling knew `src/cli.ts` is declared by t1 and **permitted the
`cmdRewind` hunk anyway**, conditioned on t1 merging first and this branch rebasing. **The permission
stands and is unchanged.** "Unheld" applies only to `src/lib/types.ts`, `src/lib/machine.ts` and
`test/cli-commands.test.ts`. The ledger, for the record:

```
$ bun -e "…runs/pipeline/*.json…"
t1 #9  plan         ["src/cli.ts","src/lib/worker-prompt.ts","src/supervisor/tasks.ts",
                     "src/supervisor/deliver.ts","prompts/worker-brief.md"]
t2 #15 spec-review  ["src/supervisor/stall.ts","src/supervisor/main.ts",
                     "prompts/stall-probe.md","src/lib/status.ts"]
```

t1 is in `plan` — actively working. **A28** removes every file in t1's list from this change set.

| File | Basis |
| --- | --- |
| `src/supervisor/stall.ts` | held by t2 |
| `src/supervisor/main.ts` | held by t2 |
| `prompts/stall-probe.md` | held by t2 |
| `src/lib/status.ts` | held by t2 — **A15** |
| `src/lib/types.ts` | declared by neither task |
| `src/lib/config.ts` | declared by neither task |
| `prompts/stall-escalate.md` | new |
| `test/stall.test.ts`, `test/phases.test.ts`, `test/status.test.ts`, `test/config.test.ts`, `test/prompts.test.ts`, `test/integration/smoke.md` | declared by neither task |

**Never edited:** `src/cli.ts`, `src/supervisor/tasks.ts`, `src/supervisor/deliver.ts`,
`src/lib/worker-prompt.ts`, `prompts/worker-brief.md` (all t1); `src/lib/phases.ts` (#19);
`src/lib/machine.ts` (no longer needed — **A28**). `deliver.ts` and `machine.ts` are **imported**
only: `absoluteArtifactPath` (`deliver.ts:97-102`), `enterTaskPhase`/`enterRunPhase`
(`machine.ts:45-51`, `:90-96`).

**A21** is the test that proves `phases.ts` is untouched.

---

## Problem

### P1 — one probe per phase entry, ever

`taskStallKey` is `${run_id}:${task_id}:${phase}:${phase_entered_at}` (`stall.ts:62-64`);
`taskStallCandidates` skips any key in `alreadyProbed` (`stall.ts:83`), the run-level at `:45`.
`sendProbes` adds the key on a successful send (`stall.ts:101`). The backing set is a bare
`Set<string>` in `main()` (`main.ts:109`), never persisted — `saveRun` serialises the `Run` only
(`ledger.ts:44-46`) and `Task` has no probe field (`types.ts:44-80`). One probe, then silence.
`prompts/stall-probe.md:7` states it as a feature: *"it will not ask again for this phase."*

### P2 — the probe cannot name what it is waiting for

The run-level probe resolves a path (`main.ts:241`, `:247`); the task-level probe substitutes a
sentence (`main.ts:262-264`). `prompts/stall-probe.md:3` renders it under "nothing has appeared at:"
and `:9-10` says "move it to the path above" — so a worker is told to move a file to a sentence.

**P2b.** `artifactPathFor(run, null)` has no null return (`deliver.ts:92-93`), so run `dispatch` and
`execute` are told nothing appeared at an invented `docs/superpowers/reviews/…` path, and
`main.ts:247`'s `?? 'the expected artifact'` is dead code.

**P2c (BLOCKER 1's half of it).** The defect is not only the *value*: `stall-probe.md:3` and `:9-10`
assert the value is a filesystem path. Fixing the value alone leaves the assertion false for seven
of nine cases — including `implement`, the most common worker row (`phases.ts:109`).

### P3 — nothing stops the ladder at a run that has been abandoned

`taskStallCandidates` gates only on the **task** row (`stall.ts:73-74`) and the supervisor passes it
every run (`main.ts:255`), not `advancing`. `cmdAbort` sets `run.phase = 'done'` and deliberately
leaves tasks live — "Worktrees and branches are untouched" (`cli.ts:292-302`). Today that is
harmless, because a task gets one probe ever. Under a ladder it means an aborted run's tasks are
probed forever and **escalated**, and `cmdResume` (`cli.ts:304-319`) restores only the run, so
`hpipe abort` / `hpipe resume` would no longer put things back as `smoke.md:477` documents.

---

## Goal / Non-goals

**Goal.** A stalled run or task is probed on a fixed cadence and, where escalation is meaningful
(**A18**) and the run is still live (**A26**), moved to `escalated` within a **bounded** time
(**A27**) and surfaced in `hpipe status` (**A15**). Every probe names what the phase is actually
waiting for, in a sentence that is true of what it names (**A13**).

**Non-goals.** **NG1** richer liveness (git-dirty) — declined; justification restated under **A27**,
because the pass-0 justification was false. **NG2** widening `stallable` → #19. **NG3**
artifact-path derivation → #9. **NG4** dead-pane detection → #24. **NG5** delivery retry budget →
#25.

---

## Assumptions

| # | Assumption | Δ |
| --- | --- | --- |
| A1 | Escalation reuses the existing `escalated` phase. | — |
| A2 | Constant probe interval, not exponential backoff. | — |
| A3 | `STALL_PROBE_MAX` defaults to `3`, and is reused as the hold cap. | amended (M3) |
| A4 | Counters are persisted via an injected `persist`. | — |
| A5 | Counters live in one optional nested field, read through an accessor; `schema_version` stays `2`. | amended (M4) |
| A6 | `stall.probes` increments only on a probe herdr accepted. | — |
| A7 | Escalation is deferred while the row actor's own pane reports `working` — **boundedly**. | amended (M3) |
| A8 | Probes are not deferred on `working`. | — |
| A9 | The escalation prompt goes to the orchestrator pane. | — |
| A10 | A new `prompts/stall-escalate.md`, specified below. | specified (M9) |
| A13 | `stallAwaiting` returns the **whole waiting clause**, not just its object. | rewritten (M2) |
| A15 | `hpipe status` warns for every escalated **task and run**. | amended (M8) |
| A16 | `stallKey`, `taskStallKey` and `alreadyProbed` are deleted. | — |
| A18 | Escalation only for `signal` ∈ `artifact`/`verdict`/`pr`. | — |
| A20 | A deferral consumes a slot, so re-checks happen once per `threshold`. | — |
| A21 | A test pins the exact stallable sets — the real NG2 guard. | — |
| A22 | Once the deferral gate passes, the transition and its `persist` are unconditional. | reworded (M5) |
| A25 | The ladder sentence is composed at the call site. | — |
| **A26** | **A task candidate is skipped when its run row is `releasesPane`.** | new (B1) |
| **A27** | **Deferrals are capped, so escalation is bounded regardless of reported status.** | new (M3) |
| **A28** | **Counters are self-invalidating, so no reset site is edited.** | new (M4) |

*Deleted: A11, A12, A14, A17, A19, A23, A24 (A24 folded into A5's nested field).*

---

## Architecture

### Modelled on

`delivery_attempts` (research note §4): a persisted counter on the record (`types.ts:78`), a config
cap (`PROMPT_RETRY_MAX`, `config.ts:13`, `:31`), plumbed through a `Deps` interface
(`tasks.ts:244-248`), checked/incremented/reset (`tasks.ts:260`, `:277`, `:282`), surfaced in
`hpipe status` (`status.ts:29-36`), documented for the operator (`smoke.md:281`). The escalation
transition is modelled on `advanceLoopingRow` (`machine.ts:113-127`); the injected-callback shape on
`sendProbes` (`stall.ts:97-103`) and `AnswerDeps` (`tasks.ts:244-248`), which keeps `stall.ts` free
of `Herdr`/`Gh` imports.

**A28's self-invalidation is modelled on the code it replaces.** `stallKey`/`taskStallKey`
(`stall.ts:12-14`, `:62-64`) already make `phase_entered_at` part of the probe's identity, and
`stall.ts:93-95` says why: *"The key carries `phase_entered_at`, so a candidate marked probed is
never retried for that phase entry."* **A16** deletes those keys; **A28** keeps their mechanism as a
persisted field instead of discarding it.

### A28, A5 — self-invalidating counters (MAJOR 4)

```ts
// types.ts — on both Run and Task
/** Stall ladder state for ONE phase entry. Absent, or stamped at a stale
 *  `at`, reads as zero — so any code that re-stamps `phase_entered_at`
 *  resets the ladder without needing to know it exists. */
stall?: { at: number; probes: number; holds: number }
```

```ts
export function stallCountsFor(r: { phase_entered_at: number; stall?: StallState }) {
  return r.stall?.at === r.phase_entered_at
    ? { probes: r.stall.probes, holds: r.stall.holds }
    : { probes: 0, holds: 0 }
}
```

Every bump writes `at: r.phase_entered_at` alongside. All five `phase_entered_at` writers are
covered without being touched — verified exhaustive:

```
$ grep -rn "phase_entered_at = " src/
src/cli.ts:180   cmdRewind, task      src/lib/machine.ts:49   enterRunPhase
src/cli.ts:186   cmdRewind, run       src/lib/machine.ts:94   enterTaskPhase
src/cli.ts:317   cmdResume, run
```

(`cli.ts:85` and `ledger.ts:32` set it in creation literals; a new record has no `stall` and reads
zero.) A sixth writer added later is covered too.

**This is a deviation in mechanism from the ruling, which named `cmdRewind` and `cmdResume` as the
reset sites.** The ruling's *requirement* — the counter resets wherever `phase_entered_at` is
bypassed — is met more completely, because it also covers `enterRunPhase`, `enterTaskPhase` and any
writer added later.

**It is not a permissions workaround.** The orchestrator has confirmed the `cmdRewind` edit is
permitted, conditioned on t1 merging first and this branch rebasing. **A28** is chosen because it is
better on its own terms: the enumeration cannot silently fall out of date (it already did once —
pass-1 MAJOR 6 caught the missing `cmdResume`), and it drops `src/cli.ts`, `src/lib/machine.ts` and
`test/cli-commands.test.ts` from the change set, so the permitted-but-contended file is not touched
and the post-rebase conflict surface is smaller. The permission is simply left unused. Flagged under
*Open decisions* so the orchestrator can direct the literal enumeration instead.

Nested object rather than three flat fields: `Task.artifacts` (`types.ts:63-68`) and
`Run.artifacts` (`types.ts:97`) are the repo's precedent, and one field means one write and one
staleness check. **No `schema_version` bump** — `isCurrentSchemaRun` is a hard `=== 2`
(`main.ts:30-32`); `readJson` does no validation (`store.ts:5-13`), so older records read zero.
Optional also keeps the diff honest: 11 files / 13 lines construct `Task` literals.

### A26 — the run-phase guard (BLOCKER 1)

```ts
if (runRow(run.phase).releasesPane === true) continue   // mirrors tick.ts:109
```

added to `taskStallCandidates`. `releasesPane` is on exactly two run rows — `escalated`
(`phases.ts:71`) and `done` (`phases.ts:72`) — which are precisely the states meaning "this run is
not being driven": `pickOneAdvance` already skips them for the same reason (`tick.ts:106-115`), and
`cmdAbort` parks a run in `done` with its tasks intact (`cli.ts:292-302`).

`releasesPane`, not `terminal`: `escalated` is `releasesPane` but **not** `terminal`
(`phases.ts:71`), and an escalated run's tasks must not be escalated out from under the human who
is about to `hpipe rewind` it.

**`stallCandidates` (run level) needs no guard** — it already gates on `row.stallable`, and neither
`escalated` nor `done` is stallable (verified by executing the filter: stallable run rows are
exactly `dispatch`, `execute`, `branch-review`). A test pins that, so the asymmetry is deliberate
rather than an oversight.

### A27, A7, A3 — bounded deferral (MAJOR 3)

Pass 0 deferred escalation indefinitely while the actor reported `working`, then declined **NG1**
on the grounds that "the ladder decides the same either way" — which that deferral falsifies
exactly where a liveness signal would matter. Two corrections:

1. **Deferrals are capped**, reusing `STALL_PROBE_MAX` rather than adding a knob:

   ```
   action = escalate   when probes >= probeMax
   defer               when action is escalate AND holds < probeMax AND actor reports 'working'
   escalate anyway     when holds >= probeMax
   ```

   At the shipped defaults (`TASK_STALL_MINUTES: 45`, `config.ts:27`), a task escalates at **180m**
   when the actor is not working, and at **315m** worst case if it reports `working` throughout.
   Both bounded; nothing waits forever. For a run (`STALL_MINUTES: 15`, `config.ts:26`): **60m** and
   **105m**, for `branch-review` only.

2. **The uncited claim is withdrawn.** Pass 0 asserted a rate-limited agent reports something other
   than `working`. Nothing in this repo or herdr 0.9.0 was found to establish that, so it is not
   relied on. **NG1** now rests on the bound alone: with deferral capped, the ladder escalates
   within a fixed time whatever the pane reports, so a git-dirty signal would change the *message*,
   not the *decision*. That argument is true; the pass-0 one was not.

The gate reads the **row actor's own** pane, not `probePaneFor`'s (which collapses a paneless worker
onto the orchestrator, `stall.ts:24`, pinned by `test/stall.test.ts:146-151`):

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
(`gating.ts:34-38`), and is `holdsFiles: true` (`phases.ts:131`). Escalation is therefore restricted
to `row.signal` ∈ `{'artifact','verdict','pr'}`. Verified by executing the filter against
`phases.ts`:

```
escalating: branch-review, research, spec, spec-review, plan, plan-review,
            implement, pr-review-intent, pr-review-quality
probe-only: dispatch, execute, blocked-on-files, blocked-on-decision
```

`blocked-on-files` clears only when a *sibling* releases (`machine.ts:186-189`);
`blocked-on-decision` waits on a *human*. Neither is produced by the probed actor working. Run
`dispatch` is `worktree` (`phases.ts:54`) and `execute` is `gate` (`phases.ts:56`), so neither
escalates — which matters because **`dispatch` and `branch-review` both lack `stallWhen`** (MINOR 7;
`execute` is the only run row that has one, `phases.ts:58-59`), so **A18** is what keeps a healthy
`dispatch` from escalating at 60m. `branch-review` does escalate, by design — it is orchestrator-
owned with a `verdict` signal.

The excluded rows lose nothing human-visible: `formatStatus` already renders the open-decision age
and question (`status.ts:21-26`) and the files-blocked holder with its escape hatch
(`status.ts:38-55`).

### A13, A25 — what the probe says (MAJOR 2)

`stallAwaiting` returns **the whole clause**, so the template asserts nothing about its shape:

```ts
export function stallAwaiting(run: Run, task: Task | null, hpipe: string): string
```

| `signal` | record | returns |
| --- | --- | --- |
| `artifact` | task | `Nothing has appeared at:\n\n    <abs path>\n\nIf you finished but wrote it elsewhere, move it exactly there — the supervisor stats that path and nothing else.` |
| `verdict` | task or run | same shape, verdict path (`deliver.ts:88-93`) |
| `pr` | task | `This phase is waiting for a pushed PR for <branch> (#<issue>).` |
| `files` | task | `This phase is waiting for another task to release the files this one declared.` |
| `manual` | task | `This phase is waiting for an answer to the open decision.` |
| `worktree` | run (`dispatch`) | `This phase is waiting for a worktree to be adopted for a dispatched task.` |
| `worktree` | task (`teardown`) | `This phase is waiting for this task's worktree to be removed.` |
| `gate` | run (`execute`) | `This phase is waiting for \`<hpipe> dispatch --done\` to close intake.` |
| else | — | `This phase is waiting for whatever clears <phase>.` |

The rewritten template hardcodes neither "appeared at" nor "the path above":

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

**`hpipe` is passed in as a rendered string**, because `render` is a single `String.replace` whose
replacement text is never re-scanned and whose throw inspects only placeholders present in the
*template* (`render.ts:8-14`), while `renderPrompt` injects `hpipe` into the template bag at
`render.ts:46`. A `{{hpipe}}` arriving inside a **value** would ship verbatim, and
`test/prompts.test.ts:68-76` cannot catch it — it reads only `prompts/*.md`. Callers pass
`hpipeCommand(pluginRoot)` (`render.ts:28-38`); `pluginRoot` is in scope at `main.ts:97`.

**A25 — the ladder sentence**, composed at the call site because a bare ratio is false for every
**A18**-excluded row:

- eligible: `This is probe 2 of 3. After 3 unanswered probes this phase is escalated to the human
  and stops moving on its own.`
- excluded: `This is a standing nudge — this phase is not escalated automatically, and clears when
  whatever it is waiting for arrives.`

### A10 — `prompts/stall-escalate.md` (MINOR 9)

Named but never specified before. `escalate.md` cannot be reused: it says *"This phase hit {{pass}}
review passes without clearing"* and *"Do not start another pass"* (`escalate.md:3`, `:5`), neither
true of a stall.

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

Must be added to `ALL` in `test/prompts.test.ts:10-14` or the orphan test fails (`:21-24`), and must
not contain a literal `hpipe` (`:68-76`). `{{probes}}` is `stall.probes` — probes actually sent,
never deferrals (**A6**).

### A15 — `hpipe status` (MINOR 8)

`taskWarnings` (`status.ts:17-59`) gains, mirroring `status.ts:21-26`:

```
  ⚠ t3 escalated from implement 47m ago — needs a human; `hpipe rewind <run> implement --task t3` resumes it
```

and `formatStatus` gains the run-level equivalent beside the existing schema warning
(`status.ts:104-109`), because the ladder escalates runs too (`branch-review`) and pass 0 surfaced
only tasks. Uses `ageMinutes` (`status.ts:12-14`), `escalated_from` (`types.ts:57`, `:95`). Fires
for every escalated record, including those escalated by `advanceLoopingRow` (`machine.ts:122`).

---

## Data and control flow

### `stall.ts` — classification (pure)

```ts
export type StallAction = 'probe' | 'escalate'
export interface StallCandidate {
  run: Run; task: Task | null
  action: StallAction
  probes: number               // sent so far, for {{ladder}} and the reason string
  escalatable: boolean         // A18
  minutes: number
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
5. **Due:** `now - phase_entered_at >= threshold × (probes + holds + 1)` minutes.
6. **Action:** `escalate` when `probes >= probeMax` **and** **A18** admits the row; else `probe`.

### `stall.ts` — application (injected effects)

```ts
export interface StallDeps {
  probe: (c: StallCandidate) => Promise<{ ok: boolean }>
  escalate: (c: StallCandidate) => Promise<void>
  agentStatus: (paneId: string) => Promise<AgentStatus>
  persist: (run: Run) => Promise<void>
}

export async function applyStalls(cs: StallCandidate[], deps: StallDeps): Promise<void> {
  for (const c of cs) {
    const record = c.task ?? c.run

    if (c.action === 'probe') {
      if ((await deps.probe(c)).ok) {                       // A6
        bumpStall(record, 'probes')
        await deps.persist(c.run)                           // A4
      }
      continue
    }

    const { holds } = stallCountsFor(record)
    if (holds < deps.probeMax && c.actorPaneId !== null     // A27 — bounded
        && (await deps.agentStatus(c.actorPaneId)) === 'working') {
      bumpStall(record, 'holds')                            // A20 — not a probe
      await deps.persist(c.run)
      continue
    }
    await deps.escalate(c)                                  // A22
  }
}
```

`enterTaskPhase`/`enterRunPhase` are called inside `escalate` in `main.ts`, keeping `stall.ts` free
of a `machine.ts` import — the layering `deliverPendingAnswers` uses (`tasks.ts:283`).

### One tick

Unchanged through `main.ts:236`; the two `applyStalls` calls replace the two `sendProbes` calls at
`main.ts:238-268`. `escalate`, in order: `enterTaskPhase(run, task, 'escalated', \`${probes} stall
probes unanswered\`)` → `saveRun` → render `stall-escalate` → send to `run.orchestrator_pane`.

**A22, reworded (MINOR 5).** "Unconditional" governs the send, not the deferral: *once the deferral
gate has passed, the `escalated` transition and its `persist` happen regardless of whether the
prompt can be delivered.* A deferral is a decision not to escalate **yet**; a failed send is a lost
prompt, never a lost transition — which is what makes **A15** the reliable surface.

**MINOR 6.** `main.ts` has two `saveRun` sites: `:136` (post-`applyEvents`, all runs) and `:217`
(per advancing run). The persistence argument needs only the second: both precede the stall block
at `:238`, and `listRuns` (`main.ts:114`) re-reads every run from disk each tick
(`ledger.ts:48-62`), so without **A4** a bump made in the stall block is discarded before the next
tick sees it.

### Config

`STALL_PROBE_MAX: number` into `Config` (`config.ts:4-20`), `3` into `DEFAULTS` (`:22-38`), the key
into `NUMERIC` (`:40-44`) — identical to `PROMPT_RETRY_MAX`.

---

## Error handling

| Failure | Behaviour | Why |
| --- | --- | --- |
| `agentPrompt` rejects a probe | No bump, no persist; stays due, retried next tick | **A6**; `stall.ts:92-96`. Bounding this is **#25** |
| `agentPrompt` rejects the escalation send | Transition already persisted; prompt lost | **A22**; `hpipe status` shows it (**A15**) |
| `agentStatus` fails | `'unknown'` (`herdr.ts:70`), `!== 'working'` → escalate | Failing open beats waiting |
| `actorPaneId` is `null` | Escalate without the gate | The owning actor has no pane (**A7**) |
| Actor reports `working` forever | Escalates anyway at `holds >= probeMax` | **A27** — the MAJOR 3 fix |
| Record has no `stall`, or a stale `stall.at` | Reads zero | **A28** |
| Run is `escalated` or `done` | Its tasks produce no candidates | **A26** — the BLOCKER 1 fix |
| `stallAwaiting` cannot resolve a path | `whatever clears <phase>` clause | Same shape as today's fallback |
| Probe pane is `null` | No candidate (`stall.ts:38-39`, `:76-77`) | Unchanged; `test/stall.test.ts:165-175` pins it |
| `persist` throws | Caught by the tick's `try` (`main.ts:269-271`); counter lost, probe re-sent | A duplicate nudge beats a lost transition |

**Race, unchanged:** `advanceTasks` runs earlier in the tick (`main.ts:176`) and may have re-stamped
`phase_entered_at`; the task is then not due, and under **A28** its counters read zero. Correct.

---

## Testing strategy

Baseline to hold: 351 pass / 0 fail, `tsc --noEmit` clean.

**`test/stall.test.ts` — every call site changes.** All 20 tests pass `alreadyProbed` positionally
(`grep -c "new Set(" ` → 18) and **A16** replaces it with `probeMax`; three assert the deleted key
format (`:66`, `:72`, `:124`). New coverage:

- probe 1 due at exactly `threshold`; probe 2 at `2 × threshold`, not `threshold + 1m`
- **persistence: bump → `persist` → re-load through `listRuns` → no candidate until `2 × threshold`**
- **A26 (BLOCKER 1): a task in `implement` inside a run whose phase is `done` or `escalated` yields
  no candidate** — built from a run put through `cmdAbort`'s exact mutation (`run.phase = 'done'`,
  tasks untouched); and the run-level asymmetry, that `stallCandidates` needs no such guard because
  `escalated`/`done` are not stallable
- **A18**: the four excluded rows are probed at the cap and never escalate; the nine eligible do
- **A27 (MAJOR 3)**: a `working` actor is deferred, `holds` increments and `probes` does not, and
  **after `probeMax` deferrals it escalates anyway**; the reason string still reports probes only
- **A7**: the gate reads `actorPaneId`; a paneless worker escalates rather than consulting the
  orchestrator (inverse of `:146-151`, which still pins probe routing)
- escalation proceeds on `idle`, `done`, `blocked`, `unknown`; defers only on `working`
- **A22**: an escalation whose send fails still leaves the record in `escalated`
- **A28**: a record whose `stall.at` is stale reads zero; re-stamping `phase_entered_at` by the
  `enterTaskPhase`/`cmdRewind`/`cmdResume` mutation each re-arms the ladder **without those
  functions being modified**
- `stallAwaiting` per signal and record, both `worktree` cases; **P2** (a task probe never renders
  `whatever clears research`) and **P2b** (a run probe in `dispatch` never names a
  `docs/superpowers/reviews/` path)
- **MAJOR 2 regression: the rendered `pr`-row probe contains neither `appeared at` nor
  `path above`**, and the rendered `blocked-on-decision` probe contains neither
- **A25**: an excluded row's `{{ladder}}` contains no `of 3`; no rendered probe contains `{{`

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

**`test/status.test.ts`** — the escalated warning renders for a task **and for a run** (**A15**).

**`test/config.test.ts`** — `STALL_PROBE_MAX` defaults to 3 and parses (mirrors `:11-30`).

**`test/prompts.test.ts`** — add `stall-escalate` to `ALL` (`:10-14`); the orphan (`:21-24`) and
no-literal-`hpipe` (`:68-76`) tests then cover it. Add: `stall-probe.md` contains neither
`will not ask again`, nor `appeared at`, nor `path above` (**MAJOR 2** — the template must not
assert a shape); and contains `{{awaiting}}` and `{{ladder}}`.

**No `test/cli-commands.test.ts` change** — **A28** means no CLI code is modified.

**Live verification — not optional.** DI with fakes hid a wiring bug in this repo before: pass 0's
counter was never persisted and every unit test would still have passed. With
`TASK_STALL_MINUTES=1`, `STALL_PROBE_MAX=2`:

1. Probes at ~1m and ~2m with a **real absolute path**, then escalation at ~3m.
2. **Read the run JSON off disk between probes and confirm `stall.probes` is climbing** — the check
   not reachable from the unit suite.
3. `hpipe status` shows the ⚠ line for the task **and** for an escalated run; `hpipe rewind`
   re-arms it.
4. A task in `blocked-on-decision` past the cap: probed, never escalated (**A18**), `{{ladder}}`
   reads as a standing nudge (**A25**).
5. **`hpipe abort` a run with a live task, wait past the cap: no probe, no escalation. `hpipe
   resume` and confirm the ladder re-arms from zero** (**A26**, **A28**).
6. **Hold an actor at `working` past `STALL_PROBE_MAX` deferrals and confirm it escalates anyway**
   (**A27**) — the path with no unit-only proof.

**Pre-PR gate.** t1 (#9) merges first; then rebase on `main`, re-run `bun test` and
`bun run typecheck`, and say in the PR body that both were re-run post-rebase. **A28** should make a
conflict unlikely — no file in t1's list is touched — but a real conflict is a stop and an
`hpipe decide`.

**Operator docs.** `smoke.md` gains a stall-ladder subsection beside the `PROMPT_RETRY_MAX`
paragraph (`:281`) and a recovery-table row (`:473`).

---

## Superseded premises

- **The research note's dead-orchestrator paragraph is wrong.** It calls the `attempts.delete` reset
  (`main.ts:234`) "a 5-tick cycle repeated forever, which is consistent with 33 further deliveries
  into a dead pane". At `TICK_MS` 1000 (`config.ts:23`) that is ≈46,800 attempts over 13 hours, not
  33; and a delivery is only attempted when the tick produced text (`main.ts:159`,
  `deliver.ts:51`). 33 over 13 hours is ~1 per 24 minutes — **successful** digests into a pane that
  was **alive** while the agent inside it was wedged. `main.ts:234` is a real bug; it is **#25**.
- **Pass 0's NG1 justification is withdrawn** — see **A27**.

## Rejected alternatives

- **Editing `cmdRewind`/`cmdResume` to reset the counter**, which the ruling explicitly permits.
  Not rejected as forbidden — rejected as weaker: an enumeration of reset sites has already gone
  stale once (pass-1 MAJOR 6 found the missing `cmdResume`), and **A28** additionally keeps
  `src/cli.ts` — declared by t1 (#9), in `plan` now — out of the change set, shrinking what has to
  survive the mandated post-merge rebase.
- **A new `stalled` phase.** Needs `phases.ts` (**NG2**); duplicates `escalated`'s machinery.
- **Exponential backoff.** 675m ≈ 11.25h against a 13h incident (**A2**).
- **Escalating every stallable row.** Cascades a correctly parked task to `blocked-on-failure`
  (`gating.ts:6-8`, `:34-38`).
- **Guarding on `terminal` rather than `releasesPane`.** Misses `escalated`, which is `releasesPane`
  but not `terminal` (`phases.ts:71`).
- **A separate `STALL_HOLD_MAX`.** A second knob for a bound that has no reason to differ from the
  probe cap.
- **Bumping `schema_version` to 3.** Strands every in-flight run behind `hpipe abort`
  (`main.ts:30-32`).

## Open decisions

One, flagged not resolved: **A28 deviates in mechanism from the ruling**, which named `cmdRewind`
and `cmdResume` as the reset sites. It meets the requirement — the counter resets at every
`phase_entered_at` bypass, including any added later — and leaves the permitted `src/cli.ts` edit
unused, which shrinks the rebase surface on a file t1 is working in. The permission to make that
edit is unchanged and available; if the orchestrator prefers the literal enumeration, say so and it
becomes a sequenced edit behind t1's merge, with `test/cli-commands.test.ts` back in the change set.
