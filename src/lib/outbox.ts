import { randomUUID } from 'node:crypto'
import { openDecisionFor } from './decisions'
import type { PaneHold } from './delivery-health'
import { type PhaseRow, runRow, taskRow } from './phases'
import type { OutboxEntry, Run, StallState, Task } from './types'
import { unbriefedWorker } from './unstarted'

function recordOf(run: Run, taskId: string | null): Run | Task | undefined {
  return taskId === null ? run : run.tasks.find((t) => t.task_id === taskId)
}

export function isCurrent(run: Run, entry: OutboxEntry): boolean {
  return recordOf(run, entry.task_id)?.phase_entered_at === entry.entered_at
}

export function recipientPane(run: Run, entry: OutboxEntry): string | null {
  if (entry.to === 'orchestrator') return run.orchestrator_pane
  return run.tasks.find((t) => t.task_id === entry.task_id)?.pane_id ?? null
}

/**
 * The task's own prompt still waiting in the outbox. Until it lands, an idle
 * worker is idle because it was never told what this phase wants, not because it
 * stopped short: status once called a worker whose spec prompt was held by stuck
 * input "idle with nothing at" its spec path. Measured on a live run.
 */
export function queuedWorkerPrompt(run: Run, task: Task): OutboxEntry | null {
  return (run.outbox ?? []).find((entry) =>
    entry.to === 'worker' && entry.task_id === task.task_id && isCurrent(run, entry)) ?? null
}

export interface OutboxInput {
  to: OutboxEntry['to']
  taskId: string | null
  text: string
  phaseNote?: string
}

export function enqueue(run: Run, input: OutboxInput, now: number): OutboxEntry {
  const entry: OutboxEntry = {
    id: randomUUID().slice(0, 8),
    to: input.to,
    task_id: input.taskId,
    entered_at: recordOf(run, input.taskId)?.phase_entered_at ?? run.phase_entered_at,
    text: input.text,
    ...(input.phaseNote ? { phase_note: input.phaseNote } : {}),
    queued_at: now,
    attempts: 0,
  }
  run.outbox = [...(run.outbox ?? []), entry]
  return entry
}

/** Drops prompts about a phase their record has since left, and returns them. */
export function pruneOutbox(run: Run): OutboxEntry[] {
  const outbox = run.outbox ?? []
  const stale = outbox.filter((entry) => !isCurrent(run, entry))
  if (stale.length > 0) run.outbox = outbox.filter((entry) => isCurrent(run, entry))
  return stale
}

export interface Settlement {
  id: string
  ok: boolean
  code?: string
  /** A failure herdr will not get past by being asked again, so keeping the prompt only blocks the pane. */
  permanent?: boolean
}

/**
 * Applies what one tick's sends did. Keyed by entry id, so it applies unchanged to
 * a freshly read run when the tick's save lost to a CLI write — an entry the CLI
 * has meanwhile superseded is simply not found.
 */
export function settleOutbox(run: Run, settlements: readonly Settlement[], now: number): void {
  if (!run.outbox || settlements.length === 0) return
  const byId = new Map(settlements.map((s) => [s.id, s]))
  run.outbox = run.outbox.flatMap((entry) => {
    const settled = byId.get(entry.id)
    if (!settled) return [entry]
    if (settled.ok || settled.permanent) return []
    return [{
      ...entry,
      attempts: entry.attempts + 1,
      ...(settled.code ? { last_code: settled.code } : {}),
      last_attempt_at: now,
    }]
  })
}

function ageMinutes(sinceMs: number, now: number): number {
  return Math.max(0, Math.floor((now - sinceMs) / 60000))
}

/**
 * Where a stall probe for this record is SENT; the ladder and `hpipe status`
 * both ask here, so status names the pane the probe is actually held for.
 * - A worker owed its brief: the orchestrator. Probed in its own pane, a
 *   brief-less agent took the probe as its first instruction (#105).
 * - A row whose actor has no pane of its own: the orchestrator, which the table
 *   points it at.
 * - A paneless worker row — a dispatch prompt that never landed leaves no pane
 *   to nudge: the orchestrator, so the probe still reaches someone.
 */
