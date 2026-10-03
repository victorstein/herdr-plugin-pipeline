import { expect, test } from 'bun:test'
import {
  AWAITING_HUMAN_LABEL, beadOutOfSync, commentMarker, desiredBead, discoveryLabel, DISCOVERED_LABEL, isManagedLabel,
} from '../src/lib/bead-desired'
import { escalatedUnanswered, openDecision } from '../src/lib/decisions'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

const mkTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'implement', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
  pr: 7, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, merge_commit: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function runWith(...tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.run_id = 'r1'
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

const RUN_LABEL = 'hpipe:run=r1'

test('a merged task wants its bead closed by hpipe, carrying only the run label', () => {
  for (const phase of ['close', 'teardown', 'done', 'orphaned'] as const) {
    const task = mkTask({ phase, merged_at_ms: 5 })
    expect(desiredBead(task, runWith(task)), phase).toEqual({
      bead: 'hp-1', status: 'closed', assignee: 'hpipe', labels: [RUN_LABEL], blockedBy: [], comments: [],
    })
  }
})

test('a task in a terminal-bad phase releases its bead, its phase label saying why', () => {
  for (const phase of ['failed', 'blocked-on-failure'] as const) {
    const task = mkTask({ phase })
    expect(desiredBead(task, runWith(task)), phase)
      .toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, `phase:${phase}`] })
  }
})

test('a task rewound to done without a merge holds nothing, so its bead is released', () => {
  const task = mkTask({ phase: 'done' })
  expect(desiredBead(task, runWith(task))).toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, 'phase:done'] })
})

test('an aborted run releases every unmerged bead as phase:aborted, and a resume re-claims it', () => {
  const task = mkTask({ phase: 'implement' })
  const run = runWith(task)
  run.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  run.escalated_from = 'execute'
  run.phase = 'done'
  expect(desiredBead(task, run)).toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, 'phase:aborted'] })

  run.history.push({ at: 2, from: 'done', to: 'execute', why: 'resumed' })
  run.phase = 'execute'
  run.escalated_from = null
  expect(desiredBead(task, run)).toMatchObject({ status: 'in_progress', assignee: 'hpipe', labels: [RUN_LABEL, 'phase:implement'] })
})

test('a run that ended on its own releases an unfinished task under that task\'s phase', () => {
  const task = mkTask({ phase: 'failed' })
  const run = runWith(task)
  run.phase = 'done'
  expect(desiredBead(task, run)).toMatchObject({ status: 'open', labels: [RUN_LABEL, 'phase:failed'] })
})

test('an escalated task keeps its claim: the human may resume it', () => {
  const task = mkTask({ phase: 'escalated', escalated_from: 'plan' })
  expect(desiredBead(task, runWith(task))).toMatchObject({ status: 'in_progress', assignee: 'hpipe' })
})

test('a registered task its worker has not been briefed on stays open and unassigned', () => {
  const queued = mkTask({ phase: 'queued' })
  expect(desiredBead(queued, runWith(queued)))
    .toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, 'phase:queued'] })
  const unbriefed = mkTask({ phase: 'research', awaiting_brief: true })
  expect(desiredBead(unbriefed, runWith(unbriefed))).toMatchObject({ status: 'open', assignee: null })
  const briefed = mkTask({ phase: 'research' })
  expect(desiredBead(briefed, runWith(briefed))).toMatchObject({ status: 'in_progress', assignee: 'hpipe' })
})

test('an escalated, unanswered decision blocks the bead, marks it for the human and wants its question posted', () => {
  const task = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan' })
  const decision = openDecision(task, { question: 'Which store?', recommendation: 'sqlite' })
  decision.escalated_at = 10
  decision.orchestrator_recommendation = 'sqlite, for the tests'

  expect(escalatedUnanswered(task)?.id).toBe('d1')
  const desired = desiredBead(task, runWith(task))
  expect(desired).toMatchObject({
    status: 'blocked', assignee: 'hpipe', labels: [RUN_LABEL, 'phase:blocked-on-decision', AWAITING_HUMAN_LABEL],
  })
  expect(desired.comments.map((c) => c.marker)).toEqual(['[hpipe t1/d1/asked]'])
  const text = desired.comments[0]!.text
  expect(text).toContain('Which store?')
  expect(text).toContain('sqlite')
  expect(text).toContain('sqlite, for the tests')
  expect(text.endsWith('[hpipe t1/d1/asked]')).toBe(true)
})

