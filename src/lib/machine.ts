import { modeOf, nextPhase, nextRunPhase, type PhaseRow, routeOf, runRow, taskRow } from './phases'
import type { VerdictResult } from './predicates'
import type { AgentStatus, CiBucket, Run, RunPhase, Task, TaskPhase } from './types'

interface HasPasses { passes: Record<string, number | undefined> }

export function counterFor(record: HasPasses, phase: string): number {
  return record.passes[phase] ?? 0
}

/**
 * Monotone by construction. Nothing in this module decrements or deletes a
 * counter — only `hpipe rewind` clears the map. Two earlier drafts reset on a
 * forward transition and each time deleted a bound: the review loop in one, the
 * shipped CI retry budget in the other.
 */
export function bumpCounter(record: HasPasses, phase: string): number {
  const next = counterFor(record, phase) + 1
  record.passes[phase] = next
  return next
}

/**
 * An agent has finished its turn. herdr reports `done` for "idle and not yet
 * seen", which is the normal resting state for an agent this plugin drives —
 * nothing human ever looks at it — so `done` must count as ready alongside
 * `idle`. Both the orchestrator and worker paths read this one predicate so the
 * two cannot drift apart again.
 */
export function isAgentReady(status: AgentStatus): boolean {
  return status === 'idle' || status === 'done'
}

export interface RunSignals {
  actorIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  maxPasses: number
  newestRegisteredAt: number | null
  dispatchComplete: boolean
  tasksAllTerminal: boolean
  /**
   * Tasks in `done` or `orphaned` whose merge was recorded. `orphaned` is
   * normally post-merge, but a manual rewind can put an unmerged task there.
   */
  landedTaskCount: number
  /** Single-PR ship rows: the batch PR as just read; null when none is open or the read failed. */
  batchPr?: BatchPr | null
}

export interface BatchPr {
  number: number
  headSha: string | null
  merged: boolean
  mergedAtMs: number | null
  mergeCommit: string | null
}

export function enterRunPhase(run: Run, phase: RunPhase, why: string): Run {
  run.history.push({ at: Date.now(), from: run.phase, to: phase, why })
  if (phase === 'escalated') run.escalated_from = run.phase
  // As a task's `ci` entry forgets its bucket: the last round's red would fail the
  // new round before its head was ever polled.
  if (phase === 'ship-ci' && run.batch !== undefined) run.batch.ci = null
  run.phase = phase
  run.phase_entered_at = Date.now()
  return run
}

export function advanceRun(run: Run, s: RunSignals): Run | null {
  switch (run.phase) {
    case 'intake': {
      if (!s.actorIdle) return null
      if (s.newestRegisteredAt === null || s.newestRegisteredAt <= run.phase_entered_at) return null
      return enterRunPhase(run, 'dispatch', 'a task was registered')
    }

    // A level, not an edge. As "a worktree adopted after this phase began" it
    // missed adoptions that came first — the orchestrator dispatches from the
    // brief `hpipe task` prints, before intake's idle gate lets the run in here —
    // and the run sat in `dispatch` for good. Measured on a live run. A rewind
    // into this row now leaves again as soon as nothing is owed a worktree.
    case 'dispatch': {
      if (!s.dispatchComplete) return null
      return enterRunPhase(run, 'execute', 'every dispatched task has a worktree')
    }

    // A final review of one task's work repeats the reviews that task already
    // passed: nothing else landed for it to have a seam with.
    case 'execute': {
      if (!run.intake_closed || !s.tasksAllTerminal) return null
      if (s.landedTaskCount >= 2) return enterRunPhase(run, 'branch-review', 'every task finished')
      if (s.landedTaskCount === 1) {
        return enterRunPhase(
          run, nextRunPhase(modeOf(run), runRow('branch-review')), 'one task landed; branch-review skipped',
        )
      }
      return enterRunPhase(run, 'escalated', 'every task finished without one landing')
    }

    case 'branch-review': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null
      if (s.verdict.verdict === 'CLEAR') {
        return enterRunPhase(run, nextRunPhase(modeOf(run), runRow('branch-review')), 'review cleared')
      }
      const count = bumpCounter(run, 'branch-review')
      if (count >= s.maxPasses) {
        return enterRunPhase(run, 'escalated', `${count} passes without clearing`)
      }
      return enterRunPhase(run, 'branch-review', `review returned BLOCKER (pass ${count})`)
    }

    case 'ship':
    case 'ship-ci':
    case 'ship-merge':
      return advanceShip(run, s)

    default:
      return null
  }
}

