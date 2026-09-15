import type { Task, TaskPhase } from './types'

/** Dependency satisfaction: a dependent may never start behind one of these. */
const TERMINAL_OK: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['done'])
const TERMINAL_BAD: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'failed', 'orphaned', 'blocked-on-failure', 'escalated',
])

/**
 * File ownership asks a DIFFERENT question than dependency satisfaction, so it
 * gets its own set. `escalated` and `failed` both leave a worktree holding
 * unmerged work, and nothing ever tears an escalated task down — releasing its
 * files would let a second task be dispatched onto them. `orphaned` is excluded
 * because it is only reachable after merge, so that code has already landed.
 */
const HOLDS_FILES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'execute', 'task-review-spec', 'task-review-quality',
  'ci', 'merge', 'close', 'teardown', 'failed', 'escalated',
])

export type GateState =
  | { state: 'ready' }
  | { state: 'waiting'; on: string[] }
  | { state: 'blocked-on-failure'; on: string[] }

/**
 * Declared-intent heuristic, not enforcement: entries are path prefixes, and the
 * real backstop is the orchestrator's PR-level conflict check before merge.
 */
export function filesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)))
}

function isInFlight(task: Task): boolean {
  return HOLDS_FILES.has(task.phase)
}

export function gateStatus(task: Task, all: Task[]): GateState {
  const byId = new Map(all.map((t) => [t.task_id, t]))

  const broken = task.depends_on.filter((id) => {
    const dep = byId.get(id)
    return dep !== undefined && TERMINAL_BAD.has(dep.phase)
  })
  if (broken.length > 0) return { state: 'blocked-on-failure', on: broken }

  const pending = task.depends_on.filter((id) => {
    const dep = byId.get(id)
    return dep === undefined || !TERMINAL_OK.has(dep.phase)
  })
  if (pending.length > 0) return { state: 'waiting', on: pending }

  const colliding = all
    .filter((t) => t.task_id !== task.task_id && isInFlight(t) && filesOverlap(task.files, t.files))
    .map((t) => t.task_id)
  if (colliding.length > 0) return { state: 'waiting', on: colliding }

  return { state: 'ready' }
}

/** Kahn's algorithm. Returns the ids still in the graph when progress stops. */
export function detectCycle(tasks: Task[]): string[] | null {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const t of tasks) {
    indegree.set(t.task_id, 0)
    dependents.set(t.task_id, [])
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!indegree.has(dep)) continue
      indegree.set(t.task_id, (indegree.get(t.task_id) ?? 0) + 1)
      dependents.get(dep)?.push(t.task_id)
    }
  }

  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift() as string
    visited++
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }

  if (visited === tasks.length) return null
  return [...indegree.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort()
}
