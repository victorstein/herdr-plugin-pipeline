import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeRunForRepo, newRun, saveRun } from '../src/lib/ledger'
import { cmdRewind, cmdStart, cmdTask } from '../src/cli'

let dir: string
let repoDir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-'))
  // `hpipe task` rejects a --surface with no matching agent definition, so the
  // fixture repo must carry real ones.
  repoDir = mkdtempSync(join(tmpdir(), 'repo-'))
  mkdirSync(join(repoDir, '.claude', 'agents'), { recursive: true })
  for (const surface of ['core', 'api']) {
    writeFileSync(join(repoDir, '.claude', 'agents', `${surface}-dev.md`), `# ${surface}-dev\n`)
  }
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

test('start opens a run and prints the intake prompt', async () => {
  const out = await cmdStart(ctx(), {
    title: 'chat meter', repoKey: 'k', repoRoot: repoDir, socketPath: '/s',
    paneId: 'w1:p1', workspaceId: 'w1',
  })
  expect(out.ok).toBe(true)
  expect(out.text).toContain('intake')
  expect((await activeRunForRepo(dir, 'personal', 'k'))?.title).toBe('chat meter')
})

test('start refuses a second run for the same repo and names the blocker', async () => {
  const first = await cmdStart(ctx(), {
    title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
  })
  const second = await cmdStart(ctx(), {
    title: 'b', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
  })
  expect(second.ok).toBe(false)
  expect(second.text).toContain(JSON.parse(first.json ?? '{}').run_id ?? 'run')
})

test('task prints its id and withholds the prompt while gated', async () => {
  const c = ctx()
  await cmdStart(c, { title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1' })
  const run = await activeRunForRepo(dir, 'personal', 'k')
  run!.phase = 'dispatch'
  await saveRun(dir, run!)

  const t1 = await cmdTask(c, { branch: 'feat/core', issue: 1, surface: 'core', text: 'core work', dependsOn: [], files: [], keepWorktree: false })
  const t2 = await cmdTask(c, { branch: 'feat/api', issue: 2, surface: 'api', text: 'api work', dependsOn: ['t1'], files: [], keepWorktree: false })

  expect(t1.text).toContain('task_id: t1')
  expect(t1.text).toContain('feat/core')
  expect(t2.text).toContain('task_id: t2')
  expect(t2.text).toContain('queued: waiting on t1')
  expect(t2.text).not.toContain('api work')
})

test('a task dispatched at registration enters the design loop, not implement', async () => {
  const c = ctx()
  await cmdStart(c, { title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1' })
  const started = await activeRunForRepo(dir, 'personal', 'k')
  started!.phase = 'dispatch'
  await saveRun(dir, started!)

  await cmdTask(c, { branch: 'feat/core', issue: 1, surface: 'core', text: 'core work', dependsOn: [], files: [], keepWorktree: false })

  const run = await activeRunForRepo(dir, 'personal', 'k')
  expect(run?.tasks[0]?.phase).toBe('research')
})

test('task rejects a dependency cycle', async () => {
  const c = ctx()
  await cmdStart(c, { title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1' })
  const run = await activeRunForRepo(dir, 'personal', 'k')
  run!.phase = 'dispatch'
  await saveRun(dir, run!)

  await cmdTask(c, { branch: 'a', issue: 1, surface: 'core', text: 'x', dependsOn: [], files: [], keepWorktree: false })
  const bad = await cmdTask(c, { branch: 'b', issue: 2, surface: 'core', text: 'y', dependsOn: ['t1', 't2'], files: [], keepWorktree: false })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('cycle')
})

test('task rejects a surface with no agent definition', async () => {
  const c = ctx()
  await cmdStart(c, { title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1' })
  const run = await activeRunForRepo(dir, 'personal', 'k')
  run!.phase = 'dispatch'
  await saveRun(dir, run!)

  // A typo in --surface would otherwise render a plausible dead path into the
  // worker prompt and fail only once the worker went looking for it.
  const bad = await cmdTask(c, { branch: 'x', issue: 9, surface: 'kore', text: 'y', dependsOn: [], files: [], keepWorktree: false })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('kore-dev.md')
})

test('task rejects a dependency id that names no task', async () => {
  const c = ctx()
  await cmdStart(c, { title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1' })
  const run = await activeRunForRepo(dir, 'personal', 'k')
  run!.phase = 'dispatch'
  await saveRun(dir, run!)

  const bad = await cmdTask(c, { branch: 'x', issue: 9, surface: 'core', text: 'y', dependsOn: ['t7'], files: [], keepWorktree: false })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('t7')
})

test('rewind clears the counters for the phase it rewinds to', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  run.phase = 'escalated'
  run.escalated_from = 'branch-review'
  run.passes['branch-review'] = 2
  await saveRun(dir, run)

  const out = await cmdRewind(ctx(), { runId: run.run_id, phase: 'branch-review', taskId: null })
  expect(out.ok).toBe(true)
  const after = await activeRunForRepo(dir, 'personal', 'k')
  expect(after?.phase).toBe('branch-review')
  expect(after?.passes).toEqual({})
})

test('the spec path carries the whole title, not a fragment of the run id', async () => {
  const out = await cmdStart(ctx(), {
    title: 'add a titleCase helper', repoKey: 'k', repoRoot: repoDir,
    socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
  })
  expect(out.ok).toBe(true)

  const run = await activeRunForRepo(dir, 'personal', 'k')
  expect(run?.artifacts.spec).toContain('add-a-titlecase-helper-design.md')
})
