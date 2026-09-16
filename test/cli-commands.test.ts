import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdAbort, cmdForget, cmdRelease, cmdResume, cmdStatus } from '../src/cli'
import { filesClearFor } from '../src/lib/gating'
import { listRuns, newRun, saveRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

let dir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'clicmd-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function seed() {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  await saveRun(dir, run)
  return run
}

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'b', issue: 1, surface: 'core', depends_on: [], files: [],
  keep_worktree: false, text: '', workspace_id: null, pane_id: null,
  agent_status: 'unknown', phase: 'queued', phase_entered_at: 0,
  escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: null, registered_at: 0, adopted_at: null,
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, notes: '',
  ...over,
})

function runWithTasks(overrides: Partial<Task>[]): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.tasks = overrides.map(mkTask)
  return run
}

test('status reports no active runs on an empty ledger', async () => {
  expect((await cmdStatus(ctx())).text).toContain('no active runs')
})

test('abort marks the run aborted and it stops being active', async () => {
  const run = await seed()
  expect((await cmdAbort(ctx(), { runId: run.run_id })).ok).toBe(true)
  const after = (await listRuns(dir, 'personal'))[0]
  expect(after?.phase).toBe('done')
  expect(after?.history.at(-1)?.why).toContain('aborted')
})

test('resume undoes an abort back to the phase it was in', async () => {
  const run = await seed()
  await cmdAbort(ctx(), { runId: run.run_id })
  expect((await cmdResume(ctx(), { runId: run.run_id })).ok).toBe(true)
  expect((await listRuns(dir, 'personal'))[0]?.phase).toBe('intake')
})

test('resume on a run that was never aborted is refused', async () => {
  const run = await seed()
  expect((await cmdResume(ctx(), { runId: run.run_id })).ok).toBe(false)
})

test('forget unbinds a workspace from its task', async () => {
  const run = await seed()
  run.tasks.push({
    task_id: 't1', branch: 'b', issue: 1, surface: 'core', depends_on: [], files: [],
    keep_worktree: false, text: '', workspace_id: 'w7', pane_id: 'w7:p1',
    agent_status: 'idle', phase: 'implement', phase_entered_at: 0,
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, notes: '',
  })
  await saveRun(dir, run)

  expect((await cmdForget(ctx(), { workspaceId: 'w7' })).ok).toBe(true)
  expect((await listRuns(dir, 'personal'))[0]?.tasks[0]?.workspace_id).toBeNull()
})

test('release drops a terminal task files reservation', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'failed', files: ['a/'] },
    { task_id: 't2', phase: 'blocked-on-files', files: ['a/'] },
  ])
  await cmdRelease(dir, run, 't1')
  expect(run.tasks[0]?.files).toEqual([])
})

test('release refuses a task that is still in flight', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'implement', files: ['a/'] }])
  await expect(cmdRelease(dir, run, 't1')).rejects.toThrow('still in flight')
})

test('release unblocks a sibling that was waiting on the same files', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'failed', files: ['a/'] },
    { task_id: 't2', phase: 'blocked-on-files', files: ['a/'] },
  ])
  const waiter = run.tasks[1]!
  expect(filesClearFor(waiter, run.tasks)).toBe(false)

  await cmdRelease(dir, run, 't1')

  expect(filesClearFor(waiter, run.tasks)).toBe(true)
})
