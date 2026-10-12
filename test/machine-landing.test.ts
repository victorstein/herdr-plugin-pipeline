import { expect, test } from 'bun:test'
import { advanceTask, enterTaskPhase, type LandingFacts, type TaskSignals } from '../src/lib/machine'
import { newRun, withBatch } from '../src/lib/ledger'
import type { Run, Submission, Task, TaskPhase, Tier } from '../src/lib/types'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

const ENTERED = 1_000

function fixture(phase: TaskPhase, over: Partial<Task> = {}): { run: Run; task: Task } {
  const run = withBatch(newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' }),
    batchFixture())
  const task: Task = {
    task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core',
    depends_on: [], files: [], keep_worktree: false,
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase, phase_entered_at: ENTERED, escalated_from: null,
    head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: '/r/wt', registered_at: 0, adopted_at: 0,
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', tier: 'standard',
    ...over,
  }
  run.tasks.push(task)
  return { run, task }
}

const signals = (over: Partial<TaskSignals> = {}): TaskSignals => ({
  actorIdle: true, artifactFresh: false, verdict: null, prNumber: null, headSha: null, merged: false,
  filesClear: false, ciBucket: null, maxPasses: 2, ...over,
})

const facts = (over: Partial<LandingFacts> = {}): LandingFacts => ({
  movedTo: null, landed: false, upToDate: true, checked: true, batchHead: 'b0b0b0b0aaaa', ...over,
})

const submitted = (over: Partial<Submission> = {}): Submission => ({
  kind: 'implement', title: 'feat(menu): close on escape', head_sha: 'aaaa1111', at: ENTERED + 5, check: 'passed', ...over,
})

const CLEAR = { verdict: 'CLEAR' as const, blockers: 0, majors: 0 }

// ——— implement ———

test('implement clears on a fresh implement submission once the worker is idle', () => {
  const { run, task } = fixture('implement', { submission: submitted() })
  expect(advanceTask(run, task, signals({ actorIdle: false }))).toBeNull()
  expect(advanceTask(run, task, signals())?.phase).toBe('pr-review')
})

const SKIP = { at: 1, skipped: ['pr-review'] as TaskPhase[], added_lines: 12, cleared: ['spec-review'] as TaskPhase[] }

test('a submission that skips its review goes to land-queue on the measured head, as a CLEAR would', () => {
  const { run, task } = fixture('implement', { tier: 'light', submission: submitted() })
  const next = advanceTask(run, task, signals({ reviewSkip: SKIP, headSha: 'aaaa1111', headContainsSubmission: true }))
  expect(next?.phase).toBe('land-queue')
  expect(task.land_sha).toBe('aaaa1111')
  expect(task.review_skip).toEqual(SKIP)
  expect(run.history.at(-1)?.why).toBe('submitted aaaa1111 as "feat(menu): close on escape"; ' +
    'pr-review skipped: 12 lines added outside docs/, spec-review cleared first pass; landing head aaaa1111')
})

test('a skip whose branch lost the submission goes back to implement and records no skip', () => {
  const { run, task } = fixture('implement', { tier: 'light', submission: submitted() })
  const next = advanceTask(run, task, signals({ reviewSkip: SKIP, headSha: 'cccc3333', headContainsSubmission: false }))
  expect(next?.phase).toBe('implement')
  expect(task.review_skip).toBeUndefined()
  expect(task.land_sha).toBeUndefined()
})

test('implement ignores a submission older than its entry, one that names the head the review rejected, or a sync', () => {
  for (const submission of [
    submitted({ at: ENTERED - 1 }), submitted({ head_sha: 'rejected' }), submitted({ kind: 'sync' }),
  ]) {
    const { run, task } = fixture('implement', { submission, head_sha_at_entry: 'rejected' })
    expect(advanceTask(run, task, signals()), JSON.stringify(submission)).toBeNull()
  }
})

