import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dispatchLockPath, type DispatchLock, groupExists, stopGroup, takeDispatchLock } from '../src/lib/dispatch-lock'
import { DispatchInterrupt, noChildren, runTrackedBootstrap, trapDispatchSignals } from '../src/lib/dispatch-process'
import { newRun, saveRun } from '../src/lib/ledger'
import { processStartedAtMs } from '../src/lib/pidfile'
import { repoContext } from '../src/lib/repo'
import type { Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'
import { makeFakeBin } from './helpers/fake-bin'
import { cleanupFixtures, cloneOfRemote, tempDir } from './helpers/git-worktree'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const PLUGIN_ROOT = join(import.meta.dir, '..')
const REPO = '/repos/berean-os'

let state: string
const groups: number[] = []
beforeEach(() => { state = tempDir('dispatch-process-') })
afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ }
  }
  cleanupFixtures()
})

function script(dir: string, body: string): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'pipeline-bootstrap'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, '.claude', 'pipeline-bootstrap'), 0o755)
}

async function heldLock(): Promise<Awaited<ReturnType<typeof takeDispatchLock>> & { ok: true }> {
  const lock: DispatchLock = {
    session: 's', run_id: 'r1', mode: 'task', task: 't1', step: 'bootstrap', since: Date.now(),
    pid: process.pid, started_at_ms: (await processStartedAtMs(process.pid))!, bootstrap: null,
  }
  const taken = await takeDispatchLock(state, REPO, lock)
  if (!taken.ok) throw new Error('lock not taken')
  return taken
}

const lockOnDisk = (): DispatchLock | null => {
  const path = dispatchLockPath(state, REPO)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as DispatchLock : null
}

test('the bootstrap runs in its own group, recorded on the lock while it runs, and the deadline stops the whole group', async () => {
  const checkout = tempDir('dispatch-checkout-')
  script(checkout, 'echo setting up\nsleep 30 &\nwait')
  const { lock } = await heldLock()
  const children = noChildren()
  const seen: Array<number | null> = []
  const watcher = setInterval(() => { seen.push(lockOnDisk()?.bootstrap?.pgid ?? null) }, 50)
  const ran = await runTrackedBootstrap(checkout, join(state, 'boot.log'), lock, children, 600)
  clearInterval(watcher)
  expect(ran.timedOutAfterMs).toBe(600)
  expect(ran.tail).toContain('setting up')
  const pgid = seen.find((value): value is number => value !== null)
  expect(pgid).toBeDefined()
  expect(groupExists(pgid!)).toBe(false)
  expect(lockOnDisk()?.bootstrap).toBeNull()
  expect(children.bootstrapPgid).toBeNull()
  lock.release()
})

test('a signal stops the bootstrap\'s group, SIGKILL included, removes the lock and exits 128+n', async () => {
  const proc = Bun.spawn(['sh', '-c', "trap '' TERM; sleep 30"], { detached: true, stdout: 'ignore', stderr: 'ignore' })
  groups.push(proc.pid)
  await Bun.sleep(100)
  const { lock } = await heldLock()
  const children = { bootstrapPgid: proc.pid, agentStartPgid: null }
  const said: string[] = []
  let exited = null as number | null
  const interrupt = new DispatchInterrupt()
  const untrap = trapDispatchSignals({
    lock, children, interrupt, say: (line) => said.push(line),
    stop: (pgid) => stopGroup(pgid, 300), exit: (code) => { exited = code },
  })
  try {
    process.emit('SIGTERM' as NodeJS.Signals)
    for (let i = 0; i < 40 && exited === null; i++) await Bun.sleep(50)
  } finally {
    untrap()
  }
  expect(exited).toBe(143)
  expect(said).toEqual(['stopped t1 at bootstrap: interrupted'])
  expect(await proc.exited).not.toBe(0)
  await Bun.sleep(50)
  expect(groupExists(proc.pid)).toBe(false)
  expect(lockOnDisk()).toBeNull()
  let gated = false
  void interrupt.gate().then(() => { gated = true })
  await Bun.sleep(20)
  expect(gated).toBe(false)
})

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/slow', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'research', awaiting_brief: true, phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
  pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', tier: 'standard', ...over,
})

test('SIGTERM to a running `hpipe dispatch` stops its bootstrap\'s whole group and removes the lock', async () => {
  const { clone } = cloneOfRemote('main')
  const repo = (await repoContext(clone))!
  const checkout = tempDir('dispatch-wt-')
  script(checkout, 'echo setting up\nsleep 60 &\nwait')
  const socket = '/sessions/s/herdr.sock'
  const run = newRun({ session: 's', socketPath: socket, repoKey: repo.repoKey, repoRoot: repo.repoRoot, title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [mkTask({})]
  await saveRun(state, run)
  const herdr = await makeFakeBin(tempDir('dispatch-herdr-'), {
    'worktree list': { result: { worktrees: [] } },
    'worktree create': {
      result: {
        workspace: { workspace_id: 'w5' }, root_pane: { pane_id: 'w5:p1', workspace_id: 'w5' }, worktree: { path: checkout },
      },
    },
  })

  const proc = Bun.spawn(['bun', 'run', CLI, 'dispatch', '--task', 't1'], {
    cwd: clone, stdout: 'pipe', stderr: 'pipe',
    env: {
      ...process.env, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_ROOT: PLUGIN_ROOT, HERDR_SESSION: 's',
      HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: herdr, HERDR_PANE_ID: 'w1:p1',
    },
  })
  const lockPath = dispatchLockPath(state, repo.repoKey)
  let pgid: number | null = null
  for (let i = 0; i < 200 && pgid === null; i++) {
    await Bun.sleep(50)
    if (existsSync(lockPath)) pgid = (JSON.parse(readFileSync(lockPath, 'utf8')) as DispatchLock).bootstrap?.pgid ?? null
  }
  expect(pgid).not.toBeNull()
  groups.push(pgid!)
  proc.kill('SIGTERM')
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  expect(code).toBe(143)
  expect(out).toContain('  base       ')
  expect(out).toContain(`  worktree   created w5 at ${checkout}, pane w5:p1`)
  expect(out.trim().split('\n').at(-1)).toBe('stopped t1 at bootstrap: interrupted')
  expect(groupExists(pgid!)).toBe(false)
  expect(existsSync(lockPath)).toBe(false)
}, 30_000)
