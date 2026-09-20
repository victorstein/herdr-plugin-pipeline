import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdAnswer, cmdDecide } from '../src/cli'
import { openDecision, answerDecision, abandonDecisions, openDecisionFor } from '../src/lib/decisions'
import { listRuns, newRun, saveRun } from '../src/lib/ledger'
import { type AnswerDeps, announceDecisions, deliverPendingAnswers } from '../src/supervisor/tasks'
import { artifactPathFor } from '../src/supervisor/deliver'
import { verdictFor } from '../src/lib/verdict-path'
import type { Run, Task, TaskPhase } from '../src/lib/types'

function taskFixture(phase: TaskPhase): Task {
  return {
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
    depends_on: [], files: [], keep_worktree: false,
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
    phase, phase_entered_at: Date.now(), escalated_from: null,
    head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
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
  keep_worktree: false, workspace_id: null, pane_id: null,
  agent_status: 'unknown', phase: 'queued', phase_entered_at: 0,
  escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
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
  await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: 'r', repoKey: 'k', runId: null })
  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.phase).toBe('blocked-on-decision')
  expect(saved?.tasks[0]?.decision_from).toBe('plan')
})

test('decide refuses a task that is already blocked', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  const first = await cmdDecide(ctx(), { task: 't1', question: 'q1', recommendation: 'r1', repoKey: 'k', runId: null })
  expect(first.ok).toBe(true)

  const second = await cmdDecide(ctx(), { task: 't1', question: 'q2', recommendation: 'r2', repoKey: 'k', runId: null })
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
  const result = await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: '   ', repoKey: 'k', runId: null })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('--recommend')

  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.phase).toBe('plan')
  expect(saved?.tasks[0]?.decisions).toHaveLength(0)
})

// ——— cmdAnswer ———

test('answer records the answer but leaves the task blocked', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: 'r', repoKey: 'k', runId: null })
  const decided = await savedRun(run.run_id)
  const decisionId = openDecisionFor(decided!.tasks[0]!)!.id

  const result = await cmdAnswer(ctx(), {
    task: 't1', decision: decisionId, answer: 'do X', by: 'orchestrator', repoKey: 'k', runId: null })
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
    task: 't1', decision: 'd1', answer: 'do X', by: 'orchestrator', repoKey: 'k', runId: null })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('plan')

  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.phase).toBe('plan')
})

test('answer on a task with a pending answer re-arms delivery', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: 'r', repoKey: 'k', runId: null })
  const decided = await savedRun(run.run_id)
  const decisionId = openDecisionFor(decided!.tasks[0]!)!.id

  await cmdAnswer(ctx(), { task: 't1', decision: decisionId, answer: 'first answer', by: 'orchestrator', repoKey: 'k', runId: null })

  const exhausted = await savedRun(run.run_id)
  exhausted!.tasks[0]!.delivery_attempts = 5
  await saveRun(dir, exhausted!)

  const result = await cmdAnswer(ctx(), {
    task: 't1', decision: decisionId, answer: 'second answer', by: 'human', repoKey: 'k', runId: null })
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
  await cmdDecide(ctx(), { task: 't1', question: 'q', recommendation: 'r', repoKey: 'k', runId: null })
  const decided = await savedRun(run.run_id)
  const decisionId = openDecisionFor(decided!.tasks[0]!)!.id

  await cmdAnswer(ctx(), { task: 't1', decision: decisionId, answer: 'do X', by: 'orchestrator', repoKey: 'k', runId: null })

  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.passes).toEqual({ plan: 2 })
})

// ——— deliverPendingAnswers ———

function blockedOnDecision(): { run: Run; task: Task; decisionId: string } {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  const task = mkTask({ task_id: 't1', phase: 'plan', pane_id: 'w7:p1' })
  const decision = openDecision(task, { question: 'ship or wait?', recommendation: 'ship' })
  answerDecision(task, decision.id, 'wait for the audit', 'human')
  task.phase = 'blocked-on-decision'
  task.decision_from = 'plan'
  task.pending_answer = decision.id
  task.phase_entered_at = Date.now() - 60_000
  run.tasks = [task]
  return { run, task, decisionId: decision.id }
}

const answerDeps = (over: Partial<AnswerDeps> = {}): AnswerDeps => ({
  pluginRoot: join(import.meta.dir, '..'),
  promptRetryMax: 5,
  send: async () => ({ ok: true }),
  ...over,
})

test('a delivered answer returns the task and resets phase_entered_at', async () => {
  const { run, task } = blockedOnDecision()
  const enteredBefore = task.phase_entered_at

  await deliverPendingAnswers(run, answerDeps())

  expect(task.phase).toBe('plan')
  expect(task.pending_answer).toBeNull()
  expect(task.decision_from).toBeNull()
  expect(task.delivery_attempts).toBe(0)
  expect(task.phase_entered_at).toBeGreaterThan(enteredBefore)
})

