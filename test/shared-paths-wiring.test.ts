import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desiredBead } from '../src/lib/bead-desired'
import { forgetDispatchBases } from '../src/lib/dispatch-base'
import { loadRun, saveRun } from '../src/lib/ledger'
import { hpipeCommand } from '../src/lib/render'
import { SHARED_PATHS_REL } from '../src/lib/shared-paths'
import { formatStatus, formatTaskDetail } from '../src/lib/status'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import { applyStalls, type StallDeps, taskStallCandidates } from '../src/supervisor/stall'
import { advanceTasks, type TaskDeps, type TaskPrompt } from '../src/supervisor/tasks'
import { cmdStart } from './helpers/cmd-start'
import { cmdTask } from './helpers/cmd-task'
import { cleanupFixtures, cloneOfRemote, commitAs, git, revParse, tempDir } from './helpers/git-worktree'

/**
 * A per-task run that shares one path, from `start` through the file gate, against
 * a real ledger and a real bare origin, with only herdr, gh and Beads faked: the
 * CLI and the supervisor's own step functions in the order a live run takes them.
 * The gate is where unit tests with fakes have missed live-only bugs before.
 */

const ROOT = join(import.meta.dir, '..')
/** The default `TASK_STALL_MINUTES`. */
const TASK_STALL_MINUTES = 45
const HPIPE = hpipeCommand(ROOT)
let stateDir: string
const ctx = () => ({ stateDir, pluginRoot: ROOT, session: 'personal' })

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  forgetDispatchBases()
  cleanupFixtures()
})

const supervisorDeps: TaskDeps = {
  pluginRoot: ROOT,
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
  freshDispatchBase: async () => { throw new Error('every task here was dispatched at registration') },
}

const loaded = async (runId: string): Promise<Run> => (await loadRun(stateDir, 'personal', runId))!
const taskOf = (run: Run, id: string): Task => run.tasks.find((t) => t.task_id === id)!

/** One supervisor pass over the run's tasks, saved the way `main.ts` saves it. */
async function supervisorTick(runId: string): Promise<{ run: Run; prompts: TaskPrompt[] }> {
  const run = await loaded(runId)
  const prompts = await advanceTasks(run, supervisorDeps)
  await saveRun(stateDir, run)
  return { run, prompts }
}

async function phases(runId: string): Promise<Record<string, TaskPhase>> {
  return Object.fromEntries((await loaded(runId)).tasks.map((t) => [t.task_id, t.phase]))
}

/** Another clone lands the list on origin's main: the orchestrator's checkout never sees it. */
function landList(remote: string, text: string): string {
  const other = join(tempDir('hpipe-lister-'), 'other')
  git(['clone', '-q', remote, other], tempDir('hpipe-cwd-'))
  commitAs(other, SHARED_PATHS_REL, text)
  git(['push', '-q', 'origin', 'HEAD:main'], other)
  return revParse(other, 'HEAD')
}

async function startedRun() {
  stateDir = mkdtempSync(join(tmpdir(), 'shared-paths-wiring-'))
  const { remote, clone } = cloneOfRemote('main')
  mkdirSync(join(clone, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(clone, '.claude', 'agents', 'core-dev.md'), '# core\n')
  git(['add', '-A'], clone)
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'chore: an agent'], clone)
  git(['push', '-q', 'origin', 'HEAD:main'], clone)
  const listed = landList(remote, '# every task appends an entry\ndocs/registry.md\n')

  const started = await cmdStart(ctx(), {
    title: 'registry', repoKey: clone, repoRoot: clone, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
  })
  expect(started.ok).toBe(true)
  expect(started.text).toContain(`shared: docs/registry.md — from ${SHARED_PATHS_REL} at ${listed.slice(0, 8)} ` +
    '(origin/main as just fetched); never locked')
  return { remote, clone, listed, runId: JSON.parse(started.json!).run_id as string }
}

const register = (clone: string, runId: string, branch: string, bead: string, files: string[]) => cmdTask(ctx(), {
  branch, bead, surface: 'core', notes: '', dependsOn: [], files, keepWorktree: false, repoKey: clone, runId,
  tier: 'light',
})

