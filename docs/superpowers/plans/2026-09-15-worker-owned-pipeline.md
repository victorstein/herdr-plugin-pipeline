# Worker-Owned Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move research, spec, adversarial review and planning out of the orchestrator agent and into the per-issue worker agent, leaving the orchestrator with intake, dispatch, decision triage, merge, close and branch-review.

**Architecture:** One declarative phase-row table in `src/lib/phases.ts` becomes the single source of phase knowledge — actor, completion signal, transitions, counter key, stall eligibility, file-holding. `machine.ts`, `gating.ts`, `stall.ts` and the delivery path all read from it instead of carrying their own phase sets. Delivery changes from one message per run per tick to one message per **actor pane** per tick. A new `blocked-on-decision` state, written and cleared only by CLI, carries worker questions to the orchestrator.

**Tech Stack:** Bun + TypeScript, no build step. `bun test` (bun:test), `tsc --noEmit` for typecheck. Tests live in `test/*.test.ts` with a local `fixture()` per file.

**Spec:** `docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md` (v3, after two adversarial rounds).

---

## Reading order before you start

Read these three, in this order. The plan assumes you have.

1. `docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md` — what you are building.
2. `docs/superpowers/specs/2026-09-13-herdr-pipeline-plugin-design.md` §Execution model, §Sessions, §Verified herdr facts — the constraints that still hold. In particular: **a hook writes one event file and exits**, herdr caps plugin commands at 32 concurrent and drops the overflow, and `plugin.action.invoke` accepts no user arguments, so every command taking data is an `hpipe` subcommand in `src/cli.ts`, never a file in `src/actions/`.
3. `docs/superpowers/reviews/2026-09-15-worker-owned-adversarial-{1,2}.md` — 31 findings, all applied to the spec. Read them for the failure classes, not the fixes: unverified claims, level predicates dressed as edges, and fixing an instance rather than the class. The review-loop bound had to be written three times.

## The one rule that has broken twice

**Every row that can send a record back to a producer phase carries a monotone counter keyed by itself, increments it on the way back, escalates at `MAX_PASSES`, and never resets it. Only `hpipe rewind` clears a counter.**

That is six rows: `spec-review`, `plan-review`, `pr-review-intent`, `pr-review-quality`, `ci`, `branch-review`. `ci` is in that list and is not a review — it has no verdict. If you find yourself writing a reset on a forward transition, or scoping the rule to "the review phases", stop: that is the exact move that produced an unbounded loop in both previous drafts.

---

## File Structure

**New:**

| File | Responsibility |
| --- | --- |
| `src/lib/phases.ts` | The `PhaseRow` table for run and task phases, plus lookup helpers. The only place a phase's actor, counter, transitions, stall eligibility or file-holding is written down. |
| `src/lib/decisions.ts` | Decision record helpers: open, answer, abandon, find-open. Pure functions over `Task`. |
| `test/phases.test.ts` | Unit tests for the lookup helpers. |
| `test/table.test.ts` | Class-level invariants over the table itself. This is the test that would have caught both previous bugs. |
| `test/decide.test.ts` | The decision channel end to end. |
| `prompts/intake.md`, `decision.md`, `answer.md`, `worker-brief.md`, `research.md`, `spec.md`, `spec-review.md`, `plan.md`, `plan-review.md`, `implement.md`, `pr-review-intent.md`, `pr-review-quality.md` | New prompt text. |

**Modified:** `src/lib/types.ts`, `src/lib/machine.ts`, `src/lib/gating.ts`, `src/lib/worker-prompt.ts`, `src/lib/status.ts`, `src/lib/ledger.ts`, `src/supervisor/deliver.ts`, `src/supervisor/tasks.ts`, `src/supervisor/tick.ts`, `src/supervisor/stall.ts`, `src/supervisor/teardown.ts`, `src/supervisor/main.ts`, `src/cli.ts`, `prompts/dispatch.md`.

**Deleted:** `prompts/spec.md` (run-level — replaced by the worker one of the same name), `prompts/spec-review.md`, `prompts/plan.md`, `prompts/plan-review.md` (all run-level), `prompts/task.md`, `prompts/task-review-spec.md`, `prompts/task-review-quality.md`.

## Milestones and the green/red rule

This is a **replacement**, not an additive feature. Milestone 2 changes the phase unions, and every module that names a phase stops compiling until it is updated. Trying to keep `tsc --noEmit` green after every task inside M2 would mean shipping a parallel machine and a switch, which is the "two tables" shape the spec rejects.

So: **inside Milestone 2, run the specific test file named in the task. At each milestone exit gate, `bun test` and `bun run typecheck` must both be clean.** Do not move to the next milestone with a red gate.

| Milestone | Tasks | Exit gate |
| --- | --- | --- |
| M1 — The table | 1–4 | Full suite green (all additive) |
| M2 — The machine | 5–10 | Full suite green, old phase names gone from `src/` |
| M3 — Gating and delivery | 11–16 | Full suite green |
| M4 — The decision channel | 17–22 | Full suite green |
| M5 — Prompts, intake, migration | 23–29 | Full suite green + the live smoke run |

---

# Milestone 1 — The table

Purely additive. Nothing consumes `phases.ts` yet, so the suite stays green throughout.

### Task 1: The `PhaseRow` type and the run table

**Files:**
- Create: `src/lib/phases.ts`
- Test: `test/phases.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/phases.test.ts
import { expect, test } from 'bun:test'
import { RUN_ROWS, runRow } from '../src/lib/phases'

test('every run phase has exactly one row', () => {
  const seen = new Set(RUN_ROWS.map((r) => r.phase))
  expect(seen.size).toBe(RUN_ROWS.length)
})

test('runRow returns the row for a phase', () => {
  expect(runRow('branch-review').actor).toBe('orchestrator')
  expect(runRow('branch-review').counter).toBe('branch-review')
})

test('intake is an orchestrator row with no counter', () => {
  expect(runRow('intake').actor).toBe('orchestrator')
  expect(runRow('intake').counter).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/phases.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/phases'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/phases.ts

export type RunPhase =
  | 'intake' | 'dispatch' | 'execute' | 'branch-review' | 'escalated' | 'done'

export type Actor = 'orchestrator' | 'worker' | 'supervisor' | 'human'

export type Signal =
  | 'artifact' | 'verdict' | 'pr' | 'ci' | 'merged' | 'closed'
  | 'worktree' | 'registration' | 'gate' | 'files' | 'manual'

export interface PhaseRow<P extends string> {
  phase: P
  /** Whose pane produces this phase's completion signal. Absent = nobody's. */
  actor?: Actor
  signal: Signal
  /** Which artifact slot this row's freshness predicate reads. */
  artifact?: 'research' | 'spec' | 'plan'
  onClear?: P
  onBlocker?: P
  /** Dynamic return target, for rows whose exit is recorded on the record. */
  returnsTo?: 'decision_from' | 'escalated_from'
  /**
   * The key this row increments on a backward transition. Required on every row
   * with an `onBlocker`; asserted by table.test.ts. Monotone — nothing resets it
   * but `hpipe rewind`.
   */
  counter?: P
  prompt?: string
  /** Prompt sent to `resumeActor` when this row is left, not when it is entered. */
  resumePrompt?: string
  resumeActor?: Actor
  stallable?: boolean
  /** Required when `actor` resolves to no pane and the row is stallable. */
  probeTarget?: 'orchestrator'
  terminal?: boolean
  releasesPane?: boolean
}

export const RUN_ROWS: readonly PhaseRow<RunPhase>[] = [
  { phase: 'intake', actor: 'orchestrator', signal: 'registration',
    onClear: 'dispatch', prompt: 'intake', stallable: true },
  { phase: 'dispatch', actor: 'orchestrator', signal: 'worktree',
    onClear: 'execute', prompt: 'dispatch', stallable: true },
  { phase: 'execute', signal: 'gate',
    onClear: 'branch-review', stallable: true, probeTarget: 'orchestrator' },
  { phase: 'branch-review', actor: 'orchestrator', signal: 'verdict',
    onClear: 'done', onBlocker: 'branch-review', counter: 'branch-review',
    prompt: 'branch-review', stallable: true },
  { phase: 'escalated', actor: 'human', signal: 'manual',
    returnsTo: 'escalated_from', prompt: 'escalate', releasesPane: true },
  { phase: 'done', signal: 'manual', terminal: true, releasesPane: true },
]

const RUN_BY_PHASE = new Map(RUN_ROWS.map((r) => [r.phase, r]))

export function runRow(phase: RunPhase): PhaseRow<RunPhase> {
  const row = RUN_BY_PHASE.get(phase)
  if (!row) throw new Error(`no run row for phase: ${phase}`)
  return row
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/phases.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/phases.ts test/phases.test.ts
git commit -m "feat: add the declarative run phase table"
```

---

### Task 2: The task table

**Files:**
- Modify: `src/lib/phases.ts`
- Test: `test/phases.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/phases.test.ts`:

```ts
import { TASK_ROWS, taskRow } from '../src/lib/phases'

test('every task phase has exactly one row', () => {
  const seen = new Set(TASK_ROWS.map((r) => r.phase))
  expect(seen.size).toBe(TASK_ROWS.length)
})

test('the eight worker-owned rows are exactly the design loop', () => {
  const worker = TASK_ROWS.filter((r) => r.actor === 'worker').map((r) => r.phase).sort()
  expect(worker).toEqual([
    'implement', 'plan', 'plan-review', 'pr-review-intent',
    'pr-review-quality', 'research', 'spec', 'spec-review',
  ])
})

test('ci carries its own counter — it is not a review row but it loops', () => {
  expect(taskRow('ci').counter).toBe('ci')
  expect(taskRow('ci').onBlocker).toBe('implement')
})

test('blocked-on-files holds no files and has no actor pane', () => {
  expect(taskRow('blocked-on-files').holdsFiles).toBe(false)
  expect(taskRow('blocked-on-files').actor).toBeUndefined()
  expect(taskRow('blocked-on-files').probeTarget).toBe('orchestrator')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/phases.test.ts`
Expected: FAIL — `TASK_ROWS` is not exported

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/phases.ts`. Note `holdsFiles` is added to `PhaseRow` here:

```ts
export type TaskPhase =
  | 'queued' | 'research' | 'spec' | 'spec-review' | 'plan' | 'plan-review'
  | 'blocked-on-files' | 'implement' | 'pr-review-intent' | 'pr-review-quality'
  | 'ci' | 'merge' | 'close' | 'teardown' | 'blocked-on-decision'
  | 'escalated' | 'failed' | 'orphaned' | 'blocked-on-failure' | 'done'
