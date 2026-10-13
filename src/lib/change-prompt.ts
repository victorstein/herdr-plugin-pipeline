import { existsSync } from 'node:fs'
import { checkoutSteps, landCommand, landsCleanSync, landsUnmergedSync, mergeBatchCommand, sha8 } from './batch'
import { trackingRefspec } from './dispatch-base'
import { CHECK_REL, repoCheck } from './check'
import { filesOverlap, sharedFiles } from './gating'
import { modeOf } from './phases'
import { renderPrompt } from './render'
import type { Batch, Run, Task } from './types'
import { shellWord } from './unstarted'
import { REVIEWS_DIR } from './verdict-path'

/**
 * The sentences that differ between a run that ships one PR per task and one that
 * ships the batch. Every task render site spreads these, so `render()` never meets
 * one unresolved, and a per-task run renders exactly the text it always did.
 */
export interface CheckWording {
  /** Whole sentences, for after a `submit` command. */
  note: string
  /** What `submit` refuses until, after "until the merge is pushed". */
  until: string
}

export function checkWording(root: string): CheckWording {
  const check = repoCheck(root)
  if (check.kind === 'none') {
    return {
      note: `This repo declares no \`${CHECK_REL}\`, so \`submit\` runs no check: run the tests and the ` +
        'typecheck yourself before you submit.',
      until: '',
    }
  }
  if (check.kind === 'not-executable') {
    return {
      note: `\`submit\` runs \`${CHECK_REL}\`, which is not executable in this checkout, so it refuses until ` +
        'you `chmod +x` it and commit that. Give that Bash call a 10-minute timeout.',
      until: ' and the check passes',
    }
  }
  return {
    note: `\`submit\` runs \`${CHECK_REL}\` on the pushed tree, so give that Bash call a 10-minute timeout.`,
    until: ' and the check passes',
  }
}

/** A fragment is rendered with its own variables before it is injected: `render()` makes one pass. */
async function fragment(pluginRoot: string, name: string, vars: Record<string, string>): Promise<string> {
  return (await renderPrompt(pluginRoot, name, vars)).replace(/\n+$/, '')
}

const prHandoffRule = (bead: string): string => [
  '- The PR body ends with the line:',
  '',
  `      Refs ${bead}`,
  '',
  '  There is no GitHub issue to close: the supervisor closes the bead itself once the PR merges.',
].join('\n')

function batchHandoffRule(batch: Batch, hpipe: string): string {
  return [
    `- \`implement\` ends with \`${hpipe} submit\`, never with a PR: this branch was cut from \`${batch.branch}\`,`,
    `  so a PR from it would carry every sibling's commits into \`${batch.into}\`. Your change ships with the`,
    '  rest of the batch in the one PR the orchestrator opens at the end, and the supervisor closes the bead',
    `  itself once the change lands on \`${batch.branch}\`.`,
  ].join('\n')
}

function syncStep(batch: Batch): string {
  return [
    `Before anything else, bring in what has landed on \`${batch.branch}\` since this branch was cut or last`,
    'synced:',
    '',
    `    ${mergeBatchCommand(batch)}`,
    '',
    "If the merge changed what this repo's bootstrap builds, re-run `./.claude/pipeline-bootstrap`. On a",
    'conflict, a subagent writes the resolution and you verify it, as below. Push the merge before you go on.',
    '',
    '',
  ].join('\n')
}

/**
 * A review entered from a sync that was not a clean merge: its resolution is code
 * no reviewer has seen. When a reviewed head is still `land_sha`, the range since
 * it is what this review is for.
 */
function resyncNote(batch: Batch, task: Task): string {
  const sync = task.submission
  if (sync?.kind !== 'sync' || sync.merge !== 'dirty') return ''
  const opening = `\n\nThis review was entered from a sync of \`${batch.branch}\` that was not a clean merge` +
    `${sync.dirty_at ? ` (at \`${sha8(sync.dirty_at)}\`)` : ''}.`
  if (!task.land_sha) return `${opening} ${firstReviewOfResync(batch, task, sync.dirty_at)}`
  return `${opening} Read what changed since the last reviewed head ` +
    `with \`git log --first-parent ${shellWord(`${task.land_sha}..origin/${task.branch}`)}\`, and ` +
    '`git show --remerge-diff <merge>` ' +
    'for each merge in it: a conflict resolution is code no reviewer has seen.'
}

