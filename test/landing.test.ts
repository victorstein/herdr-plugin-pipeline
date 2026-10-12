import { afterEach, expect, test } from 'bun:test'
import { newRun, withBatch } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { advanceTasks, type TaskDeps } from '../src/supervisor/tasks'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'
import { cleanupFixtures } from './helpers/git-worktree'

afterEach(cleanupFixtures)

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'queued', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/t1', registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function singlePrRun(tasks: Task[]): Run {
  const run = withBatch(newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' }),
    batchFixture())
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  return run
}

const deps = (over: Partial<TaskDeps> = {}): TaskDeps => ({
  pluginRoot: process.cwd(),
  liveIdle: async () => true,
  hasLiveAgent: () => true,
  maxPasses: 2,
  fileSettleMs: 0,
  prForBranch: async () => null,
  prView: async () => null,
  verdictFor: async () => null,
  removeWorktree: async () => 'removed',
  removeCheckout: async () => ({ removed: true }),
  ciDetail: async () => '',
  ambiguityLog: new Set<string>(),
  uncommittedPaths: async () => [],
  freshDispatchBase: async () => ({ commit: '1fb8a43', ref: 'origin/batch/x', fetchError: null }),
  ...over,
})

test('a single-PR task opened by its gate is cut from the batch branch', async () => {
  const asked: Array<string | null> = []
  const run = singlePrRun([mkTask({})])
  const prompts = await advanceTasks(run, deps({
    freshDispatchBase: async (_root, _merges, branch) => {
      asked.push(branch)
      return { commit: '9e06c26', ref: 'origin/batch/x', fetchError: null }
    },
  }))
  expect(asked).toEqual(['batch/x'])
  expect(prompts[0]?.text).toContain('base: 9e06c26 (origin/batch/x as just fetched)')
})
