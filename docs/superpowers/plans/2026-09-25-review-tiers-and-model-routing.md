# Review Tiers and Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every task a `light`/`standard`/`heavy` review tier that decides which review phases it runs, skip `branch-review` when at most one task landed, and move `implement`'s code-writing onto a Sonnet subagent while every judgment stays on the inherited Opus.
**Architecture:** One pure resolver, `nextPhase(tier, row)` in `src/lib/phases.ts`, replaces every forward read of `onClear` past `research`; a new combined `pr-review` row sits between `implement` and the heavy tier's two PR stages. Every tier-dependent prompt string is computed in TypeScript by `tierPromptVars(task)` (`src/lib/tier-prompt.ts`) and spread into every task render site, because `render()` has no conditionals and throws on an unresolved token. The tier is set at `hpipe task` (flag, overridden by a `pipeline:tier-*` label), changed by a new `hpipe tier`, logged in `task.tier_history` only, and shown by `hpipe status` / `hpipe show`.
**Tech Stack:** Bun + TypeScript (no runtime dependencies), `bun test`, `tsc --noEmit` via `bun run typecheck`, `gh` and `herdr` CLIs, Markdown prompt templates rendered by `src/lib/render.ts`.
---

Implements `docs/superpowers/specs/2026-09-25-review-tiers-and-model-routing-design.md` (pass 3, after
`docs/superpowers/reviews/2026-09-25-review-tiers-design-adversarial-1.md` and `…-adversarial-2.md`).
Read the spec first; this plan does not re-argue it.

**On-disk format change.** Task 2 adds a `TaskPhase` (`pr-review`) and Task 1 adds two optional
`Task` fields. `schema_version` stays `2`: every new field is optional and an absent `tier` reads as
`heavy`, so ledgers written before this change keep today's behaviour. A ledger holding a task in
`pr-review` cannot be read by any earlier build (`taskRow` throws), which is why Task 18 documents
"restart the supervisor after upgrading" and why Task 19's live run restarts it first.

**Self-hosting hazard.** Never link `src/cli.ts` onto your PATH and never run the checkout's
`src/cli.ts` against live state. Every test below runs against temp dirs; the argv tests pin
`HERDR_PLUGIN_STATE_DIR` and `HERDR_SESSION` exactly as `test/cli-argv.test.ts` already does.

**Every step:** run the named test file, then before each commit the whole suite and the typecheck:

```bash
bun test && bun run typecheck
```

Both must be green before every commit. **Line numbers** in each task's **Files** list are as of
`f82881f`, before any task runs; once an earlier task has edited a file, find the spot by the quoted
anchor text instead. Never commit to `main`; work on a feature branch
(`feat/review-tiers`). PR title (squash-merged, parsed by release-please): `feat: review tiers and model routing`.

FILES: src/lib/phases.ts, src/lib/types.ts, src/lib/machine.ts, src/lib/gh.ts, src/lib/tiers.ts
FILES: src/lib/models.ts, src/lib/tier-prompt.ts, src/lib/worker-prompt.ts, src/lib/status.ts
FILES: src/supervisor/tasks.ts, src/supervisor/tick.ts, src/supervisor/deliver.ts, src/cli.ts
FILES: prompts/
FILES: test/phases.test.ts, test/ledger.test.ts, test/table.test.ts, test/prompts.test.ts
FILES: test/machine-task.test.ts, test/machine-run.test.ts, test/tick.test.ts, test/deliver.test.ts
FILES: test/gh.test.ts, test/tiers.test.ts, test/tier-prompt.test.ts, test/cli-commands.test.ts
FILES: test/cli-argv.test.ts, test/status.test.ts
FILES: README.md, skills/herdr-pipeline/SKILL.md

## Spec deviations

None changes behaviour. Four placement or scope adjustments, each forced by the code:

1. **`Tier` is declared in `src/lib/phases.ts`, not `src/lib/types.ts`,** and re-exported from
   `types.ts` the way `RunPhase`/`TaskPhase` already are (`src/lib/types.ts:1,7`). Evidence:
   `nextPhase(tier: Tier, …)` and `PhaseRow.tiers` live in `phases.ts`, and `phases.ts` deliberately
   imports nothing from `types.ts` — `src/lib/phases.ts:33-38` ("to keep this module free of a
   types.ts import, which would cycle"), while `types.ts:1` imports from `phases.ts`. `TierChange`
   stays in `types.ts` as the spec says. `tierOf`, `TIERS` and `isTier` sit beside `Tier` in
   `phases.ts`; `tierOf` takes `{ tier?: Tier }` structurally, as `stallWhen` does
   (`src/lib/phases.ts:39`).
2. **`prompts/dispatch.md` also gains the `tier:` header line and `--tier`,** which the spec's prompt
   list omits. Evidence: `test/prompts.test.ts:279-287` asserts `dispatch.md` names every header line
   a dispatching `hpipe task` prints, and the spec (§2) adds a `tier:` header line. Leaving
   `dispatch.md` alone would make the orchestrator's own header description false.
3. **The unreadable-labels `tier:` line without `--tier`** is `tier: standard (default; labels
   unreadable: <reason>)`. The spec shows only the `--tier` form; this is the same rule applied to
   the default. `<reason>` is the first line of gh's error, so the header stays one line.
4. **`workerStillNeeded`'s switch to `nextPhase` (spec §1) is not observable** with today's table:
   every tier's route from any worker row still reaches a worker row. Task 4 makes the change and
   pins the current answers per tier with a characterisation test rather than a failing one.

Existing tests that change because the spec changes what they pin: the status task-line strings
(`test/status.test.ts:263-264,606`, tier bit), the `hpipe task` header order
(`test/cli-commands.test.ts:1043-1048,1090-1091`, `tier:` line), and the two single-landed-task
`execute` tests (`test/deliver.test.ts:248-272`, branch-review skip). Each is rewritten in the task
that causes it.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/phases.ts` | Modify | `Tier`, `TIERS`, `isTier`, `tierOf`; `PhaseRow.tiers`; `pr-review` in `TaskPhase` and `TASK_ROWS`; `implement.onClear`; `nextPhase` |
| `src/lib/types.ts` | Modify | Re-export `Tier`; `TierChange`; optional `Task.tier` / `Task.tier_history` |
| `src/lib/machine.ts` | Modify | Forward routing through `nextPhase`; `pr-review` review case; `RunSignals.landedTaskCount`; `execute` skip |
| `src/supervisor/tasks.ts` | Modify | `pr-review` in `renderTaskPhasePrompt` and `gatherSignals`; `tierPromptVars` spread into `common` and `announceDecisions` |
| `src/supervisor/tick.ts` | Modify | `workerStillNeeded` walks `nextPhase` |
| `src/supervisor/deliver.ts` | Modify | `landedTaskCount` in `taskSignalsFor`; `task_tiers` in `renderRunPhasePrompt` |
| `src/lib/gh.ts` | Modify | `Gh.issueLabels` |
| `src/lib/tiers.ts` | Create | `registrationTier`, `isLowering`, `pipelinePanes`, `TIER_LABEL_PREFIX` |
| `src/lib/models.ts` | Create | `IMPLEMENT_MODEL` |
| `src/lib/tier-prompt.ts` | Create | `tierPromptVars`, `phaseLoop`, `taskTiers` |
| `src/lib/worker-prompt.ts` | Modify | Spread `tierPromptVars` (takes over `agent_file`) |
| `src/lib/status.ts` | Modify | Tier bit on the task line; `visitedPhases`; `tier`/`tier log`/`visited` in `formatTaskDetail` |
| `src/cli.ts` | Modify | `hpipe task --tier` + label read; `hpipe tier`; rewind warning; usage |
| `prompts/pr-review.md` | Create | The combined PR review |
| `prompts/implement.md`, `prompts/ci-red.md` | Modify | Delegation to the Sonnet subagent; shared implementer's brief |
| `prompts/answer.md` | Modify | Resuming `implement` keeps delegating |
| `prompts/worker-brief.md` | Modify | `{{phase_loop}}`, tier line, tier-neutral wait paragraph |
| `prompts/merge.md` | Modify | `{{review_count}}` |
| `prompts/research.md`, `prompts/decision.md` | Modify | Raise hint |
| `prompts/intake.md`, `prompts/dispatch.md` | Modify | `--tier`, tier guidance, `tier:` header |
| `prompts/spec-review.md`, `prompts/plan-review.md`, `prompts/pr-review-intent.md`, `prompts/pr-review-quality.md`, `prompts/branch-review.md` | Modify | `Tier:` / `Tiers:` line; `{{plan_review_note}}` in `pr-review-intent` |
| `README.md`, `skills/herdr-pipeline/SKILL.md` | Modify | Tiers, labels, `hpipe tier`, model split, Opus default, restart after upgrade |
| `test/tiers.test.ts`, `test/tier-prompt.test.ts` | Create | Unit tests for the two new lib modules |
| `test/phases.test.ts`, `test/table.test.ts`, `test/machine-task.test.ts`, `test/machine-run.test.ts`, `test/tick.test.ts`, `test/deliver.test.ts`, `test/gh.test.ts`, `test/ledger.test.ts`, `test/status.test.ts`, `test/cli-commands.test.ts`, `test/cli-argv.test.ts`, `test/prompts.test.ts` | Modify | As each task states |

---

### Task 1: The `Tier` type, `TierChange`, and `tierOf`

**Files:**
- Modify: `src/lib/phases.ts:6-8` (add after the `Signal` type)
- Modify: `src/lib/types.ts:1`, `:7`, `:198-204` (inside `Task`, before `notes`), `:240-246` (after `HistoryEntry`)
- Test: `test/phases.test.ts:2` and end of file; `test/ledger.test.ts:5-8` and end of file

- [ ] **Step 1: Write the failing tests**

In `test/phases.test.ts`, replace line 2 with:

```ts
import { isTier, RUN_ROWS, runRow, TASK_ROWS, taskRow, TIERS, tierOf } from '../src/lib/phases'
```

Append to `test/phases.test.ts`:

```ts
test('the tiers are ordered lightest first', () => {
  expect(TIERS).toEqual(['light', 'standard', 'heavy'])
})

test('isTier accepts exactly the three tiers', () => {
  for (const tier of TIERS) expect(isTier(tier)).toBe(true)
  for (const other of ['', 'huge', 'Light', 'pipeline:tier-light']) expect(isTier(other)).toBe(false)
})

test('a task with no recorded tier reads as heavy, which is every review it ran before tiers', () => {
  expect(tierOf({})).toBe('heavy')
  expect(tierOf({ tier: 'light' })).toBe('light')
})
```

In `test/ledger.test.ts`, add below the existing `../src/lib/ledger` import:

```ts
import { tierOf } from '../src/lib/phases'
```

Append to `test/ledger.test.ts`:

```ts
test('a task saved without a tier loads without one, and reading its tier writes nothing back', async () => {
  const runId = await seedRun({ taskIds: ['t1'] })
  const loaded = (await loadRun(dir, 'personal', runId))!
  expect(tierOf(loaded.tasks[0]!)).toBe('heavy')

  await saveRun(dir, loaded)
  const raw = await Bun.file(join(dir, 'runs', 'personal', `${runId}.json`)).text()
  expect(raw).not.toContain('"tier"')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/phases.test.ts test/ledger.test.ts`
Expected: FAIL — `SyntaxError: Export named 'isTier' not found in module '…/src/lib/phases.ts'` (and the same for `tierOf` in `ledger.test.ts`).

- [ ] **Step 3: Minimal implementation**

In `src/lib/phases.ts`, insert after the `Signal` type (after line 8):

```ts
/** Ordered lightest first: `isLowering` reads the order. */
export type Tier = 'light' | 'standard' | 'heavy'

export const TIERS: readonly Tier[] = ['light', 'standard', 'heavy']

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value)
}

/**
 * Structural, like `stallWhen`, to keep this module free of a types.ts import. A
 * task from a ledger written before tiers existed ran every review, and keeps
 * doing so across an upgrade; the default is never written back.
 */
export function tierOf(task: { tier?: Tier }): Tier {
  return task.tier ?? 'heavy'
}
```

In `src/lib/types.ts`, replace line 1 with:

```ts
import type { RunPhase, TaskPhase, Tier } from './phases'
```

and line 7 with:

```ts
export type { RunPhase, TaskPhase, Tier } from './phases'
```

In the `Task` interface, insert immediately before `  notes: string` (line 204):

```ts
  /** Read it through `tierOf`. Optional: ledgers written before tiers lack it, and read as `heavy`. */
  tier?: Tier
  /** Every tier this task has had, registration first. */
  tier_history?: TierChange[]
```

After the `HistoryEntry` interface (after line 246), add:

```ts
/**
 * Kept out of `run.history` on purpose: `enteredByRewind` reads a task's last
 * history entry to tell a rewound task from one never dispatched, and a tier
 * entry landing after a rewind would hide the rewind.
 */
export interface TierChange {
  at: number
  /** Null on the registration entry. */
  from: Tier | null
  to: Tier
  source: 'label' | 'flag' | 'default' | 'hpipe-tier'
  /** The caller's HERDR_PANE_ID; null when it was unset. */
  pane: string | null
  /** On a registration entry, the reason `hpipe task` printed on its `tier:` line. */
  why: string
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/phases.test.ts test/ledger.test.ts && bun run typecheck`
Expected: PASS, `0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/phases.ts src/lib/types.ts test/phases.test.ts test/ledger.test.ts
git commit -m "feat(tiers): add the Tier type and tierOf, reading an untiered task as heavy"
```

---

### Task 2: The phase table — `tiers`, the `pr-review` row, `nextPhase`

**Files:**
- Modify: `src/lib/phases.ts:10-45` (`PhaseRow`), `:83-87` (`TaskPhase`), `:101-116` (rows), after `taskRow` (`:156-160`)
- Create: `prompts/pr-review.md`
- Test: `test/phases.test.ts:2,20-57` and end; `test/table.test.ts:4,58` and end; `test/prompts.test.ts:9-11` and end

- [ ] **Step 1: Write the failing tests**

In `test/phases.test.ts`, replace line 2 with:

```ts
import {
  isTier, nextPhase, RUN_ROWS, runRow, TASK_ROWS, taskRow, TIERS, tierOf, type Tier,
} from '../src/lib/phases'
import type { TaskPhase } from '../src/lib/types'
```

Replace the three tests at lines 20-32 and 49-57 with:

```ts
test('every task phase has exactly one row', () => {
  const seen = new Set(TASK_ROWS.map((r) => r.phase))
  expect(seen.size).toBe(TASK_ROWS.length)
  expect(TASK_ROWS.length).toBe(21)
})

test('the nine worker-owned rows are exactly the design loop', () => {
  const worker = TASK_ROWS.filter((r) => r.actor === 'worker').map((r) => r.phase).sort()
  expect(worker).toEqual([
    'implement', 'plan', 'plan-review', 'pr-review', 'pr-review-intent',
    'pr-review-quality', 'research', 'spec', 'spec-review',
  ])
})
```

```ts
test('the stallable set covers the last mile — #19', () => {
  expect(TASK_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort()).toEqual([
    'blocked-on-decision', 'blocked-on-files', 'ci', 'close', 'escalated', 'implement',
    'merge', 'plan', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality',
    'research', 'spec', 'spec-review', 'teardown',
  ])
  expect(RUN_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort())
    .toEqual(['branch-review', 'dispatch', 'execute'])
})
```

Append to `test/phases.test.ts`:

```ts
test('pr-review sits between implement and the heavy tier\'s two PR reviews', () => {
  const phases = TASK_ROWS.map((r) => r.phase)
  expect(phases.indexOf('pr-review')).toBe(phases.indexOf('implement') + 1)
  expect(taskRow('implement').onClear).toBe('pr-review')
  expect(taskRow('pr-review')).toMatchObject({
    actor: 'worker', signal: 'verdict', onClear: 'pr-review-intent', onBlocker: 'implement',
    counter: 'pr-review', prompt: 'pr-review', stallable: true, holdsFiles: true,
    tiers: ['light', 'standard'],
  })
})

test('only the skippable reviews carry tiers', () => {
  const tiered = Object.fromEntries(
    TASK_ROWS.filter((r) => r.tiers !== undefined).map((r) => [r.phase, r.tiers]),
  )
  expect(tiered).toEqual({
    'plan-review': ['standard', 'heavy'],
    'pr-review': ['light', 'standard'],
    'pr-review-intent': ['heavy'],
    'pr-review-quality': ['heavy'],
  })
})

const TIERED_EXITS: Partial<Record<TaskPhase, Record<Tier, TaskPhase>>> = {
  'plan': { light: 'blocked-on-files', standard: 'plan-review', heavy: 'plan-review' },
  'implement': { light: 'pr-review', standard: 'pr-review', heavy: 'pr-review-intent' },
  'pr-review': { light: 'ci', standard: 'ci', heavy: 'pr-review-intent' },
  'pr-review-intent': { light: 'ci', standard: 'ci', heavy: 'pr-review-quality' },
}

test('nextPhase follows onClear past every row the tier skips, for every tier and row', () => {
  for (const row of TASK_ROWS) {
    for (const tier of TIERS) {
      if (row.onClear === undefined) {
        expect(() => nextPhase(tier, row), `${tier} from ${row.phase}`).toThrow()
        continue
      }
      const expected = TIERED_EXITS[row.phase]?.[tier] ?? row.onClear
      expect(nextPhase(tier, row), `${tier} from ${row.phase}`).toBe(expected)
    }
  }
})

function routeFromQueued(tier: Tier): TaskPhase[] {
  const route: TaskPhase[] = ['queued']
  while (route.at(-1) !== 'ci') {
    if (route.length > TASK_ROWS.length) throw new Error(`${tier} never reaches ci`)
    route.push(nextPhase(tier, taskRow(route.at(-1)!)))
  }
  return route
}

test('each tier walks exactly the rows the tier table names', () => {
  const head: TaskPhase[] = ['queued', 'research', 'spec', 'spec-review', 'plan']
  expect(routeFromQueued('light'))
    .toEqual([...head, 'blocked-on-files', 'implement', 'pr-review', 'ci'])
  expect(routeFromQueued('standard'))
    .toEqual([...head, 'plan-review', 'blocked-on-files', 'implement', 'pr-review', 'ci'])
  expect(routeFromQueued('heavy')).toEqual([
    ...head, 'plan-review', 'blocked-on-files', 'implement', 'pr-review-intent', 'pr-review-quality', 'ci',
  ])
})
```

In `test/table.test.ts`, replace line 4 with:

```ts
import { nextPhase, RUN_ROWS, TASK_ROWS, taskRow, TIERS, type PhaseRow, type Tier } from '../src/lib/phases'
import type { TaskPhase } from '../src/lib/types'
```

Replace line 58 with:

```ts
const WORKER_REVIEW_PROMPTS = ['spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality']
```

Append to `test/table.test.ts`:

```ts
function walkFromQueued(tier: Tier): TaskPhase[] {
  const walked: TaskPhase[] = ['queued']
  while (walked.at(-1) !== 'ci') {
    if (walked.length > TASK_ROWS.length) throw new Error(`${tier} walks in a circle`)
    walked.push(nextPhase(tier, taskRow(walked.at(-1)!)))
  }
  return walked
}

test('every tier walks from queued to ci, through implement', () => {
  for (const tier of TIERS) {
    const walked = walkFromQueued(tier)
    expect(walked.at(-1), tier).toBe('ci')
    expect(walked, tier).toContain('implement')
  }
})

test('no row that is any row\'s onBlocker carries tiers — blocker routing stays tier-blind', () => {
  const targets = new Set(TASK_ROWS.flatMap((r) => (r.onBlocker === undefined ? [] : [r.onBlocker])))
  for (const phase of targets) expect(taskRow(phase).tiers, phase).toBeUndefined()
})

test('every row a tier reaches that has an actor has a prompt', () => {
  for (const tier of TIERS) {
    for (const phase of walkFromQueued(tier)) {
      const row = taskRow(phase)
      if (row.actor !== undefined) expect(row.prompt, `${tier}: ${phase}`).toBeDefined()
    }
  }
})
```

In `test/prompts.test.ts`, replace lines 9-11 with:

```ts
const REVIEW_PROMPTS = [
  'spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality', 'branch-review',
]
```

Append to `test/prompts.test.ts`:

```ts
test('pr-review carries the intent checks, then the quality checks, word for word, under one trailer', async () => {
  const read = (name: string) => Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
  const checks = (text: string) => /^Check: [\s\S]*?\n\n/m.exec(text)?.[0] ?? '(no Check: paragraph)'
  const combined = await read('pr-review')
  const intent = checks(await read('pr-review-intent'))
  const quality = checks(await read('pr-review-quality'))

  expect(combined).toContain(`### Intent\n\n${intent}`)
  expect(combined).toContain(`### Quality\n\n${quality}`)
  expect(combined.indexOf('### Intent')).toBeLessThan(combined.indexOf('### Quality'))
  expect(combined.split('VERDICT: CLEAR')).toHaveLength(2)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/phases.test.ts test/table.test.ts test/prompts.test.ts`
Expected: FAIL — `SyntaxError: Export named 'nextPhase' not found`; after that is fixed, `expect(TASK_ROWS.length).toBe(21)` receives 20 and `every declared prompt file exists` cannot find `pr-review`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/phases.ts`, add to `PhaseRow` (after `releasesPane?: boolean`, line 44):

```ts
  /**
   * The tiers that run this row; absent means every tier. Never set on a row
   * that is any row's `onBlocker`, so blocker routing stays tier-blind — asserted
   * by table.test.ts.
   */
  tiers?: readonly Tier[]
```

Replace the `TaskPhase` union (lines 83-87) with:

```ts
export type TaskPhase =
  | 'queued' | 'research' | 'spec' | 'spec-review' | 'plan' | 'plan-review'
  | 'blocked-on-files' | 'implement' | 'pr-review' | 'pr-review-intent' | 'pr-review-quality'
  | 'ci' | 'merge' | 'close' | 'teardown' | 'blocked-on-decision'
  | 'escalated' | 'failed' | 'orphaned' | 'blocked-on-failure' | 'done'
```

Replace lines 101-116 (the `plan-review` row through the `pr-review-quality` row) with:

```ts
  { phase: 'plan-review', actor: 'worker', signal: 'verdict',
    onClear: 'blocked-on-files', onBlocker: 'plan', counter: 'plan-review',
    prompt: 'plan-review', stallable: true, holdsFiles: false, tiers: ['standard', 'heavy'] },

  { phase: 'blocked-on-files', signal: 'files', onClear: 'implement',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: false },

  // A worker whose pane hangs without emitting `pane.exited` goes unnoticed otherwise.
  { phase: 'implement', actor: 'worker', signal: 'pr',
    onClear: 'pr-review', prompt: 'implement', stallable: true, holdsFiles: true },
  // One review where heavy runs two: across the 18 tasks tallied before tiers,
  // neither PR stage ever returned a BLOCKER, and two passes over one diff was
  // the clearest redundancy in the pipeline.
  { phase: 'pr-review', actor: 'worker', signal: 'verdict',
    onClear: 'pr-review-intent', onBlocker: 'implement', counter: 'pr-review',
    prompt: 'pr-review', stallable: true, holdsFiles: true, tiers: ['light', 'standard'] },
  { phase: 'pr-review-intent', actor: 'worker', signal: 'verdict',
    onClear: 'pr-review-quality', onBlocker: 'implement', counter: 'pr-review-intent',
    prompt: 'pr-review-intent', stallable: true, holdsFiles: true, tiers: ['heavy'] },
  { phase: 'pr-review-quality', actor: 'worker', signal: 'verdict',
    onClear: 'ci', onBlocker: 'implement', counter: 'pr-review-quality',
    prompt: 'pr-review-quality', stallable: true, holdsFiles: true, tiers: ['heavy'] },
```

Append after `taskRow` (end of file):

```ts
/**
 * Where a cleared row goes for this tier: along `onClear`, past every row the
 * tier skips. Every forward step past `research` reads it, so a tier change needs
 * no special case — the next step simply reads the current tier.
 */
export function nextPhase(tier: Tier, from: PhaseRow<TaskPhase>): TaskPhase {
  for (let phase = from.onClear; phase !== undefined; phase = taskRow(phase).onClear) {
    const tiers = taskRow(phase).tiers
    if (tiers === undefined || tiers.includes(tier)) return phase
  }
  throw new Error(`no ${tier} row after ${from.phase}: the table runs out`)
}
```

Create `prompts/pr-review.md`:

```markdown
# `pr-review` — PR #{{pr}}, {{branch}} (#{{issue}}), pass {{pass}}

PR #{{pr}} is open. This one review asks both questions the heavy tier splits across two stages:
does the PR do what was asked, completely, and nothing it was not asked to do — and is it written the
way this codebase is already written?

You do not review it yourself. Hand the brief below to a subagent with a fresh context, verbatim, and
route its output — the plugin owns every word of review instruction; you only carry it.

The reviewer writes its review to exactly this path:

    {{verdict_path}}

Dispatch the reviewer as a subagent and **wait for it within this turn**. Do not end your turn until
the verdict file exists at the path named above with a `VERDICT:` trailer as its last non-empty line.
Backgrounding the subagent ends your turn and leaves this pane reading idle while the review is still
being written, and the supervisor then treats a healthy worker as a stalled one.

Commit and push the verdict file before ending your turn. This ordering is load-bearing: if the
verdict were pushed at the start of your next `implement` turn, that push alone would move the PR's
head off the sha recorded when `implement` began, and an unfixed PR would advance past its own review
with no remediation done.

## The reviewer's brief

Review PR #{{pr}} on `{{branch}}` (`gh pr diff {{pr}}`) against issue #{{issue}}
(`gh issue view {{issue}}`) and the spec the PR itself carries at `{{spec_path}}`. The review has two
mandatory sections, in this order.

### Intent

Check: every acceptance criterion in the issue met; every spec requirement implemented, not just the
easy half; no silent scope reduction; no scope expansion beyond what was asked; tests that exercise
the behaviour rather than restating the implementation; and no divergence from `{{plan_path}}` that
the PR does not explain.

### Quality

Check: the change mirrors an existing pattern rather than introducing a second way to do the same
thing; naming and structure are consistent with its siblings; no dead code, no commented-out code, no
comments that restate what the next line does; error handling matches the established shape; tests
are well designed rather than merely present; nothing was duplicated that already exists in this repo.

After both sections, one list of findings across them: evidence-first, `file:line` citations, ranked
**BLOCKER** / **MAJOR** / **MINOR**, most severe first.

Rank honestly. Do not pad a review to look thorough, and do not soften a real finding to be
agreeable. The verdict gates the pipeline, so a manufactured finding costs as much as a missed one —
if the work is genuinely sound, `CLEAR` is the correct and useful answer.

The review ends with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 0

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the human can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Write the trailer at the **start of the line** — not indented, and not inside a code fence. An
indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may
follow it.
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/phases.test.ts test/table.test.ts test/prompts.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail` across the suite. Nothing routes into `pr-review` yet (`advanceTask` still hard-codes `pr-review-intent`), so every existing routing test is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/phases.ts prompts/pr-review.md test/phases.test.ts test/table.test.ts test/prompts.test.ts
git commit -m "feat(phases): add tiers to the task table and a combined pr-review row"
```

---

### Task 3: Route every forward step in the machine by tier

**Files:**
- Modify: `src/lib/machine.ts:1`, `:163-206`
- Test: `test/machine-task.test.ts:6` and end of file

- [ ] **Step 1: Write the failing tests**

In `test/machine-task.test.ts`, replace line 6 with:

```ts
import type { Run, Task, TaskPhase, Tier } from '../src/lib/types'
```

Append:

```ts
const clearedSignals = {
  actorIdle: true, artifactFresh: true,
  verdict: { verdict: 'CLEAR' as const, blockers: 0, majors: 0 },
  prNumber: 5, headSha: 'bbb', merged: false, issueClosed: false,
  ciBucket: null, filesClear: false, maxPasses: 2,
}

function tiered(phase: TaskPhase, tier: Tier): { run: Run; task: Task } {
  const fixed = fixture(phase)
  fixed.task.tier = tier
  return fixed
}

test('implement opens the combined pr-review on light and standard, and pr-review-intent on heavy', () => {
  const expected: Record<Tier, TaskPhase> = { light: 'pr-review', standard: 'pr-review', heavy: 'pr-review-intent' }
  for (const [tier, phase] of Object.entries(expected) as [Tier, TaskPhase][]) {
    const { run, task } = tiered('implement', tier)
    expect(advanceTask(run, task, clearedSignals)?.phase, tier).toBe(phase)
  }
})

test('a finished plan skips plan-review on light only', () => {
  const expected: Record<Tier, TaskPhase> = { light: 'blocked-on-files', standard: 'plan-review', heavy: 'plan-review' }
  for (const [tier, phase] of Object.entries(expected) as [Tier, TaskPhase][]) {
    const { run, task } = tiered('plan', tier)
    expect(advanceTask(run, task, clearedSignals)?.phase, tier).toBe(phase)
  }
})

test('a cleared pr-review goes to ci on light and standard', () => {
  for (const tier of ['light', 'standard'] as const) {
    const { run, task } = tiered('pr-review', tier)
    expect(advanceTask(run, task, clearedSignals)?.phase, tier).toBe('ci')
  }
})

test('a heavy task lowered to light finishes pr-review-intent, then skips pr-review-quality', () => {
  const { run, task } = tiered('pr-review-intent', 'light')
  expect(advanceTask(run, task, clearedSignals)?.phase).toBe('ci')
})

test('a light task raised to heavy finishes pr-review, then runs both heavy stages', () => {
  const { run, task } = tiered('pr-review', 'heavy')
  expect(advanceTask(run, task, clearedSignals)?.phase).toBe('pr-review-intent')
})

test('a BLOCKER on pr-review sends the task back to implement', () => {
  const { run, task } = tiered('pr-review', 'light')
  const next = advanceTask(run, task, {
    ...clearedSignals, verdict: { verdict: 'BLOCKER', blockers: 1, majors: 0 }, headSha: 'ccc',
  })
  expect(next?.phase).toBe('implement')
  expect(task.passes['pr-review']).toBe(1)
  expect(task.head_sha_at_entry).toBe('ccc')
})

test('a task from a ledger without a tier routes as heavy and is not written back', () => {
  const { run, task } = fixture('implement')
  expect(advanceTask(run, task, clearedSignals)?.phase).toBe('pr-review-intent')
  expect('tier' in task).toBe(false)
  expect(task.tier_history).toBeUndefined()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/machine-task.test.ts`
Expected: FAIL — light `implement` lands in `pr-review-intent` (hard-coded, `src/lib/machine.ts:194`), light `plan` lands in `plan-review`, and `pr-review` returns `null` (no case in `advanceTask`).

- [ ] **Step 3: Minimal implementation**

In `src/lib/machine.ts`, replace line 1 with:

```ts
import { nextPhase, type PhaseRow, taskRow, tierOf } from './phases'
```

Replace lines 167-169 (the `cleared` branch of `advanceLoopingRow`) with:

```ts
  if (cleared) {
    return enterTaskPhase(run, task, nextPhase(tierOf(task), row), 'cleared')
  }
```

Replace lines 181-206 (the `research`/`spec`/`plan`, `implement` and review cases) with:

```ts
    case 'research':
    case 'spec':
    case 'plan': {
      if (!s.actorIdle || !s.artifactFresh) return null
      return enterTaskPhase(
        run, task, nextPhase(tierOf(task), taskRow(task.phase)), 'actor idle + artifact fresh',
      )
    }

    case 'implement': {
      const moved = s.headSha !== null && s.headSha !== task.head_sha_at_entry
      if (!s.actorIdle || s.prNumber === null || !moved) return null
      task.pr = s.prNumber
      return enterTaskPhase(
        run, task, nextPhase(tierOf(task), taskRow('implement')), `PR #${s.prNumber} at ${s.headSha}`,
      )
    }

    case 'spec-review':
    case 'plan-review':
    case 'pr-review':
    case 'pr-review-intent':
    case 'pr-review-quality': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null
      return advanceLoopingRow(
        run, task, taskRow(task.phase), s.verdict.verdict === 'CLEAR',
        s.maxPasses, s.headSha,
      )
    }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/machine-task.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail`. Existing fixtures carry no `tier`, so they route as `heavy` and every older assertion (`implement → pr-review-intent`, `stage 1 CLEAR moves to stage 2`) still holds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/machine.ts test/machine-task.test.ts
git commit -m "feat(machine): route every forward step past research by the task's tier"
```

---

### Task 4: Drive `pr-review` from the supervisor, and walk the tier route for a lost worker

**Files:**
- Modify: `src/supervisor/tasks.ts:127-130` (`renderTaskPhasePrompt`), `:365-368` (`gatherSignals`)
- Modify: `src/supervisor/tick.ts:4`, `:149`
- Test: `test/table.test.ts` (imports and end), `test/tick.test.ts:15` and end

- [ ] **Step 1: Write the failing tests**

In `test/table.test.ts`, add below the imports:

```ts
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { advanceTasks, renderTaskPhasePrompt, type TaskDeps } from '../src/supervisor/tasks'
```

Append to `test/table.test.ts`:

```ts
const ROOT = join(import.meta.dir, '..')

function taskIn(phase: TaskPhase, tier: Tier): Task {
  return {
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
    depends_on: [], files: [], keep_worktree: false,
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase, phase_entered_at: 0, escalated_from: null,
    head_sha_at_entry: null, pr: 42, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: 0, adopted_at: 0,
    artifacts: { research: 'r.md', spec: 's.md', plan: 'p.md', verdicts: {} },
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    tier,
  }
}

function runWith(task: Task): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [task]
  return run
}

const clearingTick = (): TaskDeps => ({
  pluginRoot: ROOT,
  liveIdle: async () => true,
  maxPasses: 2,
  fileSettleMs: 0,
  prForBranch: async () => 42,
  prView: async () => null,
  issueView: async () => null,
  verdictFor: async () => ({ verdict: 'CLEAR', blockers: 0, majors: 0 }),
  removeWorktree: async () => 'removed',
  removeCheckout: async () => ({ removed: true }),
  ciDetail: async () => '',
  ambiguityLog: new Set<string>(),
  uncommittedPaths: async () => [],
  freshDispatchBase: async () => ({ commit: '1fb8a43', ref: 'origin/main', fetchError: null }),
})

// Through a whole tick rather than `advanceTask` alone: a verdict row missing from
// `gatherSignals` returns no signals and never reaches the machine at all.
test('a tick advances every verdict row, in every tier, to where nextPhase says', async () => {
  for (const tier of TIERS) {
    for (const row of TASK_ROWS.filter((r) => r.signal === 'verdict')) {
      const task = taskIn(row.phase, tier)
      await advanceTasks(runWith(task), clearingTick())
      expect(task.phase, `${tier}: ${row.phase}`).toBe(nextPhase(tier, row))
    }
  }
})

// Non-empty, not merely "does not throw": a phase missing from the switch falls to
// `default` and renders '', which a throw check would pass.
test('every worker row renders a non-empty prompt in every tier', async () => {
  for (const tier of TIERS) {
    for (const row of TASK_ROWS.filter((r) => r.actor === 'worker' && r.prompt !== undefined)) {
      const task = taskIn(row.phase, tier)
      const text = await renderTaskPhasePrompt(
        runWith(task), task, { pluginRoot: ROOT, ciDetail: async () => '' }, row.phase,
      )
      expect(text.length, `${tier}: ${row.phase}`).toBeGreaterThan(0)
    }
  }
})
```

In `test/tick.test.ts`, replace line 15 with:

```ts
import { TASK_ROWS, TIERS } from '../src/lib/phases'
```

Append to `test/tick.test.ts`:

```ts
test('the worker is still needed from every worker row in every tier, and past merge in none', () => {
  const workerRows = [
    'research', 'plan', 'plan-review', 'implement', 'pr-review', 'pr-review-intent',
    'pr-review-quality', 'ci',
  ] as const
  for (const tier of TIERS) {
    for (const phase of workerRows) {
      expect(workerStillNeeded(mkTask({ phase, tier })), `${tier}: ${phase}`).toBe(true)
    }
    expect(workerStillNeeded(mkTask({ phase: 'merge', tier })), `${tier}: merge`).toBe(false)
  }
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/table.test.ts test/tick.test.ts`
Expected: FAIL — `a tick advances every verdict row…` fails at `light: pr-review` (expected `ci`, received `pr-review`: `gatherSignals` returns `null` for the phase); `every worker row renders…` fails at `light: pr-review` (received length 0). The `tick.test.ts` test passes already: it is the characterisation Spec deviation 4 describes.

- [ ] **Step 3: Minimal implementation**

In `src/supervisor/tasks.ts`, replace lines 127-128 with:

```ts
    case 'pr-review':
      return renderPrompt(deps.pluginRoot, 'pr-review', common)
    case 'pr-review-intent':
      return renderPrompt(deps.pluginRoot, 'pr-review-intent', common)
```

Replace lines 365-368 with:

```ts
    case 'spec-review':
    case 'plan-review':
    case 'pr-review':
    case 'pr-review-intent':
    case 'pr-review-quality': {
```

In `src/supervisor/tick.ts`, replace line 4 with:

```ts
import { nextPhase, taskRow, tierOf } from '../lib/phases'
```

and line 149 with:

```ts
    if (row.onClear) reachable.push(nextPhase(tierOf(task), row))
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/table.test.ts test/tick.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/tasks.ts src/supervisor/tick.ts test/table.test.ts test/tick.test.ts
git commit -m "feat(supervisor): drive the pr-review row and walk a lost worker's tier route"
```

---

### Task 5: Skip `branch-review` when at most one task landed

**Files:**
- Modify: `src/lib/machine.ts:34-43` (`RunSignals`), `:71-76` (`execute`)
- Modify: `src/supervisor/deliver.ts:297-309` (`taskSignalsFor`)
- Test: `test/machine-run.test.ts:12-17,54-72`; `test/deliver.test.ts:248-272` and end

- [ ] **Step 1: Write the failing tests**

In `test/machine-run.test.ts`, replace lines 12-17 with:

```ts
const signals = (over: Partial<RunSignals> = {}): RunSignals => ({
  actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
  newestRegisteredAt: null, dispatchComplete: false,
  tasksAllTerminal: false, landedTaskCount: 0,
  ...over,
})
```

Replace lines 54-72 (the three `execute` tests) with:

```ts
test('execute waits for intake_closed even when every task is terminal', () => {
  const run = fixture('execute')
  run.intake_closed = false
  expect(advanceRun(run, signals({ tasksAllTerminal: true, landedTaskCount: 2 }))).toBeNull()
})

test('execute goes to branch-review when intake is closed and two tasks landed', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, signals({ tasksAllTerminal: true, landedTaskCount: 2 }))?.phase)
    .toBe('branch-review')
})

test('execute finishes the run without a branch review when exactly one task landed', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, signals({ tasksAllTerminal: true, landedTaskCount: 1 }))?.phase).toBe('done')
  expect(run.history.at(-1)?.why).toBe('one task landed; branch-review skipped')
})

test('execute escalates when no task landed', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, signals({ tasksAllTerminal: true, landedTaskCount: 0 }))?.phase)
    .toBe('escalated')
})
```

In `test/deliver.test.ts`, replace the two tests at lines 248-272 with:

```ts
test('rewinding the escalated task and finishing it lets the run leave execute', () => {
  const run = closedExecuteRun([
    mkTask({ task_id: 't1', phase: 'escalated', escalated_from: 'implement' }),
    mkTask({ task_id: 't2', phase: 'done', merged_at_ms: 2_000 }),
  ])
  expect(executeAdvance(run)).toBeNull()

  const t1 = run.tasks[0] as Task
  t1.phase = 'implement'
  t1.escalated_from = null
  expect(executeAdvance(run)).toBeNull()

  t1.phase = 'done'
  t1.merged_at_ms = 3_000
  expect(executeAdvance(run)?.phase).toBe('branch-review')
})

test('a terminal task that did not land still lets two landed siblings reach branch review', () => {
  for (const phase of ['failed', 'orphaned', 'blocked-on-failure'] as const) {
    const run = closedExecuteRun([
      mkTask({ task_id: 't1', phase }),
      mkTask({ task_id: 't2', phase: 'done', merged_at_ms: 2_000 }),
      mkTask({ task_id: 't3', phase: 'done', merged_at_ms: 3_000 }),
    ])
    expect(executeAdvance(run)?.phase).toBe('branch-review')
  }
})
```

Append to `test/deliver.test.ts`:

```ts
test('a landed task is done or orphaned with its merge recorded', () => {
  const landed = (task: Task) => taskSignalsFor(closedExecuteRun([task])).landedTaskCount
  expect(landed(mkTask({ phase: 'done', merged_at_ms: 1 }))).toBe(1)
  expect(landed(mkTask({ phase: 'orphaned', merged_at_ms: 1 }))).toBe(1)
  expect(landed(mkTask({ phase: 'orphaned', merged_at_ms: null }))).toBe(0)
  expect(landed(mkTask({ phase: 'done', merged_at_ms: null }))).toBe(0)
  expect(landed(mkTask({ phase: 'failed', merged_at_ms: 1 }))).toBe(0)
})

test('one landed task finishes the run with no branch review, and none escalates it', () => {
  const oneDone = closedExecuteRun([
    mkTask({ task_id: 't1', phase: 'done', merged_at_ms: 1 }),
    mkTask({ task_id: 't2', phase: 'orphaned', merged_at_ms: null }),
  ])
  expect(executeAdvance(oneDone)?.phase).toBe('done')

  const oneMergedOrphan = closedExecuteRun([mkTask({ task_id: 't1', phase: 'orphaned', merged_at_ms: 1 })])
  expect(executeAdvance(oneMergedOrphan)?.phase).toBe('done')

  const onlyUnmergedOrphan = closedExecuteRun([mkTask({ task_id: 't1', phase: 'orphaned', merged_at_ms: null })])
  expect(executeAdvance(onlyUnmergedOrphan)?.phase).toBe('escalated')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/machine-run.test.ts test/deliver.test.ts`
Expected: FAIL — typecheck-level `landedTaskCount` is not a `RunSignals` key; at runtime `advanceRun` reads the absent `anyTaskDone` as falsy and escalates where `done`/`branch-review` is expected, and `taskSignalsFor(...).landedTaskCount` is `undefined`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/machine.ts`, replace line 42 (`anyTaskDone: boolean`) with:

```ts
  /**
   * Tasks in `done` or `orphaned` whose merge was recorded. `orphaned` is
   * normally post-merge, but a manual rewind can put an unmerged task there.
   */
  landedTaskCount: number
```

Replace lines 71-76 (the `execute` case) with:

```ts
    // A final review of one task's work repeats the reviews that task already
    // passed: nothing else landed for it to have a seam with.
    case 'execute': {
      if (!run.intake_closed || !s.tasksAllTerminal) return null
      if (s.landedTaskCount >= 2) return enterRunPhase(run, 'branch-review', 'every task finished')
      if (s.landedTaskCount === 1) return enterRunPhase(run, 'done', 'one task landed; branch-review skipped')
      return enterRunPhase(run, 'escalated', 'every task finished without one reaching done')
    }
```

In `src/supervisor/deliver.ts`, insert above `export function taskSignalsFor` (line 297):

```ts
function hasLanded(task: Task): boolean {
  return (task.phase === 'done' || task.phase === 'orphaned') && task.merged_at_ms !== null
}
```

and replace line 307 (`anyTaskDone: …`) with:

```ts
    landedTaskCount: run.tasks.filter(hasLanded).length,
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/machine-run.test.ts test/deliver.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail`. `grep -rn anyTaskDone src test` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/machine.ts src/supervisor/deliver.ts test/machine-run.test.ts test/deliver.test.ts
git commit -m "feat(machine): skip branch-review when at most one task landed"
```

---

### Task 6: `Gh.issueLabels`

**Files:**
- Modify: `src/lib/gh.ts:111-117` (add after `issueView`)
- Test: `test/gh.test.ts` end of file

- [ ] **Step 1: Write the failing tests**

Append to `test/gh.test.ts`:

```ts
test('issueLabels reads the label names of an existing issue', async () => {
  const bin = await makeFakeBin(dir, {
    'issue view': { labels: [{ name: 'bug' }, { name: 'pipeline:tier-light' }] },
  })
  expect(await new Gh(bin, dir).issueLabels(12)).toEqual(['bug', 'pipeline:tier-light'])
  expect(await Bun.file(join(dir, 'calls.log')).text()).toBe('issue view 12 --json labels\n')
})

test('issueLabels passes gh\'s stderr through on failure', async () => {
  const bin = await makeFakeBin(dir, { 'issue view': { error: { message: 'Could not resolve to an issue' } } })
  expect(await new Gh(bin, dir).issueLabels(12))
    .toEqual({ error: JSON.stringify({ error: { message: 'Could not resolve to an issue' } }) })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/gh.test.ts`
Expected: FAIL — `TypeError: (intermediate value).issueLabels is not a function`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/gh.ts`, insert after `issueView` (after line 117):

```ts
  /** The failure is returned rather than swallowed: `hpipe task` prints why the labels were unreadable. */
  async issueLabels(issue: number): Promise<string[] | GhFailure> {
    const { code, text, stderr } = await this.run(['issue', 'view', String(issue), '--json', 'labels'])
    if (code !== 0) return { error: stderr.trim() || text.trim() || `gh exited ${code}` }
    try {
      const view = JSON.parse(text) as { labels?: { name: string }[] }
      return (view.labels ?? []).map((label) => label.name)
    } catch {
      return { error: `gh printed no JSON: ${text.trim()}` }
    }
  }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/gh.test.ts && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gh.ts test/gh.test.ts
git commit -m "feat(gh): read an issue's label names"
```

---

### Task 7: `src/lib/tiers.ts` — registration resolution and the lowering guard

**Files:**
- Create: `src/lib/tiers.ts`
- Test: Create `test/tiers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/tiers.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { newRun } from '../src/lib/ledger'
import { isLowering, pipelinePanes, registrationTier } from '../src/lib/tiers'
import type { Task } from '../src/lib/types'

function refusal(result: ReturnType<typeof registrationTier>): string {
  if (result.ok) throw new Error(`expected a refusal, got tier ${result.tier}`)
  return result.error
}

test('with no tier label and no --tier the tier is standard', () => {
  expect(registrationTier(undefined, [])).toEqual({ ok: true, tier: 'standard', source: 'default', why: 'default' })
})

test('--tier alone is recorded as the flag', () => {
  expect(registrationTier('heavy', ['bug'])).toEqual({ ok: true, tier: 'heavy', source: 'flag', why: '--tier' })
})

test('one tier label wins over --tier, and the reason says what --tier said', () => {
  expect(registrationTier('standard', ['bug', 'pipeline:tier-light'])).toEqual({
    ok: true, tier: 'light', source: 'label', why: 'label pipeline:tier-light; --tier said standard',
  })
  expect(registrationTier(undefined, ['pipeline:tier-heavy'])).toEqual({
    ok: true, tier: 'heavy', source: 'label', why: 'label pipeline:tier-heavy',
  })
})

test('two tier labels are refused, naming both', () => {
  expect(refusal(registrationTier('light', ['pipeline:tier-light', 'pipeline:tier-heavy'])))
    .toContain('pipeline:tier-light, pipeline:tier-heavy')
})

test('an unknown tier label is refused', () => {
  expect(refusal(registrationTier(undefined, ['pipeline:tier-huge']))).toContain('pipeline:tier-huge')
})

test('an unknown --tier is refused even when no labels were read', () => {
  expect(refusal(registrationTier('huge', null))).toBe('--tier must be one of light, standard, heavy, got: huge')
})

test('unreadable labels fall back to --tier, else standard, and say why on one line', () => {
  const unreadable = { error: 'HTTP 401: Bad credentials\n(https://api.github.com)' }
  expect(registrationTier('heavy', unreadable)).toEqual({
    ok: true, tier: 'heavy', source: 'flag', why: '--tier; labels unreadable: HTTP 401: Bad credentials',
  })
  expect(registrationTier(undefined, unreadable)).toEqual({
    ok: true, tier: 'standard', source: 'default', why: 'default; labels unreadable: HTTP 401: Bad credentials',
  })
})

test('labels that were never read leave --tier, else the default', () => {
  expect(registrationTier(undefined, null)).toEqual({ ok: true, tier: 'standard', source: 'default', why: 'default' })
  expect(registrationTier('light', null)).toEqual({ ok: true, tier: 'light', source: 'flag', why: '--tier' })
})

test('lowering is any move toward light', () => {
  expect(isLowering('heavy', 'standard')).toBe(true)
  expect(isLowering('standard', 'light')).toBe(true)
  expect(isLowering('light', 'heavy')).toBe(false)
  expect(isLowering('standard', 'standard')).toBe(false)
})

test('the pipeline panes are the orchestrator and every task pane, live or last', () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  const task = (over: Partial<Task>): Task => ({
    task_id: 't1', branch: 'b', issue: 1, surface: 'core', depends_on: [], files: [],
    keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'implement', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
    pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    ...over,
  })
  run.tasks = [
    task({ task_id: 't1', pane_id: 'w7:p1' }),
    task({ task_id: 't2', pane_id: null, last_pane_id: 'w3:p1' }),
  ]
  expect([...pipelinePanes(run)].sort()).toEqual(['w1:p1', 'w3:p1', 'w7:p1'])
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/tiers.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/tiers'`.

- [ ] **Step 3: Minimal implementation**

Create `src/lib/tiers.ts`:

```ts
import type { GhFailure } from './gh'
import { isTier, TIERS } from './phases'
import type { Run, Tier, TierChange } from './types'

export const TIER_LABEL_PREFIX = 'pipeline:tier-'

/** `null` when nothing was read: an issue `hpipe task` just filed has no labels yet. */
export type LabelRead = string[] | GhFailure | null

export interface ChosenTier {
  ok: true
  tier: Tier
  source: TierChange['source']
  why: string
}

export type RegistrationTier = ChosenTier | { ok: false; error: string }

// One line, because it lands inside the one `tier:` line `hpipe task` prints.
function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

export function registrationTier(flagValue: string | undefined, labels: LabelRead): RegistrationTier {
  let flagTier: Tier | undefined
  if (flagValue !== undefined) {
    if (!isTier(flagValue)) {
      return { ok: false, error: `--tier must be one of ${TIERS.join(', ')}, got: ${flagValue}` }
    }
    flagTier = flagValue
  }

  const fallback: ChosenTier = flagTier === undefined
    ? { ok: true, tier: 'standard', source: 'default', why: 'default' }
    : { ok: true, tier: flagTier, source: 'flag', why: '--tier' }
  if (labels === null) return fallback
  if ('error' in labels) return { ...fallback, why: `${fallback.why}; labels unreadable: ${firstLine(labels.error)}` }

  const tierLabels = labels.filter((label) => label.startsWith(TIER_LABEL_PREFIX))
  if (tierLabels.length > 1) {
    return {
      ok: false,
      error: `the issue carries ${tierLabels.length} tier labels (${tierLabels.join(', ')}); ` +
        'remove all but one, then register it again',
    }
  }
  const [label] = tierLabels
  if (label === undefined) return fallback

  const named = label.slice(TIER_LABEL_PREFIX.length)
  if (!isTier(named)) {
    return {
      ok: false,
      error: `unknown tier label ${label}; the tier labels are ` +
        TIERS.map((tier) => `${TIER_LABEL_PREFIX}${tier}`).join(', '),
    }
  }
  return {
    ok: true, tier: named, source: 'label',
    why: flagTier === undefined ? `label ${label}` : `label ${label}; --tier said ${flagTier}`,
  }
}

export function isLowering(from: Tier, to: Tier): boolean {
  return TIERS.indexOf(to) < TIERS.indexOf(from)
}

/**
 * Every pane the pipeline put an agent in. A guard, not authentication: a pane
 * herdr renamed on a move, or an orchestrator rebound by `claim`, still carries
 * an id this set no longer holds. The prompts forbid lowering; this only stops an
 * agent that ignores them from its own pane.
 */
export function pipelinePanes(run: Run): Set<string> {
  const panes = new Set<string>()
  if (run.orchestrator_pane !== null) panes.add(run.orchestrator_pane)
  for (const task of run.tasks) {
    if (task.pane_id !== null) panes.add(task.pane_id)
    if (task.last_pane_id !== undefined) panes.add(task.last_pane_id)
  }
  return panes
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/tiers.test.ts && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tiers.ts test/tiers.test.ts
git commit -m "feat(tiers): resolve a registration's tier from its labels and --tier"
```

---

### Task 8: `hpipe task --tier` and the label read

**Files:**
- Modify: `src/cli.ts:19` (imports), `:208-227` (`RegistrationAttempt`, `TaskInput`), `:299-381` (`registerTask`), `:383-397` (`cmdTask`), `:948-949` (`USAGE.task`), `:1063-1077` (`task` case)
- Test: `test/cli-commands.test.ts:1031-1060`, `:1072-1092`, and end; `test/cli-argv.test.ts` end

- [ ] **Step 1: Write the failing tests**

In `test/cli-commands.test.ts`, replace the test `the dispatched return keeps every header line above the one blank line` (lines 1031-1060) with:

```ts
test('the dispatched return keeps every header line above the one blank line', async () => {
  declareBootstrap()
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/boot', issue: 1, surface: 'core', notes: 'core work',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  }, undefined, fetchedBase, async () => [])

  const [head, ...rest] = result.text.split('\n\n')
  const lines = head!.split('\n')
  expect(lines.slice(0, 5)).toEqual([
    'task_id: t1',
    'tier: standard (default)',
    'files: none',
    'bootstrap: .claude/pipeline-bootstrap',
    'base: 1fb8a43 (origin/main as just fetched)',
  ])
  // #118: the registration path prints the whole dispatch, `agent start` flag included.
  expect(lines.slice(5)).toEqual([
    'dispatch, in order:',
    `    herdr worktree create --cwd '${repoDir}' --branch feat/boot --base 1fb8a43`,
    '    (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)',
    '    herdr agent start <name> --kind claude --pane <.result.root_pane.pane_id> -- --dangerously-skip-permissions',
    expect.stringMatching(/ dispatch --task t1 --pane <\.result\.root_pane\.pane_id>$/),
  ])
  // prompts/dispatch.md calls the lines above the blank line the orchestrator's,
  // so nothing meant for the worker may land among them.
  expect(rest.join('\n\n')).toStartWith('# feat/boot — issue #1')
})
```

In the test `a repo declaring no bootstrap says so rather than staying silent` (lines 1072-1092), replace its `cmdTask` call's closing argument list `}, undefined, fetchedBase)` with `}, undefined, fetchedBase, async () => [])`, and replace its `expect(lines.slice(0, 4)).toEqual([…])` with:

```ts
  expect(lines.slice(0, 5)).toEqual([
    'task_id: t1', 'tier: standard (default)', 'files: none', 'bootstrap: none',
    'base: 1fb8a43 (origin/main as just fetched)',
  ])
```

Append to `test/cli-commands.test.ts`:

```ts
// ——— registration tier ———

async function seedInRepo(): Promise<void> {
  await saveRun(dir, newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' }))
}

const existingIssue = {
  branch: 'feat/tiered', issue: 12, surface: 'core', notes: '',
  dependsOn: [] as string[], files: [] as string[], keepWorktree: false,
  repoKey: 'k', runId: null,
}

const headLines = (text: string): string[] => text.split('\n\n')[0]!.split('\n')

test('a pipeline:tier label beats --tier, and the tier line says what --tier said', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), { ...existingIssue, tier: 'standard', callerPane: 'w1:p1' },
    undefined, fetchedBase, async () => ['bug', 'pipeline:tier-light'])

  expect(result.ok).toBe(true)
  expect(headLines(result.text).slice(0, 2)).toEqual([
    'task_id: t1', 'tier: light (label pipeline:tier-light; --tier said standard)',
  ])
  const task = (await registered())[0]!
  expect(task.tier).toBe('light')
  expect(task.tier_history).toEqual([{
    at: expect.any(Number), from: null, to: 'light', source: 'label', pane: 'w1:p1',
    why: 'label pipeline:tier-light; --tier said standard',
  }])
})

test('--tier with no tier label is recorded as the flag', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), { ...existingIssue, tier: 'heavy' }, undefined, fetchedBase, async () => ['bug'])
  expect(headLines(result.text)).toContain('tier: heavy (--tier)')
  expect((await registered())[0]!.tier_history?.[0]).toMatchObject({ source: 'flag', pane: null })
})

test('with neither a label nor --tier the task is standard', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), existingIssue, undefined, fetchedBase, async () => [])
  expect(headLines(result.text)).toContain('tier: standard (default)')
  expect((await registered())[0]!.tier).toBe('standard')
})

test('unreadable labels fall back to --tier and still register', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), { ...existingIssue, tier: 'heavy' }, undefined, fetchedBase,
    async () => ({ error: 'HTTP 401: Bad credentials' }))
  expect(result.ok).toBe(true)
  expect(headLines(result.text)).toContain('tier: heavy (--tier; labels unreadable: HTTP 401: Bad credentials)')
})

test('two tier labels refuse the registration and record nothing', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), existingIssue, undefined, fetchedBase,
    async () => ['pipeline:tier-light', 'pipeline:tier-heavy'])
  expect(result.ok).toBe(false)
  expect(result.text).toContain('pipeline:tier-light, pipeline:tier-heavy')
  expect(await registered()).toEqual([])
})

test('an unknown tier label refuses the registration', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), existingIssue, undefined, fetchedBase, async () => ['pipeline:tier-huge'])
  expect(result.ok).toBe(false)
  expect(result.text).toContain('unknown tier label pipeline:tier-huge')
  expect(await registered()).toEqual([])
})

test('an unknown --tier files no issue', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let filed = 0
  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile, tier: 'huge' },
    async () => { filed++; return issue318 })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('--tier must be one of light, standard, heavy, got: huge')
  expect(filed).toBe(0)
})

test('a filed issue has no labels to read, so --title skips the read', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let reads = 0
  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile },
    async () => issue318, fetchedBase, async () => { reads++; return ['pipeline:tier-heavy'] })
  expect(result.ok).toBe(true)
  expect(reads).toBe(0)
  expect(headLines(result.text).slice(0, 3)).toEqual(['task_id: t1', 'tier: standard (default)', 'issue: #318 (filed)'])
})

test('a registration that loses its save reads the labels once', async () => {
  await seedInRepo()
  let reads = 0
  const result = await cmdTask(ctx(), existingIssue, undefined, fetchedBase, async () => {
    reads++
    await supervisorWrites((run) => { run.intake_closed = true })
    return ['pipeline:tier-heavy']
  })
  expect(result.ok).toBe(true)
  expect(reads).toBe(1)
  expect((await registered()).map((t) => t.tier)).toEqual(['heavy'])
})
```

Append to `test/cli-argv.test.ts`:

```ts
test('task --tier reaches registration, and a pipeline:tier label read through gh overrides it', async () => {
  const f = started()
  const binDir = tempDir('hpipe-argv-gh-')
  f.env.GH_BIN = await makeFakeBin(binDir, {
    'issue view 1': { labels: [{ name: 'pipeline:tier-light' }] },
    'issue view 2': { labels: [] },
  })

  const labelled = hpipe([...TASK, '--tier', 'heavy'], f)
  expect(labelled.code).toBe(0)
  expect(labelled.out).toContain('tier: light (label pipeline:tier-light; --tier said heavy)')

  const flagged = hpipe(['task', '--branch', 'smoke/two', '--issue', '2', '--surface', 'core', '--tier', 'heavy'], f)
  expect(flagged.code).toBe(0)
  expect(flagged.out).toContain('tier: heavy (--tier)')
  expect(await Bun.file(join(binDir, 'calls.log')).text()).toContain('issue view 1 --json labels')
})

test('task --tier with its value missing is a usage error', () => {
  const r = hpipe([...TASK, '--tier', '--files', 'src/'], started())
  expect(r.code).toBe(1)
  expect(r.out).toContain('--tier needs a value')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/cli-commands.test.ts test/cli-argv.test.ts`
Expected: FAIL — no `tier:` line in any header (`expected … 'tier: standard (default)'`), `task.tier` is `undefined`, and the two-label / unknown-label registrations succeed.

- [ ] **Step 3: Minimal implementation**

In `src/cli.ts`, replace line 19 with:

```ts
import { RUN_ROWS, TASK_ROWS, runRow, taskRow } from './lib/phases'
import { registrationTier, type LabelRead } from './lib/tiers'
```

Replace lines 210-227 (`RegistrationAttempt` through `TaskInput`) with:

```ts
/** What one `hpipe task` call carries across the stale-run retries of its registration. */
interface RegistrationAttempt {
  fileIssueOnce: (repoRoot: string) => Promise<FiledIssue | GhFailure>
  readLabelsOnce: (repoRoot: string, issue: number) => Promise<string[] | GhFailure>
  landed: (taskId: string) => void
  dispatchBase: DispatchBaseFor
}

type DispatchBaseFor = (repoRoot: string, dependencyMerges: string[] | null) => Promise<DispatchBase>

type ReadLabels = (repoRoot: string, issue: number) => Promise<string[] | GhFailure>

const fileIssueWithGh: FileIssue = (repoRoot, title, bodyFile) =>
  new Gh(undefined, repoRoot).issueCreate(title, bodyFile)

const readLabelsWithGh: ReadLabels = (repoRoot, issue) => new Gh(undefined, repoRoot).issueLabels(issue)

interface TaskInput {
  branch: string; issue: number; surface: string; notes: string
  dependsOn: string[]; files: string[]; keepWorktree: boolean
  repoKey: string | null; runId: string | null
  title?: string; bodyFile?: string
  tier?: string
  callerPane?: string | null
}
```

In `registerTask`, insert immediately after the cycle check (after line 310, `if (cycle) return fail(…)`):

```ts
  // Before filing, so a refused tier files nothing. A filed issue is brand new and
  // has no labels to read.
  const labels: LabelRead = filing ? null : await attempt.readLabelsOnce(run.repo_root, input.issue)
  const tier = registrationTier(input.tier, labels)
  if (!tier.ok) return fail(tier.error)
```

In the `task` literal (lines 323-340), replace the last line
`    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: input.notes,` with:

```ts
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: input.notes,
    tier: tier.tier,
    tier_history: [{
      at: Date.now(), from: null, to: tier.tier, source: tier.source,
      pane: input.callerPane ?? null, why: tier.why,
    }],
```

Replace lines 370-371 (the `header`) with:

```ts
  const header = [
    `task_id: ${task.task_id}`, `tier: ${tier.tier} (${tier.why})`,
    ...(filed ? [`issue: #${issue} (filed)`] : []), filesLine, bootLine,
  ].join('\n')
```

Replace lines 383-397 (the `cmdTask` signature through the `attempt` literal) with:

```ts
export async function cmdTask(
  ctx: Ctx, input: TaskInput, fileIssue: FileIssue = fileIssueWithGh,
  dispatchBase: DispatchBaseFor = freshDispatchBase, readLabels: ReadLabels = readLabelsWithGh,
): Promise<CmdResult> {
  // The retry re-runs registerTask from a fresh read, so the gh calls are memoized
  // out here: a second attempt reuses the issue the first one filed and the labels
  // it read, and never files another.
  const outcome: {
    filing: Promise<FiledIssue | GhFailure> | null
    labels: Promise<string[] | GhFailure> | null
    registeredAs: string | null
  } = { filing: null, labels: null, registeredAs: null }
  const attempt: RegistrationAttempt = {
    fileIssueOnce: (repoRoot) =>
      (outcome.filing ??= fileIssue(repoRoot, input.title!, resolve(input.bodyFile!))),
    readLabelsOnce: (repoRoot, issue) => (outcome.labels ??= readLabels(repoRoot, issue)),
    landed: (taskId) => { outcome.registeredAs = taskId },
    dispatchBase,
  }
```

Replace `USAGE.task` (lines 948-949) with:

```ts
  task: ['hpipe task --branch <branch> (--issue <n> | --title <title> --body-file <path>) --surface <surface> ' +
    '[--tier light|standard|heavy] [--depends-on <id,id>] [--files <prefix,prefix>] [--notes <text>] ' +
    '[--keep-worktree] [--run <run-id>]'],
```

In the dispatcher's `task` case (lines 1063-1077), add two properties after `bodyFile: flag(rest, 'body-file') ?? undefined,`:

```ts
        tier: flag(rest, 'tier') ?? undefined,
        callerPane: process.env.HERDR_PANE_ID || null,
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/cli-commands.test.ts test/cli-argv.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail`. (Existing `cmdTask` tests that pass no `readLabels` call the real `gh` in a temp dir that is not a GitHub repo; it fails fast, registration falls back to `standard`, and none of them asserts the tier.)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-commands.test.ts test/cli-argv.test.ts
git commit -m "feat(cli): register a task's tier from --tier and its pipeline:tier label"
```

---

### Task 9: `hpipe tier`

**Files:**
- Modify: `src/cli.ts` imports (`phases`, `tiers`), after `cmdAnswer` (`:853`), after `listFlag` (`:944`), `USAGE` (`:961`), `FREE_TEXT_FLAGS` (`:977`), dispatcher after the `answer` case (`:1143`)
- Test: `test/cli-commands.test.ts:5-8` and end; `test/cli-argv.test.ts:181-184` and end

- [ ] **Step 1: Write the failing tests**

In `test/cli-commands.test.ts`, replace lines 5-8 with:

```ts
import {
  cmdAbort, cmdAnswer, cmdBrief, cmdDecide, cmdDispatchDone, cmdDispatchTask, cmdForget,
  cmdRelease, cmdResume, cmdRewind, cmdShow, cmdStatus, cmdTask, cmdTier, recordWorkerPane,
} from '../src/cli'
```

Append to `test/cli-commands.test.ts`:

```ts
// ——— hpipe tier ———

async function seedTiered(over: Partial<Task> = {}): Promise<Run> {
  const run = runWithTasks([{
    task_id: 't1', phase: 'implement', tier: 'light', pane_id: 'w7:p1', last_pane_id: 'w3:p1', ...over,
  }])
  run.orchestrator_pane = 'w1:p1'
  await saveRun(dir, run)
  return run
}

const tierInput = (over: Partial<Parameters<typeof cmdTier>[1]> = {}): Parameters<typeof cmdTier>[1] => ({
  taskId: 't1', tier: 'heavy', why: 'research found a contract change', callerPane: 'w7:p1',
  repoKey: 'k', runId: null, ...over,
})

test('tier raises from any pane, logs the change, and writes nothing to run.history', async () => {
  const run = await seedTiered()
  const historyBefore = (await savedRun(run.run_id)).history.length

  const result = await cmdTier(ctx(), tierInput())
  expect(result.ok).toBe(true)
  expect(result.text).toContain('t1: light → heavy')

  const saved = await savedRun(run.run_id)
  expect(saved.tasks[0]?.tier).toBe('heavy')
  expect(saved.tasks[0]?.tier_history).toEqual([{
    at: expect.any(Number), from: 'light', to: 'heavy', source: 'hpipe-tier', pane: 'w7:p1',
    why: 'research found a contract change',
  }])
  expect(saved.history).toHaveLength(historyBefore)
  expect(saved.tasks[0]?.phase).toBe('implement')
})

test('tier refuses to lower from the orchestrator pane or any worker pane, live or last', async () => {
  for (const pane of ['w1:p1', 'w7:p1', 'w3:p1']) {
    const run = await seedTiered({ tier: 'heavy' })
    const result = await cmdTier(ctx(), tierInput({ tier: 'light', callerPane: pane, runId: run.run_id }))
    expect(result.ok, pane).toBe(false)
    expect(result.text).toBe('lowering a tier needs a human; run this from your own pane')
    expect((await savedRun(run.run_id)).tasks[0]?.tier).toBe('heavy')
  }
})

test('tier lowers from a pane the pipeline does not own, or from outside herdr', async () => {
  for (const pane of ['w42:p9', null]) {
    const run = await seedTiered({ tier: 'heavy' })
    const result = await cmdTier(ctx(), tierInput({ tier: 'light', callerPane: pane, runId: run.run_id }))
    expect(result.ok, String(pane)).toBe(true)
    expect((await savedRun(run.run_id)).tasks[0]?.tier).toBe('light')
  }
})

test('tier to the tier a task already has is a no-op that records nothing', async () => {
  const run = await seedTiered()
  const result = await cmdTier(ctx(), tierInput({ tier: 'light' }))
  expect(result.ok).toBe(true)
  expect(result.text).toContain('already light')
  expect((await savedRun(run.run_id)).tasks[0]?.tier_history).toBeUndefined()
})

test('tier refuses a finished task', async () => {
  await seedTiered({ phase: 'done' })
  const result = await cmdTier(ctx(), tierInput())
  expect(result.ok).toBe(false)
  expect(result.text).toContain('is finished (phase: done)')
})

test('tier needs --why and a real tier', async () => {
  await seedTiered()
  expect((await cmdTier(ctx(), tierInput({ why: '  ' }))).text).toContain('--why is required')
  expect((await cmdTier(ctx(), tierInput({ tier: 'huge' }))).text)
    .toBe('the tier must be one of light, standard, heavy, got: huge')
})

test('tier on a task from before tiers starts from heavy', async () => {
  const run = await seedTiered({ tier: undefined })
  const result = await cmdTier(ctx(), tierInput({ tier: 'standard', callerPane: 'w42:p9' }))
  expect(result.text).toContain('t1: heavy → standard')
  expect((await savedRun(run.run_id)).tasks[0]?.tier_history?.[0]?.from).toBe('heavy')
})
```

In `test/cli-argv.test.ts`, replace lines 181-184 with:

```ts
const SUBCOMMANDS = [
  'start', 'task', 'brief', 'show', 'dispatch', 'status', 'drain', 'rewind', 'release',
  'decide', 'answer', 'tier', 'resume', 'abort', 'forget',
]
```

Append to `test/cli-argv.test.ts`:

```ts
test('tier reads its positional tier and --why, and the caller pane from HERDR_PANE_ID', async () => {
  const f = fixture()
  f.env.HERDR_PANE_ID = 'w1:p1'
  const binDir = tempDir('hpipe-argv-gh-')
  f.env.GH_BIN = await makeFakeBin(binDir, { 'issue view': { labels: [] } })
  expect(hpipe(['start', 'argv fixture'], f).code).toBe(0)
  expect(hpipe([...TASK], f).out).toContain('tier: standard (default)')

  const raised = hpipe(['tier', '--task', 't1', 'heavy', '--why', 'touches the ledger schema'], f)
  expect(raised.code).toBe(0)
  expect(raised.out).toContain('t1: standard → heavy')

  // `start` made this pane the orchestrator's, so lowering from it is refused.
  const lowered = hpipe(['tier', '--task', 't1', 'light', '--why', 'smaller than it looked'], f)
  expect(lowered.code).toBe(1)
  expect(lowered.out).toContain('lowering a tier needs a human; run this from your own pane')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/cli-commands.test.ts test/cli-argv.test.ts`
Expected: FAIL — `SyntaxError: Export named 'cmdTier' not found in module '…/src/cli.ts'`; in `cli-argv.test.ts`, `tier --help` prints the full usage and exits 1 (`expected 0`).

- [ ] **Step 3: Minimal implementation**

In `src/cli.ts`, replace the two import lines from Task 8 with:

```ts
import { isTier, RUN_ROWS, TASK_ROWS, TIERS, runRow, taskRow, tierOf } from './lib/phases'
import { isLowering, pipelinePanes, registrationTier, type LabelRead } from './lib/tiers'
```

Insert after `export const cmdAnswer = retryingOnStale(answer)` (line 853):

```ts
async function tier(ctx: Ctx, input: {
  taskId: string; tier: string; why: string; callerPane: string | null
  repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const to = input.tier
  if (!isTier(to)) return fail(`the tier must be one of ${TIERS.join(', ')}, got: ${to || '(missing)'}`)
  if (input.why.trim().length === 0) {
    return fail('--why is required: the tier log records why every change was made')
  }

  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (taskPhaseIsTerminal(task.phase)) {
    return fail(`task ${task.task_id} is finished (phase: ${task.phase}) — its tier routes nothing now`)
  }
  const from = tierOf(task)
  if (from === to) return ok(`${task.task_id} is already ${to}; nothing changed`)
  if (isLowering(from, to) && input.callerPane !== null && pipelinePanes(run).has(input.callerPane)) {
    return fail('lowering a tier needs a human; run this from your own pane')
  }

  task.tier = to
  task.tier_history = [...(task.tier_history ?? []), {
    at: Date.now(), from, to, source: 'hpipe-tier', pane: input.callerPane, why: input.why,
  }]
  await saveRun(ctx.stateDir, run)
  return ok(`${task.task_id}: ${from} → ${to}. ${task.phase} completes as it is; the next step follows ${to}.`)
}
export const cmdTier = retryingOnStale(tier)
```

Insert after `listFlag` (after line 944):

```ts
function positionals(argv: string[]): string[] {
  const found: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (!arg.startsWith('--')) found.push(arg)
    else if (!VALUELESS_FLAGS.has(arg)) i++
  }
  return found
}
```

In `USAGE`, insert after the `answer` entry (line 961):

```ts
  tier: ['hpipe tier --task <id> <light|standard|heavy> --why <text> [--run <run-id>]'],
```

Replace line 977 with:

```ts
const FREE_TEXT_FLAGS = new Set(['--question', '--recommend', '--answer', '--notes', '--title', '--why'])
```

In the dispatcher, insert after the `answer` case's `break` (line 1143):

```ts
    case 'tier':
      out = await cmdTier(ctx, {
        taskId: flag(rest, 'task') ?? '',
        tier: positionals(rest)[0] ?? '',
        why: flag(rest, 'why') ?? '',
        callerPane: process.env.HERDR_PANE_ID || null,
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/cli-commands.test.ts test/cli-argv.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-commands.test.ts test/cli-argv.test.ts
git commit -m "feat(cli): add hpipe tier to raise a task's tier mid-run"
```

---

### Task 10: `hpipe status` tier bit, `hpipe show` tier / tier log / visited

**Files:**
- Modify: `src/lib/status.ts:8-9` (imports), `:421-431` (task line), `:445-478` (`formatTaskDetail` and a new `visitedPhases`)
- Test: `test/status.test.ts:2`, `:263-264`, `:606`, and end

- [ ] **Step 1: Write the failing tests**

In `test/status.test.ts`, replace line 2 with:

```ts
import { actionFor, formatStatus, formatTaskDetail, visitedPhases, waitsOnYou } from '../src/lib/status'
```

Replace lines 263-264 with:

```ts
  expect(text).toContain('  t1 feat/x #1 [research 780m] heavy working')
  expect(text).toContain('  t2 feat/x #1 [implement 2m] heavy working')
```

Replace line 606 with:

```ts
  expect(taskLine).toEndWith(`[research 0m] heavy unknown — dispatch under way — see \`${HP} show --task t1\``)
```

Append to `test/status.test.ts`:

```ts
test('the status task line carries the tier right after the phase bracket', () => {
  const now = 100_000_000
  const run = mkRun()
  run.tasks = [mkTask({ task_id: 't2', phase: 'implement', tier: 'light', phase_entered_at: now - 5 * 60_000 })]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), now))
    .toContain('  t2 feat/x #1 [implement 5m] light working')
})

test('visitedPhases lists every phase entered, drops repeats and marks rewinds', () => {
  const run = mkRun()
  const task = mkTask({ task_id: 't1' })
  run.history = [
    { at: 1, task_id: 't1', from: 'queued', to: 'research', why: 'gate opened' },
    { at: 2, task_id: 't2', from: 'queued', to: 'research', why: 'gate opened' },
    { at: 3, task_id: 't1', from: 'research', to: 'spec', why: 'actor idle + artifact fresh' },
    { at: 4, task_id: 't1', from: 'spec', to: 'blocked-on-decision', why: 'worker surfaced a decision' },
    { at: 5, task_id: 't1', from: 'blocked-on-decision', to: 'spec', why: 'decision d1 answered' },
    { at: 6, task_id: 't1', from: 'spec', to: 'spec', why: 'answer to d2 discarded, undelivered' },
    { at: 7, task_id: 't1', from: 'rewind', to: 'research', why: 'manual rewind' },
    { at: 8, from: 'execute', to: 'branch-review', why: 'every task finished' },
  ]
  expect(visitedPhases(run, task)).toEqual(['research', 'spec', 'blocked-on-decision', 'spec', '↺research'])
})

test('hpipe show prints the tier, its log and the phases visited, after the phase', () => {
  const run = mkRun()
  const task = mkTask({
    task_id: 't1', phase: 'spec', tier: 'standard',
    tier_history: [
      { at: Date.UTC(2026, 8, 25, 10, 4), from: null, to: 'light', source: 'label', pane: 'w1:p1',
        why: 'label pipeline:tier-light' },
      { at: Date.UTC(2026, 8, 25, 11, 30), from: 'light', to: 'standard', source: 'hpipe-tier', pane: 'w3:p1',
        why: 'research found a contract change' },
    ],
  })
  run.tasks = [task]
  run.history = [
    { at: 1, task_id: 't1', from: 'queued', to: 'research', why: 'gate opened' },
    { at: 2, task_id: 't1', from: 'research', to: 'spec', why: 'actor idle + artifact fresh' },
  ]
  const lines = formatTaskDetail(run, task).split('\n')
  const phaseAt = lines.findIndex((line) => line.startsWith('phase:'))
  expect(lines.slice(phaseAt + 1, phaseAt + 4)).toEqual([
    'tier:       standard',
    'tier log:   2026-09-25 10:04Z — → light (label pipeline:tier-light) · ' +
      '2026-09-25 11:30Z light → standard (hpipe-tier, pane w3:p1): research found a contract change',
    'visited:    research → spec',
  ])
})

test('hpipe show on a task from before tiers reads heavy, with no log, and nothing visited yet', () => {
  const run = mkRun()
  const task = mkTask({ phase: 'queued' })
  run.tasks = [task]
  const text = formatTaskDetail(run, task)
  expect(text).toContain('tier:       heavy')
  expect(text).toContain('tier log:   none')
  expect(text).toContain('visited:    none')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/status.test.ts`
Expected: FAIL — `SyntaxError: Export named 'visitedPhases' not found in module '…/src/lib/status.ts'`.

- [ ] **Step 3: Minimal implementation**

In `src/lib/status.ts`, replace line 8 with:

```ts
import { runRow, taskRow, tierOf } from './phases'
```

and line 9 with:

```ts
import type { MissingArtifact, Run, SessionKey, Task, TierChange, UncommittedWork } from './types'
```

In `formatStatus`'s task line (lines 422-428), replace the `bits` array with:

```ts
      const bits = [
        `  ${task.task_id}`,
        task.branch,
        `#${task.issue}`,
        `[${task.phase} ${ageMinutes(task.phase_entered_at, now)}m]`,
        tierOf(task),
        task.agent_status,
      ]
```

Insert above `export function formatTaskDetail` (line 451):

```ts
/**
 * A skipped review shows here by its absence. Tier changes are not read from
 * `run.history` because they are never written there; see `TierChange`.
 */
export function visitedPhases(run: Run, task: Task): string[] {
  const visited: string[] = []
  let previous: string | undefined
  for (const entry of run.history) {
    if (entry.task_id !== task.task_id || entry.to === previous) continue
    previous = entry.to
    visited.push(entry.from === 'rewind' ? `↺${entry.to}` : entry.to)
  }
  return visited
}

function tierLogEntry(change: TierChange): string {
  const when = `${new Date(change.at).toISOString().slice(0, 16).replace('T', ' ')}Z`
  const move = `${change.from ?? '—'} → ${change.to}`
  return change.from === null
    ? `${when} ${move} (${change.why})`
    : `${when} ${move} (${change.source}, pane ${change.pane ?? 'unknown'}): ${change.why}`
}
```

In `formatTaskDetail`, add two constants after `const open = openDecisionFor(task)`:

```ts
  const tierLog = (task.tier_history ?? []).map(tierLogEntry)
  const visited = visitedPhases(run, task)
```

and insert immediately after the `` `phase:      …` `` line:

```ts
    `tier:       ${tierOf(task)}`,
    `tier log:   ${tierLog.length > 0 ? tierLog.join(' · ') : 'none'}`,
    `visited:    ${visited.length > 0 ? visited.join(' → ') : 'none'}`,
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/status.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/status.ts test/status.test.ts
git commit -m "feat(status): show each task's tier, its tier log and the phases it visited"
```

---

### Task 11: `hpipe rewind` warns on a row the tier skips

**Files:**
- Modify: `src/cli.ts:668-669` (`rewind` locals), `:701` (after the phase write), `:747-750` (result text)
- Test: `test/cli-commands.test.ts` end

- [ ] **Step 1: Write the failing tests**

Append to `test/cli-commands.test.ts`:

```ts
test('a rewind onto a row the tier skips is allowed, and warns how the task will leave it', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'escalated', escalated_from: 'implement', tier: 'light' }])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'plan-review', taskId: 't1' })

  expect(result.ok).toBe(true)
  expect(result.text).toContain('warning: plan-review is not in tier light; the task will leave it by the light route')
  expect((await savedRun(run.run_id)).tasks[0]?.phase).toBe('plan-review')
})

