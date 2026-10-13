import { expect, test } from 'bun:test'
import {
  detectCycle, fileHolders, filesClearFor, filesOverlap, gateStatus, landingQueue, landingSlotHolder, lockingFiles,
  planDeclaredFiles, releasableFromFiles, separatePipelineArtifacts, sharedFiles, widenFiles,
} from '../src/lib/gating'
import type { Run, Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

const task = (over: Partial<Task>): Task => ({
  task_id: 't', branch: 'b', bead: 'hp-1', surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'queued', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

test('files overlap on a prefix, not only an exact path', () => {
  expect(filesOverlap(['packages/core/src/db/'], ['packages/core/src/db/usage.ts'])).toBe(true)
  expect(filesOverlap(['apps/api/'], ['packages/core/'])).toBe(false)
})

test('a task with satisfied dependencies is ready', () => {
  const done = task({ task_id: 't1', phase: 'done' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [done, waiting])).toEqual({ state: 'ready' })
})

test('a task waits on an unfinished dependency', () => {
  const running = task({ task_id: 't1', phase: 'implement' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [running, waiting])).toEqual({ state: 'waiting', on: ['t1'] })
})

test('a failed dependency blocks permanently rather than waiting forever', () => {
  const failed = task({ task_id: 't1', phase: 'failed' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [failed, waiting])).toEqual({ state: 'blocked-on-failure', on: ['t1'] })
})

test('an orphaned dependency also blocks permanently', () => {
  const orphaned = task({ task_id: 't1', phase: 'orphaned' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [orphaned, waiting]).state).toBe('blocked-on-failure')
})

test('an escalated dependency is waited on, not treated as a failure', () => {
  // A human resumes an escalated task with one rewind. Cascading its dependent
  // into the terminal blocked-on-failure would strand that dependent there.
  const stuck = task({ task_id: 't1', phase: 'escalated', escalated_from: 'implement' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [stuck, waiting])).toEqual({ state: 'waiting', on: ['t1'] })
})

test('a finished task does not hold its files', () => {
  const done = task({ task_id: 't1', phase: 'done', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/x.ts'] })
  expect(filesClearFor({ tasks: [done, waiting] }, waiting)).toBe(true)
})

test('an escalated task still holds its files', () => {
  // Nothing tears an escalated task down, so its worktree and unmerged work
  // persist — releasing the lock would let a second task edit the same files.
  const stuck = task({ task_id: 't1', phase: 'escalated', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/x.ts'] })
  expect(filesClearFor({ tasks: [stuck, waiting] }, waiting)).toBe(false)
})

test('an orphaned task releases its files, because its code already merged', () => {
  const merged = task({ task_id: 't1', phase: 'orphaned', files: ['apps/api/'] })
  const waiting = task({ task_id: 't2', phase: 'blocked-on-files', files: ['apps/api/main.ts'] })
  expect(filesClearFor({ tasks: [merged, waiting] }, waiting)).toBe(true)
})

test('queued ignores file overlap — only depends_on gates it', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'queued', files: ['packages/core/src/'] })
  expect(gateStatus(t2, [t1, t2])).toEqual({ state: 'ready' })
})

test('blocked-on-files is held by an in-flight overlapping sibling', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/src/'] })
  expect(filesClearFor({ tasks: [t1, t2] }, t2)).toBe(false)
})

test('a design-phase sibling does not hold files', () => {
  const t1 = task({ task_id: 't1', phase: 'plan', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/'] })
  expect(filesClearFor({ tasks: [t1, t2] }, t2)).toBe(true)
})

test('a failed sibling holds its files forever', () => {
  const t1 = task({ task_id: 't1', phase: 'failed', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/'] })
  expect(filesClearFor({ tasks: [t1, t2] }, t2)).toBe(false)
})

test('blocked-on-decision inherits file-holding from decision_from', () => {
  const held = task({ task_id: 't1', phase: 'blocked-on-decision', files: ['a/'] })
  held.decision_from = 'implement'
  const free = task({ task_id: 't3', phase: 'blocked-on-decision', files: ['a/'] })
  free.decision_from = 'plan'
  const waiter = task({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] })
  expect(filesClearFor({ tasks: [held, waiter] }, waiter)).toBe(false)
  expect(filesClearFor({ tasks: [free, waiter] }, waiter)).toBe(true)
})

test('at most one task leaves an overlapping group per tick', () => {
  const a = task({ task_id: 't1', phase: 'blocked-on-files', files: ['a/'] })
  const b = task({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] })
  expect(releasableFromFiles({ tasks: [a, b] }).map((t) => t.task_id)).toEqual(['t1'])
})

test('a plan declares files on column-0 FILES lines, comma-separated and repeatable', () => {
  const plan = [
    '# Plan',
    'FILES: src/lib/gating.ts, `test/gating.test.ts`',
    'FILES: ./prompts/plan.md',
    '',
  ].join('\n')
  expect(planDeclaredFiles(plan)).toEqual([
    'src/lib/gating.ts', 'test/gating.test.ts', 'prompts/plan.md',
  ])
})

test('an indented or fenced FILES line is documentation, not a declaration', () => {
  const plan = [
    '    FILES: quoted/example.ts',
    '```ts',
    'FILES: inside/a/fence.ts',
    '```',
    'FILES: real.ts',
  ].join('\n')
  expect(planDeclaredFiles(plan)).toEqual(['real.ts'])
})

test('a fence closes only on its own marker, at least as long as the opener', () => {
  const plan = [
    '````md',
    '~~~',
    'FILES: hidden/by-tilde.ts',
    '```',
    'FILES: hidden/by-short-backticks.ts',
    '````',
    'FILES: real.ts',
  ].join('\n')
  expect(planDeclaredFiles(plan)).toEqual(['real.ts'])
})

test('globs and absolute paths narrow to the prefix they imply, never to nothing', () => {
  const plan = [
    'FILES: src/**/*.ts, test/foo*.test.ts',
    'FILES: /wt/checkout/src/lib/gating.ts, /repo/docs/, /prompts/plan.md',
    'FILES: **/*.md',
  ].join('\n')
  expect(planDeclaredFiles(plan, ['/wt/checkout', '/repo/'])).toEqual([
    'src/', 'test/foo', 'src/lib/gating.ts', 'docs/', 'prompts/plan.md', '',
  ])
  expect(filesOverlap(['src/'], ['src/lib/x.ts'])).toBe(true)
  expect(filesOverlap([''], ['anything.ts'])).toBe(true)
})

test('widening adds only what the held prefixes do not already cover', () => {
  expect(widenFiles(['a/', 'b.ts'], ['a/x.ts', 'b.ts', 'c.ts', 'c.ts'])).toEqual(['c.ts'])
  expect(widenFiles(['a/'], [])).toEqual([])
})

const withArtifacts = (): Task => task({
  bead: 'hp-96',
  artifacts: {
    research: 'docs/superpowers/research/2026-09-24-hp-96-research.md',
    spec: 'docs/superpowers/specs/2026-09-24-hp-96-design.md',
    plan: 'docs/superpowers/plans/2026-09-24-hp-96-plan.md',
    verdicts: { 'plan-review-0': 'docs/superpowers/reviews/hp-96-plan-review-0.md' },
  },
})

test('a plan naming the pipeline\'s own artifact locations locks none of them', () => {
  const declared = [
    'docs/superpowers/', 'docs/superpowers', 'docs/superpowers/plans/', 'docs/superpowers/reviews',
    'docs/superpowers/specs/2026-09-24-hp-96-design.md',
    'docs/superpowers/plans/2026-09-24-hp-96-plan.md',
    'docs/superpowers/reviews/hp-96-plan-review-0.md',
    'docs/superpowers/reviews/hp-96-pr-review-quality-3.md',
    'src/lib/gating.ts',
  ]
  expect(separatePipelineArtifacts(declared, withArtifacts())).toEqual({
    kept: ['src/lib/gating.ts'],
    ignored: declared.slice(0, -1),
  })
})

test('real files beside the artifacts, and broader prefixes, stay locked', () => {
  const declared = [
    'docs/', 'docs/runbook.md', 'docs/superpowers-notes.md',
    'docs/superpowers/reviews/2026-09-24-live-smoke-run.md',
    'docs/superpowers/plans/2026-09-20-hp-12-plan.md',
    'docs/superpowers/reviews/hp-960-plan-review-0.md',
    '',
  ]
  expect(separatePipelineArtifacts(declared, withArtifacts())).toEqual({ kept: declared, ignored: [] })
})

test('a sibling declaring docs no longer overlaps a plan that only wrote its own artifacts', () => {
  const planner = withArtifacts()
  planner.files = ['src/greet.ts']
  const declared = planDeclaredFiles('FILES: test/greet.test.ts, docs/superpowers/\n')
  const { kept } = separatePipelineArtifacts(declared, planner)
  planner.files.push(...widenFiles(planner.files, kept))
  expect(planner.files).toEqual(['src/greet.ts', 'test/greet.test.ts'])
  expect(filesOverlap(planner.files, ['docs'])).toBe(false)
})

test('two waiters that each discover the other\'s files are serialised, not deadlocked', () => {
  const a = task({ task_id: 't1', phase: 'blocked-on-files', files: ['a/'] })
  const b = task({ task_id: 't2', phase: 'blocked-on-files', files: ['b/'] })
  expect(releasableFromFiles({ tasks: [a, b] }).map((t) => t.task_id)).toEqual(['t1', 't2'])

  a.files.push(...widenFiles(a.files, planDeclaredFiles('FILES: a/, b/x.ts\n')))
  expect(releasableFromFiles({ tasks: [a, b] }).map((t) => t.task_id)).toEqual(['t1'])

  b.files.push(...widenFiles(b.files, planDeclaredFiles('FILES: b/, a/y.ts\n')))
  expect(releasableFromFiles({ tasks: [a, b] }).map((t) => t.task_id)).toEqual(['t1'])

  a.phase = 'implement'
  expect(releasableFromFiles({ tasks: [a, b] })).toEqual([])

  a.phase = 'done'
  expect(releasableFromFiles({ tasks: [a, b] }).map((t) => t.task_id)).toEqual(['t2'])
})

// ——— shared paths: listed in .claude/pipeline-shared-paths, never locked ———

const sharing = (prefixes: string[], tasks: Task[]): Pick<Run, 'tasks' | 'shared_paths'> => ({
  tasks, shared_paths: { prefixes, ignored: [], commit: 'c0ffee', ref: 'origin/main', read_at: 0 },
})

test('a task locks its files minus every entry under a shared prefix', () => {
  const t1 = task({ task_id: 't1', files: ['src/reader/', 'docs/file-formats.md', 'docs/file-formats/v2.md', 'docs/'] })
  const run = sharing(['docs/file-formats'], [t1])
  expect(lockingFiles(run, t1)).toEqual(['src/reader/', 'docs/'])
  expect(sharedFiles(run, t1)).toEqual(['docs/file-formats.md', 'docs/file-formats/v2.md'])
})

test('a run with no shared paths locks every declared file, as before', () => {
  const t1 = task({ task_id: 't1', files: ['src/reader/', 'docs/file-formats.md'] })
  expect(lockingFiles({ tasks: [t1] }, t1)).toEqual(['src/reader/', 'docs/file-formats.md'])
  expect(sharedFiles({ tasks: [t1] }, t1)).toEqual([])
})

test('an overlap on a shared path alone holds nothing', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['src/a/', 'docs/registry.md'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['src/b/', 'docs/registry.md'] })
  const run = sharing(['docs/registry.md'], [t1, t2])
  expect(fileHolders(run, t2)).toEqual([])
  expect(filesClearFor(run, t2)).toBe(true)
  expect(filesClearFor({ tasks: [t1, t2] }, t2)).toBe(false)
})

test('a task whose every entry is shared locks nothing and is held by nothing', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['docs/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['docs/registry.md'] })
  const run = sharing(['docs/registry.md'], [t1, t2])
  expect(lockingFiles(run, t2)).toEqual([])
  expect(filesClearFor(run, t2)).toBe(true)
})

test('an entry broader than a shared prefix still locks the rest of it', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['docs/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['docs/other.md', 'docs/registry.md'] })
  const run = sharing(['docs/registry.md'], [t1, t2])
  expect(fileHolders(run, t2).map((t) => t.task_id)).toEqual(['t1'])
})

test('the overlap test on locking files is symmetric', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['src/a/', 'docs/registry.md'] })
  const t2 = task({ task_id: 't2', phase: 'pr-review', files: ['docs/'] })
  const t3 = task({ task_id: 't3', phase: 'ci', files: ['src/a/x.ts', 'docs/registry.md'] })
  const run = sharing(['docs/registry.md'], [t1, t2, t3])
  for (const a of run.tasks) {
    for (const b of run.tasks.filter((t) => t !== a)) {
      const aHeldByB = fileHolders(run, a).includes(b)
      expect(fileHolders(run, b).includes(a), `${a.task_id} ${b.task_id}`).toBe(aHeldByB)
    }
  }
  expect(fileHolders(run, t1).map((t) => t.task_id)).toEqual(['t3'])
  expect(fileHolders(run, t2)).toEqual([])
})