test('entering implement by any route forgets the reviewed head', () => {
  const { run, task } = fixture('pr-review', { land_sha: 'aaaa1111' })
  enterTaskPhase(run, task, 'implement', 'returned')
  expect(task.land_sha).toBeUndefined()
})

// ——— the last review's CLEAR records what lands ———

test('the CLEAR that leads into land-queue records the branch head as the reviewed head', () => {
  for (const [tier, phase] of [
    ['light', 'pr-review'], ['standard', 'pr-review'], ['heavy', 'pr-review'],
    ['heavy', 'pr-review-intent'], ['heavy', 'pr-review-quality'],
  ] as const) {
    const { run, task } = fixture(phase, { tier: tier as Tier, submission: submitted() })
    const next = advanceTask(run, task, signals({
      artifactFresh: true, verdict: CLEAR, headSha: 'bbbb2222', headContainsSubmission: true,
    }))
    expect(next?.phase, tier).toBe('land-queue')
    expect(task.land_sha, tier).toBe('bbbb2222')
  }
})

test('a CLEAR into land-queue with no head read skips the tick', () => {
  const { run, task } = fixture('pr-review', { submission: submitted() })
  expect(advanceTask(run, task, signals({ artifactFresh: true, verdict: CLEAR }))).toBeNull()
  expect(task.phase).toBe('pr-review')
})

test('a reviewed head that lost the submitted work goes back to implement, not into land-queue', () => {
  const { run, task } = fixture('pr-review', { submission: submitted() })
  const next = advanceTask(run, task, signals({
    artifactFresh: true, verdict: CLEAR, headSha: 'cccc3333', headContainsSubmission: false,
  }))
  expect(next?.phase).toBe('implement')
  expect(task.head_sha_at_entry).toBe('cccc3333')
  expect(task.land_sha).toBeUndefined()
  expect(run.history.at(-1)?.why).toContain('no longer contains its submitted head aaaa1111')
})

// ——— land-queue ———

test('land-queue waits until the slot is this task\'s', () => {
  const { run, task } = fixture('land-queue', { land_sha: 'aaaa1111' })
  expect(advanceTask(run, task, signals({ landing: facts() }))).toBeNull()
})

test('with the slot, a landed task or one up to date and checked goes to merge', () => {
  for (const landing of [facts({ landed: true, upToDate: false }), facts()]) {
    const { run, task } = fixture('land-queue', { land_sha: 'aaaa1111' })
    expect(advanceTask(run, task, signals({ slotMine: true, landing }))?.phase).toBe('merge')
  }
})

test('with the slot, a task behind the batch, or up to date but unchecked, goes to sync', () => {
  for (const [landing, why] of [
    [facts({ upToDate: false }), 'batch/x moved to b0b0b0b0 since aaaa1111 was reviewed'],
    [facts({ checked: false }), 'not checked since it was reviewed'],
  ] as const) {
    const { run, task } = fixture('land-queue', { land_sha: 'aaaa1111' })
    expect(advanceTask(run, task, signals({ slotMine: true, landing }))?.phase).toBe('sync')
    expect(run.history.at(-1)?.why).toContain(why)
  }
})

test('with the slot, a branch moved past its reviewed head goes to sync', () => {
  const { run, task } = fixture('land-queue', { land_sha: 'aaaa1111' })
  const next = advanceTask(run, task, signals({ slotMine: true, landing: facts({ movedTo: 'dddd4444' }) }))
  expect(next?.phase).toBe('sync')
  expect(run.history.at(-1)?.why).toBe('t1-branch moved to dddd4444 after its reviewed head')
  expect(task.landed).toBeUndefined()
})

test('with the slot, a landed head whose branch moved on is recorded before the task syncs the rest', () => {
  const { run, task } = fixture('land-queue', { land_sha: 'aaaa1111', submission: submitted() })
  const next = advanceTask(run, task, signals({ slotMine: true, landing: facts({ landed: true, movedTo: 'dddd4444' }) }))
  expect(next?.phase).toBe('sync')
  expect(task.landed?.map((l) => l.land_sha)).toEqual(['aaaa1111'])
  expect(task.merged_at_ms).toBeNull()
})