test('a rewind onto a row the tier runs carries no warning', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'escalated', escalated_from: 'implement', tier: 'standard' }])
  await saveRun(dir, run)
  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'plan-review', taskId: 't1' })
  expect(result.text).not.toContain('warning:')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/cli-commands.test.ts`
Expected: FAIL — the first test's text has no `warning:` line.

- [ ] **Step 3: Minimal implementation**

In `src/cli.ts` `rewind`, after `let rewoundTask: Task | null = null` (line 669) add:

```ts
  let tierWarning = ''
```

After `task.phase = input.phase as TaskPhase` (line 701) add:

```ts
    const excludedBy = taskRow(task.phase).tiers
    if (excludedBy !== undefined && !excludedBy.includes(tierOf(task))) {
      tierWarning = `\nwarning: ${task.phase} is not in tier ${tierOf(task)}; ` +
        `the task will leave it by the ${tierOf(task)} route`
    }
```

Replace the final `return ok(…)` (lines 747-750) with:

```ts
  return ok(
    `rewound ${input.taskId ?? input.runId} to ${input.phase}; counters cleared` +
    (reserved === null ? '' : `; next verdict → ${reserved}`) + owed + tierWarning,
  )
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/cli-commands.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-commands.test.ts
git commit -m "feat(cli): warn when a rewind lands on a row the task's tier skips"
```

---

### Task 12: `src/lib/models.ts` and `src/lib/tier-prompt.ts`

**Files:**
- Create: `src/lib/models.ts`, `src/lib/tier-prompt.ts`
- Test: Create `test/tier-prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/tier-prompt.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { newRun } from '../src/lib/ledger'
import { IMPLEMENT_MODEL } from '../src/lib/models'
import { TIERS } from '../src/lib/phases'
import { phaseLoop, taskTiers, tierPromptVars } from '../src/lib/tier-prompt'
import type { Task } from '../src/lib/types'

