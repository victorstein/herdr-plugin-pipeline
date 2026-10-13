import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  nextPhase, rowRunsIn, RUN_ROWS, type RunMode, TASK_ROWS, taskRow, TIERS, type PhaseRow, type Tier,
} from '../src/lib/phases'
import type { TaskPhase } from '../src/lib/types'
import { newRun, withBatch } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { advanceTasks, renderTaskPhasePrompt, type TaskDeps } from '../src/supervisor/tasks'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

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

// Named one by one, not globbed: `prompts/*-review*.md` also matches
// branch-review.md, which is orchestrator-owned and must carry neither.
const WORKER_REVIEW_PROMPTS = ['spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality']

const promptText = (name: string) =>
  Bun.file(join(import.meta.dir, '..', 'prompts', `${name}.md`)).text()

test('every worker review prompt has the verdict committed last and pushed', async () => {
  for (const name of WORKER_REVIEW_PROMPTS) {
    const text = (await promptText(name)).replace(/\s+/g, ' ')
    expect(text, `${name}.md must say the phase clears on a committed verdict`)
      .toContain('This phase clears once you are idle, with the verdict file committed')
    expect(text, `${name}.md must require the verdict be pushed`)
      .toContain('commit and push the verdict file before you end that turn')
  }
})

test('branch-review carries no worker verdict instruction — it is orchestrator-owned and left uncommitted', async () => {
  const text = (await promptText('branch-review')).replace(/\s+/g, ' ')
  expect(text).not.toContain('with the verdict file committed')
  expect(text).not.toContain('commit and push the verdict')
})

test('no task row carries a stallWhen — taskStallCandidates never reads one', () => {
  // stallCandidates consults it (stall.ts:83); taskStallCandidates does not
  // (:99-104), and its declared parameter is run-shaped (phases.ts:39). A task
  // row given one today would be silently ignored, so make that fail loudly.
  expect(TASK_ROWS.filter((r) => r.stallWhen).map((r) => r.phase)).toEqual([])
})

function walkFromQueued(tier: Tier): TaskPhase[] {
  const walked: TaskPhase[] = ['queued']
  while (walked.at(-1) !== 'ci') {
    if (walked.length > TASK_ROWS.length) throw new Error(`${tier} walks in a circle`)
    walked.push(nextPhase({ tier, mode: 'per-task' }, taskRow(walked.at(-1)!)))
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

test('a row carrying modes is the onBlocker only of rows whose modes are a subset', () => {
  for (const rows of [RUN_ROWS, TASK_ROWS] as readonly (readonly PhaseRow<string>[])[]) {
    for (const row of rows) {
      if (row.onBlocker === undefined) continue
      const target = rows.find((r) => r.phase === row.onBlocker)!
      if (target.modes === undefined) continue
      const sendsBackFrom = row.modes ?? ['per-task', 'single-pr']
      for (const mode of sendsBackFrom) expect(target.modes, `${row.phase} → ${target.phase}`).toContain(mode)
    }
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

function walkToMerge(tier: Tier, mode: RunMode): TaskPhase[] {
  const walked: TaskPhase[] = ['queued']
  while (walked.at(-1) !== 'merge') {
    if (walked.length > TASK_ROWS.length) throw new Error(`${tier} ${mode} walks in a circle`)
    walked.push(nextPhase({ tier, mode }, taskRow(walked.at(-1)!)))
  }
  return walked
}

test('in each mode and tier the walk from queued reaches merge through implement, by its own rows', () => {
  for (const tier of TIERS) {
    const perTask = walkToMerge(tier, 'per-task')
    expect(perTask, tier).toContain('implement')
    expect(perTask, tier).toContain('ci')
    expect(perTask, tier).not.toContain('land-queue')
    expect(perTask, tier).not.toContain('sync')
    const singlePr = walkToMerge(tier, 'single-pr')
    expect(singlePr, tier).toContain('implement')
    expect(singlePr, tier).not.toContain('ci')
    expect(singlePr.slice(-3), tier).toEqual(['land-queue', 'sync', 'merge'])
    for (const phase of singlePr) {
      const row = taskRow(phase)
      if (row.actor !== undefined) expect(row.prompt, `${tier} single-pr: ${phase}`).toBeDefined()
    }
  }
})

const ROOT = join(import.meta.dir, '..')

function taskIn(phase: TaskPhase, tier: Tier): Task {
  return {
    task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core',
    depends_on: [], files: [], keep_worktree: false,
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase, phase_entered_at: 0, escalated_from: null,
    head_sha_at_entry: null, pr: 42, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: 0, adopted_at: 0,
    artifacts: { research: 'r.md', spec: 's.md', plan: 'p.md', verdicts: {} },
    merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    tier,
  }
}

function runWith(task: Task): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [task]
  return rowRunsIn(taskRow(task.phase), 'per-task') ? run : withBatch(run, batchFixture())
}

const clearingTick = (): TaskDeps => ({
  pluginRoot: ROOT,
  liveIdle: async () => true,
  hasLiveAgent: () => true,
  maxPasses: 2,
  fileSettleMs: 0,
  prForBranch: async () => 42,
  prView: async () => null,
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
      expect(task.phase, `${tier}: ${row.phase}`).toBe(nextPhase({ tier, mode: 'per-task' }, row))
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

test('the close row is the supervisor\'s: no actor, no prompt, probed through the orchestrator', () => {
  const close = taskRow('close')
  expect(close.actor).toBeUndefined()
  expect(close.prompt).toBeUndefined()
  expect(close.probeTarget).toBe('orchestrator')
  expect(close.stallable).toBe(true)
})
