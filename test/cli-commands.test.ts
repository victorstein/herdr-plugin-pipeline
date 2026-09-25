import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cmdAbort, cmdAnswer, cmdBrief, cmdDecide, cmdDispatchDone, cmdDispatchTask, cmdForget,
  cmdRelease, cmdResume, cmdRewind, cmdShow, cmdStatus, cmdTask, recordWorkerPane,
} from '../src/cli'
import { artifactPathFor, taskSignalsFor } from '../src/supervisor/deliver'
import { outboxPending } from '../src/supervisor/courier'
import { advanceRun } from '../src/lib/machine'
import { advanceTasks } from '../src/supervisor/tasks'
import { openDecisionFor } from '../src/lib/decisions'
import { filesClearFor } from '../src/lib/gating'
import { listRuns, newRun, saveRun, StaleRunError } from '../src/lib/ledger'
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

  expect((await cmdRelease(ctx(), { taskId: 't1', repoKey: 'k', runId: null })).ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.files).toEqual([])
})

test('release refuses a task that is still in flight', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'implement', files: ['a/'] }])
  await saveRun(dir, run)

  const result = await cmdRelease(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
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

  await cmdRelease(ctx(), { taskId: 't1', repoKey: 'k', runId: null })

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
    repoKey: 'k', runId: null,
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
    repoKey: 'k', runId: null,
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

test('a task dispatched at registration prints the base it is cut from, one containing its dependency', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'done', merged_at_ms: 7_000, merge_commit: 'c0ffee1' }])
  run.repo_root = repoDir
  await saveRun(dir, run)
  const requested: Array<[string, string[] | null]> = []

  const result = await cmdTask(ctx(), {
    branch: 'feat/dependent', issue: 43, surface: 'core', notes: '',
    dependsOn: ['t1'], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  }, undefined, async (repoRoot, merges) => {
    requested.push([repoRoot, merges])
    return { commit: '1fb8a43', ref: 'origin/main', fetchError: null }
  })

  expect(result.ok).toBe(true)
  expect(requested).toEqual([[repoDir, ['c0ffee1']]])
  const header = result.text.split('\n\n')[0]!.split('\n')
  expect(header).toContain('base: 1fb8a43 (origin/main as just fetched)')
})

test('a queued registration fetches nothing and prints no base', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'implement' }])
  run.repo_root = repoDir
  await saveRun(dir, run)
  let fetched = false

  const result = await cmdTask(ctx(), {
    branch: 'feat/later', issue: 44, surface: 'core', notes: '',
    dependsOn: ['t1'], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  }, undefined, async () => {
    fetched = true
    return { commit: '1fb8a43', ref: 'origin/main', fetchError: null }
  })

  expect(result.text).toContain('queued: waiting on t1')
  expect(result.text).not.toContain('base:')
  expect(fetched).toBe(false)
})

test('registering a task reopens intake', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  run.intake_closed = true
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/reopen', issue: 7, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.intake_closed).toBe(false)
})

const unfiledTask = {
  branch: 'feat/tile-label', issue: 0, surface: 'core', notes: '',
  dependsOn: [] as string[], files: [] as string[], keepWorktree: false,
  repoKey: 'k', runId: null,
}

async function seedInRepoWithBrief(): Promise<string> {
  await saveRun(dir, newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' }))
  const bodyFile = join(repoDir, 'brief.md')
  writeFileSync(bodyFile, 'Relabel the settings tile.\n')
  return bodyFile
}

const registered = async (): Promise<Task[]> => (await listRuns(dir, 'personal'))[0]!.tasks

const issue318 = { number: 318, url: 'https://github.com/o/r/issues/318' }

/** Lands a write between the command's read and its save, as the supervisor would. */
async function supervisorWrites(change: (run: Run) => void): Promise<void> {
  const run = (await listRuns(dir, 'personal'))[0]!
  change(run)
  await saveRun(dir, run)
}

test('--title files the issue in the run\'s repo and registers the task under its number', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const filed: string[][] = []

  const result = await cmdTask(ctx(), { ...unfiledTask, title: 'Relabel the tile', bodyFile },
    async (repoRoot, title, path) => { filed.push([repoRoot, title, path]); return issue318 })

  expect(result.ok).toBe(true)
  expect(result.text).toContain('issue: #318 (filed)')
  expect(filed).toEqual([[repoDir, 'Relabel the tile', bodyFile]])
  const task = (await registered())[0]!
  expect(task.issue).toBe(318)
  expect(task.artifacts.spec).toContain('issue-318')
})

test('--issue and --title together are rejected before anything is filed', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let filed = 0

  const result = await cmdTask(ctx(), { ...unfiledTask, issue: 4, title: 't', bodyFile },
    async () => { filed++; return issue318 })

  expect(result.ok).toBe(false)
  expect(result.text).toContain('--issue')
  expect(result.text).toContain('--title')
  expect(filed).toBe(0)
})

test('--title without a --body-file that is a file is rejected, because the body is the brief', async () => {
  await seedInRepoWithBrief()
  let filed = 0
  const fileIssue = async () => { filed++; return issue318 }

  const missing = await cmdTask(ctx(), { ...unfiledTask, title: 't' }, fileIssue)
  const absent = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile: join(repoDir, 'nope.md') }, fileIssue)
  const directory = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile: repoDir }, fileIssue)

  expect(missing.ok).toBe(false)
  expect(missing.text).toContain('--body-file')
  expect(absent.ok).toBe(false)
  expect(absent.text).toContain('nope.md')
  expect(directory.ok).toBe(false)
  expect(directory.text).toContain('is not a file')
  expect(filed).toBe(0)
  expect(await registered()).toEqual([])
})

test('a --title that swallowed the next flag files nothing', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let filed = 0

  const result = await cmdTask(ctx(), { ...unfiledTask, title: '--body-file', bodyFile },
    async () => { filed++; return issue318 })

  expect(result.ok).toBe(false)
  expect(result.text).toContain('the value after --title is missing')
  expect(filed).toBe(0)
})

test('a registration that fails validation files no orphan issue', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let filed = 0
  const fileIssue = async () => { filed++; return issue318 }

  const badSurface = await cmdTask(ctx(), { ...unfiledTask, surface: 'kore', title: 't', bodyFile }, fileIssue)
  const badDepends = await cmdTask(ctx(), { ...unfiledTask, dependsOn: ['t9'], title: 't', bodyFile }, fileIssue)
  const cyclic = await cmdTask(ctx(), { ...unfiledTask, dependsOn: ['t1'], title: 't', bodyFile }, fileIssue)

  expect([badSurface.ok, badDepends.ok, cyclic.ok]).toEqual([false, false, false])
  expect(cyclic.text).toContain('cycle')
  expect(filed).toBe(0)
})

