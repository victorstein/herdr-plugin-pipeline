import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BdFailure, BeadUpdate, Done, ExportedBead } from '../src/lib/bd'
import { desiredBead } from '../src/lib/bead-desired'
import { beadClaimants } from '../src/lib/held'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { callsFor, closeReason, type SyncBd, type SyncDeps, syncBeads } from '../src/supervisor/beads-sync'
import { beadTaskFields } from './helpers/bead-fields'

const mkTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'implement', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
  pr: 7, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, merge_commit: 'm3rg3', ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function runWith(...tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: '/code/repo', repoRoot: '/code/repo', title: 'a' })
  run.run_id = 'r1'
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

const bead = (id: string, over: Partial<ExportedBead> = {}): ExportedBead =>
  ({ id, title: id, status: 'open', labels: [], dependencies: [], comments: [], ...over })

/**
 * An in-memory store with a separate export, as bd has: writes change the live
 * store and mark the export dirty; only a successful export or refresh copies it.
 * Records each call it is asked to make.
 */
function fakeStore(beads: ExportedBead[], fail: (id: string, kind: string) => BdFailure | null = () => null) {
  const live = new Map(beads.map((b) => [b.id, structuredClone(b)]))
  let exported = beads.map((b) => structuredClone(b))
  let dirty = false
  let exportFailure: BdFailure | null = null
  const calls: string[] = []
  let exports = 0
  let refreshes = 0
  let onCall = (): void => {}
  const answer = (id: string, call: string, apply: (b: ExportedBead) => void): Promise<Done | BdFailure> => {
    calls.push(call)
    onCall()
    const failure = fail(id, call.split(' ')[0]!)
    if (failure !== null) return Promise.resolve(failure)
    dirty = true
    const target = live.get(id)
    if (target) apply(target)
    return Promise.resolve({ ok: true })
  }
  const exportLive = (): Done | BdFailure => {
    if (exportFailure !== null) return exportFailure
    exported = [...live.values()].map((b) => structuredClone(b))
    dirty = false
    return { ok: true }
  }
  const bd: SyncBd = {
    readExport: () => exported.map((b) => structuredClone(b)),
    refreshExport: async () => {
      const failure = fail('', 'refreshExport')
      if (failure !== null) return failure
      if (!dirty) return { ok: true }
      refreshes++
      return exportLive()
    },
    reopen: (id) => answer(id, `reopen ${id}`, (b) => { b.status = 'open' }),
    update: (id, change: BeadUpdate) => answer(id, `update ${id} ${JSON.stringify(change)}`, (b) => {
      if (change.status !== undefined) b.status = change.status
      if (change.assignee !== undefined) b.assignee = change.assignee
      b.labels = [...(b.labels ?? []).filter((l) => !(change.removeLabels ?? []).includes(l)), ...(change.addLabels ?? [])]
    }),
    depAdd: (from, to) => answer(from, `depAdd ${from} ${to}`, (b) => {
      b.dependencies = [...(b.dependencies ?? []), { depends_on_id: to, type: 'blocks' }]
    }),
    comment: (id, text) => answer(id, `comment ${id}`, (b) => { b.comments = [...(b.comments ?? []), { text }] }),
    close: (id, reason) => answer(id, `close ${id} ${reason}`, (b) => { b.status = 'closed' }),
    exportNow: async () => {
      exports++
      return exportLive()
    },
  }
  return {
    bd, calls, exports: () => exports, refreshes: () => refreshes,
    onEachCall: (hook: () => void) => { onCall = hook },
    failExports: (failure: BdFailure | null) => { exportFailure = failure },
  }
}

function deps(store: ReturnType<typeof fakeStore>, over: Partial<SyncDeps> = {}): SyncDeps & { persisted: Run[] } {
  const persisted: Run[] = []
  return {
    persisted,
    bdFor: () => store.bd,
    hasStore: async () => true,
    now: () => 1_000,
    budgetMs: 2_000,
    claimants: async () => [],
    lockNotices: new Map(),
    persist: async (run) => { persisted.push(structuredClone(run)) },
    log: () => {},
    ...over,
  }
}

