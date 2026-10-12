import { join } from 'node:path'
import { trackingRefspec } from './dispatch-base'
import { parseTitle } from './release-title'
import type { Batch, Landing, Run, Task } from './types'
import { shellQuoted } from './unstarted'

export const sha8 = (sha: string): string => sha.slice(0, 8)

export function defaultBatchBranch(runId: string, repoRoot: string): string {
  const repoName = repoRoot.split('/').filter(Boolean).pop() ?? ''
  return `batch/${runId.startsWith(`${repoName}-`) ? runId.slice(repoName.length + 1) : runId}`
}

export function fetchBatchCommand(batch: Batch): string {
  return `git fetch origin ${trackingRefspec(batch.branch)}`
}

export function mergeBatchCommand(batch: Batch): string {
  return `${fetchBatchCommand(batch)} && git merge --no-edit origin/${batch.branch}`
}

/** A non-force push: git refuses it unless `landSha` already contains the batch head, which is the landing gate. */
export function landCommand(run: Run, landSha: string): string {
  return `git -C ${shellQuoted(run.repo_root)} push origin ${landSha}:refs/heads/${(run.batch as Batch).branch}`
}

/**
 * The orchestrator's checkout is the user's working copy, so the batch is patched
 * and checked in a worktree of its own, at the absolute path `start` recorded.
 */
export function checkoutSteps(run: Run, exists: boolean): string[] {
  const batch = run.batch as Batch
  if (exists) return [`git -C ${shellQuoted(batch.checkout)} pull --ff-only`]
  const repo = shellQuoted(run.repo_root)
  return [
    `git -C ${repo} fetch origin ${trackingRefspec(batch.branch)}`,
    `git -C ${repo} worktree add --track -B ${batch.branch} ${shellQuoted(batch.checkout)} origin/${batch.branch}`,
  ]
}

/**
 * Every landing in landing order. A rewind never clears `landed`, because no
 * rewind takes work off the batch branch, so a task landed twice keeps both
 * lines — and one landed twice under the same title keeps it once.
 */
export function releaseLines(run: Run): Landing[] {
  const lines: Array<Landing & { taskId: string }> = []
  for (const task of run.tasks) {
    for (const landing of task.landed ?? []) {
      if (lines.some((l) => l.taskId === task.task_id && l.title === landing.title)) continue
      lines.push({ ...landing, taskId: task.task_id })
    }
  }
  return lines.sort((a, b) => a.at - b.at).map(({ title, land_sha, at }) => ({ title, land_sha, at }))
}

const hasLandedOnBatch = (task: Task): boolean => (task.landed ?? []).length > 0

/**
 * The plugin's alone. release-please replaces the squash commit's message with
 * the override block, so each landing ships as its own release-note line.
 */
export function batchPrBody(run: Run): string {
  const landedTasks = run.tasks.filter(hasLandedOnBatch)
  const rows = landedTasks.flatMap((task) =>
    [...new Set((task.landed ?? []).map((l) => l.title))].map((title) => `| ${task.task_id} | ${task.bead} | ${title} |`))
  const missing = run.tasks.filter((task) => !hasLandedOnBatch(task))
    .map((task) => `${task.task_id} (${task.bead}) stopped at ${task.phase}`)
  return [
    `${run.title}: one PR for run ${run.run_id}`,
    '',
    '| Task | Bead | Change |',
    '|---|---|---|',
    ...rows,
    ...(missing.length === 0 ? [] : ['', `Not in this PR: ${missing.join('; ')}.`]),
    '',
    `Refs ${landedTasks.map((t) => t.bead).join(', ')}`,
    '',
    'BEGIN_COMMIT_OVERRIDE',
    ...releaseLines(run).map((l) => l.title),
    'END_COMMIT_OVERRIDE',
    '',
  ].join('\n')
}

/** The squash commit carries the lines itself, so the release reads them even if release-please never finds the PR. */
export function squashSubject(run: Run): string {
  return releaseLines(run)[0]?.title ?? suggestedPrTitle(run)
}

export function squashBody(run: Run): string {
  return releaseLines(run).slice(1).map((l) => `${l.title}\n`).join('')
}

const TYPE_STRENGTH = ['feat', 'fix', 'perf', 'refactor']

/** Only for PR-title lint: once the override block is present, release-please ignores the title. */
export function suggestedPrTitle(run: Run): string {
  const parsed = releaseLines(run).map((l) => parseTitle(l.title)).filter((p) => p !== null)
  const strongest = TYPE_STRENGTH.find((type) => parsed.some((p) => p.type === type)) ?? parsed[0]?.type ?? 'feat'
  const breaking = parsed.some((p) => p.breaking) ? '!' : ''
  return `${strongest}${breaking}: ${run.title.toLowerCase()}`
}

export const batchPrBodyPath = (stateDir: string, run: Run): string =>
  join(stateDir, 'runs', run.session, `${run.run_id}.batch-pr.md`)

export const squashBodyPath = (stateDir: string, run: Run): string =>
  join(stateDir, 'runs', run.session, `${run.run_id}.squash-body.md`)

export const checksDir = (stateDir: string, run: Run): string =>
  join(stateDir, 'runs', run.session, `${run.run_id}.checks`)