/**
 * The single-PR run's last mile. `ship` clears like `implement`: the PR found,
 * at a head past the one CI last failed on, and that head is the one
 * `hpipe batch-check` passed, so a fix-task landing forces a new check before CI.
 */
function advanceShip(run: Run, s: RunSignals): Run | null {
  const batch = run.batch
  if (batch === undefined) return null
  const pr = s.batchPr ?? null
  switch (run.phase) {
    case 'ship': {
      if (!s.actorIdle || pr === null || pr.headSha === null) return null
      batch.pr = pr.number
      if (pr.headSha === batch.head_sha_at_entry || batch.checked?.head_sha !== pr.headSha) return null
      return enterRunPhase(run, 'ship-ci', `PR #${pr.number} at ${sha8(pr.headSha)}, checked`)
    }

    case 'ship-ci': {
      if (batch.ci === 'pass') return enterRunPhase(run, 'ship-merge', `CI passed on PR #${batch.pr ?? 'unknown'}`)
      if (batch.ci !== 'fail') return null
      // The last allowed pass escalates rather than return to `ship`, so it must not wait on gh.
      const escalates = counterFor(run, 'ship-ci') + 1 >= s.maxPasses
      if (!escalates && (pr === null || pr.headSha === null)) return null
      const count = bumpCounter(run, 'ship-ci')
      if (escalates) return enterRunPhase(run, 'escalated', `${count} red CI runs on the batch PR`)
      batch.head_sha_at_entry = pr?.headSha ?? null
      return enterRunPhase(run, 'ship', `CI failed on PR #${batch.pr ?? 'unknown'} (pass ${count})`)
    }

    case 'ship-merge': {
      if (pr !== null && pr.merged) {
        batch.merged_at_ms = pr.mergedAtMs ?? Date.now()
        batch.merge_commit = pr.mergeCommit
        return enterRunPhase(run, 'done', `PR #${pr.number} squash-merged as ${sha8(pr.mergeCommit ?? 'unknown')}`)
      }
      // A push after CI passed, as `merge` sends a task back to `ci`.
      const checked = batch.ci_head?.sha
      if (pr === null || pr.headSha === null || checked === undefined || pr.headSha === checked) return null
      return enterRunPhase(run, 'ship-ci', `head moved to ${pr.headSha} after CI passed on ${checked}`)
    }

    default:
      return null
  }
}

export function enterTaskPhase(run: Run, task: Task, phase: TaskPhase, why: string): Task {
  run.history.push({ at: Date.now(), task_id: task.task_id, from: task.phase, to: phase, why })
  if (phase === 'escalated') task.escalated_from = task.phase
  // Only the gate opening puts a task in front of a worker that has not been
  // told about it yet; every later transition follows the worker's own work.
  if (task.phase === 'queued' && phase === taskRow('queued').onClear) task.awaiting_brief = true
  else delete task.awaiting_brief
  if (phase === 'blocked-on-decision') {
    task.artifact_fresh_after ??= task.phase_entered_at
    delete task.answer_sent_at
    delete task.worked_on_answer
  } else if (!leavesDecisionPending(task, phase)) {
    forgetDecisionRoundTrip(task)
  }
  // The cached bucket is the last round's, and the machine reads it every tick
  // while the poller only runs every CI_POLL_SECONDS: a second round failed on
  // the first round's red before the new head was ever polled. Found by tracing
  // a tick, not measured.
  if (phase === 'ci') task.ci = null
  // Whatever implement produces is reviewed afresh, so the head the last review
  // cleared is no longer what lands.
  if (phase === 'implement') delete task.land_sha
  task.phase = phase
  task.phase_entered_at = Date.now()
  return task
}

/**
 * Resuming the asked-from phase, or escalating out of the decision — which a
 * rewind back into `blocked-on-decision` resumes — keeps the round trip's record.
 */
