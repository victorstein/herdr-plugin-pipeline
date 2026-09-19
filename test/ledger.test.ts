import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeRunForRepo, listRuns, newRun, readOrchestrator,
  resolveRun, saveRun, writeOrchestrator,
} from '../src/lib/ledger'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('newRun produces a unique suffixed id and opens at intake', () => {
  const a = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })
  const b = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })
  expect(a.phase).toBe('intake')
  expect(a.run_id).not.toBe(b.run_id)
  expect(a.run_id).toContain('chat-meter')
})

test('listRuns only returns runs for the requested session', async () => {
  const mine = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  const theirs = newRun({ session: 'default', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'b' })
  await saveRun(dir, mine)
  await saveRun(dir, theirs)

  const runs = await listRuns(dir, 'personal')
  expect(runs).toHaveLength(1)
  expect(runs[0]?.title).toBe('a')
})

test('activeRunForRepo ignores a finished run', async () => {
  const done = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  done.phase = 'done'
  await saveRun(dir, done)
  expect(await activeRunForRepo(dir, 'personal', 'k')).toBeNull()
})

test('activeRunForRepo finds a live run', async () => {
  const live = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  await saveRun(dir, live)
  expect((await activeRunForRepo(dir, 'personal', 'k'))?.run_id).toBe(live.run_id)
})

test('orchestrators are keyed by session and repo', async () => {
  await writeOrchestrator(dir, 'personal', 'k', {
    pane_id: 'w1:p1', workspace_id: 'w1', socket_path: '/s', claimed_at: 1,
  })
  expect((await readOrchestrator(dir, 'personal', 'k'))?.pane_id).toBe('w1:p1')
  expect(await readOrchestrator(dir, 'default', 'k')).toBeNull()
})

test('concurrent orchestrator claims for different repos in one session both persist', async () => {
  await Promise.all([
    writeOrchestrator(dir, 'personal', 'repo-a', {
      pane_id: 'w1:p1', workspace_id: 'w1', socket_path: '/s', claimed_at: 1,
    }),
    writeOrchestrator(dir, 'personal', 'repo-b', {
      pane_id: 'w2:p1', workspace_id: 'w2', socket_path: '/s', claimed_at: 2,
    }),
  ])

  expect((await readOrchestrator(dir, 'personal', 'repo-a'))?.pane_id).toBe('w1:p1')
  expect((await readOrchestrator(dir, 'personal', 'repo-b'))?.pane_id).toBe('w2:p1')
})

test('a new run carries schema_version 2 and an open intake', () => {
  const run = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  expect(run.schema_version).toBe(2)
  expect(run.intake_closed).toBe(false)
  expect(run.passes).toEqual({})
})

// ——— resolveRun ———

/** A saved run with one task, so the task-id filter has something to match. */
async function seedRun(over: {
  repoKey?: string; phase?: string; title?: string; taskIds?: string[]
}): Promise<string> {
  const run = newRun({
    session: 'personal', socketPath: '/s',
    repoKey: over.repoKey ?? 'repo-a', repoRoot: '/r', title: over.title ?? 'a',
  })
  if (over.phase) run.phase = over.phase as typeof run.phase
  for (const id of over.taskIds ?? ['t1']) {
    run.tasks.push({
      task_id: id, branch: 'b', issue: 1, surface: 'core', depends_on: [], files: [],
      keep_worktree: false, workspace_id: null, pane_id: null,
      agent_status: 'unknown', phase: 'queued', phase_entered_at: 0,
      escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
      checkout_path: null, registered_at: 0, adopted_at: null,
      artifacts: { research: null, spec: null, plan: null, verdicts: {} },
      merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
      decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    })
  }
  await saveRun(dir, run)
  return run.run_id
}

const query = (over: Partial<Parameters<typeof resolveRun>[2]> = {}) => ({
  runId: null, repoKey: null, phases: null, taskId: null, allowTerminal: false, ...over,
})