function mkTask(over: Partial<Task> = {}): Task {
  return {
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
    depends_on: [], files: [], keep_worktree: false,
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase: 'research', phase_entered_at: 0, escalated_from: null,
    head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: 0, adopted_at: 0,
    artifacts: { research: 'docs/r.md', spec: 'docs/s.md', plan: 'docs/p.md', verdicts: {} },
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    ...over,
  }
}

const HEAD = [
  '1. `research` → `docs/r.md`',
  '2. `spec` → `docs/s.md`',
  '3. `spec-review` — you dispatch the reviewer',
  '4. `plan` → `docs/p.md`',
]

test('only implement\'s coding subagent is pinned, to sonnet', () => {
  expect(IMPLEMENT_MODEL).toBe('sonnet')
})

test('the light loop skips plan-review and runs one combined PR review', () => {
  expect(phaseLoop(mkTask({ tier: 'light' }))).toBe([
    ...HEAD,
    '5. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '6. `pr-review` — one review of the PR, intent then quality',
  ].join('\n'))
})

test('the standard loop keeps plan-review and the combined PR review', () => {
  expect(phaseLoop(mkTask({ tier: 'standard' }))).toBe([
    ...HEAD,
    '5. `plan-review` — you dispatch the reviewer again',
    '6. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '7. `pr-review` — one review of the PR, intent then quality',
  ].join('\n'))
})