test('a dispatched task\'s open bead gets one update folding status, assignee and labels; foreign labels stay', () => {
  const task = mkTask({ phase: 'implement' })
  const actual = bead('hp-1', { labels: ['hpipe:run=r1', 'phase:research', 'ui'] })
  expect(callsFor(desiredBead(task, runWith(task)), actual, closeReason(task))).toEqual([{
    kind: 'update',
    change: { status: 'in_progress', assignee: 'hpipe', addLabels: ['phase:implement'], removeLabels: ['phase:research'] },
  }])
})

test('a bead already as desired needs no call', () => {
  const task = mkTask({ phase: 'implement' })
  const actual = bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:implement'] })
  expect(callsFor(desiredBead(task, runWith(task)), actual, closeReason(task))).toEqual([])
})

test('a closed bead the ledger wants open again is reopened before its update', () => {
  const task = mkTask({ phase: 'implement' })
  const actual = bead('hp-1', { status: 'closed', assignee: 'hpipe', labels: ['hpipe:run=r1'] })
  expect(callsFor(desiredBead(task, runWith(task)), actual, closeReason(task))).toEqual([
    { kind: 'reopen' },
    { kind: 'update', change: { status: 'in_progress', addLabels: ['phase:implement'] } },
  ])
})

test('a merged task\'s bead is relabelled, then closed last with the merge as its reason', () => {
  const task = mkTask({ phase: 'close', merged_at_ms: 5 })
  const actual = bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:merge'] })
  expect(callsFor(desiredBead(task, runWith(task)), actual, closeReason(task))).toEqual([
    { kind: 'update', change: { removeLabels: ['phase:merge'] } },
    { kind: 'close', reason: 'merged in PR #7 (m3rg3)' },
  ])
})

test('missing edges and comments come after the update and before the close', () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'done', merged_at_ms: 1 })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'blocked-on-decision', decision_from: 'plan', depends_on: ['t1'] })
  second.decisions = [{
    id: 'd1', asked_at: 0, from_phase: 'plan', question: 'q', recommendation: 'r',
    answer: null, answered_by: null, answered_at: null, prompted_at: 1, escalated_at: 2, orchestrator_recommendation: 'o',
  }]
  const calls = callsFor(desiredBead(second, runWith(first, second)), bead('hp-2'), closeReason(second))
  expect(calls.map((c) => c.kind)).toEqual(['update', 'depAdd', 'comment'])
  expect(calls[1]).toEqual({ kind: 'depAdd', dependsOn: 'hp-1' })
  expect(calls[2]).toMatchObject({ kind: 'comment', marker: '[hpipe t2/d1/asked]' })
})

test('a closed bead that should stay closed is left alone, whoever it is assigned to', () => {
  const task = mkTask({ phase: 'done', merged_at_ms: 5 })
  expect(callsFor(desiredBead(task, runWith(task)), bead('hp-1', { status: 'closed', labels: ['hpipe:run=r1'] }), closeReason(task)))
    .toEqual([])
})

test('a pass converges every task and exports once', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'implement' })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  const store = fakeStore([bead('hp-1', { labels: ['phase:research'] }), bead('hp-2')])

  await syncBeads([runWith(first, second)], deps(store))

  expect(store.calls).toEqual([
    'update hp-1 {"status":"in_progress","assignee":"hpipe","addLabels":["hpipe:run=r1","phase:implement"],"removeLabels":["phase:research"]}',
    'update hp-2 {"addLabels":["hpipe:run=r1","phase:queued"]}',
    'depAdd hp-2 hp-1',
  ])
  expect(store.exports()).toBe(1)
})

test('a pass with nothing to change neither writes, exports nor saves', async () => {
  const task = mkTask({ phase: 'queued' })
  const store = fakeStore([bead('hp-1', { labels: ['hpipe:run=r1', 'phase:queued'] })])
  const d = deps(store)
  await syncBeads([runWith(task)], d)
  expect(store.calls).toEqual([])
  expect(store.exports()).toBe(0)
  expect(d.persisted).toEqual([])
})

test('a failed call is counted on its task, monotonically, and the next task still converges', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'implement' })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'implement' })
  const run = runWith(first, second)
  const store = fakeStore([bead('hp-1'), bead('hp-2')],
    (id) => (id === 'hp-1' ? { reason: 'exit', error: 'Error: database is locked' } : null))
  const d = deps(store)

  await syncBeads([run], d)
  await syncBeads([run], d)

  expect(first.bead_sync).toEqual({ failures: 2, last_error: 'Error: database is locked', last_ok_at_ms: null })
  expect(second.bead_sync).toEqual({ failures: 0, last_error: null, last_ok_at_ms: 1_000 })
  expect(d.persisted.at(-1)?.tasks[0]?.bead_sync.failures).toBe(2)
})

