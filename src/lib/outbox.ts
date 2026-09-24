import { randomUUID } from 'node:crypto'
import { runRow } from './phases'
import type { OutboxEntry, Run, Task } from './types'

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

function recipientLabel(entry: OutboxEntry): string {
  return entry.to === 'orchestrator' ? 'the orchestrator' : `${entry.task_id ?? '?'}'s worker`
}

/**
 * One line per recipient still owed a prompt that has failed or has nowhere to go.
 * A prompt queued this tick and not yet attempted is in flight, not held.
 */
export function outboxWarnings(
  run: Run, livePanes: ReadonlySet<string>, now: number = Date.now(),
): string[] {
  if (runRow(run.phase).terminal === true) return []
  const groups = new Map<string, { pane: string | null; entries: OutboxEntry[] }>()
  for (const entry of run.outbox ?? []) {
    if (!isCurrent(run, entry)) continue
    const pane = recipientPane(run, entry)
    const gone = pane === null || (livePanes.size > 0 && !livePanes.has(pane))
    if (entry.attempts === 0 && !gone) continue
    const key = `${entry.to}:${entry.to === 'worker' ? entry.task_id : ''}`
    const group = groups.get(key) ?? { pane, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }

  return [...groups.values()].map(({ pane, entries }) => {
    const first = entries[0] as OutboxEntry
    const oldest = Math.min(...entries.map((e) => e.queued_at))
    const attempts = entries.reduce((most, e) => Math.max(most, e.attempts), 0)
    const latest = entries.reduce<OutboxEntry>(
      (a, b) => ((b.last_attempt_at ?? 0) > (a.last_attempt_at ?? 0) ? b : a), first)
    const count = `${entries.length} prompt${entries.length === 1 ? '' : 's'}`
    const why = pane === null
      ? 'it has no pane'
      : livePanes.size > 0 && !livePanes.has(pane)
        ? `pane ${pane} is gone`
        : `${attempts} failed attempt${attempts === 1 ? '' : 's'}, last ${latest.last_code ?? 'unknown'}`
    return `  ⚠ ${count} for ${recipientLabel(first)} undelivered for ` +
      `${ageMinutes(oldest, now)}m (${why}) — held, and sent as soon as it answers again`
  })
}
