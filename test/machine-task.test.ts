import { expect, test } from 'bun:test'
import { advanceTask, bumpCounter, counterFor, enterTaskPhase } from '../src/lib/machine'
import { newRun } from '../src/lib/ledger'
import type { Run, Task, TaskPhase } from '../src/lib/types'

function fixture(phase: TaskPhase): { run: Run; task: Task } {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  const task: Task = {
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
    depends_on: [], files: [], keep_worktree: false, text: 'do it',
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase, pass: 1, phase_entered_at: Date.now(), escalated_from: null,
    head_sha_at_entry: 'aaa', pr: 5, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, notes: '',
  }
  run.tasks.push(task)
  return { run, task }
}

test('execute advances when the worker is idle, a PR exists, and the head sha moved', () => {
  const { run, task } = fixture('execute')
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: true, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'bbb', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('task-review-spec')
})

test('execute does NOT advance when the head sha is unchanged', () => {
  const { run, task } = fixture('execute')
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: true, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(next).toBeNull()
})

test('stage 1 CLEAR moves to stage 2, not straight to ci', () => {
  const { run, task } = fixture('task-review-spec')
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: false, artifactFresh: true,
    verdict: { verdict: 'CLEAR', blockers: 0, majors: 0 },
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('task-review-quality')
})

test('a task escalates alone at MAX_PASSES', () => {
  const { run, task } = fixture('task-review-quality')
  task.pass = 2
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: false, artifactFresh: true,
    verdict: { verdict: 'BLOCKER', blockers: 1, majors: 0 },
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('escalated')
  expect(next?.escalated_from).toBe('task-review-quality')
  expect(run.phase).not.toBe('escalated')
})

test('merge requires mergedAt to postdate phase entry, not merely MERGED', () => {
  const { run, task } = fixture('merge')
  const stale = advanceTask(run, task, {
    actorIdle: true, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: true, mergedAtMs: task.phase_entered_at - 1_000,
    issueClosed: false, ciBucket: null, maxPasses: 2,
  })
  expect(stale).toBeNull()
})

test('merge advances when mergedAt postdates phase entry', () => {
  const { run, task } = fixture('merge')
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: true, mergedAtMs: task.phase_entered_at + 1_000,
    issueClosed: false, ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('close')
})

test('ci pass advances to merge; ci fail returns to execute', () => {
  const pass = fixture('ci')
  expect(advanceTask(pass.run, pass.task, {
    actorIdle: false, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: 'pass', maxPasses: 2,
  })?.phase).toBe('merge')

  const fail = fixture('ci')
  expect(advanceTask(fail.run, fail.task, {
    actorIdle: false, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: 'fail', maxPasses: 2,
  })?.phase).toBe('execute')
})

test('a repeatedly red CI escalates instead of retrying forever', () => {
  const { run, task } = fixture('ci')
  task.pass = 2
  const next = advanceTask(run, task, {
    actorIdle: false, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: 'fail', maxPasses: 2,
  })
  expect(next?.phase).toBe('escalated')
})

test('a red CI below the cap increments pass on the way back to execute', () => {
  const { run, task } = fixture('ci')
  const next = advanceTask(run, task, {
    actorIdle: false, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'bbb', merged: false, issueClosed: false,
    ciBucket: 'fail', maxPasses: 3,
  })
  expect(next?.phase).toBe('execute')
  expect(next?.pass).toBe(2)
})

test('a pending ci bucket advances nothing', () => {
  const { run, task } = fixture('ci')
  expect(advanceTask(run, task, {
    actorIdle: false, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: 'pending', maxPasses: 2,
  })).toBeNull()
})

test('enterTaskPhase records the task id in run history', () => {
  const { run, task } = fixture('execute')
  enterTaskPhase(run, task, 'ci', 'both reviews cleared')
  expect(run.history.at(-1)).toMatchObject({ task_id: 't1', to: 'ci' })
})

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

test('the implement -> reviews -> red ci lap terminates instead of resetting', () => {
  const { run, task } = fixture('pr-review-intent')
  const clear = { verdict: 'CLEAR' as const, blockers: 0, majors: 0 }
  const signals = {
    actorIdle: true, artifactFresh: true, verdict: clear,
    prNumber: 5, headSha: 'bbb', merged: false, issueClosed: false,
    ciBucket: null as null, maxPasses: 2,
  }

  advanceTask(run, task, signals)
  advanceTask(run, task, signals)
  expect(task.phase).toBe('ci')
  advanceTask(run, task, { ...signals, verdict: null, ciBucket: 'fail' })
  expect(task.phase).toBe('implement')
  expect(counterFor(task, 'ci')).toBe(1)

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