test('a decision not yet put to the human leaves the bead in progress and posts nothing', () => {
  const task = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan' })
  openDecision(task, { question: 'q', recommendation: 'r' })
  expect(escalatedUnanswered(task)).toBeNull()
  expect(desiredBead(task, runWith(task))).toMatchObject({ status: 'in_progress', comments: [] })
})

test('any answer ends the block and wants the ruling posted, while the question stays posted', () => {
  for (const by of ['orchestrator', 'human'] as const) {
    const task = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan' })
    const decision = openDecision(task, { question: 'q', recommendation: 'r' })
    decision.escalated_at = 10
    Object.assign(decision, { answer: 'use sqlite', answered_by: by, answered_at: 11 })

    const desired = desiredBead(task, runWith(task))
    expect(desired.status, by).toBe('in_progress')
    expect(desired.comments.map((c) => c.marker)).toEqual(['[hpipe t1/d1/asked]', '[hpipe t1/d1/ruling]'])
    expect(desired.comments[1]!.text).toContain('use sqlite')
    expect(desired.comments[1]!.text).toContain(`by the ${by}`)
  }
})

test('an abandoned decision posts no ruling, and a rewind out of the decision un-blocks the bead', () => {
  const task = mkTask({ phase: 'plan', decision_from: null })
  const decision = openDecision(task, { question: 'q', recommendation: 'r' })
  decision.escalated_at = 10
  expect(desiredBead(task, runWith(task)).status).toBe('in_progress')

  Object.assign(decision, { answered_by: 'abandoned', answered_at: 12 })
  expect(desiredBead(task, runWith(task)).comments.map((c) => c.marker)).toEqual(['[hpipe t1/d1/asked]'])
})

test('each depends_on task becomes a blocks edge to its bead, on every row', () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'done', merged_at_ms: 1 })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  expect(desiredBead(second, runWith(first, second)).blockedBy).toEqual(['hp-1'])
  expect(desiredBead(first, runWith(first, second)).blockedBy).toEqual([])
})

test('only the hpipe: and phase: namespaces are hpipe\'s to remove', () => {
  for (const label of ['phase:plan', 'hpipe:run=r9', AWAITING_HUMAN_LABEL]) {
    expect(isManagedLabel(label), label).toBe(true)
  }
  for (const label of ['pipeline:tier-light', 'ui', 'phased', DISCOVERED_LABEL, discoveryLabel('r9', 't1', 'x1')]) expect(isManagedLabel(label), label).toBe(false)
})

test('the comment marker is spelled the one way the reconciler looks for', () => {
  expect(commentMarker('t3', 'd2', 'ruling')).toBe('[hpipe t3/d2/ruling]')
})

test('a bead is out of sync at five consecutive failed calls with an error still standing', () => {
  expect(beadOutOfSync(mkTask({ bead_sync: { failures: 5, streak: 5, last_error: 'locked', last_ok_at_ms: null } }))).toBe(true)
  expect(beadOutOfSync(mkTask({ bead_sync: { failures: 5, streak: 4, last_error: 'locked', last_ok_at_ms: null } }))).toBe(false)
  expect(beadOutOfSync(mkTask({ bead_sync: { failures: 9, streak: 0, last_error: null, last_ok_at_ms: 3 } }))).toBe(false)
})

test('one failure after many transient ones does not count as out of sync', () => {
  expect(beadOutOfSync(mkTask({ bead_sync: { failures: 6, streak: 1, last_error: 'locked', last_ok_at_ms: 3 } }))).toBe(false)
})

function abort(run: Run): Run {
  run.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  run.escalated_from = 'execute'
  run.phase = 'done'
  return run
}

test('an aborted run still closes the bead of a task that merged before the abort', () => {
  const task = mkTask({ phase: 'done', merged_at_ms: 5 })
  expect(desiredBead(task, abort(runWith(task))))
    .toMatchObject({ status: 'closed', assignee: 'hpipe', labels: [RUN_LABEL] })
})

test('a depends_on id naming no task in the run adds no edge', () => {
  const task = mkTask({ depends_on: ['t-missing'] })
  expect(desiredBead(task, runWith(task)).blockedBy).toEqual([])
})

test('an aborted run releases a done but unmerged task as phase:aborted, since its work never landed', () => {
  const task = mkTask({ phase: 'done' })
  expect(desiredBead(task, abort(runWith(task))))
    .toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, 'phase:aborted'] })
})
