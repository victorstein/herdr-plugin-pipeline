import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { QueuedEvent } from './types'

let seq = 0

const pad = (n: number, width: number) => String(n).padStart(width, '0')

// Hooks are one-shot processes, so `sequence` is 0 on essentially every real
// call and `pid` carries all the uniqueness — but pid reuse is ordinary OS
// behavior. Two hooks with a reused pid in the same millisecond, both at
// sequence 0, would otherwise produce an identical filename and silently
// overwrite one event on rename. The random suffix is a pure uniqueness
// tie-breaker and must stay last so it never affects sort order.
export function queueName(atMs: number, sequence: number, pid: number): string {
  return `${pad(atMs, 13)}-${pad(sequence, 6)}-${pad(pid, 6)}-${randomUUID().slice(0, 8)}.json`
}

export async function enqueue(queueDir: string, event: QueuedEvent): Promise<string> {
  mkdirSync(queueDir, { recursive: true })
  const name = queueName(event.at, seq++, process.pid)
  const target = join(queueDir, name)
  const tmp = `${target}.tmp`
  await Bun.write(tmp, JSON.stringify(event))
  renameSync(tmp, target)
  return target
}

export async function drain(queueDir: string): Promise<QueuedEvent[]> {
  let names: string[]
  try {
    names = readdirSync(queueDir)
  } catch {
    return []
  }

  const ready = names.filter((n) => n.endsWith('.json')).sort()
  const events: QueuedEvent[] = []

  for (const name of ready) {
    const path = join(queueDir, name)
    try {
      events.push((await Bun.file(path).json()) as QueuedEvent)
    } catch {
      // An unreadable event must not wedge the queue.
    }
    unlinkSync(path)
  }

  return events
}

export async function gcStaleTmp(queueDir: string, maxAgeMs: number): Promise<number> {
  let names: string[]
  try {
    names = readdirSync(queueDir)
  } catch {
    return 0
  }

  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    const path = join(queueDir, name)
    // mtimeMs carries sub-millisecond precision while Date.now() is
    // integer-truncated, so a same-instant write can read as fractionally
    // "later" than now; floor before comparing to avoid that false negative.
    if (Math.floor(statSync(path).mtimeMs) <= cutoff) {
      unlinkSync(path)
      removed++
    }
  }
  return removed
}
