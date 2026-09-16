# Worker-owned pipeline — design

**Date:** 2026-09-15
**Status:** Design v3 — all 18 findings from adversarial round 1 and all 13 from round 2 applied
(`reviews/2026-09-15-worker-owned-adversarial-{1,2}.md`; `BLOCKER`, `BLOCKER`). Awaiting a third pass.
**Supersedes:** the Roles and Phase machine sections of
`specs/2026-09-13-herdr-pipeline-plugin-design.md` (v4). Everything that document says about the
supervisor, hooks, event transport, queue, session scoping, orchestrator identity, predicate
edge-triggering, the verdict contract, startup reconciliation, and recovery **still holds unchanged**
except where §Event transport is amended in §Code shape below.
**Plugin id:** `stein.pipeline`
**Target:** herdr 0.9.0+

> **Review history.** Two adversarial rounds. Round 1 found 5 BLOCKERs, 8 MAJORs, 5 MINORs; round 2
> found 2 BLOCKERs, 5 MAJORs, 6 MINORs *and* audited round 1's fixes as **11 genuine / 0 cosmetic /
> 7 displaced**. All 31 findings are applied here.
>
> **One failure recurred in both rounds, and it is the same one v4's history records four times:
> fixing an instance instead of the class.** The review-loop bound was written three times before it
> held. v1 reset `pass` on every forward transition, which deleted the bound entirely, because every
> entry to a review phase is a forward transition. v2 replaced it with a per-phase map that deleted
> its counter on `CLEAR` — which bounded the four review loops and silently removed a bound that
> already ships, `advanceTask`'s `ci` retry budget, leaving `implement → pr-review-* → ci(red) →
> implement` unbounded. Both were a reset justified by local reasoning about one loop, in a machine
> where the loops overlap. v3 states the rule as a class — *every row that can send a record back to
> a producer carries a monotone counter keyed by itself* — and nothing resets on forward progress.
>
> Round 2 also caught three fixes that traded one failure for its mirror image: `intake_closed`
> turned round 1's early completion into a permanent hang whose stated mitigation did not exist
> (`stallCandidates` gates on `ARTIFACT_RUN_PHASES`, which excludes `execute`); `adopted_at` turned a
> level predicate into a one-way door, because `applyEvents` only writes it when `workspace_id` is
> null; and the `hpipe answer` delivery precondition rested on a retry loop `main.ts` does not
> implement.
>
> Claims about the v4 implementation withdrawn across the rounds: that `MAX_PASSES` defaults to 3 (it
> is 2); that `teardown.ts` fails to advance on a failed task (it already uses `every(SETTLED)`); and
> that v4 retries a failed delivery across ticks (the document says so; `main.ts` drops it).

## Problem

v4 gave the orchestrator ten of fifteen phases. It writes the run's spec, dispatches the spec review,
writes the plan, dispatches the plan review, decomposes the plan into tasks, writes the full text of
every task, and then reviews every worker's PR twice. Workers only implement: `prompts/task.md` hands
them prepared task text and says "TDD it, open a PR."

Three consequences, all measured on the first live run:

1. **The orchestrator's context is the ceiling on the run.** Every task's text, every task's diff, and
   two reviews per task pass through one agent. Fleet width is capped by one context window.
2. **Design thinking happens furthest from the code.** The agent deciding how a task should be built
   has not read the files it touches. The agent that has read them is handed a conclusion.
3. **The human sees drafts, not decisions.** The one gate is brainstorming, so the orchestrator
   surfaces prose the human must read to find the two choices that actually mattered.

## Goal

Move research, design, adversarial review, and planning **down** into the worker that owns the issue,
and reduce the orchestrator to intake, dispatch, decision triage, and the merge/close/branch-review
tail. Workers surface decisions — not drafts — and the orchestrator triages them, answering what it
can and escalating what needs the human, with a recommendation already formed.

Fleet width then scales with worker count instead of with one context window.

## Non-goals

- **Making merge decisions.** Unchanged from v4: the plugin prompts, the orchestrator merges.
- **Letting workers file their own issues.** Intake stays with the orchestrator so `depends_on`,
  `files`, and surface routing are decided in one place with the whole batch in view.
- **Letting workers pick their own issue.** Tasks are assigned at registration. Self-selection would
  need a claim protocol and would break the ordering guarantees the gates exist to provide.
- **Independent review of shipped code by a second party.** Workers now review their own PRs. This is
  a deliberate weakening, priced in §Failure modes.
- **Preserving the v4 pipeline behind a flag.** The orchestrator-led machine is replaced. Two tables
  is the "fix the instance, not the class" failure that recurred in all three v4 review rounds.
- **Changing the supervisor, hooks, queue, or session model.** Untouched. §Event transport's
  *delivery coalescing rule* is amended — see §Code shape — and nothing else is.

## Roles

| Role | What it does now | Change from v4 |
| --- | --- | --- |
| **Human** | Reports problems, answers escalated decisions | Sees decisions, not drafts |
| **Orchestrator** | Researches or receives a problem, files the GitHub issue, registers and dispatches tasks, closes intake, triages surfaced decisions, merges, closes, runs `branch-review` | Loses spec, spec-review, plan, plan-review, task text authorship, and both per-task PR reviews |
| **Worker** | Owns one issue end to end: research → spec → spec-review → plan → plan-review → implement → pr-review-intent → pr-review-quality | Gains eight phases; runs its own adversarial reviews via Claude Code subagents in its own pane |
| **Supervisor** | Unchanged mechanically | Routes most prompts to **worker** panes rather than the orchestrator's, one message per pane |
| **Plugin hooks** | Unchanged | — |

**`hpipe task` stops taking `--text`.** The issue body is the brief. The orchestrator writes it once,
into GitHub, and the worker reads it with `gh issue view`. This removes "orchestrator composes full
task text for N tasks" from the context budget, and makes the brief durable and reviewable outside
the run record. `Task.text` and the `{{task_text}}` placeholder are **removed**, not carried forward;
`render()` throws on an unresolved placeholder, so a `worker-brief.md` that inherits it dies on first
dispatch.

## Phase machine

### Run — 6 rows, 4 orchestrator-owned

| Phase | Actor | Completion predicate | Success | Failure |
| --- | --- | --- | --- | --- |
| `intake` | orchestrator | actor idle **and** a task whose `registered_at > phase_entered_at` exists | `dispatch` | — |
| `dispatch` | orchestrator | a task whose `adopted_at > phase_entered_at` exists | `execute` | — |
| `execute` | — (probed via orchestrator) | `intake_closed` **and** every task terminal | `branch-review` if ≥1 task is `done`, else `escalated` | — |
| `branch-review` | orchestrator | actor idle **and** verdict fresh, parses | `CLEAR` → `done` | else `branch-review`, `passes[branch-review]`+1; at `MAX_PASSES` → `escalated` |
| `escalated` | human | `hpipe rewind` clears `passes` | → `escalated_from` | — |
| `done` | — | terminal | — | — |

Run phases `spec`, `spec-review`, `plan`, `plan-review` are **deleted**. `RunArtifacts` shrinks to
`{ verdicts }`.

**`intake` and `dispatch` are edges, not levels.** v1 wrote them as "≥1 task registered" and "≥1
worktree adopted", both monotone: once true, true forever, so `hpipe rewind` — the design's universal
escape — re-advanced them on the next tick without the orchestrator acting. That is round 3's MAJOR 5
(`merge`/`close` as pure level predicates) reproduced on the two rows v5 introduces. `Task` gains
`registered_at` and `adopted_at` so both rows compare against the run's `phase_entered_at`.

**`adopted_at` must be clearable, or the fix overshoots into a dead end.** `applyEvents` binds a
worktree only when `workspace_id === null`, so a re-`worktree create` on an already-adopted task
never re-fires and `adopted_at` is write-once. A human who rewinds a run to `dispatch` after every
task is adopted would then have no satisfiable exit at all. **`hpipe rewind <run> dispatch` therefore
clears `adopted_at` on every task whose `workspace_id` is still bound**, so re-issuing `agent start`
against the existing worktree re-qualifies the row. §Recovery states this explicitly: after rewinding
to `dispatch`, the orchestrator re-dispatches from the existing worktrees; it does not recreate them.

**`intake` advances on the first registration, not the last, and closes explicitly.** The orchestrator
may register tasks at any phase in `intake | dispatch | execute`; a task registered during `execute`
enters `queued` and is gated normally. That capability is what makes "you report a problem mid-run"
work — and it is why `execute` cannot complete on "every task terminal" alone. That is a level
predicate over a set the design deliberately lets grow, and `intake`'s predicate is *actor idle*, so
registering one task and ending the turn is the normal path. Without an explicit close, a run whose
first task finishes while the human is still discussing the second advances to `branch-review` and
ships a third of the work.

`Run.intake_closed` is therefore set by `hpipe dispatch --done` and **cleared by any subsequent
`hpipe task`**. `execute` completes only when it is true and every task is terminal. This mirrors
`blocked-on-decision`: where a state must not be inferred, an explicit call writes it.

An explicit flag trades early completion for a hang: a run whose tasks are all terminal with
`intake_closed === false` waits forever. Two things close that, and neither is "the stall probe
covers it" — `stallCandidates` gates on `ARTIFACT_RUN_PHASES`, which does not contain `execute`, so
that mitigation does not exist in the code it was claimed of.

1. **Every path that registers a task also carries the path that closes intake.** The gate-open
   dispatch prompt — delivered to the orchestrator whenever a task's `queued` gate opens, including
   for a task registered mid-`execute` — carries the `hpipe dispatch --done` instruction alongside
   the worktree and `agent start` lines. Without this, a mid-`execute` `hpipe task` clears the flag
   and nothing ever tells the orchestrator to set it again.
2. **`execute` is `stallable: true`**, with the probe targeting `run.orchestrator_pane` directly
   because the row has no actor. Past `STALL_MINUTES` with every task terminal and `intake_closed`
   false, the orchestrator is told exactly that, once per phase entry, and `hpipe status` names the
   missing close.

**`execute` → `branch-review` requires every task terminal**, where terminal means
`done | failed | orphaned | blocked-on-failure | escalated`. A run where *no* task reached `done` has
nothing to review and goes straight to `escalated`. The `branch-review` prompt names every non-`done`
task and its terminal phase. The v4 *implementation* already advances on
`run.tasks.every(t => SETTLED.has(t.phase))` with exactly this terminal set — only the
`intake_closed` conjunct and the `→ escalated` branch are new. (The v4 *document* said "last task
torn down", which is where v1's mistaken "this is a fix" framing came from.)

### Task — 20 rows, 8 worker-owned

| Phase | Actor | Completion predicate | Success | Failure |
| --- | --- | --- | --- | --- |
| `queued` | supervisor | `depends_on` all `done` | `research`; supervisor prompts the **orchestrator** to dispatch, carrying the rendered worker brief | cycle → rejected at registration; `failed`/`orphaned`/`escalated` dependency → `blocked-on-failure` |
| `research` | worker | worker idle **and** research note fresh | `spec` | pane exited or agent released → `failed` |
| `spec` | worker | worker idle **and** spec fresh | `spec-review` | pane exited → `failed` |
| `spec-review` | worker | worker idle **and** verdict fresh, parses | `CLEAR` → `plan` | else `spec`, `passes[spec-review]`+1; at `MAX_PASSES` → `escalated` |
| `plan` | worker | worker idle **and** plan fresh | `plan-review` | pane exited → `failed` |
| `plan-review` | worker | worker idle **and** verdict fresh, parses | `CLEAR` → `blocked-on-files` | else `plan`, `passes[plan-review]`+1; at `MAX_PASSES` → `escalated` |
| `blocked-on-files` | supervisor (probed via orchestrator) | no in-flight task holds an overlapping `files` prefix | `implement` | — |
| `implement` | worker | worker idle **and** PR exists **and** `headRefOid != head_sha_at_entry` | `pr-review-intent` | pane exited or agent released → `failed` |
| `pr-review-intent` | worker | worker idle **and** verdict fresh, parses | `CLEAR` → `pr-review-quality` | else `implement`, `passes[pr-review-intent]`+1; at `MAX_PASSES` → `escalated` |
| `pr-review-quality` | worker | worker idle **and** verdict fresh, parses | `CLEAR` → `ci` | else `implement`, `passes[pr-review-quality]`+1; at `MAX_PASSES` → `escalated` |
| `ci` | supervisor | `gh pr checks` bucket terminal **and** changed | `pass` → `merge` | `fail` → `implement` with the failing check, `passes[ci]`+1; at `MAX_PASSES` → `escalated` |
| `merge` | orchestrator | `state` is `MERGED` **and** `mergedAt > phase_entered_at`; records `merged_at_ms` and `issue_closed_at_entry` | `close` | — |
| `close` | orchestrator | `issue_closed_at_entry`, **or** `closed` is true **and** `closedAt >= merged_at_ms` | `teardown` | — |
| `teardown` | supervisor | `worktree remove --workspace <ws> --force` succeeded | `done`; unblocks `queued` and `blocked-on-files`; last terminal → run `branch-review` | removal fails → `orphaned`; `keep_worktree` → skip to `done` |
| `blocked-on-decision` | orchestrator | **none — no inferred exit.** Left only by a *delivered* `hpipe answer` | → `decision_from` | pane exited → `failed`, open decisions marked abandoned |
| `escalated` | human | `hpipe rewind --task <id>` clears `passes` | → `escalated_from` | — |
| `failed` / `orphaned` / `blocked-on-failure` / `done` | — | terminal | — | — |

**Naming.** `spec-review` reviews the worker's design before code exists; `pr-review-intent` and
`pr-review-quality` review the opened PR. `pr-review-*` was chosen over v4's `task-review-*` because
`task-review-spec` sitting beside `spec-review` in the same enum is a misreading waiting to happen.
`pr-review-intent` checks the PR against the issue **and** against the worker's own spec;
`pr-review-quality` checks tests, pattern conformance, and dead code. Two review phases per task, per
`CLAUDE.md:46`, preserved.

#### `passes` is keyed by phase, and monotone

`Task.pass: number` and `Run.pass: number` are replaced by
`passes: Partial<Record<Phase, number>>`.

**The rule, stated as a class:** *every row that can send a record back to a producer phase carries a
counter keyed by itself, increments it on the way back, escalates at `MAX_PASSES`, and never resets
it. The only thing that clears a counter is `hpipe rewind`.*

That is six rows — `spec-review`, `plan-review`, `pr-review-intent`, `pr-review-quality`, `ci`, and
`branch-review` — not the four review rows v2 named. Concretely, on a backward transition from phase
`p`: `passes[p] += 1`, then escalate if `passes[p] >= MAX_PASSES`, else enter the producer phase. At
the configured default of 2 that is **one remediation attempt**: the first BLOCKER returns the record
to its producer, the second escalates.

**Nothing resets a counter on forward progress.** This is the third statement of this rule, and the
first two were both wrong in the same direction:

- **v1** reset `pass` on every forward transition. Every entry to a review phase *is* a forward
  transition from its producer, so the counter tested at `spec-review` was permanently `0` and
  `spec ↔ spec-review` had no bound at all.
- **v2** kept a per-phase map but deleted `passes[p]` on `CLEAR`. That bounded the four review loops
  in isolation and **deleted a bound that already ships**: `advanceTask`'s `ci` case tests
  `task.pass >= s.maxPasses` and escalates, under a source comment naming the exact hazard ("Without
  this the task cycles execute → review → ci → execute forever, bypassing the one safety valve the
  module has"). v2's `ci` row carried no counter, and because both PR review rows deleted their own
  counters on `CLEAR`, the lap `implement → pr-review-intent → pr-review-quality → ci(red) →
  implement` reset every counter it touched and ran forever.

Both were the same move: a reset justified by local reasoning about one loop, in a machine where the
loops overlap. Monotone counters remove the move entirely. The cost is that `MAX_PASSES` becomes a
per-phase lifetime budget for the record rather than a per-episode one, so a task that fails
`pr-review-quality` once and later fails it again after a red CI escalates on the second. That is the
safe direction to be wrong in: escalation surfaces to a human, and a livelock does not.

Monotone counters also close §Artifacts' overwrite hole for free — `<phase>-<passes[phase] ?? 0>`
strictly increases, so no verdict file is ever written twice.

The defect v1 set out to correct is real and stays corrected: with one shared counter at
`MAX_PASSES = 2`, a task that took two passes at `spec-review` arrives at `plan-review` already
holding `pass = 2` and escalates on its first BLOCKER there.

`hpipe rewind` clears the map rather than setting `1`, per v4's stated intent that "a human who
answers an escalation is not immediately re-escalated". v4's `cmdRewind` sets `pass = 1`, which under
a base of 0 spends the entire remediation budget on the rescue itself.

Any prompt rendering `{{pass}}` — `escalate.md` today — renders `passes[phase] ?? 0`.

#### The file gate moved from `queued` to `blocked-on-files`

In v4 a task held its `files` from `execute`. v1 kept the gate at `queued`, which meant a task held
its declared prefixes from `research` through `teardown` — including `research`, `spec`,
`spec-review`, `plan` and `plan-review`, five phases that write only into `docs/superpowers/**` in a
linked worktree on a separate branch and cannot possibly conflict. Since `--files` is a
*declared-intent prefix heuristic* (v4 §Ordering and collisions), two tasks both declaring
`packages/core/src/` is the normal case, so the gate capped fleet width at the number of
non-overlapping declarations over a window several times longer than v4's — defeating the redesign's
stated goal.

The gate is therefore split:

- `queued` gates on `depends_on` only.
- `blocked-on-files` sits between `plan-review` and `implement` and gates on overlap. It is entered
  unconditionally on a `plan-review` `CLEAR` and completes on the first tick when nothing overlaps,
  the same self-satisfying shape as `close`.
- `holdsFiles` is true from `implement` onward, plus `failed` and `escalated` (which leave unmerged
  work and are never torn down). It is **false** for `queued`, the five design phases, and
  `blocked-on-files` itself — a task waiting on files does not reserve them.
- `blocked-on-decision` holds files **iff `holdsFiles(decision_from)`**, so a decision raised during
  `plan` blocks nothing and one raised during `implement` keeps its reservation.

**Overlap is resolved in one pass over tasks in `task_id` order, and at most one task leaves
`blocked-on-files` per overlapping group per tick.** That is the real invariant. v2 offered a
`task_id` tie-break against two tasks "waiting on each other", which cannot happen — neither holds
files while blocked — and missed the race that can: two tasks released by the same `teardown` both
evaluating "nothing overlaps" on the same tick and both entering `implement`.

**`blocked-on-files` starves behind a `failed` or `escalated` sibling.** Both hold their files
forever by the rule above, and nothing tears them down. Since `blocked-on-files` is non-terminal, the
run's `execute` row never completes either, so one failed task strands the run. Three things address
it, and the first two are not sufficient alone:

- `teardown` unblocks `queued` and `blocked-on-files`, and **entering `failed` or `escalated` also
  re-evaluates `blocked-on-files`** — which changes nothing on its own, because the holder still
  holds. It matters only so the blocked task's state is recomputed rather than stale.
- `blocked-on-files` is **`stallable: true`**, probed via `run.orchestrator_pane`. The stall fallback
  rule is widened from "a null pane" to "**no pane**", because this row's actor is `supervisor`,
  which resolves to no pane field at all rather than to a null one.
- **`hpipe release --task <id>`** drops a terminal-but-holding task's `files` reservation, and is the
  documented human escape. `hpipe status` states the dependency plainly: *"t2 blocked on files held
  by t1 (failed)"*.

The cost of the split is in §Failure modes: a task released from `blocked-on-files` planned against
files its sibling has since changed, so its plan may be stale. Re-planning on release was considered
and rejected as one extra plan+review cycle per collision; the worker is instructed to re-read its
touched files on entering `implement`.

#### `head_sha_at_entry` and when verdicts are committed

`head_sha_at_entry` is re-captured on every entry to `implement`, including re-entry from a BLOCKER
verdict or a red CI. Without it the predicate is satisfied by the commits that just failed review —
v2's run-level livelock re-created per task.

That alone is not sufficient once verdicts live on the worker's branch. If the verdict file were
committed at the *start* of the next `implement` turn, the first `git push` would move `headRefOid`
off `head_sha_at_entry` with zero remediation performed, and the unfixed PR would advance to
`pr-review-quality`. This cannot happen in v4, where the reviewer is the orchestrator working in the
main checkout and the verdict never touches the worker's branch.

**`close` handles an issue that was already closed.** `merge` records `issue_closed_at_entry`
alongside `merged_at_ms`. If the issue was closed *before* the merge — closed by hand, or by an
earlier PR — then `closedAt < merged_at_ms` and the edge comparison can never be satisfied, so the
flag short-circuits the row and `close` completes on its first evaluation. In that case, and whenever
`closed` is already true at entry, **`close.md` is not delivered**: the phase completes before the
orchestrator could act, and prompting it to close an already-closed issue is noise it has to read.

**The review phase's own turn commits and pushes its verdict.** The phase does not complete until the
verdict is written *and* on the branch, and `head_sha_at_entry` is captured on `implement` entry
afterwards. The instruction lives in all four review prompts.

**A `queued` task has no pane.** `pane_id` arrives from `pane.agent_detected`, which fires only after
`agent start`. A task in `research` with `pane_id === null` is skipped by predicate evaluation each
tick — not an error. Its stall probe falls back to the orchestrator (§Stalls below), because the
actor it would otherwise address does not exist.

## The decision channel

### Surfacing

The worker calls, as the **last action of its turn**:

```
hpipe decide --task <task_id> \
  --question "<what must be decided, and why it cannot be settled locally>" \
  --recommend "<the path you would take, and the reasoning>"
```

`--recommend` is **required**. A worker that surfaces a bare question pushes its own thinking onto the
orchestrator, which pushes it onto the human — the exact load this design exists to remove.

**`hpipe decide` rejects a task already in `blocked-on-decision`**, naming the open decision id, and
never writes `decision_from` when the current phase is `blocked-on-decision`. A task carries **at most
one open decision**; a worker with two questions asks the more consequential one first. Without this
guard the second call writes `decision_from: "blocked-on-decision"`, destroying the record of where
the work came from and returning the task, on answer, to the one row with no inferred exit — escapable
only by a `hpipe rewind` whose target the human would have to guess.

**What counts as important is the worker's judgment, taught by prompt, not enforced by the plugin.**
`worker-brief.md` teaches the shape: surface a choice that is expensive to undo, that changes scope,
that commits another surface to a contract, that invents a pattern the repo does not already
establish, or that trades off security or data integrity. It also teaches the negative: do not
surface something the issue, `CLAUDE.md`, or an existing call site already answers. No category list
is encoded in the plugin, so per-run escalation volume is variable by design.

The CLI appends to `task.decisions[]` and enters `blocked-on-decision`, recording `decision_from`:

```jsonc
{
  "id": "d1",
  "asked_at": 1789000000000,
  "from_phase": "plan",
  "question": "…",
  "recommendation": "…",
  "answer": null,
  "answered_by": null,
  "answered_at": null
}
```

**`blocked-on-decision` has no predicate, and that is the point.** A blocked worker is idle, and idle
is the completion signal for every worker phase. Any inferred exit would fire on the next tick. This
is the same reasoning v4 used to reject inferring `dispatch` from pane counts.

The claim is bounded, though: it is the only **predicate-driven** transition into and out of the
state. Two preserved paths still write over it, and both are specified:

- **`applyEvents` on `pane.exited` or a released `pane.agent_detected`** writes `failed` from any
  phase, with no guard. A worker whose pane dies while its decision is open goes to `failed`, and
  every open **or undelivered** decision on that task is marked `answered_by: "abandoned"` as it
  does, so `hpipe status` and the stall probe stop reporting a question nobody is waiting on, and an
  answered-but-undelivered decision does not outlive the pane it was addressed to.
- **`hpipe rewind --task <id> <phase>`** writes any phase over any phase, unchanged.

**`hpipe answer` refuses a task not currently in `blocked-on-decision`**, printing its actual phase.
Without this it resurrects a `failed` task into `plan` with a dead `pane_id`, where nothing can reach
it.

### Triage

The supervisor renders `prompts/decision.md` to the orchestrator pane through the existing gated
delivery path (actor idle at evaluation, idle again `ACTOR_SETTLE_MS` later, retry with backoff).

That prompt instructs the orchestrator to answer from the issue, `CLAUDE.md`, an ADR, or an existing
call site when the answer is already determined there; and otherwise to put the question to the human
**with the worker's recommendation, its own read, and a named recommendation of its own**. Then:

```
hpipe answer --task <task_id> --decision <id> --answer "<the decision and its reason>" \
             --by orchestrator|human
```

`--by` is declared by the orchestrator because only it knows whether it asked the human. It is the
audit trail, recorded on the task and in `run.history`, with no additional UI.

### Resume — delivery is a precondition, not a side effect

`hpipe answer` writes `decisions[d].answer` and sets `pending_answer: <id>`, and **leaves the task in
`blocked-on-decision`**. The supervisor returns it to `decision_from` — with `phase_entered_at` reset
— **only after `herdr agent prompt` reports a successful submission** of `answer.md` to the worker.

v1 made the reset a side effect of the write, which is unsound against v4's own event transport:
`agent prompt` rejects with `agent_blocked` before sending input, and retries are bounded by
`PROMPT_RETRY_MAX` (5) at `TICK_MS` (1000). A worker that called `hpipe decide` mid-turn and kept
working — the exact worker §Failure modes contemplates — is `working` for far longer than five ticks.
The answer would be recorded, the phase reset, delivery abandoned, and the worker would then finish
the artifact it was writing all along, touch the file after the reset, and complete the phase **with
the answer unread** — the precise failure the reset exists to prevent, with `run.history` asserting
the decision was applied.

**The retry loop this rests on does not exist yet.** v4's §Event transport says a failed delivery is
"retried with backoff across ticks"; `main.ts` does not do that — it attempts one send, and a failure
is dropped, with a module-level `attempts` counter that aggregates unrelated failures and resets on
give-up. So §Code shape adds it: **a per-task pending delivery, re-attempted each tick while
`pending_answer` is set**, with the retry budget kept **per message** rather than per pane and reset
on a successful send to that pane. This is the same class of correction as "last task torn down" — a
v4 document claim its implementation does not honour.

On budget exhaustion the task stays blocked and `hpipe status` reports **"answered but undelivered"**.
That state has an exit, which v2 omitted: **`hpipe answer` on a task that already has
`pending_answer` re-arms delivery** (and says so), and **`hpipe rewind --task` clears
`pending_answer`**, recording *"answer discarded undelivered"* in `run.history`. Without an exit the
only escape was a bare `hpipe rewind`, which returns the task to `decision_from` with the answer
still unread — reproducing the exact failure the precondition was added to prevent.

The `phase_entered_at` reset is still load-bearing: the half-written artifact the worker produced
before asking predates the question, and without a reset its mtime already exceeds the phase's entry
time.

**`passes` is untouched by a decision.** A decision is not a failed review, and charging one against
`MAX_PASSES` would escalate workers for asking good questions.

### Stalls

`blocked-on-decision` is stall-probe eligible, targeting the **orchestrator**, once per phase entry,
past `STALL_MINUTES`. `hpipe status` lists every open decision with its age, task, and question.
Nothing auto-resolves.

**A probe whose row actor resolves to a null pane falls back to the orchestrator**, naming the task
and its phase. This is not only the `blocked-on-decision` case: a task in `research` whose dispatch
prompt was dropped has `pane_id === null` and a row actor of `worker`, so the probe extended to cover
exactly that condition would otherwise have no destination.

## Artifacts

Per task, with paths **rendered by the plugin** and never chosen by the worker — the freshness
predicate must know where to look:

```jsonc
"artifacts": {
  "research": "docs/superpowers/research/2026-09-15-issue-210-research.md",
  "spec":     "docs/superpowers/specs/2026-09-15-issue-210-design.md",
  "plan":     "docs/superpowers/plans/2026-09-15-issue-210-plan.md",
  "verdicts": {
    "spec-review-0": "docs/superpowers/reviews/2026-09-15-issue-210-spec-review-0.md",
    "spec-review-1": "…",
    "plan-review-0": "…"
  }
}
```

Verdict keys are `<phase>-<passes[phase] ?? 0>` within the task's own map, so pass 1 cannot overwrite
pass 0's file. Paths carry the issue number, which is unique per repo, so two tasks cannot collide.
A `hpipe rewind` clears `passes` and therefore deliberately reuses the `-0` path: the reviewer reads
the current artifact, not a history of them, and git carries the history.

**They resolve against the task's worktree, not `repo_root`.** The orchestrator works in the main
checkout; a worker works in a linked worktree. `Task.checkout_path` is new, populated from the
`worktree.created` event, which already carries it as a required field and which the v4
implementation's `applyEvents` discards. Missing this makes every task artifact predicate silently
never fire.

Artifacts are committed on the branch and land in the PR, which is what lets `pr-review-intent` read
the spec the PR claims to implement. **Each review phase's own turn commits and pushes its verdict** —
see §`head_sha_at_entry` above for why the ordering is load-bearing rather than cosmetic.

**Why `research` is its own artifact.** Six artifacts per issue is real cost, and folding research
into the spec was considered. It is kept because the failure that recurred in every v4 review round
was *unverified claims* — a note recording "verified X behaves like Y, evidence: `<command>`" is what
`spec-review` checks the design against, and what the orchestrator reads when triaging a decision.
The prompt states plainly that it may be short.

## Prompts

| State | Prompt | Delivered to |
| --- | --- | --- |
| new | `intake.md` | orchestrator |
| new | `decision.md` | orchestrator |
| new | `worker-brief.md` (replaces `task.md`) | orchestrator, at gate-open (relayed to the worker by `agent start`) |
| new | `research.md`, `spec.md`, `spec-review.md`, `plan.md`, `plan-review.md`, `implement.md`, `pr-review-intent.md`, `pr-review-quality.md`, `answer.md` | worker |
| revised | `dispatch.md` — loses plan decomposition, keeps worktree create + `agent start`, adds `hpipe dispatch --done` | orchestrator |
| kept | `ci-red.md`, `merge.md`, `close.md`, `branch-review.md`, `escalate.md`, `stall-probe.md`, `digest.md` | as before |
| deleted | run-level `spec.md`, `spec-review.md`, `plan.md`, `plan-review.md`; `task-review-spec.md`, `task-review-quality.md` | — |

The four worker `*-review*.md` prompts are delivered **to the worker** and instruct it to dispatch a
Claude Code subagent with a fresh context, handing it the reviewer brief verbatim and the output path.
The plugin owns every word of review instruction; the worker only routes it. The verdict contract is
unchanged — `VERDICT:` as the last non-empty line, `BLOCKER` meaning any BLOCKER finding or any MAJOR
that reverses a decision, changes scope, or needs a judgment only the human can make.

**Two instructions are mandatory in all four, and are asserted by `table.test.ts`:**

1. **Await the subagent within the same turn, and do not end the turn until the verdict file exists
   at the named path with a `VERDICT:` trailer.** Claude Code's Agent tool can run a subagent in the
   background, which ends the parent's turn and lets the pane go to rest while the review is still
   being written. herdr's own claude detection manifest carries a dedicated
   `background_agents_working` rule for the waiting case, which is direct evidence that a backgrounded
   subagent is a separately-handled state rather than ordinary `working` — and on this machine the
   claude integration is v7, which reports no state at all (`SessionStart` / `pane.report_agent_session`
   only), so status is entirely screen-scraped with no hook backstop. Without the await, the worker
   reads idle while the review is unwritten: the phase does not advance (the file is absent), but the
   `TASK_STALL_MINUTES` clock runs against a healthy worker and the actor-idle gate loses its meaning
   for those four rows, degrading the guard to `FILE_SETTLE_MS` and the trailer rule alone.
2. **Commit and push the verdict before ending the turn.** See §`head_sha_at_entry`.

`worker-brief.md` inherits from `task.md`: the `{{surface}}` → `.claude/agents/<surface>-dev.md`
routing, the `core`-dependency `dist` rebuild line, the TDD and conventional-commit requirements, and
the `Closes #<n>` PR-body rule. It **drops** `{{task_text}}`, pointing at `gh issue view #<n>`
instead, and adds `{{notes}}`, the loop protocol, the rendered artifact paths, the `hpipe decide`
contract, and the instruction to re-read its touched files on entering `implement` (the stale-plan
risk from the split file gate).

## Code shape

One table in `machine.ts` is the single source of phase knowledge:

```ts
interface PhaseRow<P> {
  phase: P
  actor: 'orchestrator' | 'worker' | 'supervisor' | 'human' | null
  signal: 'artifact' | 'verdict' | 'pr' | 'ci' | 'merged' | 'closed'
        | 'worktree' | 'registration' | 'gate' | 'files' | 'manual'
  artifact?: 'research' | 'spec' | 'plan'
  onClear?: P
  onBlocker?: P
  returnsTo?: 'decision_from' | 'escalated_from'
  prompt?: string
  resumePrompt?: string
  resumeActor?: 'orchestrator' | 'worker'
  counter?: P              // the key this row increments on a backward transition
  stallable?: boolean
  probeTarget?: 'orchestrator'   // required when `actor` resolves to no pane
  holdsFiles?: boolean | 'inherit'
  releasesPane?: boolean
  terminal?: boolean
}
```

Everything v4 spread across five sets and two maps derives from it:

| v4 | v5 |
| --- | --- |
| `ARTIFACT_RUN_PHASES` | `signal ∈ {artifact, verdict}` |
| `REVIEW_PHASES`, `TASK_REVIEW_PHASES` | `signal === 'verdict'` |
| `COMPLETED_RUN_PHASES` | `terminal` |
| `PANE_RELEASING_RUN_PHASES` | `releasesPane` |
| `HOLDS_FILES` (in `gating.ts`, unknown to `machine.ts`) | `holdsFiles`, with `'inherit'` for `blocked-on-decision` |
| `ON_CLEAR` / `ON_BLOCKER` | `onClear` / `onBlocker` / `returnsTo` |
| implicit "every task phase delivers to the orchestrator" | `actor` |
| implicit "stall-probe the artifact phases" | `stallable` |

**`stallable` is explicit, not derived from `signal`.** Three rows have no artifact and must still be
probed — `blocked-on-decision`, `blocked-on-files`, and the run's `execute` — and none of them has an
actor with a pane. Deriving stall eligibility from the signal excludes exactly the rows that most need
it, which is how v2 came to claim a mitigation that `stallCandidates` could not provide.
`probeTarget: 'orchestrator'` is required on any `stallable` row whose actor resolves to no pane, and
`table.test.ts` asserts it.

**`counter` is explicit for the same reason.** A row that can send a record backwards must name the
key it increments, so the bound is a property of the row rather than of the reviewer's memory of which
rows are reviews. `ci` is the row that proves the point: it is not a review, it has no verdict, and it
had a retry budget in v4 that v2 dropped precisely because it was reasoning about "review phases".

**`resumePrompt` / `resumeActor` are explicit too.** `answer.md` goes to the *worker* while
`blocked-on-decision`'s `actor` is the *orchestrator*; there is no row whose `actor` is that prompt's
recipient, so a single `actor` field cannot express the delivery the decision channel depends on.

Call sites that change beyond the table:

1. **Delivery becomes per-pane.** This is the amendment to v4 §Event transport. Today `DigestInput`
   is per *run* with one `nextPrompt`, `main.ts` joins every prompt produced in a tick with
   `\n\n---\n\n`, and `nextDelivery` returns **one** `Delivery` — the first input with content, with
   every other discarded and, because `advanceTasks` has already saved the run, never regenerated.
   That was safe in v4 because every prompt-producing row had the same recipient. With eight
   worker-owned rows, a tick advancing three tasks produces three prompts for three panes.
   `nextDelivery` returns `Delivery[]` grouped by target pane, never joining across panes; the
   `[pipeline] run … / N events:` header attaches only to the orchestrator's message; per-pane retry
   counters replace the single module-level `attempts`. v4's coalescing rule is restated as **"at most
   one advance per actor pane per tick"** — round 3's MAJOR 6, generalized from its instance.
2. **`evaluateRun` / task evaluation take the pane from `row.actor`** — `run.orchestrator_pane` or
   `task.pane_id`. `TaskSignals`' separate `actorIdle` and `workerIdle` collapse into one `actorIdle`,
   and the collapse must be spelled out because the two fields are not the same kind of signal today:
   `workerIdle` is **cached from events**, while `actorIdle` is a **live read, double-checked after
   `ACTOR_SETTLE_MS`**. Reading the cached one for worker rows would advance `implement` on a stale
   `idle` recorded before the worker's push; reading the live one silently adds a settle window per
   worker pane per tick against `TICK_MS = 1000`.

   **`actorIdle` is the live read.** It resolves as a `herdr agent status` call on `row.actor`'s pane,
   double-checked after `ACTOR_SETTLE_MS`, exactly as `evaluateRun` does today for the orchestrator.
   `task.agent_status` stays the badge and wake cache and is **never** a completion signal. The settle
   windows for distinct panes run **concurrently**, so a tick costs one `ACTOR_SETTLE_MS`, not one per
   pane — without that, six workers would not fit in a 1000 ms tick. The cost is priced in
   §Failure modes.
3. **`artifactPathFor`** resolves relative to `task.checkout_path` for task phases, and reads
   `row.artifact` to select the `research`/`spec`/`plan` slot rather than assuming every task artifact
   is a verdict — which held in v4 only because every task phase the orchestrator acted on was a review.
4. **`gateStatus`** splits: `depends_on` at `queued`, overlap at `blocked-on-files`, with
   `holdsFiles: 'inherit'` resolved through `decision_from`.
   **`src/lib/worker-prompt.ts`** renders `worker-brief.md` and is delivered to the *orchestrator* at
   gate-open, which relays it verbatim as the `agent start` argument. The worker never receives it as
   a prompt, because a `queued` task has no pane — §Prompts names the orchestrator as the recipient
   for exactly this reason.
5. **`cmdDecide`, `cmdAnswer`, `cmdDispatchDone` in `src/cli.ts`**, beside `cmdTask` and `cmdRewind`.
   **Not** `src/actions/` — every file there is a `[[actions]]` entry in `herdr-plugin.toml`, and v4's
   verified-facts table records that `plugin.action.invoke` accepts no user arguments, so data goes
   through `hpipe`. All three commands take required string arguments.

## CLI

| Command | Change |
| --- | --- |
| `hpipe task` | `--text` removed; `--issue` remains required; `--notes` added — free text rendered into `worker-brief.md` for batch context that does not belong in a public issue body. Accepted in `intake`, `dispatch`, `execute`; clears `intake_closed` |
| `hpipe dispatch --done` | **new** — sets `run.intake_closed` |
| `hpipe decide` | **new** — `--task`, `--question`, `--recommend` (all required); refuses a task already blocked |
| `hpipe answer` | **new** — `--task`, `--decision`, `--answer`, `--by` (all required); refuses a task not in `blocked-on-decision` |
| `hpipe status` | lists open decisions with age, task, question; flags "answered but undelivered" |
| `hpipe release --task <id>` | **new** — drops a terminal-but-holding task's `files` reservation, freeing a sibling stuck in `blocked-on-files` |
| `hpipe rewind` | accepts the new phases; **clears `passes`** rather than setting 1; clears `pending_answer` (recording "answer discarded undelivered"); `rewind <run> dispatch` clears `adopted_at` on bound tasks |
| `hpipe start`, `claim`, `abort`, `resume`, `forget`, `drain` | unchanged |

## Configuration

No new keys. `STALL_MINUTES` covers unanswered decisions; `MAX_PASSES` (default **2**) covers all four
worker review phases under the per-phase counter; `TASK_STALL_MINUTES` covers a silent worker in any
worker-owned phase, not only `implement`.

## Migration

Run records gain `schema_version: 2`. The supervisor **refuses to advance** a run without it. `Run`
has no version field today, nothing reads one, and `listRuns` casts blindly, so adding the field and
filtering unversioned runs out of the supervisor loop is a handful of lines.

There is one linked plugin per user and one `$HERDR_PLUGIN_STATE_DIR`, so "finish it on the old
version" is not available. `hpipe status` says: *"run `<id>` was started by an earlier plugin version
and cannot be advanced — `hpipe abort <id>` to release the repo."* `activeRunForRepo` treats any
non-`done` run as active, so a stranded v4 run blocks `hpipe start` on that repo until aborted.

No in-place migration: v4 phases have no honest mapping onto v5 rows, because a v4 run mid-`plan` has
an orchestrator holding work no worker can inherit.

## Failure modes

| Mode | Handling |
| --- | --- |
| The worker's reviewer subagent shares its `CLAUDE.md` and repo view | Accepted and priced. A fresh context is not a fresh worldview, and this is weaker than v4's orchestrator-dispatched review. The verdict contract, `MAX_PASSES`, and the verdict files landing in the PR are the backstop. |
| A subagent is backgrounded and the worker's pane rests mid-review | Prompt-level fix (await + verdict-file precondition), asserted by `table.test.ts`. Residual: the prompt is an instruction, not a guarantee, and the manifest's `background_agents_working` rule only matches while the parent explicitly waits. |
| Worker dies mid-loop | Task → `failed`. The worktree and its artifacts survive on the branch for `hpipe rewind` or manual pickup. Open decisions are marked abandoned. |
| Orchestrator never answers a decision | Stall probe re-prompts once per phase entry; `hpipe status` shows the age. Never auto-resolves. |
| Worker calls `hpipe decide` and keeps working | The answer's delivery is a precondition of the phase reset, so a worker too busy to receive it stays blocked and `status` says "answered but undelivered". Wasteful, and now visibly so. |
| Worker never calls `hpipe decide` and invents a pattern instead | `spec-review` and `plan-review` are the catch, and `worker-brief.md` states that inventing a pattern the repo does not establish is itself a surfaceable decision. Residual risk accepted. |
| A task released from `blocked-on-files` has a stale plan | Its sibling changed the files it planned against. `worker-brief.md` instructs a re-read of touched files on entering `implement`. Re-planning on release was rejected as one extra plan+review cycle per collision — revisit if live runs show plans going stale often. |
| Six artifacts × N tasks in one branch | Real cost, accepted. Each is scoped to one issue and reviewed by that issue's PR reviews. |
| Escalation volume is unbounded by design | Intake quality sets it. A vague issue produces questions. Intended feedback loop, but a bad batch can flood the orchestrator and `hpipe status` is the only throttle. |
| A run with every task `failed` | `execute` → `escalated` rather than `branch-review`, because there is nothing to review. |
| The orchestrator forgets `hpipe dispatch --done` | The run sits in `execute` with every task terminal. `execute` is `stallable` with the probe aimed at `orchestrator_pane`, and the gate-open dispatch prompt carries the instruction on every registration path. Chosen over inferring closure, which is round 1's BLOCKER 3. |
| A task strands in `blocked-on-files` behind a `failed` or `escalated` sibling | The holder never tears down, so the block is permanent and the run's `execute` row never completes. Surfaced by the stall probe via the orchestrator and named in `hpipe status`; released by `hpipe release --task`. A human decision by design — the held files may contain work worth rescuing. |
| Live `actorIdle` reads cost one `ACTOR_SETTLE_MS` per tick | Settle windows for distinct panes run concurrently, so the cost is one window per tick rather than one per pane. At `ACTOR_SETTLE_MS` near `TICK_MS = 1000` a tick can still overrun; the supervisor skips evaluation rather than queueing ticks, and `hpipe status` reports tick overrun. Measure on the live run. |
| `MAX_PASSES` is a per-phase lifetime budget, not a per-episode one | A task that fails `pr-review-quality` once, passes, then fails it again after a red CI escalates on the second failure rather than getting a fresh budget. Deliberate: monotone counters are the only shape under which no forward transition can delete a bound, and escalation is the safe direction to be wrong in. |

## Testing

- `machine-run.test.ts`, `machine-task.test.ts` — rewritten row sets, including: a trace asserting
  each of the six counter-bearing rows **escalates** at `MAX_PASSES`; a full-lap trace of
  `implement → pr-review-intent → pr-review-quality → ci(red) → implement` asserting the lap
  terminates rather than resetting; `head_sha_at_entry` re-capture on every `implement` entry; `close`
  completing against `merged_at_ms` on an auto-closed issue **and** against `issue_closed_at_entry` on
  an issue closed before the merge.
- `deliver.test.ts` — **per-pane** routing: three tasks advancing in one tick produce three
  `Delivery` objects, no prompt is joined across panes, no prompt is dropped, and a task with
  `pane_id === null` is skipped rather than errored.
- `gating.test.ts` — the split gate: `queued` ignores overlap, `blocked-on-files` enforces it,
  `holdsFiles: 'inherit'` resolves through `decision_from`, **at most one task leaves
  `blocked-on-files` per overlapping group per tick** (the simultaneous-release race, not the
  impossible mutual-wait), and a task blocked behind a `failed` sibling is released by
  `hpipe release`.
- `decide.test.ts` — **new**: surface → triage → answer → *delivered* → resume, asserting the
  `phase_entered_at` reset happens only on successful submission, that `passes` is untouched, that a
  second `hpipe decide` is refused, that `hpipe answer` on a non-blocked task is refused, that an
  exhausted delivery budget leaves the task blocked with an exit via re-armed `hpipe answer`, and that
  a pane death abandons open **and undelivered** decisions.
- `table.test.ts` — **new**, the class-level check:
  - **every row with an `onBlocker` names a counter key and a `MAX_PASSES` branch** — the invariant
    that would have caught v2's missing `ci` counter, stated over the property rather than over the
    four rows that happened to be reviews;
  - no row's `onClear` or `onBlocker` deletes or zeroes a counter (monotonicity);
  - every non-terminal row has an `onClear` **or** a `returnsTo`;
  - every row naming a `prompt` or `resumePrompt` names a file present in `prompts/`;
  - every `actor ∈ {orchestrator, worker}` resolves to a pane field that exists on the record type,
    and every row whose actor resolves to **no** pane is either `terminal` or names a probe target;
  - each of the **four named worker review prompts** (`spec-review.md`, `plan-review.md`,
    `pr-review-intent.md`, `pr-review-quality.md`) contains the await instruction and the
    commit-and-push instruction, and **`branch-review.md` contains neither** — it is orchestrator-owned,
    and a glob of `prompts/*-review*.md` would wrongly catch it.

  These are string and shape assertions. They cannot test obedience — a prompt containing the await
  instruction is not a worker that awaited — so the subagent question stays assigned to the live run.
  The v4 review rounds caught four separate instances of this class one at a time.

**Unit tests are not sufficient here.** The first live run of v4 surfaced two startup/gating defects
that dependency-injected fakes had passed. This change must be exercised against a real herdr session
with at least two concurrent workers, at least one surfaced decision, and at least one `blocked-on-files`
collision before it is called done. The subagent-backgrounding question (§Prompts) could not be
measured statically and must be measured there.

## Rejected alternatives

| Option | Why not |
| --- | --- |
| Keep the v4 pipeline behind `PIPELINE_MODE` | Doubles the table and the prompt set. "Fix the instance, not the class" is the failure v4's own review history records four times. |
| Fixed categories for what a worker surfaces | Predictable load, but it makes the plugin the arbiter of importance across every repo it runs in. Judgment, taught by prompt, was chosen instead. |
| Keep the file gate at `queued` and state the cost | Simplest, but overlapping tasks serialize their whole pipelines and the run looks exactly as serial as v4 — against the redesign's only quantitative goal. |
| Re-plan after `blocked-on-files` clears | More correct against a sibling's landed change; one extra plan+review cycle per collision. Deferred, with a re-read instruction in its place. |
| Declare `intake`/`dispatch` level-only | Free and honest, but leaves a run that advanced past intake early with no manual escape. Two timestamp fields were cheaper. |
| Worker reviews run as separate herdr agent panes | Genuinely independent context, and observable. Doubles pane count per task and puts reviewer lifecycle in the supervisor. Deferred, not dismissed — the obvious upgrade if self-review proves too weak. |
| Headless `claude -p` for worker reviews | Independent context with no pane, but invisible while running and un-interruptible. |
| One issue per run | An issue becomes the unit of work end to end, but it breaks the one-active-run-per-repo invariant and reduces `branch-review` to a third review of a single PR. |
| A standing per-repo pipeline with no run boundaries | Removes `branch-review` entirely and rewrites `hpipe start`/`abort`. Largest state change for the least gain right now. |
| Fold `research` into `spec` | Five artifacts instead of six, but loses the evidence record that `spec-review` checks the design against. |
| Reset a phase's counter on `CLEAR` (v2) | Bounds each review loop in isolation and deletes the bound on any loop that spans several rows — which is how the shipped `ci` retry budget disappeared. Monotone counters cost a strictly smaller per-phase budget and cannot be reasoned away one loop at a time. |
| Infer intake closure from orchestrator idleness | Would remove `hpipe dispatch --done`, and is round 1's BLOCKER 3: the orchestrator is idle between turns by construction, so inferring closure closes the run mid-intake. |
