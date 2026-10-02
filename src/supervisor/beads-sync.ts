import { type Bd, type BdFailure, type BeadUpdate, type Done, type ExportedBead, isBdFailure } from '../lib/bd'
import { type DesiredBead, desiredBead, isManagedLabel } from '../lib/bead-desired'
import { beadsSlug } from '../lib/beads-project'
import { type BeadClaimant, holdsBead } from '../lib/held'
import type { RunEffect } from '../lib/ledger'
import type { Run, Task } from '../lib/types'

export const SYNC_BUDGET_MS = 2_000

export type BeadCall =
  | { kind: 'reopen' }
  | { kind: 'update'; change: BeadUpdate }
  | { kind: 'depAdd'; dependsOn: string }
  | { kind: 'comment'; marker: string; text: string }
  | { kind: 'close'; reason: string }

export type SyncBd = Pick<
  Bd, 'readExport' | 'refreshExport' | 'reopen' | 'update' | 'depAdd' | 'comment' | 'close' | 'exportNow'
>

export interface SyncDeps {
  /** A try-lock `Bd` that does not export after writes: the pass exports once at its end. */
  bdFor: (slug: string) => SyncBd
  hasStore: (slug: string) => Promise<boolean>
  now: () => number
  budgetMs: number
  /** Every session's run files: a bead released here may be held from another session. */
  claimants: () => Promise<BeadClaimant[]>
  persist: (run: Run, effect: RunEffect) => Promise<void>
  log: (message: string) => void
  /** Per slug, the last lock message logged, kept across passes so a busy store is reported once. */
  lockNotices: Map<string, string>
}

export function closeReason(task: Task): string {
  return `merged in PR #${task.pr ?? 'unknown'} (${task.merge_commit ?? 'unknown commit'})`
}

/**
 * The fewest calls that take `actual` to `desired`, in the only order that
 * works: reopen before anything that needs an open bead, close after everything
 * else. Each is idempotent against `desired`, so a pass cut short anywhere is
 * finished by recomputing the remainder next tick.
 */
export function callsFor(desired: DesiredBead, actual: ExportedBead, reason: string): BeadCall[] {
  const calls: BeadCall[] = []
  const wasClosed = actual.status === 'closed'
  const wantsClosed = desired.status === 'closed'
  const reopening = wasClosed && !wantsClosed
  if (reopening) calls.push({ kind: 'reopen' })

  const change: BeadUpdate = {}
  // bd's reopen keeps the assignee, so only the status is known to have moved.
  const statusNow = reopening ? 'open' : actual.status
  if (!wantsClosed && statusNow !== desired.status) change.status = desired.status
  const assignee = desired.assignee ?? ''
  if (!(wantsClosed && wasClosed) && (actual.assignee ?? '') !== assignee) change.assignee = assignee
  const labels = actual.labels ?? []
  const addLabels = desired.labels.filter((label) => !labels.includes(label))
  const removeLabels = labels.filter((label) => isManagedLabel(label) && !desired.labels.includes(label))
  if (addLabels.length > 0) change.addLabels = addLabels
  if (removeLabels.length > 0) change.removeLabels = removeLabels
  if (Object.keys(change).length > 0) calls.push({ kind: 'update', change })

  // bd 1.3.1 refuses a second edge of another type between the same pair, so any
  // edge (a `discovered-from` included) stands for the `blocks` one.
  for (const dependsOn of desired.blockedBy) {
    const linked = (actual.dependencies ?? []).some((d) => d.depends_on_id === dependsOn)
    if (!linked) calls.push({ kind: 'depAdd', dependsOn })
  }
  for (const comment of desired.comments) {
    if (!(actual.comments ?? []).some((c) => c.text.includes(comment.marker))) calls.push({ kind: 'comment', ...comment })
  }
  if (wantsClosed && !wasClosed) calls.push({ kind: 'close', reason })
  return calls
}

