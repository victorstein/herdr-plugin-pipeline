import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cmdAbort, cmdAnswer, cmdBrief, cmdDecide, cmdDispatchDone, cmdForget, cmdRelease, cmdResume,
  cmdRewind, cmdStatus, cmdTask,
} from '../src/cli'
import { openDecisionFor } from '../src/lib/decisions'
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