test('the heavy loop runs both PR stages, as every task did before tiers', () => {
  expect(phaseLoop(mkTask())).toBe([
    ...HEAD,
    '5. `plan-review` — you dispatch the reviewer again',
    '6. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '7. `pr-review-intent` — does the PR do what was asked',
    '8. `pr-review-quality` — is it written the way this codebase is',
  ].join('\n'))
})

test('the loop carries its paths as text, never as a token render() would pass through', () => {
  for (const tier of TIERS) expect(phaseLoop(mkTask({ tier }))).not.toContain('{{')
})

test('the tier variables name the tier, the task, its agent file and the implement model', () => {
  expect(tierPromptVars(mkTask({ surface: 'web', tier: 'light' }))).toMatchObject({
    tier: 'light', task_id: 't1', agent_file: '.claude/agents/web-dev.md', implement_model: 'sonnet',
  })
  expect(tierPromptVars(mkTask()).tier).toBe('heavy')
})

test('the plan wording follows whether a plan review ran, not the current tier', () => {
  const raisedAfterSkipping = tierPromptVars(mkTask({ tier: 'standard' }))
  expect(raisedAfterSkipping.plan_status)
    .toBe('was not reviewed — read it critically, and fix it first if it is wrong')
  expect(raisedAfterSkipping.plan_review_note)
    .toBe('No plan review ran; judge the plan\'s soundness from the diff as well.')

  const loweredAfterReview = tierPromptVars(mkTask({ tier: 'light', verdict_seq: { 'plan-review': 1 } }))
  expect(loweredAfterReview.plan_status).toBe('cleared review')
  expect(loweredAfterReview.plan_review_note).toBe('')
})

test('review_count says both stages only when pr-review-intent ran', () => {
  expect(tierPromptVars(mkTask({ verdict_seq: { 'pr-review-intent': 1, 'pr-review-quality': 1 } })).review_count)
    .toBe('Both review stages cleared')
  expect(tierPromptVars(mkTask({ tier: 'light', verdict_seq: { 'pr-review': 1 } })).review_count)
    .toBe('Review cleared')
})

test('taskTiers names every task with its tier', () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  expect(taskTiers(run)).toBe('none')
  run.tasks = [mkTask({ task_id: 't1', tier: 'light' }), mkTask({ task_id: 't2' })]
  expect(taskTiers(run)).toBe('t1 light, t2 heavy')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/tier-prompt.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/models'`.

- [ ] **Step 3: Minimal implementation**

Create `src/lib/models.ts`:

```ts
/**
 * Only `implement`'s coding subagent is pinned. The orchestrator, the worker
 * session and every reviewer inherit the user's default — Opus at the worker's
 * own context size, which a bare `opus` alias could shrink. A constant, not a
 * config key: only the supervisor loads config, and the CLI renders prompts too.
 */
export const IMPLEMENT_MODEL = 'sonnet'
```

Create `src/lib/tier-prompt.ts`:

```ts
import { join } from 'node:path'
import { IMPLEMENT_MODEL } from './models'
import { nextPhase, taskRow, tierOf } from './phases'
import type { Run, Task, TaskPhase } from './types'

// The worker's part of the loop ends where CI takes over: every row past it is the
// orchestrator's or the supervisor's.
const LOOP_END: TaskPhase = 'ci'

function loopStep(phase: TaskPhase, task: Task): string {
  switch (phase) {
    case 'research': return `\`research\` → \`${task.artifacts.research ?? ''}\``
    case 'spec': return `\`spec\` → \`${task.artifacts.spec ?? ''}\``
    case 'spec-review': return '`spec-review` — you dispatch the reviewer'
    case 'plan': return `\`plan\` → \`${task.artifacts.plan ?? ''}\``
    case 'plan-review': return '`plan-review` — you dispatch the reviewer again'
    case 'implement': return '`implement` — a subagent writes the code and tests; you verify, push and open the PR'
    case 'pr-review': return '`pr-review` — one review of the PR, intent then quality'
    case 'pr-review-intent': return '`pr-review-intent` — does the PR do what was asked'
    case 'pr-review-quality': return '`pr-review-quality` — is it written the way this codebase is'
    default: return `\`${phase}\``
  }
}

/**
 * The paths are written in as text, not as `{{research_path}}`: `render()` makes
 * one pass, so a token inside a variable's value would reach the worker verbatim.
 */
export function phaseLoop(task: Task): string {
  const tier = tierOf(task)
  const steps: string[] = []
  let phase = taskRow('queued').onClear as TaskPhase
  while (phase !== LOOP_END) {
    const row = taskRow(phase)
    if (row.actor === 'worker') steps.push(`${steps.length + 1}. ${loopStep(phase, task)}`)
    phase = nextPhase(tier, row)
  }
  return steps.join('\n')
}