```

Add `holdsFiles?: boolean | 'inherit'` to the `PhaseRow` interface, then:

```ts
export const TASK_ROWS: readonly PhaseRow<TaskPhase>[] = [
  { phase: 'queued', signal: 'gate', onClear: 'research', holdsFiles: false },

  { phase: 'research', actor: 'worker', signal: 'artifact', artifact: 'research',
    onClear: 'spec', prompt: 'research', stallable: true, holdsFiles: false },
  { phase: 'spec', actor: 'worker', signal: 'artifact', artifact: 'spec',
    onClear: 'spec-review', prompt: 'spec', stallable: true, holdsFiles: false },
  { phase: 'spec-review', actor: 'worker', signal: 'verdict',
    onClear: 'plan', onBlocker: 'spec', counter: 'spec-review',
    prompt: 'spec-review', stallable: true, holdsFiles: false },
  { phase: 'plan', actor: 'worker', signal: 'artifact', artifact: 'plan',
    onClear: 'plan-review', prompt: 'plan', stallable: true, holdsFiles: false },
  { phase: 'plan-review', actor: 'worker', signal: 'verdict',
    onClear: 'blocked-on-files', onBlocker: 'plan', counter: 'plan-review',
    prompt: 'plan-review', stallable: true, holdsFiles: false },

  { phase: 'blocked-on-files', signal: 'files', onClear: 'implement',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: false },

  { phase: 'implement', actor: 'worker', signal: 'pr',
    onClear: 'pr-review-intent', prompt: 'implement', holdsFiles: true },
  { phase: 'pr-review-intent', actor: 'worker', signal: 'verdict',
    onClear: 'pr-review-quality', onBlocker: 'implement', counter: 'pr-review-intent',
    prompt: 'pr-review-intent', stallable: true, holdsFiles: true },
  { phase: 'pr-review-quality', actor: 'worker', signal: 'verdict',
    onClear: 'ci', onBlocker: 'implement', counter: 'pr-review-quality',
    prompt: 'pr-review-quality', stallable: true, holdsFiles: true },

  { phase: 'ci', signal: 'ci', onClear: 'merge', onBlocker: 'implement',
    counter: 'ci', prompt: 'ci-red', holdsFiles: true },
  { phase: 'merge', actor: 'orchestrator', signal: 'merged',
    onClear: 'close', prompt: 'merge', holdsFiles: true },
  { phase: 'close', actor: 'orchestrator', signal: 'closed',
    onClear: 'teardown', prompt: 'close', holdsFiles: true },
  { phase: 'teardown', signal: 'worktree', onClear: 'done', holdsFiles: true },

  { phase: 'blocked-on-decision', actor: 'orchestrator', signal: 'manual',
    returnsTo: 'decision_from', prompt: 'decision',
    resumePrompt: 'answer', resumeActor: 'worker',
    stallable: true, holdsFiles: 'inherit' },
  { phase: 'escalated', actor: 'human', signal: 'manual',
    returnsTo: 'escalated_from', prompt: 'escalate', holdsFiles: true },

  { phase: 'failed', signal: 'manual', terminal: true, holdsFiles: true },
  { phase: 'orphaned', signal: 'manual', terminal: true, holdsFiles: false },
  { phase: 'blocked-on-failure', signal: 'manual', terminal: true, holdsFiles: false },
  { phase: 'done', signal: 'manual', terminal: true, holdsFiles: false },
]

const TASK_BY_PHASE = new Map(TASK_ROWS.map((r) => [r.phase, r]))

export function taskRow(phase: TaskPhase): PhaseRow<TaskPhase> {
  const row = TASK_BY_PHASE.get(phase)
  if (!row) throw new Error(`no task row for phase: ${phase}`)
  return row
}
```

Note `orphaned` is `holdsFiles: false` — it is only reachable after merge, so that code has landed. This matches the v4 comment in `gating.ts` and is deliberate.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/phases.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/phases.ts test/phases.test.ts
git commit -m "feat: add the declarative task phase table"
```

---

### Task 3: Table invariants — the class-level check

This is the test that would have caught both prior bugs. Write it carefully.

**Files:**
- Create: `test/table.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/table.test.ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { RUN_ROWS, TASK_ROWS, type PhaseRow } from '../src/lib/phases'

const ALL: readonly PhaseRow<string>[] = [...RUN_ROWS, ...TASK_ROWS]

test('every row with an onBlocker names a counter keyed to itself', () => {
  for (const row of ALL) {
    if (!row.onBlocker) continue
    expect(row.counter, `${row.phase} loops back but names no counter`).toBe(row.phase)
  }
})

test('every counter-bearing row can loop back', () => {
  for (const row of ALL) {
    if (!row.counter) continue
    expect(row.onBlocker, `${row.phase} has a counter but never loops`).toBeDefined()
  }
})

test('every non-terminal row has an onClear or a returnsTo', () => {
  for (const row of ALL) {
    if (row.terminal) continue
    const exits = row.onClear !== undefined || row.returnsTo !== undefined
    expect(exits, `${row.phase} is non-terminal with no exit`).toBe(true)
  }
})

test('every stallable row resolves to a pane or names a probe target', () => {
  for (const row of ALL) {
    if (!row.stallable) continue
    const hasPane = row.actor === 'orchestrator' || row.actor === 'worker'
    expect(hasPane || row.probeTarget !== undefined,
      `${row.phase} is stallable but nothing can be probed`).toBe(true)
  }
})

test('every prompt named by a row exists on disk', () => {
  for (const row of ALL) {
    for (const name of [row.prompt, row.resumePrompt]) {
      if (!name) continue
      const path = join(import.meta.dir, '..', 'prompts', `${name}.md`)
      expect(existsSync(path), `${row.phase} names missing prompt ${name}.md`).toBe(true)
    }
  }
})

test('every resumePrompt names a resumeActor', () => {
  for (const row of ALL) {
    if (!row.resumePrompt) continue
    expect(row.resumeActor, `${row.phase} has a resumePrompt with no actor`).toBeDefined()
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/table.test.ts`
Expected: FAIL on "every prompt named by a row exists on disk" — `research.md`, `spec-review.md` (worker), `implement.md`, `pr-review-intent.md`, `pr-review-quality.md`, `intake.md`, `decision.md`, `answer.md` do not exist yet.

This failure is correct and expected. The prompts land in Milestone 5.

- [ ] **Step 3: Make it pass by stubbing the prompts**

Create each missing file with a one-line placeholder so the invariant holds now and the real text lands in M5. Milestone 5 Task 24 replaces every one of these.

```bash
cd /Volumes/stein/Documents/development/personal/herdr-plugin-pipeline
for p in intake decision answer research implement pr-review-intent pr-review-quality; do
  printf '# %s\n\nTODO: replaced in Milestone 5, Task 24.\n' "$p" > "prompts/$p.md"
done
```

`spec.md`, `spec-review.md`, `plan.md`, `plan-review.md` already exist as run-level prompts and are rewritten in place in M5.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/table.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Run the full suite — M1 must not break anything**

Run: `bun test && bun run typecheck`
Expected: 221+ pass, 0 fail; typecheck silent

- [ ] **Step 6: Commit**

```bash
git add test/table.test.ts prompts/
git commit -m "test: assert the phase table's class-level invariants"
```

---

### Task 4: Record fields and `schema_version`

