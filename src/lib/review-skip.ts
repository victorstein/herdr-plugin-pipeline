import { nextPhase, routeOf, TASK_ROWS, type TaskRoute, taskRow } from './phases'
import type { HistoryEntry, ReviewSkip, Run, Task, TaskPhase } from './types'

/**
 * Of 13 berean-os tasks whose spec and plan cleared first time with fewer than
 * ~150 lines added outside docs, none drew a behavioural PR finding; the one PR
 * stage defect after a sound plan came on a +784-line diff. Measured on a live run.
 */
export const PR_REVIEW_SKIP_BELOW_ADDED_LINES = 150

/** Printed verbatim into the docs as well as read at the base, like `CHECK_REL`. */
export const ALWAYS_REVIEW_REL = '.claude/pipeline-always-review'

const DOCS_PREFIX = 'docs/'

export interface ChangeSize {
  /** Lines added outside `docs/`. */
  added: number
  paths: string[]
}

export interface SkipCandidate {
  skipped: TaskPhase[]
  next: TaskPhase
  cleared: TaskPhase[]
}

interface ReviewRun {
  reviews: TaskPhase[]
  next: TaskPhase
}

function verdictRowsFrom(route: TaskRoute, from: TaskPhase, until: (phase: TaskPhase) => boolean): ReviewRun {
  const reviews: TaskPhase[] = []
  let phase = nextPhase(route, taskRow(from))
  while (!until(phase)) {
    if (taskRow(phase).signal === 'verdict') reviews.push(phase)
    phase = nextPhase(route, taskRow(phase))
  }
  return { reviews, next: phase }
}

/** The review rows `implement` clears into on this route, and the row that follows them. */
export function prReviewsOn(route: TaskRoute): ReviewRun {
  return verdictRowsFrom(route, 'implement', (phase) => taskRow(phase).signal !== 'verdict')
}

function designReviewsOn(route: TaskRoute): TaskPhase[] {
  return verdictRowsFrom(route, 'queued', (phase) => phase === 'implement').reviews
}

/** Where a review row's exit went other than forward: a send-back, or a stop that needed someone. */
const NOT_FORWARD: ReadonlySet<string> = new Set<TaskPhase>([
  'escalated', 'blocked-on-decision', 'failed', 'orphaned', 'blocked-on-failure', 'done',
])

function passed(history: readonly HistoryEntry[], review: TaskPhase): boolean {
  const sentBackTo = taskRow(review).onBlocker
  return history.some((entry) => entry.from === review && entry.to !== sentBackTo && !NOT_FORWARD.has(entry.to))
}

const REVIEW_ROWS = TASK_ROWS.filter((row) => row.signal === 'verdict')

/**
 * Read off the run's history, not the pass counters: `hpipe rewind` clears every
 * counter, and a send-back before it still happened. Over every review row, not
 * only the route's: a plan review's send-back still counts once a human lowers
 * the tier past it, and a PR review that sent the task back must see the fix.
 */
const sentBackByAReview = (entry: HistoryEntry): boolean =>
  REVIEW_ROWS.some((row) => row.phase === entry.from && (entry.to === row.onBlocker || entry.to === 'escalated'))

/** Whether a task leaving `implement` may skip its PR review, from the ledger alone: the fetch waits on a yes. */
export function skipCandidate(run: Run, task: Task): SkipCandidate | null {
  const route = routeOf(run, task)
  if (route.tier === 'heavy') return null
  const { reviews, next } = prReviewsOn(route)
  if (reviews.length === 0) return null
  const history = run.history.filter((entry) => entry.task_id === task.task_id)
  const design = designReviewsOn(route)
  if (!design.every((review) => passed(history, review)) || history.some(sentBackByAReview)) return null
  return { skipped: reviews, next, cleared: design }
}

// `git diff --numstat -z --no-renames`: one `added\tdeleted\tpath` record per NUL,
// with `-` for both counts on a binary file. -z keeps paths unquoted.
const NUMSTAT_RECORD = /^(\d+|-)\t(\d+|-)\t(.+)$/

/** Null when any record cannot be read, or a binary file outside `docs/` leaves its size unknown. */
export function changeSize(numstat: string): ChangeSize | null {
  let added = 0
  const paths: string[] = []
  for (const record of numstat.split(/[\0\n]/).filter((r) => r.length > 0)) {
    const fields = NUMSTAT_RECORD.exec(record)
    if (fields === null) return null
    const plus = fields[1] as string
    const path = fields[3] as string
    paths.push(path)
    if (path.startsWith(DOCS_PREFIX)) continue
    if (plus === '-') return null
    added += Number(plus)
  }
  return { added, paths }
}

const GLOB_CHAR = /[*?[{]/

/** A glob is cut to the prefix before its first wildcard, which can only ever widen the list. */
export function alwaysReviewPrefixes(text: string): string[] {
  const prefixes: string[] = []
  for (const line of text.split('\n')) {
    const entry = line.replace(/#.*$/, '').trim()
    if (entry.length === 0) continue
    const path = entry.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
    const glob = path.search(GLOB_CHAR)
    prefixes.push(glob === -1 ? path : path.slice(0, glob))
  }
  return prefixes
}

/**
 * Null on any doubt: an unmeasured change, or an unread always-review list, is
 * reviewed. The list is always on itself: in a single-PR run it is read from the
 * batch branch, so one skipped edit to it would decide for every later sibling.
 */
export function reviewSkip(
  candidate: SkipCandidate, size: ChangeSize | null, alwaysReview: string[] | null, at: number,
): ReviewSkip | null {
  if (size === null || alwaysReview === null) return null
  if (size.added >= PR_REVIEW_SKIP_BELOW_ADDED_LINES) return null
  const listed = [ALWAYS_REVIEW_REL, ...alwaysReview]
  if (size.paths.some((path) => listed.some((prefix) => path.startsWith(prefix)))) return null
  return { at, skipped: candidate.skipped, added_lines: size.added, cleared: candidate.cleared }
}

export function skipReason(skip: ReviewSkip): string {
  const lines = `${skip.added_lines} ${skip.added_lines === 1 ? 'line' : 'lines'} added outside ${DOCS_PREFIX}`
  return `${lines}, ${skip.cleared.join(' and ')} cleared first pass`
}

/** `pr-review skipped`: the short form for a status line or a transition. */
export function reviewsSkipped(skip: ReviewSkip): string {
  return `${skip.skipped.join(' and ')} skipped`
}

export function describeReviewSkip(skip: ReviewSkip): string {
  return `${reviewsSkipped(skip)}: ${skipReason(skip)}`
}
