import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdDispatchSteps, cmdStatus, type DispatchWiring, recordWorkerPane } from '../src/cli'
import { dispatchLockPath, type DispatchLock, readDispatchLocks, takeDispatchLock } from '../src/lib/dispatch-lock'
import type { DispatchHerdr } from '../src/lib/dispatch-steps'
import type { CallResult, CreatedWorktree } from '../src/lib/herdr'
import { listRuns, newRun, saveRun } from '../src/lib/ledger'
import { processStartedAtMs } from '../src/lib/pidfile'
import { hpipeCommand } from '../src/lib/render'
import { taskStallCandidates } from '../src/supervisor/stall'
import type { Run, Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'
import { cmdDispatchTask } from './helpers/cmd-dispatch'
import { READY_TOOLS } from './helpers/cmd-start'
import { makeFakeBin } from './helpers/fake-bin'

let dir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 's' })
const SOCKET = '/sessions/s/herdr.sock'
const EMPTY_BOX = ['─'.repeat(20), '❯ ', '─'.repeat(20)].join('\n')

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dispatch-cmd-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/t1', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'research', awaiting_brief: true, phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
  pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', tier: 'standard', ...over,
})

const owed = (id: string, over: Partial<Task> = {}): Task =>
  mkTask({ task_id: id, branch: `feat/${id}`, bead: `hp-${id.slice(1)}`, ...over })