test('a held lock ends the pass at once and counts as no failure', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'implement' })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'implement' })
  const store = fakeStore([bead('hp-1'), bead('hp-2')], () => ({ reason: 'busy', error: 'Beads is busy, retry' }))

  await syncBeads([runWith(first, second)], deps(store))

  expect(store.calls).toEqual([])
  expect(first.bead_sync.failures).toBe(0)
  expect(store.exports()).toBe(0)
})

test('the 2 s budget stops a pass part-way, and the next pass does only what is left', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'implement' })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  const run = runWith(first, second)
  const store = fakeStore([bead('hp-1'), bead('hp-2')])
  let clock = 0
  store.onEachCall(() => { clock += 1_500 })
  const d = deps(store, { now: () => clock })

  await syncBeads([run], d)
  expect(store.calls.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['update hp-1', 'update hp-2'])
  expect(store.exports()).toBe(1)

  await syncBeads([run], d)
  expect(store.calls.slice(2)).toEqual(['depAdd hp-2 hp-1'])
})

test('a pass that crashed part-way converges on the next one', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'done', merged_at_ms: 1 })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  const run = runWith(first, second)
  let failNextDep = true
  const store = fakeStore([bead('hp-1', { status: 'closed', labels: ['hpipe:run=r1'] }), bead('hp-2')], (_id, kind) => {
    if (kind !== 'depAdd' || !failNextDep) return null
    failNextDep = false
    return { reason: 'timeout', error: 'bd dep was killed after 30s' }
  })
  const d = deps(store)

  await syncBeads([run], d)
  await syncBeads([run], d)

  expect(store.calls).toEqual([
    'update hp-2 {"addLabels":["hpipe:run=r1","phase:queued"]}', 'depAdd hp-2 hp-1', 'depAdd hp-2 hp-1',
  ])
  expect(second.bead_sync).toMatchObject({ failures: 1, last_error: null })
})

test('done and aborted runs are visited: an aborted run\'s claimed bead is released', async () => {
  const task = mkTask({ phase: 'implement' })
  const run = runWith(task)
  run.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  run.escalated_from = 'execute'
  run.phase = 'done'
  const store = fakeStore([bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:implement'] })])

  await syncBeads([run], deps(store))

  expect(store.calls).toEqual([
    'update hp-1 {"status":"open","assignee":"","addLabels":["phase:aborted"],"removeLabels":["phase:implement"]}',
  ])
})

test('bead_closed_at_ms is set only once a merge is recorded and the export shows the bead closed', async () => {
  const merged = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'close', merged_at_ms: 5 })
  const unmerged = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'implement' })
  const run = runWith(merged, unmerged)
  const store = fakeStore([
    bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:close'] }),
    bead('hp-2', { status: 'closed', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:implement'] }),
  ])
  let clock = 1_000
  const d = deps(store, { now: () => clock })

  await syncBeads([run], d)
  expect(merged.bead_closed_at_ms).toBeNull()
  expect(store.calls).toContain('close hp-1 merged in PR #7 (m3rg3)')
  expect(store.calls).toContain('reopen hp-2')

  clock = 2_000
  await syncBeads([run], d)
  expect(merged.bead_closed_at_ms).toBe(2_000)
  expect(unmerged.bead_closed_at_ms).toBeNull()
})

test('a rewind that clears the merge flips the bead back: reopened and re-claimed', async () => {
  const task = mkTask({ phase: 'implement', merged_at_ms: null, bead_closed_at_ms: null })
  const store = fakeStore([bead('hp-1', { status: 'closed', assignee: 'hpipe', labels: ['hpipe:run=r1'] })])
  await syncBeads([runWith(task)], deps(store))
  expect(store.calls).toEqual(['reopen hp-1', 'update hp-1 {"status":"in_progress","addLabels":["phase:implement"]}'])
})

test('a repo with no Beads store is skipped', async () => {
  const store = fakeStore([bead('hp-1')])
  await syncBeads([runWith(mkTask())], deps(store, { hasStore: async () => false }))
  expect(store.calls).toEqual([])
})

