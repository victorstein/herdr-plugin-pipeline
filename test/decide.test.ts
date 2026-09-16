import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdAnswer, cmdDecide } from '../src/cli'
import { openDecision, answerDecision, abandonDecisions, openDecisionFor } from '../src/lib/decisions'
import { listRuns, newRun, saveRun } from '../src/lib/ledger'
import type { Run, Task, TaskPhase } from '../src/lib/types'

function taskFixture(phase: TaskPhase): Task {
  return {
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
    depends_on: [], files: [], keep_worktree: false, text: '',
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
    phase, phase_entered_at: Date.now(), escalated_from: null,
    head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  }
}

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

test('an already-answered, delivered decision is not re-abandoned', () => {
  const task = taskFixture('plan')
  const a = openDecision(task, { question: 'delivered', recommendation: 'r' })
  answerDecision(task, a.id, 'do X', 'human')
  const b = openDecision(task, { question: 'also delivered', recommendation: 'r' })
  answerDecision(task, b.id, 'do Y', 'orchestrator')
  task.pending_answer = null
  abandonDecisions(task)
  expect(task.decisions.map((d) => d.answered_by)).toEqual(['human', 'orchestrator'])
})

// ——— cmdDecide ———

let dir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'decide-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'b', issue: 1, surface: 'core', depends_on: [], files: [],
  keep_worktree: false, text: '', workspace_id: null, pane_id: null,
  agent_status: 'unknown', phase: 'queued', phase_entered_at: 0,
  escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: null, registered_at: 0, adopted_at: null,
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

async function runWithTask(over: Partial<Task>): Promise<Run> {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.tasks = [mkTask(over)]
  await saveRun(dir, run)
  return run
}

async function savedRun(runId: string): Promise<Run | undefined> {
  return (await listRuns(dir, 'personal')).find((r) => r.run_id === runId)
}

test('decide blocks the task and records where it came from', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: 'r' })
  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.phase).toBe('blocked-on-decision')
  expect(saved?.tasks[0]?.decision_from).toBe('plan')
})

test('decide refuses a task that is already blocked', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  const first = await cmdDecide(ctx(), { task: 't1', question: 'q1', recommendation: 'r1' })
  expect(first.ok).toBe(true)

  const second = await cmdDecide(ctx(), { task: 't1', question: 'q2', recommendation: 'r2' })
  expect(second.ok).toBe(false)

  const saved = await savedRun(run.run_id)
  const open = openDecisionFor(saved!.tasks[0]!)
  expect(open).not.toBeNull()
  expect(second.text).toContain(open!.id)
  expect(saved?.tasks[0]?.decision_from).toBe('plan')
  expect(saved?.tasks[0]?.decisions).toHaveLength(1)
})

test('decide requires a recommendation', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  const result = await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: '   ' })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('--recommend')

  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.phase).toBe('plan')
  expect(saved?.tasks[0]?.decisions).toHaveLength(0)
})

// ——— cmdAnswer ———

test('answer records the answer but leaves the task blocked', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: 'r' })
  const decided = await savedRun(run.run_id)
  const decisionId = openDecisionFor(decided!.tasks[0]!)!.id

  const result = await cmdAnswer(ctx(), {
    task: 't1', decision: decisionId, answer: 'do X', by: 'orchestrator',
  })
  expect(result.ok).toBe(true)

  const saved = await savedRun(run.run_id)
  const task = saved!.tasks[0]!
  expect(task.phase).toBe('blocked-on-decision')
  expect(task.pending_answer).toBe(decisionId)
  const decision = task.decisions.find((d) => d.id === decisionId)
  expect(decision?.answer).toBe('do X')
  expect(decision?.answered_by).toBe('orchestrator')
})

test('answer refuses a task that is not blocked', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  const result = await cmdAnswer(ctx(), {
    task: 't1', decision: 'd1', answer: 'do X', by: 'orchestrator',
  })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('plan')

  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.phase).toBe('plan')
})

test('answer on a task with a pending answer re-arms delivery', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: 'r' })
  const decided = await savedRun(run.run_id)
  const decisionId = openDecisionFor(decided!.tasks[0]!)!.id

  await cmdAnswer(ctx(), { task: 't1', decision: decisionId, answer: 'first answer', by: 'orchestrator' })

  const exhausted = await savedRun(run.run_id)
  exhausted!.tasks[0]!.delivery_attempts = 5
  await saveRun(dir, exhausted!)

  const result = await cmdAnswer(ctx(), {
    task: 't1', decision: decisionId, answer: 'second answer', by: 'human',
  })
  expect(result.ok).toBe(true)

  const saved = await savedRun(run.run_id)
  const task = saved!.tasks[0]!
  expect(task.delivery_attempts).toBe(0)
  expect(task.pending_answer).toBe(decisionId)
  const decision = task.decisions.find((d) => d.id === decisionId)
  expect(decision?.answer).toBe('second answer')
  expect(decision?.answered_by).toBe('human')
})

test('answering does not touch passes', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan', passes: { plan: 2 } })
  await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: 'r' })
  const decided = await savedRun(run.run_id)
  const decisionId = openDecisionFor(decided!.tasks[0]!)!.id

  await cmdAnswer(ctx(), { task: 't1', decision: decisionId, answer: 'do X', by: 'orchestrator' })

  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.passes).toEqual({ plan: 2 })
})