export function probeRecipient(run: Run, task: Task | null): string | null {
  if (task !== null && unbriefedWorker(run, task)?.paneId != null) return run.orchestrator_pane
  const row: PhaseRow<string> = task === null ? runRow(run.phase) : taskRow(task.phase)
  if (row.probeTarget === 'orchestrator') return run.orchestrator_pane
  if (row.actor === 'worker') return task?.pane_id ?? run.orchestrator_pane
  return run.orchestrator_pane
}

export type OwedKind = 'prompt' | 'decision' | 'answer' | 'stall probe'

export interface Owed {
  kind: OwedKind
  since: number
  /** Sends herdr answered with a failure; a held send is not an attempt. */
  attempts: number
  lastCode?: string
  lastAttemptAt?: number
  /** Known not to have reached the pane, whether it failed or was held. */
  undelivered?: boolean
}

export interface Recipient {
  label: string
  pane: string | null
  owed: Owed[]
}

/**
 * Only an outbox entry is kept as a prompt; a decision still to announce, an
 * answer still to deliver and a probe that could not be sent each live in their
 * own record. Status read the outbox alone, so a dead orchestrator owed a
 * decision for minutes showed nothing. Measured on a live run.
 */
export function owedByRecipient(run: Run): Recipient[] {
  if (runRow(run.phase).terminal === true) return []
  const recipients = new Map<string, Recipient>()
  const owe = (pane: string | null, taskId: string | null, owed: Owed) => {
    const toOrchestrator = taskId === null || (pane !== null && pane === run.orchestrator_pane)
    const key = toOrchestrator ? 'orchestrator' : `worker:${taskId}`
    const recipient = recipients.get(key) ?? {
      label: toOrchestrator ? 'the orchestrator' : `${taskId}'s worker`, pane, owed: [],
    }
    recipient.owed.push(owed)
    recipients.set(key, recipient)
  }

  for (const entry of run.outbox ?? []) {
    if (!isCurrent(run, entry)) continue
    owe(recipientPane(run, entry), entry.to === 'orchestrator' ? null : entry.task_id, {
      kind: 'prompt', since: entry.queued_at, attempts: entry.attempts,
      lastCode: entry.last_code, lastAttemptAt: entry.last_attempt_at,
    })
  }

  for (const task of run.tasks) {
    if (task.phase === 'blocked-on-decision') {
      const open = openDecisionFor(task)
      if (open !== null && open.prompted_at === null) {
        owe(run.orchestrator_pane, null, { kind: 'decision', since: open.asked_at, attempts: 0 })
      }
      const answered = task.decisions.find((d) => d.id === task.pending_answer)
      if (answered !== undefined) {
        owe(task.pane_id, task.task_id, {
          kind: 'answer', since: answered.answered_at ?? answered.asked_at,
          attempts: task.delivery_attempts,
        })
      }
    }
    const probeSince = heldProbeSince(run, task, task.stall)
    if (probeSince !== null) {
      owe(probeRecipient(run, task), task.task_id,
        { kind: 'stall probe', since: probeSince, attempts: 0, undelivered: true })
    }
  }
  const runProbeSince = heldProbeSince(run, run, run.stall)
  if (runProbeSince !== null) {
    owe(probeRecipient(run, null), null, { kind: 'stall probe', since: runProbeSince, attempts: 0, undelivered: true })
  }

  return [...recipients.values()]
}

/** A stall state stamped for an earlier phase entry reads as zero, so its streak is over. */
function heldProbeSince(run: Run, record: Run | Task, stall: StallState | undefined): number | null {
  if (stall?.undeliverable_since === undefined) return null
  if (stall.at !== record.phase_entered_at || stall.run_at !== run.phase_entered_at) return null
  return stall.undeliverable_since
}

/**
 * How long something owed may sit never attempted before status names it. A
 * supervisor that queues but never reaches delivery — every tick's budget gone to
 * something else, or the supervisor wedged — otherwise leaves no trace but its
 * own log.
 */
export const UNATTEMPTED_WARN_MS = 2 * 60_000

