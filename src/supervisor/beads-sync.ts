import { type Bd, type BdFailure, type BeadUpdate, type Done, type ExportedBead, isBdFailure } from '../lib/bd'
import { type DesiredBead, desiredBead, isManagedLabel } from '../lib/bead-desired'
import { beadsSlug } from '../lib/beads-project'
import { type BeadClaimant, holdsBead } from '../lib/held'
import type { RunEffect } from '../lib/ledger'
import type { Run, Task } from '../lib/types'

export const SYNC_BUDGET_MS = 2_000
/**
 * The budget is only checked between calls, so a hung bd would hold the serial
 * tick for its whole timeout; the CLI's 30 s is too long for that. A call that
 * takes ~0.4 s alone can still spend several seconds in bd's own backoff on a
 * Dolt lock another bd process holds; live, 5 s killed one such call.
 */
export const SYNC_BD_TIMEOUT_MS = 15_000
/**
 * Two sessions' supervisors sharing one store take each other's lock routinely
 * and for moments at a time; only a lock held this long is worth a line.
 */
export const LOCK_CONTENTION_NOTICE_MS = 30_000

/** One run of passes on a slug that each ended on a lock not taken. */
export interface LockContention {
  since: number
  logged: boolean
}

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
  /**
   * Per slug, the last pass-level notice logged (an export that could not be
   * refreshed), kept across passes so a lasting problem is reported once.
   */
  passNotices: Map<string, string>
  /** Per slug, kept across passes: a held lock is reported only once it has lasted. */
  lockContention: Map<string, LockContention>
  /**
   * Which repo the next pass starts at. It moves on every pass, so a repo whose
   * calls use up the budget each tick cannot starve the repos after it.
   */
  slugCursor: { index: number }
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
  // A run file written before `streak` existed has none.
  const { failures, streak } = task.bead_sync
  task.bead_sync = { ...task.bead_sync, failures: failures + 1, streak: (streak ?? 0) + 1, last_error: error }
})

export const recordSyncOk = (taskId: string, at: number): RunEffect => onTask(taskId, (task) => {
  task.bead_sync = { ...task.bead_sync, streak: 0, last_error: null, last_ok_at_ms: at }
})

/** Only after a recorded merge: a bead a human closed by hand must not let an unmerged task tear down. */
export const recordBeadClosed = (taskId: string, at: number): RunEffect => onTask(taskId, (task) => {
  if (task.merged_at_ms !== null && task.bead_closed_at_ms === null) task.bead_closed_at_ms = at
})

/** Busy, or no `ps` to stamp the lock with: either way no call can run until a later tick. */
const lockNotTaken = (failure: BdFailure): boolean => failure.reason === 'busy' || failure.reason === 'unavailable'

type Driver = Pick<BeadClaimant, 'session' | 'run_id' | 'task_id' | 'holds' | 'registered_at'>

const driverKey = (slug: string, bead: string): string => `${slug}\0${bead}`

const identity = (driver: Driver): string => `${driver.session}\0${driver.run_id}\0${driver.task_id}`

/** Every session must pick the same driver, so a full tie falls to identity rather than to which run was read first. */
function drivesOver(candidate: Driver, current: Driver): boolean {
  if (candidate.holds !== current.holds) return candidate.holds
  if (candidate.registered_at !== current.registered_at) return candidate.registered_at > current.registered_at
  return identity(candidate) > identity(current)
}

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

function rotated<T>(items: readonly T[], start: number): T[] {
  if (items.length === 0) return []
  const offset = start % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

/**
 * Converges every bead to the state its task's ledger implies. Runs after the
 * advance loop over every run file in the session, `done` and aborted ones
 * included, since their beads still need releasing. A lock it cannot take ends
 * that repo's share of the pass and the time budget ends the whole pass; what is
 * left is recomputed next tick.
 */
export async function syncBeads(runs: readonly Run[], deps: SyncDeps): Promise<void> {
  const started = deps.now()
  const overBudget = (): boolean => deps.now() - started >= deps.budgetMs
  const localSessions = new Set(runs.map((run) => run.session))
  const elsewhere = (await deps.claimants()).filter((claimant) => !localSessions.has(claimant.session))
  const drivers = beadDrivers(runs, elsewhere)

  const noticeOnce = (slug: string, notice: string): void => {
    if (deps.passNotices.get(slug) !== notice) deps.log(`beads ${slug}: ${notice}`)
    deps.passNotices.set(slug, notice)
  }
  const lockNotTakenAt = (slug: string, where: string, failure: BdFailure): void => {
    const contention = deps.lockContention.get(slug) ?? { since: deps.now(), logged: false }
    deps.lockContention.set(slug, contention)
    const heldMs = deps.now() - contention.since
    if (contention.logged || heldMs < LOCK_CONTENTION_NOTICE_MS) return
    contention.logged = true
    deps.log(`beads ${slug}: lock held for ${Math.round(heldMs / 1_000)}s; pass ended ${where}: ${failure.error}`)
  }
  const lockTaken = (slug: string): void => {
    const contention = deps.lockContention.get(slug)
    if (contention === undefined) return
    deps.lockContention.delete(slug)
    if (contention.logged) {
      deps.log(`beads ${slug}: Beads lock free again after ${Math.round((deps.now() - contention.since) / 1_000)}s`)
    }
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

  /**
   * Every other bead write can wait for a later pass, but a merged task's close
   * cannot clear without one, and the close stall must not call that waiting.
   */
  const failWaitingOnClose = async (slug: string, slugRuns: readonly Run[], why: (run: Run) => string): Promise<void> => {
    for (const run of slugRuns) {
      const effects: RunEffect[] = []
      const fail = failureOf(slug, effects)
      for (const task of run.tasks.filter(waitsOnClose)) fail(task, why(run))
      await save(slug, run, effects)
    }
  }

  const bySlug = groupBySlug(runs)
  const slugs = rotated([...bySlug.keys()].sort(), deps.slugCursor.index)
  deps.slugCursor.index++
  for (const slug of slugs) {
    if (overBudget()) break
    const slugRuns = bySlug.get(slug)!
    let stopped = false
    let lockLost = false
    if (!(await deps.hasStore(slug))) {
      await failWaitingOnClose(slug, slugRuns, (run) =>
        `no Beads store for ${run.repo_key}; run the 'Set up Beads for this repo' action or \`hpipe start\` in that repo`)
      continue
    }
    const bd = deps.bdFor(slug)
    // A write whose export failed, or a crash before the export, leaves the file
    // stale; diffing against it would post the same comment twice.
    const refreshed = await bd.refreshExport()
    if (isBdFailure(refreshed)) {
      if (lockNotTaken(refreshed)) {
        lockNotTakenAt(slug, 'before reading the export', refreshed)
      } else {
        lockTaken(slug)
        noticeOnce(slug, `export is stale and could not be refreshed (${refreshed.error}); skipped this tick`)
        await failWaitingOnClose(slug, slugRuns, () => `the Beads export could not be refreshed: ${refreshed.error}`)
      }
      continue
    }
    deps.passNotices.delete(slug)
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
          lockLost = true
          lockNotTakenAt(slug, `at ${task.task_id} (${task.bead})`, failure)
        } else if (failure !== null) fail(task, failure.error)
        else if (!stopped) effects.push(recordSyncOk(task.task_id, deps.now()))
        if (stopped) break
      }
      await save(slug, run, effects)
    }
    if (!lockLost) lockTaken(slug)

    if (wrote) {
      const exported = await bd.exportNow()
      if (isBdFailure(exported)) deps.log(`beads ${slug}: export failed (${exported.error}); the board lags until it succeeds`)
    }
  }
}