test('a failed send leaves the task blocked and counts the attempt', async () => {
  const { run, task, decisionId } = blockedOnDecision()

  await deliverPendingAnswers(run, answerDeps({
    send: async () => ({ ok: false, code: 'agent_blocked' }),
  }))

  expect(task.phase).toBe('blocked-on-decision')
  expect(task.decision_from).toBe('plan')
  expect(task.pending_answer).toBe(decisionId)
  expect(task.delivery_attempts).toBe(1)
})

test('an exhausted budget holds the task blocked rather than resuming it', async () => {
  const { run, task, decisionId } = blockedOnDecision()
  task.delivery_attempts = 5
  let sends = 0

  await deliverPendingAnswers(run, answerDeps({
    send: async () => { sends += 1; return { ok: true } },
  }))

  expect(sends).toBe(0)
  expect(task.phase).toBe('blocked-on-decision')
  expect(task.pending_answer).toBe(decisionId)
  expect(task.delivery_attempts).toBe(5)
})

test('counters are untouched by a decision round trip', async () => {
  const { run, task } = blockedOnDecision()
  task.passes = { plan: 2 }

  await deliverPendingAnswers(run, answerDeps())

  expect(task.phase).toBe('plan')
  expect(task.passes).toEqual({ plan: 2 })
})

test('the delivered prompt carries the question and the answer', async () => {
  const { run } = blockedOnDecision()
  const pluginRoot = mkdtempSync(join(tmpdir(), 'answer-prompt-'))
  mkdirSync(join(pluginRoot, 'prompts'))
  writeFileSync(
    join(pluginRoot, 'prompts', 'answer.md'),
    'resume {{phase}}\nQ: {{question}}\nA: {{answer}}\nby {{answered_by}}\n',
  )
  const sent: Array<{ paneId: string; text: string }> = []

  try {
    await deliverPendingAnswers(run, answerDeps({
      pluginRoot,
      send: async (paneId, text) => { sent.push({ paneId, text }); return { ok: true } },
    }))
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true })
  }

  expect(sent).toHaveLength(1)
  expect(sent[0]?.paneId).toBe('w7:p1')
  expect(sent[0]?.text).toContain('Q: ship or wait?')
  expect(sent[0]?.text).toContain('A: wait for the audit')
  expect(sent[0]?.text).toContain('by human')
  expect(sent[0]?.text).toContain('resume plan')
})

test('a task whose pane died is skipped rather than resumed', async () => {
  const { run, task, decisionId } = blockedOnDecision()
  task.pane_id = null
  let sends = 0

  await deliverPendingAnswers(run, answerDeps({
    send: async () => { sends += 1; return { ok: true } },
  }))

  expect(sends).toBe(0)
  expect(task.phase).toBe('blocked-on-decision')
  expect(task.pending_answer).toBe(decisionId)
  expect(task.delivery_attempts).toBe(0)
})

// ——— announceDecisions ———

function blockedWithOpenDecision(over: { question?: string; recommendation?: string } = {}): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  const task = mkTask({ task_id: 't1', phase: 'blocked-on-decision', pane_id: 'w7:p1', decision_from: 'plan' })
  openDecision(task, {
    question: over.question ?? 'ship or wait?',
    recommendation: over.recommendation ?? 'ship',
  })
  run.tasks = [task]
  return run
}

test('an open decision is announced to the orchestrator exactly once', async () => {
  const run = blockedWithOpenDecision()
  const sent: Array<{ paneId: string; text: string }> = []
  const deps = { ...answerDeps(), send: async (paneId: string, text: string) => { sent.push({ paneId, text }); return { ok: true } } }

  await announceDecisions(run, deps)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.paneId).toBe(run.orchestrator_pane ?? undefined)
  expect(sent[0]?.text).toContain('ship or wait?')

  await announceDecisions(run, deps)
  expect(sent).toHaveLength(1)
})

test('a failed announcement is retried next tick', async () => {
  const run = blockedWithOpenDecision()
  let sends = 0
  const deps = answerDeps({
    send: async () => { sends += 1; return { ok: false, code: 'agent_blocked' } },
  })

  await announceDecisions(run, deps)
  expect(sends).toBe(1)
  expect(openDecisionFor(run.tasks[0]!)?.prompted_at).toBeNull()

  await announceDecisions(run, deps)
  expect(sends).toBe(2)
})

test('an answered decision is not announced', async () => {
  const run = blockedWithOpenDecision()
  const decision = openDecisionFor(run.tasks[0]!)!
  answerDecision(run.tasks[0]!, decision.id, 'wait for the audit', 'human')
  run.tasks[0]!.pending_answer = decision.id
  let sends = 0
  const deps = answerDeps({ send: async () => { sends += 1; return { ok: true } } })

  await announceDecisions(run, deps)
  expect(sends).toBe(0)
})

test('the announcement carries the recommendation, not just the question', async () => {
  const run = blockedWithOpenDecision({
    question: 'ship or wait?',
    recommendation: 'ship now, add the audit as a follow-up issue',
  })
  const sent: Array<{ paneId: string; text: string }> = []
  const deps = { ...answerDeps(), send: async (paneId: string, text: string) => { sent.push({ paneId, text }); return { ok: true } } }

  await announceDecisions(run, deps)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.text).toContain('ship now, add the audit as a follow-up issue')
})