// ——— sync ———

test('sync: a clean submission advances the reviewed head and goes to merge', () => {
  const { run, task } = fixture('sync', {
    land_sha: 'aaaa1111', submission: submitted({ kind: 'sync', merge: 'clean', head_sha: 'eeee5555' }),
  })
  expect(advanceTask(run, task, signals())?.phase).toBe('merge')
  expect(task.land_sha).toBe('eeee5555')
})

test('sync: a dirty submission goes back to pr-review in every tier and keeps the reviewed head', () => {
  for (const tier of ['light', 'standard', 'heavy'] as const) {
    const { run, task } = fixture('sync', {
      tier: tier as Tier, land_sha: 'aaaa1111',
      submission: submitted({ kind: 'sync', merge: 'dirty', head_sha: 'eeee5555', dirty_at: 'ffff6666' }),
    })
    expect(advanceTask(run, task, signals())?.phase, tier).toBe('pr-review')
    expect(task.land_sha, tier).toBe('aaaa1111')
    expect(run.history.at(-1)?.why).toBe('sync of batch/x was not a clean merge: ffff6666')
  }
})

test('sync: a dirty submission after a skipped review forgets the head nobody reviewed', () => {
  const { run, task } = fixture('sync', {
    tier: 'light', land_sha: 'aaaa1111', review_skip: SKIP,
    submission: submitted({ kind: 'sync', merge: 'dirty', head_sha: 'eeee5555', dirty_at: 'ffff6666' }),
  })
  expect(advanceTask(run, task, signals())?.phase).toBe('pr-review')
  expect(task.land_sha).toBeUndefined()
  expect(task.review_skip).toBeUndefined()
})

test('sync: a stale submission, or a busy worker, is not read', () => {
  const stale = fixture('sync', { land_sha: 'a', submission: submitted({ kind: 'sync', merge: 'clean', at: ENTERED - 1 }) })
  expect(advanceTask(stale.run, stale.task, signals())).toBeNull()
  const busy = fixture('sync', { land_sha: 'a', submission: submitted({ kind: 'sync', merge: 'clean' }) })
  expect(advanceTask(busy.run, busy.task, signals({ actorIdle: false }))).toBeNull()
})

test('sync: a reviewed head already on the batch, with nothing pushed past it, goes to merge to record the landing', () => {
  const { run, task } = fixture('sync', { land_sha: 'aaaa1111' })
  expect(advanceTask(run, task, signals({ actorIdle: false, landing: facts({ landed: true }) }))?.phase).toBe('merge')
  const moved = fixture('sync', { land_sha: 'aaaa1111' })
  expect(advanceTask(moved.run, moved.task, signals({ landing: facts({ landed: true, movedTo: 'x' }) }))).toBeNull()
})

test('sync: a holder with no submission past the yield window gives the slot up to a waiting task', () => {
  const { run, task } = fixture('sync', { land_sha: 'aaaa1111', phase_entered_at: Date.now() - 16 * 60_000 })
  const next = advanceTask(run, task, signals({ actorIdle: false, yieldTo: ['t5'], yieldAfterMs: 15 * 60_000 }))
  expect(next?.phase).toBe('land-queue')
  expect(task.land_sha).toBe('aaaa1111')
  expect(run.history.at(-1)?.why).toBe('yielded the landing slot: no sync after 15m, t5 waiting')

  const early = fixture('sync', { land_sha: 'aaaa1111', phase_entered_at: Date.now() - 60_000 })
  expect(advanceTask(early.run, early.task, signals({ actorIdle: false, yieldTo: ['t5'], yieldAfterMs: 15 * 60_000 })))
    .toBeNull()
  const alone = fixture('sync', { land_sha: 'aaaa1111', phase_entered_at: Date.now() - 16 * 60_000 })
  expect(advanceTask(alone.run, alone.task, signals({ actorIdle: false, yieldTo: [], yieldAfterMs: 15 * 60_000 })))
    .toBeNull()
})