test('resolveRun skips a finished run that sorts first', async () => {
  // The #36/#38 shape: same repo, same task id, the completed run sorts first
  // because listRuns sorts by filename and its title is alphabetically earlier.
  const done = await seedRun({ title: 'aaa batch one', phase: 'done' })
  const live = await seedRun({ title: 'zzz batch two', phase: 'execute' })

  const result = await resolveRun(dir, 'personal', query({ taskId: 't1' }))
  expect(result.ok).toBe(true)
  expect(result.ok && result.run.run_id).toBe(live)
  expect(live).not.toBe(done)
})

test('resolveRun picks the run for the caller repo', async () => {
  // The #21 shape: another repo's run sorts first and must not win.
  await seedRun({ repoKey: '/repos/aaa', title: 'aaa' })
  const mine = await seedRun({ repoKey: '/repos/zzz', title: 'zzz' })

  const result = await resolveRun(dir, 'personal', query({ repoKey: '/repos/zzz' }))
  expect(result.ok && result.run.run_id).toBe(mine)
})

test('resolveRun refuses to choose between two live runs', async () => {
  const a = await seedRun({ title: 'aaa' })
  const b = await seedRun({ title: 'bbb' })

  const result = await resolveRun(dir, 'personal', query({ repoKey: 'repo-a' }))
  expect(result.ok).toBe(false)
  expect(!result.ok && result.reason).toBe('ambiguous')
  const ids = !result.ok && result.reason === 'ambiguous'
    ? result.candidates.map((r) => r.run_id) : []
  expect(ids.sort()).toEqual([a, b].sort())
})

test('resolveRun names the finished run that holds the task it could not find', async () => {
  const done = await seedRun({ phase: 'done', title: 'finished' })

  const result = await resolveRun(dir, 'personal', query({ repoKey: 'repo-a', taskId: 't1' }))
  expect(!result.ok && result.reason).toBe('none')
  const excluded = !result.ok && result.reason === 'none'
    ? result.excluded.map((r) => r.run_id) : []
  expect(excluded).toEqual([done])
})

test('resolveRun reports none with nothing excluded when no run holds the task', async () => {
  await seedRun({ taskIds: ['t1'] })

  const result = await resolveRun(dir, 'personal', query({ repoKey: 'repo-a', taskId: 't9' }))
  expect(!result.ok && result.reason).toBe('none')
  expect(!result.ok && result.reason === 'none' && result.excluded).toEqual([])
})

test('resolveRun by id ignores the repo and task filters', async () => {
  const other = await seedRun({ repoKey: '/repos/other', taskIds: ['t1'] })

  const result = await resolveRun(dir, 'personal', query({
    runId: other, repoKey: '/repos/mine', taskId: 't9',
  }))
  expect(result.ok && result.run.run_id).toBe(other)
})

test('resolveRun by id still applies the phase filter', async () => {
  // --run overrides inference, not legality. A task registered into a run past
  // `execute` cannot be removed by any command.
  const late = await seedRun({ phase: 'branch-review' })

  const result = await resolveRun(dir, 'personal', query({
    runId: late, phases: ['intake', 'dispatch', 'execute'],
  }))
  expect(!result.ok && result.reason).toBe('wrong-phase')
})

test('resolveRun by id refuses a finished run unless the caller allows it', async () => {
  const done = await seedRun({ phase: 'done' })

  const refused = await resolveRun(dir, 'personal', query({ runId: done }))
  expect(!refused.ok && refused.reason).toBe('terminal')

  const allowed = await resolveRun(dir, 'personal', query({ runId: done, allowTerminal: true }))
  expect(allowed.ok && allowed.run.run_id).toBe(done)
})

test('resolveRun by id reports an unknown id', async () => {
  const result = await resolveRun(dir, 'personal', query({ runId: 'nope' }))
  expect(!result.ok && result.reason).toBe('no-such-run')
})