const reviewRan = (task: Task, phase: TaskPhase): boolean => (task.verdict_seq?.[phase] ?? 0) > 0

/**
 * Spread into every task render site, so no path can render a prompt missing one
 * of these tokens. The review wording follows which reviews actually ran, not the
 * current tier: a light task raised to standard after skipping `plan-review`
 * still has an unreviewed plan.
 */
export function tierPromptVars(task: Task): Record<string, string> {
  const planReviewed = reviewRan(task, 'plan-review')
  return {
    tier: tierOf(task),
    task_id: task.task_id,
    agent_file: join('.claude', 'agents', `${task.surface}-dev.md`),
    implement_model: IMPLEMENT_MODEL,
    phase_loop: phaseLoop(task),
    plan_status: planReviewed
      ? 'cleared review'
      : 'was not reviewed — read it critically, and fix it first if it is wrong',
    review_count: reviewRan(task, 'pr-review-intent') ? 'Both review stages cleared' : 'Review cleared',
    plan_review_note: planReviewed ? '' : 'No plan review ran; judge the plan\'s soundness from the diff as well.',
  }
}

export function taskTiers(run: Run): string {
  if (run.tasks.length === 0) return 'none'
  return run.tasks.map((task) => `${task.task_id} ${tierOf(task)}`).join(', ')
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/tier-prompt.test.ts && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/models.ts src/lib/tier-prompt.ts test/tier-prompt.test.ts
git commit -m "feat(prompts): compute the tier-dependent prompt variables in one helper"
```

---

### Task 13: Spread `tierPromptVars` into every render site

**Files:**
- Modify: `src/supervisor/tasks.ts:1-23` (imports), `:107-118` (`common`), `:543-548` (`announceDecisions`)
- Modify: `src/lib/worker-prompt.ts:1-31`
- Modify: `src/supervisor/deliver.ts:1-17` (imports), `:410-415` (`renderRunPhasePrompt` `common`)
- Test: `test/tier-prompt.test.ts` (imports and end)

- [ ] **Step 1: Write the failing test**

The probe renders each site against templates that name every tier token, so a site that lacks the
bag throws — the live prompts do not use the tokens yet (Tasks 14-16 add them).

In `test/tier-prompt.test.ts`, replace the import block (lines 1-6) with:

```ts
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDecision } from '../src/lib/decisions'
import { newRun } from '../src/lib/ledger'
import { IMPLEMENT_MODEL } from '../src/lib/models'
import { TIERS } from '../src/lib/phases'
import { phaseLoop, taskTiers, tierPromptVars } from '../src/lib/tier-prompt'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import { renderWorkerPrompt } from '../src/lib/worker-prompt'
import { renderRunPhasePrompt } from '../src/supervisor/deliver'
import { announceDecisions, renderTaskPhasePrompt } from '../src/supervisor/tasks'
import { cleanupFixtures, tempDir } from './helpers/git-worktree'

afterEach(cleanupFixtures)
```

Append:

```ts
const TIER_TOKENS =
  '{{tier}}|{{task_id}}|{{agent_file}}|{{implement_model}}|{{plan_status}}|{{review_count}}|' +
  '{{plan_review_note}}|{{phase_loop}}'

const COMMON_PROMPTS = [
  'research', 'spec', 'spec-review', 'plan', 'plan-review', 'implement', 'ci-red', 'pr-review',
  'pr-review-intent', 'pr-review-quality', 'merge', 'close',
]

function probeRoot(): string {
  const root = tempDir('hpipe-probe-')
  mkdirSync(join(root, 'prompts'))
  for (const name of [...COMMON_PROMPTS, 'worker-brief', 'decision']) {
    writeFileSync(join(root, 'prompts', `${name}.md`), TIER_TOKENS)
  }
  writeFileSync(join(root, 'prompts', 'branch-review.md'), '{{task_tiers}}')
  return root
}

function runWithOne(task: Task): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [task]
  return run
}

const PROBED = 'heavy|t1|.claude/agents/core-dev.md|sonnet|'

test('every task render site carries the tier variables', async () => {
  const root = probeRoot()
  const deps = { pluginRoot: root, ciDetail: async () => '' }
  const phases: TaskPhase[] = [
    'research', 'spec', 'spec-review', 'plan', 'plan-review', 'implement', 'pr-review',
    'pr-review-intent', 'pr-review-quality', 'merge', 'close',
  ]
  for (const phase of phases) {
    const task = mkTask({ phase })
    expect(await renderTaskPhasePrompt(runWithOne(task), task, deps, phase), phase).toContain(PROBED)
  }
  const fromCi = mkTask({ phase: 'implement' })
  expect(await renderTaskPhasePrompt(runWithOne(fromCi), fromCi, deps, 'ci')).toContain(PROBED)

  const briefed = mkTask({ phase: 'research' })
  expect(await renderWorkerPrompt(root, runWithOne(briefed), briefed)).toContain(PROBED)

  const asking = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan' })
  openDecision(asking, { question: 'q', recommendation: 'r' })
  const sent: string[] = []
  await announceDecisions(runWithOne(asking), {
    pluginRoot: root, promptRetryMax: 5,
    send: async (_pane, text) => { sent.push(text); return { ok: true } },
    checkSubmission: async () => ({ state: 'submitted' }),
  })
  expect(sent[0]).toContain(PROBED)

  const finished = runWithOne(mkTask({ task_id: 't1', tier: 'light' }))
  finished.phase = 'branch-review'
  expect(await renderRunPhasePrompt(finished, root)).toBe('t1 light')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/tier-prompt.test.ts`
Expected: FAIL — `Error: unresolved template placeholder: tier` from the first `renderTaskPhasePrompt` call.

- [ ] **Step 3: Minimal implementation**

In `src/supervisor/tasks.ts`, add to the imports (after line 17):

```ts
import { tierPromptVars } from '../lib/tier-prompt'
```

Replace lines 107-118 (`const common = {…}`) with:

```ts
  const common = {
    ...tierPromptVars(task),
    run_id: run.run_id,
    branch: task.branch,
    issue: String(task.issue),
    pr: task.pr === null ? 'unknown' : String(task.pr),
    pass: String(counterFor(task, task.phase)),
    verdict_path: absoluteArtifactPath(run, task) ?? '',
    title: run.title,
    research_path: taskArtifactPath(run, task, 'research'),
    spec_path: taskArtifactPath(run, task, 'spec'),
    plan_path: taskArtifactPath(run, task, 'plan'),
  }
```

Replace lines 543-548 (the `decision` render) with:

```ts
    const text = await renderPrompt(deps.pluginRoot, 'decision', {
      ...tierPromptVars(task),
      decision_id: decision.id,
      phase: task.decision_from ?? '', question: decision.question,
      recommendation: decision.recommendation,
      branch: task.branch, issue: String(task.issue),
    })
```

Replace `src/lib/worker-prompt.ts` lines 1-31 (imports through the `vars` literal) with:

```ts
import { briefNote, repoBootstrap } from './bootstrap'
import { taskRow } from './phases'
import { renderPrompt } from './render'
import { tierPromptVars } from './tier-prompt'
import type { Run, Task } from './types'

/**
 * The brief plus the `research` row's own prompt. A task enters `research` at
 * gate-open, before `agent start` has given it a pane, so that row's prompt has
 * no later delivery path — it ships with the brief or never arrives at all.
 *
 * Past `research` the brief goes to a fresh agent set up after a rewind, and its
 * research section — "write this note, then stop" — would contradict the phase
 * the task is actually in, so it is left out.
 */
export async function renderWorkerPrompt(
  pluginRoot: string, run: Run, task: Task,
): Promise<string> {
  const vars = {
    ...tierPromptVars(task),
    run_id: run.run_id,
    branch: task.branch,
    issue: String(task.issue),
    surface: task.surface,
    batch_context: batchContext(task.notes),
    research_path: task.artifacts.research ?? '',
    spec_path: task.artifacts.spec ?? '',
    plan_path: task.artifacts.plan ?? '',
    bootstrap_note: briefNote(repoBootstrap(run.repo_root)),
  }
```

In `src/supervisor/deliver.ts`, add to the imports (after line 9):

```ts
import { taskTiers } from '../lib/tier-prompt'
```

Replace the `common` literal in `renderRunPhasePrompt` (lines 410-415) with:

```ts
  const common = {
    run_id: run.run_id, title: run.title,
    pass: String(counterFor(run, run.phase)),
    verdict_path: verdictPath,
    repo_root: run.repo_root,
    task_tiers: taskTiers(run),
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/tier-prompt.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/tasks.ts src/lib/worker-prompt.ts src/supervisor/deliver.ts test/tier-prompt.test.ts
git commit -m "feat(prompts): spread the tier variables into every task render site"
```

---

### Task 14: Reviewer briefs — `Tier:` lines and the plan-review note

**Files:**
- Modify: `prompts/spec-review.md:19-21`, `prompts/plan-review.md:19-21`, `prompts/pr-review-intent.md:23-31`, `prompts/pr-review-quality.md:23-25`, `prompts/pr-review.md` (brief opening and Intent check), `prompts/branch-review.md:12-16`
- Test: `test/prompts.test.ts` (imports and end)

- [ ] **Step 1: Write the failing tests**

In `test/prompts.test.ts`, add below the existing imports:

```ts
import { newRun } from '../src/lib/ledger'
import type { TaskPhase } from '../src/lib/types'
import { renderRunPhasePrompt } from '../src/supervisor/deliver'
import { renderTaskPhasePrompt } from '../src/supervisor/tasks'
```

Append:

```ts
async function renderPhase(
  phase: TaskPhase, over: Partial<Task> = {}, cameFrom: TaskPhase = phase,
): Promise<string> {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  const task = briefTask({ phase, pr: 7, ...over })
  run.tasks = [task]
  return renderTaskPhasePrompt(run, task, { pluginRoot: ROOT, ciDetail: async () => '- build (fail)' }, cameFrom)
}

test('every task reviewer brief opens its review with the task\'s tier', async () => {
  for (const phase of ['spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality'] as const) {
    expect(await renderPhase(phase, { tier: 'light' }), phase)
      .toContain('Open the review with the line `Tier: light`.')
  }
})

test('the branch review opens with every task\'s tier', async () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'branch-review'
  run.tasks = [
    briefTask({ task_id: 't1', phase: 'done', tier: 'light' }),
    briefTask({ task_id: 't2', phase: 'done' }),
  ]
  expect(await renderRunPhasePrompt(run, ROOT)).toContain('Open the review with the line `Tiers: t1 light, t2 heavy`.')
})

test('no review prompt pins a model: every reviewer inherits the worker\'s', async () => {
  for (const name of REVIEW_PROMPTS) {
    expect(await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text(), name).not.toContain('model:')
  }
})

test('both reviews that judge the plan are told when no plan review ran', async () => {
  for (const phase of ['pr-review', 'pr-review-intent'] as const) {
    expect(await renderPhase(phase, { tier: 'light' }), phase)
      .toContain('the PR does not explain. No plan review ran; judge the plan\'s soundness from the diff as well.')
    expect(await renderPhase(phase, { tier: 'standard', verdict_seq: { 'plan-review': 1 } }), phase)
      .not.toContain('No plan review ran')
  }
})

test('a light task raised to heavy after skipping plan-review is told its plan went unreviewed', async () => {
  expect(await renderPhase('pr-review-intent', { tier: 'heavy', verdict_seq: { 'spec-review': 1 } }))
    .toContain('No plan review ran')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/prompts.test.ts`
Expected: FAIL — no rendered prompt contains `Open the review with the line`, and `pr-review-intent` does not carry the plan-review note.

- [ ] **Step 3: Minimal implementation**

In each of `prompts/spec-review.md`, `prompts/plan-review.md`, `prompts/pr-review-intent.md`,
`prompts/pr-review-quality.md` and `prompts/pr-review.md`, replace the line `## The reviewer's brief`
and the blank line after it with:

```markdown
## The reviewer's brief

Open the review with the line `Tier: {{tier}}`.

```

In `prompts/pr-review-intent.md` and in `prompts/pr-review.md`, replace the last line of the intent
check paragraph:

```markdown
the PR does not explain.
```

with:

```markdown
the PR does not explain. {{plan_review_note}}
```

In `prompts/branch-review.md`, replace lines 12-16 with:

```markdown
Check specifically what per-task review cannot see: seams between tasks, duplicated abstractions
introduced independently by two workers, contradictions between what the first task assumed and what
the last one built, and requirements that every individual PR passed but no PR actually implemented.

Open the review with the line `Tiers: {{task_tiers}}`.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**.
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/prompts.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail` — including Task 2's `pr-review carries the intent checks…` test, since the
note lands identically in both prompts' `Check:` paragraph.

- [ ] **Step 5: Commit**

```bash
git add prompts/spec-review.md prompts/plan-review.md prompts/pr-review-intent.md prompts/pr-review-quality.md prompts/pr-review.md prompts/branch-review.md test/prompts.test.ts
git commit -m "feat(prompts): stamp each review with its tier and flag an unreviewed plan"
```

---

### Task 15: Delegation — `implement.md`, `ci-red.md`, `answer.md`

**Files:**
- Modify: `prompts/implement.md` (whole file), `prompts/ci-red.md` (whole file), `prompts/answer.md` (append)
- Test: `test/prompts.test.ts` end

- [ ] **Step 1: Write the failing tests**

Append to `test/prompts.test.ts`:

```ts
function implementersBrief(text: string): string {
  const start = text.indexOf("## The implementer's brief")
  if (start === -1) throw new Error("no implementer's brief")
  return text.slice(start)
}

test('implement and ci-red hand the coding to a sonnet subagent carrying one scoping brief', async () => {
  const implement = await renderPhase('implement', { tier: 'standard' }, 'blocked-on-files')
  const ciRed = await renderPhase('implement', { tier: 'standard' }, 'ci')
  expect(ciRed).toContain('# CI is red')
  for (const text of [implement, ciRed]) {
    expect(text).toContain('`model: sonnet`')
    expect(text).toContain('wait for it within this turn')
    expect(text).toContain('Read `.claude/agents/core-dev.md` before your first edit')
  }
  expect(implementersBrief(ciRed)).toBe(implementersBrief(implement))
})

test('the implementer commits but never pushes, re-reads before editing, and returns questions', async () => {
  const brief = implementersBrief(await Bun.file(join(ROOT, 'prompts', 'implement.md')).text())
  expect(brief).toContain('Re-read every file you are about to touch before you edit it.')
  expect(brief).toContain('Commit, but do not push')
  expect(brief).toContain('return the question')
  expect(brief).toContain('Never commit to or push the default branch.')
})

test('ci-red addresses the worker it is delivered to', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'ci-red.md')).text()
  expect(text).not.toContain('Send the worker back')
  expect(text).toContain('gh run view --log-failed')
})

test('implement calls the plan reviewed only when a plan review ran', async () => {
  const reviewed = await renderPhase('implement', { tier: 'standard', verdict_seq: { 'plan-review': 1 } })
  expect(reviewed).toContain('The plan at `/r/c.md` cleared review.')
  for (const unreviewed of [
    await renderPhase('implement', { tier: 'light' }),
    await renderPhase('implement', { tier: 'standard' }),
  ]) {
    expect(unreviewed).toContain('was not reviewed — read it critically, and fix it first if it is wrong.')
    expect(unreviewed).not.toContain('cleared review')
  }
})

test('an answer that resumes implement keeps the coding with a fresh subagent', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'answer.md')).text()
  expect(text).toContain('dispatch a fresh one with this answer in its brief')
})
```

(`/r/c.md` is `taskArtifactPath`'s join of `briefTask`'s `checkout_path: null` → `repo_root` `/r`
with `artifacts.plan: 'c.md'`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/prompts.test.ts`
Expected: FAIL — `Error: no implementer's brief`, and `answer.md` lacks the paragraph.

- [ ] **Step 3: Minimal implementation**

Replace `prompts/implement.md` entirely with:

```markdown
# Implement — {{branch}} (#{{issue}})

The plan at `{{plan_path}}` {{plan_status}}. The files you need are yours.

You keep the judgment; one subagent writes the code. Do not write it yourself.

1. **Triage.** If you are here from a `BLOCKER` verdict (pass {{pass}}), the review is the newest file
   for this issue under `docs/superpowers/reviews/`. Decide which findings you accept. Every BLOCKER
   and every MAJOR you accept goes to the subagent before anything else; answer the ones you reject
   in the PR body rather than silently ignoring them.
2. **Dispatch.** Dispatch one subagent with `model: {{implement_model}}`, and
   **wait for it within this turn**. Backgrounding it ends your turn and leaves this pane reading
   idle while the code is still being written, and the supervisor then treats a healthy worker as a
   stalled one. Its brief is the plan path, `{{plan_path}}`; the findings you accepted, if any; and
   the implementer's brief below, verbatim.
3. **Continue.** If the subagent returns with steps unfinished, dispatch a fresh one, starting at the
   first unfinished step. If it returns a question, raise it with `{{hpipe}} decide` as your brief
   describes, and end your turn.
4. **Verify and ship.** Run the tests and the typecheck yourself and read their output. When both are
   green, push, and open the PR. Its body ends with a real closing keyword:

       Closes #{{issue}}

   "Implements #{{issue}}" does **not** auto-close the issue and is treated as a failure.
5. **Fallback.** If the dispatch is rejected for its model, dispatch without `model:` and say so in
   the PR body.

Push before your turn ends. The supervisor watches the branch and the PR head, not this pane.

## The implementer's brief

Read `{{agent_file}}` before your first edit: it is the scoped guide for this surface, and the repo's
root `CLAUDE.md` outranks it where they conflict. Work only in this worktree, only on `{{branch}}`.
Never commit to or push the default branch.

Re-read every file you are about to touch before you edit it. A sibling task may have landed changes
on the same files while this one waited; code written against the old text will conflict, or will
quietly undo work that has already merged. Where the tree has moved under what you were given,
follow the tree and say so in your report.

Work step by step, in order: the failing test first, run it, the minimum code that passes it, run it
again, commit. One commit per step. Do not batch steps, and do not skip a step's test because the
change looks obvious. Commit, but do not push: pushing is the worker's, once it has verified your
work.

You cannot ask for decisions. On a choice you should not make alone — expensive to undo, changes
scope, commits another surface to a contract, or invents a pattern this repo does not already
establish — stop and return the question, with your recommendation, instead of choosing. End your
report with which steps you finished and which you did not.
```

Replace `prompts/ci-red.md` entirely with:

```markdown
# CI is red — {{branch}} (#{{issue}}), PR #{{pr}}

CI failed on PR #{{pr}}. The failing checks:

{{ci_failure}}

This is your PR to fix. Read the actual failure output before deciding what is wrong —
`gh run view --log-failed` — rather than guessing from the check name.

If the failure is environmental rather than a defect in this branch, say so in the PR and re-run the
check instead of editing code.

If it is a defect, you keep the judgment and one subagent writes the fix. Dispatch it with
`model: {{implement_model}}`, and **wait for it within this turn**: a backgrounded subagent leaves this
pane reading idle while the fix is still being written. Its brief is the failing output, what you
concluded from the log, and the implementer's brief below, verbatim. If it returns a question, raise
it with `{{hpipe}} decide` and end your turn. If the dispatch is rejected for its model, dispatch
without `model:` and say so in the PR.

When it returns, run the tests and the typecheck yourself, read their output, and push. The
supervisor watches the PR head, not this pane.

## The implementer's brief

Read `{{agent_file}}` before your first edit: it is the scoped guide for this surface, and the repo's
root `CLAUDE.md` outranks it where they conflict. Work only in this worktree, only on `{{branch}}`.
Never commit to or push the default branch.

Re-read every file you are about to touch before you edit it. A sibling task may have landed changes
on the same files while this one waited; code written against the old text will conflict, or will
quietly undo work that has already merged. Where the tree has moved under what you were given,
follow the tree and say so in your report.

Work step by step, in order: the failing test first, run it, the minimum code that passes it, run it
again, commit. One commit per step. Do not batch steps, and do not skip a step's test because the
change looks obvious. Commit, but do not push: pushing is the worker's, once it has verified your
work.

You cannot ask for decisions. On a choice you should not make alone — expensive to undo, changes
scope, commits another surface to a contract, or invents a pattern this repo does not already
establish — stop and return the question, with your recommendation, instead of choosing. End your
report with which steps you finished and which you did not.
```

Append to `prompts/answer.md` (after its last line, with one blank line between):

```markdown

If the phase you are resuming is `implement`, the coding still goes to an implement subagent as the
`implement` prompt describes — dispatch a fresh one with this answer in its brief, starting at the
first unfinished step.
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/prompts.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail` — including `test/tasks.test.ts`'s `a red CI yields the ci-red prompt…`
(`CI is red`, `build (fail)`) and `test/cli-commands.test.ts`'s `# Implement — b (#1)` rewind
assertions, whose headings are unchanged.

- [ ] **Step 5: Commit**

```bash
git add prompts/implement.md prompts/ci-red.md prompts/answer.md test/prompts.test.ts
git commit -m "feat(prompts): hand implement's coding to a sonnet subagent, CI fixes included"
```

---

### Task 16: The brief, merge, research, decision, intake and dispatch prompts

**Files:**
- Modify: `prompts/worker-brief.md:18-40`, `prompts/merge.md:3`, `prompts/research.md:17-19`, `prompts/decision.md:26`, `prompts/intake.md:22-43`, `prompts/dispatch.md:55-58,66-68`
- Test: `test/prompts.test.ts:279-287` and end

- [ ] **Step 1: Write the failing tests**

In `test/prompts.test.ts`, replace lines 283-285 (inside `the dispatch prompt names every header line…`) with:

```ts
  for (const line of ['task_id:', 'tier:', 'issue:', 'files:', 'bootstrap:', 'base:']) {
    expect(text).toContain(`\`${line}\``)
  }
```

Add to the imports:

```ts
import { openDecision } from '../src/lib/decisions'
import { announceDecisions } from '../src/supervisor/tasks'
```

(merge `announceDecisions` into the existing `renderTaskPhasePrompt` import line from Task 14:
`import { announceDecisions, renderTaskPhasePrompt } from '../src/supervisor/tasks'`).

Append:

```ts
test('the brief lists only the phases its tier runs, with the paths written in', async () => {
  const light = await renderBriefFor([briefTask({ tier: 'light' })], 0)
  expect(light).toContain('1. `research` → `a.md`')
  expect(light).toContain('4. `plan` → `c.md`')
  expect(light).toContain('6. `pr-review` — one review of the PR, intent then quality')
  expect(light).not.toContain('`plan-review`')

  const heavy = await renderBriefFor([briefTask({ tier: 'heavy' })], 0)
  expect(heavy).toContain('5. `plan-review` — you dispatch the reviewer again')
  expect(heavy).toContain('8. `pr-review-quality`')
  expect(heavy).not.toContain('`pr-review` —')
})

test('the brief names the tier, forbids lowering it, and says how to raise it', async () => {
  const text = await renderBriefFor([briefTask({ tier: 'standard' })], 0)
  expect(text).toContain('Your review tier is `standard`: it decides which of those reviews run. Never lower it.')
  expect(text).toMatch(/ tier --task t1 <higher> --why "<what you found>"/)
  const raw = await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text()
  expect(raw).toContain('{{phase_loop}}')
  expect(raw).not.toContain('Between `plan-review` and `implement`')
})

test('research tells the worker to raise a tier that is too low before the spec is written', async () => {
  const text = await renderPhase('research', { tier: 'light' })
  expect(text).toContain('Your review tier is `light`.')
  expect(text).toMatch(/ tier --task t1 <standard\|heavy> --why "<what you found>"/)
})

test('the decision prompt tells the orchestrator to raise the tier when an answer grows the task', async () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  const task = briefTask({ phase: 'blocked-on-decision', decision_from: 'plan', tier: 'light', pane_id: 'w7:p1' })
  openDecision(task, { question: 'q', recommendation: 'r' })
  run.tasks = [task]
  const sent: string[] = []
  await announceDecisions(run, {
    pluginRoot: ROOT, promptRetryMax: 5,
    send: async (_pane, text) => { sent.push(text); return { ok: true } },
    checkSubmission: async () => ({ state: 'submitted' }),
  })
  expect(sent[0]).toContain('`t1` runs the `light` review tier.')
  expect(sent[0]).toMatch(/ tier --task t1 <standard\|heavy> --why "<what the answer adds>"/)
  expect(sent[0]).toContain('Never lower a tier.')
})

test('merge counts the review stages that actually ran', async () => {
  expect(await renderPhase('merge', { tier: 'heavy', verdict_seq: { 'pr-review-intent': 1, 'pr-review-quality': 1 } }))
    .toContain('Both review stages cleared and CI is green on PR #7.')
  expect(await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 } }))
    .toContain('Review cleared and CI is green on PR #7.')
})