test('a registration that loses its save is retried without filing the issue again', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let filed = 0

  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile }, async () => {
    filed++
    await supervisorWrites((run) => { run.intake_closed = true })
    return issue318
  })

  expect(result.ok).toBe(true)
  expect(filed).toBe(1)
  expect((await registered()).map((t) => t.issue)).toEqual([318])
})

test('a registration that fails after filing names the issue so it can be registered with --issue', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let filed = 0

  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile }, async () => {
    filed++
    await supervisorWrites((run) => { run.phase = 'done' })
    return issue318
  })

  expect(result.ok).toBe(false)
  expect(filed).toBe(1)
  expect(result.text).toContain('issue #318 was filed (https://github.com/o/r/issues/318) but no task was registered')
  expect(result.text).toContain('--issue 318')
  expect(await registered()).toEqual([])
})

test('a failure after the registration landed says so, and does not invite a second registration', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const noPrompts = mkdtempSync(join(tmpdir(), 'clicmd-noprompts-'))

  const result = await cmdTask({ ...ctx(), pluginRoot: noPrompts }, { ...unfiledTask, title: 't', bodyFile },
    async () => issue318)
  rmSync(noPrompts, { recursive: true, force: true })

  expect(result.ok).toBe(false)
  expect(result.text).toContain('task t1 is registered with issue #318')
  expect(result.text).toContain('hpipe brief --task t1')
  expect(result.text).not.toContain('--issue 318')
  expect((await registered()).map((t) => t.issue)).toEqual([318])
})

test('a failed gh issue create registers nothing and passes gh\'s error through', async () => {
  const bodyFile = await seedInRepoWithBrief()

  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile },
    async () => ({ error: 'HTTP 410: Issues are disabled for this repo' }))

  expect(result.ok).toBe(false)
  expect(result.text).toContain('gh issue create failed')
  expect(result.text).toContain('HTTP 410: Issues are disabled for this repo')
  expect(await registered()).toEqual([])
})

test('with neither --issue nor --title the error names both ways in', async () => {
  await seedInRepoWithBrief()

  const result = await cmdTask(ctx(), unfiledTask, async () => issue318)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('--issue must be a positive issue number')
  expect(result.text).toContain('--title')
})

test('dispatch --done closes intake', async () => {
  const run = await seed()
  expect(run.intake_closed).toBe(false)

  const result = await cmdDispatchDone(ctx(), { runId: run.run_id, repoKey: 'k' })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.intake_closed).toBe(true)
})

test('registering a task after dispatch --done reopens intake', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  await cmdDispatchDone(ctx(), { runId: run.run_id, repoKey: 'k' })
  const closed = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(closed?.intake_closed).toBe(true)

  const result = await cmdTask(ctx(), {
    branch: 'feat/reopen-again', issue: 9, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
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

const MERGED_PR_STATE: Partial<Task> = {
  pr: 5, ci: 'pass', head_sha_at_entry: 'aaa', merged_at_ms: 9_000, issue_closed_at_entry: true,
}

test('rewind to implement or earlier forgets the PR, so a merged one cannot finish the task', async () => {
  // `merge` is a level: a sticky pr pointing at an already-merged PR would carry
  // the reworked task straight through merge on the old PR's mergedAt.
  for (const phase of ['implement', 'blocked-on-files', 'plan', 'research'] as const) {
    const run = runWithTasks([{ task_id: 't1', phase: 'done', ...MERGED_PR_STATE }])
    await saveRun(dir, run)

    expect((await cmdRewind(ctx(), { runId: run.run_id, phase, taskId: 't1' })).ok).toBe(true)

    const task = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)?.tasks[0]
    expect(task?.pr, phase).toBeNull()
    expect(task?.ci, phase).toBeNull()
    expect(task?.merged_at_ms, phase).toBeNull()
    expect(task?.issue_closed_at_entry, phase).toBe(false)
  }
})

test('a task resumed into implement with its PR still open waits for a new push', async () => {
  // The #46 resume path: a review sent it back at head H, it escalated from
  // implement, and the human resumed it. The rejected head must not count as work.
  const run = runWithTasks([{
    task_id: 't1', phase: 'escalated', escalated_from: 'implement',
    workspace_id: 'w7', pane_id: 'w7:p1', checkout_path: '/r/.worktrees/b',
    pr: 5, head_sha_at_entry: 'H',
  }])
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  await saveRun(dir, run)

  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' })).ok).toBe(true)
  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id) as Run

  let head = 'H'
  const deps = {
    pluginRoot: join(import.meta.dir, '..'),
    liveIdle: async () => true,
    maxPasses: 2,
    fileSettleMs: 0,
    prForBranch: async () => 5,
    prView: async () => ({ merged: false, mergedAtMs: null, headSha: head }),
    issueView: async () => null,
    verdictFor: async () => null,
    removeWorktree: async () => 'removed' as const,
    ciDetail: async () => '',
    ambiguityLog: new Set<string>(),
    uncommittedPaths: async () => [],
    freshDispatchBase: async () => ({ commit: '1fb8a43', ref: 'origin/main', fetchError: null }),
  }
  await advanceTasks(saved, deps)
  expect(saved.tasks[0]?.phase).toBe('implement')

  head = 'I'
  await advanceTasks(saved, deps)
  expect(saved.tasks[0]?.phase).toBe('pr-review-intent')
})

test('rewind onto a phase that works the current PR keeps it', async () => {
  for (const phase of ['pr-review-intent', 'ci', 'merge', 'close'] as const) {
    const run = runWithTasks([{ task_id: 't1', phase: 'done', ...MERGED_PR_STATE }])
    await saveRun(dir, run)

    expect((await cmdRewind(ctx(), { runId: run.run_id, phase, taskId: 't1' })).ok).toBe(true)

    const task = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)?.tasks[0]
    expect(task?.pr, phase).toBe(5)
    expect(task?.merged_at_ms, phase).toBe(9_000)
  }
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

test('rewind to dispatch keeps each binding, and the run leaves dispatch on the next evaluation', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'implement', workspace_id: 'w7', adopted_at: 1000 },
  ])
  run.phase = 'execute'
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'dispatch', taskId: null })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id) as Run
  expect(saved.phase).toBe('dispatch')
  expect(saved.tasks[0]?.workspace_id).toBe('w7')
  expect(advanceRun(saved, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    ...taskSignalsFor(saved),
  })?.phase).toBe('execute')
})

test('a run rewound to intake is carried out by the next registration, then through dispatch', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'implement', workspace_id: 'w7' }])
  run.phase = 'execute'
  await saveRun(dir, run)

  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'intake', taskId: null })).ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id) as Run
  const base = { actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2 }
  expect(advanceRun(saved, { ...base, ...taskSignalsFor(saved) })).toBeNull()

  saved.tasks.push(mkTask({
    task_id: 't2', phase: 'research', workspace_id: 'w8', registered_at: saved.phase_entered_at + 1,
  }))
  expect(advanceRun(saved, { ...base, ...taskSignalsFor(saved) })?.phase).toBe('dispatch')
  expect(advanceRun(saved, { ...base, ...taskSignalsFor(saved) })?.phase).toBe('execute')
})