/**
 * A dirty sync of a head whose PR review was skipped leaves no reviewed head, so
 * nothing bounds a range. `dirty_at` is the newest commit the sync walk refused,
 * which is a fix on top of the merge when the worker committed one after it.
 */
function firstReviewOfResync(batch: Batch, task: Task, dirtyAt: string | undefined): string {
  const merges = `\`git log --first-parent --merges ${shellWord(`origin/${batch.branch}..origin/${task.branch}`)}\``
  const resolution = dirtyAt
    ? 'Then read the conflict resolution, which no reviewer has seen, with ' +
      `\`git show --remerge-diff ${shellWord(dirtyAt)}\`, and if that commit is not a merge, the same for each ` +
      `merge in ${merges}.`
    : 'Then read each conflict resolution, which no reviewer has seen, with `git show --remerge-diff <merge>` ' +
      `for each merge in ${merges}.`
  return `No reviewed head is recorded, so this is the change's first review: read the whole diff. ${resolution}`
}

/**
 * The last review's CLEAR records the branch head that lands, so a fix pushed after
 * that tick is new code on top of it, and `sync`'s walk sends it back to review.
 */
const CLEAR_FIX_PUSHED_LATER = ' Pushed later, a fix moves the branch off the head the `CLEAR` recorded, and ' +
  'sends the change through `sync` and another review.'

const spokenList = (items: readonly string[]): string =>
  items.length === 1 ? items[0] as string : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

const pathList = (paths: readonly string[]): string => spokenList(paths.map((path) => `\`${path}\``))

const asParagraph = (note: string, indent = ''): string => (note === '' ? '' : `\n\n${indent}${note}`)

/** Most conflicts on a shared path stay mechanical when each task adds its own part and leaves the rest alone. */
export function sharedImplementNote(shared: readonly string[]): string {
  if (shared.length === 0) return ''
  const one = shared.length === 1
  return `${pathList(shared)} ${one ? 'is' : 'are'} shared: other tasks edit ${one ? 'it' : 'them'} at the same ` +
    `time. Keep your change to ${one ? 'it' : 'each'} self-contained — add your own section, never reflow or ` +
    "reorder anyone else's — so a merge stays mechanical."
}

/**
 * Per-task, before the merge. A conflict on a shared path is expected, not a sign
 * that `--files` was wrong: a mechanical union is the rebase's, and CI checks it,
 * but a collision in meaning is new code, so it goes back through the worker and
 * its review. Empty when the task declares no shared path.
 */
export function sharedMergeNote(run: Run, task: Task, hpipe: string): string {
  const shared = sharedFiles(run, task)
  if (shared.length === 0) return ''
  const them = shared.length === 1 ? 'it' : 'them'
  const merged = run.tasks.filter((t) =>
    t.task_id !== task.task_id && t.merged_at_ms !== null && filesOverlap(shared, t.files))
  const cause = merged.length === 0
    ? 'which other work may have changed since this branch was cut'
    : `and ${spokenList(merged.map((t) => `${t.task_id} (merged)`))} ` +
      `${merged.length === 1 ? 'declares' : 'declare'} ${them} too`
  const onTopOf = merged.length === 1 ? `${(merged[0] as Task).task_id}'s` : 'what merged'
  return `This task declares the shared ${pathList(shared)}, ${cause}, so this PR may conflict there. Rebase onto ` +
    "the default branch and keep both sides' additions; CI runs again on the rebased head. If the two additions " +
    'collide in meaning — the same id, number or section — do not resolve it by hand: ' +
    `\`${hpipe} rewind ${run.run_id} implement --task ${task.task_id}\`, so the worker redoes its addition on top ` +
    `of ${onTopOf} and it is reviewed.`
}

/** `{{held_shared_note}}` of the per-task hold: the same rebase step, ahead of asking the human. */
export function heldSharedNote(run: Run, task: Task, hpipe: string): { held_shared_note: string } {
  const note = sharedMergeNote(run, task, hpipe)
  return { held_shared_note: note === '' ? '' : ` ${note}` }
}

/**
 * Single-PR. Any resolution already makes the sync dirty, so it is reviewed; a
 * collision in meaning is better redone by the worker than patched in a merge commit.
 */
export function sharedSyncNote(shared: readonly string[], hpipe: string): string {
  if (shared.length === 0) return ''
  return `${pathList(shared)} ${shared.length === 1 ? 'is' : 'are'} shared, so a conflict there is expected: keep ` +
    "both sides' additions. If they collide in meaning — the same id, number or section — do not resolve it: " +
    `raise it with \`${hpipe} decide\`, recommending that the task go back to \`implement\`; the orchestrator ` +
    'rewinds it.'
}