function leavesDecisionPending(task: Task, phase: TaskPhase): boolean {
  return task.phase === 'blocked-on-decision' && (phase === task.decision_from || phase === 'escalated')
}

export function forgetDecisionRoundTrip(task: Task): void {
  delete task.artifact_fresh_after
  delete task.answer_sent_at
  delete task.worked_on_answer
}

/**
 * What the current phase's artifact or verdict must be newer than. A worker that
 * writes its verdict and then asks a decision resumes into a re-stamped phase, and
 * judged against that entry its verdict read as stale and the task sat idle until a
 * stall probe. Measured on a live run. The earlier entry counts only once the
 * worker has been seen working after its answer went in: the verdict is read on
 * the next idle, so one the answer changes has been rewritten by then, and an
 * idle read before that turn cannot clear the phase on a verdict the answer might
 * overturn.
 */
export function artifactFreshAfter(task: Task): number {
  return task.artifact_fresh_after !== undefined && task.worked_on_answer === true
    ? task.artifact_fresh_after
    : task.phase_entered_at
}

/** A working report after the answer was sent; before it, working is about something else. */
export function noteWorkingAfterAnswer(task: Task, at: number): void {
  if (task.answer_sent_at !== undefined && at >= task.answer_sent_at) task.worked_on_answer = true
}

/**
 * A single-PR task's landing, read from local refs and one `ls-remote` of its
 * branch. Only the push is the gate; these decide whom to prompt.
 */
export interface LandingFacts {
  /**
   * The branch head on origin, when it moved past `land_sha` with more than review
   * verdicts and the batch does not already have it. A tip landed in place of
   * `land_sha` has nothing left to land, and a sync of it would wedge on `submit`'s
   * "nothing to land".
   */
  movedTo: string | null
  /** `land_sha` is contained in `origin/<batch>`. */
  landed: boolean
  /** `land_sha` contains `origin/<batch>`. */
  upToDate: boolean
  /** The check ran on `land_sha`, or on a head it adds only review verdicts to. */
  checked: boolean
  batchHead: string
}

export interface TaskSignals {
  actorIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  prNumber: number | null
  headSha: string | null
  merged: boolean
  mergedAtMs?: number
  mergeCommit?: string
  filesClear: boolean
  ciBucket: CiBucket | null
  maxPasses: number
  /** Single-PR: no task holds the landing slot, and this one is first in line for it. */
  slotMine?: boolean
  landing?: LandingFacts
  /** Single-PR, a review clearing into `land-queue`: whether `headSha` contains the submitted head. */
  headContainsSubmission?: boolean | null
  /** Single-PR `sync`: tasks in `land-queue` that could take the slot this one holds. */
  yieldTo?: string[]
  yieldAfterMs?: number
}

const sha8 = (sha: string): string => sha.slice(0, 8)

/** A task that needs no sync to land, and so no worker: it may take the slot without a pane. */
export function landsWithoutSync(l: LandingFacts): boolean {
  return l.movedTo === null && (l.landed || (l.upToDate && l.checked))
}

/** A single-PR run's batch branch; only called from a single-PR edge. */
const batchBranch = (run: Run): string => run.batch?.branch ?? 'the batch'

/**
 * The reviewed head is the branch head when the last review clears, read in the
 * same tick. It must contain what was submitted, or the branch lost that work
 * during review — a force-push, say — and what would land is not what was checked.
 */
function enterLandQueue(run: Run, task: Task, s: TaskSignals): Task | null {
  if (s.headSha === null) return null
  const submitted = task.submission?.head_sha
  if (submitted !== undefined && s.headContainsSubmission !== true) {
    if (s.headContainsSubmission !== false) return null
    enterTaskPhase(run, task, 'implement',
      `${task.branch} no longer contains its submitted head ${sha8(submitted)}: it lost work during review`)
    task.head_sha_at_entry = s.headSha
    return task
  }
  task.land_sha = s.headSha
  return enterTaskPhase(run, task, 'land-queue', `cleared; reviewed head ${sha8(s.headSha)}`)
}

/**
 * The record's truth: once `land_sha` is on the batch its commits ship with it, whatever
 * the task does next, so the line is kept even when the task still has more to land.
 */
