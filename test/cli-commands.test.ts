import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdAbort, cmdForget, cmdResume, cmdStatus } from '../src/cli'
import { listRuns, newRun, saveRun } from '../src/lib/ledger'

let dir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'clicmd-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function seed() {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  await saveRun(dir, run)
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
  expect((await listRuns(dir, 'personal'))[0]?.phase).toBe('spec')
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
    agent_status: 'idle', phase: 'execute', pass: 1, phase_entered_at: 0,
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  })
  await saveRun(dir, run)

  expect((await cmdForget(ctx(), { workspaceId: 'w7' })).ok).toBe(true)
  expect((await listRuns(dir, 'personal'))[0]?.tasks[0]?.workspace_id).toBeNull()
})