test('dispatch --done finds the active run when no id is given', async () => {
  // Both intake.md and dispatch.md invoke it bare, so the fallback is the path
  // the orchestrator actually takes.
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdDispatchDone(ctx(), { runId: null, repoKey: 'k' })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.intake_closed).toBe(true)
})

test('task registration refuses a missing issue number', async () => {
  // Live-run finding: the argv parser defaults --issue to 0, so a mistyped
  // command minted a ghost task into a running run.
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/x', issue: 0, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('--issue')

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks).toHaveLength(0)
})

test('task registration refuses an empty branch', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: '   ', issue: 7, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('--branch')
})

test('brief renders a worker brief without mutating the run', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)
  await cmdTask(ctx(), {
    branch: 'feat/x', issue: 11, surface: 'core', notes: 'land first',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  })

  const before = JSON.stringify((await listRuns(dir, 'personal'))[0])
  const result = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })

  expect(result.ok).toBe(true)
  expect(result.text).toContain('11')
  expect(result.text).toContain('land first')
  expect(JSON.stringify((await listRuns(dir, 'personal'))[0])).toBe(before)
})

test('past research the brief leaves out the research section a fresh agent would obey — #94', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'research' }])
  run.repo_key = 'k'
  await saveRun(dir, run)
  expect((await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })).text)
    .toContain('## Phase 1 — research')

  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' })).ok).toBe(true)
  const past = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  expect(past.text).toContain('Your task id is `t1`')
  expect(past.text).not.toContain('## Phase 1 — research')
})

test('the brief states the path contract without promising a recovery', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)
  await cmdTask(ctx(), {
    branch: 'feat/x', issue: 11, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  })

  const result = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  expect(result.text).toContain('does not satisfy this phase\'s contract')
  expect(result.text).not.toContain('stats those paths and nothing else')
})

test('task registers into this repo run, not another repo run that sorts first', async () => {
  // Issue #21, reproduced. The foreign run MUST sort first or this test passes
  // without the fix: newRun prefixes run_id with basename(repoRoot)
  // (src/lib/ledger.ts:22, :25) and listRuns sorts by filename (:57). repoDir is
  // a mkdtemp `clicmd-repo-…`, so the foreign run needs a repoRoot that beats
  // `c` — hence '/aaa', not '/r'.
  const other = newRun({ session: 'personal', socketPath: '/s', repoKey: '/repos/aaa', repoRoot: '/aaa', title: 'other repo' })
  await saveRun(dir, other)
  const mine = newRun({ session: 'personal', socketPath: '/s', repoKey: '/repos/zzz', repoRoot: repoDir, title: 'mine' })
  await saveRun(dir, mine)

  const result = await cmdTask(ctx(), {
    branch: 'feat/x', issue: 21, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: '/repos/zzz', runId: null,
  })
  expect(result.ok).toBe(true)

  const runs = await listRuns(dir, 'personal')
  expect(runs.find((r) => r.run_id === mine.run_id)?.tasks).toHaveLength(1)
  expect(runs.find((r) => r.run_id === other.run_id)?.tasks).toHaveLength(0)
})

test('task names the candidates rather than choosing between two live runs', async () => {
  const a = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'aaa' })
  const b = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'bbb' })
  await saveRun(dir, a)
  await saveRun(dir, b)

  const result = await cmdTask(ctx(), {
    branch: 'feat/x', issue: 21, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(false)
  expect(result.text).toContain(a.run_id)
  expect(result.text).toContain(b.run_id)
  expect(result.text).toContain('--run')
})

test('brief renders the live run brief when a finished run holds the same task id', async () => {
  // Issue #36, reproduced: the finished run sorts first and wins today, and its
  // brief was delivered to a worker that then researched an already-merged issue.
  const done = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'aaa finished' })
  done.phase = 'done'
  await saveRun(dir, done)
  const live = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'zzz live' })
  await saveRun(dir, live)

  await cmdTask(ctx(), {
    branch: 'feat/live', issue: 36, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })
  // Give the finished run a t1 too, so both hold the id being asked for.
  const withTask = (await listRuns(dir, 'personal')).find((r) => r.run_id === live.run_id)!
  const stale = (await listRuns(dir, 'personal')).find((r) => r.run_id === done.run_id)!
  stale.tasks.push({ ...withTask.tasks[0]!, issue: 9, branch: 'fix/9-artifact-paths' })
  await saveRun(dir, stale)

  const result = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  expect(result.ok).toBe(true)
  expect(result.text).toContain('issue #36')
  expect(result.text).not.toContain('issue #9')
})

test('brief renders a finished run brief when that run is named', async () => {
  const done = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'finished' })
  await saveRun(dir, done)
  await cmdTask(ctx(), {
    branch: 'feat/x', issue: 36, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })
  const saved = (await listRuns(dir, 'personal'))[0]!
  saved.phase = 'done'
  await saveRun(dir, saved)

  const bare = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  expect(bare.ok).toBe(false)
  expect(bare.text).toContain('--run')

  const named = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: saved.run_id })
  expect(named.ok).toBe(true)
})

test('release clears the live run reservation, not a finished run with the same task id', async () => {
  // The title must go through newRun: run_id carries the slug (src/lib/ledger.ts:25)
  // and listRuns sorts by filename (:57). runWithTasks hardcodes title 'a', so
  // assigning .title afterwards leaves the sort to newRun's random suffix and
  // this test becomes a coin flip.
  const done = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'aaa finished' })
  done.phase = 'done'
  done.tasks = [mkTask({ task_id: 't1', phase: 'failed', files: ['a/'] })]
  await saveRun(dir, done)
  const live = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'zzz live' })
  live.tasks = [mkTask({ task_id: 't1', phase: 'failed', files: ['b/'] })]
  await saveRun(dir, live)

  const result = await cmdRelease(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  expect(result.ok).toBe(true)

  const runs = await listRuns(dir, 'personal')
  expect(runs.find((r) => r.run_id === live.run_id)?.tasks[0]?.files).toEqual([])
  expect(runs.find((r) => r.run_id === done.run_id)?.tasks[0]?.files).toEqual(['a/'])

  // Spec testing item 8b: the escape the refusal message offers must work.
  const named = await cmdRelease(ctx(), { taskId: 't1', repoKey: 'k', runId: done.run_id })
  expect(named.ok).toBe(true)
  const after = await listRuns(dir, 'personal')
  expect(after.find((r) => r.run_id === done.run_id)?.tasks[0]?.files).toEqual([])
})