test('intake explains the tiers and registers with --tier', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'intake.md')).text()
  expect(text).toContain('[--tier light|standard|heavy]')
  expect(text).toContain('When unsure, pick the higher tier: under-review is the costly mistake.')
  expect(text).toContain('`pipeline:tier-<name>`')
  expect(text).toContain('Never lower a tier')
  expect(text).toContain('then a `tier:` line')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/prompts.test.ts`
Expected: FAIL — the brief still carries the fixed seven-step loop (`plan-review` present on light),
`merge` still says `Both review stages cleared` for light, and `dispatch.md` does not name `` `tier:` ``.

- [ ] **Step 3: Minimal implementation**

Replace `prompts/worker-brief.md` lines 18-40 (from `## The loop` through the paragraph ending
`silently undo their work.`) with:

```markdown
## The loop

You are driven one phase at a time. Each phase's instructions arrive as a prompt in this pane; do
that phase, commit, push, and stop. Do not run ahead — a phase completes when its file is on the
branch, not when you feel finished.

{{phase_loop}}

Those paths are relative to this worktree, which is your cwd. Write them exactly as given, stem and
all — do not re-derive them from the conventions you see in `docs/`. The stem carries the issue
number, and every later phase cites the path by name. An artifact written anywhere else
does not satisfy this phase's contract.

Your review tier is `{{tier}}`: it decides which of those reviews run. Never lower it. If research
shows the task is bigger than its tier — another surface, a contract, a migration — raise it:
`{{hpipe}} tier --task {{task_id}} <higher> --why "<what you found>"`.

Before `implement` you may wait — a sibling task holding files you need has to land first. When
`implement` starts, the subagent that writes the code re-reads every file before it edits it, and you
re-read them too: to triage review findings, and to brief it. A sibling may have rewritten them while
you waited, and a plan written against the old text will conflict or silently undo their work.
```

Replace `prompts/merge.md` line 3 with:

```markdown
{{review_count}} and CI is green on PR #{{pr}}.
```

Replace `prompts/research.md` lines 17-19 (from `It may be short.` to the end) with:

```markdown
It may be short. It may not be empty, and it may not simply restate the issue.

Your review tier is `{{tier}}`. If what you found shows the task is bigger than that — it reaches
another surface, changes a contract, or needs a migration — raise it before the spec is written:

    {{hpipe}} tier --task {{task_id}} <standard|heavy> --why "<what you found>"

Never lower it.

Commit and push it, then stop. The spec is the next phase and arrives on its own.
```

In `prompts/decision.md`, insert before line 26 (`## Either way, record the answer`):

```markdown
## If the answer grows the task, raise its tier

`{{task_id}}` runs the `{{tier}}` review tier. A decision is often where scope grows: if your answer
takes the task onto another surface, into a contract or into a migration, raise its tier before you
record the answer:

    {{hpipe}} tier --task {{task_id}} <standard|heavy> --why "<what the answer adds>"

Never lower a tier. The phase the worker is in still completes; the step after it follows the new
tier.

```

Replace `prompts/intake.md` lines 22-43 (step 4, from `4. **Register each one:**` through
`returns.`) with:

```markdown
4. **Register each one:**

       {{hpipe}} task --branch <branch> --issue <n> --surface <surface> \
                  [--tier light|standard|heavy] \
                  [--depends-on <id,id>] [--files <prefix,prefix>] \
                  [--notes "<batch context that does not belong in a public issue>"]

   Not filed yet? `--title "<title>" --body-file <path>` in place of `--issue <n>` files the issue
   with that body and registers it in one step, and prints `issue: #<n> (filed)`. The body file is
   the same brief step 3 asks for — write it just as carefully.

   `--tier` decides which reviews the task runs. `light` skips `plan-review` and gets one combined
   PR review; `standard` keeps `plan-review` and the combined PR review; `heavy` runs every review,
   with the PR reviewed in two separate stages. Pick it from the issue:

   - **light** — one surface, a handful of files, and the issue already pins down the exact change:
     no API, contract or schema decision left open.
   - **heavy** — changes a contract another surface consumes, migrates data, touches security or
     auth, concurrency, or state-machine code; or you are not sure.
   - **standard** — everything else.

   When unsure, pick the higher tier: under-review is the costly mistake. With no `--tier` a task is
   `standard`, and an issue labelled `pipeline:tier-<name>` overrides `--tier`. Never lower a tier
   once the task is running; a worker or a decision that finds it too low raises it.

   `--surface` routes the worker to `.claude/agents/<surface>-dev.md` and is rejected if no such file
   exists. `--files` and `--depends-on` are **comma-separated**: a value containing whitespace is
   rejected, and repeating either flag adds to it rather than replacing it. `{{hpipe}} task` prints the
   task id, then a `tier:` line naming the tier it recorded and why, then a `files:` line echoing
   exactly what it recorded (or `files: none`) — check both say what you meant — and then either the
   worker brief to dispatch or `queued: waiting on …`, which is correct, and you will be told when
   that task is ready. A brief to dispatch comes with a `base: <commit> (…)` line: cut that task's
   worktree from that commit (`herdr worktree create … --base <commit>`), never from your local
   `main`, which is only as new as your last pull. Under it, `dispatch, in order:` lists the whole
   dispatch with that commit already filled in — worktree, bootstrap,
   `agent start … -- --dangerously-skip-permissions`, `dispatch --task` — so run it as printed,
   filling in the pane and path the create response returns.
```

Replace `prompts/dispatch.md` lines 55-58 (from `own. When it came from` through `before `agent start`.`) with:

```markdown
own. When it came from `{{hpipe}} task`, the header lines above it — `task_id:`, `tier:`, `issue:`
when it filed one, `files:`, `bootstrap:`, `base:` and the `dispatch, in order:` block — are yours:
confirm the `tier:` and `files:` lines match what you declared, then run the block, which cuts the
worktree from the `base:` commit and runs what `bootstrap:` names in the new checkout before
`agent start`.
```

and lines 66-68 (the registration example) with:

```markdown
    {{hpipe}} task --branch <branch> --issue <n> --surface <surface> \
               [--tier light|standard|heavy] \
               [--depends-on <id,id>] [--files <prefix,prefix>] \
               [--notes "<batch context that does not belong in a public issue>"]
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/prompts.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail` — including the existing `'the dispatch prompt shows the same agent start line…'`,
`'both dispatch paths point the orchestrator at the base: line…'` and `'no prompt hardcodes the hpipe binary'` tests.

- [ ] **Step 5: Commit**

```bash
git add prompts/worker-brief.md prompts/merge.md prompts/research.md prompts/decision.md prompts/intake.md prompts/dispatch.md test/prompts.test.ts
git commit -m "feat(prompts): route the brief's loop by tier and tell agents how to raise one"
```

---

### Task 17: Render coverage — every prompt, every tier, every path

**Files:**
- Test: `test/prompts.test.ts` (imports and end)

- [ ] **Step 1: Write the test**

Add to the imports of `test/prompts.test.ts`:

```ts
import { TASK_ROWS, TIERS } from '../src/lib/phases'
import { renderWorkerPrompt } from '../src/lib/worker-prompt'
```

Append:

```ts
test('every prompt renders for every tier on every path with no placeholder left', async () => {
  for (const tier of TIERS) {
    const rendered: Array<[string, string]> = []

    for (const row of TASK_ROWS.filter((r) => r.prompt !== undefined)) {
      rendered.push([row.phase, await renderPhase(row.phase, { tier, escalated_from: 'implement' })])
    }
    rendered.push(['implement from blocked-on-files', await renderPhase('implement', { tier }, 'blocked-on-files')])
    rendered.push(['implement from ci', await renderPhase('implement', { tier }, 'ci')])

    const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
    run.orchestrator_pane = 'w1:p1'
    const task = briefTask({ tier })
    run.tasks = [task]
    rendered.push(['brief and research', await renderWorkerPrompt(ROOT, run, task)])

    const asking = briefTask({ phase: 'blocked-on-decision', decision_from: 'implement', tier, pane_id: 'w7:p1' })
    openDecision(asking, { question: 'q', recommendation: 'r' })
    run.tasks = [asking]
    const sent: string[] = []
    await announceDecisions(run, {
      pluginRoot: ROOT, promptRetryMax: 5,
      send: async (_pane, text) => { sent.push(text); return { ok: true } },
      checkSubmission: async () => ({ state: 'submitted' }),
    })
    rendered.push(['decision', sent[0] ?? '(not sent)'])

    run.phase = 'branch-review'
    run.tasks = [briefTask({ task_id: 't1', phase: 'done', tier })]
    rendered.push(['branch-review', await renderRunPhasePrompt(run, ROOT)])

    for (const [what, text] of rendered) expect(text, `${tier}: ${what}`).not.toContain('{{')
  }
})
```

- [ ] **Step 2: Run it**

Run: `bun test test/prompts.test.ts`
Expected: PASS. This is the spec §5 render-coverage guard; with Tasks 13-16 in place it is green on
first run. Prove it bites: temporarily delete `...tierPromptVars(task),` from `renderTaskPhasePrompt`'s
`common` in `src/supervisor/tasks.ts` and re-run — expected FAIL with
`unresolved template placeholder: tier`. Restore the line.

- [ ] **Step 3: Minimal implementation**

None — the test guards Tasks 13-16.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test && bun run typecheck`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add test/prompts.test.ts
git commit -m "test(prompts): render every prompt for every tier on every delivery path"
```

---

### Task 18: README and the `herdr-pipeline` skill

**Files:**
- Modify: `README.md:6-9`, `:120-123`, after `:147` (new sections), `:161-173` (Getting out table)
- Modify: `skills/herdr-pipeline/SKILL.md:3`, `:17-29` (Ground rules), `:33-41` (step 2), `:50-58` (While it runs), `:62-75` (Recovery)
- Test: `test/prompts.test.ts` end
- Do **not** edit `CHANGELOG.md`: release-please owns it.

- [ ] **Step 1: Write the failing tests**

Append to `test/prompts.test.ts`:

```ts
test('the README documents tiers, their labels, hpipe tier, the model split and the restart', async () => {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  for (const needle of [
    '## Review tiers', '--tier light|standard|heavy', 'pipeline:tier-light', 'hpipe tier --task',
    'Run Claude with Opus as the default model', 'Restart the supervisor after upgrading',
    'skips the final `branch-review`',
  ]) {
    expect(readme, needle).toContain(needle)
  }
})