function applyCall(bd: SyncBd, bead: string, call: BeadCall): Promise<Done | BdFailure> {
  switch (call.kind) {
    case 'reopen': return bd.reopen(bead)
    case 'update': return bd.update(bead, call.change)
    case 'depAdd': return bd.depAdd(bead, call.dependsOn)
    case 'comment': return bd.comment(bead, call.text)
    case 'close': return bd.close(bead, call.reason, { force: false })
  }
}

const onTask = (taskId: string, change: (task: Task) => void): RunEffect => (run) => {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (task) change(task)
}

export const recordSyncFailure = (taskId: string, error: string): RunEffect => onTask(taskId, (task) => {
  task.bead_sync = { ...task.bead_sync, failures: task.bead_sync.failures + 1, last_error: error }
})

export const recordSyncOk = (taskId: string, at: number): RunEffect => onTask(taskId, (task) => {
  task.bead_sync = { ...task.bead_sync, last_error: null, last_ok_at_ms: at }
})

/** Only after a recorded merge: a bead a human closed by hand must not let an unmerged task tear down. */
export const recordBeadClosed = (taskId: string, at: number): RunEffect => onTask(taskId, (task) => {
  if (task.merged_at_ms !== null && task.bead_closed_at_ms === null) task.bead_closed_at_ms = at
})

/** Busy, or no `ps` to stamp the lock with: either way no call can run until a later tick. */
const lockNotTaken = (failure: BdFailure): boolean => failure.reason === 'busy' || failure.reason === 'unavailable'

type Driver = Pick<BeadClaimant, 'session' | 'run_id' | 'task_id' | 'holds' | 'registered_at'>

const driverKey = (slug: string, bead: string): string => `${slug}\0${bead}`

const drivesOver = (candidate: Driver, current: Driver): boolean =>
  candidate.holds !== current.holds ? candidate.holds : candidate.registered_at > current.registered_at

/**
 * Which task, across every session, drives each bead. A bead released by an
 * aborted or failed run can be adopted by a later one, from this session or
 * another; without one driver the two desired states would flip the bead back
 * and forth every tick. The holder wins, else the latest registered.
 */
function beadDrivers(localRuns: readonly Run[], elsewhere: readonly BeadClaimant[]): Map<string, Driver> {
  const local: (Driver & { repo_key: string; bead: string })[] = localRuns.flatMap((run) => run.tasks.map((task) => ({
    session: run.session, run_id: run.run_id, task_id: task.task_id, repo_key: run.repo_key, bead: task.bead,
    holds: holdsBead(run, task), registered_at: task.registered_at,
  })))
  const drivers = new Map<string, Driver>()
  for (const claimant of [...local, ...elsewhere]) {
    const key = driverKey(beadsSlug(claimant.repo_key), claimant.bead)
    const current = drivers.get(key)
    if (current === undefined || drivesOver(claimant, current)) drivers.set(key, claimant)
  }
  return drivers
}

const isDriver = (driver: Driver | undefined, run: Run, task: Task): boolean =>
  driver?.session === run.session && driver.run_id === run.run_id && driver.task_id === task.task_id

const waitsOnClose = (task: Task): boolean => task.merged_at_ms !== null && task.bead_closed_at_ms === null

function groupBySlug(runs: readonly Run[]): Map<string, Run[]> {
  const bySlug = new Map<string, Run[]>()
  for (const run of runs) {
    const slug = beadsSlug(run.repo_key)
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), run])
  }
  return bySlug
}

/**
 * Converges every bead to the state its task's ledger implies. Runs after the
 * advance loop over every run file in the session, `done` and aborted ones
 * included, since their beads still need releasing. A lock it cannot take or the
 * time budget ends the pass; what is left is recomputed next tick.
 */