function noteLanded(task: Task, landSha: string, at: number): void {
  const landed = task.landed ?? []
  if (landed.at(-1)?.land_sha === landSha) return
  const title = task.submission?.title ?? landed.at(-1)?.title ?? task.brief.title
  task.landed = [...landed, { title, land_sha: landSha, at }]
}

/** The machine's: landed now, and nothing more to land, so the bead closes. */
function recordLanding(task: Task, landSha: string, at: number): void {
  task.merged_at_ms = at
  task.merge_commit = landSha
  noteLanded(task, landSha, at)
}

/** A commit pushed after the review goes through `sync`, so it lands reviewed rather than not at all. */
function syncPastMove(run: Run, task: Task, movedTo: string, landed: boolean, landSha: string): Task {
  const moved = `${task.branch} moved to ${sha8(movedTo)} after its reviewed head`
  if (!landed) return enterTaskPhase(run, task, 'sync', moved)
  noteLanded(task, landSha, Date.now())
  return enterTaskPhase(run, task, 'sync', `${moved} ${sha8(landSha)} landed`)
}

function advanceLanding(run: Run, task: Task, s: TaskSignals): Task | null {
  const landSha = task.land_sha
  if (!landSha) return null
  const batch = batchBranch(run)
  const l = s.landing
  switch (task.phase) {
    case 'land-queue': {
      if (s.slotMine !== true || l === undefined) return null
      if (l.movedTo !== null) return syncPastMove(run, task, l.movedTo, l.landed, landSha)
      if (l.landed) return enterTaskPhase(run, task, 'merge', `${sha8(landSha)} is already on ${batch}`)
      if (l.upToDate && l.checked) {
        return enterTaskPhase(run, task, 'merge', `${sha8(landSha)} is up to date with ${batch} and checked`)
      }
      return enterTaskPhase(run, task, 'sync', l.upToDate
        ? `${sha8(landSha)} is up to date with ${batch} but was not checked since its review`
        : `${batch} moved to ${sha8(l.batchHead)} since ${sha8(landSha)} was reviewed`)
    }

    case 'sync': {
      if (l?.landed === true && l.movedTo === null) {
        return enterTaskPhase(run, task, 'merge', `${sha8(landSha)} is already on ${batch}`)
      }
      const sync = task.submission
      if (sync?.kind !== 'sync' || sync.at < task.phase_entered_at) {
        const waiting = s.yieldTo ?? []
        const yieldAfterMs = s.yieldAfterMs ?? Number.POSITIVE_INFINITY
        if (waiting.length === 0 || Date.now() - task.phase_entered_at < yieldAfterMs) return null
        return enterTaskPhase(run, task, 'land-queue',
          `yielded the landing slot: no sync after ${Math.round(yieldAfterMs / 60_000)}m, ${waiting.join(', ')} waiting`)
      }
      if (!s.actorIdle) return null
      if (sync.merge === 'clean') {
        task.land_sha = sync.head_sha
        return enterTaskPhase(run, task, 'merge', `clean sync of ${batch} at ${sha8(sync.head_sha)}`)
      }
      return enterTaskPhase(run, task, nextPhase(routeOf(run, task), taskRow('implement')),
        `sync of ${batch} was not a clean merge: ${sha8(sync.dirty_at ?? sync.head_sha)}`)
    }

    // A level, like per-task's: a landing pushed before the task entered `merge`,
    // or a rewind into it after, is still recorded, even when the branch has moved
    // on and the task must sync the rest.
    case 'merge': {
      if (l === undefined) return null
      if (l.movedTo !== null) return syncPastMove(run, task, l.movedTo, l.landed, landSha)
      if (l.landed) {
        recordLanding(task, landSha, Date.now())
        return enterTaskPhase(run, task, 'close', `landed on ${batch} at ${sha8(landSha)}`)
      }
      if (l.upToDate) return null
      return enterTaskPhase(run, task, 'sync', `${batch} moved to ${sha8(l.batchHead)} before ${sha8(landSha)} landed`)
    }

    default:
      return null
  }
}