// ——— merge ———

test('merge: a landed head records the landing once and goes to close', () => {
  const { run, task } = fixture('merge', { land_sha: 'aaaa1111', submission: submitted() })
  expect(advanceTask(run, task, signals({ landing: facts({ landed: true }) }))?.phase).toBe('close')
  expect(task.merged_at_ms).not.toBeNull()
  expect(task.merge_commit).toBe('aaaa1111')
  expect(task.landed).toEqual([{ title: 'feat(menu): close on escape', land_sha: 'aaaa1111', at: task.merged_at_ms! }])

  enterTaskPhase(run, task, 'merge', 'rewound')
  advanceTask(run, task, signals({ landing: facts({ landed: true }) }))
  expect(task.landed).toHaveLength(1)
})

test('merge: a batch that moved before the landing sends the task back to sync', () => {
  const { run, task } = fixture('merge', { land_sha: 'aaaa1111' })
  expect(advanceTask(run, task, signals({ landing: facts({ upToDate: false }) }))?.phase).toBe('sync')
  expect(run.history.at(-1)?.why).toBe('batch/x moved to b0b0b0b0 before aaaa1111 landed')
})

test('merge: a push to the branch after its review that has not landed goes to sync, so it lands reviewed', () => {
  const { run, task } = fixture('merge', { land_sha: 'aaaa1111' })
  expect(advanceTask(run, task, signals({ landing: facts({ movedTo: 'dddd4444' }) }))?.phase).toBe('sync')
  expect(task.landed).toBeUndefined()
})

test('merge: a landing is recorded even when the branch moved on, and the rest syncs with the bead still open', () => {
  const { run, task } = fixture('merge', { land_sha: 'aaaa1111', submission: submitted() })
  expect(advanceTask(run, task, signals({ landing: facts({ landed: true, movedTo: 'dddd4444' }) }))?.phase).toBe('sync')
  expect(task.landed).toEqual([{ title: 'feat(menu): close on escape', land_sha: 'aaaa1111', at: expect.any(Number) }])
  expect(task.merged_at_ms).toBeNull()
  expect(task.merge_commit ?? null).toBeNull()
  expect(run.history.at(-1)?.why).toBe('t1-branch moved to dddd4444 after its reviewed head aaaa1111 landed')

  enterTaskPhase(run, task, 'merge', 'synced')
  advanceTask(run, task, signals({ landing: facts({ landed: true }) }))
  expect(task.phase).toBe('close')
  expect(task.landed).toHaveLength(1)
})

// Smoke run 14: t2's first landing skipped its PR review, a later commit went
// through pr-review, and that cleared every record of the skip.
test('a landing made past a skipped PR review keeps the skip once the task is reviewed again', () => {
  const { run, task } = fixture('merge', {
    tier: 'light', land_sha: 'aaaa1111', submission: submitted(), review_skip: SKIP,
  })
  expect(advanceTask(run, task, signals({ landing: facts({ landed: true, movedTo: 'dddd4444' }) }))?.phase).toBe('sync')
  enterTaskPhase(run, task, 'pr-review', 'sync of batch/x was not a clean merge')
  expect(task.review_skip).toBeUndefined()
  task.land_sha = 'eeee5555'
  enterTaskPhase(run, task, 'merge', 'cleared')
  advanceTask(run, task, signals({ landing: facts({ landed: true }) }))
  expect(task.landed?.map((l) => [l.land_sha, l.review_skipped])).toEqual([
    ['aaaa1111', ['pr-review']], ['eeee5555', undefined],
  ])
})

test('merge: up to date and not yet landed waits for the orchestrator, with no ci_head rule', () => {
  const { run, task } = fixture('merge', { land_sha: 'aaaa1111', ci_head: { sha: 'old', seen_at: 0 } })
  expect(advanceTask(run, task, signals({ landing: facts(), headSha: 'zzz' }))).toBeNull()
})