test('a merged task waiting on its close in a repo with no store counts a failure, logged once; others are untouched', async () => {
  const waiting = mkTask({ phase: 'close', merged_at_ms: 5 })
  const working = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'implement' })
  const logged: string[] = []
  const d = deps(fakeStore([]), { hasStore: async () => false, log: (message) => { logged.push(message) } })
  const run = runWith(waiting, working)

  await syncBeads([run], d)
  await syncBeads([run], d)

  expect(waiting.bead_sync).toMatchObject({
    failures: 2, last_error: 'no Beads store for /code/repo; run the setup action or `hpipe close`',
  })
  expect(working.bead_sync.failures).toBe(0)
  expect(logged).toHaveLength(1)
  expect(d.persisted).toHaveLength(2)
})

test('a merged task waiting on a bead another task drives counts a failure naming the driver', async () => {
  const holder = mkTask({ phase: 'implement', registered_at: 2 })
  const merged = mkTask({ phase: 'close', merged_at_ms: 5, registered_at: 1 })
  const olderRun = runWith(merged)
  olderRun.run_id = 'r0'
  const store = fakeStore([bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:implement'] })])

  await syncBeads([runWith(holder), olderRun], deps(store))

  expect(merged.bead_sync.failures).toBe(1)
  expect(merged.bead_sync.last_error).toContain('driven by t1 of run r1 (session p)')
  expect(merged.bead_closed_at_ms).toBeNull()
  expect(store.calls).toEqual([])
})

test('a merged task waiting on a bead another task drives records the close once the bead is closed', async () => {
  const holder = mkTask({ phase: 'close', merged_at_ms: 9, bead_closed_at_ms: 9, registered_at: 2 })
  const merged = mkTask({ phase: 'close', merged_at_ms: 5, registered_at: 1 })
  const olderRun = runWith(merged)
  olderRun.run_id = 'r0'
  const store = fakeStore([bead('hp-1', { status: 'closed', assignee: 'hpipe', labels: ['hpipe:run=r1'] })])

  await syncBeads([runWith(holder), olderRun], deps(store))

  expect(merged.bead_closed_at_ms).toBe(1_000)
  expect(merged.bead_sync.failures).toBe(0)
  expect(store.calls).toEqual([])
})

test('a lock that could not be taken for want of ps also ends the pass without a failure', async () => {
  const task = mkTask({ phase: 'implement' })
  const store = fakeStore([bead('hp-1')], () => ({ reason: 'unavailable', error: 'could not read this process\'s start time' }))
  await syncBeads([runWith(task)], deps(store))
  expect(task.bead_sync.failures).toBe(0)
})

test('a closed bead whose close is already recorded saves nothing on later passes', async () => {
  const task = mkTask({ phase: 'done', merged_at_ms: 1, bead_closed_at_ms: 5 })
  const store = fakeStore([bead('hp-1', { status: 'closed', labels: ['hpipe:run=r1'] })])
  const d = deps(store)
  await syncBeads([runWith(task)], d)
  expect(d.persisted).toEqual([])
})

test('a bead an aborted run released and a later run took is driven by the run holding it', async () => {
  const abandoned = mkTask({ phase: 'implement', registered_at: 1 })
  const oldRun = runWith(abandoned)
  oldRun.run_id = 'r0'
  oldRun.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  oldRun.escalated_from = 'execute'
  oldRun.phase = 'done'
  const taken = mkTask({ phase: 'implement', registered_at: 2 })
  const store = fakeStore([bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:implement'] })])

  await syncBeads([runWith(taken), oldRun], deps(store))
  await syncBeads([oldRun, runWith(taken)], deps(store))

  expect(store.calls).toEqual([])
})

const escalatedDecision = (): Task['decisions'][number] => ({
  id: 'd1', asked_at: 0, from_phase: 'plan', question: 'q', recommendation: 'r',
  answer: null, answered_by: null, answered_at: null, prompted_at: 1, escalated_at: 2, orchestrator_recommendation: 'o',
})

test('a lock taken mid-pass ends it without a failure', async () => {
  const task = mkTask({ phase: 'implement' })
  const store = fakeStore([bead('hp-1')], (_id, kind) => (kind === 'update' ? { reason: 'busy', error: 'Beads is busy, retry' } : null))
  await syncBeads([runWith(task)], deps(store))
  expect(store.calls).toHaveLength(1)
  expect(task.bead_sync.failures).toBe(0)
})

test('a lock that stays held is logged once, not every tick', async () => {
  const store = fakeStore([bead('hp-1')], () => ({ reason: 'busy', error: 'Beads is busy, retry' }))
  const logged: string[] = []
  const d = deps(store, { log: (message) => { logged.push(message) } })
  const run = runWith(mkTask({ phase: 'implement' }))
  await syncBeads([run], d)
  await syncBeads([run], d)
  expect(logged).toHaveLength(1)
})

test('any existing edge between the pair stands for the blocks edge, since bd refuses a second type', () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'done', merged_at_ms: 1 })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  const actual = bead('hp-2', {
    labels: ['hpipe:run=r1', 'phase:queued'], dependencies: [{ depends_on_id: 'hp-1', type: 'discovered-from' }],
  })
  expect(callsFor(desiredBead(second, runWith(first, second)), actual, closeReason(second))).toEqual([])
})

test('a write whose export failed is re-exported before the next diff, so no comment is posted twice', async () => {
  const task = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan', decisions: [escalatedDecision()] })
  const store = fakeStore([bead('hp-1', { status: 'blocked', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:blocked-on-decision', 'hpipe:awaiting-human'] })])
  const run = runWith(task)
  const d = deps(store)

  store.failExports({ reason: 'exit', error: 'disk full' })
  await syncBeads([run], d)
  await syncBeads([run], d)
  expect(store.calls).toEqual(['comment hp-1'])

  store.failExports(null)
  await syncBeads([run], d)
  expect(store.calls).toEqual(['comment hp-1'])
  expect(store.refreshes()).toBe(2)
})

test('a bead missing from the export counts as a failure, logged once while the error stays the same', async () => {
  const task = mkTask({ phase: 'close', merged_at_ms: 5, bead: 'hp-9' })
  const store = fakeStore([bead('hp-1')])
  const logged: string[] = []
  const d = deps(store, { log: (message) => { logged.push(message) } })
  const run = runWith(task)

  await syncBeads([run], d)
  await syncBeads([run], d)

  expect(task.bead_sync).toMatchObject({ failures: 2, last_error: 'bead hp-9 is not in the Beads export' })
  expect(task.bead_closed_at_ms).toBeNull()
  expect(logged).toHaveLength(1)
})

let stateDir: string
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'beads-sync-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

function writeRunFile(run: Run): void {
  mkdirSync(join(stateDir, 'runs', run.session), { recursive: true })
  writeFileSync(join(stateDir, 'runs', run.session, `${run.run_id}.json`), JSON.stringify(run))
}

function abortedRun(task: Task): Run {
  const run = runWith(task)
  run.run_id = 'r0'
  run.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  run.escalated_from = 'execute'
  run.phase = 'done'
  return run
}

function runInSession(session: string, task: Task): Run {
  const run = runWith(task)
  run.session = session
  run.run_id = 'r2'
  return run
}

test('a bead this session released and another session took is left to the session holding it', async () => {
  const released = abortedRun(mkTask({ phase: 'implement', registered_at: 1 }))
  writeRunFile(released)
  writeRunFile(runInSession('q', mkTask({ phase: 'implement', registered_at: 2 })))
  const store = fakeStore([bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r2', 'phase:implement'] })])

  await syncBeads([released], deps(store, { claimants: () => beadClaimants(stateDir) }))

  expect(store.calls).toEqual([])
})

test('once the other session merges the bead, this session\'s older release does not reopen it', async () => {
  const released = abortedRun(mkTask({ phase: 'implement', registered_at: 1 }))
  writeRunFile(released)
  const merged = runInSession('q', mkTask({ phase: 'done', merged_at_ms: 9, registered_at: 2 }))
  merged.phase = 'done'
  writeRunFile(merged)
  const store = fakeStore([bead('hp-1', { status: 'closed', assignee: 'hpipe', labels: ['hpipe:run=r2'] })])

  await syncBeads([released], deps(store, { claimants: () => beadClaimants(stateDir) }))

  expect(store.calls).toEqual([])
})

test('a bead no other session claims is still released by this one', async () => {
  const released = abortedRun(mkTask({ phase: 'implement', registered_at: 1 }))
  writeRunFile(released)
  const store = fakeStore([bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r0', 'phase:implement'] })])

  await syncBeads([released], deps(store, { claimants: () => beadClaimants(stateDir) }))

  expect(store.calls).toHaveLength(1)
})