export async function changePromptVars(
  pluginRoot: string, hpipe: string, run: Run, task: Task,
): Promise<Record<string, string>> {
  const batch = run.batch
  const sharedNote = asParagraph(sharedImplementNote(sharedFiles(run, task)))
  if (modeOf(run) === 'per-task' || batch === undefined) {
    const pr = task.pr === null ? 'unknown' : String(task.pr)
    return {
      subject: `PR #${pr}`, the_change: 'the PR', change_noun: 'PR', whose_head: "the PR's",
      diff_command: `gh pr diff ${pr}`, review_context: '', sync_step: '', reply_place: 'the PR body',
      clear_fix_note: '', shared_note: sharedNote,
      handoff: await fragment(pluginRoot, 'handoff-pr', { bead: task.bead }),
      handoff_rule: prHandoffRule(task.bead),
    }
  }
  const check = checkWording(task.checkout_path ?? run.repo_root)
  const refspecs = [batch.branch, task.branch].map((branch) => shellWord(trackingRefspec(branch))).join(' ')
  return {
    subject: `\`${batch.branch}...${task.branch}\``,
    the_change: 'the change', change_noun: 'change', whose_head: "the branch's",
    diff_command: `git fetch origin ${refspecs} && ` +
      `git diff ${shellWord(`origin/${batch.branch}...origin/${task.branch}`)}`,
    review_context: '\n\nThe worker answers a finding it rejects in an empty commit on the branch, so read ' +
      `\`git log ${shellWord(`origin/${batch.branch}..origin/${task.branch}`)}\` for its replies.` +
      resyncNote(batch, task),
    sync_step: syncStep(batch),
    reply_place: 'the message of an empty commit on the branch',
    clear_fix_note: CLEAR_FIX_PUSHED_LATER, shared_note: sharedNote,
    handoff: await fragment(pluginRoot, 'handoff-batch', {
      task_id: task.task_id, batch: batch.branch, into: batch.into, check_note: check.note,
    }),
    handoff_rule: batchHandoffRule(batch, hpipe),
  }
}

/** The `sync` row's own variables; only a single-PR task reaches that row. */
export function syncPromptVars(run: Run, task: Task, hpipe: string): Record<string, string> {
  const batch = run.batch as Batch
  const check = checkWording(task.checkout_path ?? run.repo_root)
  return {
    batch: batch.branch, merge_batch: mergeBatchCommand(batch), check_note: check.note, check_until: check.until,
    cleared_as: task.review_skip === undefined ? 'was reviewed' : 'skipped its PR review as a small change',
    shared_note: asParagraph(sharedSyncNote(sharedFiles(run, task), hpipe), '   '),
  }
}

/**
 * A rewind into a merge row arrives with no green recorded, and "CI is green" there
 * was a claim nothing had checked. Measured on a live run.
 */
export function ciCheckFirst(pr: string): string {
  return `Check it first, and merge only once every check passes:\n\n    gh pr checks ${pr}\n`
}

/**
 * Pinned to the head the pass was read on, so a push between the prompt and the
 * merge makes GitHub refuse it rather than merge a head CI never passed.
 */
export function mergePromptVars(run: Run, task: Task, hpipe: string): Record<string, string> {
  const pr = task.pr === null ? 'unknown' : String(task.pr)
  const green = task.ci === 'pass'
  const passedOn = green ? task.ci_head?.sha : undefined
  return {
    ci_status: green
      ? ` and CI is green on PR #${pr}.`
      : `, but no green CI is recorded on PR #${pr}. ${ciCheckFirst(pr)}`,
    green_head: passedOn === undefined
      ? 'the head CI ran on'
      : `\`${sha8(passedOn)}\`, the head CI ran on: the command below merges only while the PR's head is still ` +
        'that commit',
    match_head: passedOn === undefined ? '' : ` --match-head-commit ${shellWord(passedOn)}`,
    shared_note: asParagraph(sharedMergeNote(run, task, hpipe)),
  }
}

/**
 * A CLEAR records the head that carries its verdict, past the head `submit`
 * checked, and `land-queue` lets it through unchecked only because all it adds is
 * review verdicts. Calling that head "checked" was a claim about a commit the
 * check never ran on. Measured on a live run.
 */
