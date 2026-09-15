# Worker-owned pipeline — design

**Date:** 2026-09-15
**Status:** Design v1 — awaiting first adversarial pass
**Supersedes:** the Roles and Phase machine sections of
`specs/2026-09-13-herdr-pipeline-plugin-design.md` (v4). Everything that document says about the
supervisor, hooks, event transport, queue, session scoping, orchestrator identity, predicate
edge-triggering, the verdict contract, startup reconciliation, and recovery **still holds unchanged**
and is not restated here.
**Plugin id:** `stein.pipeline`
**Target:** herdr 0.9.0+

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
  need a claim protocol and would break the ordering guarantees `queued` exists to provide.
- **Independent review of shipped code by a second party.** Workers now review their own PRs. This is
  a deliberate weakening, priced in §Failure modes.
- **Preserving the v4 pipeline behind a flag.** The orchestrator-led machine is replaced. Two tables
  is the "fix the instance, not the class" failure that recurred in all three v4 review rounds.
- **Changing the supervisor, hooks, queue, or session model.** Untouched.

## Roles

| Role | What it does now | Change from v4 |
| --- | --- | --- |
| **Human** | Reports problems, answers escalated decisions | Sees decisions, not drafts |
| **Orchestrator** | Researches or receives a problem, files the GitHub issue, registers and dispatches tasks, triages surfaced decisions, merges, closes, runs `branch-review` | Loses spec, spec-review, plan, plan-review, task text authorship, and both per-task PR reviews |
| **Worker** | Owns one issue end to end: research → spec → spec-review → plan → plan-review → implement → pr-review-intent → pr-review-quality | Gains eight phases; runs its own adversarial reviews via Claude Code subagents in its own pane |
| **Supervisor** | Unchanged mechanically | Routes most prompts to **worker** panes rather than the orchestrator's |
| **Plugin hooks** | Unchanged | — |

**`hpipe task` stops taking `--text`.** The issue body is the brief. The orchestrator writes it once,
into GitHub, and the worker reads it with `gh issue view`. This removes "orchestrator composes full
task text for N tasks" from the context budget, and makes the brief durable and reviewable outside
the run record.

## Phase machine

### Run — 6 rows, 4 orchestrator-owned

| Phase | Actor | Completion predicate | Success | Failure |
| --- | --- | --- | --- | --- |
| `intake` | orchestrator | actor idle **and** ≥1 task registered | `dispatch` | — |
| `dispatch` | orchestrator | ≥1 worktree adopted | `execute` | — |
| `execute` | — | every task terminal | `branch-review` if ≥1 task is `done`, else `escalated` | — |
| `branch-review` | orchestrator | actor idle **and** verdict fresh, parses | `CLEAR` → `done` | else `branch-review`, `pass`+1; at `MAX_PASSES` → `escalated` |
| `escalated` | human | `hpipe rewind` resets `pass` | → `escalated_from` | — |
| `done` | — | terminal | — | — |

Run phases `spec`, `spec-review`, `plan`, `plan-review` are **deleted**. `RunArtifacts` shrinks to
`{ verdicts }`.

**`intake` advances on the first registration, not the last.** The orchestrator may register more
tasks at any later phase; a task registered during `execute` enters `queued` and is gated normally.
This is a capability the v4 machine did not have — it required a cleared plan before any task could
exist — and it is what makes "you report a problem mid-run" work.

**`execute` → `branch-review` requires every task terminal**, where terminal means
`done | failed | orphaned | blocked-on-failure | escalated`. v4 said "last task torn down", which
never fires on a run with one failed task. A run where *no* task reached `done` has nothing to review
and goes straight to `escalated`. The `branch-review` prompt names every non-`done` task and its
terminal phase, so the reviewer knows what is missing from the branch.

### Task — 15 rows, 8 worker-owned