/** What `hpipe status` knows about the panes beyond whether herdr still lists them. */
export interface PaneObservations {
  /** Listed panes with no agent running in them. */
  agentless?: ReadonlySet<string>
  /** The live supervisor's delivery gate, by pane. */
  holds?: Readonly<Record<string, PaneHold>>
}

const KIND_ORDER: readonly OwedKind[] = ['prompt', 'decision', 'answer', 'stall probe']

function countOf(owed: readonly Owed[]): string {
  const parts = KIND_ORDER.flatMap((kind) => {
    const n = owed.filter((o) => o.kind === kind).length
    return n === 0 ? [] : [`${n} ${kind}${n === 1 ? '' : 's'}`]
  })
  return parts.length === 1 ? parts[0] as string : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * One line per recipient still owed something that has failed, has nowhere to
 * go, or has waited UNATTEMPTED_WARN_MS without being tried — plus one for an
 * orchestrator pane that is still listed with no agent in it, which a dead
 * Claude leaves and a pane list alone cannot tell from a live one. Anything
 * younger and untried is in flight, not held.
 */
export function deliveryWarnings(
  run: Run, livePanes: ReadonlySet<string>, now: number = Date.now(),
  panes: PaneObservations = {},
): string[] {
  if (runRow(run.phase).terminal === true) return []
  const agentless = panes.agentless ?? new Set<string>()
  const holds = panes.holds ?? {}
  const isGone = (pane: string) => livePanes.size > 0 && !livePanes.has(pane)
  const lines: string[] = []

  const orchestrator = run.orchestrator_pane
  if (orchestrator !== null && !isGone(orchestrator) && agentless.has(orchestrator)) {
    lines.push(`  ⚠ orchestrator pane ${orchestrator} has no live agent — start Claude in it, ` +
      'or run the plugin\'s "claim" action from the pane that should drive this run')
  }

  for (const { label, pane, owed } of owedByRecipient(run)) {
    const hold = pane === null ? undefined : holds[pane]
    const unreachable = pane === null || isGone(pane) || agentless.has(pane) || hold !== undefined
    const held = owed.filter((o) =>
      unreachable || o.undelivered === true || o.attempts > 0 || now - o.since >= UNATTEMPTED_WARN_MS)
    if (held.length === 0) continue

    const oldest = Math.min(...held.map((o) => o.since))
    const latest = held.reduce((a, b) => ((b.lastAttemptAt ?? 0) > (a.lastAttemptAt ?? 0) ? b : a))
    const count = countOf(held)
    if (pane !== null && (hold?.code === 'stuck_input' || latest.lastCode === 'stuck_input')) {
      lines.push(`  ⚠ stuck input in ${pane}: ${count} for ${label} held ` +
        `${ageMinutes(oldest, now)}m because its input box holds text the supervisor did not ` +
        'send — submit or clear that text and delivery resumes')
      continue
    }

    const why: string[] = []
    if (pane === null) why.push('it has no pane')
    else if (isGone(pane)) why.push(`pane ${pane} is gone`)
    else if (agentless.has(pane)) why.push(`pane ${pane} has no live agent`)
    const attempts = held.reduce((most, o) => Math.max(most, o.attempts), 0)
    if (hold !== undefined && hold.failures > 0) {
      why.push(`${plural(hold.failures, 'failed attempt')}, last ${hold.code}`)
    } else if (attempts > 0) {
      why.push(plural(attempts, 'failed attempt') + (latest.lastCode ? `, last ${latest.lastCode}` : ''))
    } else if (why.length === 0 && held.some((o) => o.undelivered === true)) {
      why.push('its last stall probe did not reach it')
    }

    if (why.length === 0) {
      lines.push(`  ⚠ ${count} for ${label} queued ${ageMinutes(oldest, now)}m and ` +
        'never attempted — the supervisor is not reaching delivery; check its pane')
      continue
    }
    lines.push(`  ⚠ ${count} for ${label} undelivered for ` +
      `${ageMinutes(oldest, now)}m (${why.join('; ')}) — held, and sent as soon as it answers again`)
  }
  return lines
}
