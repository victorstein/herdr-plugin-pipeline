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
const sentByAReview = (entry: HistoryEntry): boolean =>
  REVIEW_ROWS.some((row) => row.phase === entry.from && (entry.to === row.onBlocker || entry.to === 'escalated'))

/** A candidate, or why a light or standard task is none; heavy, or a route with no PR review, gives no reason. */
export type Candidacy = { candidate: SkipCandidate } | { reviewedBecause: string | null }

/** From the ledger alone: the fetch that sizes the change waits on a candidate. */
export function skipCandidacy(run: Run, task: Task): Candidacy {
  const route = routeOf(run, task)
  if (route.tier === 'heavy') return { reviewedBecause: null }
  const { reviews, next } = prReviewsOn(route)
  if (reviews.length === 0) return { reviewedBecause: null }
  const history = run.history.filter((entry) => entry.task_id === task.task_id)
  const sentBack = history.find(sentByAReview)
  if (sentBack !== undefined) {
    return { reviewedBecause: `${sentBack.from} ${sentBack.to === 'escalated' ? 'escalated it' : 'sent it back'}` }
  }
  const design = designReviewsOn(route)
  const unpassed = design.find((review) => !passed(history, review))
  if (unpassed !== undefined) return { reviewedBecause: `${unpassed} never cleared` }
  return { candidate: { skipped: reviews, next, cleared: design } }
}

/** Whether a task leaving `implement` may skip its PR review, from the ledger alone: the fetch waits on a yes. */
export function skipCandidate(run: Run, task: Task): SkipCandidate | null {
  const found = skipCandidacy(run, task)
  return 'candidate' in found ? found.candidate : null
}

/** Why a light or standard task leaving `implement` is no skip candidate; null for a candidate, or heavy. */
export function notSkippedBecause(run: Run, task: Task): string | null {
  const found = skipCandidacy(run, task)
  return 'candidate' in found ? null : found.reviewedBecause
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

export type ReviewCall = { skip: ReviewSkip } | { reviewedBecause: string }

/**
 * Reviewed on any doubt: an unmeasured change, or an unread always-review list.
 * The list is always on itself: in a single-PR run it is read from the batch
 * branch, so one skipped edit to it would decide for every later sibling. The
 * reason goes in the history, which said only what was submitted when a 167-line
 * change was reviewed. Measured on a live run.
 */
export function reviewCall(
  candidate: SkipCandidate, size: ChangeSize | null, alwaysReview: string[] | null, at: number,
): ReviewCall {
  if (size === null) return { reviewedBecause: 'its change could not be measured' }
  if (alwaysReview === null) return { reviewedBecause: `${ALWAYS_REVIEW_REL} could not be read at its base` }
  if (size.added >= PR_REVIEW_SKIP_BELOW_ADDED_LINES) {
    return {
      reviewedBecause: `${size.added} lines added outside ${DOCS_PREFIX} ` +
        `(a skip needs fewer than ${PR_REVIEW_SKIP_BELOW_ADDED_LINES})`,
    }
  }
  if (size.paths.includes(ALWAYS_REVIEW_REL)) return { reviewedBecause: `it edits ${ALWAYS_REVIEW_REL}` }
  const listed = size.paths.find((path) => alwaysReview.some((prefix) => path.startsWith(prefix)))
  if (listed !== undefined) return { reviewedBecause: `${listed} is on ${ALWAYS_REVIEW_REL}` }
  return { skip: { at, skipped: candidate.skipped, added_lines: size.added, cleared: candidate.cleared } }
}

export function reviewSkip(
  candidate: SkipCandidate, size: ChangeSize | null, alwaysReview: string[] | null, at: number,
): ReviewSkip | null {
  const call = reviewCall(candidate, size, alwaysReview, at)
  return 'skip' in call ? call.skip : null
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