test('dispatch --done closes the run in the caller repo, not another repo run that sorts first', async () => {
  // The gap this step closes is the REPO filter: cmdDispatchDone already skips a
  // terminal run today (src/cli.ts:173), so a done-vs-live fixture would pass
  // without the fix. Both runs here are live, in different repos.
  const other = newRun({ session: 'personal', socketPath: '/s', repoKey: '/repos/aaa', repoRoot: '/aaa', title: 'other repo' })
  await saveRun(dir, other)
  const mine = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'mine' })
  await saveRun(dir, mine)

  const result = await cmdDispatchDone(ctx(), { runId: null, repoKey: 'k' })
  expect(result.ok).toBe(true)
  expect(result.text).toContain(mine.run_id)

  const runs = await listRuns(dir, 'personal')
  expect(runs.find((r) => r.run_id === mine.run_id)?.intake_closed).toBe(true)
  expect(runs.find((r) => r.run_id === other.run_id)?.intake_closed).toBe(false)
})

test('rewind refuses a phase that is in no row and writes nothing', async () => {
  // rewind writes its argument straight onto the record, and every later row
  // lookup throws on a phase with no row — including resolveRun's.
  const run = runWithTasks([{ task_id: 't1', phase: 'implement' }])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'dnoe', taskId: 't1' })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('dnoe')
  expect(result.text).toContain('implement')

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.phase).toBe('implement')
})

test('rewind refuses a run phase that is in no row', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'implement' }])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'excute', taskId: null })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('execute')

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.phase).toBe('intake')
})

test('rewind to a terminal phase abandons an open decision', async () => {
  // #38's repair needed three commands per task because a rewind left the
  // decision open and hpipe status kept nagging about it.
  const run = runWithTasks([{ task_id: 't1', phase: 'blocked-on-decision' }])
  const task = run.tasks[0]!
  task.decisions.push({
    id: 'd1', asked_at: 1, from_phase: 'plan', question: 'q', recommendation: 'r',
    answer: null, answered_by: null, answered_at: null, prompted_at: null,
  })
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'done', taskId: 't1' })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(openDecisionFor(saved!.tasks[0]!)).toBeNull()
  expect(saved?.history.some((h) => h.why.includes('d1') && h.why.includes('abandoned'))).toBe(true)
})

test('rewind to a live phase leaves an open decision alone', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'blocked-on-decision' }])
  run.tasks[0]!.decisions.push({
    id: 'd1', asked_at: 1, from_phase: 'plan', question: 'q', recommendation: 'r',
    answer: null, answered_by: null, answered_at: null, prompted_at: null,
  })
  await saveRun(dir, run)

  await cmdRewind(ctx(), { runId: run.run_id, phase: 'plan', taskId: 't1' })

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(openDecisionFor(saved!.tasks[0]!)?.id).toBe('d1')
})

test('a terminal rewind keeps the undelivered-answer history entry', async () => {
  // abandonDecisions nulls pending_answer and its per-decision test reads it, so
  // it must run AFTER the existing discard block or the entry is lost.
  const run = runWithTasks([{ task_id: 't1', phase: 'blocked-on-decision', pending_answer: 'd1' }])
  run.tasks[0]!.decisions.push({
    id: 'd1', asked_at: 1, from_phase: 'plan', question: 'q', recommendation: 'r',
    answer: 'do X', answered_by: 'human', answered_at: 2, prompted_at: null,
  })
  await saveRun(dir, run)

  await cmdRewind(ctx(), { runId: run.run_id, phase: 'done', taskId: 't1' })

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.history.some((h) => h.why.includes('discarded, undelivered'))).toBe(true)
  expect(saved?.tasks[0]?.pending_answer).toBeNull()
})

test('the worker brief names the run it was rendered from', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)
  await cmdTask(ctx(), {
    branch: 'feat/x', issue: 11, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })

  const result = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  expect(result.text).toContain(run.run_id)
})

test('a run excluded for its phase is not described as finished', async () => {
  // `excluded` also holds live runs that are merely past this command's phases —
  // branch-review and escalated are both non-terminal by design.
  const late = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'late' })
  late.phase = 'branch-review'
  await saveRun(dir, late)

  const result = await cmdTask(ctx(), {
    branch: 'feat/x', issue: 21, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('branch-review')
  expect(result.text).not.toContain('a finished run cannot be re-entered')
})

test('an excluded run whose phase is in no row says so', async () => {
  const broken = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'broken' })
  broken.phase = 'dnoe' as typeof broken.phase
  broken.tasks = [mkTask({ task_id: 't1', phase: 'plan' })]
  await saveRun(dir, broken)

  const result = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('unrecognised phase')
  // The generic escape is refused for an unreadable run, so it is not offered.
  expect(result.text).not.toContain('renders it anyway')
})

test('a missing --task names the flag rather than printing an empty subject', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  for (const result of [
    await cmdBrief(ctx(), { taskId: '', repoKey: 'k', runId: null }),
    await cmdRelease(ctx(), { taskId: '', repoKey: 'k', runId: null }),
    await cmdDecide(ctx(), { task: '', question: 'q', recommendation: 'r', repoKey: 'k', runId: null }),
    await cmdAnswer(ctx(), { task: '', decision: 'd1', answer: 'a', by: 'human', repoKey: 'k', runId: null }),
  ]) {
    expect(result.ok).toBe(false)
    expect(result.text).toBe('--task is required')
  }
})

test('an empty --run names the flag rather than searching for a run called ""', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  for (const result of [
    await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: '' }),
    await cmdTask(ctx(), {
      branch: 'feat/x', issue: 1, surface: 'core', notes: '',
      dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: '',
    }),
    await cmdDispatchDone(ctx(), { runId: '', repoKey: 'k' }),
  ]) {
    expect(result.ok).toBe(false)
    expect(result.text).toBe('--run needs a run id')
  }
})

test('a rewind onto a review row does not re-issue a path an earlier review holds', async () => {
  const occupant = 'docs/superpowers/reviews/issue-1-spec-review-0.md'
  mkdirSync(join(repoDir, 'docs', 'superpowers', 'reviews'), { recursive: true })
  writeFileSync(join(repoDir, occupant), 'VERDICT: CLEAR\n')

  const run = runWithTasks([{ task_id: 't1', phase: 'spec-review', checkout_path: repoDir }])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'spec-review', taskId: 't1' })
  expect(result.ok).toBe(true)
  expect(result.text).toContain('issue-1-spec-review-1.md')

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id) as Run
  expect(artifactPathFor(saved, saved.tasks[0] as Task)).not.toBe(occupant)
  expect(artifactPathFor(saved, saved.tasks[0] as Task))
    .toBe('docs/superpowers/reviews/issue-1-spec-review-1.md')
})