Additive only — new optional fields alongside the existing ones. The phase unions do **not** change yet; that is Task 5.

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ledger.ts` (set `schema_version` on `newRun`)
- Test: `test/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/ledger.test.ts`:

```ts
test('a new run carries schema_version 2 and an open intake', () => {
  const run = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  expect(run.schema_version).toBe(2)
  expect(run.intake_closed).toBe(false)
  expect(run.passes).toEqual({})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/ledger.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` received `undefined`

- [ ] **Step 3: Write minimal implementation**

In `src/lib/types.ts`, add the `Decision` interface and extend the records:

```ts
export interface Decision {
  id: string
  asked_at: number
  from_phase: string
  question: string
  recommendation: string
  answer: string | null
  answered_by: 'orchestrator' | 'human' | 'abandoned' | null
  answered_at: number | null
}
```

Add to `Task`:

```ts
  /** Worktree checkout path. Task artifacts resolve against this, not repo_root. */
  checkout_path: string | null
  registered_at: number
  adopted_at: number | null
  merged_at_ms: number | null
  /** True when the issue was already closed at `merge` completion. */
  issue_closed_at_entry: boolean
  passes: Record<string, number>
  decisions: Decision[]
  decision_from: string | null
  pending_answer: string | null
  notes: string
```

Add to `Run`:

```ts
  schema_version: number
  intake_closed: boolean
  passes: Record<string, number>
```

Keep `pass: number` on both for now — Task 7 removes it.

In `src/lib/ledger.ts`, `newRun` sets `schema_version: 2`, `intake_closed: false`, `passes: {}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/ledger.test.ts`
Expected: PASS

- [ ] **Step 5: Fix the fixtures the new required fields broke**

Run: `bun run typecheck`
Every `test/*.test.ts` that builds a `Task` literal now fails on missing fields. Add to each fixture:

```ts
    checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, notes: '',
```

- [ ] **Step 6: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: green

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/ledger.ts test/
git commit -m "feat: add worker-owned record fields and schema_version"
```

**M1 exit gate:** `bun test && bun run typecheck` clean.

---

# Milestone 2 — The machine

The phase unions change here. Typecheck goes red across `src/` until Task 10. Run the named test file per task; the full gate is at the end of the milestone.

### Task 5: Point the phase unions at the table

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Make the change**

Delete the `RunPhase` and `TaskPhase` unions from `types.ts` and re-export the table's:

```ts
export type { RunPhase, TaskPhase } from './phases'
```

Change `Task.passes` / `Run.passes` from `Record<string, number>` to `Partial<Record<TaskPhase, number>>` and `Partial<Record<RunPhase, number>>`, and `Task.decision_from` to `TaskPhase | null`, `Task.escalated_from` to `TaskPhase | null` (already is), `Decision.from_phase` to `TaskPhase`.

- [ ] **Step 2: Observe the damage**

Run: `bun run typecheck`
Expected: FAIL, ~40 errors across `machine.ts`, `gating.ts`, `stall.ts`, `teardown.ts`, `tasks.ts`, `tick.ts`, `deliver.ts`, `cli.ts`, `status.ts` and their tests. This is the red window. Tasks 6–10 close it.

- [ ] **Step 3: Commit anyway, so the red window is one reviewable commit**

```bash
git add src/lib/types.ts
git commit -m "refactor: source the phase unions from the table

Typecheck is red from here until the machine rewrite lands. Deliberate:
a parallel machine behind a switch is the two-table shape the spec rejects."
```

---

### Task 6: Monotone counters

**Files:**
- Modify: `src/lib/machine.ts`
- Test: `test/machine-task.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the counter assertions in `test/machine-task.test.ts` with:

```ts
import { bumpCounter, counterFor } from '../src/lib/machine'

test('a counter increments and never resets on forward progress', () => {
  const { task } = fixture('spec-review')
  expect(counterFor(task, 'spec-review')).toBe(0)
  bumpCounter(task, 'spec-review')
  expect(counterFor(task, 'spec-review')).toBe(1)
  bumpCounter(task, 'spec-review')
  expect(counterFor(task, 'spec-review')).toBe(2)
})

test('counters are independent per phase', () => {
  const { task } = fixture('spec-review')
  bumpCounter(task, 'spec-review')
  bumpCounter(task, 'spec-review')
  expect(counterFor(task, 'plan-review')).toBe(0)
  expect(counterFor(task, 'ci')).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/machine-task.test.ts`
Expected: FAIL — `bumpCounter` is not exported

- [ ] **Step 3: Write minimal implementation**

In `src/lib/machine.ts`:

```ts
interface HasPasses { passes: Record<string, number | undefined> }

export function counterFor(record: HasPasses, phase: string): number {
  return record.passes[phase] ?? 0
}

/**
 * Monotone by construction. Nothing in this module decrements or deletes a
 * counter — only `hpipe rewind` clears the map. Two earlier drafts reset on a
 * forward transition and each time deleted a bound: the review loop in one, the
 * shipped CI retry budget in the other.
 */
export function bumpCounter(record: HasPasses, phase: string): number {
  const next = counterFor(record, phase) + 1
  record.passes[phase] = next
  return next
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/machine-task.test.ts -t counter`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/machine.ts test/machine-task.test.ts
git commit -m "feat: monotone per-phase counters"
```

---

### Task 7: Table-driven `advanceTask` — the review and CI rows

**Files:**
- Modify: `src/lib/machine.ts`
- Test: `test/machine-task.test.ts`

- [ ] **Step 1: Write the failing tests**

The load-bearing one is the full lap. Write it first.

```ts
test('the implement -> reviews -> red ci lap terminates instead of resetting', () => {
  const { run, task } = fixture('pr-review-intent')
  const clear = { verdict: 'CLEAR' as const, blockers: 0, majors: 0 }
  const signals = {
    actorIdle: true, artifactFresh: true, verdict: clear,
    prNumber: 5, headSha: 'bbb', merged: false, issueClosed: false,
    ciBucket: null as null, maxPasses: 2,
  }

  // Lap 1: both reviews clear, CI goes red, task returns to implement.
  advanceTask(run, task, signals)                                  // -> pr-review-quality
  advanceTask(run, task, signals)                                  // -> ci
  expect(task.phase).toBe('ci')
  advanceTask(run, task, { ...signals, verdict: null, ciBucket: 'fail' })
  expect(task.phase).toBe('implement')
  expect(counterFor(task, 'ci')).toBe(1)

  // Lap 2: identical, and the ci counter must NOT have been reset by the clears.
  enterTaskPhase(run, task, 'pr-review-intent', 'test')
  advanceTask(run, task, signals)
  advanceTask(run, task, signals)
  advanceTask(run, task, { ...signals, verdict: null, ciBucket: 'fail' })
  expect(task.phase).toBe('escalated')
  expect(counterFor(task, 'ci')).toBe(2)
})

test('a review row escalates at MAX_PASSES on its own counter', () => {
  const { run, task } = fixture('spec-review')
  const blocker = { verdict: 'BLOCKER' as const, blockers: 1, majors: 0 }
  const s = {
    actorIdle: true, artifactFresh: true, verdict: blocker, prNumber: null,
    headSha: null, merged: false, issueClosed: false, ciBucket: null, maxPasses: 2,
  }
  advanceTask(run, task, s)
  expect(task.phase).toBe('spec')
  enterTaskPhase(run, task, 'spec-review', 'test')
  advanceTask(run, task, s)
  expect(task.phase).toBe('escalated')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/machine-task.test.ts -t lap`
Expected: FAIL — `advanceTask` still switches on the v4 phase names

- [ ] **Step 3: Write the implementation**

Replace `advanceTask`'s `task-review-spec`/`task-review-quality` and `ci` cases with table-driven handling. The review and CI rows share one path because they share one shape — a row with a `counter`, an `onClear`, and an `onBlocker`:

```ts
function advanceLoopingRow(
  run: Run, task: Task, row: PhaseRow<TaskPhase>, cleared: boolean,
  maxPasses: number, headSha: string | null,
): Task | null {
  if (cleared) {
    // No counter reset here. See bumpCounter's comment.
    return enterTaskPhase(run, task, row.onClear as TaskPhase, 'cleared')
  }
  const count = bumpCounter(task, row.phase)
  if (count >= maxPasses) {
    return enterTaskPhase(run, task, 'escalated', `${count} passes at ${row.phase}`)
  }
  enterTaskPhase(run, task, row.onBlocker as TaskPhase, `returned (pass ${count})`)
  if (task.phase === 'implement') task.head_sha_at_entry = headSha
  return task
}
```

Then in `advanceTask`:

```ts
    case 'spec-review':
    case 'plan-review':
    case 'pr-review-intent':
    case 'pr-review-quality': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null
      return advanceLoopingRow(
        run, task, taskRow(task.phase), s.verdict.verdict === 'CLEAR',
        s.maxPasses, s.headSha,
      )
    }

    case 'ci': {
      if (s.ciBucket !== 'pass' && s.ciBucket !== 'fail') return null
      return advanceLoopingRow(
        run, task, taskRow('ci'), s.ciBucket === 'pass', s.maxPasses, s.headSha,
      )
    }
```

`TaskSignals` loses `workerIdle`; `actorIdle` is now resolved per row by the caller (Task 14).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/machine-task.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/machine.ts test/machine-task.test.ts
git commit -m "feat: table-driven review and ci rows with per-phase bounds"
```

---

### Task 8: The worker artifact rows and `implement`

**Files:**
- Modify: `src/lib/machine.ts`
- Test: `test/machine-task.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('an artifact row advances on actor idle plus a fresh artifact', () => {
  const { run, task } = fixture('research')
  const s = {
    actorIdle: true, artifactFresh: true, verdict: null, prNumber: null,
    headSha: null, merged: false, issueClosed: false, ciBucket: null, maxPasses: 2,
  }
  expect(advanceTask(run, task, s)?.phase).toBe('spec')
})

test('an artifact row does not advance on a stale artifact', () => {
  const { run, task } = fixture('spec')
  const s = {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: null,
    headSha: null, merged: false, issueClosed: false, ciBucket: null, maxPasses: 2,
  }
  expect(advanceTask(run, task, s)).toBeNull()
})

test('implement advances only when the head sha moved, and goes to pr-review-intent', () => {
  const { run, task } = fixture('implement')
  const s = {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: 5,
    headSha: 'bbb', merged: false, issueClosed: false, ciBucket: null, maxPasses: 2,
  }
  expect(advanceTask(run, task, s)?.phase).toBe('pr-review-intent')
  const stale = fixture('implement')
  expect(advanceTask(stale.run, stale.task, { ...s, headSha: 'aaa' })).toBeNull()
})

test('re-entry to implement re-captures head_sha_at_entry', () => {
  const { run, task } = fixture('pr-review-quality')
  advanceTask(run, task, {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'BLOCKER', blockers: 1, majors: 0 },
    prNumber: 5, headSha: 'ccc', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(task.phase).toBe('implement')
  expect(task.head_sha_at_entry).toBe('ccc')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/machine-task.test.ts -t artifact`
Expected: FAIL — `research` hits the `default: return null` arm

- [ ] **Step 3: Write minimal implementation**

```ts
    case 'research':
    case 'spec':
    case 'plan': {
      if (!s.actorIdle || !s.artifactFresh) return null
      return enterTaskPhase(
        run, task, taskRow(task.phase).onClear as TaskPhase, 'actor idle + artifact fresh',
      )
    }

    case 'implement': {
      const moved = s.headSha !== null && s.headSha !== task.head_sha_at_entry
      if (!s.actorIdle || s.prNumber === null || !moved) return null
      task.pr = s.prNumber
      return enterTaskPhase(run, task, 'pr-review-intent', `PR #${s.prNumber} at ${s.headSha}`)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/machine-task.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/machine.ts test/machine-task.test.ts
git commit -m "feat: worker artifact rows and the implement row"
```

---

### Task 9: `merge`, `close` and `blocked-on-files`

`close` is the row this repo already has a live deadlock bug on. Get the predicate right.

**Files:**
- Modify: `src/lib/machine.ts`
- Test: `test/machine-task.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('merge records merged_at_ms and whether the issue was already closed', () => {
  const { run, task } = fixture('merge')
  task.phase_entered_at = 1000
  advanceTask(run, task, {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: 5, headSha: 'a',
    merged: true, mergedAtMs: 2000, issueClosed: false, ciBucket: null, maxPasses: 2,
  })
  expect(task.phase).toBe('close')
  expect(task.merged_at_ms).toBe(2000)
  expect(task.issue_closed_at_entry).toBe(false)
})

test('close completes on an auto-closed issue, where closedAt predates phase entry', () => {
  // The bug this repo already has: GitHub closes the issue as a side effect of
  // the merge, so closedAt ~= mergedAt and always predates close's entry.
  const { run, task } = fixture('close')
  task.merged_at_ms = 2000
  task.phase_entered_at = 3000
  const next = advanceTask(run, task, {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: 5, headSha: 'a',
    merged: true, issueClosed: true, closedAtMs: 2001, ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('teardown')
})

test('close completes when the issue was already closed before the merge', () => {
  const { run, task } = fixture('close')
  task.merged_at_ms = 2000
  task.issue_closed_at_entry = true
  const next = advanceTask(run, task, {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: 5, headSha: 'a',
    merged: true, issueClosed: true, closedAtMs: 500, ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('teardown')
})

test('close does not complete on an issue that is still open', () => {
  const { run, task } = fixture('close')
  task.merged_at_ms = 2000
  expect(advanceTask(run, task, {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: 5, headSha: 'a',
    merged: true, issueClosed: false, ciBucket: null, maxPasses: 2,
  })).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/machine-task.test.ts -t close`
Expected: FAIL — the auto-close case returns null under the v4 `closedAtMs > phase_entered_at` comparison

- [ ] **Step 3: Write minimal implementation**

```ts
    case 'merge': {
      if (!s.merged) return null
      if (s.mergedAtMs === undefined || s.mergedAtMs <= task.phase_entered_at) return null
      task.merged_at_ms = s.mergedAtMs
      task.issue_closed_at_entry = s.issueClosed
      return enterTaskPhase(run, task, 'close', 'PR merged')
    }

    case 'close': {
      if (!s.issueClosed) return null
      // The edge is "closed by the merge that should have caused it", NOT "closed
      // after this phase began". GitHub auto-closes on merge, so closedAt always
      // predates phase entry and the v4 comparison was unsatisfiable.
      const closedByMerge =
        task.merged_at_ms !== null &&
        s.closedAtMs !== undefined &&
        s.closedAtMs >= task.merged_at_ms
      if (!task.issue_closed_at_entry && !closedByMerge) return null
      return enterTaskPhase(run, task, 'teardown', `issue #${task.issue} closed`)
    }

    case 'blocked-on-files': {
      if (!s.filesClear) return null
      return enterTaskPhase(run, task, 'implement', 'no overlapping files in flight')
    }
```

Add `filesClear: boolean` to `TaskSignals`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/machine-task.test.ts`
Expected: PASS

- [ ] **Step 5: Suppress `close.md` when there is nothing to close**

In `src/supervisor/tasks.ts`'s `promptForTaskPhase`, the `close` case returns `''` when the issue is
already closed. On the happy path GitHub auto-closes on merge, so the row completes on its first
evaluation and prompting the orchestrator to close an already-closed issue is noise it has to read.

```ts
    case 'close':
      // Only ask when the auto-close did NOT happen — a missing `Closes #n`
      // keyword, or an issue in another repo.
      return task.issue_closed_at_entry ? '' : renderPrompt(deps.pluginRoot, 'close', common)
```

Add the test:

```ts
test('close prompts only when the issue is still open', async () => {
  const closed = runWithTask({ phase: 'close' })
  closed.tasks[0]!.issue_closed_at_entry = true
  expect(await promptForTaskPhase(closed, closed.tasks[0]!, deps, 'merge')).toBe('')
})
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/tasks.test.ts test/machine-task.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/machine.ts src/supervisor/tasks.ts test/
git commit -m "fix: close compares against merged_at_ms, not phase entry"
```

---

### Task 10: `advanceRun` on the new run table

**Files:**
- Modify: `src/lib/machine.ts`
- Test: `test/machine-run.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `test/machine-run.test.ts` wholesale:

```ts
import { expect, test } from 'bun:test'
import { advanceRun, enterRunPhase, counterFor } from '../src/lib/machine'
import { newRun } from '../src/lib/ledger'
import type { Run, RunPhase } from '../src/lib/types'

function fixture(phase: RunPhase): Run {
  const run = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  enterRunPhase(run, phase, 'test')
  return run
}

test('intake advances on a task registered after phase entry', () => {
  const run = fixture('intake')
  run.phase_entered_at = 1000
  expect(advanceRun(run, {
    actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: 2000, newestAdoptedAt: null, tasksAllTerminal: false,
    anyTaskDone: false,
  })?.phase).toBe('dispatch')
})

test('intake does NOT advance on a task registered before phase entry', () => {
  const run = fixture('intake')
  run.phase_entered_at = 3000
  expect(advanceRun(run, {
    actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: 2000, newestAdoptedAt: null, tasksAllTerminal: false,
    anyTaskDone: false,
  })).toBeNull()
})

test('execute waits for intake_closed even when every task is terminal', () => {
  const run = fixture('execute')
  run.intake_closed = false
  expect(advanceRun(run, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: null, newestAdoptedAt: null,
    tasksAllTerminal: true, anyTaskDone: true,
  })).toBeNull()
})

test('execute goes to branch-review when intake is closed and a task is done', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: null, newestAdoptedAt: null,
    tasksAllTerminal: true, anyTaskDone: true,
  })?.phase).toBe('branch-review')
})

test('execute escalates when no task reached done', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: null, newestAdoptedAt: null,
    tasksAllTerminal: true, anyTaskDone: false,
  })?.phase).toBe('escalated')
})

test('branch-review escalates at MAX_PASSES on its own counter', () => {
  const run = fixture('branch-review')
  const s = {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'BLOCKER' as const, blockers: 1, majors: 0 }, maxPasses: 2,
    newestRegisteredAt: null, newestAdoptedAt: null,
    tasksAllTerminal: false, anyTaskDone: false,
  }
  advanceRun(run, s)
  expect(run.phase).toBe('branch-review')
  expect(counterFor(run, 'branch-review')).toBe(1)
  advanceRun(run, s)
  expect(run.phase).toBe('escalated')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/machine-run.test.ts`
Expected: FAIL — `RunSignals` has no `newestRegisteredAt`

- [ ] **Step 3: Write minimal implementation**

```ts
export interface RunSignals {
  actorIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  maxPasses: number
  newestRegisteredAt: number | null
  newestAdoptedAt: number | null
  tasksAllTerminal: boolean
  anyTaskDone: boolean
}

export function advanceRun(run: Run, s: RunSignals): Run | null {
  switch (run.phase) {
    case 'intake': {
      if (!s.actorIdle) return null
      if (s.newestRegisteredAt === null || s.newestRegisteredAt <= run.phase_entered_at) return null
      return enterRunPhase(run, 'dispatch', 'a task was registered')
    }

    case 'dispatch': {
      // Edge, not level: a rewind to `dispatch` clears adopted_at on bound tasks
      // so this can re-fire. Without that this row is a one-way door.
      if (s.newestAdoptedAt === null || s.newestAdoptedAt <= run.phase_entered_at) return null
      return enterRunPhase(run, 'execute', 'a worktree was adopted')
    }

    case 'execute': {
      if (!run.intake_closed || !s.tasksAllTerminal) return null
      return s.anyTaskDone
        ? enterRunPhase(run, 'branch-review', 'all tasks settled')
        : enterRunPhase(run, 'escalated', 'every task settled without one reaching done')
    }

    case 'branch-review': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null
      if (s.verdict.verdict === 'CLEAR') return enterRunPhase(run, 'done', 'review cleared')
      const count = bumpCounter(run, 'branch-review')
      if (count >= s.maxPasses) {
        return enterRunPhase(run, 'escalated', `${count} passes without clearing`)
      }
      return enterRunPhase(run, 'branch-review', `review returned BLOCKER (pass ${count})`)
    }

    default:
      return null
  }
}
```

Delete `ARTIFACT_RUN_PHASES`, `REVIEW_PHASES`, `COMPLETED_RUN_PHASES`, `PANE_RELEASING_RUN_PHASES`, `ON_CLEAR`, `ON_BLOCKER` and the `pass` fields from both records. Replace each consumer with the table:

```ts
// was: ARTIFACT_RUN_PHASES.has(run.phase)
const sig = runRow(run.phase).signal
sig === 'artifact' || sig === 'verdict'

// was: PANE_RELEASING_RUN_PHASES.has(run.phase)
runRow(run.phase).releasesPane === true
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/machine-run.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Close the red window**

Run: `bun run typecheck`
Fix every remaining error by replacing old phase names with new ones: `execute` → `implement` in task contexts, `task-review-spec` → `pr-review-intent`, `task-review-quality` → `pr-review-quality`.

**`teardown.ts`'s `SETTLED` is NOT `TASK_ROWS.filter(r => r.terminal)`.** The two sets differ by
`escalated`, which is settled for the purpose of "has this task stopped moving" but is not terminal —
it has a `returnsTo` and a human can rewind it. Deriving `SETTLED` from `terminal` drops `escalated`,
and a run with one escalated task then never leaves `execute`. Define it explicitly:

```ts
const SETTLED: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  ...TASK_ROWS.filter((r) => r.terminal).map((r) => r.phase),
  'escalated',
])
```

and state in a comment why `escalated` is added, because the asymmetry looks like a bug otherwise.

- [ ] **Step 6: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: green

- [ ] **Step 7: Verify the old names are gone**

Run: `grep -rn "task-review-spec\|task-review-quality\|ARTIFACT_RUN_PHASES\|\.pass\b" src/`
Expected: no output

- [ ] **Step 8: Commit**

```bash
git add src/ test/
git commit -m "feat: table-driven run machine with explicit intake closure"
```

**M2 exit gate:** `bun test && bun run typecheck` clean; the grep in Step 7 is empty.

---

# Milestone 3 — Gating and delivery

### Task 11: Split the file gate

`gating.ts` stops owning a phase set. `queued` gates on `depends_on` only; overlap moves to `blocked-on-files`.

**Files:**
- Modify: `src/lib/gating.ts`
- Test: `test/gating.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('queued ignores file overlap — only depends_on gates it', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'queued', files: ['packages/core/src/'] })
  expect(gateStatus(t2, [t1, t2])).toEqual({ state: 'ready' })
})

test('blocked-on-files is held by an in-flight overlapping sibling', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/src/'] })
  expect(filesClearFor(t2, [t1, t2])).toBe(false)
})

test('a design-phase sibling does not hold files', () => {
  const t1 = task({ task_id: 't1', phase: 'plan', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/'] })
  expect(filesClearFor(t2, [t1, t2])).toBe(true)
})

test('a failed sibling holds its files forever', () => {
  const t1 = task({ task_id: 't1', phase: 'failed', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/'] })
  expect(filesClearFor(t2, [t1, t2])).toBe(false)
})

test('blocked-on-decision inherits file-holding from decision_from', () => {
  const held = task({ task_id: 't1', phase: 'blocked-on-decision', files: ['a/'] })
  held.decision_from = 'implement'
  const free = task({ task_id: 't3', phase: 'blocked-on-decision', files: ['a/'] })
  free.decision_from = 'plan'
  const waiter = task({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] })
  expect(filesClearFor(waiter, [held, waiter])).toBe(false)
  expect(filesClearFor(waiter, [free, waiter])).toBe(true)
})

test('at most one task leaves an overlapping group per tick', () => {
  const a = task({ task_id: 't1', phase: 'blocked-on-files', files: ['a/'] })
  const b = task({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] })
  expect(releasableFromFiles([a, b]).map((t) => t.task_id)).toEqual(['t1'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gating.test.ts`
Expected: FAIL — `filesClearFor` is not exported

- [ ] **Step 3: Write minimal implementation**

Delete `HOLDS_FILES` from `gating.ts` — but **first move its comment onto the rows it explains**.
`gating.ts` is currently the only place recording why `failed` and `escalated` hold their files
forever while `orphaned` does not ("`orphaned` is only reachable after merge, so that code has
already landed"). That is a constraint that looks arbitrary without the reason, which is exactly what
this repo's comment rule preserves. Put it above the `failed`/`orphaned` rows in `phases.ts`.

Then add:

```ts
import { taskRow } from './phases'

function holdsFiles(task: Task): boolean {
  const rule = taskRow(task.phase).holdsFiles
  if (rule === 'inherit') {
    return task.decision_from !== null && taskRow(task.decision_from).holdsFiles === true
  }
  return rule === true
}

export function filesClearFor(task: Task, all: Task[]): boolean {
  return !all.some(
    (t) => t.task_id !== task.task_id && holdsFiles(t) && filesOverlap(task.files, t.files),
  )
}

/**
 * One pass in task_id order, at most one release per overlapping group. Without
 * the running set, two tasks freed by the same teardown both read "nothing
 * overlaps" on the same tick and both enter `implement`.
 */
export function releasableFromFiles(all: Task[]): Task[] {
  const waiting = all
    .filter((t) => t.phase === 'blocked-on-files')
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
  const released: Task[] = []
  for (const t of waiting) {
    if (!filesClearFor(t, all)) continue
    if (released.some((r) => filesOverlap(r.files, t.files))) continue
    released.push(t)
  }
  return released
}
```

Remove the overlap branch from `gateStatus` — it now only checks `depends_on`.

Wire it into the tick in the same commit: `advanceTasks` computes `filesClear` for a
`blocked-on-files` task by calling `releasableFromFiles(run.tasks)` **once per tick** and checking
membership — not by calling `filesClearFor` per task, which would let a whole overlapping group
through together. Because the set is recomputed every tick, a sibling entering `teardown`, `failed`
or `escalated` re-evaluates the group automatically; no explicit re-evaluation hook is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/gating.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/gating.ts test/gating.test.ts
git commit -m "feat: split the file gate out of queued into blocked-on-files"
```

---

### Task 12: `hpipe release`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli-commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('release drops a terminal task files reservation', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'failed', files: ['a/'] },
    { task_id: 't2', phase: 'blocked-on-files', files: ['a/'] },
  ])
  await cmdRelease(run, 't1')
  expect(run.tasks[0]?.files).toEqual([])
})

test('release refuses a task that is still in flight', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'implement', files: ['a/'] }])
  await expect(cmdRelease(run, 't1')).rejects.toThrow('still in flight')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli-commands.test.ts -t release`
Expected: FAIL — `cmdRelease` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
export async function cmdRelease(run: Run, taskId: string): Promise<void> {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (!task) throw new Error(`no such task: ${taskId}`)
  if (!taskRow(task.phase).terminal && task.phase !== 'escalated') {
    throw new Error(`task ${taskId} is still in flight (${task.phase})`)
  }
  task.files = []
  await saveRun(run)
}
```

Wire it into the arg parser beside `cmdRewind`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli-commands.test.ts -t release`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-commands.test.ts
git commit -m "feat: hpipe release frees a stranded file reservation"
```

---

### Task 13: Per-pane delivery

The single biggest behavioural change. `nextDelivery` returns a list, grouped by pane, never joining across panes.

**Files:**
- Modify: `src/supervisor/deliver.ts`
- Test: `test/deliver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('three prompts for three panes produce three deliveries', () => {
  const out = deliveriesFor([
    { paneId: 'w1:p1', run, text: 'orchestrator prompt', isOrchestrator: true, events: ['e1'] },
    { paneId: 'w7:p1', run, text: 'worker 1 prompt', isOrchestrator: false, events: [] },
    { paneId: 'w8:p1', run, text: 'worker 2 prompt', isOrchestrator: false, events: [] },
  ])
  expect(out).toHaveLength(3)
  expect(out.map((d) => d.paneId).sort()).toEqual(['w1:p1', 'w7:p1', 'w8:p1'])
})

test('a worker delivery carries no run digest header', () => {
  const out = deliveriesFor([
    { paneId: 'w7:p1', run, text: 'worker prompt', isOrchestrator: false, events: ['e1'] },
  ])
  expect(out[0]?.text).toBe('worker prompt')
  expect(out[0]?.text).not.toContain('[pipeline] run')
})

test('the orchestrator delivery carries the header and its events', () => {
  const out = deliveriesFor([
    { paneId: 'w1:p1', run, text: 'do the thing', isOrchestrator: true, events: ['e1', 'e2'] },
  ])
  expect(out[0]?.text).toContain('[pipeline] run')
  expect(out[0]?.text).toContain('2 events')
  expect(out[0]?.text).toContain('do the thing')
})

test('two prompts for the SAME pane are joined, not dropped', () => {
  const out = deliveriesFor([
    { paneId: 'w1:p1', run, text: 'first', isOrchestrator: true, events: [] },
    { paneId: 'w1:p1', run, text: 'second', isOrchestrator: true, events: [] },
  ])
  expect(out).toHaveLength(1)
  expect(out[0]?.text).toContain('first')
  expect(out[0]?.text).toContain('second')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/deliver.test.ts -t panes`
Expected: FAIL — `deliveriesFor` is not exported; `nextDelivery` returns one `Delivery | null`

- [ ] **Step 3: Write minimal implementation**

```ts
export interface PendingPrompt {
  paneId: string
  run: Run
  text: string
  isOrchestrator: boolean
  events: string[]
}

export interface Delivery { paneId: string; text: string; run: Run }

/**
 * Grouped by pane. v4 returned ONE delivery per tick and discarded the rest,
 * which was safe only because every prompt-producing row had the same recipient.
 * With eight worker-owned rows a tick routinely produces prompts for several
 * panes, and a dropped one is never regenerated because the run is already saved.
 */
export function deliveriesFor(pending: PendingPrompt[]): Delivery[] {
  const byPane = new Map<string, PendingPrompt[]>()
  for (const p of pending) {
    if (p.text.length === 0 && p.events.length === 0) continue
    const list = byPane.get(p.paneId) ?? []
    list.push(p)
    byPane.set(p.paneId, list)
  }

  const out: Delivery[] = []
  for (const [paneId, group] of byPane) {
    const first = group[0] as PendingPrompt
    const body = group.map((p) => p.text).filter((t) => t.length > 0).join('\n\n---\n\n')
    const events = group.flatMap((p) => p.events)
    const text = first.isOrchestrator
      ? buildDigest({ run: first.run, eventLines: events, phaseNote: ` → ${first.run.phase}`, nextPrompt: body })
      : body
    out.push({ paneId, text, run: first.run })
  }
  return out
}
```

Keep `buildDigest` as it is. Delete `nextDelivery`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/deliver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/deliver.ts test/deliver.test.ts
git commit -m "feat: group delivery by actor pane instead of by run"
```

---

### Task 14: Resolve `actorIdle` per row, live

**Files:**
- Modify: `src/supervisor/tasks.ts`
- Test: `test/tasks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a worker row reads the worker pane live, not the cached agent_status', async () => {
  const run = runWithTask({ phase: 'spec', pane_id: 'w7:p1', agent_status: 'idle' })
  const reads: string[] = []
  await advanceTasks(run, {
    ...deps,
    // The cache says idle; the live read says working. The live read must win.
    liveIdle: async (pane: string) => { reads.push(pane); return false },
  })
  expect(reads).toEqual(['w7:p1'])
  expect(run.tasks[0]?.phase).toBe('spec')
})

test('an orchestrator row reads the orchestrator pane', async () => {
  const run = runWithTask({ phase: 'merge', pane_id: 'w7:p1' })
  run.orchestrator_pane = 'w1:p1'
  const reads: string[] = []
  await advanceTasks(run, { ...deps, liveIdle: async (p: string) => { reads.push(p); return true } })
  expect(reads).toEqual(['w1:p1'])
})

test('a task with no pane is skipped, not errored', async () => {
  const run = runWithTask({ phase: 'research', pane_id: null })
  await expect(advanceTasks(run, deps)).resolves.toBeDefined()
  expect(run.tasks[0]?.phase).toBe('research')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/tasks.test.ts -t live`
Expected: FAIL — `TaskDeps` has a static `actorIdle: boolean`

- [ ] **Step 3: Write minimal implementation**

In `src/supervisor/tasks.ts`, replace `actorIdle: boolean` on `TaskDeps` with:

```ts
  /**
   * Live `herdr agent status` read on a pane, already double-checked after
   * ACTOR_SETTLE_MS by the caller. NOT task.agent_status, which is the badge and
   * wake cache and can be stale by a whole turn.
   */
  liveIdle: (paneId: string) => Promise<boolean>
```

and resolve the pane from the row:

```ts
function actorPaneFor(run: Run, task: Task): string | null {
  const actor = taskRow(task.phase).actor
  if (actor === 'worker') return task.pane_id
  if (actor === 'orchestrator') return run.orchestrator_pane
  return null
}
```

In the per-task loop, skip when the row has an actor but no pane:

```ts
  const row = taskRow(task.phase)
  const pane = actorPaneFor(run, task)
  if (row.actor !== undefined && pane === null) continue
  const actorIdle = pane === null ? false : await deps.liveIdle(pane)
```

The settle double-check lives in `main.ts` (Task 15) and runs concurrently across panes.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/tasks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/tasks.ts test/tasks.test.ts
git commit -m "feat: resolve actor idleness per row from a live pane read"
```

---

### Task 15: Concurrent settle and the tick loop

**Files:**
- Modify: `src/supervisor/main.ts`
- Test: `test/tick.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('settle windows for distinct panes run concurrently, not serially', async () => {
  const settleMs = 200
  const started = Date.now()
  const idle = makeSettledIdleReader(['w1:p1', 'w7:p1', 'w8:p1'], settleMs)
  await Promise.all(['w1:p1', 'w7:p1', 'w8:p1'].map((p) => idle(p)))
  // Serial would be ~600ms. Concurrent is ~200ms. Allow generous slack.
  expect(Date.now() - started).toBeLessThan(settleMs * 2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/tick.test.ts -t concurrent`
Expected: FAIL — `makeSettledIdleReader` is not exported

- [ ] **Step 3: Write minimal implementation**

In `src/supervisor/main.ts`:

```ts
/**
 * One settle window per tick, not one per pane. Six workers at ACTOR_SETTLE_MS
 * serially would not fit inside TICK_MS = 1000. Reads are memoised per tick so
 * a pane consulted by several rows is polled once.
 */
export function makeSettledIdleReader(
  panes: string[], settleMs: number, status: (p: string) => Promise<AgentStatus>,
): (paneId: string) => Promise<boolean> {
  const results = new Map<string, Promise<boolean>>()
  for (const pane of panes) {
    results.set(pane, (async () => {
      if (!isAgentReady(await status(pane))) return false
      await Bun.sleep(settleMs)
      return isAgentReady(await status(pane))
    })())
  }
  return async (paneId: string) => (await results.get(paneId)) ?? false
}
```

Call it once per tick with every pane the run's tasks and orchestrator reference, then pass the reader into `advanceTasks` and `evaluateRun`.

Deliver with the new list form:

```ts
for (const delivery of deliveriesFor(pending)) {
  await sendWithRetry(delivery)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/tick.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/main.ts test/tick.test.ts
git commit -m "feat: one concurrent settle window per tick across all actor panes"
```

---

### Task 16: Stall probes for the actorless rows

**Files:**
- Modify: `src/supervisor/stall.ts`
- Test: `test/stall.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('execute is probed via the orchestrator when intake was never closed', () => {
  const run = fixture('execute')
  run.intake_closed = false
  run.phase_entered_at = Date.now() - 60 * 60_000
  const out = stallCandidates([run], Date.now(), 15, new Set())
  expect(out.map((c) => c.paneId)).toEqual([run.orchestrator_pane])
})

test('a task stranded in blocked-on-files is probed via the orchestrator', () => {
  const run = runWithTask({ phase: 'blocked-on-files', pane_id: null })
  run.tasks[0]!.phase_entered_at = Date.now() - 60 * 60_000
  const out = taskStallCandidates([run], Date.now(), 15, new Set())
  expect(out).toHaveLength(1)
  expect(out[0]?.paneId).toBe(run.orchestrator_pane)
})

test('a worker-owned artifact row is probed via the worker pane', () => {
  const run = runWithTask({ phase: 'spec', pane_id: 'w7:p1' })
  run.tasks[0]!.phase_entered_at = Date.now() - 60 * 60_000
  const out = taskStallCandidates([run], Date.now(), 15, new Set())
  expect(out[0]?.paneId).toBe('w7:p1')
})

test('a worker row with no pane falls back to the orchestrator', () => {
  const run = runWithTask({ phase: 'research', pane_id: null })
  run.tasks[0]!.phase_entered_at = Date.now() - 60 * 60_000
  const out = taskStallCandidates([run], Date.now(), 15, new Set())
  expect(out[0]?.paneId).toBe(run.orchestrator_pane)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/stall.test.ts`
Expected: FAIL — `stallCandidates` gates on `ARTIFACT_RUN_PHASES`, which excluded `execute`; `taskStallCandidates` does not exist

- [ ] **Step 3: Write minimal implementation**

Replace the `ARTIFACT_RUN_PHASES` gate with `row.stallable`, and resolve the probe target:

```ts
function probePaneFor(run: Run, row: PhaseRow<string>, taskPane: string | null): string | null {
  if (row.probeTarget === 'orchestrator') return run.orchestrator_pane
  if (row.actor === 'worker') return taskPane ?? run.orchestrator_pane
  if (row.actor === 'orchestrator') return run.orchestrator_pane
  return run.orchestrator_pane
}
```

`StallCandidate` gains `paneId: string` and `taskId: string | null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/stall.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/stall.ts test/stall.test.ts
git commit -m "feat: probe the actorless rows through the orchestrator pane"
```

**M3 exit gate:** `bun test && bun run typecheck` clean.

---

# Milestone 4 — The decision channel

### Task 17: Decision records

**Files:**
- Create: `src/lib/decisions.ts`
- Test: `test/decide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/decide.test.ts
import { expect, test } from 'bun:test'
import { openDecision, answerDecision, abandonDecisions, openDecisionFor } from '../src/lib/decisions'

test('opening a decision assigns a sequential id and records the phase', () => {
  const task = taskFixture('plan')
  const d = openDecision(task, { question: 'q', recommendation: 'r' })
  expect(d.id).toBe('d1')
  expect(d.from_phase).toBe('plan')
  expect(d.answer).toBeNull()
  expect(openDecisionFor(task)?.id).toBe('d1')
})

test('answering records the answer, who gave it, and when', () => {
  const task = taskFixture('plan')
  const d = openDecision(task, { question: 'q', recommendation: 'r' })
  answerDecision(task, d.id, 'do X', 'human')
  expect(task.decisions[0]?.answer).toBe('do X')
  expect(task.decisions[0]?.answered_by).toBe('human')
  expect(task.decisions[0]?.answered_at).toBeGreaterThan(0)
})

test('abandoning closes open AND undelivered decisions', () => {
  const task = taskFixture('plan')
  const a = openDecision(task, { question: 'open', recommendation: 'r' })
  const b = openDecision(task, { question: 'undelivered', recommendation: 'r' })
  answerDecision(task, b.id, 'answered but never sent', 'orchestrator')
  task.pending_answer = b.id
  abandonDecisions(task)
  expect(task.decisions.map((d) => d.answered_by)).toEqual(['abandoned', 'abandoned'])
  expect(task.pending_answer).toBeNull()
  expect(openDecisionFor(task)).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/decide.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/decisions'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/decisions.ts
import type { Decision, Task, TaskPhase } from './types'

export function openDecisionFor(task: Task): Decision | null {
  return task.decisions.find((d) => d.answer === null && d.answered_by === null) ?? null
}

export function openDecision(
  task: Task, input: { question: string; recommendation: string },
): Decision {
  const decision: Decision = {
    id: `d${task.decisions.length + 1}`,
    asked_at: Date.now(),
    from_phase: task.phase as TaskPhase,
    question: input.question,
    recommendation: input.recommendation,
    answer: null, answered_by: null, answered_at: null,
  }
  task.decisions.push(decision)
  return decision
}

export function answerDecision(
  task: Task, id: string, answer: string, by: 'orchestrator' | 'human',
): Decision {
  const decision = task.decisions.find((d) => d.id === id)
  if (!decision) throw new Error(`no such decision: ${id}`)
  decision.answer = answer
  decision.answered_by = by
  decision.answered_at = Date.now()
  return decision
}

/**
 * A pane death ends every question addressed to it — including one already
 * answered but never delivered, which would otherwise outlive its task in
 * `hpipe status` and keep the stall probe nagging.
 */
export function abandonDecisions(task: Task): void {
  for (const d of task.decisions) {
    if (d.answered_by === 'abandoned') continue
    if (d.answer !== null && task.pending_answer !== d.id) continue
    d.answered_by = 'abandoned'
    d.answered_at = Date.now()
  }
  task.pending_answer = null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/decide.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/decisions.ts test/decide.test.ts
git commit -m "feat: decision record helpers"
```

---

### Task 18: `hpipe decide`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/decide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('decide blocks the task and records where it came from', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(run, { task: 't1', question: 'q', recommendation: 'r' })
  expect(run.tasks[0]?.phase).toBe('blocked-on-decision')
  expect(run.tasks[0]?.decision_from).toBe('plan')
})

test('decide refuses a task that is already blocked', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(run, { task: 't1', question: 'q1', recommendation: 'r' })
  await expect(cmdDecide(run, { task: 't1', question: 'q2', recommendation: 'r' }))
    .rejects.toThrow('d1')
  // decision_from must NOT have been overwritten with blocked-on-decision.
  expect(run.tasks[0]?.decision_from).toBe('plan')
})

test('decide requires a recommendation', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'plan' })
  await expect(cmdDecide(run, { task: 't1', question: 'q', recommendation: '' }))
    .rejects.toThrow('--recommend')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/decide.test.ts -t decide`
Expected: FAIL — `cmdDecide` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
export async function cmdDecide(
  run: Run, args: { task: string; question: string; recommendation: string },
): Promise<void> {
  const task = run.tasks.find((t) => t.task_id === args.task)
  if (!task) throw new Error(`no such task: ${args.task}`)
  if (args.recommendation.trim().length === 0) {
    throw new Error('--recommend is required: surface a recommendation, not a bare question')
  }
  // Guard both the phase and the field. Without this the second call writes
  // decision_from: 'blocked-on-decision' and the answer returns the task to a
  // row with no inferred exit.
  if (task.phase === 'blocked-on-decision') {
    const open = openDecisionFor(task)
    throw new Error(
      `task ${task.task_id} already has an open decision (${open?.id ?? 'unknown'}); ` +
      'a task carries at most one — ask the more consequential question first',
    )
  }
  task.decision_from = task.phase
  openDecision(task, { question: args.question, recommendation: args.recommendation })
  enterTaskPhase(run, task, 'blocked-on-decision', 'worker surfaced a decision')
  await saveRun(run)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/decide.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/decide.test.ts
git commit -m "feat: hpipe decide, one open decision per task"
```

---

### Task 19: `hpipe answer` — write, do not resume

**Files:**
- Modify: `src/cli.ts`
- Test: `test/decide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('answer records the answer but leaves the task blocked', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(run, { task: 't1', question: 'q', recommendation: 'r' })
  await cmdAnswer(run, { task: 't1', decision: 'd1', answer: 'do X', by: 'human' })
  // The reset is the supervisor's, and only after a successful send.
  expect(run.tasks[0]?.phase).toBe('blocked-on-decision')
  expect(run.tasks[0]?.pending_answer).toBe('d1')
  expect(run.tasks[0]?.decisions[0]?.answer).toBe('do X')
})

test('answer refuses a task that is not blocked', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'plan' })
  await expect(cmdAnswer(run, { task: 't1', decision: 'd1', answer: 'x', by: 'human' }))
    .rejects.toThrow('plan')
})

test('answer on a task with a pending answer re-arms delivery', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(run, { task: 't1', question: 'q', recommendation: 'r' })
  await cmdAnswer(run, { task: 't1', decision: 'd1', answer: 'first', by: 'human' })
  run.tasks[0]!.delivery_attempts = 5
  await cmdAnswer(run, { task: 't1', decision: 'd1', answer: 'second', by: 'human' })
  expect(run.tasks[0]?.delivery_attempts).toBe(0)
  expect(run.tasks[0]?.decisions[0]?.answer).toBe('second')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/decide.test.ts -t answer`
Expected: FAIL — `cmdAnswer` is not exported

- [ ] **Step 3: Write minimal implementation**

Add `delivery_attempts: number` to `Task` (default 0), then:

```ts
export async function cmdAnswer(
  run: Run,
  args: { task: string; decision: string; answer: string; by: 'orchestrator' | 'human' },
): Promise<void> {
  const task = run.tasks.find((t) => t.task_id === args.task)
  if (!task) throw new Error(`no such task: ${args.task}`)
  if (task.phase !== 'blocked-on-decision') {
    throw new Error(`task ${task.task_id} is not awaiting a decision (it is in ${task.phase})`)
  }
  answerDecision(task, args.decision, args.answer, args.by)
  task.pending_answer = args.decision
  // Re-arm: this is the documented exit from "answered but undelivered".
  task.delivery_attempts = 0
  await saveRun(run)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/decide.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/lib/types.ts test/decide.test.ts
git commit -m "feat: hpipe answer writes the answer and arms delivery"
```

---

### Task 20: Resume only on a delivered answer

**Files:**
- Modify: `src/supervisor/tasks.ts`
- Test: `test/decide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a delivered answer returns the task and resets phase_entered_at', async () => {
  const run = blockedRunWithAnswer()
  const before = run.tasks[0]!.phase_entered_at
  await deliverPendingAnswers(run, { ...deps, send: async () => ({ ok: true }) })
  expect(run.tasks[0]?.phase).toBe('plan')
  expect(run.tasks[0]?.pending_answer).toBeNull()
  expect(run.tasks[0]!.phase_entered_at).toBeGreaterThan(before)
})

test('a failed send leaves the task blocked and counts the attempt', async () => {
  const run = blockedRunWithAnswer()
  await deliverPendingAnswers(run, {
    ...deps, send: async () => ({ ok: false, code: 'agent_blocked' }),
  })
  expect(run.tasks[0]?.phase).toBe('blocked-on-decision')
  expect(run.tasks[0]?.delivery_attempts).toBe(1)
})

test('an exhausted budget holds the task blocked rather than resuming it', async () => {
  const run = blockedRunWithAnswer()
  run.tasks[0]!.delivery_attempts = 5
  await deliverPendingAnswers(run, {
    ...deps, promptRetryMax: 5, send: async () => ({ ok: false, code: 'agent_blocked' }),
  })
  expect(run.tasks[0]?.phase).toBe('blocked-on-decision')
  expect(run.tasks[0]?.pending_answer).toBe('d1')
})

test('counters are untouched by a decision round trip', async () => {
  const run = blockedRunWithAnswer()
  await deliverPendingAnswers(run, { ...deps, send: async () => ({ ok: true }) })
  expect(run.tasks[0]?.passes).toEqual({})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/decide.test.ts -t delivered`
Expected: FAIL — `deliverPendingAnswers` does not exist

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * The phase reset is a consequence of a successful send, never of the write.
 * v4's transport documents retries across ticks; main.ts does not implement them,
 * so a worker busy for more than PROMPT_RETRY_MAX ticks would have had its phase
 * reset, its delivery abandoned, and would then have completed the phase with the
 * answer unread — with run.history asserting the decision was applied.
 */
export async function deliverPendingAnswers(run: Run, deps: AnswerDeps): Promise<void> {
  for (const task of run.tasks) {
    if (task.phase !== 'blocked-on-decision' || task.pending_answer === null) continue
    if (task.pane_id === null) continue
    if (task.delivery_attempts >= deps.promptRetryMax) continue

    const decision = task.decisions.find((d) => d.id === task.pending_answer)
    if (!decision) continue

    const text = await renderPrompt(deps.pluginRoot, 'answer', {
      question: decision.question,
      answer: decision.answer ?? '',
      answered_by: decision.answered_by ?? 'orchestrator',
      phase: task.decision_from ?? '',
    })

    const result = await deps.send(task.pane_id, text)
    if (!result.ok) { task.delivery_attempts += 1; continue }

    task.pending_answer = null
    task.delivery_attempts = 0
    enterTaskPhase(run, task, task.decision_from as TaskPhase, `decision ${decision.id} answered`)
    task.decision_from = null
  }
}
```

`enterTaskPhase` already sets `phase_entered_at = Date.now()`, which is the reset the spec requires.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/decide.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/tasks.ts test/decide.test.ts
git commit -m "feat: resume a blocked task only once its answer is delivered"
```

---

### Task 21: A pane death abandons its decisions

**Files:**
- Modify: `src/supervisor/tick.ts`
- Test: `test/tick.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a pane exit while blocked fails the task and abandons its decisions', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'blocked-on-decision', pane_id: 'w7:p1' })
  run.tasks[0]!.decisions = [openDecisionFixture()]
  await applyEvents([run], [{ kind: 'pane.exited', pane_id: 'w7:p1', session: 's', at: Date.now() }])
  expect(run.tasks[0]?.phase).toBe('failed')
  expect(run.tasks[0]?.decisions[0]?.answered_by).toBe('abandoned')
})

test('worktree.created records the checkout path and adoption time', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'queued', branch: 'feat/x', workspace_id: null })
  await applyEvents([run], [{
    kind: 'worktree.created', session: 's', at: Date.now(),
    branch: 'feat/x', workspace_id: 'w7', checkout_path: '/r/.worktrees/feat-x',
  }])
  expect(run.tasks[0]?.checkout_path).toBe('/r/.worktrees/feat-x')
  expect(run.tasks[0]?.adopted_at).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/tick.test.ts -t abandon`
Expected: FAIL — decisions survive; `checkout_path` stays null

- [ ] **Step 3: Write minimal implementation**

In `applyEvents`, before writing `failed`:

```ts
  if (task.phase === 'blocked-on-decision') abandonDecisions(task)
  enterTaskPhase(run, task, 'failed', 'pane exited')
```

and in the `worktree.created` branch, alongside `workspace_id`:

```ts
  task.checkout_path = event.checkout_path ?? null
  task.adopted_at = Date.now()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/tick.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/tick.ts test/tick.test.ts
git commit -m "fix: abandon decisions on pane death and record the checkout path"
```

---

### Task 22: Artifact paths resolve against the worktree

**Files:**
- Modify: `src/supervisor/deliver.ts`
- Test: `test/deliver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a task artifact path resolves against the worktree, not repo_root', () => {
  const run = runWithTask({ phase: 'spec', checkout_path: '/r/.worktrees/feat-x' })
  run.repo_root = '/r'
  run.tasks[0]!.artifacts.spec = 'docs/superpowers/specs/2026-09-15-issue-210-design.md'
  expect(absoluteArtifactPath(run, run.tasks[0]!))
    .toBe('/r/.worktrees/feat-x/docs/superpowers/specs/2026-09-15-issue-210-design.md')
})

test('a run artifact path resolves against repo_root', () => {
  const run = fixture('branch-review')
  run.repo_root = '/r'
  expect(absoluteArtifactPath(run, null)).toStartWith('/r/docs/superpowers/reviews/')
})

test('a verdict row reads the verdict slot keyed by phase and counter', () => {
  const run = runWithTask({ phase: 'spec-review', checkout_path: '/w' })
  run.tasks[0]!.passes = { 'spec-review': 1 }
  expect(absoluteArtifactPath(run, run.tasks[0]!)).toContain('spec-review-1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/deliver.test.ts -t worktree`
Expected: FAIL — `artifactPathFor` assumes every task artifact is a verdict and joins against `repo_root`

- [ ] **Step 3: Write minimal implementation**

```ts
export function artifactPathFor(run: Run, task: Task | null): string | null {
  if (task) {
    const row = taskRow(task.phase)
    if (row.artifact) return task.artifacts[row.artifact]
    const key = `${task.phase}-${counterFor(task, task.phase)}`
    return task.artifacts.verdicts[key]
      ?? join('docs/superpowers/reviews', `issue-${task.issue}-${key}.md`)
  }
  const key = `${run.phase}-${counterFor(run, run.phase)}`
  return run.artifacts.verdicts[key]
    ?? join('docs/superpowers/reviews', `${run.run_id}-${key}.md`)
}

/** Task artifacts live in the worker's linked worktree; run artifacts in the main checkout. */
export function absoluteArtifactPath(run: Run, task: Task | null): string | null {
  const rel = artifactPathFor(run, task)
  if (rel === null) return null
  const base = task?.checkout_path ?? run.repo_root
  return join(base, rel)
}
```

Add `artifacts: { research, spec, plan, verdicts }` to `Task` in `types.ts`, seeded by `cmdTask`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/deliver.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/deliver.ts src/lib/types.ts src/cli.ts test/deliver.test.ts
git commit -m "feat: resolve task artifacts against the worker worktree"
```

**M4 exit gate:** `bun test && bun run typecheck` clean.

---

# Milestone 5 — Prompts, intake, migration

### Task 23: `hpipe task` drops `--text`, gains `--notes`

**Files:**
- Modify: `src/cli.ts`, `src/lib/worker-prompt.ts`
- Test: `test/cli-commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('task registration requires an issue and seeds artifact paths', async () => {
  const run = freshRun()
  await cmdTask(run, {
    branch: 'feat/x', issue: 210, surface: 'core', dependsOn: [], files: [], notes: 'land first',
  })
  const task = run.tasks[0]!
  expect(task.issue).toBe(210)
  expect(task.notes).toBe('land first')
  expect(task.artifacts.spec).toContain('issue-210')
  expect(task.registered_at).toBeGreaterThan(0)
  expect(task.phase).toBe('queued')
})

test('registering a task reopens intake', async () => {
  const run = freshRun()
  run.intake_closed = true
  await cmdTask(run, { branch: 'feat/x', issue: 1, surface: 'core', dependsOn: [], files: [], notes: '' })
  expect(run.intake_closed).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli-commands.test.ts -t registration`
Expected: FAIL — `cmdTask` still requires `text`

- [ ] **Step 3: Write minimal implementation**

Drop `text` from `cmdTask`'s args and from `Task`. Seed artifacts:

```ts
  const date = new Date().toISOString().slice(0, 10)
  const stem = `${date}-issue-${issue}`
  task.artifacts = {
    research: join('docs/superpowers/research', `${stem}-research.md`),
    spec: join('docs/superpowers/specs', `${stem}-design.md`),
    plan: join('docs/superpowers/plans', `${stem}-plan.md`),
    verdicts: {},
  }
  task.registered_at = Date.now()
  run.intake_closed = false
```

In `worker-prompt.ts`, render `worker-brief` instead of `task`, drop `task_text`, add `notes` and the three artifact paths.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli-commands.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/lib/worker-prompt.ts test/cli-commands.test.ts
git commit -m "feat: the issue body is the brief; hpipe task takes notes, not text"
```

---

### Task 24: The prompt set

Replaces the Task 3 stubs with real text. No tests beyond `table.test.ts` and `prompts.test.ts`, which already assert every placeholder resolves.

**Files:**
- Modify: every file in `prompts/`
- Delete: `prompts/task.md`, `prompts/task-review-spec.md`, `prompts/task-review-quality.md`

- [ ] **Step 1: Write `prompts/worker-brief.md`**

Must carry: `gh issue view #{{issue}}` as the brief, the surface agent file, `{{notes}}`, the three artifact paths, the loop, the `hpipe decide` contract, the re-read instruction on entering `implement`, the `Closes #{{issue}}` rule, TDD, and conventional commits. It must **not** contain `{{task_text}}`.

- [ ] **Step 2: Write the four worker review prompts**

`spec-review.md`, `plan-review.md`, `pr-review-intent.md`, `pr-review-quality.md`. Each one must contain, verbatim enough for `table.test.ts` to grep:

> Dispatch the reviewer as a subagent and **wait for it within this turn**. Do not end your turn until the verdict file exists at the path named above with a `VERDICT:` trailer as its last non-empty line.

> Commit and push the verdict file before ending your turn.

- [ ] **Step 3: Write `decision.md` and `answer.md`**

`decision.md` (to the orchestrator): the question, the worker's recommendation, and the instruction to answer from the issue / `CLAUDE.md` / an existing call site where the answer is already determined, and otherwise to put it to the human **with a named recommendation of its own**. Names the exact `hpipe answer --task <id> --decision <id> --answer "…" --by orchestrator|human` line.

`answer.md` (to the worker): the question, the answer, who decided, and "resume {{phase}} applying this".

- [ ] **Step 4: Write `intake.md`** — research the report or take the user's, open one issue per task with `gh issue create`, register with `hpipe task`, and **call `hpipe dispatch --done` when the batch is complete**.

- [ ] **Step 5: Revise `prompts/dispatch.md`** — drop plan decomposition, keep `worktree create` + `agent start`, and add the `hpipe dispatch --done` line so every registration path also carries the closing path.

- [ ] **Step 6: Add the prompt-content invariant to `test/table.test.ts`**

The spec requires this in three places and no task ever writes it. Add to `table.test.ts`:

```ts
const WORKER_REVIEW_PROMPTS = ['spec-review', 'plan-review', 'pr-review-intent', 'pr-review-quality']

test('every worker review prompt demands an awaited subagent and a pushed verdict', async () => {
  for (const name of WORKER_REVIEW_PROMPTS) {
    const text = await Bun.file(join(import.meta.dir, '..', 'prompts', `${name}.md`)).text()
    expect(text, `${name}.md must require the subagent be awaited`).toContain('wait for it within this turn')
    expect(text, `${name}.md must require the verdict be pushed`).toContain('Commit and push the verdict')
  }
})

test('branch-review carries neither worker instruction — it is orchestrator-owned', async () => {
  const text = await Bun.file(join(import.meta.dir, '..', 'prompts', 'branch-review.md')).text()
  expect(text).not.toContain('wait for it within this turn')
  expect(text).not.toContain('Commit and push the verdict')
})
```

Name the four files explicitly. A glob of `prompts/*-review*.md` also catches `branch-review.md`,
which must carry neither.

- [ ] **Step 7: Update `test/prompts.test.ts` to match the new prompt set**

This file keeps its own two lists, independent of the phase table, and Task 3 only extended `ALL` with the placeholders. Now that the real set is landing:

- `REVIEW_PROMPTS`: drop `task-review-spec` and `task-review-quality`; add `pr-review-intent` and `pr-review-quality`. This is what forces the four worker review prompts to carry `VERDICT: CLEAR`, `VERDICT: BLOCKER`, `last non-empty line` and `{{verdict_path}}`.
- `ALL`: drop `task` (replaced by `worker-brief`); add `worker-brief`.
- The test named "the task prompt routes to the surface agent and demands a closing keyword" reads `prompts/task.md`. Point it at `worker-brief.md` and add an assertion that the file does **not** contain `{{task_text}}`.

- [ ] **Step 8: Run the prompt tests**

Run: `bun test test/prompts.test.ts test/table.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add prompts/ test/prompts.test.ts
git commit -m "feat: the worker-owned prompt set"
```

---

### Task 25: `hpipe dispatch --done`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli-commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('dispatch --done closes intake', async () => {
  const run = freshRun()
  await cmdDispatchDone(run)
  expect(run.intake_closed).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli-commands.test.ts -t "closes intake"`
Expected: FAIL — `cmdDispatchDone` is not exported

- [ ] **Step 3: Write minimal implementation**

```ts
export async function cmdDispatchDone(run: Run): Promise<void> {
  run.intake_closed = true
  await saveRun(run)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli-commands.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-commands.test.ts
git commit -m "feat: hpipe dispatch --done closes intake explicitly"
```

---

### Task 26: `hpipe rewind` clears counters, pending answers, and `adopted_at`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli-commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('rewind clears the whole counter map rather than spending a pass', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'escalated' })
  run.tasks[0]!.passes = { 'spec-review': 2, ci: 1 }
  await cmdRewind(run, { phase: 'spec', task: 't1' })
  expect(run.tasks[0]?.passes).toEqual({})
})

test('rewind clears a pending answer and records the discard', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'blocked-on-decision' })
  run.tasks[0]!.pending_answer = 'd1'
  await cmdRewind(run, { phase: 'plan', task: 't1' })
  expect(run.tasks[0]?.pending_answer).toBeNull()
  expect(run.history.some((h) => h.why.includes('answer discarded undelivered'))).toBe(true)
})

test('rewind to dispatch clears adopted_at on bound tasks so the row can re-fire', async () => {
  const run = runWithTask({ task_id: 't1', phase: 'implement', workspace_id: 'w7' })
  run.tasks[0]!.adopted_at = 1000
  await cmdRewind(run, { phase: 'dispatch' })
  expect(run.tasks[0]?.adopted_at).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli-commands.test.ts -t rewind`
Expected: FAIL — `cmdRewind` sets `pass = 1`

- [ ] **Step 3: Write minimal implementation**

```ts
  if (task) {
    if (task.pending_answer !== null) {
      run.history.push({
        at: Date.now(), task_id: task.task_id, from: task.phase, to: args.phase,
        why: 'answer discarded undelivered',
      })
      task.pending_answer = null
    }
    task.passes = {}
    task.delivery_attempts = 0
    enterTaskPhase(run, task, args.phase as TaskPhase, 'rewound by hand')
  } else {
    run.passes = {}
    // applyEvents only binds a worktree when workspace_id is null, so adopted_at
    // is write-once. Without clearing it, `dispatch` can never re-fire and the
    // rewind is a one-way door.
    if (args.phase === 'dispatch') {
      for (const t of run.tasks) if (t.workspace_id !== null) t.adopted_at = null
    }
    enterRunPhase(run, args.phase as RunPhase, 'rewound by hand')
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli-commands.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-commands.test.ts
git commit -m "feat: rewind clears counters, pending answers and adoption"
```

---

### Task 27: `hpipe status` surfaces the new states

**Files:**
- Modify: `src/lib/status.ts`
- Test: `test/status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('status lists an open decision with its age and question', () => {
  const run = runWithTask({ task_id: 't1', phase: 'blocked-on-decision' })
  run.tasks[0]!.decisions = [{ ...openDecisionFixture(), question: 'which cache?' }]
  expect(renderStatus([run])).toContain('which cache?')
})

test('status names an answered-but-undelivered decision', () => {
  const run = runWithTask({ task_id: 't1', phase: 'blocked-on-decision' })
  run.tasks[0]!.pending_answer = 'd1'
  run.tasks[0]!.delivery_attempts = 5
  expect(renderStatus([run])).toContain('answered but undelivered')
})

test('status names who holds the files a blocked task is waiting on', () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'failed', files: ['a/'] },
    { task_id: 't2', phase: 'blocked-on-files', files: ['a/'] },
  ])
  expect(renderStatus([run])).toContain('t2 blocked on files held by t1 (failed)')
})

test('status flags a run whose intake was never closed', () => {
  const run = fixture('execute')
  run.intake_closed = false
  run.tasks = [taskFixture('done')]
  expect(renderStatus([run])).toContain('hpipe dispatch --done')
})

test('status refuses to advance a run from an older schema', () => {
  const run = fixture('execute')
  ;(run as { schema_version?: number }).schema_version = undefined
  expect(renderStatus([run])).toContain('hpipe abort')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/status.test.ts`
Expected: FAIL on all five

- [ ] **Step 3: Write the implementation**

Add the five lines to `renderStatus`. The schema line reads exactly:

```
run <id> was started by an earlier plugin version and cannot be advanced — hpipe abort <id> to release the repo.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/status.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/status.ts test/status.test.ts
git commit -m "feat: status surfaces decisions, file blocks and open intake"
```

---

### Task 28: The supervisor skips pre-v2 runs

**Files:**
- Modify: `src/supervisor/main.ts`
- Test: `test/tick.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a run without schema_version 2 is never advanced', async () => {
  const stale = fixture('intake')
  ;(stale as { schema_version?: number }).schema_version = undefined
  const before = stale.phase
  await runTick([stale], deps)
  expect(stale.phase).toBe(before)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/tick.test.ts -t schema`
Expected: FAIL — the run advances

- [ ] **Step 3: Write minimal implementation**

In the tick's run loop, beside the existing session filter:

```ts
    // No in-place migration: a v4 run mid-`plan` has an orchestrator holding work
    // no worker can inherit. `hpipe status` tells the human to abort it.
    if (run.schema_version !== 2) continue
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/tick.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/main.ts test/tick.test.ts
git commit -m "feat: refuse to advance runs from an earlier plugin version"
```

---

### Task 29: Full gate and the live smoke run

Unit tests were not sufficient last time: the first live run of v4 surfaced two startup/gating defects that dependency-injected fakes had passed. That is recorded in this repo's own memory. Do not skip this task.

**Files:**
- Modify: `test/integration/smoke.md`

- [ ] **Step 1: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: green, 0 fail

- [ ] **Step 2: Confirm no old phase or field names survive**

```bash
grep -rn "task-review-spec\|task-review-quality\|task_text\|\.pass\b\|HOLDS_FILES\|ARTIFACT_RUN_PHASES\|nextDelivery" src/ prompts/
```
Expected: no output

- [ ] **Step 3: Rewrite `test/integration/smoke.md` for the new pipeline**

The runbook must cover, in one real herdr session:
1. `hpipe start`, orchestrator files two issues, registers both with overlapping `--files`, `hpipe dispatch --done`.
2. **Two concurrent workers** reaching `spec` at the same time — proves per-pane delivery, which no unit test can.
3. **One `blocked-on-files` collision** — proves only one task leaves the group per tick.
4. **One surfaced decision** answered by the orchestrator without the human, and one escalated to the human.
5. **The subagent question:** while a worker's review subagent runs, record `herdr agent get <worker pane>` every 5s and note whether the pane ever reads `idle` before the verdict file exists. This is the one assumption two adversarial rounds could not settle statically. Write the finding into the runbook.

- [ ] **Step 4: Execute the runbook against a real herdr session**

Record actual output for each step. Any step whose observed behaviour differs from the spec is a finding, not a test failure to paper over — bring it back before merging.

- [ ] **Step 5: Commit**

```bash
git add test/integration/smoke.md
git commit -m "docs: live smoke runbook for the worker-owned pipeline"
```

**M5 exit gate:** full suite green, the grep in Step 2 is empty, and the live run is executed with its findings recorded.

---

## Open items deliberately left to the live run

| Item | Why it is not resolved here |
| --- | --- |
| Whether a Claude Code review subagent perturbs its worker pane's `agent_status` | Both adversarial rounds tried and failed to settle it statically. herdr's detection manifest carries a dedicated `background_agents_working` rule, which is evidence a backgrounded subagent is handled specially, but the claude integration on this machine is v7 and reports no state, so status is entirely screen-scraped. The prompt-level await is the mitigation; the verdict-file predicate is the independent guard. Measure it in Task 29 Step 3.5. |
| Whether `ACTOR_SETTLE_MS` fits inside `TICK_MS` with six workers | Settles run concurrently (Task 15), so the arithmetic should hold, but it is measured, not proved. `hpipe status` reports tick overrun. |
| Whether re-planning after `blocked-on-files` is needed | The spec chose a re-read instruction over a full re-plan cycle. If live runs show plans going stale against a sibling's landed change, revisit. |