/** Each task as its plan clears onto the file gate: a worktree, a worker pane, and no plan widening. */
async function atTheFileGate(runId: string): Promise<void> {
  const run = await loaded(runId)
  for (const task of run.tasks) {
    Object.assign(task, {
      phase: 'blocked-on-files', phase_entered_at: Date.now() - 1_000, checkout_path: tempDir('hpipe-wt-'),
      workspace_id: `w-${task.task_id}`, pane_id: `w-${task.task_id}:p1`, agent_status: 'idle', adopted_at: Date.now(),
    })
    delete task.awaiting_brief
  }
  run.intake_closed = true
  run.phase = 'execute'
  await saveRun(stateDir, run)
}

const stallDeps = (sent: string[], now: number): StallDeps => ({
  probeMax: 3,
  now: () => now,
  probe: async (c) => { sent.push(`probe:${c.task?.task_id ?? 'run'}`); return { ok: true } },
  escalationText: async () => 'escalation text',
  queueEscalation: (c) => { sent.push(`escalate:${c.task?.task_id ?? 'run'}`) },
  agentStatus: async () => 'idle',
  persist: async () => {},
  limited: async () => false,
})

test('two tasks sharing only a listed path implement at once; one overlapping a locking path waits', async () => {
  const { remote, clone, listed, runId } = await startedRun()

  // Registration: the record keeps the shared entry, marks it, and names only a locking overlap.
  const t1 = await register(clone, runId, 'feat/a', 'hp-1', ['src/a/', 'docs/registry.md'])
  expect(t1.text).toContain('files: src/a/, docs/registry.md (shared)\n')
  const t2 = await register(clone, runId, 'feat/b', 'hp-2', ['src/b/', 'docs/registry.md'])
  expect(t2.text).toContain('files: src/b/, docs/registry.md (shared)\n')
  const t3 = await register(clone, runId, 'feat/c', 'hp-3', ['src/a/x.ts'])
  expect(t3.text).toContain('files: src/a/x.ts — overlaps t1: whichever reaches implement second waits there')

  // The gate: t1 and t2 leave on the same tick, t3 waits behind t1.
  await atTheFileGate(runId)
  const { run, prompts } = await supervisorTick(runId)
  expect(await phases(runId)).toEqual({ t1: 'implement', t2: 'implement', t3: 'blocked-on-files' })
  for (const id of ['t1', 't2']) {
    const implement = prompts.find((p) => p.taskId === id)?.text ?? ''
    expect(implement, id).toContain('`docs/registry.md` is shared: other tasks edit it at the same time.')
  }

  // What the orchestrator and the human read agrees with the gate.
  const status = formatStatus([run], { state: 'live' }, 'personal', HPIPE)
  expect(status).toContain(`  shared: docs/registry.md (from ${listed.slice(0, 8)})`)
  expect(status).toContain('⚠ t3 blocked on files held by t1 (implement) — waiting for it to finish')
  expect(status).not.toContain('held by t2')
  expect(status).toContain('nothing for you — waiting for t1 (implement) to free the files it holds')
  expect(formatTaskDetail(run, taskOf(run, 't2'))).toContain('files:      src/b/, docs/registry.md (shared)\n')
  expect(formatTaskDetail(run, taskOf(run, 't3'))).toContain('files:      src/a/x.ts\n')
  expect(desiredBead(taskOf(run, 't3'), run).blockedBy).toEqual(['hp-1'])

  // A wait on a live holder draws no probe, however long it lasts.
  const later = Date.now() + 3 * TASK_STALL_MINUTES * 60_000
  const sent: string[] = []
  await applyStalls(taskStallCandidates([run], later, TASK_STALL_MINUTES, 3).filter((c) => c.task?.task_id === 't3'),
    stallDeps(sent, later))
  expect(sent).toEqual([])

  // The snapshot is the run's for good: a list edited on origin mid-run changes nothing.
  landList(remote, 'docs/registry.md\nsrc/\n')
  const t4 = await register(clone, runId, 'feat/d', 'hp-4', ['src/a/y.ts'])
  expect(t4.text).toContain('files: src/a/y.ts — overlaps t1: whichever reaches implement second')
  expect((await loaded(runId)).shared_paths).toMatchObject({ prefixes: ['docs/registry.md'], commit: listed })

  // t1 finishing frees t3, and t2, still implementing beside it, never held it.
  const finished = await loaded(runId)
  taskOf(finished, 't1').phase = 'done'
  await saveRun(stateDir, finished)
  await supervisorTick(runId)
  expect(await phases(runId)).toMatchObject({ t1: 'done', t2: 'implement', t3: 'implement' })
}, 60_000)