export async function syncBeads(runs: readonly Run[], deps: SyncDeps): Promise<void> {
  const started = deps.now()
  const overBudget = (): boolean => deps.now() - started >= deps.budgetMs
  const localSessions = new Set(runs.map((run) => run.session))
  const elsewhere = (await deps.claimants()).filter((claimant) => !localSessions.has(claimant.session))
  const drivers = beadDrivers(runs, elsewhere)

  const lockNotTakenAt = (slug: string, where: string, failure: BdFailure): void => {
    if (deps.lockNotices.get(slug) !== failure.error) deps.log(`beads ${slug}: pass ended ${where}: ${failure.error}`)
    deps.lockNotices.set(slug, failure.error)
  }

  const failureOf = (slug: string, effects: RunEffect[]) => (task: Task, error: string): void => {
    effects.push(recordSyncFailure(task.task_id, error))
    if (task.bead_sync.last_error !== error) deps.log(`beads ${slug}: ${task.task_id} (${task.bead}) did not sync: ${error}`)
  }
  const save = async (slug: string, run: Run, effects: RunEffect[]): Promise<void> => {
    if (effects.length === 0) return
    const combined: RunEffect = (target) => { for (const apply of effects) apply(target) }
    combined(run)
    try {
      await deps.persist(run, combined)
    } catch (error) {
      deps.log(`beads ${slug}: run ${run.run_id}: sync state not saved (${error}); it is recomputed next tick`)
    }
  }

  let stopped = false
  for (const [slug, slugRuns] of groupBySlug(runs)) {
    if (stopped) break
    if (!(await deps.hasStore(slug))) {
      // Every other bead write can wait for a store, but a merged task's close
      // cannot clear without one, and the close stall must not call that waiting.
      for (const run of slugRuns) {
        const effects: RunEffect[] = []
        const fail = failureOf(slug, effects)
        for (const task of run.tasks.filter(waitsOnClose)) {
          fail(task, `no Beads store for ${run.repo_key}; run the setup action or \`hpipe close\``)
        }
        await save(slug, run, effects)
      }
      continue
    }
    const bd = deps.bdFor(slug)
    // A write whose export failed, or a crash before the export, leaves the file
    // stale; diffing against it would post the same comment twice.
    const refreshed = await bd.refreshExport()
    if (isBdFailure(refreshed)) {
      if (lockNotTaken(refreshed)) {
        lockNotTakenAt(slug, 'before reading the export', refreshed)
        stopped = true
      } else {
        deps.log(`beads ${slug}: export is stale and could not be refreshed (${refreshed.error}); skipped this tick`)
      }
      continue
    }
    deps.lockNotices.delete(slug)
    const actual = new Map(bd.readExport().map((b) => [b.id, b]))
    let wrote = false

    for (const run of slugRuns) {
      if (stopped) break
      const effects: RunEffect[] = []
      const fail = failureOf(slug, effects)
      for (const task of run.tasks) {
        const current = actual.get(task.bead)
        const driver = drivers.get(driverKey(slug, task.bead))
        if (!isDriver(driver, run, task)) {
          if (!waitsOnClose(task)) continue
          if (current?.status === 'closed') effects.push(recordBeadClosed(task.task_id, deps.now()))
          else {
            fail(task, `bead ${task.bead} is driven by ${driver?.task_id} of run ${driver?.run_id} ` +
              `(session ${driver?.session}), not by this task, so the supervisor will not close it for this one`)
          }
          continue
        }
        if (current === undefined) {
          fail(task, `bead ${task.bead} is not in the Beads export`)
          continue
        }
        if (current.status === 'closed' && waitsOnClose(task)) effects.push(recordBeadClosed(task.task_id, deps.now()))

        const calls = callsFor(desiredBead(task, run), current, closeReason(task))
        if (calls.length === 0) continue
        let failure: BdFailure | null = null
        for (const call of calls) {
          if (overBudget()) {
            stopped = true
            break
          }
          const result = await applyCall(bd, task.bead, call)
          if (isBdFailure(result)) {
            failure = result
            break
          }
          wrote = true
        }
        if (failure !== null && lockNotTaken(failure)) {
          stopped = true
          lockNotTakenAt(slug, `at ${task.task_id} (${task.bead})`, failure)
        } else if (failure !== null) fail(task, failure.error)
        else if (!stopped) effects.push(recordSyncOk(task.task_id, deps.now()))
        if (stopped) break
      }
      await save(slug, run, effects)
    }

    if (wrote) {
      const exported = await bd.exportNow()
      if (isBdFailure(exported)) deps.log(`beads ${slug}: export failed (${exported.error}); the board lags until it succeeds`)
    }
  }
}