test('two waiters that share only a listed path leave the gate on the same pass', () => {
  const a = task({ task_id: 't1', phase: 'blocked-on-files', files: ['src/a/', 'docs/registry.md'] })
  const b = task({ task_id: 't2', phase: 'blocked-on-files', files: ['src/b/', 'docs/registry.md'] })
  const c = task({ task_id: 't3', phase: 'blocked-on-files', files: ['src/a/x.ts'] })
  expect(releasableFromFiles(sharing(['docs/registry.md'], [a, b, c])).map((t) => t.task_id)).toEqual(['t1', 't2'])
  expect(releasableFromFiles({ tasks: [a, b, c] }).map((t) => t.task_id)).toEqual(['t1'])
})

test('detectCycle names a cycle', () => {
  const a = task({ task_id: 't1', depends_on: ['t2'] })
  const b = task({ task_id: 't2', depends_on: ['t1'] })
  expect(detectCycle([a, b])).toEqual(['t1', 't2'])
})

test('detectCycle returns null for an acyclic graph', () => {
  const a = task({ task_id: 't1' })
  const b = task({ task_id: 't2', depends_on: ['t1'] })
  expect(detectCycle([a, b])).toBeNull()
})

// ——— single-PR: one landing at a time ———

test('the landing slot is held from sync through merge, and through a decision asked from either', () => {
  for (const phase of ['sync', 'merge'] as const) {
    expect(landingSlotHolder([task({ task_id: 't1', phase })])?.task_id, phase).toBe('t1')
  }
  for (const from of ['sync', 'merge'] as const) {
    const asking = task({ task_id: 't1', phase: 'blocked-on-decision', decision_from: from })
    expect(landingSlotHolder([asking])?.task_id, from).toBe('t1')
  }
  for (const phase of ['close', 'escalated', 'failed', 'pr-review', 'land-queue'] as const) {
    expect(landingSlotHolder([task({ task_id: 't1', phase })]), phase).toBeNull()
  }
  expect(landingSlotHolder([task({ phase: 'blocked-on-decision', decision_from: 'implement' })])).toBeNull()
})

test('the landing queue is ordered by entry time, then task id', () => {
  const queue = landingQueue([
    task({ task_id: 't3', phase: 'land-queue', phase_entered_at: 5 }),
    task({ task_id: 't2', phase: 'land-queue', phase_entered_at: 5 }),
    task({ task_id: 't1', phase: 'land-queue', phase_entered_at: 9 }),
    task({ task_id: 't4', phase: 'sync', phase_entered_at: 1 }),
  ])
  expect(queue.map((t) => t.task_id)).toEqual(['t2', 't3', 't1'])
})