function advanceLoopingRow(
  run: Run, task: Task, row: PhaseRow<TaskPhase>, cleared: boolean,
  maxPasses: number, headSha: string | null, s?: TaskSignals,
): Task | null {
  if (cleared) {
    const next = nextPhase(routeOf(run, task), row)
    if (next === 'land-queue' && s !== undefined) return enterLandQueue(run, task, s)
    return enterTaskPhase(run, task, next, 'cleared')
  }
  const count = bumpCounter(task, row.phase)
  if (count >= maxPasses) {
    return enterTaskPhase(run, task, 'escalated', `${count} passes at ${row.phase}`)
  }
  enterTaskPhase(run, task, row.onBlocker as TaskPhase, `returned (pass ${count})`)
  if (task.phase === 'implement') task.head_sha_at_entry = headSha
  return task
}

export function advanceTask(run: Run, task: Task, s: TaskSignals): Task | null {
  if (modeOf(run) === 'single-pr' && ['land-queue', 'sync', 'merge'].includes(task.phase)) {
    return advanceLanding(run, task, s)
  }
  switch (task.phase) {
    case 'research':
    case 'spec':
    case 'plan': {
      if (!s.actorIdle || !s.artifactFresh) return null
      return enterTaskPhase(
        run, task, nextPhase(routeOf(run, task), taskRow(task.phase)), 'actor idle + artifact fresh',
      )
    }

    // The single-PR edge reads only the ledger: `hpipe submit` already checked the
    // work, and a submission older than this entry cannot clear it.
    case 'implement': {
      if (modeOf(run) === 'single-pr') {
        const sub = task.submission
        const fresh = sub?.kind === 'implement' && sub.at >= task.phase_entered_at &&
          sub.head_sha !== task.head_sha_at_entry
        if (!s.actorIdle || !fresh) return null
        return enterTaskPhase(run, task, nextPhase(routeOf(run, task), taskRow('implement')),
          `submitted ${sha8(sub.head_sha)} as "${sub.title}"`)
      }
      const moved = s.headSha !== null && s.headSha !== task.head_sha_at_entry
      if (!s.actorIdle || s.prNumber === null || !moved) return null
      task.pr = s.prNumber
      return enterTaskPhase(
        run, task, nextPhase(routeOf(run, task), taskRow('implement')), `PR #${s.prNumber} at ${s.headSha}`,
      )
    }

    case 'spec-review':
    case 'plan-review':
    case 'pr-review':
    case 'pr-review-intent':
    case 'pr-review-quality': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null
      return advanceLoopingRow(
        run, task, taskRow(task.phase), s.verdict.verdict === 'CLEAR',
        s.maxPasses, s.headSha, s,
      )
    }

    case 'ci': {
      if (s.ciBucket !== 'pass' && s.ciBucket !== 'fail') return null
      return advanceLoopingRow(
        run, task, taskRow('ci'), s.ciBucket === 'pass', s.maxPasses, s.headSha,
      )
    }

    case 'merge': {
      // A level for the same reason as the run's `dispatch` row: a PR merged
      // before the task entered `merge` (merging is the human's move and races
      // the CI poll), or a rewind into `merge` after it, stranded the task here.
      if (s.merged && s.mergedAtMs !== undefined) {
        task.merged_at_ms = s.mergedAtMs
        task.merge_commit = s.mergeCommit ?? null
        return enterTaskPhase(run, task, 'close', 'PR merged')
      }
      // The orchestrator pushed a hand-off commit after CI passed, and the green it
      // was shown belonged to the head before it. Measured on a live run (#16).
      const checked = task.ci_head?.sha
      if (s.headSha === null || checked === undefined || s.headSha === checked) return null
      return enterTaskPhase(run, task, 'ci', `head moved to ${s.headSha} after CI passed on ${checked}`)
    }

    // An edge although it reads a field: only a reconciler pass that saw the bead
    // closed after this merge was recorded sets it, and every rewind that clears
    // the merge clears it too.
    case 'close': {
      if (task.bead_closed_at_ms === null) return null
      return enterTaskPhase(run, task, 'teardown', `bead ${task.bead} closed`)
    }

    case 'blocked-on-files': {
      if (!s.filesClear) return null
      return enterTaskPhase(run, task, 'implement', 'no overlapping files in flight')
    }

    default:
      return null
  }
}