| Phase | Actor | Completion predicate | Success | Failure |
| --- | --- | --- | --- | --- |
| `queued` | supervisor | `depends_on` all `done`, no in-flight `files` overlap | `research`; supervisor prompts the **orchestrator** to dispatch, carrying the rendered worker brief | cycle → rejected at registration; `failed`/`orphaned`/`escalated` dependency → `blocked-on-failure` |
| `research` | worker | worker idle **and** research note fresh | `spec` | pane exited or agent released → `failed` |
| `spec` | worker | worker idle **and** spec fresh | `spec-review` | pane exited → `failed` |
| `spec-review` | worker | worker idle **and** verdict fresh, parses | `CLEAR` → `plan` | else `spec`, `pass`+1; at `MAX_PASSES` → `escalated` |
| `plan` | worker | worker idle **and** plan fresh | `plan-review` | pane exited → `failed` |
| `plan-review` | worker | worker idle **and** verdict fresh, parses | `CLEAR` → `implement` | else `plan`, `pass`+1; at `MAX_PASSES` → `escalated` |
| `implement` | worker | worker idle **and** PR exists **and** `headRefOid != head_sha_at_entry` | `pr-review-intent` | pane exited or agent released → `failed` |
| `pr-review-intent` | worker | worker idle **and** verdict fresh, parses | `CLEAR` → `pr-review-quality` | else `implement`, `pass`+1; at `MAX_PASSES` → `escalated` |
| `pr-review-quality` | worker | worker idle **and** verdict fresh, parses | `CLEAR` → `ci` | else `implement`, `pass`+1; at `MAX_PASSES` → `escalated` |
| `ci` | supervisor | `gh pr checks` bucket terminal **and** changed | `pass` → `merge` | `fail` → `implement` with the failing check |
| `merge` | orchestrator | `gh pr view --json state` is `MERGED` **and** `mergedAt > phase_entered_at` | `close` | — |
| `close` | orchestrator | `gh issue view --json closed` is true **and** `closedAt > phase_entered_at` | `teardown` | — |
| `teardown` | supervisor | `worktree remove --workspace <ws> --force` succeeded | `done`; unblocks `queued`; last terminal → run `branch-review` | removal fails → `orphaned`; `keep_worktree` → skip to `done` |
| `blocked-on-decision` | orchestrator | **none — no inferred exit.** Left only by `hpipe answer` | → `decision_from` | — |
| `escalated` | human | `hpipe rewind --task <id>` resets `pass` | → `escalated_from` | — |
| `failed` / `orphaned` / `blocked-on-failure` / `done` | — | terminal | — | — |

**Naming.** `spec-review` reviews the worker's design before code exists; `pr-review-intent` and
`pr-review-quality` review the opened PR. `pr-review-*` was chosen over v4's `task-review-*` because
`task-review-spec` sitting beside `spec-review` in the same enum is a misreading waiting to happen.
`pr-review-intent` checks the PR against the issue **and** against the worker's own spec;
`pr-review-quality` checks tests, pattern conformance, and dead code. Two review phases per task, per
`CLAUDE.md:46`, preserved.

**`pass` resets on every forward transition.** Entering a phase via `onClear` sets `pass = 0`;
entering via `onBlocker` increments it. Without this, a task that took two passes at `spec-review`
arrives at `plan-review` already holding `pass = 2` and escalates on its first BLOCKER at
`MAX_PASSES = 3`. v4's `advanceRun` has this bug latently — the run carried one counter across
`spec-review`, `plan-review`, and `branch-review` — and four review phases per task make it
load-bearing. `MAX_PASSES` means passes *at this phase*, which is the only reading under which the
number is interpretable.

**`head_sha_at_entry` is re-captured on every entry to `implement`**, including re-entry from a
BLOCKER verdict or a red CI. Without it the predicate is satisfied by the commits that just failed
review, which is exactly v2's run-level livelock re-created per task.

**A `queued` task has no pane.** `pane_id` arrives from `pane.agent_detected`, which fires only after
`agent start`. A task in `research` with `pane_id === null` is skipped by predicate evaluation each
tick — not an error, and not a stall until `TASK_STALL_MINUTES`.

## The decision channel

### Surfacing

The worker calls, as the **last action of its turn**:

```
hpipe decide --task <task_id> \
  --question "<what must be decided, and why it cannot be settled locally>" \
  --recommend "<the path you would take, and the reasoning>"
```

`--recommend` is **required**, and `hpipe decide` rejects a call without it. A worker that surfaces a
bare question pushes its own thinking onto the orchestrator, which pushes it onto the human — the
exact load this design exists to remove.

**What counts as important is the worker's judgment, taught by prompt, not enforced by the plugin.**
`worker-brief.md` teaches the shape: surface a choice that is expensive to undo, that changes scope,
that commits another surface to a contract, that invents a pattern the repo does not already
establish, or that trades off security or data integrity. It also teaches the negative: do not
surface something the issue, `CLAUDE.md`, or an existing call site already answers. No category list
is encoded in the plugin, so per-run escalation volume is variable by design.

The CLI appends to `task.decisions[]` and enters `blocked-on-decision`, recording
`decision_from: "<current phase>"`.

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
is the completion signal for every worker phase. Any inferred exit would fire on the next tick. The
explicit CLI call in and the explicit CLI call out are what make the state unambiguous — this is the
same reasoning v4 used to reject inferring `dispatch` from pane counts.

The task **keeps its `files` reservation** while blocked, and its dependents stay `queued`. Releasing
the files would let a sibling be dispatched onto paths a blocked worker has already half-edited in
its worktree.

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

### Resume

`hpipe answer` writes the answer, and the supervisor delivers `prompts/answer.md` to the **worker**
pane and returns the task to `decision_from` with **`phase_entered_at` reset**.

The reset is load-bearing. The half-written artifact the worker produced before asking predates the
question; without a reset its mtime already exceeds the phase's entry time and the phase completes on
the next tick with the answer unread.

**`pass` does not increment.** A decision is not a failed review, and charging one against
`MAX_PASSES` would escalate workers for asking good questions.

### Unanswered decisions