test('a rewind to a producer row reserves nothing and does not reset verdict_seq', async () => {
  // Seeded, not absent: an implementation that CLEARS verdict_seq alongside
  // `passes` would satisfy `toBeUndefined()` on an empty fixture while destroying
  // the one property the key rests on — that it never regresses.
  const run = runWithTasks([{
    task_id: 't1', phase: 'spec-review', checkout_path: repoDir,
    verdict_seq: { 'spec-review': 2 },
    artifacts: {
      research: null, spec: null, plan: null,
      verdicts: { 'spec-review-1': 'docs/superpowers/reviews/issue-1-spec-review-1.md' },
    },
  }])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'spec', taskId: 't1' })
  expect(result.ok).toBe(true)
  expect(result.text).not.toContain('next verdict')

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks[0]?.passes).toEqual({})
  expect(saved?.tasks[0]?.verdict_seq).toEqual({ 'spec-review': 2 })
  expect(saved?.tasks[0]?.artifacts.verdicts)
    .toEqual({ 'spec-review-1': 'docs/superpowers/reviews/issue-1-spec-review-1.md' })
})

test('a rewind onto branch-review reserves a run-level path under the run id', async () => {
  const run = newRun({
    session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a',
  })
  run.phase = 'escalated'
  run.escalated_from = 'branch-review'
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), {
    runId: run.run_id, phase: 'branch-review', taskId: null,
  })
  expect(result.ok).toBe(true)
  expect(result.text).toContain(`${run.run_id}-branch-review-0.md`)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.verdict_seq?.['branch-review']).toBe(1)
  expect(saved?.artifacts.verdicts['branch-review-0'])
    .toBe(`docs/superpowers/reviews/${run.run_id}-branch-review-0.md`)
})

/** Adds a bootstrap script to the fixture repo created in beforeEach. */
function declareBootstrap(mode = 0o755): void {
  writeFileSync(join(repoDir, '.claude', 'pipeline-bootstrap'), '#!/bin/sh\ntrue\n')
  chmodSync(join(repoDir, '.claude', 'pipeline-bootstrap'), mode)
}

test('task echoes the repo bootstrap on the dispatched return', async () => {
  // Modelled on test/cli.test.ts:228-246, "task echoes files: none on the
  // dispatched return when nothing was declared".
  declareBootstrap()
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/boot', issue: 1, surface: 'core', notes: 'core work',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })

  expect(result.ok).toBe(true)
  expect(result.text).toContain('bootstrap: .claude/pipeline-bootstrap')
})

const fetchedBase = async () => ({ commit: '1fb8a43', ref: 'origin/main', fetchError: null })

test('the dispatched return keeps every header line above the one blank line', async () => {
  declareBootstrap()
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/boot', issue: 1, surface: 'core', notes: 'core work',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  }, undefined, fetchedBase)

  const [head, ...rest] = result.text.split('\n\n')
  const lines = head!.split('\n')
  expect(lines.slice(0, 4)).toEqual([
    'task_id: t1',
    'files: none',
    'bootstrap: .claude/pipeline-bootstrap',
    'base: 1fb8a43 (origin/main as just fetched)',
  ])
  // #118: the registration path prints the whole dispatch, `agent start` flag included.
  expect(lines.slice(4)).toEqual([
    'dispatch, in order:',
    `    herdr worktree create --cwd '${repoDir}' --branch feat/boot --base 1fb8a43`,
    '    (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)',
    '    herdr agent start <name> --kind claude --pane <.result.root_pane.pane_id> -- --dangerously-skip-permissions',
    expect.stringMatching(/ dispatch --task t1 --pane <\.result\.root_pane\.pane_id>$/),
  ])
  // prompts/dispatch.md calls the lines above the blank line the orchestrator's,
  // so nothing meant for the worker may land among them.
  expect(rest.join('\n\n')).toStartWith('# feat/boot — issue #1')
})

test('a non-executable declaration is reported to the orchestrator, not hidden', async () => {
  declareBootstrap(0o644)
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/notexec', issue: 3, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })

  expect(result.text).toContain('NOT EXECUTABLE')
})

test('a repo declaring no bootstrap says so rather than staying silent', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/quiet', issue: 2, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  }, undefined, fetchedBase)

  // Spec item 13 is "bootstrap: none AND still satisfies test 12" — the undeclared
  // path is the one every repo hits today, so it gets the shape contract too.
  const [head, ...rest] = result.text.split('\n\n')
  const lines = head!.split('\n')
  expect(lines.slice(0, 4)).toEqual([
    'task_id: t1', 'files: none', 'bootstrap: none', 'base: 1fb8a43 (origin/main as just fetched)',
  ])
  expect(lines.join('\n')).not.toContain('pipeline-bootstrap')
  expect(lines.join('\n')).toContain('-- --dangerously-skip-permissions')
  expect(rest.join('\n\n')).toStartWith('# feat/quiet — issue #2')
})

test('task echoes the repo bootstrap on the queued return as well', async () => {
  // Modelled on test/cli.test.ts:206-226, "task echoes the file set it recorded
  // while gated": t1 dispatches into `research`, which is not terminal, so t2
  // stays gated and the `queued:` return is the one that runs.
  declareBootstrap()
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  await cmdTask(ctx(), {
    branch: 'feat/first', issue: 1, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })
  const gated = await cmdTask(ctx(), {
    branch: 'feat/second', issue: 2, surface: 'core', notes: '',
    dependsOn: ['t1'], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })

  expect(gated.ok).toBe(true)
  expect(gated.text).toContain('queued: waiting on t1')
  expect(gated.text).toContain('bootstrap: .claude/pipeline-bootstrap')
})

test('show prints the recorded task without touching the ledger', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'done' },
    {
      task_id: 't2', branch: 'feat/show', issue: 17, surface: 'core',
      files: ['src/cli.ts', 'README.md'], depends_on: ['t1'],
      phase: 'implement', phase_entered_at: Date.now() - 42 * 60000,
      pr: 58, ci: 'pending', checkout_path: '/wt/show',
      artifacts: {
        research: 'docs/r.md', spec: 'docs/s.md', plan: 'docs/p.md',
        verdicts: { 'spec-review-0': 'docs/superpowers/reviews/x-spec-review-0.md' },
      },
    },
  ])
  await saveRun(dir, run)
  const before = JSON.stringify((await listRuns(dir, 'personal'))[0])

  const result = await cmdShow(ctx(), { taskId: 't2', repoKey: 'k', runId: null })

  expect(result.ok).toBe(true)
  for (const line of [
    `run:        ${run.run_id}`,
    'branch:     feat/show', 'issue:      #17', 'surface:    core',
    'files:      src/cli.ts, README.md', 'depends on: t1', 'phase:      implement (42m)',
    'research:   docs/r.md', 'spec:       docs/s.md', 'plan:       docs/p.md',
    'spec-review-0: docs/superpowers/reviews/x-spec-review-0.md',
    'pr:         #58', 'ci:         pending', 'checkout:   /wt/show',
  ]) expect(result.text).toContain(line)
  expect(JSON.stringify((await listRuns(dir, 'personal'))[0])).toBe(before)
})

