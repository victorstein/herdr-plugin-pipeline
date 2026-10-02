import { type Bd, type BdFailure, type BeadUpdate, type Done, type ExportedBead, isBdFailure } from '../lib/bd'
import { type DesiredBead, desiredBead, isManagedLabel } from '../lib/bead-desired'
import { beadsSlug } from '../lib/beads-project'
import { holdsBead } from '../lib/held'
import type { RunEffect } from '../lib/ledger'
import type { Run, Task } from '../lib/types'

export const SYNC_BUDGET_MS = 2_000

export type BeadCall =
  | { kind: 'reopen' }
  | { kind: 'update'; change: BeadUpdate }
  | { kind: 'depAdd'; dependsOn: string }
  | { kind: 'comment'; marker: string; text: string }
  | { kind: 'close'; reason: string }

export type SyncBd = Pick<Bd, 'readExport' | 'reopen' | 'update' | 'depAdd' | 'comment' | 'close' | 'exportNow'>

export interface SyncDeps {
  /** A try-lock `Bd` that does not export after writes: the pass exports once at its end. */
  bdFor: (slug: string) => SyncBd
  hasStore: (slug: string) => Promise<boolean>
  now: () => number
  budgetMs: number
  persist: (run: Run, effect: RunEffect) => Promise<void>
  log: (message: string) => void
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

  for (const dependsOn of desired.blockedBy) {
    const present = (actual.dependencies ?? []).some((d) => d.depends_on_id === dependsOn && d.type === 'blocks')
    if (!present) calls.push({ kind: 'depAdd', dependsOn })
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

interface TaskInRun {
  run: Run
  task: Task
}

/**
 * Which task drives each bead. A bead released by an aborted or failed run can
 * be adopted by a later one; without one driver the two desired states would
 * flip the bead back and forth every tick. The holder wins, else the latest registered.
 */
function beadDrivers(runs: readonly Run[]): Map<string, TaskInRun> {
  const drivers = new Map<string, TaskInRun>()
  for (const run of runs) {
    for (const task of run.tasks) {
      const current = drivers.get(task.bead)
      const holds = holdsBead(run, task)
      const currentHolds = current !== undefined && holdsBead(current.run, current.task)
      const wins = current === undefined ||
        (holds && !currentHolds) ||
        (holds === currentHolds && task.registered_at > current.task.registered_at)
      if (wins) drivers.set(task.bead, { run, task })
    }
  }
  return drivers
}

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

  let stopped = false
  for (const [slug, slugRuns] of groupBySlug(runs)) {
    if (stopped) break
    if (!(await deps.hasStore(slug))) continue
    const bd = deps.bdFor(slug)
    const actual = new Map(bd.readExport().map((b) => [b.id, b]))
    const drivers = beadDrivers(slugRuns)
    let wrote = false

    for (const run of slugRuns) {
      if (stopped) break
      const effects: RunEffect[] = []
      for (const task of run.tasks) {
        if (drivers.get(task.bead)?.task !== task) continue
        const current = actual.get(task.bead)
        if (current === undefined) continue
        const closeUnrecorded = task.merged_at_ms !== null && task.bead_closed_at_ms === null
        if (current.status === 'closed' && closeUnrecorded) effects.push(recordBeadClosed(task.task_id, deps.now()))

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
          deps.log(`beads ${slug}: pass ended at ${task.task_id} (${task.bead}): ${failure.error}`)
        } else if (failure !== null) {
          effects.push(recordSyncFailure(task.task_id, failure.error))
          deps.log(`beads ${slug}: ${task.task_id} (${task.bead}) did not sync: ${failure.error}`)
        } else if (!stopped) effects.push(recordSyncOk(task.task_id, deps.now()))
        if (stopped) break
      }
      if (effects.length === 0) continue
      const combined: RunEffect = (target) => { for (const apply of effects) apply(target) }
      combined(run)
      try {
        await deps.persist(run, combined)
      } catch (error) {
        deps.log(`beads ${slug}: run ${run.run_id}: sync state not saved (${error}); it is recomputed next tick`)
      }
    }

    if (wrote) {
      const exported = await bd.exportNow()
      if (isBdFailure(exported)) deps.log(`beads ${slug}: export failed (${exported.error}); the board lags until it succeeds`)
    }
  }
}