function landHead(batch: Batch, task: Task): string {
  const sub = task.submission
  const checked = sub?.check === 'passed'
  const judged = task.review_skip === undefined ? 'reviewed' : 'submitted'
  if (landsUnmergedSync(task)) {
    return `the head that was ${judged}${checked ? ' and checked' : ''}; its sync found nothing on ` +
      `\`${batch.branch}\` to merge`
  }
  if (landsCleanSync(task)) {
    return `a clean sync of \`${batch.branch}\` on top of the ${judged} head${checked ? ', checked' : ''}`
  }
  if (!checked || !task.land_sha || sub.head_sha === task.land_sha) {
    return `the head that was ${judged}${checked ? ' and checked' : ''}`
  }
  const recorded = task.review_skip === undefined
    ? 'the head that was reviewed'
    : 'the head recorded when its PR review was skipped'
  return `${recorded}. The check ran on \`${sha8(sub.head_sha)}\`, and \`${sha8(task.land_sha)}\` adds nothing to ` +
    `it but review verdicts under \`${REVIEWS_DIR}/\`, which no check tests`
}

/** A single-PR `merge`: the orchestrator lands the recorded head, never the branch tip. */
export function landingPromptVars(run: Run, task: Task): Record<string, string> {
  const batch = run.batch as Batch
  const landSha = task.land_sha ?? '<no reviewed head recorded>'
  return {
    batch: batch.branch, into: batch.into, land_sha8: sha8(landSha), land_head: landHead(batch, task),
    land_command: landCommand(run, landSha), repo_root: run.repo_root,
  }
}

const PER_TASK_SCOPE = (hpipe: string): string => [
  'There is no run-level spec to review against: each task carried its own, on its own branch. Start',
  `from this run's merged PRs — \`${hpipe} show --task <id>\` prints each task's \`pr:\` — and read each`,
  "one's spec and plan under `docs/superpowers/specs/` and `docs/superpowers/plans/`. Those are the",
  'contracts the work claimed to fulfil.',
].join('\n')

const PER_TASK_BLOCKER_NOTE = 'A BLOCKER sends this phase round again and you patch the branch directly — ' +
  'there is no task left to\nsend it back to.'

function batchScope(run: Run, batch: Batch, hpipe: string): string {
  return [
    'There is no run-level spec to review against: each task carried its own, on its own branch. Review',
    'exactly what the batch PR will carry, ' +
    `\`git diff ${shellWord(`origin/${batch.into}...origin/${batch.branch}`)}\`, in the batch`,
    'checkout, brought up to date first:',
    '',
    ...checkoutSteps(run, existsSync(batch.checkout)).map((step) => `    ${step}`),
    '',
    "Each task's spec and plan are on that branch under `docs/superpowers/specs/` and",
    `\`docs/superpowers/plans/\`, and \`${hpipe} show --task <id>\` prints each task's landings. Those are the`,
    'contracts the work claimed to fulfil.',
  ].join('\n')
}

function batchBlockerNote(batch: Batch, hpipe: string): string {
  return `A BLOCKER sends this phase round again and you patch \`${batch.branch}\` directly, in its checkout at ` +
    `\`${batch.checkout}\`, and push — there is no task left to send it back to. A BLOCKER too big to patch ` +
    `becomes a fix task: \`${hpipe} task …\` registers it into this run and moves the run back to \`execute\`, ` +
    `then \`${hpipe} dispatch --done\`.`
}

function modeNote(batch: Batch): string {
  return `\n\n**This run ships as one PR.** Every task lands on \`${batch.branch}\`, one at a time, and only once ` +
    'it contains every landing before it; a task that falls behind merges the batch in, is checked again, ' +
    'and then lands. `--files` still serializes overlapping work, and a wrong `--files` now costs a ' +
    `re-review when that task syncs. Nothing reaches \`${batch.into}\` until the batch PR merges at the end ` +
    'of the run.'
}

/** The run-level counterpart, spread into every run render site. */
export function runChangeVars(run: Run, hpipe: string): Record<string, string> {
  const batch = run.batch
  if (modeOf(run) === 'per-task' || batch === undefined) {
    return {
      mode_note: '', scope: PER_TASK_SCOPE(hpipe), blocker_note: PER_TASK_BLOCKER_NOTE, change_noun: 'PR',
    }
  }
  return {
    mode_note: modeNote(batch), scope: batchScope(run, batch, hpipe),
    blocker_note: batchBlockerNote(batch, hpipe), change_noun: 'change',
  }
}