test('show says none rather than printing null for what a task has not reached', async () => {
  await saveRun(dir, runWithTasks([{ task_id: 't1' }]))

  const result = await cmdShow(ctx(), { taskId: 't1', repoKey: 'k', runId: null })

  expect(result.text).toContain('files:      none')
  expect(result.text).toContain('depends on: none')
  expect(result.text).toContain('pr:         none')
  expect(result.text).not.toContain('null')
})

test('show prints a freshly fetched base for an unfinished task, containing its dependency merges', async () => {
  const run = runWithTasks([
    { task_id: 't1', phase: 'done', merged_at_ms: 5_000, merge_commit: 'c0ffee1' },
    { task_id: 't2', phase: 'research', depends_on: ['t1'] },
  ])
  run.repo_root = repoDir
  await saveRun(dir, run)
  const requested: Array<[string, string[] | null]> = []
  const fetchBase = async (repoRoot: string, merges: string[] | null) => {
    requested.push([repoRoot, merges])
    return { commit: '1fb8a43', ref: 'origin/main', fetchError: null }
  }

  const unfinished = await cmdShow(ctx(), { taskId: 't2', repoKey: 'k', runId: null }, fetchBase)
  expect(unfinished.text).toContain('base: 1fb8a43 (origin/main as just fetched)')
  expect(requested).toEqual([[repoDir, ['c0ffee1']]])

  const finished = await cmdShow(ctx(), { taskId: 't1', repoKey: 'k', runId: null }, fetchBase)
  expect(finished.text).not.toContain('base:')
  expect(requested).toHaveLength(1)
})

test('show names a missing task', async () => {
  await saveRun(dir, runWithTasks([{ task_id: 't1' }]))
  const result = await cmdShow(ctx(), { taskId: 't9', repoKey: 'k', runId: null })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('holding t9')
})

function recordingSend(reply: { ok: boolean; code?: string; message?: string } = { ok: true }) {
  const sent: { paneId: string; text: string }[] = []
  const send = async (paneId: string, text: string) => {
    sent.push({ paneId, text })
    return reply
  }
  return { sent, send }
}

async function registerReadyTask(): Promise<void> {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)
  await cmdTask(ctx(), {
    branch: 'feat/x', issue: 11, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })
}

test('dispatch --task hands the bare brief to the pane, not the header lines', async () => {
  await registerReadyTask()
  const brief = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  const before = JSON.stringify((await listRuns(dir, 'personal'))[0])
  const { sent, send } = recordingSend()

  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null,
  }, send)

  expect(result.ok).toBe(true)
  expect(result.text).toContain('t1')
  expect(result.text).toContain('w1-2')
  expect(sent).toEqual([{ paneId: 'w1-2', text: brief.text }])
  expect(sent[0]!.text).not.toContain('task_id:')
  const after = (await listRuns(dir, 'personal'))[0]!
  expect(after.tasks[0]!.pane_id).toBe('w1-2')
  after.tasks[0]!.pane_id = null
  delete after.tasks[0]!.stall
  const { revision: _after, ...afterRest } = after
  const { revision: _before, ...beforeRest } = JSON.parse(before) as Run
  expect(beforeRest.tasks[0]!.awaiting_brief).toBe(true)
  delete beforeRest.tasks[0]!.awaiting_brief
  expect(afterRest).toEqual(beforeRest)
})

test('dispatch --task records the pane over a supervisor write made during the handoff — #12', async () => {
  // A lost `pane.agent_detected` must not leave a briefed worker looking agentless.
  await registerReadyTask()
  const send = async () => {
    await supervisorWrites((run) => { run.tasks[0]!.notes = 'written mid-send' })
    return { ok: true }
  }
  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null,
  }, send)

  expect(result.ok).toBe(true)
  const task = (await listRuns(dir, 'personal'))[0]!.tasks[0]!
  expect(task.pane_id).toBe('w1-2')
  expect(task.notes).toBe('written mid-send')
})

test('dispatch --task records nothing when the handoff was not confirmed — #12', async () => {
  await registerReadyTask()
  const { send } = recordingSend({ ok: false, code: 'agent_not_found', message: 'not found' })
  await cmdDispatchTask(ctx(), { taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null }, send)
  const task = (await listRuns(dir, 'personal'))[0]!.tasks[0]!
  expect(task.pane_id).toBeNull()
  expect(task.awaiting_brief).toBe(true)
})

test('a registered task awaits its brief until dispatch --task confirms the handoff — #89', async () => {
  await registerReadyTask()
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.awaiting_brief).toBe(true)
  const { send } = recordingSend()
  await cmdDispatchTask(ctx(), { taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null }, send)
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.awaiting_brief).toBeUndefined()
})

test('a rewind past the briefed phase drops a stale awaiting-brief mark — #89', async () => {
  await registerReadyTask()
  const run = (await listRuns(dir, 'personal'))[0]!
  expect(run.tasks[0]!.awaiting_brief).toBe(true)
  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'spec', taskId: 't1' })).ok).toBe(true)
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.awaiting_brief).toBeUndefined()
})

test('a paneless rewind into research owes the fresh agent a brief; a bound one does not — #89', async () => {
  await registerReadyTask()
  await supervisorWrites((run) => {
    const task = run.tasks[0]!
    delete task.awaiting_brief
    task.phase = 'failed'
    task.pane_id = null
  })
  const runId = (await listRuns(dir, 'personal'))[0]!.run_id
  expect((await cmdRewind(ctx(), { runId, phase: 'research', taskId: 't1' })).ok).toBe(true)
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.awaiting_brief).toBe(true)

  await supervisorWrites((run) => { run.tasks[0]!.pane_id = 'w1-2'; run.tasks[0]!.phase = 'spec' })
  expect((await cmdRewind(ctx(), { runId, phase: 'research', taskId: 't1' })).ok).toBe(true)
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.awaiting_brief).toBeUndefined()
})

test('a confirmed brief is recorded even when the pane was already bound by detection — #89', async () => {
  // `pane.agent_detected` usually binds the pane first, so the bind alone
  // changes nothing and must not be what decides whether the save happens.
  await registerReadyTask()
  await supervisorWrites((run) => { run.tasks[0]!.pane_id = 'w1-2' })
  const { send } = recordingSend()
  await cmdDispatchTask(ctx(), { taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null }, send)
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.awaiting_brief).toBeUndefined()
})

