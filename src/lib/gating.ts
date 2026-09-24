import { taskRow } from './phases'
import type { Task, TaskPhase } from './types'

/** Dependency satisfaction: a dependent may never start behind one of these. */
const TERMINAL_OK: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['done'])
const TERMINAL_BAD: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'failed', 'orphaned', 'blocked-on-failure', 'escalated',
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

// Column 0, outside fences, for the same reason as the VERDICT trailer
// (predicates.ts): the plan prompt documents the line as an indented example, and
// a plan's code steps may quote one. A quoted copy must not claim files.
const FILES_LINE = /^FILES:(.*)$/
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/
const GLOB_CHAR = /[*?[{]/

/**
 * `roots` are the absolute directories a plan may have written paths under (the
 * checkout, the repo root); a path under one is made repo-relative.
 */
export function planDeclaredFiles(planText: string, roots: string[] = []): string[] {
  const declared: string[] = []
  let openFence: string | null = null
  for (const line of planText.split('\n').map((l) => l.replace(/\r$/, ''))) {
    const fence = FENCE_OPEN.exec(line)?.[1]
    if (openFence === null && fence !== undefined) { openFence = fence; continue }
    if (openFence !== null) {
      if (isFenceClose(line, openFence)) openFence = null
      continue
    }
    const match = FILES_LINE.exec(line)
    if (!match) continue
    for (const entry of (match[1] ?? '').split(',')) {
      const path = normaliseDeclared(entry, roots)
      if (path !== null) declared.push(path)
    }
  }
  return declared
}

function isFenceClose(line: string, openFence: string): boolean {
  const marker = openFence[0] as string
  const close = new RegExp(`^\\s{0,3}(\\${marker}{${openFence.length},})\\s*$`)
  return close.test(line)
}

/**
 * `filesOverlap` is a plain prefix test, so an entry kept verbatim as a glob or an
 * absolute path would overlap nothing and lock nothing. Both are narrowed to the
 * prefix they imply instead, which can only lock more, never less: a glob with no
 * literal directory before it becomes the empty prefix, which locks everything.
 */
function normaliseDeclared(entry: string, roots: string[]): string | null {
  let path = entry.trim().replace(/^`|`$/g, '')
  if (path.length === 0) return null
  for (const root of roots) {
    const base = root.endsWith('/') ? root : `${root}/`
    if (path.startsWith(base)) { path = path.slice(base.length); break }
  }
  path = path.replace(/^\/+/, '').replace(/^(\.\/)+/, '')
  const glob = path.search(GLOB_CHAR)
  return glob === -1 ? path : path.slice(0, glob)
}

/**
 * The declared entries `held` does not already cover. Widen-only: a plan that
 * names fewer files than intake did must not release a lock the orchestrator
 * asked for.
 */
export function widenFiles(held: string[], declared: string[]): string[] {
  const added: string[] = []
  for (const path of declared) {
    if ([...held, ...added].some((prefix) => path.startsWith(prefix))) continue
    added.push(path)
  }
  return added
}

export function isInFlight(task: Task): boolean {
  const rule = taskRow(task.phase).holdsFiles
  if (rule === 'inherit') {
    return task.decision_from !== null && taskRow(task.decision_from).holdsFiles === true
  }
  return rule === true
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

  return { state: 'ready' }
}

export function filesClearFor(task: Task, all: Task[]): boolean {
  return !all.some(
    (t) => t.task_id !== task.task_id && isInFlight(t) && filesOverlap(task.files, t.files),
  )
}

/**
 * One pass in task_id order, at most one release per overlapping group. Without
 * the running set, two tasks freed by the same teardown both read "nothing
 * overlaps" on the same tick and both enter `implement`.
 */
export function releasableFromFiles(all: Task[]): Task[] {
  const waiting = all
    .filter((t) => t.phase === 'blocked-on-files')
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
  const released: Task[] = []
  for (const t of waiting) {
    if (!filesClearFor(t, all)) continue
    if (released.some((r) => filesOverlap(r.files, t.files))) continue
    released.push(t)
  }
  return released
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