test('the skill teaches tiers, hpipe tier, the model requirement and the restart', async () => {
  const skill = await Bun.file(join(ROOT, 'skills', 'herdr-pipeline', 'SKILL.md')).text()
  for (const needle of [
    'hpipe tier --task', 'pipeline:tier-<name>', '--tier light|standard|heavy',
    'Run Claude with Opus as the default model', 'Restart the supervisor after upgrading',
  ]) {
    expect(skill, needle).toContain(needle)
  }
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/prompts.test.ts`
Expected: FAIL — `## Review tiers` is not in the README; `hpipe tier --task` is not in the skill.

- [ ] **Step 3: Minimal implementation**

In `README.md`, replace lines 6-9 (the second paragraph) with:

```markdown
One **worker** agent owns each GitHub issue end to end: research → spec → adversarial review → plan →
adversarial review → implement → PR review → CI → merge → close → teardown, with the reviews a task
runs set by its **tier** (below). The **orchestrator** keeps intake (research the problem, file the
issue, dispatch), decision triage, merge, close, and the whole-branch review at the end.
```

Replace the registration example (lines 120-122) with:

```markdown
    hpipe task --branch <branch> --issue <n> --surface <surface> \
               [--tier light|standard|heavy] \
               [--depends-on <id,id>] [--files <prefix,prefix>] [--notes <batch context>] \
               [--run <run-id>]
```

Insert before `## Answering a decision` (line 149):

```markdown
## Review tiers

Every task carries a tier that decides which reviews it runs:

| Tier | `spec-review` | `plan-review` | PR review |
|---|---|---|---|
| `light` | ✓ | – | one combined `pr-review` |
| `standard` | ✓ | ✓ | one combined `pr-review` |
| `heavy` | ✓ | ✓ | `pr-review-intent`, then `pr-review-quality` |

The orchestrator sets it at registration with `--tier light|standard|heavy`; a new task defaults to
`standard`. An issue labelled `pipeline:tier-light`, `pipeline:tier-standard` or `pipeline:tier-heavy`
overrides `--tier`, and an issue carrying two tier labels is refused. Labels are read once, at
registration, and `hpipe task` prints the result as `tier: <tier> (<why>)`.

Mid-run, `hpipe tier --task <id> <tier> --why "<reason>"` changes it. Raising works from any pane;
lowering is refused from the orchestrator's and the workers' panes, so run it from your own. The
phase the task is in always completes; only the next step follows the new tier, and a raise never goes
back for a review already skipped (`hpipe rewind` does). `hpipe show --task <id>` prints the tier, its
log, and every phase the task visited.

A run in which at most one task landed skips the final `branch-review` and finishes.

## Models

Judgment stays on Opus: the orchestrator, every worker session and every reviewer subagent inherit
your default model, and only `implement`'s code-writing is handed to a subagent pinned to Sonnet.
Run Claude with Opus as the default model. Nothing pins the worker panes, so a Sonnet default would
put the judgment on Sonnet too.

## Upgrading

Restart the supervisor after upgrading the plugin, in every session with a run in flight: close its
`Pipeline supervisor` pane and run the plugin's `supervisor` action, or restart the session. A
supervisor still running the old code beside a new CLI routes a task by the old phase table while the
CLI briefs it on the new one. The review-tiers release also changes the on-disk format: a ledger
holding a task in `pr-review` cannot be read by an earlier version, so finish or abort those runs
before rolling back. Tasks registered before tiers existed carry none and run as `heavy` — every
review, as before.

```

In the `## Getting out` table, insert after the `A task is escalated` row:

```markdown
| A task needs more (or less) review than its tier | `hpipe tier --task <id> <tier> --why "<reason>"`. Lowering is refused from pipeline panes; run it from your own |
```

In `skills/herdr-pipeline/SKILL.md`, replace line 3 (the `description:`) with:

```markdown
description: Use when running, orchestrating, checking on or unsticking a batch of GitHub issues through the herdr pipeline plugin (stein.pipeline) — the `hpipe` CLI (start, task, tier, dispatch, status, show, decide, answer, rewind, release, forget), review tiers, worker agents in herdr worktrees, escalated or stalled tasks, "stuck input", "waiting on you", or a dead orchestrator/supervisor pane.
```

Append to the `## Ground rules` bullet list (after the `--surface` bullet):

```markdown
- Run Claude with Opus as the default model. The orchestrator, the workers and every reviewer
  inherit it; only `implement`'s coding subagent is pinned, to Sonnet.
```

In `## Running a batch`, insert after step 2's paragraph (after `` `--title` prints `issue: #<n> (filed)`. ``):

```markdown
   Pick a tier with `--tier light|standard|heavy` (default `standard`). **light**: one surface, a
   handful of files, the issue pins the exact change. **heavy**: a contract another surface
   consumes, a data migration, security/auth, concurrency or state-machine code — or you are
   unsure. **standard**: the rest. When unsure, go higher. A `pipeline:tier-<name>` issue label
   overrides `--tier`; two tier labels are refused. The `tier:` line under `task_id:` says what was
   recorded and why. light skips `plan-review`; light and standard get one combined `pr-review`;
   heavy runs `pr-review-intent` then `pr-review-quality`.
```

In the `## While it runs` table, insert before the `Anything else` row:

```markdown
| A task turns out bigger than its tier (research or a decision finds a contract, a migration, another surface) | `hpipe tier --task <id> <higher> --why "…"`. The current phase completes; only the next step changes. Never lower a tier: it is refused from pipeline panes, so the user runs it from their own. `hpipe show --task <id>` prints `tier:`, `tier log:` and `visited:` |
```

In the `## Recovery` table, insert as the last row:

```markdown
| Plugin upgraded | Restart the supervisor after upgrading: close the `Pipeline supervisor` pane, then `herdr plugin action invoke supervisor --plugin stein.pipeline` (or restart the session). An old supervisor beside a new CLI routes tasks by the old table |
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/prompts.test.ts && bun test && bun run typecheck`
Expected: PASS, `0 fail` — including the existing README tests (`bin/hpipe`, `There is nothing else to install`, `.claude/pipeline-bootstrap`).

- [ ] **Step 5: Commit**

```bash
git add README.md skills/herdr-pipeline/SKILL.md test/prompts.test.ts
git commit -m "docs: document review tiers, hpipe tier, the model split and restarting after upgrade"
```

---

### Task 19: Final verification, PR, and the live smoke run

**Files:**
- Create (after the live run): `docs/superpowers/reviews/<date>-live-smoke-run-4.md`

This task changes startup-adjacent routing, gating (`blocked-on-files` after a skipped
`plan-review`), delivery (the new `pr-review` prompt, the Sonnet dispatch inside the worker's turn)
and the run's end (`branch-review` skip). The unit suite cannot prove any of that against herdr; the
live run does. **A difference between this checklist and what you observe is a finding to write
down, not a test to make pass.** Do not edit the plugin mid-run.

- [ ] **Step 1: Full suite and typecheck**

Run: `bun test`
Expected: the summary ends `N pass` / `0 fail` with N above the pre-change 1028.

Run: `bun run typecheck`
Expected: prints `$ tsc --noEmit` and exits 0 with no diagnostics.

Run: `grep -rn "anyTaskDone" src test`
Expected: no output.

- [ ] **Step 2: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat: review tiers and model routing" --body "Implements docs/superpowers/specs/2026-09-25-review-tiers-and-model-routing-design.md.

On-disk format change: a ledger holding a task in pr-review cannot be read by an earlier build. Restart the supervisor after upgrading."
```

Expected: a PR URL. Merging and the release are the human's; the live run below needs the released
build installed.

- [ ] **Step 3: Install the release and restart every supervisor**

After release-please has cut the release carrying this PR:

```bash
herdr plugin install victorstein/herdr-plugin-pipeline
herdr plugin list --json | jq '.[] | select(.id == "stein.pipeline") | {version, plugin_root}'
```

Expected: the new version. Then, in **every** session with a supervisor (including `default`): close
its `Pipeline supervisor` pane and run `herdr plugin action invoke supervisor --plugin stein.pipeline`
from a pane in that session. Check `hpipe status` reports `supervisor: live (pid …)` with a new pid.
Never link the checkout instead: that is the self-hosting hazard.

- [ ] **Step 4: Set up the smoke session** (mirrors `docs/superpowers/reviews/2026-09-25-live-smoke-run-3.md`)

```bash
export SMOKE=pipesmoke4
herdr --session "$SMOKE" server &
herdr --session "$SMOKE" workspace list   # a workspace labelled "pipeline"
herdr --session "$SMOKE" pane list        # exactly ONE "Pipeline supervisor" pane
```

Open an orchestrator pane in `$SMOKE`, `cd` into a clone of `victorstein/hpipe-smoke`, `git pull`,
and check `echo "$HERDR_SESSION"` prints `pipesmoke4`. `ls .claude/agents/` gives the `--surface`
value (below `<s>`). Start Claude there with Opus as the default model (confirm with `/model`), and
give it the `herdr-pipeline` skill. Start a scratch **human** pane in the same session for the
commands the orchestrator must not run. Record everything under a scratchpad `r4/out/` as run 3 did
(pane captures, `hpipe status` every 5s, ledger copies).

Create the tier labels once:

```bash
for t in light standard heavy; do gh label create "pipeline:tier-$t" --repo victorstein/hpipe-smoke --force; done
```

- [ ] **Step 5: Batch A — one task per tier**

File three issues on `victorstein/hpipe-smoke`: a one-file helper with the exact change spelled out
(L), a small feature touching two files (S), and a change to a function signature another module
consumes (H). Label L `pipeline:tier-light`. From the orchestrator pane:

```bash
hpipe start "smoke batch 4a"
hpipe task --branch smoke/light --issue <L> --surface <s> --tier standard
hpipe task --branch smoke/standard --issue <S> --surface <s>
hpipe task --branch smoke/heavy --issue <H> --surface <s> --tier heavy --files <prefix H touches>
hpipe dispatch --done
```

Check, and record each observation:

| Check | Expected |
|---|---|
| `tier:` lines printed by `hpipe task` | `tier: light (label pipeline:tier-light; --tier said standard)`, `tier: standard (default)`, `tier: heavy (--tier)` |
| `hpipe status` task lines | `t1 smoke/light #<L> [<phase> <n>m] light …`, `standard` for t2, `heavy` for t3 |
| t1's worker during `implement` (`herdr pane read <t1 pane>`, and the captures) | the worker dispatches one subagent with `model: sonnet` and waits for it in the same turn; the pane reads `working` throughout; the worker, not the subagent, pushes and opens the PR |
| Verdict files (`head -1 docs/superpowers/reviews/issue-<n>-*.md` on each branch) | first line `Tier: light` / `Tier: standard` / `Tier: heavy` |
| `hpipe show --task t1 --run <run>` after `done` | `visited:` has `pr-review`, and no `plan-review`, `pr-review-intent` or `pr-review-quality` |
| `hpipe show --task t2 …` | `visited:` has `plan-review` and `pr-review`; no `pr-review-intent`/`pr-review-quality` |
| `hpipe show --task t3 …` | `visited:` has `plan-review`, `pr-review-intent`, `pr-review-quality`; no bare `pr-review` step |
| t1's `blocked-on-files` → `implement` after skipping `plan-review` | the gate still widens from t1's plan (supervisor log `plan widened files by …` if its plan declares new files) |
| Run end | `branch-review` runs; its verdict file opens `Tiers: t1 light, t2 standard, t3 heavy`; run `done` |

- [ ] **Step 6: Batch B — a light task raised after research**

File one small issue (B), no label. From the orchestrator pane:

```bash
hpipe start "smoke batch 4b"
hpipe task --branch smoke/raise --issue <B> --surface <s> --tier light
hpipe dispatch --done
```

When `hpipe status` shows t1 has left `research` (in `spec`), from the orchestrator pane first:

```bash
hpipe tier --task t1 light --why "smoke: same tier"         # t1 is already light; nothing changed
hpipe tier --task t1 standard --why "smoke: raise after research"
```

then from the **orchestrator** pane try to lower it, which must be refused:

```bash
hpipe tier --task t1 light --why "smoke: lowering from a pipeline pane"
# lowering a tier needs a human; run this from your own pane   (exit 1)
```

Check:

| Check | Expected |
|---|---|
| `hpipe show --task t1` right after the raise | `tier: standard`; `tier log:` shows `— → light (--tier) · <time> light → standard (hpipe-tier, pane <orchestrator pane>): smoke: raise after research` |
| `hpipe status` | `… standard …` on t1's line; the raise added no line to the run's history (`jq '.history[-1]' <ledger>`) |
| t1's phases | `plan` clears to `plan-review` (not `blocked-on-files`) |
| The `implement` prompt t1 receives | `The plan at … cleared review.` |
| Run end | run history's last entry `execute → done`, why `one task landed; branch-review skipped`; no branch-review verdict file |

- [ ] **Step 7: Write up and tear down**

Write `docs/superpowers/reviews/<date>-live-smoke-run-4.md` in run 3's shape: header (date, plugin
version and commit, session, repo, runs and tasks), a verdict, a table per batch with expected /
observed / result, new findings with severity, and teardown. File any finding as a GitHub issue.
Tear down as run 3 did: stop the `pipesmoke4` server and delete the session, remove its plugin state,
close the smoke issues and delete the `smoke/*` branches (local and remote), force-remove leftover
worktrees, and leave the smoke checkout clean on `main`.

```bash
git add docs/superpowers/reviews/<date>-live-smoke-run-4.md
git commit -m "docs: record live smoke run 4 of review tiers and model routing"
```

---

## Spec coverage

| Spec section / requirement | Task |
|---|---|
| On-disk format change; restart after upgrade | Plan header; 18 (README, skill); 19 step 3 |
| Decisions: tier set at intake, label overrides; default `standard` / old ledger `heavy` | 1 (`tierOf`), 7, 8 |
| Decisions: raise anywhere, lower refused from pipeline panes | 7 (`pipelinePanes`, `isLowering`), 9 |
| Decisions: tier table (what each tier runs) | 2 (`tiers`, `nextPhase`) |
| Decisions: `branch-review` skipped at ≤ 1 landed | 5 |
| Decisions: models — `IMPLEMENT_MODEL` constant, reviewers and panes unpinned | 12 (`models.ts`), 14 (no `model:` in reviews), 15 (delegation) |
| §1 `Task.tier` / `tier_history` / `TierChange`; `tierOf`; not written back | 1, 3 (routing test) |
| §1 tier changes only in `tier_history`, never `run.history` | 9 (test asserts history length) |
| §1 phase table: `pr-review` row, `implement.onClear`, `tiers`, `PhaseRow.tiers` | 2 |
| §1 `models.ts` | 12 |
| §1 `nextPhase`; every forward read through it (`advanceLoopingRow`, research/spec/plan, implement, `workerStillNeeded`, brief loop) | 2, 3, 4, 12 (`phaseLoop`) |
| §1 `queued → research` reads stay raw | unchanged (no task touches them) |
| §1 site table: `advanceTask` case, `renderTaskPhasePrompt` case, `gatherSignals` case, `REVIEW_PROMPTS`/`ALL`, `WORKER_REVIEW_PROMPTS` | 3, 4, 2 |
| §1 `PHASES_BEFORE_A_PR` unchanged | unchanged |
| §1 rewind onto an excluded row warns | 11 |
| §2 `hpipe task --tier`; `readLabels` injected and memoised; filed issue skips the read | 6, 8 |
| §2 label wins; two labels refused; unknown value/suffix refused; gh failure falls back | 7, 8 |
| §2 printed `tier:` line after `task_id:`; registration `tier_history` entry | 8 |
| §2 `hpipe tier`: `retryingOnStale`, `--why` required, raise, lower guard, no-op, terminal refused | 9 |
| §2 known gap (moved/rebound panes) | 7 (`pipelinePanes` doc comment) |
| §2 the current phase always completes | 3 (lowered/raised routing tests), 9 (output text) |
| §2 who is told to raise: research, decision, brief, orchestrator never-lower | 16 |
| §2 intake guidance | 16 |
| §2 visibility: status tier bit; `show` tier / tier log / visited; `visitedPhases` | 10 |
| §3 `tierPromptVars` (all eight variables, `agent_file` moved, literal paths, `verdict_seq`-based wording) | 12 |
| §3 spread at every render site (`renderTaskPhasePrompt`, `renderWorkerPrompt`, `announceDecisions`, `renderRunPhasePrompt` `task_tiers`) | 13 |
| §3 `implement.md` delegation (triage, dispatch + wait, scoping brief, continue, verify and ship, fallback, `{{plan_status}}`) | 15 |
| §3 `answer.md` static paragraph | 15 |
| §3 `ci-red.md` rewritten to the worker, same delegation and identical scoping block | 15 |
| §3 review prompts: no model; `Tier:` line; `Tiers:` in branch-review | 14 |
| §3 `pr-review.md` (intent + quality verbatim, one trailer, `{{plan_review_note}}`); note in `pr-review-intent.md` | 2, 14 |
| §3 `worker-brief.md`: `{{phase_loop}}`, tier-neutral wait paragraph, never-lower line | 16 |
| §3 `merge.md` `{{review_count}}` | 16 |
| §3 docs: README and skill | 18 |
| §4 `landedTaskCount` (done/orphaned with `merged_at_ms !== null`); 0/1/≥2 outcomes | 5 |
| §5 table invariants: walk reaches `ci` via `implement`; no tiered `onBlocker` target; reached actor rows have prompts | 2 |
| §5 every verdict row advanced end to end through a tick | 4 |
| §5 every worker row renders non-empty | 4 |
| §5 unit: `nextPhase` every (tier, row); `advanceTask` per tier; old ledger heavy, not written back | 2, 3, 1 |
| §5 unit: `hpipe tier` cases; registration cases; `readLabels` once across a stale retry | 9, 8 |
| §5 unit: `branch-review` skip at 0/1/2, done vs merged orphaned vs unmerged orphaned | 5 |
| §5 unit: `formatTaskDetail`, `visitedPhases`, status line | 10 |
| §5 render coverage (every prompt, every tier, both `implement` entries, brief, decision, branch-review) | 17 (and the wiring probe in 13) |
| §5 rendered content (loop per tier, literal paths, `plan_status`/`review_count`/`plan_review_note`, `model: sonnet`, no `model:` in reviews, scoping block + agent file in both, answer paragraph, `Tier:` lines) | 12, 14, 15, 16 |
| §5 `pr-review` in the prompt contract lists | 2 |
| §5 live smoke run, Batch A and Batch B | 19 |
| Out of scope (collapsing artifacts, cost accounting, tier-dependent models, closing the pane gap) | not planned |