test('dispatch --task refuses the orchestrator\'s own pane before sending anything — #12', async () => {
  await registerReadyTask()
  await supervisorWrites((run) => { run.orchestrator_pane = 'w1-1' })
  const { sent, send } = recordingSend()
  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: 'w1-1', repoKey: 'k', runId: null,
  }, send)
  expect(result.ok).toBe(false)
  expect(result.text).toContain('orchestrator pane')
  expect(sent).toEqual([])
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.pane_id).toBeNull()
})

test('dispatch --task refuses a pane already bound to another task before sending — #12', async () => {
  // Recorded on both, the pane's exit and idle events would reach whichever task
  // findTask meets first.
  await registerReadyTask()
  await supervisorWrites((run) => {
    run.tasks.push({ ...run.tasks[0]!, task_id: 't2', branch: 'feat/y', pane_id: 'w2-1', workspace_id: 'w2' })
  })
  const { sent, send } = recordingSend()
  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: 'w2-1', repoKey: 'k', runId: null,
  }, send)
  expect(result.ok).toBe(false)
  expect(result.text).toContain("already t2's worker pane")
  expect(sent).toEqual([])
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.pane_id).toBeNull()
})

test('a delivered brief whose pane was not recorded never says to run dispatch again — #12', async () => {
  await registerReadyTask()
  const { sent, send } = recordingSend()
  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null,
  }, send, async () => 'the ledger kept changing under the save')
  expect(result.ok).toBe(true)
  expect(sent).toHaveLength(1)
  expect(result.text).toContain('delivered to w1-2')
  expect(result.text).toContain('but its pane was not recorded (the ledger kept changing under the save)')
  expect(result.text).toContain('Do not run `dispatch --task` again')
  expect(result.text).not.toContain('run it again')
})

test('recording the pane reports an unlanded save instead of throwing — #12', async () => {
  await registerReadyTask()
  const run = (await listRuns(dir, 'personal'))[0]!
  const reason = await recordWorkerPane(ctx(), {
    runId: run.run_id, taskId: 't1', paneId: 'w1-2', briefedPhase: 'research',
  }, async (_dir, r) => { throw new StaleRunError(r.run_id) })
  expect(reason).toBe('the ledger kept changing under the save')
})

test('recording the pane leaves a task that failed during the handoff unbound — #12', async () => {
  await registerReadyTask()
  await supervisorWrites((run) => { run.tasks[0]!.phase = 'failed' })
  const run = (await listRuns(dir, 'personal'))[0]!
  const reason = await recordWorkerPane(ctx(), {
    runId: run.run_id, taskId: 't1', paneId: 'w1-2', briefedPhase: 'research',
  })
  expect(reason).toBeNull()
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.pane_id).toBeNull()
})

test('dispatch --task reports a failed handoff instead of claiming it landed', async () => {
  await registerReadyTask()
  const { send } = recordingSend({ ok: false, code: 'agent_prompt_stalled', message: 'no working state' })

  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null,
  }, send)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('agent_prompt_stalled')
  expect(result.text).toContain('pane read w1-2')
  expect(result.text).toContain('send it twice')
})

test('dispatch --task does not warn of a double send when herdr rejected before sending', async () => {
  await registerReadyTask()
  const { send } = recordingSend({ ok: false, code: 'agent_not_found', message: 'not found' })

  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null,
  }, send)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('agent_not_found')
  expect(result.text).toContain('nothing was sent')
  expect(result.text).not.toContain('send it twice')
})

test('dispatch --task refuses a task whose gate has not opened', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)
  await cmdTask(ctx(), {
    branch: 'feat/first', issue: 1, surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })
  await cmdTask(ctx(), {
    branch: 'feat/second', issue: 2, surface: 'core', notes: '',
    dependsOn: ['t1'], files: [], keepWorktree: false, repoKey: 'k', runId: null,
  })
  const { sent, send } = recordingSend()

  const result = await cmdDispatchTask(ctx(), {
    taskId: 't2', paneId: 'w1-2', repoKey: 'k', runId: null,
  }, send)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('queued')
  expect(sent).toEqual([])
})

test('dispatch --task refuses a task whose worker is already past its first phase', async () => {
  await registerReadyTask()
  const [run] = await listRuns(dir, 'personal')
  run!.tasks[0]!.phase = 'implement'
  await saveRun(dir, run!)
  const { sent, send } = recordingSend()

  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null,
  }, send)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('already in implement')
  expect(result.text).toContain('brief --task t1')
  expect(sent).toEqual([])
})

test('dispatch --task needs a pane', async () => {
  await registerReadyTask()
  const { sent, send } = recordingSend()

  const result = await cmdDispatchTask(ctx(), {
    taskId: 't1', paneId: '', repoKey: 'k', runId: null,
  }, send)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('--pane')
  expect(sent).toEqual([])
})

test('a supervisor save of a copy loaded before a rewind cannot undo the rewind', async () => {
  // The interleaving that returned a run from `execute` to `intake` on
  // 2026-09-19: the supervisor loads, a human rewinds, the supervisor saves.
  const run = await seed()
  const supervisorCopy = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)!

  const rewound = await cmdRewind(ctx(), { runId: run.run_id, phase: 'execute', taskId: null })
  expect(rewound.ok).toBe(true)

  supervisorCopy.history.push({ at: Date.now(), from: 'intake', to: 'intake', why: 'tick' })
  await expect(saveRun(dir, supervisorCopy)).rejects.toThrow()

  const onDisk = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(onDisk?.phase).toBe('execute')
})

test('concurrent commands on one run each land instead of the last one winning', async () => {
  const ids = ['t1', 't2', 't3', 't4', 't5']
  const run = runWithTasks(ids.map((task_id) => ({ task_id, phase: 'failed', files: [`src/${task_id}`] })))
  await saveRun(dir, run)

  const results = await Promise.all(
    ids.map((taskId) => cmdRelease(ctx(), { taskId, repoKey: null, runId: run.run_id })),
  )
  expect(results.every((r) => r.ok)).toBe(true)

  const onDisk = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(onDisk?.tasks.map((t) => t.files)).toEqual([[], [], [], [], []])
})

// #88: a rewind is a phase entry the supervisor never made, so nothing else
// would ever prompt for it.
const savedRun = async (runId: string): Promise<Run> =>
  (await listRuns(dir, 'personal')).find((r) => r.run_id === runId) as Run