test('decide refuses a task in a finished run and writes nothing', async () => {
  // Issue #38, reproduced: this filed both of a live batch's decisions onto a
  // completed run and dragged two torn-down tasks back to blocked-on-decision.
  const done = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'aaa finished' })
  done.phase = 'done'
  done.tasks = [mkTask({ task_id: 't1', phase: 'done' })]
  await saveRun(dir, done)

  const result = await cmdDecide(ctx(), {
    task: 't1', question: 'q', recommendation: 'r', repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(false)
  // Spec testing item 8b: neither recovery works on a naturally-finished run —
  // rewind leaves run.phase alone, and resume needs a prior abort.
  expect(result.text).not.toContain('rewind')
  expect(result.text).not.toContain('resume')

  const saved = await savedRun(done.run_id)
  expect(saved?.tasks[0]?.phase).toBe('done')
  expect(saved?.tasks[0]?.decisions).toHaveLength(0)
})

test('decide refuses a finished task even inside a live run', async () => {
  const run = await runWithTask({ task_id: 't1', phase: 'done' })
  const result = await cmdDecide(ctx(), {
    task: 't1', question: 'q', recommendation: 'r', repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('finished')

  const saved = await savedRun(run.run_id)
  expect(saved?.tasks[0]?.decisions).toHaveLength(0)
})

test('decide files onto the live run when a finished run holds the same task id', async () => {
  const done = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'aaa finished' })
  done.phase = 'done'
  done.tasks = [mkTask({ task_id: 't1', phase: 'done' })]
  await saveRun(dir, done)
  const live = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'zzz live' })
  live.phase = 'execute'
  live.tasks = [mkTask({ task_id: 't1', phase: 'plan' })]
  await saveRun(dir, live)

  const result = await cmdDecide(ctx(), {
    task: 't1', question: 'q', recommendation: 'r', repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(true)

  expect((await savedRun(live.run_id))?.tasks[0]?.phase).toBe('blocked-on-decision')
  expect((await savedRun(done.run_id))?.tasks[0]?.phase).toBe('done')
})

test('answer still records onto a finished run when that run is named', async () => {
  // The repair path #38's damage needed: rewind into blocked-on-decision,
  // answer, rewind back. It must keep working on a run that is already done.
  const run = await runWithTask({ task_id: 't1', phase: 'plan' })
  await cmdDecide(ctx(), {
    task: 't1', question: 'q', recommendation: 'r', repoKey: 'k', runId: null,
  })
  const decided = await savedRun(run.run_id)
  const decisionId = openDecisionFor(decided!.tasks[0]!)!.id
  decided!.phase = 'done'
  await saveRun(dir, decided!)

  const bare = await cmdAnswer(ctx(), {
    task: 't1', decision: decisionId, answer: 'do X', by: 'human',
    repoKey: 'k', runId: null,
  })
  expect(bare.ok).toBe(false)
  expect(bare.text).toContain('--run')

  const named = await cmdAnswer(ctx(), {
    task: 't1', decision: decisionId, answer: 'do X', by: 'human',
    repoKey: 'k', runId: run.run_id,
  })
  expect(named.ok).toBe(true)
  expect((await savedRun(run.run_id))?.tasks[0]?.pending_answer).toBe(decisionId)
})

test('answering a decision raised on a review row does not move the verdict path', async () => {
  // The invariant the orchestrator's ruling on #26 exists to protect: a resume
  // re-enters the phase but commissions no review, so the agent keeps the path it
  // was handed. Pass 1 of that design keyed the path on phase entries and broke it.
  const run = newRun({
    session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a',
  })
  const task = mkTask({ task_id: 't1', phase: 'spec-review', pane_id: 'w7:p1' })
  task.verdict_seq = { 'spec-review': 1 }
  task.artifacts.verdicts = {
    'spec-review-0': 'docs/superpowers/reviews/issue-1-spec-review-0.md',
  }
  const decision = openDecision(task, { question: 'narrow it?', recommendation: 'narrow' })
  answerDecision(task, decision.id, 'narrow it', 'human')
  task.phase = 'blocked-on-decision'
  task.decision_from = 'spec-review'
  task.pending_answer = decision.id
  run.tasks = [task]

  // The path handed to the agent when the review was commissioned, read off the
  // review row rather than off `task.phase` — the task is parked in
  // `blocked-on-decision` right now, which resolves to a different row entirely.
  const handed = verdictFor(task, 'spec-review')
  expect(handed).toBe('docs/superpowers/reviews/issue-1-spec-review-0.md')

  await deliverPendingAnswers(run, answerDeps())

  // Read through `run.tasks` so the literal assignment above does not narrow the
  // comparison type to `blocked-on-decision`.
  expect(run.tasks[0]?.phase).toBe('spec-review')
  expect(task.verdict_seq).toEqual({ 'spec-review': 1 })
  expect(task.artifacts.verdicts).toEqual({
    'spec-review-0': 'docs/superpowers/reviews/issue-1-spec-review-0.md',
  })
  expect(verdictFor(task, 'spec-review')).toBe(handed)
  expect(artifactPathFor(run, task)).toBe(handed)
})