`blocked-on-decision` is stall-probe eligible, targeting the **orchestrator** (the row's actor), once
per phase entry, past `STALL_MINUTES`. `hpipe status` lists every open decision with its age, task,
and question. Nothing auto-resolves.

## Artifacts

Per task, with paths **rendered by the plugin** and never chosen by the worker — the freshness
predicate must know where to look:

```jsonc
"artifacts": {
  "research": "docs/superpowers/research/2026-09-15-issue-210-research.md",
  "spec":     "docs/superpowers/specs/2026-09-15-issue-210-design.md",
  "plan":     "docs/superpowers/plans/2026-09-15-issue-210-plan.md",
  "verdicts": {
    "spec-review-1": "docs/superpowers/reviews/2026-09-15-issue-210-spec-review-1.md",
    "plan-review-1": "…",
    "pr-review-intent-1": "…"
  }
}
```

Verdict keys stay `<phase>-<pass>` within the task's own map, so pass 2 cannot read pass 1's file.
Paths carry the issue number, which is unique per repo, so two tasks cannot collide. A `hpipe rewind`
deliberately reuses the same path: the reviewer reads the current artifact, not a history of them,
and git carries the history.

**They resolve against the task's worktree, not `repo_root`.** The orchestrator works in the main
checkout; a worker works in a linked worktree. `Task.checkout_path` is new, populated from the
`worktree.created` event, which already carries it and which the v4 implementation discards. Missing
this makes every task artifact predicate silently never fire.

Artifacts are committed on the branch and land in the PR, which is what lets `pr-review-intent` read
the spec the PR claims to implement.

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
| new | `worker-brief.md` (replaces `task.md`) | worker, at dispatch |
| new | `research.md`, `spec.md`, `spec-review.md`, `plan.md`, `plan-review.md`, `implement.md`, `pr-review-intent.md`, `pr-review-quality.md`, `answer.md` | worker |
| revised | `dispatch.md` — loses plan decomposition, keeps worktree create + `agent start` | orchestrator |
| kept | `ci-red.md`, `merge.md`, `close.md`, `branch-review.md`, `escalate.md`, `stall-probe.md`, `digest.md` | as before |
| deleted | run-level `spec.md`, `spec-review.md`, `plan.md`, `plan-review.md`; `task-review-spec.md`, `task-review-quality.md` | — |

The four worker `*-review*.md` prompts are delivered **to the worker** and instruct it to dispatch a
Claude Code subagent with a fresh context, handing it the reviewer brief verbatim and the output path.
The plugin owns every word of review instruction; the worker only routes it. The verdict contract is
unchanged — `VERDICT:` as the last non-empty line, `BLOCKER` meaning any BLOCKER finding or any MAJOR
that reverses a decision, changes scope, or needs a judgment only the human can make.

`worker-brief.md` inherits from `task.md`: the `{{surface}}` → `.claude/agents/<surface>-dev.md`
routing, the `core`-dependency `dist` rebuild line, the TDD and conventional-commit requirements, and
the `Closes #<n>` PR-body rule. It adds the loop protocol, the rendered artifact paths, and the
`hpipe decide` contract.

## Code shape

One table in `machine.ts` is the single source of phase knowledge:

```ts
interface PhaseRow<P> {
  phase: P
  actor: 'orchestrator' | 'worker' | 'supervisor' | 'human' | null
  signal: 'artifact' | 'verdict' | 'pr' | 'ci' | 'merged' | 'closed'
        | 'worktree' | 'registration' | 'gate' | 'manual'
  artifact?: 'research' | 'spec' | 'plan'
  onClear?: P
  onBlocker?: P
  prompt?: string
  stallable?: boolean
  holdsFiles?: boolean
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
| `HOLDS_FILES` (in `gating.ts`, unknown to `machine.ts`) | `holdsFiles` |
| `ON_CLEAR` / `ON_BLOCKER` | `onClear` / `onBlocker` |
| implicit "every task phase delivers to the orchestrator" | `actor` |
| implicit "stall-probe the artifact phases" | `stallable` |

**`stallable` is an explicit field, not derived from `signal`.** `blocked-on-decision` has no artifact
and must still be probed, and its probe targets the orchestrator rather than the phase's worker.
Deriving stall eligibility from the signal would silently exclude the one row that most needs it.

Three call sites change beyond the table:

1. **`nextDelivery` / `evaluateRun`** take the pane from `row.actor` — `run.orchestrator_pane` for
   orchestrator rows, `task.pane_id` for worker rows — instead of always the orchestrator's.
   `TaskSignals`' separate `actorIdle` and `workerIdle` collapse into one `actorIdle` resolved per row.
2. **`artifactPathFor`** resolves relative to `task.checkout_path` for task phases, and reads
   `row.artifact` to select the `research`/`spec`/`plan` slot rather than assuming every task artifact
   is a verdict — which held in v4 only because every task phase the orchestrator acted on was a review.
3. **`src/actions/decide.ts` and `src/actions/answer.ts`** are the only writers of
   `blocked-on-decision` and the only path out of it.

## CLI

| Command | Change |
| --- | --- |
| `hpipe task` | `--text` removed; `--issue` remains required; `--notes` added — free text rendered into `worker-brief.md` for batch context that does not belong in a public issue body (ordering rationale, a sibling task's contract) |
| `hpipe decide` | **new** — `--task`, `--question`, `--recommend` (all required) |
| `hpipe answer` | **new** — `--task`, `--decision`, `--answer`, `--by` (all required) |
| `hpipe status` | lists open decisions with age, task, question |
| `hpipe rewind` | accepts the new task phases; unchanged semantics |
| `hpipe start`, `claim`, `abort`, `resume`, `forget`, `drain` | unchanged |

## Configuration

No new keys. `STALL_MINUTES` covers unanswered decisions; `MAX_PASSES` covers all four worker review
phases under the corrected per-phase reading; `TASK_STALL_MINUTES` covers a silent worker in any
worker-owned phase, not only `implement`.

## Migration

Run records gain `schema_version: 2`. The supervisor **refuses to advance** a run without it,
surfacing through `hpipe status`: *"run <id> was started by an earlier plugin version — finish it on
that version or `hpipe abort` it."* No in-place migration: v4 phases have no honest mapping onto v5
rows, because a v4 run mid-`plan` has an orchestrator holding work no worker can inherit.

## Failure modes

| Mode | Handling |
| --- | --- |
| The worker's reviewer subagent shares its `CLAUDE.md` and repo view | Accepted and priced. A fresh context is not a fresh worldview, and this is weaker than v4's orchestrator-dispatched review. The verdict contract, `MAX_PASSES`, and the verdict files landing in the PR are the backstop. |
| Worker dies mid-loop | Task → `failed`. The worktree and its artifacts survive on the branch for `hpipe rewind` or manual pickup. Unchanged from v4. |
| Orchestrator never answers a decision | Stall probe re-prompts once per phase entry; `hpipe status` shows the age. Never auto-resolves. |
| Worker calls `hpipe decide` and keeps working | The phase is already `blocked-on-decision` with no predicate, so nothing advances on the extra work; it is redone after the answer. Wasteful, not incorrect. |
| Worker never calls `hpipe decide` and invents a pattern instead | `spec-review` and `plan-review` are the catch, and `worker-brief.md` states that inventing a pattern the repo does not establish is itself a surfaceable decision. Residual risk accepted. |
| Six artifacts × N tasks in one branch | Real cost, accepted. Each is scoped to one issue and reviewed by that issue's PR reviews. |
| Escalation volume is unbounded by design | Intake quality sets it. A vague issue produces questions. This is the intended feedback loop, but it means a bad batch can flood the orchestrator, and `hpipe status` is the only throttle. |
| A run with every task `failed` | `execute` → `escalated` rather than `branch-review`, because there is nothing to review. |

## Testing

- `machine-run.test.ts`, `machine-task.test.ts` — rewritten row sets, including the `pass`-reset-on-
  forward-transition rule and `head_sha_at_entry` re-capture on every `implement` entry.
- `deliver.test.ts` — worker-pane routing: a worker-owned phase must never deliver to
  `orchestrator_pane`, and a task with `pane_id === null` must be skipped, not errored.
- `gating.test.ts` — `holdsFiles` for the new rows, including `blocked-on-decision`.
- `decide.test.ts` — **new**: surface → triage → answer → resume, asserting the `phase_entered_at`
  reset, the `pass` non-increment, the `--recommend` requirement, and that no predicate exits
  `blocked-on-decision`.
- `table.test.ts` — **new**, the class-level check: every non-terminal row has an `onClear`; every
  `verdict` row has an `onBlocker`; every row naming a `prompt` names a file present in `prompts/`;
  every `actor` resolves to a pane field that exists on the record type. The v4 review rounds caught
  four separate instances of this class one at a time.

**Unit tests are not sufficient here.** The first live run of v4 surfaced two startup/gating defects
that dependency-injected fakes had passed. This change must be exercised against a real herdr session
with at least two concurrent workers and at least one surfaced decision before it is called done.

## Rejected alternatives

| Option | Why not |
| --- | --- |
| Keep the v4 pipeline behind `PIPELINE_MODE` | Doubles the table and the prompt set. "Fix the instance, not the class" is the failure v4's own review history records four times. |
| Fixed categories for what a worker surfaces | Predictable load, but it makes the plugin the arbiter of importance across every repo it runs in. Judgment, taught by prompt, was chosen instead. |
| Worker reviews run as separate herdr agent panes | Genuinely independent context, and observable. Doubles pane count per task and puts reviewer lifecycle in the supervisor. Deferred, not dismissed — it is the obvious upgrade if self-review proves too weak. |
| Headless `claude -p` for worker reviews | Independent context with no pane, but invisible while running and un-interruptible. |
| One issue per run | An issue becomes the unit of work end to end, but it breaks the one-active-run-per-repo invariant and reduces `branch-review` to a third review of a single PR. |
| A standing per-repo pipeline with no run boundaries | Removes `branch-review` entirely and rewrites `hpipe start`/`abort`. Largest state change for the least gain right now. |
| Fold `research` into `spec` | Five artifacts instead of six, but loses the evidence record that `spec-review` checks the design against. |