test('a task rewind owes its worker the phase prompt, in the same save', async () => {
  const run = runWithTasks([{
    task_id: 't1', phase: 'escalated', escalated_from: 'implement',
    workspace_id: 'w7', pane_id: 'w7:p1', checkout_path: repoDir,
  }])
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' })
  expect(result.text).toContain('its prompt is queued for w7:p1')

  const saved = await savedRun(run.run_id)
  const task = saved.tasks[0] as Task
  expect(saved.outbox).toHaveLength(1)
  expect(saved.outbox?.[0]).toMatchObject({ to: 'worker', task_id: 't1', entered_at: task.phase_entered_at })
  expect(saved.outbox?.[0]?.text).toContain('# Implement — b (#1)')
  // A live agent already holds the brief; only the phase is sent.
  expect(saved.outbox?.[0]?.text).not.toContain('Your task id is')
  expect(outboxPending(saved).map((p) => p.paneId)).toEqual(['w7:p1'])
})

test('a rewind onto a review row prompts with the one path it printed, reserved once', async () => {
  const run = runWithTasks([{
    task_id: 't1', phase: 'escalated', escalated_from: 'pr-review-quality',
    workspace_id: 'w7', pane_id: 'w7:p1', checkout_path: repoDir,
  }])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'pr-review-quality', taskId: 't1' })
  expect(result.text).toContain('issue-1-pr-review-quality-0.md')

  const saved = await savedRun(run.run_id)
  expect(saved.tasks[0]?.verdict_seq?.['pr-review-quality']).toBe(1)
  expect(saved.outbox?.[0]?.text)
    .toContain(join(repoDir, 'docs/superpowers/reviews/issue-1-pr-review-quality-0.md'))
})

test('a rewind into research with no worker owes nothing: the dispatched brief carries it', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'failed', last_pane_id: 'w7:p1' }])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'research', taskId: 't1' })
  // The F10 shape: no workspace either, so the first step is a worktree, not a dispatch.
  expect(result.text).toContain("no worker is bound, so nothing is sent — `herdr worktree create --cwd '/r' --branch b")
  expect(result.text.indexOf('herdr agent start')).toBeLessThan(result.text.indexOf('dispatch --task t1 --pane <root pane>'))
  expect((await savedRun(run.run_id)).outbox ?? []).toEqual([])
})

test('a rewind past research with no worker holds the prompt until one is bound', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'failed', workspace_id: 'w7', checkout_path: repoDir }])
  await saveRun(dir, run)

  const result = await cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' })
  expect(result.text).toContain("queued for t1's worker, which is not bound yet")
  expect(result.text).toContain('herdr pane list --workspace w7')
  expect(result.text).toContain('send it nothing yourself')
  expect(result.text).not.toContain('brief --task')

  const saved = await savedRun(run.run_id)
  expect(saved.outbox).toHaveLength(1)
  // A fresh agent gets the brief first, without its research section, then the phase.
  const text = saved.outbox?.[0]?.text ?? ''
  expect(text).toContain('Your task id is `t1`')
  expect(text).not.toContain('## Phase 1 — research')
  expect(text.indexOf('Your task id is `t1`')).toBeLessThan(text.indexOf('# Implement — b (#1)'))
  expect(outboxPending(saved)).toEqual([])
  ;(saved.tasks[0] as Task).pane_id = 'w7:p1'
  expect(outboxPending(saved).map((p) => p.paneId)).toEqual(['w7:p1'])
})

test('a rewind into research with a worker bound re-sends the research prompt', async () => {
  const run = runWithTasks([{
    task_id: 't1', phase: 'spec', workspace_id: 'w7', pane_id: 'w7:p1', checkout_path: repoDir,
    artifacts: { research: 'docs/r.md', spec: null, plan: null, verdicts: {} },
  }])
  await saveRun(dir, run)

  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'research', taskId: 't1' })).ok).toBe(true)
  expect((await savedRun(run.run_id)).outbox?.[0]?.text).toContain('## Phase 1 — research')
})

test('a rewind into an orchestrator row prompts the orchestrator, and a terminal one prompts no one', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'escalated', escalated_from: 'merge', pr: 5 }])
  run.orchestrator_pane = 'w1:p1'
  await saveRun(dir, run)

  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'merge', taskId: 't1' })).ok).toBe(true)
  expect((await savedRun(run.run_id)).outbox?.map((e) => e.to)).toEqual(['orchestrator'])

  const abandoned = runWithTasks([{ task_id: 't1', phase: 'escalated', escalated_from: 'merge', pr: 5 }])
  abandoned.orchestrator_pane = 'w1:p1'
  await saveRun(dir, abandoned)
  expect((await cmdRewind(ctx(), { runId: abandoned.run_id, phase: 'failed', taskId: 't1' })).ok).toBe(true)
  expect((await savedRun(abandoned.run_id)).outbox ?? []).toEqual([])
})

test('a run rewind onto branch-review prompts the orchestrator with the path it reserved', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  run.phase = 'escalated'
  run.escalated_from = 'branch-review'
  run.orchestrator_pane = 'w1:p1'
  await saveRun(dir, run)

  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'branch-review', taskId: null })).ok).toBe(true)

  const saved = await savedRun(run.run_id)
  expect(saved.verdict_seq?.['branch-review']).toBe(1)
  expect(saved.outbox).toHaveLength(1)
  expect(saved.outbox?.[0]).toMatchObject({ to: 'orchestrator', task_id: null, entered_at: saved.phase_entered_at })
  expect(saved.outbox?.[0]?.text).toContain(`${run.run_id}-branch-review-0.md`)
})

test('concurrent rewinds each reserve once and queue one current entry', async () => {
  const ids = ['t1', 't2', 't3', 't4']
  const run = runWithTasks(ids.map((task_id) => ({
    task_id, phase: 'escalated', escalated_from: 'pr-review-quality',
    workspace_id: `w${task_id}`, pane_id: `w${task_id}:p1`, checkout_path: repoDir,
  })))
  await saveRun(dir, run)
  const results = await Promise.all(ids.map((taskId) =>
    cmdRewind(ctx(), { runId: run.run_id, phase: 'pr-review-quality', taskId })))
  expect(results.every((r) => r.ok)).toBe(true)
  const saved = await savedRun(run.run_id)
  expect(saved.tasks.map((t) => t.verdict_seq?.['pr-review-quality'])).toEqual([1, 1, 1, 1])
  expect(outboxPending(saved)).toHaveLength(4)
})

test('a second rewind leaves the first entry stale, never delivered', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'escalated', escalated_from: 'implement',
    workspace_id: 'w7', pane_id: 'w7:p1', checkout_path: repoDir }])
  await saveRun(dir, run)
  await cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' })
  await Bun.sleep(2)
  await cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' })
  const saved = await savedRun(run.run_id)
  expect(saved.outbox).toHaveLength(2)
  expect(outboxPending(saved).map((p) => p.outboxId)).toEqual([saved.outbox?.[1]?.id])
})

test('a run rewind into a phase with no prompt owes nothing', async () => {
  const run = await seed()
  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'execute', taskId: null })).ok).toBe(true)
  expect((await savedRun(run.run_id)).outbox ?? []).toEqual([])
})
