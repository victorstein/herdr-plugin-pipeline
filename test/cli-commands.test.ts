import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cmdAbort, cmdDispatchDone, cmdForget, cmdRelease, cmdResume, cmdRewind, cmdStatus, cmdTask,
} from '../src/cli'
import { filesClearFor } from '../src/lib/gating'
import { activeRunForRepo, listRuns, newRun, saveRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

let dir: string
let repoDir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clicmd-'))
  // `hpipe task` rejects a --surface with no matching agent definition, so the
  // fixture repo must carry a real one.
  repoDir = mkdtempSync(join(tmpdir(), 'clicmd-repo-'))
  mkdirSync(join(repoDir, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(repoDir, '.claude', 'agents', 'core-dev.md'), '# core-dev\n')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

async function seed() {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  await saveRun(dir, run)
  return run
}

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
    keep_worktree: false, workspace_id: 'w7', pane_id: 'w7:p1',
    agent_status: 'idle', phase: 'implement', phase_entered_at: 0,
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
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
  await saveRun(dir, run)

  expect((await cmdRelease(ctx(), { taskId: 't1' })).ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.files).toEqual([])
})

test('release refuses a task that is still in flight', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'implement', files: ['a/'] }])
  await saveRun(dir, run)

  const result = await cmdRelease(ctx(), { taskId: 't1' })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('still in flight')

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.files).toEqual(['a/'])
})

test('release unblocks a sibling that was waiting on the same files', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'failed', files: ['a/'] },
    { task_id: 't2', phase: 'blocked-on-files', files: ['a/'] },
  ])
  await saveRun(dir, run)
  expect(filesClearFor(run.tasks[1]!, run.tasks)).toBe(false)

  await cmdRelease(ctx(), { taskId: 't1' })

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(filesClearFor(saved!.tasks[1]!, saved!.tasks)).toBe(true)
})

test('task registration requires an issue and seeds artifact paths', async () => {
  // t1 stays in flight so the new task's dependsOn leaves it gated — a task
  // dispatched immediately at registration moves off 'queued' (covered by
  // cli.test.ts), which is not what this test is checking.
  const run = runWithTasks([{ task_id: 't1', phase: 'implement' }])
  run.repo_root = repoDir
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/land-first', issue: 210, surface: 'core', notes: 'land first',
    dependsOn: ['t1'], files: [], keepWorktree: false,
  })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  const task = saved?.tasks.find((t) => t.task_id === 't2')
  expect(task?.issue).toBe(210)
  expect(task?.notes).toBe('land first')
  expect(task?.artifacts.research).toContain('issue-210')
  expect(task?.artifacts.spec).toContain('issue-210')
  expect(task?.artifacts.plan).toContain('issue-210')
  expect(task?.registered_at).toBeGreaterThan(0)
  expect(task?.phase).toBe('queued')
})

test('the three seeded artifact paths are distinct and land in the right directories', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/paths', issue: 42, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
  })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  const task = saved!.tasks[0]!
  const paths = [task.artifacts.research, task.artifacts.spec, task.artifacts.plan]
  expect(new Set(paths).size).toBe(3)
  expect(task.artifacts.research).toContain('docs/superpowers/research/')
  expect(task.artifacts.spec).toContain('docs/superpowers/specs/')
  expect(task.artifacts.plan).toContain('docs/superpowers/plans/')
})

test('registering a task reopens intake', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  run.intake_closed = true
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/reopen', issue: 7, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
  })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.intake_closed).toBe(false)
})

test('dispatch --done closes intake', async () => {
  const run = await seed()
  expect(run.intake_closed).toBe(false)

  const result = await cmdDispatchDone(ctx(), { runId: run.run_id })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.intake_closed).toBe(true)
})

test('registering a task after dispatch --done reopens intake', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  await cmdDispatchDone(ctx(), { runId: run.run_id })
  const closed = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(closed?.intake_closed).toBe(true)

  const result = await cmdTask(ctx(), {
    branch: 'feat/reopen-again', issue: 9, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
  })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.intake_closed).toBe(false)
})

test('rewind clears the whole counter map rather than spending a pass', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'escalated', passes: { 'spec-review': 2, ci: 1 } },
  ])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'spec', taskId: 't1' })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.passes).toEqual({})
})

test('rewind clears a pending answer and records the discard', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'blocked-on-decision', pending_answer: 'd1' },
  ])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'plan', taskId: 't1' })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.pending_answer).toBeNull()
  expect(saved?.history.some((h) => h.why.includes('d1') && h.why.includes('discard'))).toBe(true)
})

test('rewind to dispatch clears adopted_at on bound tasks so the row can re-fire', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'implement', workspace_id: 'w7', adopted_at: 1000 },
  ])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'dispatch', taskId: null })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.adopted_at).toBeNull()
})

test('dispatch --done finds the active run when no id is given', async () => {
  // Both intake.md and dispatch.md invoke it bare, so the fallback is the path
  // the orchestrator actually takes.
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdDispatchDone(ctx(), {})
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.intake_closed).toBe(true)
})