async function seed(tasks: Task[]): Promise<Run> {
  const run = newRun({ session: 's', socketPath: SOCKET, repoKey: '/repo', repoRoot: '/repo', title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  await saveRun(dir, run)
  return run
}

interface Wired { wiring: DispatchWiring; said: string[]; calls: string[]; traps: string[] }

/** `onStart` stands in for herdr starting the named agent, and may refuse it. */
function wired(
  over: Partial<DispatchWiring> = {},
  onStart: (name: string) => Promise<CallResult<unknown>> = async () => ({ ok: true }),
): Wired {
  const said: string[] = []
  const calls: string[] = []
  const traps: string[] = []
  let workspaces = 1
  const created: CreatedWorktree[] = []
  const herdr: DispatchHerdr = {
    workspaceListing: async () => ({
      ok: true,
      items: created.map((made) => ({
        workspace_id: made.workspaceId, label: made.path, worktree: { repo_key: 'k', repo_root: made.path, is_linked_worktree: true },
      })),
    }),
    worktreeList: async () => ({
      ok: true,
      items: created.map((made) => ({
        path: made.path, branch: made.path.slice('/wt/'.length), is_linked_worktree: true, is_prunable: false,
      })),
    }),
    // Stands in for the supervisor's tick too, which binds a new worktree to its task from herdr's hook.
    worktreeCreate: async (_repo, branch) => {
      workspaces += 1
      calls.push(`create ${branch}`)
      const made = { workspaceId: `w${workspaces}`, paneId: `w${workspaces}:p1`, path: `/wt/${branch}` }
      created.push(made)
      const [run] = await listRuns(dir, 's')
      const task = run!.tasks.find((t) => t.branch === branch)!
      task.workspace_id = made.workspaceId
      task.checkout_path = made.path
      await saveRun(dir, run!)
      return { ok: true, result: made }
    },
    paneListing: async (ws) => ({ ok: true, items: [{ pane_id: `${ws}:p1`, agent: null, agent_status: 'unknown' }] }),
    agentPane: async () => null,
    agentStart: async (request) => {
      calls.push(`start ${request.name}`)
      return onStart(request.name)
    },
    agentStatus: async () => 'idle',
    paneReadStyled: async () => EMPTY_BOX,
  }
  const wiring: DispatchWiring = {
    herdr,
    git: { branchCommit: async () => null, contains: async () => true },
    base: async () => ({ commit: 'c0ffee1c0ffee1', ref: 'origin/main', fetchError: null }),
    runBootstrap: async () => ({ code: 0, tail: '' }),
    handOver: {
      send: async (paneId) => { calls.push(`brief ${paneId}`); return { ok: true } },
      recordPane: recordWorkerPane,
      claim: async () => ({ ok: true }),
      readPaneLimit: async () => null,
    },
    say: (line) => { said.push(line) },
    now: Date.now,
    sleep: async () => {},
    trap: () => { traps.push('on'); return () => { traps.push('off') } },
    gate: async () => {},
    ...over,
  }
  return { wiring, said, calls, traps }
}

const input = (taskId: string | null, socketPath = SOCKET) => ({ taskId, repoKey: '/repo', runId: null, socketPath })

async function holder(over: Partial<DispatchLock>): Promise<DispatchLock> {
  return {
    session: 's', run_id: 'r', mode: 'task', task: 't1', step: 'bootstrap', since: Date.now() - 180_000,
    pid: process.pid, started_at_ms: (await processStartedAtMs(process.pid))!, bootstrap: null, ...over,
  }
}

test('dispatch --task runs every step, says each line, and lets go of the lock and its traps', async () => {
  const run = await seed([owed('t1')])
  const w = wired()
  const result = await cmdDispatchSteps(ctx(), input('t1'), w.wiring)
  expect(result.ok).toBe(true)
  expect(w.said.at(-1)).toBe('dispatched t1')
  expect(w.calls).toEqual(['create feat/t1', 'start hp-1', 'brief w2:p1'])
  expect(existsSync(dispatchLockPath(dir, run.repo_key))).toBe(false)
  expect(w.traps).toEqual(['on', 'off'])
  const [saved] = await listRuns(dir, 's')
  expect(saved?.tasks[0]).toMatchObject({ pane_id: 'w2:p1' })
  expect(saved?.tasks[0]?.awaiting_brief).toBeUndefined()
})

test('dispatch refuses outside the run\'s own herdr session', async () => {
  await seed([owed('t1')])
  for (const socket of ['', '/sessions/other/herdr.sock']) {
    const w = wired()
    const result = await cmdDispatchSteps(ctx(), input('t1', socket), w.wiring)
    expect(result).toEqual({ ok: false, text: 'hpipe dispatch drives herdr itself: run it from a pane of session s' })
    expect(w.calls).toEqual([])
  }
})

test('dispatch --task takes only a task owed its brief, and says why it will not take another', async () => {
  await seed([
    owed('t1', { phase: 'queued', awaiting_brief: undefined, depends_on: ['t4'] }),
    owed('t2', { awaiting_brief: undefined, pane_id: 'w3:p1' }),
    owed('t3', { phase: 'implement', awaiting_brief: undefined, workspace_id: null }),
    owed('t4', { phase: 'implement', awaiting_brief: undefined, pane_id: 'w4:p1' }),
  ])
  const cases: Array<[string, string]> = [
    ['t1', 't1 is still queued: waiting on t4 — you will be told when it is ready'],
    ['t2', "t2's worker has the brief"],
    ['t3', 't3 is in implement, past research, with no worker: '],
    ['t4', 't4 is already in implement, past research — its worker has the brief'],
  ]
  for (const [id, message] of cases) {
    const w = wired()
    const result = await cmdDispatchSteps(ctx(), input(id), w.wiring)
    expect(result.ok, id).toBe(false)
    expect(result.text, id).toContain(message)
    expect(w.calls, id).toEqual([])
  }
})

test('a held lock refuses a second dispatch in the repo, naming its holder, task and step', async () => {
  const run = await seed([owed('t1'), owed('t4')])
  await takeDispatchLock(dir, run.repo_key, await holder({ run_id: run.run_id }))
  const w = wired()
  const result = await cmdDispatchSteps(ctx(), input('t4'), w.wiring)
  expect(result.ok).toBe(false)
  expect(result.text).toBe(`t1 is being dispatched by pid ${process.pid} (bootstrap, 3m), in session s (run ` +
    `${run.run_id}): one dispatch runs per repo at a time. Run this again once it ends`)
  expect(w.calls).toEqual([])
})

test('a --ready holder says it takes the task too', async () => {
  const run = await seed([owed('t1'), owed('t4')])
  await takeDispatchLock(dir, run.repo_key, await holder({ run_id: run.run_id, mode: 'ready' }))
  const result = await cmdDispatchSteps(ctx(), input('t4'), wired().wiring)
  expect(result.text).toContain('; it takes every task that becomes ready before it ends, t4 included. ')
})

test('the --pane form takes the lock too', async () => {
  const run = await seed([owed('t1'), owed('t4')])
  await takeDispatchLock(dir, run.repo_key, await holder({ run_id: run.run_id }))
  let sent = false
  const result = await cmdDispatchTask(ctx(), { taskId: 't4', paneId: 'w9:p1', repoKey: '/repo', runId: null },
    async () => { sent = true; return { ok: true } })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('one dispatch runs per repo at a time')
  expect(sent).toBe(false)
})

test('the --pane form lets go of the lock once the brief is handed over', async () => {
  const run = await seed([owed('t1')])
  const result = await cmdDispatchTask(ctx(), { taskId: 't1', paneId: 'w9:p1', repoKey: '/repo', runId: null },
    async () => ({ ok: true }))
  expect(result.ok).toBe(true)
  expect(existsSync(dispatchLockPath(dir, run.repo_key))).toBe(false)
})

test('--ready takes every task owed its brief in task id order, and only those', async () => {
  await seed([owed('t10'), owed('t2'), owed('t3', { phase: 'queued', awaiting_brief: undefined, depends_on: ['t2'] }),
    owed('t1', { awaiting_brief: undefined, pane_id: 'w7:p1' })])
  const w = wired()
  const result = await cmdDispatchSteps(ctx(), input(null), w.wiring)
  expect(result).toEqual({ ok: true, text: 'dispatched t2, t10' })
  expect(w.calls.filter((c) => c.startsWith('start'))).toEqual(['start hp-2', 'start hp-10'])
})

test('--ready stops at the first failure and names what was dispatched, where it stopped and what was not started', async () => {
  await seed([owed('t1'), owed('t2'), owed('t3'), owed('t4')])
  const w = wired({}, async (name) =>
    (name === 'hp-2' ? { ok: false, code: 'agent_not_ready', message: 'dialog' } : { ok: true }))
  const result = await cmdDispatchSteps(ctx(), input(null), w.wiring)
  expect(result).toEqual({ ok: false, text: 'dispatched t1; stopped at t2; not started: t3, t4' })
  expect(w.said).toContain('stopped t2 at agent: herdr agent start answered agent_not_ready — dialog: ' +
    '`herdr pane read w3:p1`; a re-run skips the worktree and the bootstrap, and starts the agent unless one is in the pane')
  expect(w.calls.filter((c) => c.startsWith('start'))).toEqual(['start hp-1', 'start hp-2'])
})

test('--ready takes a task that became owed its brief while it ran, before it lets go of the lock', async () => {
  const run = await seed([owed('t1')])
  const w = wired({}, async (name) => {
    if (name === 'hp-1') {
      const [current] = await listRuns(dir, 's')
      current!.tasks.push(owed('t2'))
      await saveRun(dir, current!)
    }
    return { ok: true }
  })
  const result = await cmdDispatchSteps(ctx(), input(null), w.wiring)
  expect(result).toEqual({ ok: true, text: 'dispatched t1, t2' })
  expect(existsSync(dispatchLockPath(dir, run.repo_key))).toBe(false)
})

test('--ready with nothing owed says so and succeeds', async () => {
  await seed([owed('t1', { awaiting_brief: undefined, pane_id: 'w7:p1' })])
  const result = await cmdDispatchSteps(ctx(), input(null), wired().wiring)
  expect(result).toEqual({ ok: true, text: 'nothing to dispatch: no task in this run is waiting for its brief' })
})

test('the lock names each task and step as the dispatch moves', async () => {
  const run = await seed([owed('t1')])
  const seen: string[] = []
  const w = wired({}, async () => {
    const lock = JSON.parse(await Bun.file(dispatchLockPath(dir, run.repo_key)).text()) as DispatchLock
    seen.push(`${lock.mode} ${lock.task} ${lock.step}`)
    return { ok: true }
  })
  expect((await cmdDispatchSteps(ctx(), input('t1'), w.wiring)).ok).toBe(true)
  expect(seen).toEqual(['task t1 agent'])
})

/** A task rewound into research with no worktree: its dispatch advice is owed at once. */
async function seedOwingADispatch(): Promise<Run> {
  const run = await seed([owed('t1', { phase_entered_at: 0 })])
  run.phase_entered_at = 0
  run.history.push({ at: 0, task_id: 't1', from: 'rewind', to: 'research', why: 'manual rewind' })
  await saveRun(dir, run)
  return run
}

async function statusText(): Promise<string> {
  const herdrBefore = process.env.HERDR_BIN_PATH
  process.env.HERDR_BIN_PATH = await makeFakeBin(dir, { 'pane list': { result: { panes: [] } } })
  try {
    return (await cmdStatus(ctx(), async () => READY_TOOLS)).text
  } finally {
    if (herdrBefore === undefined) delete process.env.HERDR_BIN_PATH
    else process.env.HERDR_BIN_PATH = herdrBefore
  }
}

test('status and the stall ladder read a live dispatch lock off disk, and leave its task alone', async () => {
  const run = await seedOwingADispatch()
  expect(await statusText()).toContain('YOUR move: no worktree and no agent')
  const [onDisk] = await listRuns(dir, 's')
  expect(taskStallCandidates([onDisk!], Date.now(), 45, 3, 15)).toHaveLength(1)

  const taken = await takeDispatchLock(dir, run.repo_key, await holder({ run_id: run.run_id }))
  if (!taken.ok) throw new Error('lock not taken')
  try {
    const text = await statusText()
    expect(text).toContain(`nothing for you — \`${hpipeCommand(ctx().pluginRoot)} dispatch\` (pid ${process.pid}) ` +
      'is at bootstrap for t1, started 3m ago')
    expect(text).not.toContain('waiting on you:')
    const locks = await readDispatchLocks(dir, [run.repo_key])
    expect(taskStallCandidates([onDisk!], Date.now(), 45, 3, 15, locks)).toHaveLength(0)
  } finally {
    taken.lock.release()
  }
})

test('status names a dispatch lock its holder left behind, and keeps the advice', async () => {
  const run = await seedOwingADispatch()
  const dead = Bun.spawn(['true'])
  await dead.exited
  await takeDispatchLock(dir, run.repo_key, await holder({ run_id: run.run_id, pid: dead.pid, started_at_ms: 1 }))
  const text = await statusText()
  expect(text).toContain('YOUR move: no worktree and no agent')
  expect(text).toContain(`⚠ a dispatch lock for this repo is left by pid ${dead.pid}, which is gone; the next ` +
    `\`${hpipeCommand(ctx().pluginRoot)} dispatch\` cleans it up`)
})

test('the --pane form will not hand a second brief to the pane that already has one', async () => {
  await seed([owed('t1', { awaiting_brief: undefined, pane_id: 'w5:p1' })])
  let sent = false
  const result = await cmdDispatchTask(ctx(), { taskId: 't1', paneId: 'w5:p1', repoKey: '/repo', runId: null },
    async () => { sent = true; return { ok: true } })
  expect(result).toEqual({
    ok: false,
    text: `t1's worker in w5:p1 already has the brief; \`${hpipeCommand(ctx().pluginRoot)} brief --task t1\` prints ` +
      'it to reread',
  })
  expect(sent).toBe(false)
})

test('a dispatch refuses when its own start time cannot be read, since the lock could not tell it from a dead one', async () => {
  await seed([owed('t1')])
  const w = wired({ lock: { startedAt: async () => null, groupExists: () => false, stopGroup: async () => {} } })
  const result = await cmdDispatchSteps(ctx(), input('t1'), w.wiring)
  expect(result.ok).toBe(false)
  expect(result.text).toContain("could not read this process's start time")
  expect(w.calls).toEqual([])
})

test('after a signal, a killed child\'s answer is not judged: the dispatch waits on the handler instead', async () => {
  await seed([owed('t1')])
  let interrupted = false
  const w = wired({
    gate: async () => { if (interrupted) await new Promise<never>(() => {}) },
  }, async () => {
    interrupted = true
    return { ok: false, code: 'spawn_failed', message: 'killed' }
  })
  let settled = false
  void cmdDispatchSteps(ctx(), input('t1'), w.wiring).then(() => { settled = true })
  for (let i = 0; i < 20 && !w.calls.some((c) => c.startsWith('start')); i++) await Bun.sleep(10)
  await Bun.sleep(50)
  expect(w.calls).toContain('start hp-1')
  expect(settled).toBe(false)
  expect(w.said.some((line) => line.startsWith('stopped t1'))).toBe(false)
})
