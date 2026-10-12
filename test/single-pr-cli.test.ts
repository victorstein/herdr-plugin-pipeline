import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdRewind } from '../src/cli'
import { cmdTask } from './helpers/cmd-task'
import { listRuns, newRun, saveRun, withBatch } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

let dir: string
let repoDir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'single-pr-cli-'))
  repoDir = mkdtempSync(join(tmpdir(), 'single-pr-repo-'))
  mkdirSync(join(repoDir, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(repoDir, '.claude', 'agents', 'core-dev.md'), '# core-dev\n')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null,
  agent_status: 'unknown', phase: 'implement', phase_entered_at: 0,
  escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function perTaskRun(tasks: Partial<Task>[]): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks.map(mkTask)
  return run
}

const singlePrRun = (tasks: Partial<Task>[]): Run => withBatch(perTaskRun(tasks), batchFixture())

const saved = async (run: Run): Promise<Run> =>
  (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)!

test('a task cannot be rewound onto a row its run\'s mode skips', async () => {
  const perTask = perTaskRun([{ phase: 'implement' }])
  await saveRun(dir, perTask)
  for (const phase of ['land-queue', 'sync']) {
    const refused = await cmdRewind(ctx(), { runId: perTask.run_id, phase, taskId: 't1' })
    expect(refused.ok, phase).toBe(false)
    expect(refused.text, phase).toContain(`${phase} is not a phase of a per-task run`)
  }

  const singlePr = singlePrRun([{ phase: 'implement' }])
  await saveRun(dir, singlePr)
  const refused = await cmdRewind(ctx(), { runId: singlePr.run_id, phase: 'ci', taskId: 't1' })
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain('ci is not a phase of a single-PR run')
  expect((await saved(singlePr)).tasks[0]?.phase).toBe('implement')
})

test('a per-task run cannot be rewound onto a ship row', async () => {
  const run = perTaskRun([{ phase: 'done' }])
  await saveRun(dir, run)
  const refused = await cmdRewind(ctx(), { runId: run.run_id, phase: 'ship', taskId: null })
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain('ship is not a phase of a per-task run')
  expect((await saved(run)).phase).toBe('execute')
})

const register = (run: Run, branch: string, base = async (..._args: unknown[]) =>
  ({ commit: '1fb8a43', ref: 'origin/batch/x', fetchError: null })) =>
  cmdTask(ctx(), {
    branch, bead: 'hp-9', surface: 'core', notes: '', dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: run.run_id,
  }, undefined, base)

test('a single-PR task is never registered on the batch branch or the default branch', async () => {
  const run = singlePrRun([])
  await saveRun(dir, run)
  for (const branch of ['batch/x', 'main']) {
    const refused = await register(run, branch)
    expect(refused.ok, branch).toBe(false)
    expect(refused.text, branch).toContain(`--branch ${branch} is this run's`)
  }
  expect((await saved(run)).tasks).toEqual([])
})

test('a single-PR task is dispatched from the batch branch as just fetched', async () => {
  const run = singlePrRun([])
  await saveRun(dir, run)
  const asked: unknown[][] = []
  const out = await register(run, 'feat/y', async (...args: unknown[]) => {
    asked.push(args)
    return { commit: '9e06c26', ref: 'origin/batch/x', fetchError: null }
  })
  expect(out.ok).toBe(true)
  expect(asked).toEqual([[repoDir, [], 'batch/x']])
  expect(out.text).toContain('base: 9e06c26 (origin/batch/x as just fetched)')
})
