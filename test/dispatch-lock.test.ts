import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type DispatchLock, dispatchLockPath, dispatchUnderWay, groupExists, holderLine, type LockDeps, readDispatchLocks,
  staleDispatchLock, stopGroup, takeDispatchLock, underWayClause,
} from '../src/lib/dispatch-lock'
import { newRun } from '../src/lib/ledger'
import { processStartedAtMs } from '../src/lib/pidfile'
import type { Run, Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

let dir: string
const spawned: number[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dispatch-lock-')) })
afterEach(() => {
  for (const pgid of spawned.splice(0)) {
    try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

const REPO = '/repos/berean-os'
const NOW = 1_800_000_000_000

const lockFor = (over: Partial<DispatchLock>): DispatchLock => ({
  session: 's', run_id: 'r1', mode: 'task', task: 't1', step: 'base', since: NOW,
  pid: process.pid, started_at_ms: 0, bootstrap: null, ...over,
})

async function ourLock(over: Partial<DispatchLock> = {}): Promise<DispatchLock> {
  return lockFor({ pid: process.pid, started_at_ms: (await processStartedAtMs(process.pid))!, ...over })
}

/** A pid that has exited, so nothing answers to it. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true'])
  await proc.exited
  return proc.pid
}

/** A process leading a group of its own, as a bootstrap does. */
async function groupLeader(argv: string[]): Promise<{ pgid: number; startedAt: number }> {
  const proc = Bun.spawn(argv, { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  spawned.push(proc.pid)
  await Bun.sleep(100)
  return { pgid: proc.pid, startedAt: (await processStartedAtMs(proc.pid))! }
}

const writeLock = (lock: DispatchLock): void => {
  const path = dispatchLockPath(dir, REPO)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(lock))
}

const onDisk = (): unknown => {
  const path = dispatchLockPath(dir, REPO)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

const quickDeps: LockDeps = {
  startedAt: processStartedAtMs, groupExists, stopGroup: (pgid) => stopGroup(pgid, 500),
}

test('the lock is one file per repo, created only when free, and refuses while its holder lives', async () => {
  const mine = await ourLock()
  const taken = await takeDispatchLock(dir, REPO, mine)
  expect(taken.ok).toBe(true)
  expect(onDisk()).toEqual(mine)
  expect(dispatchLockPath(dir, REPO)).toStartWith(join(dir, 'dispatch', 'berean-os-'))

  const second = await takeDispatchLock(dir, REPO, lockFor({ pid: 1, task: 't4', mode: 'pane' }))
  expect(second).toEqual({ ok: false, holder: mine })
})

test('the holder rewrites its task and step, and its release removes only its own lock', async () => {
  const taken = await takeDispatchLock(dir, REPO, await ourLock())
  if (!taken.ok) throw new Error('not taken')
  await taken.lock.at('t2', 'bootstrap', NOW + 60_000)
  await taken.lock.bootstrapStarted(4321, NOW + 61_000)
  expect(onDisk()).toMatchObject({ task: 't2', step: 'bootstrap', since: NOW + 60_000, bootstrap: { pgid: 4321 } })
  await taken.lock.bootstrapEnded()
  expect(onDisk()).toMatchObject({ bootstrap: null })

  const other = await ourLock({ started_at_ms: 1 })
  writeLock(other)
  taken.lock.release()
  expect(onDisk()).toEqual(other)
})

test('a lock left by a dead pid is taken over', async () => {
  writeLock(lockFor({ pid: await deadPid(), started_at_ms: NOW }))
  const mine = await ourLock()
  expect((await takeDispatchLock(dir, REPO, mine)).ok).toBe(true)
  expect(onDisk()).toEqual(mine)
})

test('a lock whose pid now names another process is stale', async () => {
  writeLock(await ourLock({ started_at_ms: 1_000 }))
  const mine = await ourLock({ task: 't9' })
  expect((await takeDispatchLock(dir, REPO, mine)).ok).toBe(true)
  expect(onDisk()).toMatchObject({ task: 't9' })
})

test('a dead dispatch\'s bootstrap group that is provably its own is stopped before the takeover', async () => {
  const group = await groupLeader(['sleep', '30'])
  writeLock(lockFor({
    pid: await deadPid(), started_at_ms: NOW, step: 'bootstrap',
    bootstrap: { pgid: group.pgid, started_at_ms: group.startedAt },
  }))
  const taken = await takeDispatchLock(dir, REPO, await ourLock(), quickDeps)
  expect(taken.ok).toBe(true)
  expect(groupExists(group.pgid)).toBe(false)
})

test('a live group that cannot be shown to be the dead dispatch\'s is left alone, and the dispatch refuses', async () => {
  const group = await groupLeader(['sleep', '30'])
  const stale = lockFor({
    pid: await deadPid(), started_at_ms: NOW, step: 'bootstrap',
    bootstrap: { pgid: group.pgid, started_at_ms: group.startedAt - 3_600_000 },
  })
  writeLock(stale)
  const taken = await takeDispatchLock(dir, REPO, await ourLock(), quickDeps)
  expect(taken).toEqual({
    ok: false,
    refusal: `process group ${group.pgid} may be an earlier dispatch's bootstrap: check \`ps -g ${group.pgid}\`, ` +
      'stop it, then run this again',
  })
  expect(groupExists(group.pgid)).toBe(true)
  expect(onDisk()).toEqual(stale)
})

test('a recorded bootstrap group that is gone is no reason to refuse', async () => {
  const gone = await deadPid()
  writeLock(lockFor({ pid: await deadPid(), started_at_ms: NOW, bootstrap: { pgid: gone, started_at_ms: NOW } }))
  expect((await takeDispatchLock(dir, REPO, await ourLock(), quickDeps)).ok).toBe(true)
})

test('a lock that cannot be read refuses rather than being overwritten', async () => {
  const path = dispatchLockPath(dir, REPO)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{ not json')
  const taken = await takeDispatchLock(dir, REPO, await ourLock())
  expect(taken).toEqual({
    ok: false,
    refusal: `the dispatch lock ${path} cannot be read; if no \`hpipe dispatch\` is running, delete it and run this again`,
  })
})

test('stopping a group sends SIGTERM, then SIGKILL to what ignored it', async () => {
  const stubborn = await groupLeader(['sh', '-c', "trap '' TERM; sleep 30"])
  await stopGroup(stubborn.pgid, 300)
  await Bun.sleep(100)
  expect(groupExists(stubborn.pgid)).toBe(false)
})

test('the holder line names the task, its step and how long, and where it runs', () => {
  expect(holderLine(lockFor({ pid: 4242, step: 'bootstrap', since: NOW - 180_000 }), NOW))
    .toBe('t1 is being dispatched by pid 4242 (bootstrap, 3m), in session s (run r1)')
  expect(holderLine(lockFor({ pid: 4242, mode: 'ready', task: null, step: null }), NOW))
    .toBe('a dispatch (--ready) is under way by pid 4242, in session s (run r1)')
})

const mkRun = (): Run => {
  const run = newRun({ session: 's', socketPath: '/sock', repoKey: REPO, repoRoot: REPO, title: 'a' })
  run.run_id = 'r1'
  run.phase = 'execute'
  run.tasks = [mkTask({ task_id: 't1' }), mkTask({ task_id: 't2' }), mkTask({ task_id: 't3', phase: 'implement' })]
  return run
}

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'research', awaiting_brief: true, phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
  pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', ...over,
})

test('a live lock is under way for the task it names, and nothing else', () => {
  const run = mkRun()
  const [t1, t2] = run.tasks as [Task, Task]
  const lock = lockFor({ pid: 4242, step: 'bootstrap', since: NOW - 180_000 })
  const locks = new Map([[REPO, { live: true, lock }]])
  expect(dispatchUnderWay(locks, run, t1)).toEqual(lock)
  expect(dispatchUnderWay(locks, run, t2)).toBeNull()
  expect(underWayClause(lock, t1, 'hp', NOW))
    .toBe('nothing for you — `hp dispatch` (pid 4242) is at bootstrap for t1, started 3m ago')
})

test('a --ready lock is under way for every task owed its brief, which it takes before it ends', () => {
  const run = mkRun()
  const [, t2, t3] = run.tasks as [Task, Task, Task]
  const lock = lockFor({ pid: 4242, mode: 'ready', step: 'agent', since: NOW - 60_000 })
  const locks = new Map([[REPO, { live: true, lock }]])
  expect(dispatchUnderWay(locks, run, t2)).toEqual(lock)
  expect(dispatchUnderWay(locks, run, t3)).toBeNull()
  expect(underWayClause(lock, t2, 'hp', NOW))
    .toBe('nothing for you — `hp dispatch --ready` (pid 4242) is at agent for t1, started 1m ago; it takes t2 before it ends')
})

test('a stale lock, or one of another run or session, is under way for nobody; only a stale one is named', () => {
  const run = mkRun()
  const t1 = run.tasks[0] as Task
  const stale = new Map([[REPO, { live: false, lock: lockFor({}) }]])
  expect(dispatchUnderWay(stale, run, t1)).toBeNull()
  expect(staleDispatchLock(stale, run)).toEqual(lockFor({}))
  for (const other of [lockFor({ run_id: 'r2' }), lockFor({ session: 'other' })]) {
    const locks = new Map([[REPO, { live: true, lock: other }]])
    expect(dispatchUnderWay(locks, run, t1)).toBeNull()
    expect(staleDispatchLock(locks, run)).toBeNull()
  }
})

test('readDispatchLocks reads each repo\'s lock once and judges it live by its pid\'s start time', async () => {
  writeLock(await ourLock())
  const locks = await readDispatchLocks(dir, [REPO, REPO, '/repos/other'])
  expect([...locks.keys()]).toEqual([REPO])
  expect(locks.get(REPO)?.live).toBe(true)

  writeLock(lockFor({ pid: await deadPid(), started_at_ms: NOW }))
  expect((await readDispatchLocks(dir, [REPO])).get(REPO)?.live).toBe(false)
})
