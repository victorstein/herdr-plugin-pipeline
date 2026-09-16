import { expect, test } from 'bun:test'
import { openDecision, answerDecision, abandonDecisions, openDecisionFor } from '../src/lib/decisions'
import type { Task, TaskPhase } from '../src/lib/types'

function taskFixture(phase: TaskPhase): Task {
  return {
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
    depends_on: [], files: [], keep_worktree: false, text: '',
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
    phase, phase_entered_at: Date.now(), escalated_from: null,
    head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, notes: '',
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
